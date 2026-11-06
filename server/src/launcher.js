'use strict';
/**
 * 跨平台启动器：直接拉起本地 API 服务。
 *
 * 整条链路只需要 Node.js 运行时，不需要任何外部组件 —— 签名由本进程内的
 * PureSign 纯代码计算（见 server/src/core/pure-sign.js），播放解密由 Stream
 * 离线完成。
 *
 * 用法：
 *   node server/src/main.js                        # 启动服务（默认 127.0.0.1:8000）
 *   node server/src/main.js --config                # 打印当前生效配置后退出
 *   node server/src/main.js --stop                  # 停掉在跑的实例
 *   node server/src/main.js --selftest              # 跑自检
 *
 * 启动即跑 API 服务：签名与解密都在本进程内完成，没有第二个组件，
 * 也就不存在“启停哪个服务”的选择。
 *
 * 配置来源（优先级由高到低）：
 *   环境变量 > server/config/config.json > 内置默认值
 *   日常改配置请编辑 server/config/config.json，环境变量仅用于临时覆盖。
 *
 * 环境变量（覆盖配置文件用，一般不需要设）：
 *   PORT / BIND_HOST        API 服务监听，默认 8000 / 127.0.0.1
 *
 * 打开浏览器：用 child_process 调用各平台原生打开方式
 * （Windows: cmd /c start，macOS: open，Linux: xdg-open）。
 */

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const Config = require('./util/config');
const Log = require('./util/log');
const { sleepUnref, sleepSync } = require('./util/common');

// ==================== 入口 ====================

/**
 * 启动器主入口。
 *
 * @param {string[]} [args] 命令行参数，默认取 process.argv.slice(2)
 * @returns {Promise<void>}
 */
async function main(args = process.argv.slice(2)) {
  const argv = Array.isArray(args) ? args : process.argv.slice(2);

  // --config：只打印生效配置，不启动任何服务
  for (const a of argv) {
    if (a === '--config' || a === '--show-config') {
      printConfig();
      return;
    }
  }

  // --stop：按入口脚本路径找到并停掉在跑的实例，然后退出。
  // 放在本侧是因为目标与端口都来自 config.json —— 脚本要拿到
  // 它们就得先把 JSON 解析一遍，等于把配置逻辑在 bat 里重写一份。
  for (const a of argv) {
    if (a === '--stop') {
      const killed = stopRunning();
      // 无论是否定位到进程都要查端口：「没找到进程」并不等于
      // 「端口是空的」——Windows 上以管理员权限启动的服务，
      // 普通权限的 --stop 读不到它的命令行，匹配会落空，
      // 而端口仍在监听。此时必须如实告知，否则用户会以为
      // 停止成功，留下一个占着端口的隐形实例。
      await reportPorts(Config.num('api.port', 8000), killed);
      // 两种结果都算成功：「停掉了」和「本来就没在跑」都是
      // 幂等停止的正常结局。返回非 0 会让 stop.bat 打出
      // "Service exited with code 1"，把一次正常操作报成失败。
      process.exit(0);
      return;
    }
  }

  const apiPort = Config.num('api.port', 8000);
  const bindHost = Config.str('api.host', '127.0.0.1');

  banner();

  // 同进程内直接建 Server，无需再 fork 任何子进程
  const ServerMod = require('./server');
  const Server = typeof ServerMod === 'function'
    ? ServerMod
    : (ServerMod.Server || ServerMod.default);
  const server = new Server();
  const boot = server.ensureBootstrap();
  if (boot !== null && boot !== undefined) Log.info('已签发本地链路密钥   ' + boot);
  // 管理口令只在首次自动生成时输出：此时已写入 apikeys.json，
  // 重启沿用同一口令，不再重复打扰；环境变量显式设置时同样不输出。
  if (server.adminTokenFresh()) {
    Log.info('管理口令(ADMIN_TOKEN) ' + server.adminToken()
      + '（已写入 server/config/apikeys.json，重启沿用）');
  }

  await server.start(bindHost, apiPort);

  // 浏览器交给启动器开：launcher.open_browser 是配置项，
  // 启动脚本只负责把进程拉起来，不参与任何编排。
  if (Config.bool('launcher.open_browser', true)) {
    openBrowserWhenReady(apiPort);
  }

  // 阻塞主线程：Node 的 http server 是非 daemon 句柄，main 返回后
  // 进程也不会退出，但显式等待能确保 Ctrl-C / SIGTERM 走默认退出
  // 流程，进程状态由 /health 与浏览器体现，控制台不补状态行。
  await awaitShutdown();
}

