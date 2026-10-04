'use strict';
/**
 * spade_a -> content key 纯离线解包
 *
 * 移植自原 Python 模块 frida/unwrap_spade.py（逆向自 libttmplayer.so FUN_001c4550，ver1 路径）。
 * 算法为纯字节变换：XOR + POPCOUNT + 位置相关，不含 KEK、不含 AES。
 *
 * 链路：video_model.encryptInfo.spadeA(base64)
 *      -> base64 解码 -> unwrapV1 -> content key（16 字节，32 位十六进制）
 *      -> 配合密文 senc 首样本 base_iv -> AES-128-CTR 解密。
 *
 * 注：ver2（spade type 为 "app_v2" / "web_v2"）走 libttmplayer FUN_00271a50
 *     （base64 + MD5(KEK) + AES-GCM-256），当前红果视频未见使用，此处不实现。
 */

/** 32 位无符号整数的二进制 1 的个数。 */
function popcount(x) {
  let v = x >>> 0;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/** 等价于 C 的 strncmp，遇到任一 NUL 终止符即视为相等（对齐原实现 _strncmp0）。 */
function strncmp0(a, b, n) {
  for (let k = 0; k < n; k++) {
    const ca = k < a.length ? a[k] : 0;
    const cb = k < b.length ? b[k] : 0;
    if (ca !== cb) return false;
    if (ca === 0) return true;
  }
  return true;
}

/**
 * unwrapV1：spade（37 字节 Buffer 或十六进制字符串）-> content key（32 位十六进制字符串）
 * @param {Buffer|string} spade 输入字节
 * @param {number} flag 播放器 option 0x97 的值（实测为 0）；非 0 时变换方向相反
 * @returns {string|null} content key，失败返回 null
 */
function unwrapV1(spade, flag = 0) {
  const buf = Buffer.isBuffer(spade) ? spade : Buffer.from(String(spade), 'hex');
  const L = buf.length;
  if (L < 3) return null;

  // bVar5 = spade[0] ^ spade[1] ^ spade[2]，其后推 type 字符串长度
  const bVar5 = buf[0] ^ buf[1] ^ buf[2];
  const iVar9 = bVar5 - 0x30;
  if (iVar9 < 1) return null;

  // 工作缓冲长度，并做越界校验
  const uVar1 = L - bVar5 + 0x2f;
  if (uVar1 < 1 || 1 + uVar1 > L) return null;

  // memcpy(dest, spade + 1, uVar1)
  const dest = Buffer.from(buf.subarray(1, 1 + uVar1));

  // 解出 type 字符串以区分 v1 / v2
  const s1 = Buffer.alloc(iVar9);
  const b16 = buf[L - iVar9 - 2];
  const b14 = buf[L - iVar9 - 1];
  for (let i = 0; i < iVar9; i++) {
    s1[i] = b14 ^ b16 ^ buf[i + (L - iVar9)];
  }
  if (strncmp0(s1, Buffer.from('app_v2'), iVar9) || strncmp0(s1, Buffer.from('web_v2'), iVar9)) {
    return null; // ver2 走 AES-GCM 路径，此处不实现
  }

  // ver1 字节变换
  let cur14 = 0x55;
  let cur16 = 0xfa;
  for (let i = 0; i < uVar1; i++) {
    const b6 = dest[i];
    const u18 = popcount(i);
    let b3 = b6;
    let b7 = cur14;
    if (i & 1) {
      b3 = cur16;
      b7 = b6;
      cur16 = cur14;
    }
    // C 的有符号 char 溢出语义在 JS 中等价于对 0xff 取模
    const cVar4 = flag ? (u18 + 0x15) : (-0x15 - u18);
    dest[i] = (cVar4 + (cur16 ^ b6)) & 0xff;
    cur14 = b7;
    cur16 = b3;
  }

  // 按 dest[0] 的十六进制字符值切出 content key
  const b0 = dest[0];
  let u11;
  if (b0 >= 0x30 && b0 <= 0x39) u11 = b0 - 0x30;
  else if (b0 >= 0x61 && b0 <= 0x7a) u11 = b0 - 0x57;
  else return null;

  const iv9 = uVar1 - (u11 & 0xff);
  if (iv9 < 2) return null;
  return dest.subarray(1, iv9).toString('latin1');
}

/** 判断解出的 key 是否为合法的 32 位十六进制字符串。 */
function isValidKey(key) {
  return typeof key === 'string' && key.length === 32 && /^[0-9a-f]{32}$/.test(key);
}

/**
 * spadeToKey：video_model 的 spadeA（base64）-> content key（32 位十六进制）
 * flag 不确定时自动两种都试。
 */
function spadeToKey(spadeAB64, flag = 0) {
  let raw;
  try {
    raw = Buffer.from(String(spadeAB64 || '').trim(), 'base64');
  } catch {
    return null;
  }
  if (!raw.length) return null;

  let key = unwrapV1(raw, flag);
  if (isValidKey(key)) return { key, flag };

  const alt = unwrapV1(raw, 1 - flag);
  if (isValidKey(alt)) return { key: alt, flag: 1 - flag };

  return { key: null, flag };
}

// 5 组运行时真值（libttmplayer FUN_001c4550 hook 抓取），用于自检
const TRUTH = [
  ['93bc1df253ba1bf7618b19c448b806f64d810afc45b715fe5eb925f26cbf12f541ba098282', '287216bfa89e662a0f748120c305e199'],
  ['a1bc2ff164b91df04dbf00f17dba00f47cbb35c27b922aec67a628eb52972fdc7ea036a7a7', 'd742b28967e4e6c92b699f4375add27f'],
  ['9cbc12fb588721cd69b739f977b70be7429c08e074990ec847843dcc738638cf76b33ebcbc', '113fb30d9767d80e3edbb905b052204f'],
  ['a3bc2df760ba2bc27b8b34c04a8907f557be19f249be35c748ba03f64fbc1ff161ba29a2a2', 'b5674a8384f25d757585dadf343274d5'],
  ['9cbc12f45aba11f76fb814f444bd15f459b225cb5e8c15dd459a0fd170ac0ad358aa108b8b', '121846f9d5829130ebc0397023feaf8c'],
];

/** 自检：用 5 组真值验证解包算法。全部通过返回 true。 */
function selfTest() {
  let ok = 0;
  for (const [sp, exp] of TRUTH) {
    const got = unwrapV1(Buffer.from(sp, 'hex'), 0);
    if (got === exp) ok++;
  }
  return { passed: ok, total: TRUTH.length, ok: ok === TRUTH.length };
}

module.exports = { popcount, unwrapV1, spadeToKey, isValidKey, selfTest, TRUTH };
