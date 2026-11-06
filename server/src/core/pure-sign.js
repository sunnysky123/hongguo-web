'use strict';
/**
 * 红果 App 接口签名，纯 JS 实现（不依赖任何外部进程或 native so）。
 *
 * 算法源自 jackotom/hongguo-drama 的 src/native/app-source.js（GPL-3.0），
 * 其签名与 spade 算法改编自 woshishiq1/drpys，经 N3urda/hongguoTV 传递。
 * 六个签名头按同一算法直接计算，字节级对齐：
 *
 *   x-gorgon  : RC4 变体 + 位旋转/位反转后处理
 *   x-khronos : 秒级时间戳
 *   x-ladon   : be32(khronos) 的 base64
 *   x-argus   : le32(khronos) 的 base64
 *   x-helios  : md5 -> 64 位字表 -> 类 Feistel 变换的 base64
 *   x-medusa  : sm3(query) + md5(body) 经 hashF13 分支 -> protobuf 消息
 *               -> xmxor 混淆 -> 逆序 -> 异或 -> AesV3 加密的 base64
 *
 * 用法：sign(url, body) 传入完整 URL（含 query）与请求体，
 * 返回需要合并进请求头的签名字段。
 *
 * 注意：签名对 query 字节级敏感，URL 必须与最终发出的请求完全一致
 * （本模块只读 url 的 '?' 之后部分做 sm3，因此调用方传入什么就签什么）。
 *
 * 实现约定：字节统一用 Buffer 并在需要处 `& 0xff` 取无符号；32 位整数溢出
 * 用 `| 0` 对齐；64 位整数运算用 BigInt。
 */
const crypto = require('crypto');
const Crypto = require('../util/crypto');
const Log = require('../util/log');

// SM3 由 Node 内置 crypto 提供（依赖 OpenSSL >= 1.1.1，Node >= 18 均满足）；
// 不可用时直接抛错，不做降级——x-medusa 签名链路离开 SM3 无法工作。
if (!crypto.getHashes().includes('sm3')) {
  throw new Error('当前 Node 运行时缺少 SM3 算法支持（需 OpenSSL >= 1.1.1），x-medusa 签名链路无法工作');
}

// ==================== 基础位运算（对齐 JS 的 u32 语义） ====================

function rotl(x, n) {
  const k = n & 31;
  return (((x << k) | (x >>> ((32 - k) & 31)))) | 0;
}

function ror(x, n) {
  const k = n & 31;
  return (((x >>> k) | (x << ((32 - k) & 31)))) | 0;
}

/** 8 位循环左移。 */
function rotl8(x) {
  return ((x << 4) | (x >>> 4)) & 255;
}

/** 8 位循环左移 3 位（xmxor 专用，与 rotl8 的移位数不同）。 */
function rotl8_3(x) {
  return ((x << 3) | (x >>> 5)) & 255;
}

/** 反转一个字节的 8 个位。 */
function reverseBits(value) {
  let r = 0;
  for (let i = 0; i < 8; i++) r = (r << 1) | ((value >> i) & 1);
  return r;
}

/**
 * 读 32 位整型。
 * 入参统一为 Buffer，直接走 Node 内置的 readUInt32LE/BE，
 * 不再手写位移拼接（历史实现是逐字节移位）。
 */
function readLe32(b, off) {
  return b.readInt32LE(off);
}

function readBe32(b, off) {
  return b.readInt32BE(off);
}

/** 写 32 位整型（Buffer 内置，接受 int32 语义）。 */
function putLe32(b, off, v) {
  b.writeInt32LE(v | 0, off);
}

function putBe32(b, off, v) {
  b.writeInt32BE(v | 0, off);
}

function le32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32LE(v | 0, 0);
  return b;
}

function be32(v) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v | 0, 0);
  return b;
}

/** 读 64 位无符号（Buffer 内置 readBigUInt64LE）。 */
function readU64Le(b, off) {
  return b.readBigUInt64LE(off);
}

function putU64Le(b, off, v) {
  b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)), off);
}

/** 64 位循环右移。 */
function rotr64(x, n) {
  const v = BigInt.asUintN(64, x);
  const k = BigInt(n & 63);
  if (k === 0n) return v;
  return BigInt.asUintN(64, (v >> k) | (v << (64n - k)));
}

function xorBytes(a, b) {
  const out = Buffer.from(a);
  for (let i = 0; i < out.length; i++) out[i] = out[i] ^ b[i % b.length];
  return out;
}

function md5(data) {
  return Crypto.md5(data);
}

function sm3(data) {
  return crypto.createHash('sm3').update(data).digest();
}

const EMPTY = Buffer.alloc(0);

// ==================== protobuf 手写编码 ====================

function varint(value) {
  // 仅签路使用非负值（负值一律走 sint 的 zigzag）
  let n = typeof value === 'bigint' ? value : BigInt(value);
  const out = [];
  while (n > 127n) {
    out.push(Number((n & 127n) | 128n));
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function zigzag(value) {
  return value < 0n ? ((-value) * 2n - 1n) : value * 2n;
}

/** 单个 protobuf 字段。type: string/bytes/message/float/sint/int。 */
function protoField(tag, value, type) {
  if (value === null || value === undefined) return EMPTY;
  if (type === 'string' && value === '') return EMPTY;
  let head;
  let body;
  if (type === 'bytes' || type === 'message') {
    body = value;
    head = Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length)]);
  } else if (type === 'string') {
    body = Buffer.from(String(value));
    head = Buffer.concat([varint((BigInt(tag) << 3n) | 2n), varint(body.length)]);
  } else if (type === 'float') {
    body = Buffer.alloc(4);
    body.writeFloatLE(Number(value), 0);
    head = varint((BigInt(tag) << 3n) | 5n);
  } else {
    const v = BigInt(Math.trunc(Number(value)));
    head = varint(BigInt(tag) << 3n);
    body = varint(type === 'sint' ? zigzag(v) : v);
  }
  return Buffer.concat([head, body]);
}

