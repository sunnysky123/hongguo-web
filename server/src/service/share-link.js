'use strict';
/**
 * 红果 App 分享链接解析 -> 定位本站可播的剧集。
 *
 * 手机版分享文案形如：
 *   漫剧《冷宫开席：陛下又来蹭饭了第四季》 - 免费好剧，尽在红果
 *   点击链接打开👉https://novelquickapp.com/s/5em_xJT-hmg/
 *   复制本条消息后，打开「红果短剧App」后免费看全集~
 *
 * 短链 https://novelquickapp.com/s/{token}/ 会 302 到落地页
 *   /hongguo/ug/pages/video-animation-share?video_id=...&vid=...&share_toast_vid=...
 * 其中（漫剧分享）video_id 就是 series_id，vid 是分享时正在看的那一集。
 * 落地页是 React SSR，页面里带 data-fn-args 的 flight 分块含：
 *   series_data.title / series_cover / series_intro / serial_count
 *   chapter_ids / chapter_order / used_chapter_id
 *
 * 解析顺序（逐级降级，尽量不依赖单一字段）：
 *  1) 从文案里抠出链接、从《...》里抠出剧名提示；校验域名白名单（防 SSRF）。
 *  2) 手工逐跳展开 302（Http.send 默认跟随重定向但会丢掉最终 URL），
 *     每跳都重新校验域名，拿到最终 URL 与落地页 HTML。
 *  3) 从最终 URL 取 series_id / book_id / video_id / player/{id}；
 *     从 HTML 取剧名、封面、简介、集数与分集 vid 列表。
 *  4) 用 Client.getEpisodes(seriesId) 校验这个 id 确实是这部剧（标题一致），
 *     失败时保留 id 但标记 verified=false；标题对不上或压根没有 id 时，
 *     退回 Client.search(剧名) 精确匹配。
 *  5) 用 vid 在分集列表里定位分享时所在的集号。
 *
 * 纯文本解析函数（parseShareText / parseLanding 等；剧名比对 normalizeTitle /
 * titleScore 统一来自 util/season）不访问网络，供自检离线覆盖；
 * resolve 的结果按原始短链缓存 10 分钟。
 */
const { URL } = require('url');

const Http = require('../util/http');
const Json = require('../util/json');
const Log = require('../util/log');
const Safeguards = require('../core/safeguards');
const { normalizeTitle, titleScore } = require('../util/season');
const Client = require('./client');

/** 分享链允许访问的域名（含子域）。服务端会主动请求这些地址，必须白名单化。 */
const SHARE_HOSTS = [
  'novelquickapp.com',
  'hongguoduanju.com',
  'douyin.com',
  'iesdouyin.com',
  'snssdk.com',
];

/** 落地页需要移动 UA 才会输出完整的 SSR 分块。 */
const SHARE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15000;
const CACHE_TTL_SEC = 600;

/** 面向调用方的可预期失败（参数错误 / 未识别到剧集），带 HTTP 状态码。 */
class ShareLinkError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ShareLinkError';
    this.status = status;
  }
}

// ==================== 纯文本工具 ====================

/**
 * URL 允许字符集（RFC 3986 子集）。刻意不含中文/全角标点/emoji，
 * 这样「👉https://xxx/s/abc/ 复制本条消息」能干净地断在空格或中文处。
 */
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&*+,;=%]+/i;
/** 省略了 https:// 的裸链兜底。 */
const BARE_URL_RE =
  /(?:[\w-]+\.)*(?:novelquickapp\.com|hongguoduanju\.com|v\.douyin\.com)\/[A-Za-z0-9\-._~:/?#\[\]@!$&*+,;=%]+/i;

/** 去掉尾部误带入的中文/英文标点（保留 base64 padding 的 = 与路径末尾的 /）。 */
function trimUrlTail(s) {
  return String(s).replace(/[.,;:!?*）)》】」』、，。；：！？～~'"`]+$/, '').replace(/[)\]}]+$/, '');
}

/** 解码 HTML 实体；一次扫描完成，避免 &amp;quot; 被二次解码。 */
function decodeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|nbsp|apos);/gi, (whole, ent) => {
      const k = ent.toLowerCase();
      if (k === 'quot') return '"';
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'nbsp') return ' ';
      if (k === 'apos') return "'";
      try {
        if (k[0] === '#') {
          const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
          if (Number.isFinite(n) && n > 0 && n <= 0x10ffff) return String.fromCodePoint(n);
        }
      } catch (e) { /* 非法数字实体原样保留 */ }
      return whole;
    });
}

