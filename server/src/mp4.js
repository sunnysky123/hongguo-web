'use strict';
/**
 * 纯文件 / 纯算法 MP4 CENC 解密
 *
 * 移植并重写自原 Python 模块 frida/decutil.py + oracle.py 的样本表解析部分。
 * 与原实现的关键差异：不使用正则扫描字节流（原文对 "senc"/"moov" 做正则匹配），
 * 而是完整解析 ISO BMFF 盒结构，因此对多 trak、大小端、64 位偏移都更稳健。
 *
 * 解密方案：CENC 的 AES-128-CTR，计数器为 128 位大端，
 *   counter = (base_iv_high64 + sampleIndex) << 64，即低 64 位恒为 0。
 */

const crypto = require('crypto');

/** 需要在 trak 内递归查找的容器盒。 */
const CONTAINERS = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'mvex', 'moof', 'traf',
]);

/** sample description box（stsd）本身是全量盒，但其条目是普通盒。 */
class Box {
  constructor(type, start, headerSize, size) {
    this.type = type;
    this.start = start;          // 盒起始绝对偏移
    this.headerSize = headerSize; // 盒头长度
    this.size = size;            // 盒总长度（含头）
    this.children = [];
  }
  get end() { return this.start + this.size; }
  get payloadStart() { return this.start + this.headerSize; }
  get payloadEnd() { return this.end; }
  child(type) { return this.children.find((c) => c.type === type) || null; }
  childrenOf(type) { return this.children.filter((c) => c.type === type); }
}

/**
 * 解析 buf 中 offset 起的盒树。
 * @param {Buffer} buf
 * @param {number} offset 起始偏移
 * @param {number} end 结束偏移（不含）
 * @returns {Box[]}
 */
function parseBoxes(buf, offset, end) {
  const boxes = [];
  let p = offset;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let headerSize = 8;

    if (size === 1) {
      if (p + 16 > end) break;
      // 64 位长度使用 BigInt 以支持 >4GB 文件
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - p; // 延伸到文件末尾
    }

    if (size < headerSize || p + size > end) break;
    const box = new Box(type, p, headerSize, size);
    if (CONTAINERS.has(type)) {
      box.children = parseBoxes(buf, box.payloadStart, box.payloadEnd);
    } else if (type === 'stsd') {
      // stsd: version/flags(4) + entry_count(4)，之后是 sample entry
      box.children = parseBoxes(buf, box.payloadStart + 8, box.payloadEnd);
    }
    boxes.push(box);
    p += size;
  }
  return boxes;
}

/** 递归收集指定类型的全部盒。 */
function collect(box, type, acc = []) {
  for (const c of box.children || []) {
    if (c.type === type) acc.push(c);
    collect(c, type, acc);
  }
  return acc;
}

/** 递归查找第一个指定类型的盒。 */
function findBox(box, type) {
  for (const c of box.children || []) {
    if (c.type === type) return c;
    const hit = findBox(c, type);
    if (hit) return hit;
  }
  return null;
}

/** 解析 mvhd，取 timescale。 */
function readTimescale(buf, moov) {
  const mvhd = moov.child('mvhd');
  if (!mvhd) return 90000;
  const p = mvhd.payloadStart;
  const version = buf[p];
  if (version === 1) return buf.readUInt32BE(p + 20);
  return buf.readUInt32BE(p + 12);
}

/** 解析 trak 的 tkhd，取 track_ID 与宽高。 */
function readTrackHeader(buf, trak) {
  const tkhd = trak.child('tkhd');
  const out = { trackId: 0, width: 0, height: 0, duration: 0 };
  if (!tkhd) return out;
  const p = tkhd.payloadStart;
  const version = buf[p];
  if (version === 1) {
    out.trackId = buf.readUInt32BE(p + 20);
    out.duration = Number(buf.readBigUInt64BE(p + 28));
    out.width = buf.readUInt32BE(p + 88) / 65536;
    out.height = buf.readUInt32BE(p + 92) / 65536;
  } else {
    out.trackId = buf.readUInt32BE(p + 12);
    out.duration = buf.readUInt32BE(p + 20);
    out.width = buf.readUInt32BE(p + 76) / 65536;
    out.height = buf.readUInt32BE(p + 80) / 65536;
  }
  return out;
}