/** proto([[tag, value, type], ...]) 的紧凑写法。 */
function proto(fields) {
  const parts = [];
  for (const f of fields) {
    const type = f.length > 2 ? String(f[2]) : 'string';
    parts.push(protoField(Number(f[0]), f[1], type));
  }
  return Buffer.concat(parts);
}

// ==================== hashF13 家族 ====================

/** getIv：按字节奇偶交替混合的 32 位状态机。 */
function getIv(iv, data) {
  let value = iv;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] & 0xff;
    if ((i & 1) === 0) {
      value = ((value >>> 4) ^ value ^ (value << 6) ^ d) | 0;
    } else {
      value = ~((value >>> 7) ^ value ^ (d | (value << 12)));
    }
  }
  return value;
}

/** sumMd5：取前 12 字节的固定轮混淆，末位或 4 再异或 0x1000000。 */
function sumMd5(data) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i++) {
    const temp = (i & 1) === 0 ? ((check >>> 3) ^ check) : ((check >>> 5) ^ check);
    check = (i & 1) === 0
      ? ((data[i] & 0xff) ^ (check << 7))
      : ((data[i] & 0xff) | (check << 11));
    if ((i & 1) !== 0) check = ~check;
    check = check ^ temp;
  }
  return ((check | 4) ^ 0x1000000) | 0;
}

const BRANCH2_SV = [
  0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5, 0x38afe0ef, 0xb2bbad73,
  0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40, 0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64,
  0x353595a4, 0x4609c13b, 0x36925008, 0x8c6d0925, 0x5df5c177, 0x1cfbf52b, 0x8a4fa7f0, 0x114ca35e,
  0x8193f984, 0x7a7a8733, 0x316ab4d5, 0x3c20cfc9, 0xa6d84453, 0x3a18500c, 0x798ec47a, 0x97a76b28,
  0x66c4ff96, 0x51716443, 0x0dd2fc3b, 0xb5696da7, 0xbbeb3ac5, 0x5c53d204, 0xd32608ce, 0x7279b9ec,
  0xf4188ecf, 0xf7d793db, 0x332cc491, 0xab76ae15, 0x9bebe727, 0x18a01384, 0x5be9f8a7, 0x5f90a754,
  0x39b663c0, 0x36673c83, 0x7c92f514, 0x9d7d94d7, 0xe2e8d9aa, 0x5f7e9ea9, 0x7abd4551, 0x569e05da,
  0x40a25632, 0x3df5a9a5, 0xbab37d80, 0x454286dc, 0x3f5d4e78, 0x03d7b75d, 0xb1fe4af7, 0xa5ab26a3];

const BRANCH2_ORDERS = Crypto.unhex(
  '0f0704000908030a060b050d0e010c02'
  + '0f05080c0009020103070e060b0a0d04'
  + '060500070c000a04080f010b0d09020e'
  + '060b02050403080101070a000d0c090e'
  + '0d070e0f0b0208030c0509010004060a'
  + '0d0902060f0b0a040807000c0503010e'
  + '0c090f07060f030e020d0405010b0a00'
  + '0c050a090e0802040407030f01060b00'
  + '0b0f0408020a0700090d06010e03050c'
  + '0b060a0508020c03070f0e090d000104'
  + '0906080f050800040a0b030d01020c0e'
  + '090d0c0604070a03030f00080105020e'
  + '01000d0f090a0b0e0402080703060c05'
  + '01080a0c0f0905060b000304020e070d'
  + '04080f000c0f0e0d0a01060207090503'
  + '040205080d0b0a0606000e0f070c0903'
  + '0a08040f000b01060d0c0709030e0502'
  + '0a070b050f00020e0108030d0c060904'
  + '0d070f08050f06040b0a0e0c09000203'
  + '0d0c020704010b0e0e08060f09050003');

function md5V3Step(kind, a, b, c, d, m, shift, constant) {
  let f;
  if (kind === 0) f = (b & c) | (~b & d);
  else if (kind === 1) f = (b & d) | (c & ~d);
  else if (kind === 2) f = b ^ c ^ d;
  else f = c ^ (b | ~d);
  return (b + rotl((a + f + m + constant) | 0, shift)) | 0;
}

/** MD5 变体：固定轮常量表 + 消息编排表驱动的 64 轮压缩。 */
function md5SumV3(message, countV2, orders, countV1) {
  const sv = new Array(BRANCH2_SV.length);
  for (let i = 0; i < sv.length; i++) sv[i] = ror(BRANCH2_SV[i], countV1);
  const start = [
    ror(0x79e0f2fb, countV2), ror(0xc8b52570, countV2),
    ror(0xebc2f8cd, countV2), ror(0x7c104d93, countV2)];
  const endCount = (countV2 + 6) & 255;
  const end = [
    ror(0x19be4866, endCount), ror(0xe85986b4, endCount),
    ror(0xe19b326e, endCount), ror(0x71d1d7d4, endCount)];
  const m = new Array(16);
  for (let i = 0; i < 16; i++) m[i] = readLe32(message, i * 4);
  let a = start[0]; let b = start[1]; let c = start[2]; let d = start[3];

  const shifts0 = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22];
  const shifts1 = [5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20];
  const shifts2 = [4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23];
  const shifts3 = [6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];

  for (let kind = 0; kind < 4; kind++) {
    const shifts = kind === 0 ? shifts0 : kind === 1 ? shifts1 : kind === 2 ? shifts2 : shifts3;
    const offset = kind * 16;
    for (let i = 0; i < 16; i++) {
      const phase = i & 3;
      const mm = m[orders[offset + i] & 0xff];
      const cc = sv[offset + i];
      let next;
      if (phase === 0) next = md5V3Step(kind, a, b, c, d, mm, shifts[i], cc);
      else if (phase === 1) next = md5V3Step(kind, d, a, b, c, mm, shifts[i], cc);
      else if (phase === 2) next = md5V3Step(kind, c, d, a, b, mm, shifts[i], cc);
      else next = md5V3Step(kind, b, c, d, a, mm, shifts[i], cc);
      if (phase === 0) a = next;
      else if (phase === 1) d = next;
      else if (phase === 2) c = next;
      else b = next;
    }
  }
  const ret = Buffer.alloc(16);
  putLe32(ret, 0, (start[0] + a) ^ end[0]);
  putLe32(ret, 4, (start[1] + b) ^ end[1]);
  putLe32(ret, 8, (start[2] + c) ^ end[2]);
  putLe32(ret, 12, (start[3] + d) ^ end[3]);
  return Buffer.concat([ret, le32(sumMd5(ret))]);
}

function branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos) {
  const v = (iv & 13) * 86;
  const ivV0 = ((v >>> 15) & 255) + ((v >>> 8) & 255);
  const n1 = [0x8980f29b, 0xeb549c7f, 0xb08726db, 0xd40cb5e6, 0xe8f559e4][ivV0];
  const countV1 = (n1 + khronos + 1) & 255;
  const countV2 = (n1 + khronos) | 0;
  const shift = (countV2 + 5) & 7;
  const seed = [0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8];
  const pad = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) pad[i] = ((seed[i] | (seed[i] << 8)) >> shift) & 255;
  const input = Buffer.concat([querySm3, bodyMd5, tsBytes, pad,
    Crypto.unhex('a0010000')]);
  const from = ivV0 << 6;
  const to = (ivV0 + 1) << 6;
  const orders = BRANCH2_ORDERS.subarray(from, to);
  return md5SumV3(input, countV2, orders, countV1);
}

/** hashF13：按 iv 低 4 位选分支（0 为主分支，1 不被服务端接受，2 为备用变体）。 */
function hashF13(querySm3, bodyMd5, tsBytes, khronos) {
  const iv = getIv(getIv(getIv(0x20230928, querySm3), bodyMd5), tsBytes);
  const low = iv & 15;
  const ivV0 = (low * 171) >> 9;
  const branch = low - ivV0 * 3;
  if (branch === 2) return branch2F13(iv, querySm3, bodyMd5, tsBytes, khronos);
  if (branch !== 0) {
    return Buffer.concat([querySm3.subarray(0, 16), bodyMd5,
      le32(sumMd5(Buffer.concat([querySm3, bodyMd5])))]);
  }

  const ivV1List = [0xc4a78580, 0xb3c0fd39, 0xc58c5686, 0xc9aa3ba7, 0xf5a7adf2, 0x963c2ed1];
  const ivV1 = ivV1List[ivV0] | 0;
  const countV1 = (ivV1 + khronos + 1) & 255;
  const countV2 = (ivV1 + khronos) | 0;
  const tt02 = [
    0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
    0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
    0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
    0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
    0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
    0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
    0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
    0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x0284ba7, 0x08387cfa, 0x5fb37586];
  const tt = new Array(tt02.length);
  for (let i = 0; i < tt.length; i++) tt[i] = ror(tt02[i], countV1);
  const n0 = (countV2 + 2) & 7;
  const seed = [0xfa, 0x45, 0x61, 0xd7];
  // JS: Buffer.from(seed.map(...)) —— seed 仅 4 个元素，pad 为 4 字节
  const pad = Buffer.alloc(seed.length);
  for (let i = 0; i < seed.length; i++) pad[i] = ((seed[i] | (seed[i] << 8)) >> n0) & 255;
  const data = Buffer.concat([querySm3, bodyMd5, tsBytes, pad,
    Crypto.unhex('00000000000001a0')]);

  const di = new Array((data.length / 4) + 112 + 16).fill(0);
  let diLen = 0;
  for (let i = 0; i + 3 < data.length; i += 4) di[diLen++] = readBe32(data, i);
  // di0 每轮前进一格：参考实现里它是「上一轮的 di[i+1]」，等价于本轮取 di[i]。
  // 写成常量 di[0] 会让第 1 轮之后的每一项都算错（branch 0 的 queryBodyTs 全错）。
  let di0 = di[0];
  for (let i = 0; i < 112; i++) {
    const di1 = di[i + 1];
    const di14 = di[i + 14];
    const r1 = rotl(di1, 14) ^ rotl(di1, 25) ^ (di1 >>> 3);
    const r2 = rotl(di14, 13) ^ rotl(di14, 15) ^ (di14 >>> 10);
    di[diLen++] = (di0 + di[i + 9] + r1 + r2) | 0;
    di0 = di1;
  }

  const initRaw = [0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
    984304912, 3005047866, 2874125293, 2152413264];
  const init = new Array(8);
  for (let i = 0; i < 8; i++) init[i] = ror(initRaw[i], countV2 & 31);
  const chosenTable = [
    [101, 5, 7, 6, 3, 2, 1, 0, 5, 4, 3],
    [96, 0, 6, 7, 5, 3, 2, 1, 5, 4, 4],
    [96, 7, 6, 2, 1, 4, 0, 5, 4, 3, 5],
    [99, 3, 6, 2, 4, 5, 1, 0, 0, 7, 6],
    [96, 0, 5, 6, 7, 3, 1, 2, 5, 4, 4],
    [100, 2, 0, 3, 5, 4, 6, 7, 2, 1, 5]];
  const chosen = chosenTable[ivV0];
  const d = init.slice();
  for (let i = 0; i < chosen[0]; i++) {
    const base = (ivV1 + i) | 0;
    const n0v = di[base & 127];
    const n1 = ((d[chosen[3]] ^ d[chosen[4]]) & d[chosen[1]]) ^ d[chosen[3]];
    const n2 = rotl(d[chosen[1]], 26) ^ rotl(d[chosen[1]], 21) ^ rotl(d[chosen[1]], 7);
    const n4 = (n0v + n1 + n2 + tt[base & 63] + d[chosen[5]]) | 0;
    const n5 = rotl(d[chosen[2]], 30) ^ rotl(d[chosen[2]], 19) ^ rotl(d[chosen[2]], 10);
    const n6 = (d[chosen[2]] & d[chosen[6]]) | ((d[chosen[2]] | d[chosen[6]]) & d[chosen[7]]);
    const n7 = (n5 + n6) | 0;
    const old = d[chosen[9]];
    // d.unshift(d.pop())：末元素移到队首（循环右移一格）
    const last = d[d.length - 1];
    for (let k = d.length - 1; k >= 1; k--) d[k] = d[k - 1];
    d[0] = last;
    d[chosen[10]] = (n7 + n4) | 0;
    d[chosen[8]] = (old + n4) | 0;
  }
  const ret = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) putBe32(ret, i * 4, (d[i] + init[i]) | 0);
  for (let i = 0; i < 16; i++) ret[i] = ret[i] ^ ret[i + 16];
  return Buffer.concat([ret.subarray(0, 16), le32(sumMd5(ret.subarray(0, 16)))]);
}

