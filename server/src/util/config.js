'use strict';
/**
 * 启动配置装载：server/config/config.json。
 *
 * 取值优先级（高到低）：
 *   1. 环境变量（如 PORT=9000，CI 与临时覆盖用）
 *   2. 本配置文件 server/config/config.json
 *   3. 代码内默认值
 *
 * 约定：配置文件用小写蛇形键名（api.port），环境变量用大写下划线（API_PORT），
 * 二者通过 ENV_OF 映射到同一配置项。
 *
 * 配置文件缺失或解析失败时静默降级为「无配置」，不影响启动。
 */
const fs = require('fs');
const path = require('path');
const Json = require('./json');
const Log = require('./log');

/** 配置项候选路径（相对 cwd 与仓库根各试一次），按优先级尝试。 */
const PATHS = ['server/config/config.json', 'scripts/config.json', 'config.json'];

/** 仓库根目录（本文件位于 <root>/server/src/util）。 */
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** 配置键 → 环境变量名。 */
const ENV_OF = {
  // ---- API 服务 ----
  'api.host': 'BIND_HOST',
  'api.port': 'PORT',
  // ---- 启动器行为 ----
  'launcher.open_browser': 'HG_OPEN_BROWSER',
  // ---- 运行时调优 ----
  'runtime.data_dir': 'HONGGUO_DATA_DIR',
  'runtime.device_id': 'HG_DEVICE_ID',
  'runtime.cache.max_files': 'HONGGUO_CACHE_MAX_FILES',
  'runtime.cache.mem_max': 'HG_MEM_CACHE_MAX',
  'runtime.cache.mem_max_mb': 'HG_MEM_CACHE_MAX_MB',
  'runtime.cache.img_max_mb': 'HG_IMG_CACHE_MAX_MB',
  'runtime.cache.img_max_kb': 'HG_IMG_MAX_KB',
  'runtime.throttle_ms': 'HG_THROTTLE_MS',
  'runtime.download.dir': 'HONGGUO_DOWNLOAD_DIR',
  'runtime.download.concurrency': 'HONGGUO_DOWNLOAD_CONCURRENCY',
  'runtime.rate_buckets_max': 'HG_RATE_BUCKETS_MAX',
  'runtime.rate_bucket_idle_ms': 'HG_RATE_BUCKET_IDLE_MS',
  'runtime.sweep_interval_ms': 'HG_SWEEP_INTERVAL_MS',
};

/** 候选文件实际存在的路径（用于 loadedFrom）。 */
function existingPath(c) {
  try { return fs.existsSync(c); } catch (e) { return false; }
}

function candidateList() {
  const out = [];
  const custom = Log.env('HONGGUO_CONFIG', null);
  if (custom) out.push(custom);
  for (const p of PATHS) {
    out.push(p);
    out.push(path.join(ROOT, p));
  }
  // 去重
  return [...new Set(out)];
}

function load() {
  const custom = Log.env('HONGGUO_CONFIG', null);
  for (const c of candidateList()) {
    try {
      if (!existingPath(c)) continue;
      let raw = fs.readFileSync(c);
      if (raw.length === 0) return null;
      // 容忍 UTF-8 BOM：记事本存 UTF-8 时会加 EF BB BF
      if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
        raw = raw.subarray(3);
      }
      const text = raw.toString();
      if (text.trim() === '') return null;
      const m = Json.parseObject(text);
      return (m === null || Object.keys(m).length === 0) ? null : m;
    } catch (e) {
      // 试下一个候选路径
    }
  }
  void custom;
  return null;
}

const CFG = load();

/** 配置文件实际路径，未装载时返回 null。 */
function loadedFrom() {
  if (CFG === null) return null;
  for (const c of candidateList()) {
    if (existingPath(c)) return c;
  }
  return null;
}

/** 按点分键路径取原始对象，如 get("api")、get("api.port")；未配置返回 null。 */
function get(dottedKey) {
  if (CFG === null) return null;
  let cur = CFG;
  for (const seg of String(dottedKey).split('.')) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = cur[seg];
    if (cur === null || cur === undefined) return null;
  }
  return cur;
}

function envNameOf(key) { return ENV_OF[key]; }

/** 读取字符串配置：环境变量 > 配置文件 > 默认值。 */
function str(key, def) {
  const env = envNameOf(key);
  if (env) {
    const v = Log.env(env, null);
    if (v !== null) return v;
  }
  const o = get(key);
  if (o === null || o === undefined) return def;
  const s = Json.optStr(o, '').trim();
  return s === '' ? def : s;
}

/** 读取整型配置，非法值回落到默认值。 */
function num(key, def) {
  const env = envNameOf(key);
  if (env) {
    const v = Log.env(env, null);
    if (v !== null) {
      const n = parseInt(v.trim(), 10);
      if (!Number.isNaN(n)) return n;
    }
  }
  const o = get(key);
  if (o === null || o === undefined) return def;
  if (typeof o === 'number') return Math.trunc(o);
  const n = parseInt(Json.optStr(o, '').trim(), 10);
  return Number.isNaN(n) ? def : n;
}

function parseBool(s, def) {
  if (s === null || s === undefined) return def;
  const t = String(s).trim().toLowerCase();
  if (t === '') return def;
  if (t === '1' || t === 'true' || t === 'yes' || t === 'on') return true;
  if (t === '0' || t === 'false' || t === 'no' || t === 'off') return false;
  return def;
}

/** 读取布尔配置：true/1/yes/on 视为真；false/0/no/off 视为假。 */
function bool(key, def) {
  const env = envNameOf(key);
  if (env) {
    const v = Log.env(env, null);
    if (v !== null) return parseBool(v, def);
  }
  const o = get(key);
  if (o === null || o === undefined) return def;
  if (typeof o === 'boolean') return o;
  return parseBool(Json.optStr(o, ''), def);
}

/**
 * 当前项目版本号，取自 package.json 的 version 字段（全项目唯一来源）。
 * 读不到时返回 'unknown'，不报错。
 */
function version() {
  try {
    const p = path.join(ROOT, 'package.json');
    if (!fs.existsSync(p)) return 'unknown';
    const j = Json.parseObject(fs.readFileSync(p, 'utf8'));
    const v = Json.optStr(j.version, '').trim();
    return v === '' ? 'unknown' : v;
  } catch (e) {
    return 'unknown';
  }
}

/** 列出全部可配置键，供 --help 与文档同步。 */
function keys() {
  return Object.keys(ENV_OF).sort();
}

module.exports = { loadedFrom, get, str, num, bool, version, keys, ENV_OF, PATHS };
