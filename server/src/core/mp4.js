'use strict';
/**
 * 纯文件 / 纯算法 MP4 CENC 解密。
 *
 * 不使用正则扫描字节流，而是完整解析 ISO BMFF 盒结构，因此对多 trak、大小端、
 * 64 位偏移都更稳健。
 *
 * 解密方案：CENC 的 AES-128-CTR，计数器为 128 位大端，
 *   counter = (base_iv_high64 + sampleIndex) << 64，即低 64 位恒为 0。
 */

const fs = require('node:fs');
const Crypto = require('../util/crypto');
const { readFullySync } = require('../util/common');

/** 需要在 trak 内递归查找的容器盒。 */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf',
]);

// ==================== 字节视图（支持非零基址） ====================

/**
 * 一段字节 + 它在文件中的起始绝对偏移。
 *
 * 为什么需要它：Box.start 记录的是**文件绝对偏移**，而大小端读取助手
 * 直接用绝对下标索引字节数组。整文件读入内存时 base 恒为 0；
 * 但流式方案只把 moov 段（几MB）载入内存时，该段首字节对应的文件偏移
 * 远非 0，若不做 base 换算，所有偏移都会整体错位。
 */
class ByteView {
  constructor(b, base) {
    this.b = b;
    this.base = base;
  }

  /** 整文件视图（base = 0），等价于历史行为。 */
  static whole(buf) {
    return new ByteView(buf, 0);
  }

  idx(fileOffset) { return fileOffset - this.base; }

  /** 越界安全的取字节；越界返回 0（调用点均已有边界校验）。 */
  at(fileOffset) {
    const i = this.idx(fileOffset);
    return (i < 0 || i >= this.b.length) ? 0 : (this.b[i] & 0xFF);
  }
}

/** 把 Buffer / ByteView 统一成 ByteView。 */
function asView(bufOrView) {
  return (bufOrView instanceof ByteView) ? bufOrView : ByteView.whole(bufOrView);
}

// ==================== 样本存储抽象 ====================

/**
 * 样本字节的随机读写存储。
 *
 * 引入它的目的：解密只需按样本表逐个读写 [offset, offset+size) 区间，
 * 没有任何跨样本依赖（AES-CTR 每样本独立计数器，长度守恒），
 * 因此完全不需要把整个 MP4 读进堆内存 —— 这正是整文件方案内存暴涨的根源。
 *
 * 实现约定：length() / read(off,len)->Buffer / write(off,data)。
 */

/** 整文件已在内存时的存储实现（保持历史行为，供自检与小文件使用）。 */
class ByteArrayStore {
  constructor(buf) { this.buf = buf; }

  length() { return this.buf.length; }

  read(off, len) { return this.buf.subarray(off, off + len); }

  write(off, data) { data.copy(this.buf, off); }
}

/** 基于 fd（或 Node 风格随机访问文件对象）的存储实现：堆内存占用与文件大小解耦。 */
class RafStore {
  constructor(raf, bufSize) {
    this.raf = raf;
    // 仅保留 bufSize 以对齐构造签名（实际读缓冲按需分配）
    this.bufSize = Math.max(4096, bufSize | 0);
  }

  /** 取底层 fd：既接受 fs.openSync 返回的 fd，也接受带 .fd 的文件对象。 */
  _fd() {
    if (typeof this.raf === 'number') return this.raf;
    if (this.raf && typeof this.raf.fd === 'number') return this.raf.fd;
    throw new Error('RafStore 需要 fd 或含 fd 的文件对象');
  }

  length() {
    if (typeof this.raf === 'number') return fs.fstatSync(this.raf).size;
    if (this.raf && typeof this.raf.length === 'function') return this.raf.length();
    if (this.raf && typeof this.raf.statSync === 'function') return this.raf.statSync().size;
    return fs.fstatSync(this._fd()).size;
  }

  read(off, len) {
    const buf = Buffer.allocUnsafe(len);
    readFullySync(this._fd(), buf, 0, len, off);
    return buf;
  }

  write(off, data) {
    const fd = this._fd();
    let written = 0;
    while (written < data.length) {
      written += fs.writeSync(fd, data, written, data.length - written, off + written);
    }
  }
}

// ==================== 盒结构 ====================

/** MP4 盒。 */
class Box {
  constructor(type, start, headerSize, size) {
    this.type = type;
    this.start = start;            // 盒起始绝对偏移
    this.headerSize = headerSize;  // 盒头长度
    this.size = size;              // 盒总长度（含头）
    this.children = [];
  }

  end() { return this.start + this.size; }

  payloadStart() { return this.start + this.headerSize; }

  child(t) {
    for (const c of this.children) if (c.type === t) return c;
    return null;
  }

  childrenOf(t) {
    const out = [];
    for (const c of this.children) if (c.type === t) out.push(c);
    return out;
  }
}

/** 轨道信息。 */
class Track {
  constructor() {
    this.trackId = 0;
    this.handler = null;           // 'vide' | 'soun' | ...
    this.width = 0;
    this.height = 0;
    this.sampleCount = 0;
    this.sizes = [];               // number[]
    this.offsets = [];             // number[]
    this.ivs = null;               // hex，元素为 8 或 16 字节
    this.ivSize = 16;
    this.kid = null;
    this.constantIv = null;
  }
}

/** 解析结果。 */
class Analysis {
  constructor() {
    this.tracks = [];
    this.timescale = 90000;
  }
}

/** moov 盒在文件中的位置。 */
class MoovSpan {
  constructor(start, size) {
    this.start = start;
    this.size = size;
  }

  end() { return this.start + this.size; }
}

/** 解密结果。 */
class DecryptResult {
  constructor(decrypted, total) {
    this.decrypted = decrypted;
    this.total = total;
  }
}

// ==================== 大小端读取 ====================
//
// 全部以「文件绝对偏移」为入参，内部经 ByteView.idx 换算成数组下标。
// 这样同一套读取逻辑既能服务整文件视图（base=0），
// 也能服务只载入 moov 段的窗口视图（base>0）。

function u8(v, p) { return v.at(p); }

// base === 0 时（整文件视图）直接用 Buffer 内置读法；
// base > 0 时（只载入 moov 的窗口视图）仍需先做基址换算，
// 此时退回逐字节读取，因为内置读法的下标语义是相对 Buffer 起点。
function u16(v, p) {
  if (v.base === 0) {
    const i = p;
    if (i < 0 || i + 2 > v.b.length) {
      return ((v.at(p) & 0xFF) << 8) | (v.at(p + 1) & 0xFF);
    }
    return v.b.readUInt16BE(i);
  }
  return ((v.at(p) & 0xFF) << 8) | (v.at(p + 1) & 0xFF);
}

function u32(v, p) {
  if (v.base === 0 && p >= 0 && p + 4 <= v.b.length) {
    return v.b.readUInt32BE(p);
  }
  return (v.at(p) & 0xFF) * 0x1000000
       + (v.at(p + 1) & 0xFF) * 0x10000
       + (v.at(p + 2) & 0xFF) * 0x100
       + (v.at(p + 3) & 0xFF);
}

function u64(v, p) {
  if (v.base === 0 && p >= 0 && p + 8 <= v.b.length) {
    return Number(v.b.readBigUInt64BE(p));
  }
  let r = 0n;
  for (let i = 0; i < 8; i++) r = (r << 8n) | BigInt(v.at(p + i) & 0xFF);
  return Number(r);
}