// ==================== x-gorgon ====================

/** RC4 变体（KSA 只赋值不交换，PRGA 异或 s[(y+y)&255]）。 */
function rc4Gorgon(data, key) {
  const s = new Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    s[i] = s[j];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i += 1;
    const x = s[i];
    j += x;
    const y = s[j & 255];
    s[i] = y;
    out[k] = data[k] ^ s[(y + y) & 255];
  }
  return out;
}

function xGorgon(query, body, timestamp, random) {
  const q4 = md5(Buffer.from(query)).subarray(0, 4);
  const b4 = body != null && body.length > 0
    ? md5(body).subarray(0, 4) : Buffer.alloc(4);
  const sdk = le32(67503104);
  const input = Buffer.concat([q4, b4, Buffer.alloc(4), sdk, be32(timestamp | 0)]);
  const key = [0x4a, 0x40, 0x16, (random >> 8) & 255, 0x47, 0x6c, 0x01, random & 255];
  const out = rc4Gorgon(input, key);
  for (let i = 0; i < out.length; i++) {
    const value = rotl8(out[i] & 0xff);
    const next = i + 1 < out.length ? (out[i + 1] & 0xff) : (out[0] & 0xff);
    out[i] = (~(reverseBits((next ^ value) & 255) ^ 20)) & 255;
  }
  return Crypto.hex(Buffer.concat([Crypto.unhex('8404'),
    Buffer.from([random & 255, (random >> 8) & 255, 0x40, 0x01]), out]));
}

// ==================== AesV3（medusa 内置的 AES 变体） ====================

const SBOX = Buffer.from(
  '+n0Ia5xZs0sEXznQOEqRmQBnpiCf9U2Ccybu3xhmgzOAAxn72f6uqqmwUsYL83klTni0NqxdGieeiNu9PGPsSRXBMB/cuFbUbM3KCUPINaPvHvSW0vwOcnuUhNHqRVpiAj/TEoE0K91+5ijypUYTATsh9mE3KSoN7Yyvv51cuyR2D3XkU4nhmI2xmmVwT1RMWKtub4sjxAcRDLrPoKSO2AU9FLLadMPX577Wf95IFj6FkKFVt3dCIsmGUC4X+WQxLJvxbRxEaOPpqJOXyzJX6+Vxaq3AzMfF/WAdoi1Hp+JRaV56zgpBtpWP97mH4DoGEIq1+FvV8LyS/3wvwugbQOwb2r26mJEMsiuDQTRn+wrYdrVGBVlhI3WQhyrjUBVMrLF5667llUcEaPCGPVGLD8qO5LlO8hKCvA7V9+8oJc9bXelqVQLhM76T5/WtnT45JKji+hdX0HoNCDDWuKON/QeaxB5uImSX0h2wv0VmP2zd2yeApxHcpsVS+MC2yFwAc2B7oBkTqsk1SEvTpM2fmfMQREBUfin0Bh+iq6EvPPavhWI2IX9e3yAas7Tm/3KEj2UmlFp36kN4x0rMLBRrxuh0U/zUHM4xcAMYjJY4MonxOl/X+alpt2M3WMI7w3HLnpIBigtNiJu7T21v4P6lSd5WFgntnMEt7oF92XzRLkJbTcGmXepE/UVOG6E/0YnhfS+q26utWcuxzpooyeD2cDlK1/8w9d28VzsRjbLuALbmGlp8+d7EzS6Au7lMpZ+ECMZvQmzwJ+eLOpxR+2chdUExp8ogQyq3v9l68rX4jCwjg0+PYKAEEzcU4wHFY2ZcdIHfWL1okD3SszT0GZMyKdZJrg1L2AeerB4tC0C4crp2EHGo5FYdSP7lwkeR2ocmnR+Ia8CYviUJlzOjhRZef9xuVOn3qcjow3fQgivsAmKKkg4+sA8F8/GWeDiGNhg8JM8KtFPMYWWkx5TVFX5t73kiNRJqjlIGVXtGZFCV4gzt0xcDopuZ6xz8r9Rzafpf9ywev8jh8592gHFIqpStZPuJxmDDMrNN0uBE3V+oscdoIzTJbRJ/t+sVvqnReJOgDJKk10fjisJwqyZBmnmn2BSFj8BvVtCMEbkuPOKdzw7eA11GPs04Qw8zWtkaZWwiO/wwpojqN6K0jY5RnNZA7vn4hPSul+nKCkVnVwQvg1zVxcSCtqORmB9KrJaBbssbCQivGJVJfVTt+hYxOtq4ZvWl8f4QAQZ0zGPffCgl9s6yT4vlvIdpu4YhBwA25wtQWZsc6GJYGWHyvSdeuh3mmUI9DSq13Fsp8C1MU3tqc04/df9LoTUXVXI5INOw/e8C7Hd+5CvbkMEFnnrUUmskEw==',
  'base64');

