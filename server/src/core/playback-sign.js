'use strict';
/**
 * 播放专用真实签名：551 Argus + Ladon（替代此前的「4 字节时间戳占位」）。
 *
 * 背景（2026-11-11）：6.9 之前 x-argus / x-ladon 只是 be32/le32(khronos) 的
 * base64 占位，不是上游真正校验的签名。上游收紧后，播放接口对占位签名一律
 * 回 HTTP 200 + 0 字节（表现和「限流 / 熔断」一模一样），换身份、换路径、
 * 换出口都没用。
 *
 * 算法来源：jackotom/hongguo-drama 6.9 的 src/native/playback-signature.js，
 * 其上游为 N3urda/hongguoTV 7444bb01（Argus.kt）与 ch6vip/fqapp 的
 * rust/src/sign/{argus,simon,ladon,protobuf}.rs（GPL-3.0-only）。
 * 这里只保留播放接口需要的三种签名与 protobuf 编码；注册、搜索等其它签名族
 * 仍走 core/pure-sign.js，算法不动。
 *
 * 签名输入绑定「最终 query」与「实际发送的 body」：
 *   x-argus : Simon(protobuf{ aid, device_id, license, 时间, body 摘要, query 摘要 })
 *             -> xmxor -> 逆序 -> AES-128-CBC 的 base64（前缀 f281）
 *   x-ladon : md5(随机4字节 + aid) 生成 34 轮字表，对 "ts-license-aid" 分组变换
 *   协议常量（SIGN_KEY / AES_KEY / LICENSE_ID 等）取自客户端公开协议，不是账号凭据。
 */
const crypto = require('crypto');

/** 签名内固定的版权方标识（客户端协议常量）。 */
const LICENSE_ID = 1611921764n;

/** Argus 的 Simon 轮密钥源（32 字节，4 个 u64 字）。 */
const SIGN_KEY = Buffer.from(
  'fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304', 'hex');

/** Argus 最终加密的 AES-128-CBC 密钥与 IV。 */
const AES_KEY = Buffer.from('d31e3718288a1027baab59f146a09a9c', 'hex');
const AES_IV = Buffer.from('ea180a0336ed352fcd24e4d50018ae54', 'hex');

/** 帧头与帧尾（xmxor 前）。 */
const MAGIC8 = Buffer.from('f2f7fcfff2f7fcff', 'hex');
const TAIL9 = Buffer.from('eafb2cfe8568519154', 'hex');

const u64 = (value) => BigInt.asUintN(64, value);
const rol64 = (value, bits) => u64((u64(value) << BigInt(bits)) | (u64(value) >> BigInt(64 - bits)));
const ror64 = (value, bits) => rol64(value, 64 - bits);

const integer = (value) => {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new TypeError('Safe integer or BigInt required');
  return BigInt(value);
};

const le64 = (value) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(u64(value));
  return out;
};

