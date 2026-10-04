'use strict';
/**
 * 风控与稳定性辅助：内存缓存、节流、风控识别、设备身份池。
 * 移植自原 Python 模块 safeguards.py + devicepool.py。
 */

const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 缓存 ----------------
const _mem = new Map(); // key -> { val, expire }

function cacheKey(...parts) {
  return parts.map((p) => String(p)).join(':');
}

function cacheGet(key) {
  const hit = _mem.get(key);
  if (!hit) return null;
  if (hit.expire && hit.expire < Date.now()) {
    _mem.delete(key);
    return null;
  }
  // 命中后延长滑动过期
  if (hit.slide) hit.expire = Date.now() + hit.slide;
  return hit.val;
}

function cacheSet(key, val, ttl) {
  if (ttl <= 0) return;
  if (_mem.size > 20000) {
    // 简易 LRU 近似：清掉最早过期的一批
    const sorted = [..._mem.entries()].sort((a, b) => (a[1].expire || 0) - (b[1].expire || 0));
    for (let i = 0; i < 2000; i++) _mem.delete(sorted[i][0]);
  }
  _mem.set(key, { val, expire: ttl > 0 ? Date.now() + ttl * 1000 : 0, slide: 0 });
}

// ---------------- 节流 ----------------
class Throttle {
  constructor() {
    this.minIntervalMs = parseInt(process.env.HG_THROTTLE_MS || '260', 10);
    this.last = 0;
    this.chain = Promise.resolve();
  }
  /** 串行化节流：保证任意两次外部 API 调用间隔 >= minIntervalMs。 */
  wait() {
    const run = async () => {
      const now = Date.now();
      const gap = now - this.last;
      if (gap < this.minIntervalMs) await sleep(this.minIntervalMs - gap);
      this.last = Date.now();
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }
}
const throttle = new Throttle();

// ---------------- 风控识别 ----------------
const AUTH_CODES = new Set([401, 403, 8, 1001]);
const AUTH_KEYWORDS = ['token', '登录', 'login', '未登录', 'not login', 'unauthor'];
const RISK_CODES = new Set([429, 110001, 110002, 110003]);
const RISK_KEYWORDS = ['verify', 'captcha', 'risk', '频繁', '稍后', '验证', 'rate limit', 'too many'];

class RiskControlError extends Error { constructor(m) { super(m); this.name = 'RiskControlError'; } }
class AuthExpiredError extends Error { constructor(m) { super(m); this.name = 'AuthExpiredError'; } }

/** 检查上游业务响应，命中风控/登录态失效则抛对应错误（附安全诊断信息）。 */
function checkResponse(j) {
  if (!j || typeof j !== 'object') return;
  const code = typeof j.code === 'number' ? j.code : null;
  const msg = String(j.message || j.msg || '').toLowerCase();

  const knownRisk = code !== null && RISK_CODES.has(code);
  const riskKeyword = RISK_KEYWORDS.some((w) => msg.includes(w));
  if (knownRisk || (code !== null && code !== 0 && riskKeyword)) {
    const err = new RiskControlError(`风控/限流 (code=${code})`);
    err.safe_response = { code, known_risk_code: knownRisk, risk_keyword: riskKeyword };
    throw err;
  }

  const knownAuth = code !== null && AUTH_CODES.has(code);
  const authKeyword = AUTH_KEYWORDS.some((w) => msg.includes(w));
  if (knownAuth || (code !== null && code !== 0 && authKeyword)) {
    const err = new AuthExpiredError(`登录态失效 (code=${code})`);
    err.safe_response = { code, known_auth_code: knownAuth, auth_keyword: authKeyword };
    throw err;
  }
}

// ---------------- 设备身份池 ----------------
const UA_TEMPLATES = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];

/**
 * 设备身份池：分散 device_id / cdid，降低风控。
 * size<=0 或托管模式时返回 null（单设备，直接沿用 baseQuery 里的稳定 device_id）。
 *
 * 注：这里刻意不为每个池设备生成 iid —— 实测随机 iid 与 device_id 不匹配时，
 * 上游会直接返回空响应（风控拦截），详见 server/src/device.js。
 */
function loadDevicePool(baseQuery, { size, managed, baseDeviceId }) {
  if (managed || !size || size <= 0) return null;
  const devices = [];
  for (let i = 0; i < size; i++) {
    const rnd = (n) => crypto.randomBytes(8).readBigUInt64BE() % BigInt(n);
    devices.push({
      query: {
        device_id: String(rnd(9e15) + 1e15),
        cdid: String(rnd(9e15) + 1e15),
        device_type: 'audit-windows',
      },
      user_agent: UA_TEMPLATES[i % UA_TEMPLATES.length],
    });
  }
  // 单设备池沿用主身份，保持与 baseQuery 一致
  if (size === 1 && baseDeviceId) devices[0].query.device_id = baseDeviceId;
  let idx = 0;
  return {
    current() { return devices[idx % devices.length]; },
    rotate() { idx = (idx + 1) % devices.length; return devices[idx]; },
    size: devices.length,
  };
}

module.exports = {
  sleep, cacheGet, cacheSet, cacheKey, throttle, Throttle,
  checkResponse, RiskControlError, AuthExpiredError,
  RISK_CODES, AUTH_CODES, loadDevicePool,
};