/** JS 语义：越界读返回 0（undefined 在位运算中等价于 0）。 */
function aesSrc(data, idx) {
  return idx < data.length ? (data[idx] & 0xff) : 0;
}

function aesPut(out, idx, value) {
  if (idx >= 0 && idx < out.length) out[idx] = value & 0xff;
}

function aesMatrix(bytes) {
  const rows = new Array(4);
  for (let i = 0; i < 4; i++) {
    rows[i] = new Array(4);
    for (let j = 0; j < 4; j++) rows[i][j] = bytes[i * 4 + j] & 0xff;
  }
  return rows;
}

function aesFlat(rows) {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) b[i * 4 + j] = rows[i][j] & 0xff;
  }
  return b;
}

function aesXt(x) {
  return ((x << 1) ^ ((x & 128) !== 0 ? 0x1b : 0)) & 255;
}

function aesMix(rows) {
  for (let i = 0; i < 4; i++) {
    const t = rows[0][i] ^ rows[1][i] ^ rows[2][i] ^ rows[3][i];
    const u = rows[0][i];
    rows[0][i] ^= t ^ aesXt(rows[0][i] ^ rows[1][i]);
    rows[1][i] ^= t ^ aesXt(rows[1][i] ^ rows[2][i]);
    rows[2][i] ^= t ^ aesXt(rows[2][i] ^ rows[3][i]);
    rows[3][i] ^= t ^ aesXt(rows[3][i] ^ u);
  }
}

/** AES 变体：S 盒按 khronos 选段、行/列换用查表、密钥扩展 12 组。 */
class AesV3 {
  constructor(key, khronos) {
    this.wordSize = khronos & 3;
    this.box = SBOX.subarray(this.wordSize * 256, (this.wordSize + 1) * 256);
    const con2Table = [[1, 0, 2, 3], [2, 0, 3, 1], [0, 1, 3, 2], [1, 0, 2, 3]];
    const orderTable = [
      [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3],
      [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
      [0, 9, 14, 7, 4, 13, 2, 11, 8, 1, 6, 3, 12, 5, 10, 15],
      [0, 9, 14, 11, 4, 13, 2, 7, 8, 1, 6, 15, 12, 5, 10, 3]];
    this.con2 = con2Table[this.wordSize];
    this.order = orderTable[this.wordSize];
    const init = [0xca025ddc, 0x823dc546, 0xc9420583, 0xc298225f][this.wordSize];
    const initial = Buffer.alloc(16);
    for (let i = 0; i < 4; i++) putLe32(initial, i * 4, init);
    const mk = xorBytes(initial, key);
    const expanded = Buffer.concat([mk, Buffer.alloc(32)]);
    let rounds = 8;
    for (let i = 4; i < 12; i++) {
      const at = 4 * (i - 1);
      let a = expanded[at] & 0xff; let b = expanded[at + 1] & 0xff;
      let c = expanded[at + 2] & 0xff; let d = expanded[at + 3] & 0xff;
      if ((i & 3) === 0) {
        const t = ((init >>> (rounds & 24)) ^ (this.box[b] & 0xff)) & 255;
        b = this.box[c] & 0xff;
        c = this.box[d] & 0xff;
        d = this.box[a] & 0xff;
        a = t;
      }
      rounds += 2;
      expanded[at + 4] = (a ^ (expanded[at - 12] & 0xff)) & 0xff;
      expanded[at + 5] = (b ^ (expanded[at - 11] & 0xff)) & 0xff;
      expanded[at + 6] = (c ^ (expanded[at - 10] & 0xff)) & 0xff;
      expanded[at + 7] = (d ^ (expanded[at - 9] & 0xff)) & 0xff;
    }
    this.keys = new Array(12);
    for (let i = 0; i < 12; i++) {
      this.keys[i] = new Array(4);
      for (let j = 0; j < 4; j++) this.keys[i][j] = expanded[i * 4 + j] & 0xff;
    }
  }

  add(rows, key) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] ^= key[i][j];
    }
  }

  addCon(rows, ks) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] ^= ks[i][this.con2[j]];
    }
  }

  sub(rows) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] = this.box[rows[i][j]] & 0xff;
    }
    const old = new Array(4);
    for (let i = 0; i < 4; i++) old[i] = rows[i].slice();
    for (let i = 0; i < 4; i++) rows[i] = old[this.con2[i]];
  }

  shift(rows) {
    const b = aesFlat(rows);
    for (let i = 0; i < 16; i++) rows[(i / 4) | 0][i % 4] = b[this.order[i]] & 0xff;
  }

  shiftCon(rows) {
    const old = new Array(4);
    for (let i = 0; i < 4; i++) old[i] = rows[i].slice();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) rows[i][j] = old[i][this.con2[j]];
    }
  }

  block(value) {
    const rows = aesMatrix(value);
    const k0 = this.subKeys(0);
    this.addCon(rows, k0);
    for (let i = 1; i < 3; i++) {
      this.sub(rows);
      this.shift(rows);
      if (i === 1) {
        this.shiftCon(rows);
        aesMix(rows);
      }
      this.addCon(rows, this.subKeys(i * 4));
    }
    this.add(rows, this.subKeys(4));
    return aesFlat(rows);
  }

  subKeys(from) {
    const out = new Array(4);
    for (let i = 0; i < 4; i++) out[i] = this.keys[from + i].slice(0, 4);
    return out;
  }

  /** 加密：明文具化到 32 字节 -> CBC 两轮 -> 按 key 逐位回填源数据，末尾缀 key 末字节。 */
  encrypt(data, iv) {
    const plaintext = Buffer.alloc(32);
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      const n0 = (aesSrc(data, at) >> 4) & 2;
      const n1 = n0 | (aesSrc(data, at + 1) & 64);
      const n2 = n1 | ((aesSrc(data, at + 2) >> 2) & 1);
      const n3 = n2 | ((aesSrc(data, at + 3) << 3) & 128);
      const n4 = n3 | ((aesSrc(data, at + 4) >> 1) & 4);
      const n5 = n4 | ((aesSrc(data, at + 5) << 3) & 16);
      const n6 = n5 | ((aesSrc(data, at + 6) << 5) & 32);
      plaintext[i] = (n6 | ((aesSrc(data, at + 7) >> 4) & 8)) & 0xff;
    }
    plaintext[31] = 1;
    const blocks = [];
    let previous = Buffer.from(iv);
    for (let i = 0; i < plaintext.length; i += 16) {
      const value = this.block(xorBytes(plaintext.subarray(i, i + 16), previous));
      blocks.push(value);
      previous = value;
    }
    const key = Buffer.concat(blocks);
    const out = Buffer.from(data);
    for (let i = 0; i < 31; i++) {
      const at = i * 8;
      const k = key[i] & 0xff;
      // JS 语义：越界读写均静默忽略，故读用 aesSrc()、写用 aesPut()
      aesPut(out, at, (aesSrc(out, at) & 0xdf) | ((k << 4) & 32));
      aesPut(out, at + 1, (aesSrc(out, at + 1) & 0xbf) | (k & 64));
      aesPut(out, at + 2, (aesSrc(out, at + 2) & 0xfb) | ((k << 2) & 4));
      aesPut(out, at + 3, (aesSrc(out, at + 3) & 0xef) | ((k >> 3) & 16));
      aesPut(out, at + 4, (aesSrc(out, at + 4) & 0xf7) | ((k + k) & 8));
      aesPut(out, at + 5, (aesSrc(out, at + 5) & 0xfd) | ((k >> 3) & 2));
      aesPut(out, at + 6, (aesSrc(out, at + 6) & 0xfe) | ((k >> 5) & 1));
      aesPut(out, at + 7, (aesSrc(out, at + 7) & 0x7f) | ((k << 4) & 128));
    }
    return Buffer.concat([key.subarray(key.length - 1, key.length), out]);
  }
}

