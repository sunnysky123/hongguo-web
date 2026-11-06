'use strict';
/**
 * 剧集季数解析与标题相似度工具。
 *
 * 独立成 util 模块，作为 normalizeTitle / titleScore 的唯一实现：
 *  - share-link.js 与 client.js 都要用这套比对逻辑，统一收在这里
 *    （share-link 直接 require 本模块，不再各留一份拷贝）。
 *  - 这里只放纯函数，零网络依赖，可被 selftest 离线覆盖。
 */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字（或阿拉伯数字）→ 整数；无法解析返回 NaN。 */
function cnNumToNum(v) {
  const s = String(v === null || v === undefined ? '' : v).trim();
  if (s === '') return NaN;
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let n = 0, d = 0;
  for (const ch of s) {
    if (ch === '十') { n += (d || 1) * 10; d = 0; }
    else if (ch === '百') { n += (d || 1) * 100; d = 0; }
    else d = CN_DIGITS[ch] !== undefined ? CN_DIGITS[ch] : 0;
  }
  return /[十百]/.test(s) ? n + d : Number([...s].map((c) => CN_DIGITS[c] || 0).join('') || 0);
}

/**
 * 解析剧名里的季数。
 *
 * 匹配格式（小写 + 去空格后）：
 *   - 「xxx第N季」「xxx第N部」
 *   - 「xxx（N）」「xxx(N)」
 *   - 「xxx Season N」
 *
 * @param {string} title 原始剧名
 * @returns {{ base: string, season: number, explicit: boolean }}
 *   base: 去掉季数修饰词后的基础名；无季数时 base 为整个标题，season=1，explicit=false
 */
function parseSeason(title) {
  const raw = String(title === null || title === undefined ? '' : title);
  // 归一化：NFKC + 收成单空格，保留原大小写
  const text = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  // compact：去所有空格、小写，用于匹配季数锚点
  const compact = text.toLowerCase().replace(/\s+/g, '');
  const re = /^(.*?)(?:(?:第)?([一二三四五六七八九十百零两\d]+)[季部]|[（(](?:第)?([一二三四五六七八九十百零两\d]+)[）)]|season(\d+))$/;
  const m = re.exec(compact);
  if (!m) return { base: raw, season: 1, explicit: false };
  const value = m[2] || m[3] || m[4];
  let season = cnNumToNum(value);
  // 括号里的数字可能是年份或其他元信息；只接受 1~99 作为季数
  if (m[3] && season > 99) return { base: raw, season: 1, explicit: false };
  if (!Number.isFinite(season) || season < 1 || season > 99) {
    return { base: raw, season: 1, explicit: false };
  }
  // compact 是 text 去空格小写后的结果，长度差即为空格数。
  // 从 text 里取前 baseLen 个"非空格字符"对应的原始子串，还原带空格的 base。
  const baseLen = (m[1] || '').length;
  let base = '';
  for (let i = 0; i < text.length && base.length < baseLen; i++) {
    if (text[i] !== ' ') base += text[i];
  }
  // 在原始 raw 里从开头取到 base 结束的位置（保留原始大小写与空格）
  // 简单做法：直接在 text（保留原始空格与大小写）里重新定位 base 的长度
  // 实际上 base 就是 text 去掉部分空格后的前缀，直接用 text 截断：
  // 找到 text 中第 baseLen 个非空格字符的结束位置
  let cutPos = 0;
  let cnt = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') cnt++;
    if (cnt >= baseLen) { cutPos = i + 1; break; }
  }
  const baseTrimmed = text.substring(0, cutPos).trim();
  return { base: baseTrimmed, season, explicit: true };
}

/**
 * 归一化标题用于比对：忽略空白、常见标点、全角差异与大小写。
 * share-link.js 引用本实现（不再各自维护一份）。
 */
function normalizeTitle(s) {
  return String(s === null || s === undefined ? '' : s)
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[《》「」【】\[\]（）()!！?？,，.。:：;；—_~·'"“”‘’|\-]/g, '');
}

/**
 * 标题相似度 0~100：完全相同 100；包含关系 60~88；公共前缀给 40~75。
 */
function titleScore(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 100;
  if (x.includes(y) || y.includes(x)) {
    return Math.max(60, 88 - Math.abs(x.length - y.length) * 2);
  }
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n >= 4 ? Math.min(75, 40 + n * 3) : 0;
}

/**
 * 关联剧集的搜索关键词：在剧名后追加「第」。
 *
 * 同一系列的其他季标题通常是「<剧名>第X季 / 第X部」，直接用剧名搜索会
 * 被同名正片、解说、剪辑等噪声占满前几页；「第」作为锚点能直接筛出
 * 带季数的系列条目。剧名本身以「第」结尾时不重复追加。
 *
 * @param {string} title 剧名（一般由 parseSeason 解析出的基础名）
 * @returns {string} 搜索关键词；剧名为空时返回空串
 */
function seasonKeyword(title) {
  const t = String(title === null || title === undefined ? '' : title).trim();
  if (t === '') return '';
  return t.endsWith('第') ? t : t + '第';
}

module.exports = { parseSeason, cnNumToNum, normalizeTitle, titleScore, seasonKeyword };
