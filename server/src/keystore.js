'use strict';
/**
 * 本地链路密钥管理。
 * 移植自原 Python 模块 apikeys.py 的 KeyStore。
 *
 * 设计：数据接口强制要求有效密钥（x-api-key 头或 ?api_key= 查询参数），
 * 管理接口另用 ADMIN_TOKEN 口令校验，两者分离。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.HONGGUO_DATA_DIR
  || path.join(__dirname, '..', 'data');
const KEYS_FILE = path.join(DATA_DIR, 'apikeys.json');

class KeyStore {
  constructor(file = KEYS_FILE) {
    this.file = file;
    this.keys = new Map(); // key -> { note, enabled, createdAt }
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const row of raw.keys || []) {
        this.keys.set(row.key, { note: row.note || '', enabled: row.enabled !== false, createdAt: row.createdAt });
      }
    } catch (e) {
      console.warn('[keystore] 读取密钥文件失败，使用空集合:', e.message);
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const rows = [...this.keys.entries()].map(([key, v]) => ({ key, ...v }));
      fs.writeFileSync(this.file, JSON.stringify({ keys: rows }, null, 2));
    } catch (e) {
      console.warn('[keystore] 写入密钥文件失败（仅内存生效）:', e.message);
    }
  }

  /** 首次启动时若无任何密钥，自动签发一把本地密钥，避免用户手动配置。 */
  ensureBootstrap() {
    if (this.keys.size > 0) return null;
    const key = this.generate('bootstrap');
    return key;
  }

  generate(note = '') {
    const key = 'hg_' + crypto.randomBytes(24).toString('hex');
    this.keys.set(key, { note, enabled: true, createdAt: new Date().toISOString() });
    this._save();
    return key;
  }

  isValid(key) {
    if (!key) return false;
    const rec = this.keys.get(String(key));
    return !!(rec && rec.enabled);
  }

  list() {
    return [...this.keys.entries()].map(([key, v]) => ({ key, ...v }));
  }

  countEnabled() {
    let n = 0;
    for (const v of this.keys.values()) if (v.enabled) n++;
    return n;
  }

  /** 撤销或启用一把密钥。 */
  revoke(key, enabled = false) {
    const rec = this.keys.get(String(key));
    if (!rec) return false;
    rec.enabled = !!enabled;
    this._save();
    return true;
  }

  delete(key) {
    const ok = this.keys.delete(String(key));
    if (ok) this._save();
    return ok;
  }
}

module.exports = { KeyStore, KEYS_FILE };