// ==================== xmxor / keyHash / medusa / helios ====================

/** xmxor：按 key 表逐字节混淆 + 三段尾部修正。 */
function xmxor(data, key) {
  const encoded = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    const at = (i * 4) & 28;
    const d0 = key[at] & 0xff;
    const d1 = key[at + 1] & 0xff;
    let d2 = (rotl8(data[i] & 0xff) + d0);
    d2 = (~d2) ^ d1;
    d2 = rotl8_3(d2 & 0xff);
    d2 = (d2 + d1) & 255;
    d2 = (d2 ^ d0) & 255;
    encoded[data.length - i - 1] = (~d2) & 255;
  }
  const last = (encoded[encoded.length - 1] ^ encoded[encoded.length - 2]) & 255;
  const first = encoded[0] & 0xff;
  encoded[0] = ((~last) + first) & 255;
  encoded[1] = ((encoded[0] ^ encoded[encoded.length - 1] ^ 254) + encoded[1]) & 255;
  encoded[2] = (encoded[2] + (((last - first) ^ rotl8_3(encoded[1] & 0xff)) ^ 2)) & 255;
  for (let i = 0; i < encoded.length - 4; i++) {
    const temp = (rotl8_3(encoded[i + 2] & 0xff) ^ encoded[i + 1] ^ (i + 3));
    encoded[i + 3] = ((~temp) + encoded[i + 3]) & 255;
  }
  encoded[encoded.length - 1] = (encoded[encoded.length - 1] ^ encoded[encoded.length - 2]) & 255;
  let sum = 0;
  for (let i = 0; i < encoded.length - 1; i++) sum += encoded[i + 1] & 0xff;
  encoded[0] = ((encoded[0] ^ encoded[1]) + sum) & 255;
  return encoded;
}

/** keyHash：signKey || le32(random) || signKey 的 SM3，附一个由 random 派生的 4 字节种子。 */
function keyHash(signKey, random) {
  const hash = sm3(Buffer.concat([signKey, le32(random), signKey]));
  const d1 = (random >> 16) & 255;
  let d2 = (((d1 << 11) | (random >>> 24)) ^ (d1 >> 5) ^ d1);
  d2 = ~d2;
  return [hash, le32(d2)];
}

const MEDUSA_SIGN_KEY = Crypto.unhex(
  '8ebdfa3806ecc5cee79423e6029ed82540bc2218bb7eaef71cb691f7aa8aa2f5');
const MEDUSA_AES_KEY = Crypto.unhex('f1593376766ea98d34f31b057a9d5be4');
const MEDUSA_AES_IV = Crypto.unhex('1fe109a4125283f418de9e051a969e12');
const MEDUSA_MAGIC16 = Crypto.unhex('f7e85ffad7d7dc3bd62ac87057cf6118');
const MEDUSA_MAGIC8 = Crypto.unhex('4001000000000000');