/** 解析 mdia/hdlr，取处理类型（vide / soun）。 */
function readHandler(buf, trak) {
  const mdia = trak.child('mdia');
  const hdlr = mdia && mdia.child('hdlr');
  if (!hdlr) return null;
  return buf.toString('latin1', hdlr.payloadStart + 8, hdlr.payloadStart + 12);
}

/**
 * 解析 stbl 的样本表，得到每个样本在文件中的绝对偏移与长度。
 * @returns {{sizes:number[], offsets:number[], total:number}}
 */
function readSampleTable(buf, stbl) {
  const sizes = [];
  const offsets = [];

  // stsz：样本大小（size==0 时逐样本读取）
  const stsz = stbl.child('stsz');
  if (stsz) {
    const p = stsz.payloadStart + 4; // 跳过 version/flags
    const uniform = buf.readUInt32BE(p);
    const count = buf.readUInt32BE(p + 4);
    if (uniform > 0) {
      for (let i = 0; i < count; i++) sizes.push(uniform);
    } else {
      for (let i = 0; i < count; i++) sizes.push(buf.readUInt32BE(p + 8 + i * 4));
    }
  }

  // stsc：样本到 chunk 的映射
  const stscEntries = [];
  const stsc = stbl.child('stsc');
  if (stsc) {
    const p = stsc.payloadStart + 4;
    const n = buf.readUInt32BE(p);
    for (let i = 0; i < n; i++) {
      const q = p + 4 + i * 12;
      stscEntries.push({
        firstChunk: buf.readUInt32BE(q),
        samplesPerChunk: buf.readUInt32BE(q + 4),
        descIndex: buf.readUInt32BE(q + 8),
      });
    }
  }

  // stco / co64：chunk 偏移
  const chunkOffsets = [];
  const stco = stbl.child('stco');
  if (stco) {
    const p = stco.payloadStart + 4;
    const n = buf.readUInt32BE(p);
    for (let i = 0; i < n; i++) chunkOffsets.push(buf.readUInt32BE(p + 4 + i * 4));
  } else {
    const co64 = stbl.child('co64');
    if (co64) {
      const p = co64.payloadStart + 4;
      const n = buf.readUInt32BE(p);
      for (let i = 0; i < n; i++) {
        chunkOffsets.push(Number(buf.readBigUInt64BE(p + 4 + i * 8)));
      }
    }
  }

  // 依据 stsc 把 chunk 展开为样本偏移
  for (let e = 0; e < stscEntries.length; e++) {
    const cur = stscEntries[e];
    const next = stscEntries[e + 1];
    const lastChunk = next ? next.firstChunk - 1 : chunkOffsets.length;
    for (let ch = cur.firstChunk; ch <= lastChunk; ch++) {
      const base = chunkOffsets[ch - 1];
      if (base === undefined) break;
      let off = base;
      for (let s = 0; s < cur.samplesPerChunk; s++) {
        const idx = offsets.length;
        if (idx >= sizes.length) break;
        offsets.push(off);
        off += sizes[idx];
      }
    }
  }

  return { sizes, offsets, total: sizes.length };
}

/**
 * 解析 senc 盒，取每个样本的 IV。
 *
 * CENC 的 senc 为 FullBox：version/flags(4) + sample_count(4)，
 * 随后是 per_sample_IV[IV_size] (+ 可选 subsample 信息)。
 *
 * 重要：IV 长度并非总是 16 字节。本项目实测两种都存在：
 *   - 16 字节：标准 CENC，per-sample IV 为完整 128 位；
 *   - 8 字节：PIFF/简化形态，盒长度恰好等于 8 + count*IV_size，
 *     且 tenc.default_IV_size 也声明为 8。
 * 因此这里不写死 16，而是用「盒剩余长度 / 样本数」反推实际 IV 长度，
 * 并以 tenc 声明作为交叉校验，避免读到一半错位。
 *
 * @returns {string[]} 每个样本的 IV（hex），元素为 8 或 16 字节的 hex
 */