/** 取纯数字 ID；太短的串不算 id，避免把集号、channel 等误当 series_id。 */
function digits(v) {
  const m = /^(\d{6,})$/.exec(String(v === null || v === undefined ? '' : v).trim());
  return m ? m[1] : '';
}

/** 取小整数（集号等）；非法返回 0。 */
function intOf(v) {
  const n = Number.parseInt(String(v === null || v === undefined ? '' : v).trim(), 10);
  return Number.isNaN(n) || n < 0 ? 0 : n;
}

/** 去标签 + 实体解码 + 收空白。 */
function cleanText(s) {
  return decodeHtml(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 剧名是否视为同一部（相似度阈值 80）。normalizeTitle / titleScore 的实现
 * 统一收在 util/season（client.js 的关联剧集也用它），此处只定阈值。
 */
function sameTitle(a, b) {
  return titleScore(a, b) >= 80;
}

/**
 * 从粘贴的整段分享文案里提取链接与剧名提示。纯函数，不访问网络。
 *
 * @param {string} text 分享文案（可以只是一条 URL）
 * @returns {{url: string, titleHint: string}}
 */
function parseShareText(text) {
  const s = String(text === null || text === undefined ? '' : text);
  let url = '';
  const m = URL_RE.exec(s);
  if (m !== null) url = trimUrlTail(m[0]);
  if (url === '') {
    const bare = BARE_URL_RE.exec(s);
    if (bare !== null) url = 'https://' + trimUrlTail(bare[0]);
  }
  const tm = /《([^》]{1,120})》/.exec(s);
  const titleHint = tm === null ? '' : cleanText(tm[1]);
  return { url, titleHint };
}

/**
 * 域名白名单校验。返回解析后的 URL，非法返回 null。
 * 白名单之外的主机一律不发起请求，避免把本接口当任意 URL 代理。
 */
function allowedHost(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.port !== '' && u.port !== '80' && u.port !== '443') return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  for (const allow of SHARE_HOSTS) {
    if (h === allow || h.endsWith('.' + allow)) return u;
  }
  return null;
}

/** 从落地页 HTML 里找带 series_data 的 React flight 分块。 */
function pageDataFromHtml(html) {
  const text = String(html === null || html === undefined ? '' : html);
  const re = /data-fn-args="([^"]*)"/g;
  let m = re.exec(text);
  while (m !== null) {
    let v = null;
    try { v = Json.parse(decodeHtml(m[1])); } catch (e) { v = null; }
    if (Array.isArray(v) && v.length >= 3) {
      const pd = Json.optObj(v[2]);
      if (pd !== null && (Json.optObj(pd.series_data) !== null
          || Json.optArr(pd.chapter_ids).length > 0)) return pd;
    }
    m = re.exec(text);
  }
  return null;
}

/** 取 HTML 里第一个正则捕获的文本。 */
function captureText(html, re) {
  const m = re.exec(String(html === null || html === undefined ? '' : html));
  return m === null ? '' : cleanText(m[1]);
}

/** <title> 兜底剧名：多数落地页是「红果短剧 ｜ 跟我一起免费看《剧名》」。 */
function titleFromHtml(html) {
  const t = captureText(html, /<title[^>]*>([^<]*)<\/title>/i);
  if (t === '') return '';
  const q = /《([^》]{2,120})》/.exec(t);
  if (q !== null) return cleanText(q[1]);
  const c = t.replace(/^红果短剧\s*[|｜－—-]?\s*/, '')
    .replace(/^跟我一起免费看\s*/, '')
    .replace(/\s*[|｜－—-]\s*红果短剧.*$/, '').trim();
  return c === '' || c === '红果短剧' ? '' : c;
}

/**
 * 解析落地页：把 URL 参数与 SSR 数据汇总成结构化信息。纯函数。
 *
 * @param {string} finalUrl 展开短链后的最终 URL
 * @param {string} html 落地页 HTML（可为空串）
 * @param {string} titleHint 分享文案《...》里的剧名提示
 */