/** 进程级 nonce（18 随机字节的 base64url）。 */
const PROCESS_NONCE = crypto.randomBytes(18).toString('base64url');
const PROCESS_STARTED = Date.now();

function randomBytes(n) {
  return crypto.randomBytes(n);
}

/** 返回 [0, n) 的随机整数。 */
function rndInt(n) {
  return crypto.randomInt(n);
}

/**
 * 返回无符号 32 位随机整数（0 ~ 2^32-1）。
 *
 * 参考实现的随机源是 `Math.floor(Math.random() * 0x100000000)`，恒为非负；
 * 这里同样取无符号，避免下游对符号做隐式假设（medusa 的 `random >> 16`、
 * `le32(random)` 都基于「非负 32 位整数」这一前提）。
 */
function rndInt32() {
  return crypto.randomBytes(4).readUInt32BE(0);
}

/**
 * 设备信息 protobuf。与 jackotom 参考实现保持一致：字段 30-36 为固定设备值
 * （25053RT47C / Redmi / Xiaomi），不跟随 query 参数，仅 deviceId/version 外部传入。
 */
function deviceProto(deviceId, version) {
  return proto([
    [1, 1, 'sint'], [2, 2, 'sint'], [3, '8662'], [4, deviceId],
    [5, PROCESS_NONCE], [6, '!noperm!'], [7, -888888, 'sint'], [8, -888888, 'sint'],
    [9, 3, 'sint'], [10, -888888, 'sint'], [11, '!notset!'],
    [12, 'Asia/Shanghai,8'], [13, 'zh_CN'], [14, 4, 'sint'],
    [16, 0, 'float'], [17, 0, 'float'], [18, 0, 'float'], [19, 0, 'float'],
    [20, 0, 'float'], [21, 0, 'float'], [22, '16'], [23, 41, 'sint'],
    [24, 36, 'sint'], [25, PROCESS_STARTED, 'sint'], [26, PROCESS_STARTED, 'sint'],
    [27, PROCESS_STARTED, 'sint'], [28, PROCESS_STARTED, 'sint'], [29, -1, 'sint'],
    [30, '25053RT47C'], [31, 'Redmi'], [32, '25053RT47C'], [33, '25053RT47C'],
    [34, 'Xiaomi'], [35, 'Redmi'], [36, 'Redmi'], [38, 31, 'sint']]);
}

/** 构造 x-medusa。 */
function buildMedusa(url, body, khronos, deviceId, version) {
  const bodyMd5 = body != null && body.length > 0 ? md5(body) : Buffer.alloc(16);
  const query = queryOf(url);
  const querySm3 = sm3(Buffer.from(query));
  const ts = le32(khronos | 0);
  const queryBodyTs = hashF13(querySm3, bodyMd5, ts, khronos);

  const messageRand = randomBytes(4);
  const messageRandU = readLe32(messageRand, 0) >>> 0;
  const envLaunch = 100 + rndInt(21);
  const envPid = 10001 + rndInt(2000);
  const env = proto([
    [1, envLaunch, 'sint'], [2, 146331399, 'sint'], [3, 146331396, 'sint'],
    [5, 7, 'sint'], [6, 'v04.06.04.03-bugfix'], [7, envPid, 'sint'],
    [12, deviceProto(deviceId, version), 'message'],
    [13, proto([
      [1, Math.floor(Date.now() / 1000), 'sint'],
      [2, -2, 'sint'], [4, 200, 'sint']]), 'message'],
    [14, version]]);
  const queryHash = sm3(Buffer.concat([Buffer.from(query), bodyMd5,
    Buffer.from('none')]));

  const nested = proto([
    [1, 111, 'sint'], [2, 10, 'sint'], [3, 694367, 'sint'], [5, 586952199, 'sint']]);
  const message = proto([
    [1, MEDUSA_MAGIC16, 'bytes'], [2, 3, 'sint'], [3, messageRandU, 'sint'],
    [4, '8662'], [5, deviceId], [6, '1588093228'], [7, version],
    [8, 'v04.06.04-ml-android'], [9, 67503104, 'sint'],
    [10, MEDUSA_MAGIC8, 'bytes'], [12, khronos, 'sint'],
    [13, queryBodyTs, 'bytes'], [14, querySm3.subarray(0, 6), 'bytes'],
    [15, nested, 'message'], [16, PROCESS_NONCE], [17, khronos, 'sint'],
    [19, queryHash, 'bytes'], [20, 'none'], [21, 312, 'sint'],
    [23, env, 'message'],
    [24, '{"cmr":16777216,"cmr2":16777216,"un_h":1879194040,"vpn":0,'
    + '"kd":0,"fkd":3672518972,"pd":-1872573247,"dyn":"",'
    + '"do":0,"tk":true}']]);

  const random = rndInt32();
  const hs = keyHash(MEDUSA_SIGN_KEY, random);
  const hash = hs[0];
  const seed = hs[1];
  let transformed = xmxor(message, hash);
  transformed = Buffer.concat([MEDUSA_MAGIC8, transformed]);
  // 整体逆序
  for (let i = 0, j = transformed.length - 1; i < j; i++, j--) {
    const t = transformed[i];
    transformed[i] = transformed[j];
    transformed[j] = t;
  }
  for (let i = 0; i < transformed.length; i++) {
    transformed[i] = (transformed[i] ^ seed[(~i) & 3]) & 0xff;
  }
  const check = (((querySm3[0] & 63) << 14) | 0x18000001 | ((queryBodyTs[0] & 63) << 8)) | 0;
  const xmRand = rndInt32();
  const packed = Buffer.concat([Buffer.from([0x35]), le32(xmRand), le32(check), transformed,
    Buffer.from([(random >> 16) & 255, (random >> 24) & 255])]);
  const encrypted = new AesV3(MEDUSA_AES_KEY, khronos).encrypt(packed, MEDUSA_AES_IV);
  const versionBytes = Crypto.unhex('03000000f7e85ffad7d7dc3bd62ac87057cf6118');
  const prefix = Buffer.alloc(20);
  for (let i = 0; i < 20; i += 4) {
    // JS: u32(version.readUInt32LE(i) ^ khronos) 后 writeUInt32LE
    putLe32(prefix, i, (readLe32(versionBytes, i) ^ (khronos | 0)));
  }
  return Buffer.concat([prefix,
    Buffer.from([random & 255, (random >> 8) & 255, 0, 1]), encrypted]).toString('base64');
}

