'use strict';
/**
 * 自检用 MP4 夹具：构造一个最小但结构完整的 CENC 加密 mp4。
 *
 * 目的：让 --selftest 能在无网络、无外部样本的情况下验证
 * Mp4.analyzeEncryptedTracks 的盒解析、样本表展开与 IV 提取是否正确。
 *
 * 结构：
 *   ftyp
 *   moov
 *     mvhd
 *     trak
 *       tkhd
 *       mdia
 *         hdlr (vide)
 *         minf
 *           stbl
 *             stsd (avc1 / encv 占位)
 *             stts / stsc / stsz / stco
 *             senc  (2 个样本，各 16 字节 IV)
 *             sinf
 *               schm (cenc)
 *               schi
 *                 tenc (default_KID 16B)
 *   mdat（真实密文：由固定 content key 加密合法 AVCC 明文而来）
 *
 * 自检价值：解密后能拿明文比对，且明文是合法 AVCC 长度前缀链，
 * 可通过 Mp4.avccSelfOk 自证 —— 这正是真实链路的判定方式。
 */

const Crypto = require('./util/crypto');

/** 每个样本的逐样本 IV（16 字节标准 CENC 形态）。 */
const IVS = [
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
               0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
               0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
];

const KID = Buffer.from([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
  0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00,
]);

/**
 * 夹具用的 content key（固定值，便于自检做「解密还原」断言）。
 * 与真实链路无关，仅供自检闭环。
 */
const CONTENT_KEY = Buffer.from([
  0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0xF6, 0x07, 0x18,
  0x29, 0x3A, 0x4B, 0x5C, 0x6D, 0x7E, 0x8F, 0x90,
]);

/** 构造样本数据：2 个样本。 */
const SAMPLE_COUNT = 2;

/** 构造明文样本：合法 AVCC 长度前缀链，解密后应通过 avccSelfOk 自证。 */
function buildPlainSamples() {
  const plains = new Array(SAMPLE_COUNT);
  // 样本 0：SPS + IDR 两个 NAL
  plains[0] = Buffer.from([0, 0, 0, 2, 0x67, 0x42,
                           0, 0, 0, 3, 0x65, 0x88, 0x84]); // NAL type 5 (IDR)
  // 样本 1：PPS + SEI + 尾部分片
  plains[1] = Buffer.from([0, 0, 0, 2, 0x68, 0xCE,
                           0, 0, 0, 2, 0x06, 0x05,
                           0, 0, 0, 1, 0x41]);
  return plains;
}

/** 用 content key + 逐样本 IV 加密明文样本，得到 mdat 负载。 */
function buildCipherPayload() {
  const plains = buildPlainSamples();
  const parts = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    parts.push(Crypto.aes128Ctr(CONTENT_KEY, IVS[i], plains[i]));
  }
  return Buffer.concat(parts);
}

/** 自检用的 content key（hex）。 */
function fixtureKeyHex() {
  return Crypto.hex(CONTENT_KEY);
}

/** 自检用的明文样本，供解密还原比对。 */
function plainSamples() {
  return buildPlainSamples();
}

/**
 * 构造 moov 位于**文件末尾**的加密 mp4（非 faststart 形态）。
 *
 * 为什么需要：真实短剧源流并非都是 faststart，moov 常在尾部。
 * 流式解密方案必须能在不读全文的前提下定位尾部 moov
 * （Mp4.findMoov 只读盒头并按 p += size 跳跃），
 * 而早期夹具只有 moov 在头部的形态，无法覆盖该分支。
 *
 * 结构：ftyp / mdat（密文）/ moov（索引，含回填的 stco 绝对偏移）
 */
function buildTailMoovEncryptedMp4() {
  const plain = buildMinimalEncryptedMp4();
  // 从头部形态里取出 moov 段（找到 'moov' 后回退 4 字节即为盒头）
  const moovPos = indexOf(plain, Buffer.from('moov', 'latin1'));
  if (moovPos < 4) throw new Error('夹具异常：未找到 moov');
  const moovStart = moovPos - 4;
  const moovSize = u32At(plain, moovStart);
  const moov = Buffer.from(plain.subarray(moovStart, moovStart + moovSize));
  const ftyp = plain.subarray(0, moovStart);
  // mdat：从头部形态里切出来（含盒头）
  const mdat = sliceMdat(plain);

  // 组装：ftyp + mdat + moov，并在 moov 内部回填 chunk 偏移
  const mdatPayloadStart = ftyp.length + 8;
  const moovFixed = patchStco(moov, mdatPayloadStart);
  return Buffer.concat([ftyp, mdat, moovFixed]);
}