function parseLanding(finalUrl, html, titleHint) {
  let u;
  try { u = new URL(finalUrl); } catch (e) { u = new URL('https://novelquickapp.com/'); }
  const q = u.searchParams;
  const info = {
    seriesId: '',
    seriesIdFrom: '',
    title: '',
    cover: '',
    intro: '',
    episodeCnt: 0,
    vid: '',
    usedVid: '',
    chapterIds: [],
    chapterOrder: 0,
    pageType: q.get('page_type') || '',
    contentType: '',
  };

  // ---- 1) URL 参数：显式 series_id / book_id 优先，video_id 是漫剧分享里的 series_id ----
  for (const k of ['series_id', 'book_id']) {
    const v = digits(q.get(k));
    if (v !== '') { info.seriesId = v; info.seriesIdFrom = k; break; }
  }
  if (info.seriesId === '') {
    const v = digits(q.get('video_id'));
    if (v !== '') { info.seriesId = v; info.seriesIdFrom = 'video_id'; }
  }
  info.vid = digits(q.get('vid'));
  info.chapterOrder = intOf(q.get('chapter_order'));
  info.usedVid = digits(q.get('share_toast_vid'));
  try {
    const rp = Json.optObj(Json.parse(q.get('report_params')));
    if (rp !== null) {
      info.contentType = Json.optStr(rp.content_type, '');
      if (info.vid === '') info.vid = digits(Json.optStr(rp.content_id, ''));
    }
  } catch (e) { /* report_params 非法不影响主流程 */ }

  // ---- 2) 官网播放页 /player/{series_id} 直接链接 ----
  if (info.seriesId === '') {
    const pm = /(?:^|\/)player\/(\d{6,})(?:\/|$)/.exec(u.pathname);
    if (pm !== null) { info.seriesId = pm[1]; info.seriesIdFrom = 'player_path'; }
  }

  // ---- 3) SSR flight 分块 ----
  const pd = pageDataFromHtml(html);
  if (pd !== null) {
    const sd = Json.optObj(pd.series_data);
    if (sd !== null) {
      info.title = cleanText(Json.optStr(sd.title, ''));
      info.cover = Json.optStr(sd.series_cover, '');
      info.intro = cleanText(Json.optStr(sd.series_intro, ''));
      info.episodeCnt = Json.optInt(sd.serial_count, 0);
      if (info.seriesId === '') {
        const v = digits(Json.optStr(sd.series_id, ''));
        if (v !== '') { info.seriesId = v; info.seriesIdFrom = 'ssr'; }
      }
    }
    for (const raw of Json.optArr(pd.chapter_ids)) {
      const v = digits(raw);
      if (v !== '') info.chapterIds.push(v);
    }
    if (info.chapterOrder === 0) info.chapterOrder = Json.optInt(pd.chapter_order, 0);
    if (info.usedVid === '') info.usedVid = digits(Json.optStr(pd.used_chapter_id, ''));
  }

  // ---- 4) 标题兜底：可见标题 -> <title> -> 文案《...》 ----
  if (info.title === '') {
    info.title = captureText(html, /class="[^"]*video-info__title[^"]*"[^>]*>([^<]*)</i);
  }
  if (info.title === '') info.title = titleFromHtml(html);
  // parseShareText 已经剥过《》，这里再兜一层，便于直接用原始文案调用
  if (info.title === '') {
    info.title = cleanText(String(titleHint === null || titleHint === undefined
      ? '' : titleHint).replace(/^《|》$/g, ''));
  }
  return info;
}

// ==================== 网络 ====================

/**
 * 逐跳展开短链（每跳都校验白名单），返回最终 URL 与该页 HTML。
 * 不用 Http.send 的默认跟随重定向：那样拿不到最终 URL 里的 video_id/vid。
 */
