#!/usr/bin/env node
'use strict';
/**
 * 跨平台启动器：先拉起 unidbg 签名服务，就绪后再拉起本地 API 服务。
 *
 * 用法：
 *   node scripts/launcher.js              # 完整模式（含签名服务）
 *   node scripts/launcher.js --no-sign    # 仅 API（免签列表页）
 *   node scripts/launcher.js --sign-only  # 仅签名服务
 *   node scripts/launcher.js --port 9000  # 指定签名服务端口
 *
 * 环境变量：
 *   JAVA_HOME / PATH        用于探测 java
 *   SIGN_SERVER             显式指定签名服务地址（不启动本地服务）
 *   SIGN_PORT               签名服务端口，默认 9099
 *   PORT / BIND_HOST        API 服务监听，默认 8000 / 127.0.0.1
 *   SIGN_JVM_XMX            签名服务堆上限，默认 512m
 *   READY_TIMEOUT_MS        签名服务就绪超时，默认 90000（unidbg 初始化较慢）
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIGN_DIR = path.join(ROOT, 'signer');
const JAR = path.join(SIGN_DIR, 'unidbg-sign.jar');
const BUNDLED_JRE = path.join(SIGN_DIR, 'jre');
const SERVER = path.join(ROOT, 'server', 'src', 'server.js');

// FqTrace 用相对路径 ../capture/fq_oversea/ 加载 so，必须以 signer/ 为工作目录
const CAPTURE = path.join(ROOT, 'capture', 'fq_oversea');
const REQUIRED_SO = ['libmetasec_ml.so', 'libc++_shared.so', 'ms_16777218.bin'];

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const flagVal = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const SIGN_PORT = parseInt(flagVal('--port', process.env.SIGN_PORT || '9099'), 10);
const API_PORT = parseInt(process.env.PORT || '8000', 10);
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const JVM_XMX = process.env.SIGN_JVM_XMX || '512m';
const READY_TIMEOUT = parseInt(process.env.READY_TIMEOUT_MS || '90000', 10);
const EXTERNAL_SIGN = process.env.SIGN_SERVER || '';
const NO_SIGN = hasFlag('--no-sign');
const SIGN_ONLY = hasFlag('--sign-only');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const paint = (c, s) => (process.stdout.isTTY ? `${C[c]}${s}${C.reset}` : String(s));
const log = (...a) => console.log(...a);

/**
 * 签名服务日志过滤。
 *
 * libmetasec_ml.so 在每次签名时会向 stderr 打一行：
 *   [main]E/METASEC: Fatal: SDK not init, crashing...
 *
 * 实测结论（已验证，非推测）：
 *   - 启动阶段 0 次；每调用一次 /sign 恰好 1 次，严格 1:1。
 *   - 该行来自 so 内部一个非致命的旁路（证书/设备上报），
 *     主签名流程不依赖它：过滤前后每次 /sign 都稳定返回 8 个签名头
 *     （X-Argus / X-Gorgon / X-Khronos / X-Ladon / X-Helios /
 *       X-Medusa / X-Neptune / X-Soter），搜索等接口实测 code=0。
 *   - 触发条件与请求域名相关：fqnovel.com 正常出签名，
 *     非该域名会被 so 内部短路（只回 X-Neptune）。
 *
 * 之所以过滤而非放任：它每次签名都刷一行，会把真正的错误淹没。
 * 默认过滤，可用 HG_SHOW_METASEC=1 关闭过滤以便排查。
 */
const SHOW_METASEC = /^(1|true|yes|on)$/i.test(
  String(process.env.HG_SHOW_METASEC || '').trim(),
);
let metasecCount = 0;
const METASEC_RE = /E\/METASEC/i;

/**
 * 过滤签名服务输出并统计被抑制的 METASEC 告警。
 *
 * 实测坑点：so 的 stderr 不是按行吐的，而是把
 *   "[main]E/METASEC: Fatal: SDK not init, crashing...\n"
 * 拆成若干独立事件（"[main" / "]E/METASEC: Fatal..." / "[main" / "]" ...）。
 * 因此单看一个 data 块永远匹配不到完整关键字，会漏出 "[signer] [main" 残片。
 *
 * 解决办法：按 stream 维护一个 pending 缓冲，把不完整的尾部留到下一个块
 * 到达后再判断；只对「确定不含 METASEC 的完整行」立即输出。
 */