/** 取出头部形态夹具里的 mdat 盒。 */
function sliceMdat(all) {
  const p = indexOf(all, Buffer.from('mdat', 'latin1'));
  if (p < 4) throw new Error('夹具异常：未找到 mdat');
  const start = p - 4;
  const size = u32At(all, start);
  return all.subarray(start, start + size);
}

/** 把 moov 内 stco 的 chunk 偏移改为 chunkOffset，保持 stco 盒长度不变。 */
function patchStco(moov, chunkOffset) {
  const p = indexOf(moov, Buffer.from('stco', 'latin1'));
  if (p < 0) throw new Error('夹具异常：moov 内未找到 stco');
  const boxStart = p - 4;
  const boxSize = u32At(moov, boxStart);
  const out = Buffer.from(moov);
  // payload: version/flags(4) + entry_count(4) + 偏移(4)
  const offPos = boxStart + 8 + 8;
  out[offPos] = (chunkOffset >>> 24) & 0xFF;
  out[offPos + 1] = (chunkOffset >>> 16) & 0xFF;
  out[offPos + 2] = (chunkOffset >>> 8) & 0xFF;
  out[offPos + 3] = chunkOffset & 0xFF;
  // 确认盒长度未变（原地补丁的前提）
  if (u32At(out, boxStart) !== boxSize) {
    throw new Error('夹具异常：stco 长度变化');
  }
  return out;
}

function u32At(b, p) {
  return (b[p] & 0xFF) * 0x1000000 + (b[p + 1] & 0xFF) * 0x10000
       + (b[p + 2] & 0xFF) * 0x100 + (b[p + 3] & 0xFF);
}

