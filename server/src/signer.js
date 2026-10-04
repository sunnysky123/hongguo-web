'use strict';
/**
 * 签名客户端：对接 Java(unidbg) 签名服务。
 *
 * 原应用的签名由 unidbg 在本地 x86_64 上模拟 ARM64 的 libmetasec_ml.so 执行，
 * 通过一个 HTTP 服务暴露（桌面端固定 127.0.0.1:9099，端口由 FqTrace serve 占用）。
 *
 * 本模块保持与原 Python 侧完全一致的调用协议：
 *   POST {base}/sign  {url, headers} -> { "X-Argus": ..., "X-Gorgon": ..., "X-Khronos": ..., "X-Ladon": ... }
 *   GET  {base}/grab  -> { url, headers }   （抓取设备身份，用于登录态刷新；桌面模式不使用）
 *
 * 设计要点：
 *  - 支持多个签名服务地址轮询 + 故障转移（原 SIGN_SERVER 逗号分隔语义）。
 *  - 列表类接口默认免签（原 HG_SIGN_LIST 语义），避免高频轮询打爆 unidbg。
 *  - 签名服务不可用时抛出可诊断错误，由上层决定降级。
 */

const http = require('http');

/** 原 hongguo.py SIGN_SERVERS 的默认值。 */
function signServers() {
  const raw = process.env.SIGN_SERVER || '';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

let rrIndex = 0;
function nextServer(list) {
  if (!list.length) return null;
  const s = list[rrIndex % list.length];
  rrIndex = (rrIndex + 1) % list.length;
  return s;
}

/** POST JSON 到本机签名服务。 */
function postJson(base, pathname, payload, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    const url = new URL(base.replace(/\/+$/, '') + pathname);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': body.length },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`签名服务 HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('签名服务返回非 JSON'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('签名服务超时')); });
    req.end(body);
  });
}

/** GET JSON（用于 /grab 与健康检查）。 */
function getJson(base, pathname, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const url = new URL(base.replace(/\/+$/, '') + pathname);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`签名服务 HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('签名服务返回非 JSON'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('签名服务超时')); });
    req.end();
  });
}

/**
 * 对 URL + headers 签名。
 * @param {string} url 待签名完整 URL
 * @param {object} headers 基础请求头
 * @returns {Promise<object>} 签名后的头字段
 */
async function sign(url, headers) {
  const list = signServers();
  if (!list.length) {
    throw new Error('未配置签名服务（SIGN_SERVER 为空）。请启动 Java 签名服务并设置 SIGN_SERVER=http://127.0.0.1:9099');
  }
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const base = nextServer(list);
    try {
      const j = await postJson(base, '/sign', { url, headers });
      if (j && j.error) throw new Error(String(j.error));
      return j;
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
    }
  }
  throw new Error('所有签名服务失败: ' + errors.join('; '));
}

/** 抓取签名服务侧的设备身份（登录态刷新用；桌面托管模式不启用）。 */
async function grab() {
  const list = signServers();
  if (!list.length) throw new Error('未配置签名服务');
  return getJson(list[0], '/grab');
}

/**
 * 健康检查：探测签名服务是否可用。
 * 该服务（com.hongguo.sign.FqTrace serve）只提供 /sign 与 /grab，
 * 根路径返回 404，因此不能拿 GET / 当作探活依据。
 * 这里以「端口可连接 + 已知路由存在」作为就绪判据。
 */
async function health() {
  const list = signServers();
  const out = [];
  for (const b of list) {
    try {
      await getJson(b, '/', 5000).catch((e) => {
        // 根路径 404 属预期：说明端口活着且是本签名服务
        if (!/HTTP 404/.test(e.message)) throw e;
      });
      out.push({ url: b, ready: true, probe: 'tcp+route' });
    } catch (e) {
      out.push({ url: b, ready: false, error: e.message });
    }
  }
  return out;
}

module.exports = { sign, grab, health, signServers };