/**
 * 服务就绪后打开浏览器。
 *
 * 之所以放在启动器而不是 bat：host/port 都由 config.json 决定，
 * 脚本要拿到它们就得先把配置读一遍并回传，等于把配置解析
 * 逻辑在 bat 里重写一份。这里直接用刚启动的端口即可。
 *
 * 监听 0.0.0.0 时必须改用 127.0.0.1：0.0.0.0 是"监听所有网卡"的
 * 通配地址，浏览器拿它当目标去连会直接失败（与 bat 里原先
 * HG_BROWSER_HOST 的处理一致）。
 *
 * 单独起异步任务轮询 /health：Server.start() 返回时端口已经在听，
 * 但前端页面还要等密钥就绪才能真正可用，过早打开
 * 会看到空白页。超时 90s 后放弃，不阻塞主流程。
 */
function openBrowserWhenReady(apiPort) {
  const host = browserHost();
  const url = 'http://' + host + ':' + apiPort + '/ui';
  // 探活地址必须与浏览器地址同源。此前硬编码 127.0.0.1，
  // 而服务绑定的是 api.host —— 若用户把 api.host 配成局域网 IP，
  // 服务只在那个 IP 上监听，探 127.0.0.1 永远连不上，
  // 表现就是"服务正常但浏览器一直不开"。
  const health = 'http://' + host + ':' + apiPort + '/health';
  Log.info('就绪后自动打开 ' + url);
  return (async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (await probe(health, 2000)) {
        const err = browse(url);
        if (err === null) {
          Log.info('已打开浏览器');
        } else {
          Log.warn('自动打开失败，请手动打开网页：' + url);
          Log.info('  原因：' + err);
        }
        return;
      }
      await sleep(500);
    }
    Log.warn('等待服务就绪超时，未自动打开浏览器，请手动访问 ' + url);
  })().catch((e) => {
    Log.warn('自动打开浏览器任务异常：' + (e && e.message ? e.message : e));
  });
}

/** 浏览器可连接的地址：0.0.0.0 / :: 是监听通配符，不能作为连接目标。 */
function browserHost() {
  const h = Config.str('api.host', '127.0.0.1');
  if (h === null || h === '' || h === '0.0.0.0' || h === '::') return '127.0.0.1';
  return h;
}

/**
 * 用系统默认浏览器打开 URL。
 *
 * 调用各平台原生打开方式，不自行拼装"半吊子兜底"：命令执行失败就如实告知，
 * 让用户自己开。无图形会话的容器 / WSL / 纯 SSH / CI runner 下这些
 * 命令同样不会成功，报错即可。
 *
 * @returns {string|null} 成功返回 null；失败返回原因描述
 */