async function expand(startUrl) {
  let current = startUrl;
  let hops = 0;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    if (allowedHost(current) === null) {
      throw new ShareLinkError(400, '分享链接跳转到了不支持的域名：' + safeHost(current));
    }
    let r;
    try {
      r = await Http.send({
        url: current,
        method: 'GET',
        followRedirect: false,
        timeoutMs: REQUEST_TIMEOUT_MS,
        headers: {
          'User-Agent': SHARE_UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      });
    } catch (e) {
      throw new ShareLinkError(502, '打开分享链接失败：' + (e && e.message ? e.message : e));
    }
    const loc = r.status >= 300 && r.status < 400 ? r.header('location') : null;
    if (loc !== null && loc !== '') {
      let next;
      try { next = new URL(loc, current).toString(); } catch (e) {
        throw new ShareLinkError(502, '分享链接返回了非法的跳转地址');
      }
      current = next;
      hops++;
      continue;
    }
    if (!r.ok()) throw new ShareLinkError(502, '分享链接返回 HTTP ' + r.status);
    return { finalUrl: current, html: r.text(), hops };
  }
  throw new ShareLinkError(502, '分享链接跳转次数过多（>' + MAX_REDIRECTS + '）');
}

function safeHost(rawUrl) {
  try { return new URL(rawUrl).hostname; } catch (e) { return '未知域名'; }
}

// ==================== 剧集匹配 ====================

/** 用 vid 在 App 分集表 / SSR chapter_ids 中定位分享时所在集号。 */
function resolveEpisode(info, episodes) {
  const total = episodes.length > 0 ? episodes.length : info.chapterIds.length;
  let index = 0;
  if (info.vid !== '') {
    for (let i = 0; i < episodes.length; i++) {
      const e = Json.optObj(episodes[i]);
      if (e !== null && digits(Json.optStr(e.vid, '')) === info.vid) { index = i + 1; break; }
    }
    if (index === 0) {
      const p = info.chapterIds.indexOf(info.vid);
      if (p >= 0) index = p + 1;
    }
  }
  // chapter_order 是落地页预览的集号，仅在链接没带 vid 时才有参考意义
  if (index === 0 && info.vid === '' && info.chapterOrder > 0) index = info.chapterOrder;
  if (index === 0 && total === 0) return null;
  const out = Json.obj();
  out.index = index;
  out.vid = info.vid;
  out.total = total;
  return out;
}

/**
 * 解析分享文案，返回可直接用于 /episodes 的结果。
 *
 * @param {string} rawText 整段分享文案或单条链接
 * @returns {Promise<object>} {ok, share_url, landing_url, series_id, title,
 *   cover, intro, episode_cnt, episode, meta, candidates, copyright,
 *   matched_by, verified, page_type, content_type, redirects, episodes_url}
 * @throws {ShareLinkError} 参数非法 / 未识别到剧集 / 分享页打不开
 * @throws {Error} 上游 API 异常（交给 Server.handle 统一转 502）
 */