/** latin1 字符串（等价 JS 的 toString('latin1')）。 */
function latin1(v, from, to) {
  let i0 = v.idx(from);
  let i1 = v.idx(to);
  if (i0 < 0) i0 = 0;
  if (i1 > v.b.length) i1 = v.b.length;
  return v.b.toString('latin1', i0, i1);
}

/**
 * 区间字节的十六进制串（Buffer 内置 toString('hex')）。
 * 越界部分按旧实现语义补 '00'，避免调用方拿到短串。
 */
function hexAt(v, from, to) {
  const i0 = v.idx(from);
  const i1 = v.idx(to);
  const a = Math.max(0, i0);
  const b = Math.min(i1, v.b.length);
  const inRange = a < b ? v.b.toString('hex', a, b) : '';
  const missing = (to - from) - (b - a);
  return missing > 0 ? inRange + '00'.repeat(missing) : inRange;
}

// ==================== 盒解析 ====================

/**
 * 解析 v 中 offset 起的盒树。
 *
 * @param bufOrByteView Buffer 或 ByteView
 * @param offset 起始偏移（文件绝对偏移）
 * @param end    结束偏移（不含，文件绝对偏移）
 * @returns {Box[]}
 */
function parseBoxes(bufOrByteView, offset, end) {
  const v = asView(bufOrByteView);
  const boxes = [];
  let p = offset;
  while (p + 8 <= end) {
    let size = u32(v, p);
    const type = latin1(v, p + 4, p + 8);
    let headerSize = 8;

    if (size === 1) {
      if (p + 16 > end) break;
      size = u64(v, p + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - p; // 延伸到文件末尾
    }

    if (size < headerSize || p + size > end || size < 0) break;
    const box = new Box(type, p, headerSize, size);
    if (CONTAINERS.has(type)) {
      box.children.push(...parseBoxes(v, box.payloadStart(), box.end()));
    } else if (type === 'stsd') {
      // stsd: version/flags(4) + entry_count(4)，之后是 sample entry
      box.children.push(...parseBoxes(v, box.payloadStart() + 8, box.end()));
    }
    boxes.push(box);
    p += size;
  }
  return boxes;
}

/** 递归查找第一个指定类型的盒。 */
function findBox(box, type) {
  for (const c of box.children) {
    if (c.type === type) return c;
    const hit = findBox(c, type);
    if (hit) return hit;
  }
  return null;
}

// ==================== 元信息 ====================

/** 解析 mvhd，取 timescale。 */
function readTimescale(v, moov) {
  const mvhd = moov.child('mvhd');
  if (mvhd == null) return 90000;
  const p = mvhd.payloadStart();
  const version = u8(v, p);
  if (version === 1) return u32(v, p + 20);
  return u32(v, p + 12);
}

/** tenc 信息。 */
class Tenc {
  constructor() {
    this.kid = null;
    this.constantIv = null;
    this.ivSize = 16;
    this.isProtected = false;
  }
}

/** 解析 trak 的 tkhd，取 track_ID 与宽高。 */
function readTrackHeader(v, trak) {
  const t = new Track();
  const tkhd = trak.child('tkhd');
  if (tkhd == null) return t;
  const p = tkhd.payloadStart();
  const version = u8(v, p);
  if (version === 1) {
    t.trackId = u32(v, p + 20);
    t.width = Math.trunc(u32(v, p + 88) / 65536);
    t.height = Math.trunc(u32(v, p + 92) / 65536);
  } else {
    t.trackId = u32(v, p + 12);
    t.width = Math.trunc(u32(v, p + 76) / 65536);
    t.height = Math.trunc(u32(v, p + 80) / 65536);
  }
  return t;
}

/** 解析 mdia/hdlr，取处理类型（vide / soun）。 */
function readHandler(v, trak) {
  const mdia = trak.child('mdia');
  const hdlr = mdia == null ? null : mdia.child('hdlr');
  if (hdlr == null) return null;
  return latin1(v, hdlr.payloadStart() + 8, hdlr.payloadStart() + 12);
}

/**
 * 解析 stbl 的样本表，得到每个样本在文件中的绝对偏移与长度。
 */
function readSampleTable(v, stbl, track) {
  const sizes = [];
  const offsets = [];

  // stsz：样本大小（size==0 时逐样本读取）
  const stsz = stbl.child('stsz');
  if (stsz != null) {
    const p = stsz.payloadStart() + 4; // 跳过 version/flags
    const uniform = u32(v, p);
    const count = u32(v, p + 4);
    if (uniform > 0) {
      for (let i = 0; i < count; i++) sizes.push(uniform);
    } else {
      for (let i = 0; i < count; i++) sizes.push(u32(v, p + 8 + i * 4));
    }
  }

  // stsc：样本到 chunk 的映射
  const stscEntries = []; // {firstChunk, samplesPerChunk, descIndex}
  const stsc = stbl.child('stsc');
  if (stsc != null) {
    const p = stsc.payloadStart() + 4;
    const n = u32(v, p);
    for (let i = 0; i < n; i++) {
      const q = p + 4 + i * 12;
      stscEntries.push({ firstChunk: u32(v, q), samplesPerChunk: u32(v, q + 4), descIndex: u32(v, q + 8) });
    }
  }

  // stco / co64：chunk 偏移
  const chunkOffsets = [];
  const stco = stbl.child('stco');
  if (stco != null) {
    const p = stco.payloadStart() + 4;
    const n = u32(v, p);
    for (let i = 0; i < n; i++) chunkOffsets.push(u32(v, p + 4 + i * 4));
  } else {
    const co64 = stbl.child('co64');
    if (co64 != null) {
      const p = co64.payloadStart() + 4;
      const n = u32(v, p);
      for (let i = 0; i < n; i++) chunkOffsets.push(u64(v, p + 4 + i * 8));
    }
  }

  // 依据 stsc 把 chunk 展开为样本偏移
  for (let e = 0; e < stscEntries.length; e++) {
    const cur = stscEntries[e];
    const next = (e + 1 < stscEntries.length) ? stscEntries[e + 1] : null;
    const lastChunk = next != null ? next.firstChunk - 1 : chunkOffsets.length;
    for (let ch = cur.firstChunk; ch <= lastChunk; ch++) {
      const ci = ch - 1;
      if (ci < 0 || ci >= chunkOffsets.length) break;
      let off = chunkOffsets[ci];
      for (let s = 0; s < cur.samplesPerChunk; s++) {
        const idx = offsets.length;
        if (idx >= sizes.length) break;
        offsets.push(off);
        off += sizes[idx];
      }
    }
  }

  track.sizes = sizes;
  track.offsets = offsets;
  track.sampleCount = sizes.length;
}

/**
 * 读取 tenc 盒的 default_KID、default_IV_size 与 constant IV（若有）。
 */
function readTenc(v, trak) {
  const sinf = findBox(trak, 'sinf');
  const schm = sinf == null ? null : sinf.child('schm');
  if (schm != null) {
    const p = schm.payloadStart() + 4;
    const scheme = latin1(v, p, p + 4);
    if (scheme !== 'cenc') return null; // 仅处理 CENC
  }
  const tenc = sinf == null ? null : sinf.child('tenc');
  if (tenc == null) return null;
  const out = new Tenc();
  const p = tenc.payloadStart();
  const version = u8(v, p);
  const flags = ((v.at(p + 1) & 0xFF) << 16) | ((v.at(p + 2) & 0xFF) << 8)
              | (v.at(p + 3) & 0xFF);
  let q;
  if (version === 0) {
    out.ivSize = u8(v, p + 4);
    q = p + 5;
  } else {
    out.ivSize = u8(v, p + 9);
    q = p + 10;
  }
  out.kid = hexAt(v, q, q + 16);
  if ((flags & 0x01) !== 0) {
    out.constantIv = hexAt(v, q + 16, q + 16 + out.ivSize);
  }
  out.isProtected = (flags & 0x02) !== 0;
  return out;
}

/**
 * 存在 subsample 信息时，无法直接用长度反推 IV 大小；
 * 改为假定 16 字节走一遍，若最终偏移不吻合再退回 8 字节。
 */
function estimateWithoutSubsample(v, start, end, count) {
  let q = start;
  let n = 0;
  while (q + 18 <= end && n < count) {
    const subsampleCount = u16(v, q + 16);
    q += 16 + 2 + subsampleCount * 6;
    n++;
  }
  if (q > end) return (end - start);
  return q - start;
}

/**
 * 解析 senc 盒，取每个样本的 IV。
 *
 * 重要：IV 长度并非总是 16 字节。本项目实测两种都存在：
 *   - 16 字节：标准 CENC，per-sample IV 为完整 128 位；
 *   - 8 字节：PIFF/简化形态，盒长度恰好等于 8 + count*IV_size。
 * 因此用「盒剩余长度 / 样本数」反推实际 IV 长度，并以 tenc 声明交叉校验。
 */
function readSencIVs(v, senc, tencIvSize) {
  const p = senc.payloadStart();
  const flags = ((v.at(p + 1) & 0xFF) << 16) | ((v.at(p + 2) & 0xFF) << 8)
              | (v.at(p + 3) & 0xFF);
  const count = u32(v, p + 4);
  const hasSubsample = (flags & 0x02) !== 0;

  // 反推 IV 长度：剩余字节里先扣掉 subsample 开销
  let payload = senc.end() - (p + 8);
  if (hasSubsample) payload = estimateWithoutSubsample(v, p + 8, senc.end(), count);
  let ivSize = count > 0 ? Math.trunc(payload / count) : 16;
  if (ivSize !== 8 && ivSize !== 16) {
    ivSize = (tencIvSize === 8) ? 8 : 16;
  }
  // tenc 声明优先（它是权威来源）
  if (tencIvSize === 8 || tencIvSize === 16) ivSize = tencIvSize;

  const ivs = [];
  let q = p + 8;
  for (let i = 0; i < count; i++) {
    if (q + ivSize > senc.end()) break;
    ivs.push(hexAt(v, q, q + ivSize));
    q += ivSize;
    if (hasSubsample) {
      if (q + 2 > senc.end()) break;
      const subsampleCount = u16(v, q);
      q += 2 + subsampleCount * 6;
    }
  }
  return ivs;
}

/**
 * 收集密文 mp4 中所有加密轨（视频 + 音频）及其样本表与 IV。
 *
 * @param bufOrView 字节视图。流式解密时只需传入「moov 段窗口」，
 *        Box.start 仍是文件绝对偏移，样本偏移才能对上 mdat 里的真实位置。
 */
function analyzeEncryptedTracks(bufOrView) {
  const v = asView(bufOrView);
  const top = parseBoxes(v, v.base, v.base + v.b.length);
  let moov = null;
  for (const b of top) if (b.type === 'moov') moov = b;
  if (moov == null) throw new Error('不是有效的 MP4：缺少 moov 盒');

  const out = new Analysis();
  out.timescale = readTimescale(v, moov);

  for (const trak of moov.childrenOf('trak')) {
    const mdia = trak.child('mdia');
    const minf = mdia == null ? null : mdia.child('minf');
    const stblBox = minf == null ? null : minf.child('stbl');
    if (stblBox == null) continue;

    const t = new Track();
    t.handler = readHandler(v, trak);
    const header = readTrackHeader(v, trak);
    t.trackId = header.trackId;
    t.width = header.width;
    t.height = header.height;
    readSampleTable(v, stblBox, t);
    if (t.sampleCount === 0) continue;

    // senc 可能在 stbl 内（明文 CENC），或经 saiz/saio 指向
    let senc = stblBox.child('senc');
    if (senc == null) senc = findBox(trak, 'senc');
    const tenc = readTenc(v, trak);
    // tenc 的 default_IV_size 是 IV 长度的权威来源
    t.ivs = senc != null ? readSencIVs(v, senc, tenc != null ? tenc.ivSize : 0) : null;
    t.ivSize = tenc != null ? tenc.ivSize : 16;
    t.kid = tenc != null ? tenc.kid : null;
    t.constantIv = tenc != null ? tenc.constantIv : null;

    out.tracks.push(t);
  }
  return out;
}

// ==================== moov 定位（流式前置） ====================

function hU32(h, p) {
  return (h[p] & 0xFF) * 0x1000000
       + (h[p + 1] & 0xFF) * 0x10000
       + (h[p + 2] & 0xFF) * 0x100
       + (h[p + 3] & 0xFF);
}

function hU64(h, p) {
  let r = 0n;
  for (let i = 0; i < 8; i++) r = (r << 8n) | BigInt(h[p + i] & 0xFF);
  return Number(r);
}

/** 基于 fd 的盒头读取器；实例本身可当作 (off,len)=>Buffer|null 函数使用。 */
class FileHeadReader {
  constructor(fd) {
    this.fd = fd;
    const self = this;
    const fn = (off, len) => self.head(off, len);
    fn.head = fn;
    return fn;
  }

  /** 读取 [off, off+len) 的盒头字节；越界返回 null 表示读不到。 */
  head(off, len) {
    try {
      const size = fs.fstatSync(this.fd).size;
      if (off < 0 || off + len > size) return null;
      const b = Buffer.alloc(len);
      readFullySync(this.fd, b, 0, len, off);
      return b;
    } catch (e) {
      return null;
    }
  }
}

/**
 * 只读顶层盒头，定位 moov 的 [start, size)。
 *
 * 顶层遍历每次只碰 8/16 字节盒头并按 p += size 跳跃，因此无需把文件读进内存
 * 即可找到 moov —— 即使 moov 在文件末尾（非 faststart 的常见形态）也只需
 * 顺序扫到文件尾。严格复刻 parseBoxes 的两条特殊规则：size==1 读 64 位
 * largesize、size==0 延伸到 EOF。
 *
 * @param headReader JS 函数 (off, len) => Buffer|null
 * @param fileLen 文件总长度
 * @returns {MoovSpan|null}
 */
function findMoov(headReader, fileLen) {
  let p = 0;
  while (p + 8 <= fileLen) {
    const h8 = headReader(p, 8);
    if (h8 == null) return null;
    let size = hU32(h8, 0);
    const type = h8.toString('latin1', 4, 8);
    let headerSize = 8;

    if (size === 1) {
      const h16 = headReader(p, 16);
      if (h16 == null) return null;
      size = hU64(h16, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = fileLen - p; // 延伸到文件末尾
    }
    if (size < headerSize || p + size > fileLen || size < 0) return null;

    if (type === 'moov') return new MoovSpan(p, size);
    p += size;
  }
  return null;
}

// ==================== CTR 计数器 ====================

function hexVal(code) {
  if (code >= 48 && code <= 57) return code - 48;   // 0-9
  if (code >= 97 && code <= 102) return code - 87;  // a-f
  if (code >= 65 && code <= 70) return code - 55;   // A-F
  return -1;
}

/**
 * 逐样本 IV（senc/PIFF 常为 8 字节）直接作为 CTR 计数器的高 64 位，低 64 位补 0。
 *
 * 本项目实测：senc 里的 IV 是「逐样本递增」的 8 字节序列，即 iv[i] = base_iv + i。
 * 因此「取 iv[i] 当高 64 位」与「base_iv 加 i 后左移」完全等价，
 * 但前者能天然兼容 16 字节 IV 的标准 CENC。
 */
function ivToCounter(ivHex) {
  const h = ivHex == null ? '' : String(ivHex).trim();
  // 16 字节标准 IV：本身就是 128 位计数器
  if (h.length >= 32) {
    return Crypto.unhex(h.substring(0, 32));
  }
  // 8 字节 IV（PIFF 形态）：位于高 64 位，低 64 位补 0 —— 即右侧补零
  let sb = h;
  while (sb.length < 32) sb += '0';
  return Crypto.unhex(sb.substring(0, 32));
}

/**
 * 构造 AES-128-CTR 的初始计数器：counter = (baseIvHi64 + index) << 64。
 *
 * 即 (hi+index).shiftLeft(64).and(2^128-1)：用 BigInt 做 mod 2^64 的加法，低 64 位恒为 0。
 */
function ctrCounter(baseIvHex, index) {
  const h = baseIvHex == null ? '' : String(baseIvHex).trim();
  let hi = 0n;
  // 只取前 16 个十六进制字符（高 64 位）；超出部分一律掩码丢弃
  const take = Math.min(h.length, 16);
  for (let i = 0; i < take; i++) {
    const d = hexVal(h.charCodeAt(i));
    if (d < 0) break;
    hi = (hi << 4n) | BigInt(d);
  }
  const sum = BigInt.asUintN(64, hi + BigInt(index));
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    out[i] = Number((sum >> BigInt(56 - 8 * i)) & 0xFFn); // 高 64 位
    out[8 + i] = 0;                                        // 低 64 位恒为 0
  }
  return out;
}

/** 取第 i 个样本的 CTR 计数器：优先用逐样本 IV，缺失时回退 base_iv + i。 */
function counterFor(track, baseIvHex, i) {
  if (track.ivs != null && i >= 0 && i < track.ivs.length && track.ivs[i] != null) {
    return ivToCounter(track.ivs[i]);
  }
  return ctrCounter(baseIvHex, i);
}

// ==================== 解密 ====================

function isStore(x) {
  return x != null && typeof x.read === 'function'
      && typeof x.write === 'function' && typeof x.length === 'function';
}

function asStore(bufOrStore) {
  return isStore(bufOrStore) ? bufOrStore : new ByteArrayStore(bufOrStore);
}

/**
 * 就地解密单轨的全部样本（AES-128-CTR），样本数据经存储抽象随机读写。
 *
 * 逐样本处理：每次只把「一个样本」放进内存，因此峰值堆内存与文件总大小无关。
 *
 * @param bufOrStore Buffer 或实现了 length/read/write 的存储
 * @param keyHex    content key（32 位十六进制）
 * @param baseIvHex 该轨 base_iv 高 8 字节（仅在无逐样本 IV 时使用）
 * @returns {DecryptResult}
 */
function decryptTrack(bufOrStore, track, keyHex, baseIvHex) {
  const store = asStore(bufOrStore);
  const key = Crypto.unhex(keyHex);
  if (key.length !== 16) throw new Error('content key 长度非法');
  const hasIvs = track.ivs != null && track.ivs.length > 0;
  if (!hasIvs && baseIvHex == null) {
    throw new Error('该轨既无逐样本 IV 也无 base_iv，无法解密');
  }
  const storeLen = store.length();
  let done = 0;
  for (let i = 0; i < track.sampleCount; i++) {
    const off = track.offsets[i];
    const size = track.sizes[i];
    if (size == null || size <= 0) continue;
    if (off < 0 || off + size > storeLen) continue;
    const counter = counterFor(track, baseIvHex, i);
    const sample = store.read(off, size);
    const plain = Crypto.aes128Ctr(key, counter, sample);
    // AES-CTR 长度守恒：plain.length == size，原地覆写同一区间
    store.write(off, plain);
    done++;
  }
  return new DecryptResult(done, track.sampleCount);
}

/** 取该轨的 base_iv 候选（16 位 hex = 计数器高 64 位）。 */
function trackBaseIvCandidates(track) {
  const out = [];
  const push = (hx) => {
    if (hx == null || hx === '') return;
    const hi = hx.length >= 16 ? hx.substring(0, 16) : hx;
    if (hi.length === 16 && !out.includes(hi)) out.push(hi);
  };
  push(track.constantIv);
  if (track.ivs != null) {
    for (const iv of track.ivs) {
      push(iv);
      if (out.length >= 4) break;
    }
  }
  return out;
}

// ==================== IV 自证 ====================

/**
 * AVCC 自证：4 字节大端长度前缀链必须自洽地走完整个样本，且每个 NAL 类型合法。
 * 也接受 Annex-B 起始码（00 00 00 01 / 00 00 01）。
 *
 * 关键点：一个视频样本通常含多个 NAL（SPS/PPS/SEI/IDR），
 * 所以必须遍历整条长度链，只看首个 NAL 会误判。
 */
function avccSelfOk(plain, size) {
  const n = Math.min(plain.length, size > 0 ? size : plain.length);
  if (n < 5) return false;
  // Annex-B 起始码
  if (plain[0] === 0 && plain[1] === 0
      && (plain[2] === 1 || (plain[2] === 0 && plain[3] === 1))) {
    return true;
  }
  let off = 0;
  let nals = 0;
  while (off + 5 <= n) {
    // plain 是单个样本的裸数组，base=0 视图即可
    const len = u32(ByteView.whole(plain), off);
    if (len <= 0 || off + 4 + len > n) return false;
    // NAL 头：1 bit forbidden_zero + 2 bit nal_ref_idc + 5 bit nal_unit_type
    if ((plain[off + 4] & 0x80) !== 0) return false;
    off += 4 + len;
    if (++nals > 64) return false;
  }
  return nals > 0 && (off === n || n - off <= 3);
}

/** 挑选探测样本：首个 + 中段若干 + 末尾，跳过 size 过小的样本。 */
function pickProbeIndices(track) {
  const n = track.sampleCount;
  if (n === 0) return [];
  const cand = [0, 1, 2, n >> 2, n >> 1, n - 1];
  const out = [];
  const seen = new Set();
  for (const i of cand) {
    if (i < 0 || i >= n) continue;
    if (seen.has(i)) continue;
    seen.add(i);
    if (track.sizes[i] >= 8) out.push(i);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * 用候选 base_iv 试解一个视频轨，返回能通过 AVCC 自证的 base_iv；失败返回 null。
 *
 * 只读不写：因此可在「moov 已解析、样本尚未解密」的任意阶段安全调用。
 */
function verifyVideoIv(bufOrStore, track, keyHex, candidates) {
  const store = asStore(bufOrStore);
  let key;
  try {
    key = Crypto.unhex(keyHex);
  } catch (e) {
    return null;
  }
  if (key.length !== 16) return null;

  const hasIvs = track.ivs != null && track.ivs.length >= track.sampleCount;
  let list;
  if (hasIvs) {
    list = [track.ivs[0]];
  } else {
    list = candidates != null ? candidates : [];
  }
  const storeLen = store.length();
  for (const cand of list) {
    let ok = 0;
    let tested = 0;
    for (const i of pickProbeIndices(track)) {
      const off = track.offsets[i];
      const size = track.sizes[i];
      if (size === 0 || off + size > storeLen) continue;
      tested++;
      const counter = counterFor(track, cand, i);
      const plain = Crypto.aes128Ctr(key, counter, store.read(off, size));
      if (avccSelfOk(plain, size)) ok++;
    }
    // 全部探测样本都自洽才算通过：避免 60% 阈值被噪声蒙混
    if (tested > 0 && ok === tested) return cand;
  }
  return null;
}

// ==================== 剥离 CENC 信令（纯 JS 减壳） ====================

/**
 * 视觉样本条目类型（VisualSampleEntry，固定头 78 字节）。
 * encv 为加密视频条目；其余为常见明文视频条目（万一信令已除也认得）。
 *
 * vvc1/vvi1 是标准 VVC（H.266）条目；bv2C/bvc2 是字节 ByteVC2 的私有条目
 * （红果部分新集只有这种片源）：样本条目名取自 sinf/frma 的 bvc2，
 * 其内部的解码配置盒名为 bv2C，两者大小写不一致是上游自身的不规范，
 * 这里两个都认。这类片源的解码配置是私有的，标准 VVC 播放器认不出，
 * 但把加密信令剥干净后，支持 ByteVC2 的播放器仍能打开 ——
 * 这正是「下载到本地播放」这条路能走通的前提。
 */
const VISUAL_ENTRY = new Set([
  'encv', 'hvc1', 'hev1', 'avc1', 'av01', 'mp4v', 'vp08', 'vp09', 'dvav', 'dva1',
  'vvc1', 'vvi1', 'bv2C', 'bvc2',
]);

/** 音频样本条目类型（AudioSampleEntry，QuickTime 布局固定头 28 字节）。 */
const AUDIO_ENTRY = new Set([
  'enca', 'mp4a', 'ac-3', 'ec-3', 'Opus', 'fLaC', 'samr', 'sawb',
]);

/** 样本条目固定头长度；未知类型返回 -1（调用方应放弃剥离）。 */
function entryFixedHeader(type) {
  if (VISUAL_ENTRY.has(type)) return 78;
  if (AUDIO_ENTRY.has(type)) return 28;
  return -1;
}

/**
 * 剥离 CENC 加密信令，产出普通 mp4 —— 纯 JS 实现，不调用任何外部程序。
 *
 * 前提：样本数据（mdat）已是解密后的明文，加密信令全部位于 moov：
 *   - stsd 样本条目（encv/enca）内的 sinf（frma/schm/schi>tenc）；
 *   - stbl 内的 senc/saio/saiz（逐样本 IV 与索引）；
 *   - moov 直属的 pssh（DRM 系统声明，若有）。
 *
 * 剥离后 moov 变小，其后所有绝对偏移（stco/co64 的 chunk 偏移）必须统一
 * 左移 delta，因此要求「全部 chunk 偏移都落在 moov 之后」。布局不符时
 * （moov 在尾部、偏移越界、64 位盒、未知条目类型、双 moov 等）返回 false，
 * 由调用方决定如何交付（本项目会保留未减壳的 raw 文件）。
 *
 * @returns {boolean} true 表示 out 已写好且通过自校验（盒链完整、加密信令除净）
 */
function stripEncryption(inPath, outPath) {
  try {
    return strip0(inPath, outPath);
  } catch (ignore) {
    // 任何意外都视为「布局不符」，交由调用方处理
    return false;
  }
}

// ==================== ByteVC2 → 标准 VVC（容器改写） ====================

/** VVC 参数集的 NAL 类型（ISO/IEC 23090-3）：VPS / SPS / PPS。 */
const NAL_VPS = 14;
const NAL_SPS = 15;
const NAL_PPS = 16;

/** 视觉样本条目的固定头长度（与 entryFixedHeader 的 78 一致）。 */
const VISUAL_FIXED = 78;

/**
 * 取 NAL 负载的前 n 个字节，途中拆掉 emulation prevention（00 00 03 → 00 00）。
 *
 * 为什么需要：SPS 开头的 profile_tier_level 是定长字段，但负载里可能插入
 * 0x03 防止与起始码混淆；不去掉就会整体错位一个字节，解析出的 profile/level
 * 全是错的。前几个字节里出现这种序列的概率极低，但不能假设不发生。
 */
function rbspHead(nal, n) {
  const out = [];
  for (let i = 2; i < nal.length && out.length < n; i++) {
    if (nal[i] === 0x00 && nal[i + 1] === 0x00 && nal[i + 2] === 0x03) {
      out.push(0x00, 0x00);
      i += 2;
    } else {
      out.push(nal[i]);
    }
  }
  return out;
}

/**
 * 从一个样本里挑出 VPS / SPS / PPS。
 *
 * 为什么从样本取而不是从私有配置盒取：bv2C 的内部布局是字节私有的
 * （尾部还带 "NBVC2-v1.3.4.8" 版本串），没有公开规范；而 mp4 的每个
 * 关键帧前都原样带着这三类 NAL，格式是标准 VVC，取出来即可直接用。
 *
 * @param {Buffer} sample 样本数据，内部是「4 字节长度 + NAL」的序列
 * @returns {{vps: Buffer|null, sps: Buffer|null, pps: Buffer|null}}
 */
function paramSetsOf(sample) {
  const out = { vps: null, sps: null, pps: null };
  let p = 0;
  while (p + 4 <= sample.length) {
    const n = sample.readUInt32BE(p);
    if (n === 0 || p + 4 + n > sample.length) break;
    const nal = sample.subarray(p + 4, p + 4 + n);
    if (nal.length >= 2) {
      const t = (nal[1] >> 3) & 0x1f;
      if (t === NAL_VPS && out.vps === null) out.vps = nal;
      else if (t === NAL_SPS && out.sps === null) out.sps = nal;
      else if (t === NAL_PPS && out.pps === null) out.pps = nal;
    }
    p += 4 + n;
    if (out.vps !== null && out.sps !== null && out.pps !== null) break;
  }
  return out;
}

/**
 * 组装标准 VvcDecoderConfigurationRecord（ISO/IEC 14496-15）。
 *
 * 字段来源：profile / tier / level / 色度格式 / 子层数都取自 SPS 开头的
 * profile_tier_level；位深按 8 bit 填 —— 红果的 BVC2 片源目前都是 8 bit，
 * 真出现 10 bit 时这里会标错，但解码走的是码流里的 SPS，不影响画面。
 *
 * 开头 4 个 0 不是填充：ffmpeg 的 mov 解析器把 vvcC 内容当作
 * 「4 字节 version/flags + record」，去掉这 4 字节会按 NAL 长度前缀误读，
 * 直接报 "Invalid NAL unit size"。
 *
 * @returns {Buffer|null} 记录本身；参数集不全时返回 null
 */
function buildVvcConfig(sets) {
  if (sets.sps === null || sets.pps === null) return null;
  const h = rbspHead(sets.sps, 5);
  if (h.length < 2) return null;
  const maxSubMinus1 = (h[1] >> 5) & 0x07;
  const chroma = (h[1] >> 3) & 0x03;
  const ptlPresent = h[1] & 0x01;
  let profile = 1;
  let tier = 0;
  let level = 105;
  let constraint = 0;
  if (ptlPresent === 1 && h.length >= 5) {
    profile = (h[2] >> 1) & 0x7f;
    tier = h[2] & 0x01;
    level = h[3];
    // 这一个字节本身就是 frame_only(1)+multilayer(1)+constraint(6)，
    // 与记录里 num_bytes_constraint_info=1 时的写法恰好一致，直接照搬。
    constraint = h[4];
  }
  const numSub = (maxSubMinus1 & 0x07) + 1;
  const packed = ((numSub & 0x07) << 4) | (0x01 << 2) | (chroma & 0x03);

  const arrays = [];
  if (sets.vps !== null) arrays.push([NAL_VPS, sets.vps]);
  arrays.push([NAL_SPS, sets.sps]);
  arrays.push([NAL_PPS, sets.pps]);

  let need = 13 + 1;
  for (const a of arrays) need += 5 + a[1].length;
  const b = Buffer.alloc(need + 8);
  let p = 0;
  b.writeUInt32BE(0, p); p += 4;                    // version/flags 占位
  b[p] = 0xff; p += 1;                              // 0xf8 | lenSizeMinus1(3)<<1 | ptlPresent
  b.writeUInt16BE(packed, p); p += 2;               // olsIdx/子层数/恒定帧率/色度格式
  b[p] = 0x1f; p += 1;                              // bitDepthMinus8(0) << 5 | 保留 11111
  b[p] = 0x01; p += 1;                              // num_bytes_constraint_info
  b[p] = ((profile & 0x7f) << 1) | (tier & 0x01); p += 1;
  b[p] = level & 0xff; p += 1;
  b[p] = constraint & 0xff; p += 1;
  b[p] = arrays.length; p += 1;
  for (const a of arrays) {
    b[p] = 0x80 | (a[0] & 0x1f); p += 1;            // array_completeness=1
    b.writeUInt16BE(1, p); p += 2;                  // numNalus
    b.writeUInt16BE(a[1].length, p); p += 2;
    a[1].copy(b, p); p += a[1].length;
  }
  return b.subarray(0, p);
}

/**
 * 把减壳后的 ByteVC2 成品**就地**改写成标准 VVC 容器（bvc2 → vvc1）。
 *
 * 为什么值得做：实测这一集（1080p/30fps/4223 帧）的码流本身就是标准
 * H.266/VVC —— 抽出样本转 Annex B 后，ffmpeg 的 vvc 解码器 4223 帧全解、
 * 0 错误；换成标准 vvcC 后同一份 mp4 也能整片解开。上游只是把样本条目名
 * 写成私有的 bvc2、配置盒写成私有的 bv2C，标准解析器（ffmpeg / VLC 4 /
 * mpv）按标签找解码器，认不出就直接拒播。改完标签，这些播放器就能打开
 * 下载下来的文件，而码流一个字节都没动。
 *
 * 不改文件布局：新配置记录比私有盒短，余下空间补 0；盒子尺寸与文件长度
 * 都不变，因此 stco/co64 的 chunk 偏移无需平移，失败风险极小。
 *
 * @returns {boolean} true 表示已完成改写（或本来就不需要改写）
 */
function normalizeByteVc2(file) {
  let fd = null;
  try {
    const fileLen = fs.statSync(file).size;
    if (fileLen < 4096) return false;

    fd = fs.openSync(file, 'r+');
    // 先低成本探一下：没有私有配置盒就说明不是 BVC2（或已改写过）。
    // 这样常规的缓存命中只需读 1MB，不必把整个 moov 段载入内存。
    const probeLen = Math.min(fileLen, 1024 * 1024);
    const probe = Buffer.alloc(probeLen);
    readFullySync(fd, probe, 0, probeLen, 0);
    if (probe.indexOf('bv2C') < 0) return false;

    const headLen = Math.min(fileLen, 64 * 1024 * 1024);
    const head = Buffer.alloc(headLen);
    readFullySync(fd, head, 0, headLen, 0);
    const v = ByteView.whole(head);

    // 顶层盒链：只需要 moov（成品由 strip0 产出，moov 一定在 mdat 之前）
    const top = parseBoxes(v, 0, headLen);
    let moov = null;
    for (const b of top) if (b.type === 'moov') { moov = b; break; }
    if (moov === null) return false;

    // 找第一个样本条目是 bvc2 的视频轨
    let entry = null;
    let stblBox = null;
    for (const trak of moov.childrenOf('trak')) {
      const mdia = trak.child('mdia');
      const minf = mdia === null ? null : mdia.child('minf');
      const stbl = minf === null ? null : minf.child('stbl');
      if (stbl === null) continue;
      const stsd = stbl.child('stsd');
      if (stsd === null || stsd.children.length === 0) continue;
      if (stsd.children[0].type !== 'bvc2') continue;
      entry = stsd.children[0];
      stblBox = stbl;
      break;
    }
    if (entry === null) return false;

    // bvc2 不在 CONTAINERS 里，parseBoxes 不会往下走，手动从固定头之后解析
    const kids = parseBoxes(v, entry.start + entry.headerSize + VISUAL_FIXED, entry.end());
    let cfg = null;
    for (const c of kids) if (c.type === 'bv2C') { cfg = c; break; }
    if (cfg === null) return false;

    // 参数集取自第一个样本（IDR，前面必带 VPS/SPS/PPS）
    const track = new Track();
    readSampleTable(v, stblBox, track);
    if (track.sampleCount === 0) return false;
    const sOff = track.offsets[0];
    const sSize = track.sizes[0];
    if (!(sOff > 0) || !(sSize > 0) || sOff + sSize > fileLen) return false;
    const sample = Buffer.alloc(sSize);
    readFullySync(fd, sample, 0, sSize, sOff);

    const sets = paramSetsOf(sample);
    const record = buildVvcConfig(sets);
    if (record === null) return false;

    const room = cfg.size - cfg.headerSize;
    if (record.length > room) return false;

    // 就地改写：条目名、配置盒名、配置盒内容（补 0 到原长度）
    fs.writeSync(fd, Buffer.from('vvc1', 'latin1'), 0, 4, entry.start + 4);
    fs.writeSync(fd, Buffer.from('vvcC', 'latin1'), 0, 4, cfg.start + 4);
    const payload = Buffer.alloc(room);
    record.copy(payload);
    fs.writeSync(fd, payload, 0, room, cfg.payloadStart());
    return true;
  } catch (ignore) {
    // 任何意外都按「没改」处理：文件仍是可用的 BVC2 成品，只是标签没换
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (ignore) { /* 忽略 */ }
    }
  }
}

function strip0(inPath, outPath) {
  const fileLen = fs.statSync(inPath).size;
  if (fileLen < 16) return false;

  const fd = fs.openSync(inPath, 'r');
  try {
    // ---- 1. 只读盒头摸清顶层布局：ftyp / .. / moov / [free|skip]* / mdat ----
    const hdr = Buffer.alloc(16);
    let moovStart = -1, moovEnd = -1, mdatStart = -1, mdatHeaderSize = 8;
    let ftypFirst = false;
    let p = 0;

    while (p + 8 <= fileLen) {
      readFullySync(fd, hdr, 0, 8, p);
      let size = u32b(hdr, 0);
      const type = hdr.toString('latin1', 4, 8);
      let hs = 8;
      if (size === 1) {
        readFullySync(fd, hdr, 8, 8, p + 8);
        size = u64b(hdr, 8);
        hs = 16;
      } else if (size === 0) {
        size = fileLen - p;
      }
      if (size < hs || p + size > fileLen) return false;
      if (p === 0) {
        if (type !== 'ftyp') return false;
        ftypFirst = true;
      }
      if (type === 'moov') {
        if (moovStart >= 0) return false; // 双 moov：布局意外，放弃
        moovStart = p;
        moovEnd = p + size;
      } else if (type === 'mdat') {
        mdatStart = p;
        mdatHeaderSize = hs;
        break;
      }
      p += size;
    }
    if (!ftypFirst || moovStart < 0 || mdatStart < 0 || mdatStart < moovEnd) {
      return false; // 无 moov、moov 在 mdat 之后（尾部 moov 形态）等
    }
    // moov 与 mdat 之间只允许 free / skip（faststart 对齐盒）
    let q = moovEnd;
    while (q < mdatStart) {
      readFullySync(fd, hdr, 0, 8, q);
      let size = u32b(hdr, 0);
      const type = hdr.toString('latin1', 4, 8);
      let hs = 8;
      if (size === 1) {
        readFullySync(fd, hdr, 8, 8, q + 8);
        size = u64b(hdr, 8);
        hs = 16;
      } else if (size === 0) {
        return false; // 中段盒不允许延伸到文件尾
      }
      if (size < hs || q + size > mdatStart) return false;
      if (type !== 'free' && type !== 'skip') return false;
      q += size;
    }

    // ---- 2. 读入头部段（ftyp .. mdat 盒头，含盒头本身）在内存中修补 ----
    const headLen = mdatStart + mdatHeaderSize;
    if (headLen > 64 * 1024 * 1024) return false; // moov 异常巨大，放弃
    const head = Buffer.alloc(headLen);
    readFullySync(fd, head, 0, headLen, 0);

    // 解析终点取 mdatStart：head 里 mdat 只有盒头（负载不在段内），
    // 声明尺寸会越界，整段解析会在 mdat 处中断。
    const parseEnd = mdatStart;
    const top = parseBoxes(ByteView.whole(head), 0, parseEnd);
    let moov = null;
    for (const b of top) {
      if (b.type === 'moov') { moov = b; break; }
    }
    if (moov == null) return false;
    if (top[top.length - 1].end() !== parseEnd) return false; // 盒链不收尾

    // ---- 3. 剥离加密信令，沿途修补各层盒尺寸 ----
    const removals = [];
    const delta = pruneEncryption(head, moov, removals);
    if (delta <= 0) return false; // 没有加密信令可剥（布局不符），按不适用处理

    // ---- 4. chunk 偏移统一左移 delta（全部条目必须落在 moov 之后）----
    for (const trak of moov.children) {
      if (trak.type !== 'trak') continue;
      const mdia = trak.child('mdia');
      const minf = mdia == null ? null : mdia.child('minf');
      const stbl = minf == null ? null : minf.child('stbl');
      if (stbl == null) continue;
      patchChunkOffsets(head, stbl, 'stco', 4, delta, moovEnd);
      patchChunkOffsets(head, stbl, 'co64', 8, delta, moovEnd);
    }

    // ---- 5. 写出：head 跳过移除段 + mdat 负载从源文件流式拷贝 ----
    removals.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < removals.length; i++) {
      if (removals[i][0] < removals[i - 1][1]) return false; // 重叠即异常
    }
    const mdatPayload = mdatStart + mdatHeaderSize;
    const outFd = fs.openSync(outPath, 'w');
    try {
      let copied = 0;
      for (const r of removals) {
        fs.writeSync(outFd, head, copied, r[0] - copied);
        copied = r[1];
      }
      fs.writeSync(outFd, head, copied, headLen - copied);
      copyFdRange(fd, mdatPayload, outFd, fileLen - mdatPayload);
    } finally {
      fs.closeSync(outFd);
    }

    // ---- 6. 自校验：回读输出的头部段，验证真正交付的文件 ----
    // （不能校验内存里的 head：那是压缩前的布局，尺寸链不可能收尾）
    const outLen = fs.statSync(outPath).size;
    const outMdatStart = mdatStart - delta;
    if (outLen !== fileLen - delta) return false;
    const verifyLen = outMdatStart + 8;
    const vhead = Buffer.alloc(verifyLen);
    const vfd = fs.openSync(outPath, 'r');
    try {
      readFullySync(vfd, vhead, 0, verifyLen, 0);
    } finally {
      fs.closeSync(vfd);
    }
    const chk = parseBoxes(ByteView.whole(vhead), 0, outMdatStart);
    if (chk.length === 0) return false;
    if (chk[0].type !== 'ftyp') return false;
    if (chk[chk.length - 1].end() !== outMdatStart) return false;
    if (u32b(vhead, outMdatStart) !== outLen - outMdatStart) return false;
    let moov2 = null;
    for (const b of chk) {
      if (b.type === 'moov') { moov2 = b; break; }
    }
    if (moov2 == null) return false;
    for (const trak of moov2.children) {
      if (trak.type !== 'trak') continue;
      const mdia = trak.child('mdia');
      const minf = mdia == null ? null : mdia.child('minf');
      const stbl = minf == null ? null : minf.child('stbl');
      if (stbl == null) continue;
      for (const t of ['senc', 'saio', 'saiz']) {
        if (stbl.child(t) != null) return false;
      }
      const stsd = stbl.child('stsd');
      if (stsd != null) {
        for (const e of stsd.children) {
          // 条目类型必须已改回普通类型（encv/enca 是加密专用）
          if (!isPlainEntryType(e.type)) return false;
          const fh = entryFixedHeader(e.type);
          if (fh < 0) return false;
          const kids = parseBoxes(ByteView.whole(vhead), e.start + 8 + fh, e.end());
          for (const c of kids) {
            if (c.type === 'sinf') return false;
          }
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/**
 * 递归剥离加密信令，返回从 box 子树中移除的字节总数；
 * 沿途就地修补各层盒的 32 位尺寸字段（head 下标即文件绝对偏移）。
 *
 * 只删三类盒：stbl 直属的 senc/saio/saiz、stsd 条目内的 sinf、
 * moov 直属的 pssh。遇到 64 位尺寸盒或未知样本条目类型即抛错
 * （上层捕获后放弃剥离）——修补逻辑只覆盖 32 位尺寸这一种形态。
 */
function pruneEncryption(head, box, removals) {
  let removed = 0;
  if (box.type === 'stbl') {
    for (const c of box.children.slice()) {
      if (c.type === 'senc' || c.type === 'saio' || c.type === 'saiz') {
        removals.push([c.start, c.end()]);
        removed += c.size;
        box.children.splice(box.children.indexOf(c), 1);
      }
    }
  } else if (box.type === 'moov') {
    for (const c of box.children.slice()) {
      if (c.type === 'pssh') {
        removals.push([c.start, c.end()]);
        removed += c.size;
        box.children.splice(box.children.indexOf(c), 1);
      }
    }
  } else if (box.type === 'stsd') {
    // stsd 的子盒是样本条目（parseBoxes 按叶子处理），
    // 需按条目类型跳固定头后才能看到 sinf。
    for (const entry of box.children) {
      const fh = entryFixedHeader(entry.type);
      if (fh < 0) {
        throw new Error('未知样本条目类型: ' + entry.type);
      }
      const kids = parseBoxes(ByteView.whole(head), entry.start + 8 + fh, entry.end());
      let er = 0;
      for (const c of kids) {
        if (c.type === 'sinf') {
          removals.push([c.start, c.end()]);
          er += c.size;
          // 删信令的同时把条目类型从 encv/enca 改回原始类型
          // （frma 权威记录，解码配置子盒兜底推断）——
          // 否则条目仍是 CENC 加密类型，播放器不认
          rewriteEntryType(head, entry, c);
        } else {
          er += pruneEncryption(head, c, removals);
        }
      }
      if (er > 0) {
        patchBoxSize(head, entry, entry.size - er);
        removed += er;
      }
    }
    // stsd 自身也随条目一起缩小（调用方只按返回值修上层盒，
    // 不会穿透到 stsd——漏了这步盒链会在 stsd 处断裂）
    if (removed > 0) patchBoxSize(head, box, box.size - removed);
    return removed;
  }
  for (const c of box.children) {
    removed += pruneEncryption(head, c, removals);
  }
  if (removed > 0) patchBoxSize(head, box, box.size - removed);
  return removed;
}

/**
 * 把样本条目的类型从加密类型（encv/enca）改写回原始类型。
 * 权威来源是 sinf 内 frma 盒的 data_format（加密前的条目类型）；
 * frma 缺失或不可识别时按条目内的解码配置子盒推断
 * （hvcC→hvc1、avcC→avc1、av1C→av01、esds→mp4a）；
 * 都判不出则抛错放弃剥离——类型写错比不剥更糟。
 */
function rewriteEntryType(head, entry, sinf) {
  const nt = plainEntryType(head, entry, sinf);
  if (nt == null) {
    throw new Error('无法确定样本条目原始类型，放弃剥离: ' + entry.type);
  }
  head.write(nt, entry.start + 4, 4, 'latin1');
}

/** 推断样本条目的原始（非加密）类型；判不出返回 null。 */
function plainEntryType(head, entry, sinf) {
  // 1. sinf 内 frma 的 data_format：加密前的原始条目类型（权威）
  const inner = parseBoxes(ByteView.whole(head), sinf.start + 8, sinf.end());
  for (const b of inner) {
    if (b.type === 'frma' && b.size >= 12 && b.headerSize === 8) {
      const f = head.toString('latin1', b.start + 8, b.start + 12);
      if (isPlainEntryType(f)) return f;
    }
  }
  // 2. 按解码配置子盒推断
  const kids = parseBoxes(ByteView.whole(head), entry.start + 8 + entryFixedHeader(entry.type), entry.end());
  for (const b of kids) {
    if (b.type === 'hvcC') return 'hvc1';
    if (b.type === 'avcC') return 'avc1';
    if (b.type === 'av1C') return 'av01';
    if (b.type === 'esds') return 'mp4a';
  }
  return null;
}

/** 是否为普通（非加密）样本条目类型。 */
function isPlainEntryType(t) {
  return t !== 'encv' && t !== 'enca'
      && (VISUAL_ENTRY.has(t) || AUDIO_ENTRY.has(t));
}

/** 就地修补盒的 32 位尺寸字段；64 位盒直接抛错（放弃剥离）。 */
function patchBoxSize(head, box, newSize) {
  if (box.headerSize !== 8) {
    throw new Error('64 位盒尺寸，放弃剥离: ' + box.type);
  }
  if (newSize < 8 || newSize > 0xFFFFFFFF) {
    throw new Error('盒尺寸越界，放弃剥离: ' + box.type);
  }
  putU32(head, box.start, newSize);
}

/**
 * 把 stco/co64 的全部 chunk 偏移左移 delta。
 * 任一条目落在 moovEnd 之前（不该发生）即抛错——布局不符时整体放弃剥离。
 */
function patchChunkOffsets(head, stbl, type, width, delta, moovEnd) {
  const b = stbl.child(type);
  if (b == null) return;
  if (b.headerSize !== 8) {
    throw new Error('64 位偏移盒，放弃剥离: ' + type);
  }
  let p = b.start + 12; // 跳过盒头(8) + version/flags(4)
  const n = u32b(head, p);
  p += 4; // entry_count
  if (n < 0 || p + n * width > b.end()) {
    throw new Error('偏移表长度异常，放弃剥离: ' + type);
  }
  for (let i = 0; i < n; i++) {
    const v = width === 4 ? u32b(head, p) : u64b(head, p);
    if (v < moovEnd) {
      throw new Error('chunk 偏移落在 moov 之前，放弃剥离');
    }
    if (width === 4) putU32(head, p, v - delta);
    else putU64(head, p, v - delta);
    p += width;
  }
}

// ==================== 基础读写工具 ====================

/** 从 srcFd 的 srcOff 处拷贝长度 length 到 dstFd 当前位置（源不足则抛错）。 */
function copyFdRange(srcFd, srcOff, dstFd, length) {
  const buf = Buffer.alloc(65536);
  let left = length;
  let pos = srcOff;
  while (left > 0) {
    const want = Math.min(buf.length, left);
    const n = fs.readSync(srcFd, buf, 0, want, pos);
    if (n <= 0) throw new Error('源文件在读流中提前结束');
    let written = 0;
    while (written < n) {
      written += fs.writeSync(dstFd, buf, written, n - written);
    }
    left -= n;
    pos += n;
  }
}

/** Buffer 内置大端读法。 */
function u32b(b, p) {
  return b.readUInt32BE(p);
}

function u64b(b, p) {
  return Number(b.readBigUInt64BE(p));
}

/** Buffer 内置大端写法。 */
function putU32(b, p, v) {
  b.writeUInt32BE(v >>> 0, p);
}

function putU64(b, p, v) {
  b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(v)), p);
}

module.exports = {
  ByteView, ByteArrayStore, RafStore, FileHeadReader,
  Box, Track, Analysis, MoovSpan, DecryptResult,
  parseBoxes, findBox,
  analyzeEncryptedTracks, findMoov,
  ivToCounter, ctrCounter, counterFor,
  decryptTrack, trackBaseIvCandidates, avccSelfOk, pickProbeIndices, verifyVideoIv,
  stripEncryption,
  normalizeByteVc2,
};
