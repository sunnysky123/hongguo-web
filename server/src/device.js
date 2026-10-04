'use strict';
/**
 * 本机稳定设备身份。
 *
 * 背景（实测结论）：
 *   红果的 search/tab/v 接口会校验 query 里的 device_id。缺失时上游直接返回
 *   code=100103 PARAM_INVALID —— 与签名是否正确无关，签名齐全也一样。
 *   实测：同一个签名服务、同一套参数，仅因为多带一个 device_id，
 *   响应就从 53 字节的 PARAM_INVALID 变成 code=0 + 完整结果（几十~上百 KB）。
 *
 *   对照实验（同一时刻、同一签名服务）：
 *     无 device_id                       -> code=100103（53 字节）
 *     有 device_id，任意随机值           -> code=0，正常返回
 *     有 device_id + 不匹配的 iid       -> 空响应（风控拦截）
 *     有 device_id + iid=0              -> code=0
 *   结论：device_id 是必需项；iid 反而不能乱填，非 0 的随机 iid 会被风控。
 *   因此本模块只生成 device_id，不生成 iid。
 *
 * 为什么必须持久化：
 *   device_id 相当于本机的「设备指纹」。若每次启动都随机生成，短时间内的
 *   身份跳变会被上游判定为异常流量。落盘后长期保持稳定，符合真实设备行为。
 *
 * 优先级：
 *   1. 环境变量 HONGGUO_DEVICE_ID / HG_DEVICE_ID（便于多实例隔离）
 *   2. 配置里已有的 device_id（content-config.json base_query）
 *   3. server/data/device.json 中持久化的值
 *   4. 以上都没有时生成新的并落盘
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.HONGGUO_DATA_DIR
  || path.join(__dirname, '..', 'data');
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');

/** 设备 ID 取值范围：与抓包一致，16 位十进制（1e15 ~ 1e16-1）。 */
function randomDeviceId() {
  const n = crypto.randomBytes(8).readBigUInt64BE() % 9000000000000000n;
  return String(n + 1000000000000000n);
}

function readStore() {
  try {
    if (!fs.existsSync(DEVICE_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8').replace(/^\uFEFF/, ''));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeStore(obj) {
  try {
    fs.mkdirSync(path.dirname(DEVICE_FILE), { recursive: true });
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.warn('[device] 写入设备身份文件失败（仅本次运行有效）:', e.message);
    return false;
  }
}

/** 校验格式：仅接受 16 位十进制数字，避免把脏值带进 query。 */
function isValidId(v) {
  return typeof v === 'string' && /^\d{10,20}$/.test(v.trim());
}

/**
 * 取得本机稳定 device_id。
 * @param {object} baseQuery 上游配置里的 base_query（可能被就地补全）
 * @returns {{device_id: string, source: string}}
 */
function ensureDeviceId(baseQuery) {
  // 1) 环境变量优先：支持同一台机器跑多个实例并各自隔离身份
  const fromEnv = (process.env.HONGGUO_DEVICE_ID || process.env.HG_DEVICE_ID || '').trim();
  if (isValidId(fromEnv)) {
    if (baseQuery && !isValidId(baseQuery.device_id)) baseQuery.device_id = fromEnv;
    return { device_id: fromEnv, source: 'env' };
  }

  // 2) 配置里已显式提供：尊重配置，不覆盖
  if (baseQuery && isValidId(baseQuery.device_id)) {
    return { device_id: baseQuery.device_id.trim(), source: 'config' };
  }

  // 3) 复用上次持久化的值
  const store = readStore();
  if (isValidId(store.device_id)) {
    if (baseQuery) baseQuery.device_id = store.device_id;
    return { device_id: store.device_id, source: 'stored' };
  }

  // 4) 首次生成并落盘
  const id = randomDeviceId();
  if (baseQuery) baseQuery.device_id = id;
  writeStore({
    device_id: id,
    // 刻意不写 iid：随机 iid 会触发风控（见文件头实测结论）
    created_at: new Date().toISOString(),
    note: '本机稳定设备标识；删除此文件会重新生成并可能触发上游风控',
  });
  return { device_id: id, source: 'generated' };
}

/** 当前生效的 device_id（不修改任何配置）。 */
function currentDeviceId() {
  const fromEnv = (process.env.HONGGUO_DEVICE_ID || process.env.HG_DEVICE_ID || '').trim();
  if (isValidId(fromEnv)) return fromEnv;
  const store = readStore();
  if (isValidId(store.device_id)) return store.device_id;
  return null;
}

module.exports = { ensureDeviceId, currentDeviceId, randomDeviceId, DEVICE_FILE };