function readSencIVs(buf, senc, tencIvSize) {
  const p = senc.payloadStart;
  const flags = buf.readUIntBE(p + 1, 3);
  const count = buf.readUInt32BE(p + 4);
  const hasSubsample = (flags & 0x02) !== 0;

  // 反推 IV 长度：剩余字节里先扣掉 subsample 开销
  let payload = senc.end - (p + 8);
  if (hasSubsample) payload = estimateWithoutSubsample(buf, p + 8, senc.end, count);
  let ivSize = count > 0 ? Math.floor(payload / count) : 16;
  if (ivSize !== 8 && ivSize !== 16) {
    ivSize = tencIvSize === 8 ? 8 : 16;
  }
  // tenc 声明优先（它是权威来源）
  if (tencIvSize === 8 || tencIvSize === 16) ivSize = tencIvSize;

  const ivs = [];
  let q = p + 8;
  for (let i = 0; i < count; i++) {
    if (q + ivSize > senc.end) break;
    ivs.push(buf.toString('hex', q, q + ivSize));
    q += ivSize;
    if (hasSubsample) {
      if (q + 2 > senc.end) break;
      const subsampleCount = buf.readUInt16BE(q);
      q += 2 + subsampleCount * 6;
    }
  }
  return ivs;
}

/**
 * 存在 subsample 信息时，无法直接用长度反推 IV 大小；
 * 改为假定 16 字节走一遍，若最终偏移不吻合再退回 8 字节。
 * 返回该假定下的"每样本非 IV 字节数"估计。
 */
function estimateWithoutSubsample(buf, start, end, count) {
  // 先按 16 字节 IV + subsample 走，统计实际消耗
  let q = start;
  let n = 0;
  while (q + 18 <= end && n < count) {
    const subsampleCount = buf.readUInt16BE(q + 16);
    q += 16 + 2 + subsampleCount * 6;
    n++;
  }
  if (q > end) {
    // 溢出说明不是 16 字节 IV
    return (end - start);
  }
  const used = q - start;
  return used;
}

/** 读取 tenc 盒的 default_KID、default_IV_size 与 constant IV（若有），用于核对。 */
function readTenc(buf, trak) {
  const sinf = findBox(trak, 'sinf');
  const schm = sinf && sinf.child('schm');
  if (schm) {
    const p = schm.payloadStart + 4;
    const scheme = buf.toString('latin1', p, p + 4);
    if (scheme !== 'cenc') return null; // 仅处理 CENC
  }
  const tenc = sinf && sinf.child('tenc');
  if (!tenc) return null;
  const p = tenc.payloadStart;
  const version = buf[p];
  const flags = buf.readUIntBE(p + 1, 3);
  let ivSize = 0;
  let q;
  if (version === 0) {
    ivSize = buf[p + 4];
    q = p + 5;
  } else {
    // version 1: reserved(1) + pattern(4+4) + default_IV_size(1)
    ivSize = buf[p + 9];
    q = p + 10;
  }
  const kid = buf.toString('hex', q, q + 16);
  let constantIv = null;
  if (flags & 0x01) {
    constantIv = buf.toString('hex', q + 16, q + 16 + ivSize);
  }
  return { kid, constantIv, ivSize, isProtected: (flags & 0x02) !== 0 };
}

/**
 * 收集密文 mp4 中所有加密轨（视频 + 音频）及其样本表与 IV。
 * @param {Buffer} buf 整个 mp4
 * @returns {{tracks:Array, timescale:number}}
 */