async function resolve(rawText) {
  const parsed = parseShareText(rawText);
  if (parsed.url === '') {
    throw new ShareLinkError(400, '未识别到分享链接（请粘贴含 http(s) 链接的红果分享文案）');
  }
  if (allowedHost(parsed.url) === null) {
    throw new ShareLinkError(400, '不支持的分享链接域名：' + safeHost(parsed.url));
  }

  const ck = Safeguards.cacheKey('sharelink', parsed.url);
  const cached = Safeguards.cacheGet(ck);
  if (cached !== null && cached !== undefined) return Json.optObj(cached);

  const ex = await expand(parsed.url);
  const info = parseLanding(ex.finalUrl, ex.html, parsed.titleHint);
  const idFromLink = info.seriesId;

  let seriesId = idFromLink;
  let matchedBy = info.seriesIdFrom;
  let verified = false;
  let meta = null;
  let episodes = [];

  // 1) 链接里带 id：用 App 详情接口校验「这个 id 确实是这部剧」
  if (seriesId !== '') {
    try {
      const d = await Client.getEpisodes(seriesId);
      meta = Json.optObj(d && d.meta);
      episodes = Json.optArr(d && d.episodes);
      const detailTitle = meta === null ? '' : Json.optStr(meta.title, '');
      if (detailTitle !== '' && info.title !== '' && !sameTitle(detailTitle, info.title)) {
        // 有些分享类型里 video_id 是单集 id 而不是 series_id，不能硬认
        Log.warn('分享链接 ID 与剧名不符，改走标题搜索：' + seriesId
          + ' / ' + detailTitle + ' / ' + info.title);
        seriesId = '';
        meta = null;
        episodes = [];
      } else {
        verified = true;
        if (info.title === '') info.title = detailTitle;
      }
    } catch (e) {
      // 风控/网络问题不该让已经拿到的 series_id 丢失，标记未校验即可
      Log.warn('分享链接剧集详情获取失败（保留链接中的 ID）：'
        + (e && e.message ? e.message : e));
    }
  }

  // 2) 没有 id，或 id 与剧名不符：按剧名搜索，严格匹配标题
  let candidates = [];
  if (seriesId === '' && info.title !== '') {
    let items;
    try {
      items = await Client.search(info.title, 20);
    } catch (e) {
      if (idFromLink !== '') {
        Log.warn('标题搜索失败，改用链接中的 ID：' + (e && e.message ? e.message : e));
        items = [];
      } else {
        throw e;
      }
    }
    candidates = Json.optArr(items).slice(0, 5);
    let best = null;
    let bestScore = 0;
    for (const item of Json.optArr(items)) {
      const row = Json.optObj(item);
      if (row === null) continue;
      const score = titleScore(info.title, row.title);
      if (score > bestScore) { bestScore = score; best = row; }
    }
    if (best !== null && bestScore >= 60) {
      seriesId = Json.optStr(best.series_id, '');
      matchedBy = bestScore >= 100 ? 'title_exact' : 'title_fuzzy';
      verified = true;
      if (info.cover === '') info.cover = Json.optStr(best.cover, '');
      if (info.intro === '') info.intro = Json.optStr(best.abstract, '');
      if (info.episodeCnt === 0) info.episodeCnt = Json.optInt(best.episode_cnt, 0);
    }
  }

  // 3) 仍无结果但链接里有 id：返回未校验的 id，交给调用方决定是否采信
  if (seriesId === '' && idFromLink !== '') {
    seriesId = idFromLink;
    matchedBy = 'unverified';
    verified = false;
  }
  if (seriesId === '') {
    if (info.title === '') throw new ShareLinkError(404, '分享链接里未找到剧集 ID 或剧名');
    throw new ShareLinkError(404, '未在本站找到与「' + info.title + '」对应的剧集');
  }

  // 详情校验成功时用 App 元信息补全落地页缺的字段
  if (meta !== null) {
    if (info.cover === '') info.cover = Json.optStr(meta.cover, '');
    if (info.intro === '') info.intro = Json.optStr(meta.abstract, '');
    if (info.episodeCnt === 0) info.episodeCnt = Json.optInt(meta.episode_cnt, 0);
    if (info.title === '') info.title = Json.optStr(meta.title, '');
  }

  const out = Json.obj();
  out.ok = true;
  out.share_url = parsed.url;
  out.landing_url = ex.finalUrl;
  out.redirects = ex.hops;
  out.page_type = info.pageType;
  out.content_type = info.contentType;
  out.series_id = seriesId;
  out.title = info.title;
  out.cover = info.cover;
  out.intro = info.intro;
  out.episode_cnt = info.episodeCnt > 0 ? info.episodeCnt : (episodes.length || info.chapterIds.length);
  out.episode = resolveEpisode(info, episodes);
  out.meta = meta;
  out.candidates = candidates;
  // 制作方：标题搜索路径的候选结果自带 copyright；落地页 video_id 主路径
  // 没有该字段，交给前端用本机播放历史兜底，不额外发请求。
  let copyright = meta === null ? '' : Json.optStr(meta.copyright, '');
  for (const c of Json.optArr(candidates)) {
    const row = Json.optObj(c);
    if (row !== null && Json.optStr(row.series_id, '') === seriesId) {
      copyright = Json.optStr(row.copyright, '') || copyright;
      break;
    }
  }
  out.copyright = copyright;
  out.matched_by = matchedBy;
  out.verified = verified;
  out.episodes_url = '/episodes?series_id=' + encodeURIComponent(seriesId);
  Safeguards.cacheSet(ck, out, CACHE_TTL_SEC);
  return out;
}

module.exports = {
  ShareLinkError,
  resolve,
  parseShareText,
  parseLanding,
  allowedHost,
  // 剧名比对转发自 util/season：selftest 等既有调用方仍走本模块导出
  normalizeTitle,
  titleScore,
  decodeHtml,
};