/** protobuf varint（值按 u32 截断，负数按补码展开到 5 字节）。 */
function varint(value) {
  let n = BigInt.asUintN(32, integer(value));
  const out = [];
  while (n >= 128n) {
    out.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

/** 极简 protobuf 编码器：只需 varint / bytes / 嵌套消息。 */
class ProtoBuf {
  constructor() {
    this.parts = [];
  }

  putVarint(tag, value) {
    this.parts.push(varint(BigInt(tag) << 3n), varint(value));
    return this;
  }

  putBytes(tag, bytes) {
    const value = Buffer.from(bytes);
    this.parts.push(varint((BigInt(tag) << 3n) | 2n), varint(value.length), value);
    return this;
  }

  putUtf8(tag, value) {
    return this.putBytes(tag, Buffer.from(value, 'utf8'));
  }

  putProtobuf(tag, value) {
    return this.putBytes(tag, value.toBuf());
  }

  toBuf() {
    return Buffer.concat(this.parts);
  }
}

/** 32 字节 UUID 的 SM3（本地运行时由 Node crypto 提供）。 */
function sm3(input) {
  return crypto.createHash('sm3').update(input).digest();
}

/** PKCS#7 补齐到 16 字节整数倍（固定块长，调用方再关掉自动填充）。 */
const pad16 = (data) => Buffer.concat([data, Buffer.alloc(16 - data.length % 16, 16 - data.length % 16)]);

/** 从 query 原文取参数值（解码失败时原样返回，签名按字节算）。 */
function queryParam(query, name) {
  const decode = (value) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch (e) {
      return value;
    }
  };
  for (const part of query.split('&')) {
    const at = part.indexOf('=');
    const key = at < 0 ? part : part.slice(0, at);
    if (decode(key) === name) return decode(at < 0 ? '' : part.slice(at + 1));
  }
  return null;
}

/**
 * Simon 分组密码（4 个 u64 轮密钥字、2 个 u64 数据字，72 轮）。
 * 位运算必须全程按 u64 取模，否则 JS 的 Number 会丢精度。
 */
const Simon = {
  keyExpansion(key) {
    if (!Array.isArray(key) || key.length !== 4) throw new TypeError('Four Simon key words required');
    const expanded = key.map((value) => u64(integer(value)));
    for (let i = 4; i < 72; i += 1) {
      let tmp = ror64(expanded[i - 1], 3) ^ expanded[i - 3];
      tmp ^= ror64(tmp, 1);
      const bit = (0x3dc94c3a046d678bn >> BigInt((i - 4) % 62)) & 1n;
      expanded.push(u64(~expanded[i - 4] ^ tmp ^ bit ^ 3n));
    }
    return expanded;
  },

  encrypt(left, right, key) {
    let x = u64(integer(left));
    let y = u64(integer(right));
    for (const roundKey of Simon.keyExpansion(key)) {
      const previous = y;
      y = u64(x ^ (rol64(y, 1) & rol64(y, 8)) ^ rol64(y, 2) ^ roundKey);
      x = previous;
    }
    return [x, y];
  },
};

/** 551 Argus：protobuf 明文 -> Simon -> 异或混淆 -> 逆序 -> AES。 */
const Argus = {
  /** body 摘要取 md5(stub) 前 6 字节；无正文时是 16 个零字节的摘要。 */
  bodyHash(stubHex) {
    if (!stubHex) return sm3(Buffer.alloc(16)).subarray(0, 6);
    const bytes = /^(?:[a-f\d]{2})+$/i.test(stubHex) ? Buffer.from(stubHex, 'hex') : Buffer.alloc(0);
    return sm3(bytes).subarray(0, 6);
  },

  /** query 摘要取 sm3(query 原文) 前 6 字节。 */
  queryHash(query) {
    return sm3(query ? Buffer.from(query, 'utf8') : Buffer.alloc(16)).subarray(0, 6);
  },

  sign(query, stubHex, ts, aid, licenseId, deviceId, installId, randField) {
    if (typeof query !== 'string' || typeof stubHex !== 'string'
        || typeof deviceId !== 'string' || typeof installId !== 'string') {
      throw new TypeError('String protocol fields required');
    }
    const bean = new ProtoBuf()
      .putVarint(1, 1077940818).putVarint(2, 2).putVarint(3, randField)
      .putUtf8(4, String(integer(aid) === 0n ? 1967n : integer(aid))).putUtf8(5, deviceId)
      .putUtf8(6, String(integer(licenseId) === 0n ? LICENSE_ID : integer(licenseId)))
      .putUtf8(7, queryParam(query, 'version_name') || '').putUtf8(8, 'v04.04.05-ov-android')
      .putVarint(9, 134744640).putBytes(10, Buffer.alloc(8)).putVarint(11, 0).putVarint(12, integer(ts) << 1n)
      .putBytes(13, Argus.bodyHash(stubHex)).putBytes(14, Argus.queryHash(query))
      .putProtobuf(15, new ProtoBuf().putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xc792eccc))
      .putUtf8(16, installId).putUtf8(20, 'none').putVarint(21, 738)
      .putProtobuf(23, new ProtoBuf().putUtf8(1, 'NX551J').putVarint(2, 8196).putVarint(4, 0x80e0d800))
      .putVarint(25, 2);
    const protobuf = pad16(bean.toBuf());
    const key = Array.from({ length: 4 }, (_, i) => SIGN_KEY.readBigUInt64LE(i * 8));
    const blocks = [];
    for (let at = 0; at < protobuf.length; at += 16) {
      const encrypted = Simon.encrypt(protobuf.readBigUInt64LE(at), protobuf.readBigUInt64LE(at + 8), key);
      blocks.push(le64(encrypted[0]), le64(encrypted[1]));
    }
    const framed = Buffer.concat([MAGIC8, ...blocks, TAIL9]);
    for (let i = 8; i < framed.length; i += 1) framed[i] ^= MAGIC8[i % 8];
    const padded = pad16(Buffer.concat([framed.reverse(), Buffer.from('ao', 'ascii')]));
    const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([Buffer.from('f281', 'hex'), cipher.update(padded), cipher.final()]).toString('base64');
  },
};