function analyzeEncryptedTracks(buf) {
  const top = parseBoxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) throw new Error('不是有效的 MP4：缺少 moov 盒');
  const timescale = readTimescale(buf, moov);

  const tracks = [];
  for (const trak of moov.childrenOf('trak')) {
    const stbl = (trak.child('mdia') || { child: () => null }).child('minf');
    const stblBox = stbl && stbl.child('stbl');
    if (!stblBox) continue;

    const handler = readHandler(buf, trak);
    const header = readTrackHeader(buf, trak);
    const table = readSampleTable(buf, stblBox);
    if (!table.total) continue;

    // senc 可能在 stbl 内（明文 CENC），或经 saiz/saio 指向
    const senc = stblBox.child('senc') || findBox(trak, 'senc');
    const tenc = readTenc(buf, trak);
    // tenc 的 default_IV_size 是 IV 长度的权威来源
    const ivs = senc ? readSencIVs(buf, senc, tenc ? tenc.ivSize : 0) : null;

    tracks.push({
      trackId: header.trackId,
      handler, // 'vide' | 'soun' | ...
      width: Math.round(header.width),
      height: Math.round(header.height),
      sampleCount: table.total,
      sizes: table.sizes,
      offsets: table.offsets,
      ivs,
      ivSize: tenc ? tenc.ivSize : 16,
      kid: tenc ? tenc.kid : null,
      constantIv: tenc ? tenc.constantIv : null,
    });
  }
  return { tracks, timescale };
}

/**
 * 取该轨的 base_iv 候选（16 位 hex = 计数器高 64 位）。
 *
 * 本项目实测样本 IV 为 8 字节（PIFF 形态），其值直接就是 CENC 计数器的高 64 位，
 * 低 64 位恒为 0 —— 与原 Python 实现"取 senc 首样本 IV 的高 8 字节"一致。
 * 若为标准 16 字节 IV，则取其高 8 字节。
 */
function trackBaseIvCandidates(buf, track) {
  const out = [];
  const push = (hex) => {
    if (!hex) return;
    // 统一截取高 8 字节（16 位 hex）
    const hi = hex.length >= 16 ? hex.slice(0, 16) : hex;
    if (hi.length === 16 && !out.includes(hi)) out.push(hi);
  };
  push(track.constantIv);
  if (track.ivs && track.ivs.length) {
    for (const iv of track.ivs) {
      push(iv);
      if (out.length >= 4) break; // 前若干个样本足以覆盖多 iv 场景
    }
  }
  return out;
}

/** 兼容旧接口：返回密文文件中所有 senc 盒首样本 IV 的高 8 字节（十六进制）。 */
function sencIv8(buf) {
  const top = parseBoxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return [];
  const out = [];
  for (const trak of moov.childrenOf('trak')) {
    const senc = findBox(trak, 'senc');
    if (!senc) continue;
    const tenc = readTenc(buf, trak);
    const ivs = readSencIVs(buf, senc, tenc ? tenc.ivSize : 0);
    if (ivs.length) {
      const hi = ivs[0].length >= 16 ? ivs[0].slice(0, 16) : ivs[0];
      if (hi.length === 16 && !out.includes(hi)) out.push(hi);
    }
  }
  return out;
}

/** 兼容旧接口：返回 tenc default_KID。 */
function tencKid(buf) {
  const top = parseBoxes(buf, 0, buf.length);
  const moov = top.find((b) => b.type === 'moov');
  if (!moov) return null;
  for (const trak of moov.childrenOf('trak')) {
    const t = readTenc(buf, trak);
    if (t && t.kid) return t.kid;
  }
  return null;
}

/** 构造 AES-128-CTR 的初始计数器：counter = (baseIvHi64 + index) << 64。 */
function ctrCounter(baseIvHex, index) {
  const hi = BigInt('0x' + baseIvHex);
  const counter = ((hi + BigInt(index)) << 64n) & ((1n << 128n) - 1n);
  const hex = counter.toString(16).padStart(32, '0');
  return Buffer.from(hex, 'hex');
}