function browse(url) {
  const candidates = process.platform === 'win32'
    ? [['cmd', ['/c', 'start', '', url]]]
    : process.platform === 'darwin'
      ? [['open', [url]]]
      : [['xdg-open', [url]]];

  let lastErr = null;
  for (const [cmd, cmdArgs] of candidates) {
    try {
      const r = spawnSync(cmd, cmdArgs, {
        stdio: 'ignore', windowsHide: true, timeout: 10000,
      });
      if (r.error) { lastErr = r.error; continue; }
      if (r.status === 0) return null;
      lastErr = new Error(cmd + ' 退出码 ' + r.status);
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = lastErr ? (lastErr.message || String(lastErr)) : '';
  return '打开浏览器失败' + (msg ? '：' + msg : '');
}

/**
 * 探测 HTTP 端点是否可用。
 *
 * 只求「连得上、有响应」，不校验响应体内容：就绪判定交给
 * 前端自身的重试逻辑，这里过早深入反而会把 Web 层的策略
 * 复制到启动器里。
 *
 * @param {string} url       目标地址
 * @param {number} timeoutMs 单次连接/读取超时
 * @returns {Promise<boolean>} 收到任何 HTTP 响应（含 4xx/5xx）即视为可用
 */
function probe(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let u;
    let mod;
    try {
      u = new URL(url);
      mod = u.protocol === 'https:' ? require('https') : require('http');
    } catch (e) {
      resolve(false);
      return;
    }
    const req = mod.request(u, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * 阻塞主线程直到进程收到终止信号。
 *
 * 没有子进程需要收编（签名与解密都在本进程内），
 * 这里只把主流程挂住，让 Ctrl-C / SIGTERM 走 Node 默认退出流程。
 * 控制台不额外打印状态行：服务是否在跑，看浏览器或 /health 即可，
 * 末尾再补一行提示只是噪声。
 */
function awaitShutdown() {
  return new Promise(() => {});
}

/**
 * 启动横幅。只打印纯 ASCII 的系统信息。
 *
 * 这里刻意不输出中文标题：控制台代码页与输出编码一旦不一致，
 * 中文会变成「红红果果」式的重复乱码，而纯 ASCII 在任何代码页下
 * 都正常。需要中文标识时可看浏览器标题栏或日志文件。
 */
function banner() {
  Log.info('  Hongguo Short Drama - Web Launcher (Node Edition)');
  Log.info('  ' + os.platform() + ' ' + os.arch() + '  Node ' + process.version);
}

/**
 * 打印当前生效配置（--config）。
 *
 * 供用户确认「我改的配置到底生效没有」——排查配置问题时，
 * 比起逐层追问日志，直接看这一段最快。
 */
function printConfig() {
  console.log();
  console.log('  生效配置（环境变量 > 配置文件 > 默认值）');
  console.log('  ' + '-'.repeat(56));
  const src = Config.loadedFrom();
  console.log('    配置文件      : ' + (src === null ? '未找到（使用内置默认值）' : src));
  // 版本号也一并打出来：排查「装的到底是哪一版」时，
  // 光看配置路径不够，还得知道它自称的版本。
  console.log('    version       : ' + Config.version());
  console.log('    api.host       : ' + Config.str('api.host', '127.0.0.1'));
  console.log('    api.port       : ' + Config.num('api.port', 8000));
  console.log('    签名方式       : ' + '本地纯代码签名（PureSign，内置）');
  // data_dir 只承载视频缓存（落在 server/stream-cache）；设备身份与
  // 密钥（均落在 apikeys.json）固定位于 server/config，不随本项变化。
  console.log('    data_dir(视频缓存) : ' + Config.str('runtime.data_dir', 'server'));
  console.log('    download_dir(剧集下载) : ' + Config.str('runtime.download.dir', 'download')
    + '（并发 ' + Config.num('runtime.download.concurrency', 2) + '）');
  console.log('  ' + '-'.repeat(56));
  console.log();
}

// ==================== 停止在跑的实例 ====================

/**
 * 停掉本机在跑的服务进程（--stop）。
 *
 * 按入口脚本路径匹配，而不是按端口：端口会随 config.json 变，
 * 而文件路径是稳定的。
 *
 * 两个条件缺一不可：进程本体必须是 Node，并且命令行里出现目标文件名。
 * 只看后者的教训很实际：任何提到这个文件名的进程都会被误杀——shell 里那句
 * node server/src/main.js --stop、编辑器标签页、甚至一次 grep，都会命中，
 * 而它们与本服务毫无关系。加上进程类型这一层之后，能通过的只剩下真正
 * 在跑的实例。
 *
 * @returns {boolean} 至少停掉一个进程时返回 true
 */
function stopRunning() {
  // 入口脚本路径片段（含两种分隔符）。只比文件名（如 "main.js"）会误杀
  // 其它项目同名的 Node 进程，必须连目录一起比。
  const names = [
    'server/src/main.js', 'server\\src\\main.js',
    'server/src/launcher.js', 'server\\src\\launcher.js',
  ];
  const self = process.pid;
  const all = listProcesses();
  const targets = [];
  for (const h of all) {
    if (h.pid === self) continue;                  // 本进程（--stop 自己）
    if (!isRuntimeProcess(h)) continue;            // 必须是 Node 进程
    const cmd = commandLineOf(h);
    if (cmd === null) continue;
    // 排除"正在执行停止"的进程（可能是本进程，也可能是
    // 用户同时在另一个窗口敲了 stop）。一次停止不该打断
    // 另一次停止：两个 --stop 并发时若互杀，双方都会被
    // SIGTERM 打断，调用方拿到 128+15 的退出码，
    // 看起来像失败，其实只是撞车。
    if (cmd.includes('--stop')) continue;
    // 大小写不敏感：Windows 文件名与命令行均不区分大小写，
    // 而用户启动服务时用的路径大小写不受我们控制。
    const lower = cmd.toLowerCase();
    for (const n of names) {
      if (lower.includes(n.toLowerCase())) { targets.push(h); break; }
    }
  }

  if (targets.length === 0) {
    Log.info('没有找到正在运行的 API 进程。');
    return false;
  }
  for (const h of targets) {
    console.log('   停止 PID ' + h.pid);
    kill(h, all);
  }
  // 给操作系统一点时间回收 socket，否则紧接着的端口检查仍会报占用
  sleepSync(1200);
  return true;
}

/**
 * 进程本体是否是 Node。
 *
 * 这正是"进程类型"这一层需要的判据：凡是想杀的，都是 Node 起的；
 * 而误伤对象（shell、编辑器、grep）都不是。
 *
 * 必须截到基名再比。/proc/<pid>/exe 在 Linux 上返回完整路径，
 * 直接拿返回值比 "node" 会永远失配。
 *
 * command 为空时回退到命令行首个 token：Windows 上对高权限
 * 或异会话进程，exe 偶有读不到的情况（此时命令行往往仍可读）。
 *
 * 读不到名字时返回 false（宁可不杀，不误杀）。
 */
function isRuntimeProcess(h) {
  let exe = '';
  try {
    exe = h.command === null || h.command === undefined ? '' : String(h.command);
  } catch (e) {
    exe = '';
  }
  if (exe === '') {
    const cmd = commandLineOf(h);
    if (cmd !== null && cmd.trim() !== '') {
      const first = cmd.trim();
      const sp = first.indexOf(' ');
      exe = sp > 0 ? first.substring(0, sp) : first;
    }
  }
  const cut = Math.max(exe.lastIndexOf('/'), exe.lastIndexOf('\\'));
  if (cut >= 0) exe = exe.substring(cut + 1);
  let n = exe.toLowerCase();
  if (n.endsWith('.exe')) n = n.substring(0, n.length - 4);
  return n === 'node';
}

/** 读进程命令行；读不到时返回 null。 */
function commandLineOf(h) {
  if (!h || h.commandLine === null || h.commandLine === undefined) return null;
  const s = String(h.commandLine);
  return s === '' ? null : s;
}

/**
 * 结束一个进程树：先 SIGTERM 给它走正常退出流程，仍在世就强杀。
 *
 * 只对直接子进程发信号不够：目标进程可能再 fork 出孙进程，
 * 强杀父进程后孙进程会被 init 收养并继续持有端口，表现为
 * 「端口仍被占用」。因此先收编子孙再收编自己。
 */
function kill(h, procs) {
  let all = [];
  try {
    all = descendants(h.pid, procs || listProcesses());
  } catch (e) {
    // 读不到子孙就只杀自己
  }
  all.push(h);
  for (const d of all) {
    if (!isAlive(d.pid)) continue;
    try {
      terminate(d.pid);
      waitExit(d.pid, 2000);
    } catch (e) {
      // 超时或不支持：落到强杀
    }
    if (isAlive(d.pid)) {
      try {
        forceKill(d.pid);
        waitExit(d.pid, 1000);
      } catch (e) {
        // 已经退出
      }
    }
  }
}

/**
 * 报告配置里的端口是否仍被占用。
 *
 * 两种调用场景，措辞完全不同：
 *  - killed=true：真的停掉了实例，端口仍占用通常意味着
 *      有另一个实例在跑，或杀进程需要管理员权限；
 *  - killed=false：没能定位到进程，端口却还在听 ——
 *      典型原因是服务以管理员权限启动（当前权限不足，读不到它的
 *      命令行），或从本项目的另一份拷贝启动。此时必须点破，
 *      否则用户会以为停止成功，留下一个占着端口的隐形实例。
 */
async function reportPorts(apiPort, killed) {
  if (!(await portBusy(apiPort))) return;
  if (killed) {
    Log.warn('端口 ' + apiPort + ' 仍被占用。若有其他实例在跑属正常；'
      + '否则可尝试以管理员身份运行，或查看：netstat -ano | findstr ' + apiPort);
  } else {
    Log.warn('端口 ' + apiPort + ' 仍在监听，但未能定位到进程。');
    Log.warn('  常见原因：服务以管理员权限启动（当前权限不足），'
      + '或从本项目的另一份拷贝启动。');
    Log.warn('  可手动结束：netstat -ano | findstr ' + apiPort
      + ' 查到 PID 后执行 taskkill /PID <pid> /F，'
      + '或在任务管理器结束对应的 node.exe。');
  }
}

/**
 * 端口是否仍在接受连接。
 *
 * 用 TCP 连接探测，而不是解析 netstat：后者的输出格式三个平台
 * 各不一样（Windows 是 LISTENING，Linux 是 LISTEN，macOS 又是另一套），
 * 照某一种写正则必然在别的平台上失灵。一次 connect 在所有平台
 * 语义一致：连得上，就是有东西在听。
 *
 * 连不上时视为未占用：防火墙拦截、绑定在别的网卡上都会走到这里，
 * 宁可漏报也不误报 —— 停止流程本身已经结束，这里只是补充信息。
 *
 * @returns {Promise<boolean>}
 */
function portBusy(port) {
  const host = Config.str('api.host', '127.0.0.1');
  const wildcard = host === null || host === '' || host === '0.0.0.0' || host === '::';
  const candidates = wildcard ? ['127.0.0.1'] : [host, '127.0.0.1'];
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= candidates.length) { resolve(false); return; }
      const h = candidates[i];
      i += 1;
      const sock = new net.Socket();
      let done = false;
      const finish = (busy) => {
        if (done) return;
        done = true;
        sock.destroy();
        if (busy) resolve(true);
        else next();
      };
      sock.setTimeout(1000, () => finish(false));
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      sock.connect({ host: h, port });
    };
    next();
  });
}