/** Ladon：md5(随机 4 字节 + aid) 生成 34 轮字表，输出「随机 4 字节 + 密文」。 */
const Ladon = {
  encrypt(ts, licenseId, aid, randomBytes) {
    if (!Buffer.isBuffer(randomBytes) || randomBytes.length !== 4) {
      throw new TypeError('Four Ladon random bytes required');
    }
    const aidText = integer(aid).toString();
    const digest = crypto.createHash('md5')
      .update(Buffer.concat([randomBytes, Buffer.from(aidText)])).digest('hex');
    const ascii = Buffer.from(digest, 'ascii');
    const words = Array.from({ length: 4 }, (_, i) => ascii.readBigUInt64LE(i * 8));
    const table = [words[0]];
    const queue = words.slice(2);
    let b0 = words[0];
    let b8 = words[1];
    for (let i = 0; i < 34; i += 1) {
      let x8 = u64(ror64(b8, 8) + b0) ^ BigInt(i);
      queue.push(x8);
      x8 ^= rol64(b0, 3);
      table.push(u64(x8));
      b0 = u64(x8);
      b8 = queue.shift();
    }
    const input = pad16(Buffer.from(`${integer(ts)}-${integer(licenseId)}-${aidText}`, 'ascii'));
    const out = Buffer.alloc(input.length);
    for (let at = 0; at < input.length; at += 16) {
      let a = input.readBigUInt64LE(at);
      let b = input.readBigUInt64LE(at + 8);
      for (let i = 0; i < 34; i += 1) {
        b = table[i] ^ u64(a + ror64(b, 8));
        a = b ^ rol64(a, 3);
      }
      out.writeBigUInt64LE(u64(a), at);
      out.writeBigUInt64LE(u64(b), at + 8);
    }
    return Buffer.concat([randomBytes, out]).toString('base64');
  },
};

/**
 * 生成播放请求的签名头。
 *
 * @param {object} input
 * @param {string} input.query 最终 query 原文（不含 '?'，与发出去的字节一致）
 * @param {Buffer|null} [input.body] 实际发送的 body（POST 为 gzip 后的 Buffer）
 * @param {number|bigint} input.ts 秒级时间戳（x-khronos）
 * @param {number} [input.randField] Argus 随机字段，默认随机 4 字节
 * @param {Buffer} [input.ladonRandom] Ladon 随机 4 字节，默认随机
 * @returns {{'x-ss-req-ticket': string, 'x-khronos': string, 'x-ladon': string,
 *   'x-argus': string, 'x-ss-stub'?: string}}
 */
function signPlayer(input) {
  const { query, body = null, ts } = input;
  if (typeof query !== 'string' || (body !== null && !Buffer.isBuffer(body))) {
    throw new TypeError('Final query string and raw Buffer body required');
  }
  const aidValue = queryParam(query, 'aid');
  let aid = 1967n;
  if (/^[+-]?\d+$/.test(aidValue || '')) {
    const candidate = BigInt(aidValue);
    if (candidate >= -(1n << 63n) && candidate < 1n << 63n) aid = candidate;
  }
  const timestamp = integer(ts);
  // 摘要对「实际发送的 body」计算：有正文用 md5(body)，无正文留空（走 16 零字节）
  const stub = body && body.length ? crypto.createHash('md5').update(body).digest('hex') : '';
  const randField = input.randField === undefined
    ? crypto.randomBytes(4).readInt32LE() : input.randField;
  const ladonRandom = input.ladonRandom === undefined
    ? crypto.randomBytes(4) : input.ladonRandom;
  const headers = {
    'x-ss-req-ticket': String(timestamp * 1000n),
    'x-khronos': String(timestamp),
    'x-ladon': Ladon.encrypt(timestamp, LICENSE_ID, aid, ladonRandom),
    'x-argus': Argus.sign(query, stub, timestamp, aid, LICENSE_ID,
      queryParam(query, 'device_id') || '', '', randField),
  };
  if (stub) headers['x-ss-stub'] = stub;
  return headers;
}

module.exports = { signPlayer, Argus, Ladon, ProtoBuf, Simon };