function buildMinimalEncryptedMp4() {
  // ---- ftyp ----
  const ftyp = box('ftyp', concat(
    Buffer.from('isom', 'latin1'),
    u32(512),
    Buffer.from('isom', 'latin1'),
    Buffer.from('iso2', 'latin1')));

  // ---- moov ----
  const mvhd = box('mvhd', concat(
    Buffer.from([0, 0, 0, 0]),   // version/flags
    u32(0), u32(0),              // creation/modification
    u32(90000),                  // timescale
    u32(0),                      // duration
    u32(0x00010000), u32(0),     // rate/volume
    Buffer.alloc(10),            // reserved
    unityMatrix(),
    Buffer.alloc(24),            // predefined
    u32(2)));                    // next track id
  const tkhd = box('tkhd', concat(
    Buffer.from([0, 0, 0, 3]),   // version 0, flags=enabled
    u32(0), u32(0),
    u32(1),                      // track id
    u32(0),                      // reserved
    u32(180000),                 // duration
    Buffer.alloc(8),             // reserved
    u16(0), u16(0),              // layer/altgroup
    u16(0), u16(0),              // volume/reserved
    unityMatrix(),
    u32(1920 << 16), u32(1080 << 16)));
  const hdlr = box('hdlr', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(0),
    Buffer.from('vide', 'latin1'),
    Buffer.alloc(12),
    Buffer.from('VideoHandler', 'latin1'),
    Buffer.alloc(1)));
  const schm = box('schm', concat(
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('cenc', 'latin1'),
    u32(0)));
  // tenc（version 0）：1 字节 version + 3 字节 flags
  //                 + 1 字节 default_Per_Sample_IV_Size + 16 字节 default_KID
  // 注意：version 0 没有 version 1 才有的 16 字节 reserved 字段，
  // 多写会让解析器整体偏移，KID 读出来全零。
  const tenc = box('tenc', concat(
    Buffer.from([0, 0, 0, 2]),   // version 0 + flags 0x02 (isProtected)
    Buffer.from([16]),           // default_Per_Sample_IV_Size = 16
    KID));
  const schi = box('schi', tenc);
  // frma：记录加密前的原始条目类型。真实 CENC 文件必有此盒，
  // 减壳时靠它把 encv/enca 改回 hvc1/mp4a——只删 sinf 不改类型，
  // 播放器会把条目当加密流而拒绝解码（表现为 codec_name 为空）。
  const frma = box('frma', Buffer.from('hvc1', 'latin1'));
  const sinf = box('sinf', concat(frma, schm, schi));

  // sinf 必须挂在 sample entry（encv）内，而不是 stbl 直接子级 ——
  // 这才是真实 CENC 文件的层级。stbl 只认 CONTAINERS 白名单里的盒型，
  // 写成 stbl 的直接子级会导致 sinf.children 为空、tenc 读不到。
  // encv 布局：6 字节 reserved + 2 字节 data_ref_index
  //            + VisualSampleEntry 字段(70) + 子盒
  // 子盒除 sinf 外还带 hvcC（HEVC 解码配置）——真实加密条目即如此，
  // 减壳在 frma 缺失时靠它兜底推断原始类型。
  const hvcC = box('hvcC', Buffer.alloc(32));
  const encv = box('encv', concat(
    Buffer.alloc(6), u16(1), Buffer.alloc(70), hvcC, sinf));

  const stsd = box('stsd', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(1),
    encv));
  // ---- stsz：逐样本记录真实尺寸 ----
  const plains = buildPlainSamples();
  const stsz = box('stsz', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(0),
    u32(SAMPLE_COUNT),
    concat(...plains.map((p) => u32(p.length)))));
  const stsc = box('stsc', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(1),                      // entry count
    u32(1), u32(SAMPLE_COUNT), u32(1))); // 1 chunk 含 2 样本
  // chunk 偏移先占位，稍后回填
  const stcoPlaceholder = box('stco', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(1),
    u32(0)));

  // ---- senc：version0 + flags0 + sample_count + 每样本 16 字节 IV ----
  //  刻意用标准 16 字节 IV 形态：项目实测的 PIFF 8 字节 IV 由
  //  Mp4.ivToCounter 的独立用例覆盖，两种形态都要测到。
  const senc = box('senc', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(SAMPLE_COUNT),
    ...IVS));

  const stbl = box('stbl', concat(stsd, stsc, stsz, stcoPlaceholder, senc));
  const minf = box('minf', stbl);
  const mdia = box('mdia', concat(hdlr, minf));
  const trak = box('trak', concat(tkhd, mdia));
  const moov = box('moov', concat(mvhd, trak));

  let all = Buffer.concat([ftyp, moov]);

  // ---- mdat：写入真实密文（由固定 content key 加密明文 AVCC 而来）----
  const mdatStart = all.length;
  all = Buffer.concat([all, box('mdat', buildCipherPayload())]);

  // 回填 chunk 偏移：指向 mdat payload 起点
  const chunkOffset = mdatStart + 8;
  const stco = box('stco', concat(
    Buffer.from([0, 0, 0, 0]),
    u32(1),
    u32(chunkOffset)));
  const stcoPos = indexOf(all, Buffer.from('stco', 'latin1'));
  const newStcoLen = stco.length;
  const delta = newStcoLen - stcoPlaceholder.length;
  // 若长度变化则整体重建（保持简单：长度相同则原地替换）
  if (delta === 0) {
    stco.copy(all, stcoPos - 4);
    return all;
  }
  // 长度不同：递归重建 moov
  return rebuild(all, mdatStart);
}

/** 递归替换 stco 内容并重建（处理长度变化）。 */
function rebuild(all, mdatStart) {
  const stcoPos = indexOf(all, Buffer.from('stco', 'latin1'));
  const boxStart = stcoPos - 4;
  const oldSize = u32At(all, boxStart);
  const chunkOffset = mdatStart + 8;
  const stco = box('stco', concat(
    Buffer.from([0, 0, 0, 0]), u32(1), u32(chunkOffset)));
  return Buffer.concat([
    all.subarray(0, boxStart),
    stco,
    all.subarray(boxStart + oldSize),
  ]);
}

function indexOf(hay, needle) {
  return hay.indexOf(needle);
}

// ==================== 基础工具 ====================

/** 构造标准盒（32 位长度 + type + payload）。 */
function box(type, payload) {
  const t = Buffer.from(type, 'latin1');
  const size = 8 + payload.length;
  return concat(u32(size), t, payload);
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0, 0);
  return b;
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xFFFF, 0);
  return b;
}

function unityMatrix() {
  return concat(
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000));
}

function concat(...parts) {
  return Buffer.concat(parts);
}

module.exports = {
  buildMinimalEncryptedMp4,
  buildTailMoovEncryptedMp4,
  fixtureKeyHex,
  plainSamples,
};