/** helios：md5 ASCII 化 -> 64 位字表 -> 34 轮扩展 -> 分组类 Feistel。 */
function helios(khronos) {
  return heliosWith(khronos, rndInt32());
}

/** 可注入 random 的 helios（默认重载用 rndInt32()）。 */
function heliosWith(khronos, random) {
  const digest = md5(Buffer.concat([le32(random), Buffer.from('8662')]));
  const hex = digest.toString('hex');
  const ascii = Buffer.from(hex, 'ascii');
  const words = new Array(4);
  for (let i = 0; i < 4; i++) words[i] = readU64Le(ascii, i * 8);

  // JS: words.splice(0,2) 后每轮 push 一个、shift 一个，队列恒长 2。
  // 用双端队列精确模拟：b8 始终取「最早入队未消费」的元素。
  const queue = [words[2], words[3]];
  let b0 = words[0];
  let b8 = words[1];
  const table = new Array(35);
  table[0] = words[0];
  for (let i = 0; i < 34; i++) {
    let x8 = BigInt.asUintN(64, rotr64(b8, 8) + b0);
    x8 = BigInt.asUintN(64, x8 ^ BigInt(i));
    queue.push(x8);
    x8 = BigInt.asUintN(64, x8 ^ rotr64(b0, 61));
    table[i + 1] = x8;
    b0 = x8;
    b8 = queue.shift();
  }
  const text = String(khronos) + '-1588093228-8662';
  const tb = Buffer.from(text);
  const padLen = Math.floor((tb.length + 1 + 15) / 16) * 16;
  const pad = Buffer.alloc(padLen);
  pad.fill((16 - (tb.length % 16)) & 0xff);
  tb.copy(pad, 0);

  const output = [];
  for (let at = 0; at < pad.length; at += 16) {
    let a = readU64Le(pad, at);
    let b = readU64Le(pad, at + 8);
    for (let i = 0; i < 34; i++) {
      b = BigInt.asUintN(64, table[i] ^ BigInt.asUintN(64, a + rotr64(b, 8)));
      a = BigInt.asUintN(64, b ^ rotr64(a, 61));
    }
    const block = Buffer.alloc(16);
    // JS: block.writeBigUInt64LE —— 小端写入
    putU64Le(block, 0, a);
    putU64Le(block, 8, b);
    output.push(block);
  }
  const all = [le32(random), ...output];
  return Buffer.concat(all).toString('base64');
}

// ==================== 分支判定与入口 ====================

/** 与 hashF13 相同的分支计算；branch==1 时服务端不认，调用方应抖动 _rticket 避开。 */
function branchOf(url, body, khronos) {
  const bodyMd5 = body != null && body.length > 0 ? md5(body) : Buffer.alloc(16);
  const q = sm3(Buffer.from(queryOf(url)));
  const iv = getIv(getIv(getIv(0x20230928, q), bodyMd5), le32(khronos | 0));
  const low = iv & 15;
  return low - (((low * 171) >> 9) * 3);
}

function queryOf(url) {
  const i = url.indexOf('?');
  return i < 0 ? '' : url.substring(i + 1);
}

/**
 * 计算一组签名头。
 *
 * @param {string} url  完整 URL（含 query），必须与最终请求一致
 * @param {Buffer|null} body 请求体字节；GET 传 null
 * @param {number} [khronos] 可选的秒级时间戳；缺省取当前时间
 * @returns {object} 需要合并进请求头的字段（x-gorgon / x-khronos / x-ladon / x-argus / x-helios / x-medusa）
 */
function sign(url, body, khronos) {
  const ts = (khronos === undefined || khronos === null)
    ? Math.floor(Date.now() / 1000) : khronos;
  const gorgonRandom = rndInt(65536);
  const query = queryOf(url);
  const out = {};
  out['x-gorgon'] = xGorgon(query, body, ts, gorgonRandom);
  out['x-khronos'] = String(ts);
  out['x-ladon'] = be32(ts | 0).toString('base64');
  out['x-argus'] = le32(ts | 0).toString('base64');
  out['x-helios'] = helios(ts);
  out['x-medusa'] = buildMedusa(url, body, ts,
    paramOf(query, 'device_id', '0'),
    paramOf(query, 'version_name', '7.1.3.32'));
  return out;
}

function paramOf(query, key, fallback) {
  for (const kv of query.split('&')) {
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    if (kv.substring(0, eq) === key) {
      const v = kv.substring(eq + 1);
      if (v.length > 0) return v;
    }
  }
  return fallback;
}

/**
 * 仅供自检：用 query/body 明文跑一次 hashF13，返回十六进制。
 *
 * hashF13 有三个分支（0/1/2），分支 0 的展开循环里有一处「上一轮值」的
 * 状态推进，最容易被改错；给三个分支各留一组固定向量，退化时自检立刻报错。
 */
function hashF13Hex(queryText, bodyText, khronos) {
  return hashF13(sm3(Buffer.from(queryText)), md5(Buffer.from(bodyText)),
    le32(khronos), khronos).toString('hex');
}

module.exports = { sign, branchOf, hashF13Hex };