function makeSignerFilter() {
  let pending = '';
  return function push(text) {
    pending += String(text);
    const lines = pending.split('\n');
    pending = lines.pop(); // 最后一段可能不完整，留待下次
    const out = [];
    for (const line of lines) {
      if (METASEC_RE.test(line)) {
        metasecCount++;
        if (!SHOW_METASEC) continue; // 抑制整行
      }
      if (/^SLF4J/.test(line)) continue;
      out.push(line);
    }
    return out.join('\n') + (out.length ? '\n' : '');
  };
}

/** 关闭过滤时汇总说明，避免「静默丢日志」的困惑。 */
function reportMetasecSuppressed() {
  if (metasecCount > 0) {
    log('');
    log(paint('dim', `  ${paint('yellow', `[signer] 已抑制 ${metasecCount} 条 METASEC "SDK not init" 告警（不影响签名，上游实测 code=0）`)}`));
    if (!SHOW_METASEC) log(paint('dim', '  如需查看原始告警：设置 HG_SHOW_METASEC=1'));
  }
}

/** 读 java 主版本号；读不到返回 null */
function javaMajor(bin) {
  // 1) 优先读 JRE 自带的 release 文件（Temurin 都有，无需执行进程）
  const rel = path.join(path.dirname(path.dirname(bin)), 'release');
  try {
    const txt = fs.readFileSync(rel, 'utf8');
    const m = txt.match(/^JAVA_VERSION="?(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch { /* 无 release 文件则退回 -version */ }
  // 2) 退回 `java -version`（输出形如 openjdk version "25.0.4.1" 2026-08-18）
  try {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/version "(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch { /* 忽略 */ }
  return null;
}

/**
 * 找可用的 java：优先项目自带 JRE，其次 JAVA_HOME，最后系统 PATH。
 * 自带 JRE 优先于系统 PATH —— 避免用户机器上的旧 JDK(如 8/11) 抢先被选中，
 * 导致 unidbg 在旧 JRE 上异常（签名头缺失或直接崩溃）。
 */
function findJava() {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const bundled = path.join(BUNDLED_JRE, 'bin', exe);
  if (fs.existsSync(bundled)) {
    return { bin: bundled, from: '项目自带 JRE', major: javaMajor(bundled) };
  }

  if (process.env.JAVA_HOME) {
    const j = path.join(process.env.JAVA_HOME, 'bin', exe);
    if (fs.existsSync(j)) {
      return { bin: j, from: 'JAVA_HOME', major: javaMajor(j) };
    }
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which',
    ['java'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && fs.existsSync(first)) {
      return { bin: first, from: '系统 PATH', major: javaMajor(first) };
    }
  }
  return null;
}

/** 签名服务要求的最低 Java 主版本 */
const JAVA_MIN_MAJOR = 17;

/** 校验签名资产齐备 */
function checkAssets() {
  const missing = [];
  if (!fs.existsSync(JAR)) missing.push(`缺少签名 JAR：${path.relative(ROOT, JAR)}`);
  for (const f of REQUIRED_SO) {
    if (!fs.existsSync(path.join(CAPTURE, f))) missing.push(`缺少 so：capture/fq_oversea/${f}`);
  }
  return missing;
}

/** TCP 探活 */
function probe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let mod;
    try { mod = url.startsWith('https') ? require('https') : require('http'); } catch { resolve(false); return; }
    const req = mod.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      // 签名服务根路径返回 404 属预期：端口可连接即视为就绪
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * 等待签名服务就绪。
 *
 * 关键：必须同时盯住子进程是否已退出。若端口被别的进程占用，Java 会
 * 抛 BindException 退出，而探活请求会打到那个「占位」的旧服务上，
 * 从而误判为就绪（实测踩过：端口被沙箱代理占用，仍报"签名服务就绪"）。
 */
async function waitReady(base, deadline, proc) {
  const url = `${base}/grab`;
  let dots = 0;
  while (Date.now() < deadline) {
    if (proc && proc.exitCode !== null) return false; // 子进程已退出，不再空等
    if (proc && proc.signalCode) return false;
    // eslint-disable-next-line no-await-in-loop
    if (await probe(url)) return true;
    process.stdout.write(`\r  等待签名服务就绪 ${'.'.repeat((dots++ % 3) + 1)}   `);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 900));
  }
  process.stdout.write('\r');
  return false;
}

const children = [];
let shuttingDown = false;
/** 签名服务启动+就绪等待期间为 true：用于把退出处理让位给 waitReady 的具体诊断。 */
let signStarting = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('');
  reportMetasecSuppressed();
  log(paint('yellow', '[launcher] 正在停止子进程...'));
  for (const c of children) {
    if (!c.killed) {
      try { c.kill(process.platform === 'win32' ? undefined : 'SIGTERM'); } catch { /* 忽略 */ }
    }
  }
  setTimeout(() => process.exit(code), 400);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function startSignService(javaBin) {
  // --add-opens：unidbg 需要反射访问 java.lang（Unsafe / 内部类）
  // --enable-native-access：Java 24+ 对 System.loadLibrary 收紧了限制，
  //   unidbg 加载 libmetasec_ml.so 会打出 "Restricted methods will be blocked
  //   in a future release" 警告，显式开启可避免未来版本直接失败。
  //   低版本 JRE 不认识这个参数会直接退出，故仅在 ≥24 时附加。
  const major = javaMajor(javaBin);
  const args = ['--add-opens', 'java.base/java.lang=ALL-UNNAMED'];
  if (major != null && major >= 24) {
    args.push('--enable-native-access=ALL-UNNAMED');
  }
  args.push('-Xmx' + JVM_XMX, '-cp', path.basename(JAR),
    'com.hongguo.sign.FqTrace', 'serve', String(SIGN_PORT));
  log(paint('cyan', `[signer] ${path.basename(javaBin)} ${args.join(' ')}`));
  const c = spawn(javaBin, args, {
    cwd: SIGN_DIR,           // 关键：so 以 ../capture/ 相对路径加载
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tag = paint('magenta', '[signer]');
  const pipe = (stream, out) => {
    const filter = makeSignerFilter();   // 每路独立缓冲，避免 stdout/stderr 互相串行错位
    stream.on('data', (d) => {
      const text = String(filter(d))
        .split('\n')
        .filter((l) => l && !/^SLF4J/.test(l))
        .map((l) => `${tag} ${l}\n`).join('');
      if (text) out.write(text);
    });
  };
  pipe(c.stdout, process.stdout);
  pipe(c.stderr, process.stderr);
  c.on('error', (e) => log(tag, paint('red', `启动失败：${e.message}`)));
  c.on('exit', (code) => {
    // waitReady 正在等待时，由它给出更具体的原因（端口占用等），此处不抢先退出
    if (!shuttingDown && !signStarting) {
      log(tag, paint('red', `签名服务意外退出（code=${code}）`));
      shutdown(1);
    }
  });
  children.push(c);
  return c;
}

function startApiServer(env) {
  log(paint('cyan', `[api] node server/src/server.js`));
  const c = spawn(process.execPath, [SERVER], {
    cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env }, windowsHide: false,
  });
  c.on('exit', (code) => { if (!shuttingDown) shutdown(code ?? 0); });
  children.push(c);
  return c;
}

(async () => {
  log('');
  log(paint('bold', '  红果短剧 · 网页版启动器'));
  log(paint('dim', `  ${os.platform()} ${os.arch()}  node ${process.version}`));
  log('');

  let signBase = null;
  const needLocalSign = !NO_SIGN && !EXTERNAL_SIGN;

  if (needLocalSign) {
    const missing = checkAssets();
    if (missing.length) {
      log(paint('red', '签名资产不完整：'));
      for (const m of missing) log(paint('red', `  - ${m}`));
      log('');
      log(paint('dim', '目录应为：'));
      log(paint('dim', '  <根>/signer/unidbg-sign.jar'));
      log(paint('dim', '  <根>/capture/fq_oversea/{libmetasec_ml.so,libc++_shared.so,ms_16777218.bin}'));
      process.exit(1);
    }
    const java = findJava();
    if (!java) {
      log(paint('red', '未找到 Java 运行时。'));
      log(paint('dim', '  Windows：把 JRE 放到 signer/jre/，或安装 Temurin 25+ 并加入 PATH'));
      process.exit(1);
    }
    signBase = `http://127.0.0.1:${SIGN_PORT}`;
    log(paint('blue', `[launcher] Java：${java.bin}`));
    log(paint('dim', `           来源：${java.from}`));
    // 版本校验：unidbg 依赖 JVM 内部 API，低版本 JRE 会在初始化时抛
    // InaccessibleObjectException 或缺签名头。这里提前拦下并说清原因，
    // 免得用户只看到「签名服务未就绪」而无从下手。
    if (java.major != null) {
      if (java.major < JAVA_MIN_MAJOR) {
        log(paint('red', `[launcher] Java 版本过低：${java.major} < ${JAVA_MIN_MAJOR}`));
        log(paint('dim', '  签名服务需要 Java 17 或更高版本（推荐 25 LTS）。'));
        log(paint('dim', '  处理：把 Temurin JRE 25 解压到 signer/jre/ 覆盖旧目录，'));
        log(paint('dim', '        或安装 Temurin 25 后清空 JAVA_HOME 再重试。'));
        process.exit(1);
      }
      const tag = java.major >= 25 ? '（LTS）' : '';
      log(paint('dim', `           版本：${java.major}${tag}`));
    } else {
      log(paint('yellow', '  [warn] 无法探测 Java 版本，若签名失败请确认 JRE ≥ 17'));
    }
    signStarting = true;
    const proc = startSignService(java.bin);
    log(paint('blue', '[launcher] 等待签名服务就绪（unidbg 初始化约需 10~30 秒）...'));
    const ok = await waitReady(signBase, Date.now() + READY_TIMEOUT, proc);
    signStarting = false;
    if (!ok) {
      if (proc.exitCode !== null) {
        // 子进程已自行退出，原因通常在上面的 [signer] 日志里
        log(paint('red', `[launcher] 签名服务进程已退出（code=${proc.exitCode}）`));
        log(paint('dim', '  常见原因：端口被占用。可换端口重试，例如'));
        log(paint('dim', `    set SIGN_PORT=${SIGN_PORT + 1} && node scripts\\launcher.js`));
      } else {
        log(paint('red', `[launcher] 签名服务 ${READY_TIMEOUT / 1000}s 内未就绪`));
        log(paint('dim', '  排查：1) Java 版本 >= 8  2) capture/fq_oversea 下三个文件是否齐全'));
      }
      shutdown(1);
      return;
    }
    log(paint('green', `[launcher] 签名服务就绪 ${signBase}`));
  } else if (EXTERNAL_SIGN) {
    signBase = EXTERNAL_SIGN.replace(/\/+$/, '');
    log(paint('green', `[launcher] 使用外部签名服务：${signBase}`));
  } else {
    log(paint('yellow', '[launcher] --no-sign：仅免签接口可用（推荐/榜单/最新/筛选）'));
  }

  if (SIGN_ONLY) {
    log('');
    log(paint('green', `[launcher] 签名服务独立运行中：${signBase}`));
    log(paint('dim', '  按 Ctrl-C 停止'));
    return;
  }

  const env = {};
  if (signBase) env.SIGN_SERVER = signBase;
  env.PORT = String(API_PORT);
  env.BIND_HOST = BIND_HOST;
  startApiServer(env);

  log('');
  log(paint('bold', '  ────────────────────────────────────────'));
  log(`  ${paint('green', '网页版')}  ${paint('bold', `http://${BIND_HOST}:${API_PORT}/`)}`);
  log(`  ${paint('green', '接口自述')} ${paint('bold', `http://${BIND_HOST}:${API_PORT}/`)}`);
  if (signBase) log(`  ${paint('magenta', '签名服务')} ${signBase}`);
  log(paint('bold', '  ────────────────────────────────────────'));
  log(paint('bold', '  ────────────────────────────────────────'));
  log(paint('dim', '  按 Ctrl-C 同时停止 API 与签名服务'));
  if (!SHOW_METASEC) {
    log(paint('dim', '  已自动隐藏 so 内部的 METASEC "SDK not init" 告警（不影响签名）'));
    log(paint('dim', '  如需查看原始日志：设置 HG_SHOW_METASEC=1'));
  }
  log('');
})().catch((e) => {
  log(paint('red', `[launcher] 异常：${e.message}`));
  console.error(e.stack);
  shutdown(1);
});