/**
 * 就地解密单轨的全部样本（AES-128-CTR）。
 * @param {Buffer} buf 整个文件（会被修改）
 * @param {object} track analyzeEncryptedTracks 得到的轨
 * @param {string} keyHex content key（32 位十六进制）
 * @param {string} baseIvHex 该轨 base_iv 高 8 字节
 * @returns {{decrypted:number, total:number}}
 */
function decryptTrack(buf, track, keyHex, baseIvHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) throw new Error('content key 长度非法');
  let done = 0;
  for (let i = 0; i < track.sampleCount; i++) {
    const off = track.offsets[i];
    const size = track.sizes[i];
    if (off === undefined || size === undefined || size <= 0) continue;
    if (off + size > buf.length) continue;
    const counter = ctrCounter(baseIvHex, i);
    const cipher = crypto.createCipheriv('aes-128-ctr', key, counter);
    const plain = Buffer.concat([cipher.update(buf.subarray(off, off + size)), cipher.final()]);
    plain.copy(buf, off);
    done++;
  }
  return { decrypted: done, total: track.sampleCount };
}


/**
 * 逐样本 IV（senc/PIFF 常为 8 字节）直接作为 CTR 计数器的高 64 位，低 64 位补 0。
 *
 * 本项目实测：senc 里的 IV 是「逐样本递增」的 8 字节序列
 * （ebbde5029bbf3f29, ebbde5029bbf3f2a, ...），即 iv[i] = base_iv + i。
 * 因此「取 iv[i] 当高 64 位」与「base_iv 加 i 后左移」完全等价，
 * 但前者能天然兼容 16 字节 IV 的标准 CENC，无需再猜 base_iv。
 *
 * @param {string} ivHex 8 或 16 字节 IV（十六进制）
 * @returns {Buffer} 16 字节 CTR 初始计数器
 */
function ivToCounter(ivHex) {
  const h = String(ivHex || '').trim();
  // 16 字节标准 IV：本身就是 128 位计数器
  if (h.length >= 32) return Buffer.from(h.slice(0, 32).padEnd(32, '0'), 'hex');
  // 8 字节 IV（PIFF 形态）：位于高 64 位，低 64 位补 0 —— 即右侧补零
  return Buffer.from(h.padEnd(32, '0'), 'hex');
}

/**
 * 取第 i 个样本的 CTR 计数器：优先用逐样本 IV，缺失时回退 base_iv + i。
 * @param {object} track analyzeEncryptedTracks 得到的轨
 * @param {string|null} baseIvHex 回退用的 base_iv 高 8 字节
 * @param {number} i 样本序号
 */
function counterFor(track, baseIvHex, i) {
  if (track.ivs && track.ivs[i]) return ivToCounter(track.ivs[i]);
  return ctrCounter(baseIvHex, i);
}

/**
 * 就地解密单轨的全部样本（AES-128-CTR）。
 * @param {Buffer} buf 整个文件（会被修改）
 * @param {object} track analyzeEncryptedTracks 得到的轨
 * @param {string} keyHex content key（32 位十六进制）
 * @param {string} baseIvHex 该轨 base_iv 高 8 字节（仅在无逐样本 IV 时使用）
 * @returns {{decrypted:number, total:number}}
 */
function decryptTrack(buf, track, keyHex, baseIvHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) throw new Error('content key 长度非法');
  const hasIvs = !!(track.ivs && track.ivs.length);
  if (!hasIvs && !baseIvHex) throw new Error('该轨既无逐样本 IV 也无 base_iv，无法解密');
  let done = 0;
  for (let i = 0; i < track.sampleCount; i++) {
    const off = track.offsets[i];
    const size = track.sizes[i];
    if (off === undefined || size === undefined || size <= 0) continue;
    if (off + size > buf.length) continue;
    const counter = counterFor(track, baseIvHex, i);
    const cipher = crypto.createCipheriv('aes-128-ctr', key, counter);
    const plain = Buffer.concat([cipher.update(buf.subarray(off, off + size)), cipher.final()]);
    plain.copy(buf, off);
    done++;
  }
  return { decrypted: done, total: track.sampleCount };
}

