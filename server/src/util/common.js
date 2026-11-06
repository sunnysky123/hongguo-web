'use strict';
/**
 * 跨模块共用的小工具。
 *
 * 存在的目的：这些能力此前在多个文件里各自实现了一份
 * （sleep / readFully / escapeRe / LRU 缓存），属于项目内部重复造轮子。
 * 统一收敛到这里，避免行为随时间分叉。
 *
 * 注意：凡是 Node 内置已能直接完成的（Buffer 读写、path、URLSearchParams 等），
 * 这里不再包装，调用方直接用内置 API。
 */
const fs = require('fs');

// ==================== 时间 ====================

/** 异步睡眠。 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 带 unref 的异步睡眠：不阻止进程退出（后台重试等场景用）。 */
function sleepUnref(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

/** 同步睡眠（Node 无同步 sleep，Atomics.wait 是标准做法）。 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// ==================== 文件读取 ====================

/**
 * 从 fd 的 position 处读满 length 字节，写进 buf 的 offset 起。
 * 读不满（遇到 EOF）抛错——调用点都要求区间完整。
 */
function readFullySync(fd, buf, offset, length, position) {
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, offset + got, length - got, position + got);
    if (n <= 0) throw new Error('读取越界：源数据提前结束');
    got += n;
  }
}

// ==================== 正则 ====================

/**
 * 正则元字符转义；用于把普通字符串安全拼进 new RegExp。
 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ==================== 错误信息 ====================

/**
 * 取异常文案：Error 用 message，其余原样转字符串；null/undefined 返回 'null'。
 * 此前 stream.js 与 download.js 各有一份相同实现，统一收敛到这里。
 */
function errMsg(e) {
  if (e === null || e === undefined) return 'null';
  return (e.message !== undefined && e.message !== null) ? String(e.message) : String(e);
}

// ==================== 访问序 LRU 缓存 ====================

/**
 * 访问序 LRU + 容量上限缓存。
 *
 * 合并了此前两套独立实现：
 *  - safeguards 的 cacheGet/cacheSet/trim（条数 + 字节双上限，带 TTL）
 *  - server.js 的 imgCache（条数/字节上限，无 TTL）
 * 因此同时支持「最多 N 条」「最多 N 字节」「每条 TTL」三种约束，
 * 且都可单独关闭（传 0 或 Infinity）。
 *
 * 结构约定：Map 头部是最久未访问的，命中后删除重插到尾部。
 */
class LruCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries] 最多条数，默认 Infinity
   * @param {number} [opts.maxBytes]   总字节上限，默认 Infinity
   * @param {number} [opts.maxItemBytes] 单条字节上限，超过则不缓存，默认 Infinity
   * @param {function} [opts.weigh] 计算单条字节数的函数，默认 1
   */
  constructor(opts = {}) {
    this.map = new Map();
    this.bytes = 0;
    this.maxEntries = opts.maxEntries === undefined ? Infinity : opts.maxEntries;
    this.maxBytes = opts.maxBytes === undefined ? Infinity : opts.maxBytes;
    this.maxItemBytes = opts.maxItemBytes === undefined ? Infinity : opts.maxItemBytes;
    this.weigh = typeof opts.weigh === 'function' ? opts.weigh : () => 1;
  }

  /** 当前条数。 */
  get size() { return this.map.size; }

  /** 当前累计字节数。 */
  get byteSize() { return this.bytes; }

  /** 读取；未命中或已过期返回 null。命中会刷新 LRU 顺序。 */
  get(key, now = Date.now()) {
    const e = this.map.get(key);
    if (e === undefined) return null;
    if (e.expire !== 0 && e.expire <= now) {
      this._drop(key);
      return null;
    }
    // 访问序 LRU：删除后重插到尾部
    this.map.delete(key);
    this.map.set(key, e);
    return e.val;
  }

  /** 是否命中且未过期（不刷新 LRU 顺序）。 */
  has(key, now = Date.now()) {
    const e = this.map.get(key);
    if (e === undefined) return false;
    if (e.expire !== 0 && e.expire <= now) {
      this._drop(key);
      return false;
    }
    return true;
  }

  /**
   * 写入。ttlSec <= 0 表示不缓存（保持原 safeguards 语义）。
   * @param {number} [ttlSec] 存活秒数，默认 0（不缓存）
   */
  set(key, val, ttlSec = 0) {
    if (!(ttlSec > 0)) {
      // 不缓存：清掉同名旧值，避免脏读
      this._drop(key);
      return;
    }
    const weight = this.weigh(val);
    if (weight > this.maxItemBytes) {
      this._drop(key);
      return;
    }
    this._drop(key);
    this.map.set(key, { val, expire: Date.now() + ttlSec * 1000, weight });
    this.bytes += weight;
    this._trim();
  }

  /**
   * 永久写入（无 TTL）。等价于 set(key, val, Infinity)——仅供不需要过期的缓存用。
   */
  setForever(key, val) {
    const weight = this.weigh(val);
    if (weight > this.maxItemBytes) {
      this._drop(key);
      return;
    }
    this._drop(key);
    this.map.set(key, { val, expire: 0, weight });
    this.bytes += weight;
    this._trim();
  }

  /** 删除单条。 */
  delete(key) {
    const had = this.map.has(key);
    this._drop(key);
    return had;
  }

  /** 清空。 */
  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  /** 清掉全部已过期条目；返回删除条数。 */
  sweep(now = Date.now()) {
    let n = 0;
    for (const [k, e] of [...this.map]) {
      if (e.expire !== 0 && e.expire <= now) {
        this._drop(k);
        n++;
      }
    }
    return n;
  }

  /** 只删不触发裁剪（内部用）。 */
  _drop(key) {
    const e = this.map.get(key);
    if (e === undefined) return;
    this.map.delete(key);
    this.bytes -= e.weight;
  }

  /** 裁剪到上限内：按 LRU 顺序从头淘汰。 */
  _trim() {
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes)
           && this.map.size > 0) {
      const first = this.map.keys().next().value;
      this._drop(first);
    }
  }
}

module.exports = { sleep, sleepUnref, sleepSync, readFullySync, escapeRe, errMsg, LruCache };