// ==================== 进程枚举 ====================

/**
 * 列出本机进程，元素形如 { pid, ppid, command, commandLine }。
 *
 * Node 没有跨平台的进程枚举 API，分平台实现：
 *   - Linux：直接读 /proc
 *   - Windows：wmic（CSV，带表头）
 *   - 其它（macOS / BSD）：ps -eo
 * 读不到的字段留空，调用方按"读不到就不动"处理。
 */
function listProcesses() {
  const out = [];
  if (process.platform === 'linux') {
    let dirs;
    try { dirs = fs.readdirSync('/proc'); } catch (e) { return out; }
    for (const d of dirs) {
      if (!/^\d+$/.test(d)) continue;
      const pid = parseInt(d, 10);
      let commandLine = null;
      try {
        const buf = fs.readFileSync('/proc/' + d + '/cmdline');
        const s = buf.toString().replace(/\0+$/, '');
        commandLine = s === '' ? null : s.split('\0').join(' ');
      } catch (e) { commandLine = null; }
      let command = '';
      try {
        command = fs.readlinkSync('/proc/' + d + '/exe');
      } catch (e) {
        try { command = fs.readFileSync('/proc/' + d + '/comm', 'utf8').trim(); }
        catch (e2) { command = ''; }
      }
      let ppid = null;
      try {
        const status = fs.readFileSync('/proc/' + d + '/status', 'utf8');
        const m = status.match(/^PPid:\s*(\d+)/m);
        if (m) ppid = parseInt(m[1], 10);
      } catch (e) { ppid = null; }
      out.push({ pid, ppid, command, commandLine });
    }
    return out;
  }

  if (process.platform === 'win32') {
    try {
      const r = spawnSync('wmic',
        ['process', 'get', 'ParentProcessId,ProcessId,ExecutablePath,CommandLine', '/format:csv'],
        { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (r.status === 0 && r.stdout) {
        const lines = r.stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
        if (lines.length > 0) {
          const header = lines[0].split(',');
          const col = (name) => header.findIndex((x) => x.trim().toLowerCase() === name.toLowerCase());
          const iPid = col('ProcessId');
          const iPpid = col('ParentProcessId');
          const iExe = col('ExecutablePath');
          const iCmd = col('CommandLine');
          for (let k = 1; k < lines.length; k += 1) {
            const c = lines[k].split(',');
            const pid = parseInt(c[iPid], 10);
            if (Number.isNaN(pid)) continue;
            out.push({
              pid,
              ppid: parseInt(c[iPpid], 10),
              command: iExe >= 0 ? (c[iExe] || '') : '',
              commandLine: iCmd >= 0 ? (c[iCmd] || null) : null,
            });
          }
        }
      }
    } catch (e) { /* 无 wmic：返回空表，宁可不杀 */ }
    return out;
  }

  // macOS / BSD / 其它 POSIX
  try {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='],
      { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split(/\r?\n/)) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        out.push({
          pid: parseInt(m[1], 10),
          ppid: parseInt(m[2], 10),
          command: m[3],
          commandLine: m[4],
        });
      }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

/** 收集某进程的全部子孙（先收编子孙、后收编自己时用）。 */
function descendants(pid, procs) {
  const byParent = new Map();
  for (const p of procs) {
    if (p.ppid === null || p.ppid === undefined) continue;
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([pid]);
  const stack = [pid];
  while (stack.length > 0) {
    const cur = stack.pop();
    for (const c of (byParent.get(cur) || [])) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      stack.push(c.pid);
    }
  }
  return out;
}

/** 进程是否仍在世（EPERM 说明存在但无权限，同样算在世）。 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function terminate(pid) {
  try { process.kill(pid, 'SIGTERM'); return true; }
  catch (e) { return false; }
}

function forceKill(pid) {
  try { process.kill(pid, 'SIGKILL'); return true; }
  catch (e) { return false; }
}

/** 轮询等待进程退出；返回是否已在超时内退出。 */
function waitExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    sleepSync(50);
  }
  return !isAlive(pid);
}

// ==================== 小工具 ====================

/** 异步睡眠（带 unref，不阻止进程退出）；实现见 util/common。 */
const sleep = sleepUnref;

// 只导出 main：此前内部函数全部挂在导出表上（stop 与 stopRunning 还是同一
// 函数导了两次），但全仓库只有 main.js 引用 main，其余成员已收敛回私有。
module.exports = { main };