/**
 * 挑选探测样本：首个 + 中段若干 + 末尾，跳过 size 过小的样本。
 * 样本数多时只取固定几个，避免为校验而解密整轨。
 */
function pickProbeIndices(track) {
  const n = track.sampleCount;
  if (!n) return [];
  const cand = new Set([0, 1, 2, n >> 2, n >> 1, n - 1]);
  const out = [];
  for (const i of cand) {
    if (i < 0 || i >= n) continue;
    if (track.sizes[i] >= 8) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

/**
 * AVCC 自证：4 字节大端长度前缀链必须自洽地走完整个样本，且每个 NAL 类型合法。
 * 也接受 Annex-B 起始码（00 00 00 01 / 00 00 01）。
 *
 * 关键点：一个视频样本通常含多个 NAL（SPS/PPS/SEI/IDR），
 * 所以必须遍历整条长度链，只看首个 NAL 会误判。
 *
 * @param {Buffer} plain 完整明文样本
 * @param {number} size 样本字节数
 * @returns {boolean}
 */
function avccSelfOk(plain, size) {
  const n = Math.min(plain.length, size || plain.length);
  if (n < 5) return false;
  // Annex-B 起始码
  if (plain[0] === 0 && plain[1] === 0 && (plain[2] === 1 || (plain[2] === 0 && plain[3] === 1))) return true;
  let off = 0;
  let nals = 0;
  while (off + 5 <= n) {
    const len = plain.readUInt32BE(off);
    if (len <= 0 || off + 4 + len > n) return false;   // 长度非法或越界
    // NAL 头：1 bit forbidden_zero + 2 bit nal_ref_idc + 5 bit nal_unit_type
    // forbidden_zero_bit 必须为 0（明文 MP4 不会置位），据此排除「长度字段错位」
    if (plain[off + 4] & 0x80) return false;
    off += 4 + len;
    if (++nals > 64) return false;                      // 防御：避免畸形长度导致长循环
  }
  // 必须走完（允许末尾少量 0 填充）
  return nals > 0 && (off === n || n - off <= 3);
}

/**
 * 用候选 base_iv 试解一个视频轨，返回能通过 AVCC 自证的 base_iv；失败返回 null。
 *
 * 逐样本 IV 齐全时，base_iv 只是等价回退值，优先直接用 iv[0] 验证。
 */
function verifyVideoIv(buf, track, keyHex, candidates) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 16) return null;

  const hasIvs = !!(track.ivs && track.ivs.length >= track.sampleCount);
  const list = hasIvs ? [track.ivs[0]] : (candidates || []);
  for (const cand of list) {
    let ok = 0;
    let tested = 0;
    for (const i of pickProbeIndices(track)) {
      const off = track.offsets[i];
      const size = track.sizes[i];
      if (!size || off + size > buf.length) continue;
      tested++;
      const counter = counterFor(track, cand, i);
      const decipher = crypto.createDecipheriv('aes-128-ctr', key, counter);
      const plain = Buffer.concat([decipher.update(buf.subarray(off, off + size)), decipher.final()]);
      if (avccSelfOk(plain, size)) ok++;
    }
    // 全部探测样本都自洽才算通过：避免 60% 阈值被噪声蒙混
    if (tested && ok === tested) return cand;
  }
  return null;
}

/** 兼容旧接口：NAL 自证（对完整样本做 AVCC 链校验）。 */
function nalOk(head, size) {
  return avccSelfOk(head, size || head.length);
}

module.exports = {
  parseBoxes, collect, findBox,
  analyzeEncryptedTracks, trackBaseIvCandidates,
  sencIv8, tencKid,
  decryptTrack, verifyVideoIv, ctrCounter, nalOk,
  ivToCounter, counterFor, avccSelfOk, pickProbeIndices,
};
