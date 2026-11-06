'use strict';
/**
 * 红果短剧 API 客户端。
 *
 * 核心语义：稳定设备身份、_rticket 时间戳、x-ss-stub MD5、列表类接口免签、
 * 剧集详情缓存、风控/登录态退避重试。
 *
 * 两处关键架构：
 *  - 签名不走任何外部服务，而是本进程内 PureSign 纯代码计算
 *    （branch==1 时抖动 _rticket 规避，实测服务端返回 code=0）；
 *  - 搜索与分集详情均以 App 签名接口为主，官网数据源（WebSource）兜底：
 *    搜索 App 无结果或请求失败时回落官网搜索页，分集详情 App 失败时
 *    回落官网分集页。
 *
 * 同步 / 异步：纯解析/组装函数保持同步；所有发网络请求的函数写成 async
 * （返回 Promise），串行等待改用 await。
 */
const crypto = require('crypto');
const Json = require('../util/json');
const Log = require('../util/log');
const Config = require('../util/config');
const Crypto = require('../util/crypto');
const Http = require('../util/http');
const Device = require('../core/device');
const Safeguards = require('../core/safeguards');
const PureSign = require('../core/pure-sign');
const WebSource = require('../service/web-source');
const SeasonUtil = require('../util/season');

// ==================== 配置装载 ====================
//
// 上游参数（api_host / base_query / session_headers）住在 config.json 的
// upstream 段（原 content-config.json，1.0.7 起合并，固定值不常改）。
// 环境变量 HONGGUO_HOST / HONGGUO_UA 仍可临时覆盖。

const HOST = Log.env('HONGGUO_HOST', Config.str('upstream.api_host', ''));

if (HOST === '' || HOST === null || HOST === undefined) {
  throw new Error(
    'config.json 缺少 upstream.api_host（上游接口参数段，见 upstream._说明）');
}

/**
 * base_query 的缓存实例：device_id 就注入在它身上，必须保持同一实例。
 */
let BASE_QUERY_CACHE = null;

/**
 * 基础 query 参数。`_` 开头的键是给用户看的注释（config.json 的
 * 文档风格），整体透传进上游 query 前必须剥掉。
 */
function baseQuery() {
  if (BASE_QUERY_CACHE === null) {
    const q = Json.optObj(Config.get('upstream.base_query'));
    const out = {};
    if (q !== null) {
      for (const k of Object.keys(q)) {
        if (!k.startsWith('_')) out[k] = q[k];
      }
    }
    BASE_QUERY_CACHE = out;
  }
  return BASE_QUERY_CACHE;
}

function sessionHeaders() {
  const h = Json.optObj(Config.get('upstream.session_headers'));
  const out = {};
  if (h !== null) {
    for (const k of Object.keys(h)) {
      // 同 baseQuery：注释键不进请求头
      if (k.startsWith('_')) continue;
      const v = h[k];
      if (v !== null && v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

const BASE_QUERY = baseQuery();
const IDENTITY = Device.ensureDeviceId(BASE_QUERY);

/** 桌面托管模式标志：存在则禁止刷新登录态、禁止降级容错。 */
const MANAGED = Log.env('HONGGUO_SESSION_API_KEY', null) !== null;

/** 仅 landpage/cell 系列列表接口免签（原 SIGN_LIST 语义）。 */
const SIGN_LIST = ['1', 'true', 'yes', 'on'].includes(
  Log.env('HG_SIGN_LIST', '').toLowerCase(),
);

const _sessionHeaders = sessionHeaders();
const USER_AGENT = Log.env('HONGGUO_UA',
  Object.prototype.hasOwnProperty.call(_sessionHeaders, 'user-agent')
    ? _sessionHeaders['user-agent'] : 'hongguo-web/1.0');

function identity() { return IDENTITY; }

// ==================== 榜单 / 体裁常量 ====================

const RANK_BOARDS = {};
const RANK_NAMES = {};
RANK_BOARDS.recommend = 'comic_series_hot_rank';
RANK_BOARDS.hot = 'comic_series_hot_play';
RANK_BOARDS.new = 'comic_series_new_rank';
RANK_NAMES.recommend = '漫剧推荐榜';
RANK_NAMES.hot = '漫剧热播榜';
RANK_NAMES.new = '漫剧新剧榜';

const COMIC_RANK_CELL = '7470092475068071998';

/** genre -> [req_scene, genre] */
const GENRES = {};
const GENRE_NAMES = {};
GENRES.short_play = ['default', 'short_play'];
GENRES.comic_series = ['comic_series', 'comic_series'];
GENRES.ai_series = ['ai_series', 'ai_series'];
GENRE_NAMES.short_play = '短剧';
GENRE_NAMES.comic_series = '漫剧';
GENRE_NAMES.ai_series = 'AI短剧';

// 主题 / 设定 / 背景 共用 cate_ 命名空间
const FILTER_CATE = {};
const FILTER_SORT = {};
const FILTER_GENDER = {};
const FILTER_DAYS = {};
const FILTER_STATUS = {};
{
  const cate = [
    ['脑洞', 'cate_755'], ['奇幻', 'cate_6'], ['剧情', 'cate_316'], ['玄幻', 'cate_7'],
    ['末世', 'cate_68'], ['豪门', 'cate_936'], ['科幻', 'cate_1092'], ['冒险', 'cate_1182'],
    ['重生', 'cate_36'], ['穿越', 'cate_37'], ['逆袭', 'cate_739'], ['异能', 'cate_598'],
    ['系统', 'cate_19'], ['反转', 'cate_756'], ['娱乐圈', 'cate_43'], ['总裁', 'cate_29'],
    ['架空', 'cate_452'], ['都市', 'cate_1'], ['古代', 'cate_758'], ['异界', 'cate_599'],
    ['校园', 'cate_4'], ['职场', 'cate_127'], ['年代', 'cate_79'], ['乡村', 'cate_11'],
    ['民国', 'cate_390'],
  ];
  for (const c of cate) FILTER_CATE[c[0]] = c[1];

  FILTER_SORT['最新上架'] = 'online_time';
  FILTER_SORT['最新'] = 'online_time';
  FILTER_SORT['最高热度'] = 'hot_score';
  FILTER_SORT['热度'] = 'hot_score';
  FILTER_SORT['hot'] = 'hot_score';
  FILTER_SORT['最高收藏'] = 'hot_collect';
  FILTER_SORT['收藏'] = 'hot_collect';

  FILTER_GENDER['男频'] = '1';
  FILTER_GENDER['男'] = '1';
  FILTER_GENDER['女频'] = '0';
  FILTER_GENDER['女'] = '0';

  FILTER_DAYS['7'] = 'days_7';
  FILTER_DAYS['14'] = 'days_14';
  FILTER_DAYS['30'] = 'days_30';
  FILTER_DAYS['90'] = 'days_90';
  FILTER_DAYS['7天内上新'] = 'days_7';
  FILTER_DAYS['14天内上新'] = 'days_14';
  FILTER_DAYS['30天内上新'] = 'days_30';
  FILTER_DAYS['90天内上新'] = 'days_90';

  FILTER_STATUS['已完结'] = 'creation_status_0';
  FILTER_STATUS['完结'] = 'creation_status_0';
  FILTER_STATUS['连载中'] = 'creation_status_1';
  FILTER_STATUS['连载'] = 'creation_status_1';
}

// ==================== 请求组装 ====================

/** 组装完整 URL（含 base_query、设备身份、_rticket）。 */
function buildUrl(pathname, extra, rticket) {
  if (rticket === undefined || rticket === null) rticket = Date.now();
  const q = Object.assign({}, BASE_QUERY);
  if (extra !== null && extra !== undefined) Object.assign(q, extra);
  q._rticket = String(rticket);

  const parts = [];
  for (const [k, v] of Object.entries(q)) {
    parts.push(k + '=' + encodeURIComponent(String(v)));
  }
  return 'https://' + HOST + pathname + '?' + parts.join('&');
}

/** 构造基础请求头与请求体。 */
function buildHeaders(body) {
  const headers = Object.assign({}, sessionHeaders());
  if (!Object.prototype.hasOwnProperty.call(headers, 'user-agent')) {
    headers['user-agent'] = USER_AGENT;
  }
  headers['content-type'] = 'application/json; charset=utf-8';

  let data = null;
  if (body !== null && body !== undefined) {
    data = Buffer.from(Json.stringify(body));
    headers['x-ss-stub'] = Crypto.md5HexUpper(data);
    headers['Content-Length'] = String(data.length);
  } else {
    delete headers['Content-Length'];
  }
  return { headers, data };
}

/** 单次 API 调用（不含重试）。 */
async function apiOnce(method, pathname, body, extraQuery, signed) {
  let url = buildUrl(pathname, extraQuery);
  const built = buildHeaders(body);
  const headers = built.headers;
  const data = built.data;

  if (signed) {
    // 本地纯代码签名（PureSign，算法源自 jackotom/hongguo-drama）。
    // 注意 branch==1 的签名变体服务端不认（实测 110001），
    // 需抖动 _rticket 换一个 query 重签，最多 32 次。
    const khronos = Math.floor(Date.now() / 1000);
    let rticket = Date.now();
    let guard = 0;
    while (PureSign.branchOf(url, data, khronos) === 1 && guard++ < 32) {
      rticket += 1;
      url = buildUrl(pathname, extraQuery, rticket);
    }
    if (guard >= 32) {
      Log.warn('签名分支抖动 32 次未避开 branch==1，按当前 URL 签名（可能被服务端拒绝）');
    }
    Object.assign(headers, PureSign.sign(url, data, khronos));
  }
  delete headers['accept-encoding'];
  await Safeguards.throttle().wait();

  const req = {
    url,
    method,
    headers,
    body: data,
    timeoutMs: 30000,
  };
  const res = await Http.send(req);
  const text = res.text();
  let j;
  try {
    j = Json.parseObject(text);
  } catch (e) {
    const err = new Safeguards.UpstreamResponseError('上游未返回 JSON');
    const diag = Json.obj();
    diag.http_status = res.status;
    diag.body_bytes = Buffer.byteLength(text);
    err.diagnostic = diag;
    throw err;
  }
  Safeguards.checkResponse(j);
  return j;
}

/** 带重试退避 + 登录态刷新的 API 调用。 */
async function api(method, pathname, body, extraQuery, maxRetries, signed) {
  let last = null;
  let attempts = maxRetries;
  let deviceIdRetryUsed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const requestDeviceId = IDENTITY.deviceId;
    try {
      return await apiOnce(method, pathname, body, extraQuery, signed);
    } catch (e) {
      if (e instanceof Safeguards.AuthExpiredError
          || e instanceof Safeguards.RiskControlError) {
        if (e instanceof Safeguards.RiskControlError
            && e.safeResponse !== null && e.safeResponse.device_id_rejected
            && !deviceIdRetryUsed) {
          const nextId = Device.rotateDeviceId(BASE_QUERY, IDENTITY, requestDeviceId);
          if (nextId !== null && nextId !== requestDeviceId) {
            deviceIdRetryUsed = true;
            attempts++;
            Log.warn('上游拒绝当前 device_id，已更新本地身份并重试一次');
            continue;
          }
        }
        if (MANAGED) throw e; // 托管模式不自动重试失效的登录态
        last = e;
        if (e instanceof Safeguards.AuthExpiredError) {
          Log.info('登录态失效，稍候重试 (' + pathname + ')');
          await Safeguards.sleep(1000);
        } else {
          const wait = Math.pow(2, attempt) + 1;
          Log.info('风控/异常，退避 ' + wait + 's 重试 (' + pathname + '): ' + e.message);
          await Safeguards.sleep(wait * 1000);
        }
      } else if (e instanceof Safeguards.UpstreamResponseError) {
        if (MANAGED) throw e;
        last = e;
        await Safeguards.sleep(1500 * (attempt + 1));
      } else {
        throw e;
      }
    }
  }
  if (last !== null) throw last;
  throw new Error('api 失败');
}

// ==================== 数据解析 ====================

/** 从 category_schema 字符串中解析分类名（源数据为 JSON 字符串）。 */
function parseCategories(schema) {
  const out = [];
  if (schema === null || schema === undefined) return out;
  const s = String(schema);
  const rx = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = rx.exec(s)) !== null) {
    if (m[1] !== '' && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 提取封面角标文本（爆剧/新剧/独播…）。 */
function coverTags(d) {
  const out = [];
  const m = Json.optObj(d);
  if (m === null) return out;
  for (const t of Json.optArr(m.cover_tag_info_list)) {
    const tm = Json.optObj(t);
    if (tm !== null) {
      const v = firstNonNull(tm, 'text', 'content', 'name', 'tag_text', 'title');
      if (v !== null) out.push(String(v).replace(/<[^>]+>/g, ''));
    } else if (typeof t === 'string' && t !== '') {
      out.push(t);
    }
  }
  return out;
}

function firstNonNull(m, ...keys) {
  for (const k of keys) {
    const v = m[k];
    if (v !== null && v !== undefined && String(v) !== '') return v;
  }
  return null;
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function str(m, k) {
  return m === null || m === undefined ? '' : Json.optStr(m[k], '');
}

function num(m, k) {
  return m === null || m === undefined ? 0 : Json.optLong(m[k], 0);
}

/** 剥 HTML 标签并截断。 */
function strip(s, max) {
  const t = (s === null || s === undefined) ? '' : String(s).replace(/<[^>]+>/g, '');
  return t.length > max ? t.substring(0, max) : t;
}

/** 从搜索 cell 解析短剧条目；非短剧（无集数）或无 id 返回 null。 */
function parseSearchCell(cellObj) {
  const cell = Json.optObj(cellObj);
  if (cell === null) return null;
  let sid = cell.book_id;
  if (sid === null || sid === undefined) sid = cell.search_result_id;
  if (sid === null || sid === undefined) return null;
  let vd = Json.optObj(cell.video_detail);
  if (vd === null) vd = Json.obj();

  let vdataObj = cell.video_data;
  if (Array.isArray(vdataObj) && vdataObj.length > 0) vdataObj = vdataObj[0];
  let vdata = Json.optObj(vdataObj);
  if (vdata === null) vdata = Json.obj();
  let inner = Json.optObj(vdata.video_detail);
  if (inner === null) inner = Json.obj();

  let ep = num(vd, 'episode_cnt');
  if (ep === 0) ep = num(vdata, 'episode_cnt');
  if (ep === 0) ep = num(inner, 'episode_cnt');
  if (ep === 0) return null; // 只要短剧（有集数的）

  const hl = Json.optObj(cell.search_high_light);
  let hlText = '';
  if (hl !== null) {
    const t = Json.optObj(hl.title);
    if (t !== null) hlText = str(t, 'text');
  }
  let title = hlText;
  if (title === '') title = str(vd, 'series_title');
  if (title === '') title = str(vdata, 'title');
  if (title === '') title = str(inner, 'series_title');

  const out = Json.obj();
  out.series_id = String(sid);
  out.title = strip(title, 9999);
  out.episode_cnt = ep;
  out.score = hasOwn(vdata, 'score') ? vdata.score
    : (hasOwn(inner, 'score') ? inner.score : '');
  out.play_cnt = hasOwn(vdata, 'play_cnt') ? vdata.play_cnt
    : Json.optLong(inner.series_play_cnt, 0);
  out.hot = str(vdata, 'rec_text');
  out.copyright = str(vdata, 'copyright');
  let cover = str(vdata, 'cover');
  if (cover === '') cover = str(inner, 'series_cover');
  out.cover = cover;
  out.tags = coverTags(vdata);
  const intro = str(inner, 'series_intro') !== '' ? str(inner, 'series_intro')
    : str(vd, 'series_intro');
  out.abstract = strip(intro, 60);
  out.vid = str(vdata, 'vid');
  out.duration = num(vdata, 'duration');
  out.horiz_cover = str(vdata, 'horiz_cover');
  return out;
}

/** 官网搜索结果转为与 parseSearchCell 相同的条目结构（未知字段留空）。 */
function webSearchItems(web) {
  const out = [];
  for (const w of web) {
    const row = Json.obj();
    row.series_id = Json.optStr(w.series_id, '');
    row.title = Json.optStr(w.series_title, '');
    row.episode_cnt = Json.optLong(w.episode_cnt, 0);
    row.score = '';
    row.play_cnt = 0;
    row.hot = '';
    row.copyright = '';
    row.cover = Json.optStr(w.cover, '');
    row.tags = [];
    row.abstract = strip(Json.optStr(w.series_intro, ''), 60);
    row.vid = '';
    row.duration = 0;
    row.horiz_cover = '';
    out.push(row);
  }
  return out;
}

/**
 * 官网分集结果转为与 parseEpisodeDetail 相同的结构。
 *
 * 官网没有演员表，但分集页内嵌 JSON 里有简介、标签与连载状态，这里透传；
 * 其余数值字段（播放量、追剧数）官网不提供，保留 0。
 * meta.degraded 标记来源为官网降级数据，调用方据此用短 TTL 缓存。
 */
function webEpisodesToDetail(web) {
  const sid = Json.optStr(web.series_id, '');
  const eps = [];
  for (const eObj of Json.optArr(web.episodes)) {
    const e = Json.optObj(eObj);
    if (e === null) continue;
    const vid = Json.optStr(e.vid, '');
    const row = Json.obj();
    row.index = Json.optLong(e.vid_index, 0);
    row.vid = vid;
    row.title = Json.optStr(e.title, '');
    row.duration = 0;
    row.cover = Json.optStr(e.cover, '');
    row.comment_count = 0;
    row.digged_count = 0;
    // 官网侧标注：该集是否落在网页版限免集数内（仅作展示，
    // 播放取址已统一走 AppSource，不再据此探测官网直链）
    row.web_available = e.web_available;
    eps.push(row);
  }
  const meta = Json.obj();
  meta.series_id = sid;
  const title = Json.optStr(web.series_title, '');
  meta.title = title === '' ? sid : title;
  meta.abstract = Json.optStr(web.series_intro, '');
  // 官网分集页 SSR 没有制作方字段，留空串以保持 meta 形状一致
  meta.copyright = Json.optStr(web.copyright, '');
  meta.episode_cnt = Json.optLong(web.total, eps.length);
  const st = web.series_status;
  meta.status = (st === 1 || st === '1') ? '完结' : ((st === 0 || st === '0') ? '连载中' : '');
  meta.play_cnt = 0;
  meta.followed_cnt = 0;
  meta.create_time = 0;
  meta.cover = Json.optStr(web.cover, '');
  const tags = [];
  for (const tObj of Json.optArr(web.tags)) {
    const t = Json.optStr(tObj, '');
    if (t !== '') tags.push(t);
  }
  meta.category = tags;
  meta.tags = [];
  meta.celebrities = [];
  meta.degraded = true;
  const out = Json.obj();
  out.meta = meta;
  out.episodes = eps;
  return out;
}

/** 剧集详情请求体（image_shrink 为抓包中的固定值）。 */
const IMAGE_SHRINK = 'W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d';

function episodesBody(seriesId) {
  const biz = Json.obj();
  biz.detail_page_version = 0;
  biz.disable_digg_stat = false;
  biz.image_shrink_datas_str = IMAGE_SHRINK;
  biz.need_all_video_definition = false;
  biz.need_mp4_align = false;
  biz.screen_width_px = '900';
  biz.source = 7;
  biz.use_os_player = false;
  biz.use_server_dns = false;

  const out = Json.obj();
  out.biz_param = biz;
  out.dr_scene = 'preload';
  out.series_id = String(seriesId);
  return out;
}

/**
 * 解析剧集详情。
 *
 * 注意 title 字段：上游 video_list[].title 里装的其实是「本剧简介」，
 * 每一集都重复同一段文字。这里与 series_intro 比对，命中则视为无效标题。
 */
function parseEpisodeDetail(sid, vd) {
  if (vd === null || vd === undefined) vd = Json.obj();
  const intro = str(vd, 'series_intro').trim();
  const eps = [];

  for (const eObj of Json.optArr(vd.video_list)) {
    const e = Json.optObj(eObj);
    if (e === null) continue;
    let title = str(e, 'title').trim();
    if (title !== '' && intro !== ''
        && (title === intro || intro.includes(title))) {
      title = '';
    }
    const row = Json.obj();
    row.index = num(e, 'vid_index');
    const v = e.vid;
    row.vid = v === null || v === undefined ? '' : String(v);
    row.title = title.length > 30 ? title.substring(0, 30) : title;
    row.duration = num(e, 'duration');
    let cover = str(e, 'episode_cover');
    if (cover === '') cover = str(e, 'cover');
    row.cover = cover;
    row.comment_count = num(e, 'comment_count');
    row.digged_count = num(e, 'digged_count');
    eps.push(row);
  }

  eps.sort((a, b) => Json.optLong(a.index, 0) - Json.optLong(b.index, 0));

  let firstEpCover = '';
  for (const o of eps) {
    if (o !== null && str(o, 'cover') !== '') {
      firstEpCover = str(o, 'cover');
      break;
    }
  }

  const celebs = [];
  for (const cObj of Json.optArr(vd.celebrities)) {
    const c = Json.optObj(cObj);
    if (c === null) continue;
    const cm = Json.obj();
    cm['演员'] = str(c, 'nickname');
    cm['角色'] = str(c, 'role_name');
    cm['头像'] = str(c, 'avatar');
    cm['简介'] = strip(str(c, 'intro'), 80);
    celebs.push(cm);
  }

  const meta = Json.obj();
  meta.series_id = String(sid);
  const title = str(vd, 'series_title');
  meta.title = title === '' ? String(sid) : title;
  meta.abstract = str(vd, 'series_intro');
  // 制作方：上游列表接口的 Copyright 字段。详情接口通常不返回，
  // 播放器主要由列表数据带入（见 web/app.js 的 openSeries），这里仅作透传兜底。
  meta.copyright = str(vd, 'copyright');
  const epCnt = num(vd, 'episode_cnt');
  meta.episode_cnt = epCnt !== 0 ? epCnt : eps.length;
  meta.status = Json.optLong(vd.series_status, 0) === 1 ? '完结' : '连载中';
  meta.play_cnt = num(vd, 'series_play_cnt');
  meta.followed_cnt = num(vd, 'followed_cnt');
  meta.create_time = num(vd, 'create_time');
  const cover = str(vd, 'series_cover');
  meta.cover = cover === '' ? firstEpCover : cover;
  meta.category = parseCategories(vd.category_schema);
  meta.tags = coverTags(vd);
  meta.celebrities = celebs;

  const out = Json.obj();
  out.meta = meta;
  out.episodes = eps;
  return out;
}

// ==================== 业务接口 ====================

/**
 * 搜索短剧。按综合 tab 分页循环翻页，
 * 直到 has_more=false 或达到 max_items / 12 页安全上限。
 */
async function search(query, maxItemsArg) {
  return (await searchPage(query, maxItemsArg, 0)).items;
}

/**
 * App 签名搜索的一页（/reading/bookapi/search/tab/v 综合 tab）。
 *
 * search 接口的 passback/search_id/offset 是上游游标，跨页必须原样回传，
 * 否则每次都从第 1 页重查。
 *
 * skip 的语义是"调用方已展示的条数"：上游不支持直接跳到第 N 条，
 * 只能从头抓够 skip + limit 条再丢掉前 skip 条。因此续页代价随页码增长，
 * 但结果正确 —— 早先的实现完全忽略 skip、每次都返回同一批前 limit 条，
 * 前端按 id 去重后得到空列表，于是误报"没有更多了"。
 *
 * 上游无结果时返回空页；请求彻底失败（风控 / 网络 / 签名被拒）时抛错，
 * 由调用方决定兜底。
 */
async function appSearchPage(query, limit, skipN) {
  // 游标状态可复用：同一关键词的续页从头重抓上游，靠这里的缓存兜住重复请求
  const ck = Safeguards.cacheKey('searchp', query, limit, skipN);
  const cached = Safeguards.cacheGet(ck);
  if (Array.isArray(cached)) {
    if (cached.length === 3 && Array.isArray(cached[0])) {
      return new Page(cached[0], cached[1] === true,
        Json.optInt(cached[2], skipN));
    }
  }

  const results = [];
  const seen = new Set();
  let offset = 0;
  let passback = '';
  let searchId = '';
  let hasMore = false;

  // 续页要跳过前 skipN 条，只能从头多抓。为免每点一次「加载更多」就
  // 把上游从头翻一遍，这里把已累积的结果与上游游标按关键词缓存起来，
  // 后续续页从上次位置接着抓。缓存仅 10 分钟，避免结果集明显变化后仍给旧数据。
  const ckAll = Safeguards.cacheKey('searchacc', query);
  const cachedAcc = Safeguards.cacheGet(ckAll);
  if (Array.isArray(cachedAcc)) {
    if (cachedAcc.length === 6) {
      for (const x of (Array.isArray(cachedAcc[0]) ? cachedAcc[0] : [])) results.push(x);
      for (const o of (Array.isArray(cachedAcc[1]) ? cachedAcc[1] : [])) seen.add(String(o));
      offset = Json.optInt(cachedAcc[2], 0);
      passback = Json.optStr(cachedAcc[3], '');
      searchId = Json.optStr(cachedAcc[4], '');
      hasMore = cachedAcc[5] === true;
    }
  }

  // 连续翻上游直到攒够要交付的那一页（skip 之后的 limit 条）
  const want = skipN + limit;
  // 上游每页 count=10 且要过滤掉无集数的条目，多留些轮次以免深翻页时凑不满
  for (let page = 0; page < 60; page++) {
    // 注意：hasMore 初值为 false，不能在首轮就用它判断退出，
    // 否则第一页都抓不到（搜索恒返回 0 条）。首次无条件抓一轮。
    if (results.length >= want) break;
    if (page > 0 && !hasMore) break;
    const q = Json.obj();
    q.query = query;
    q.tab_name = 'feed';
    q.search_source = '1';
    q.offset = String(offset);
    q.count = '10';
    q.use_correct = 'true';
    if (passback !== '') q.passback = passback;
    if (searchId !== '') q.search_id = searchId;

    let j;
    try {
      j = await api('GET', '/reading/bookapi/search/tab/v', null, q, 1, true);
    } catch (e) {
      // 翻页中途失败：保留已累积的部分，交由调用方判断 has_more，
      // 不能把整个请求判死，否则续页永远无结果
      if (results.length === 0) throw e;
      break;
    }
    const tabs = Json.optArr(j.search_tabs);
    if (tabs.length === 0) { hasMore = false; break; }
    const tab = Json.optObj(tabs[0]);
    if (tab === null) { hasMore = false; break; }
    const data = Json.optArr(tab.data);
    for (const cell of data) {
      const item = parseSearchCell(cell);
      if (item === null) continue;
      const isid = str(item, 'series_id');
      if (seen.has(isid)) continue;
      seen.add(isid);
      results.push(item);
    }
    // 游标先落定，供下一页使用
    const adv = (tab.next_offset !== null && tab.next_offset !== undefined)
      ? Json.optInt(tab.next_offset, offset + data.length)
      : offset + data.length;
    const pb = str(tab, 'passback');
    if (pb !== '') passback = pb;
    const sid = str(tab, 'search_id');
    if (sid !== '') searchId = sid;
    hasMore = Json.optBool(tab.has_more, false) && data.length > 0;
    if (adv <= offset) hasMore = false;   // 游标原地不动 => 无后续
    offset = adv;
  }

  Safeguards.cacheSet(ckAll, [
    results.slice(), Array.from(seen), offset, passback, searchId, hasMore], 600);

  // 丢掉前 skipN 条，只交付之后的那一页（切片逻辑见 Page.slice）
  const page = Page.slice(results, skipN, limit, hasMore);
  Safeguards.cacheSet(ck, [page.items, page.hasMore, page.nextSkip], 600);
  return page;
}

/**
 * 搜索的一页（供「加载更多」续页）。
 *
 * 数据源优先级：App 签名搜索（字段全、有分页游标）-> 官网搜索页
 * （_ROUTER_DATA.searchList，服务端渲染、免签，一次返回全部命中、
 * 无后续页）。App 无结果或请求失败时回落官网；官网也无结果时，若 App
 * 是异常失败则把该异常抛给调用方，否则返回空页。
 */
async function searchPage(query, maxItemsArg, skip) {
  const limit = Math.max(1, Math.min(
    maxItemsArg > 0 ? maxItemsArg : Log.envInt('HG_SEARCH_MAX_ITEMS', 20), 40));
  const skipN = Math.max(0, skip);

  // ---- App 签名搜索优先 ----
  let appError = null;
  try {
    const appPage = await appSearchPage(query, limit, skipN);
    if (appPage.items.length > 0) return appPage;
  } catch (e) {
    appError = e;
    Log.warn('App 搜索失败，回落官网搜索 (' + query + ')：' + e.message);
  }

  // ---- 官网搜索兜底 ----
  const ckWeb = Safeguards.cacheKey('websearch', query);
  let webItems = null;
  const cachedWeb = Safeguards.cacheGet(ckWeb);
  if (Array.isArray(cachedWeb)) webItems = cachedWeb;
  if (webItems === null) {
    const web = await WebSource.search(query);
    if (web.length > 0) {
      webItems = webSearchItems(web);
      Safeguards.cacheSet(ckWeb, webItems, 600);
    }
  }
  if (webItems !== null && webItems.length > 0) {
    // 官网一次返回全部命中（约 10 条），没有后续页
    return Page.slice(webItems, skipN, limit, false);
  }

  // 两边都无结果：App 是异常失败就把异常抛给调用方，否则返回空页
  if (appError !== null) throw appError;
  return Page.slice([], skipN, limit, false);
}

/**
 * App 详情接口「空 data」时的额外重试次数与间隔。
 *
 * 上游 preload/v1 对约 1/3 的请求返回 HTTP 200 + 空 data（风控软拦截，
 * 与签名无关、也不区分剧）。api() 的重试只处理抛异常的情况，空 data 走不到，
 * 所以在这里补一层：宁可多等 0.8 秒，也别直接回落成「无简介」的官网数据。
 */
const APP_DETAIL_RETRIES = 2;
const APP_DETAIL_RETRY_DELAY_MS = 400;

/** 正常详情缓存 6 小时；官网降级数据只存 10 分钟，便于尽快重试 App 链路。 */
const EPISODE_CACHE_TTL_SEC = 21600;
const EPISODE_DEGRADED_TTL_SEC = 600;

/** 取 App 详情；空 data 时重试，成功返回解析结果，全部落空才抛错。 */
async function fetchAppEpisodes(sid) {
  let last = null;
  for (let attempt = 0; attempt <= APP_DETAIL_RETRIES; attempt++) {
    if (attempt > 0) await Safeguards.sleep(APP_DETAIL_RETRY_DELAY_MS);
    const j = await api('POST', '/novel/player/multi_video_detail/preload/v1',
      episodesBody(sid), null, 3, true);
    const data = Json.optObj(j.data);
    const entry = data === null ? null : Json.optObj(data[sid]);
    const vd = entry === null ? null : Json.optObj(entry.video_data);
    const result = parseEpisodeDetail(sid, vd);
    if (result.episodes.length > 0) return result;
    last = new Error('App 未返回剧集列表（空 data，疑似风控）');
  }
  throw last;
}

/** 取单剧元信息 + 剧集列表（缓存 6 小时）。App 详情失败时回落官网分集页。 */
async function getEpisodes(seriesId) {
  const sid = String(seriesId);
  const ck = Safeguards.cacheKey('episodes', sid);
  const cached = Safeguards.cacheGet(ck);
  if (cached !== null) return Json.optObj(cached);

  try {
    const result = await fetchAppEpisodes(sid);
    Safeguards.cacheSet(ck, result, EPISODE_CACHE_TTL_SEC);
    return result;
  } catch (e) {
    // App 详情失败（风控 / 网络 / 签名被拒）时回落官网分集页：
    // 官网只有分集列表，富信息（演员、播放量）缺失，但至少分集可见。
    // App 失败回落官网是常态（风控空响应等），此处不输出日志避免刷屏；
    // 仅当官网链路同样失败、确实无法获取剧集信息时，才在下方汇总输出一行
    // （合并 App 侧与官网侧两个原因，不再分别打印）。
    let web = null;
    let webErr = '';
    try {
      web = await WebSource.episodes(sid);
    } catch (e2) {
      webErr = e2 && e2.message ? e2.message : String(e2);
    }
    if (web !== null && web !== undefined) {
      const result = webEpisodesToDetail(web);
      // 降级数据只短存：给 App 链路一个尽快重试的机会，避免一次瞬时
      // 空响应把「无简介」锁死 6 小时。
      Safeguards.cacheSet(ck, result, EPISODE_DEGRADED_TTL_SEC);
      return result;
    }
    Log.warn('App 与官网分集链路均失败，无法获取剧集信息 (' + sid + ')：'
      + 'App - ' + e.message + '；官网 - '
      + (webErr !== '' ? webErr : '未解析到分集数据'));
    throw e;
  }
}

/** 批量取剧集元数据。 */
async function getEpisodesBatch(seriesIds, batchSizeArg) {
  const ids = [];
  const seen = new Set();
  for (const s of seriesIds) {
    const sid = s === null || s === undefined ? '' : String(s).trim();
    if (sid !== '' && !seen.has(sid)) { seen.add(sid); ids.push(sid); }
  }
  const bs = Math.max(1, Math.min(batchSizeArg > 0 ? batchSizeArg : 20, 20));
  const out = Json.obj();
  const failed = [];
  const todo = [];

  for (const sid of ids) {
    const c = Safeguards.cacheGet(Safeguards.cacheKey('episodes', sid));
    if (c !== null) {
      out[sid] = Json.optObj(c).meta;
    } else {
      todo.push(sid);
    }
  }

  // 批量接口同样会被风控软拦截（HTTP 200 + 缺该 sid 的 video_data）。
  // 空结果的 sid 进入下一轮重试，而不是直接记 failed —— 否则卡片列表里
  // 这部剧的简介/标签会一直空着。
  let pending = todo;
  for (let round = 0; round <= APP_DETAIL_RETRIES && pending.length > 0; round++) {
    if (round > 0) await Safeguards.sleep(APP_DETAIL_RETRY_DELAY_MS);
    const next = [];
    for (let i = 0; i < pending.length; i += bs) {
      const batch = pending.slice(i, Math.min(i + bs, pending.length));
      let j = null;
      try {
        j = await api('POST', '/novel/player/multi_video_detail/preload/v1',
          episodesBody(batch.join(',')), null, 3, true);
      } catch (e) {
        for (const sid of batch) {
          const f = Json.obj();
          f.series_id = sid;
          f.error = String(e && e.message !== undefined ? e.message : e);
          failed.push(f);
        }
        continue;
      }
      const data = Json.optObj(j.data);
      for (const sid of batch) {
        const entry = data === null ? null : Json.optObj(data[sid]);
        const vd = entry === null ? null : Json.optObj(entry.video_data);
        if (vd === null || Object.keys(vd).length === 0) {
          next.push(sid);
          continue;
        }
        const parsed = parseEpisodeDetail(sid, vd);
        Safeguards.cacheSet(Safeguards.cacheKey('episodes', sid), parsed, EPISODE_CACHE_TTL_SEC);
        out[sid] = parsed.meta;
      }
    }
    pending = next;
  }
  for (const sid of pending) {
    const f = Json.obj();
    f.series_id = sid;
    f.error = 'empty detail';
    failed.push(f);
  }
  return [out, failed];
}

/** 取漫剧榜单。board: recommend / hot / new。 */
async function rank(board, limit) {
  const p = await rankPage(board, limit, 0);
  return p.items;
}

/**
 * 榜单分页结果（供前端无限滚动）。
 *
 * @param items 本页条目
 * @param hasMore 上游是否还有后续页
 * @param nextOffset 下一页应使用的偏移量
 */
class RankPage {
  constructor(items, hasMore, nextOffset) {
    this.items = items;
    this.hasMore = hasMore;
    this.nextOffset = nextOffset;
  }
}

/**
 * 取漫剧榜单的一页。
 *
 * offset 为 0 时行为与从前一致（从头累积抓够 limit 条）；offset>0 时只抓
 * 本页，不会从头重复遍历 —— 无限滚动必须走这条路径，否则每次触底都会把
 * 前面的页重跑一遍。
 */
async function rankPage(board, limit, offsetArg) {
  const limit1 = Math.max(1, Math.min(limit <= 0 ? 30 : limit, 100));
  const offset = Math.max(0, offsetArg);
  // 分页视图按 offset 缓存，避免相邻页互相覆盖
  const ck = Safeguards.cacheKey('rankp', board, limit1, offset);
  const cached = Safeguards.cacheGet(ck);
  if (Array.isArray(cached)) {
    if (cached.length === 3 && Array.isArray(cached[0])) {
      return new RankPage(cached[0], cached[1] === true,
        Json.optInt(cached[2], offset));
    }
  }

  const sub = RANK_BOARDS[board] !== undefined ? RANK_BOARDS[board] : board;
  const results = [];
  let cur = offset;
  const sessionUuid = crypto.randomUUID();
  let hasMore = false;

  while (results.length < limit1) {
    const q = Json.obj();
    q.cell_id = COMIC_RANK_CELL;
    q.tab_type = '26';
    q.client_req_type = '2';
    q.client_template = '2';
    q.screen_width_px = '1350';
    q.selected_items = 'comic_series_rank';
    q.sub_selected_items = sub;
    q.session_uuid = sessionUuid;
    if (cur !== 0) q.offset = String(cur);

    const j = await api('GET', '/reading/bookapi/bookmall/cell/change/v',
      null, q, 3, SIGN_LIST);
    const data = Json.optObj(j.data);
    const cv = data === null ? null : Json.optObj(data.cell_view);
    const cells = cv === null ? [] : Json.optArr(cv.cell_data);
    if (cells.length === 0) break;

    for (const itemObj of cells) {
      const item = Json.optObj(itemObj);
      if (item === null) continue;
      let vo = item.video_data;
      if (Array.isArray(vo)) {
        vo = vo.length === 0 ? Json.obj() : vo[0];
      }
      let v = Json.optObj(vo);
      if (v === null) v = Json.obj();
      let sid = v.series_id;
      if (sid === null || sid === undefined) sid = v.book_id;
      if (sid === null || sid === undefined) continue;

      const row = Json.obj();
      // 分页时 rank 接着上一页排，避免每页都从 1 开始
      row.rank = offset + results.length + 1;
      row.series_id = String(sid);
      row.title = str(v, 'title');
      row.episode_cnt = num(v, 'episode_cnt');
      row.score = hasOwn(v, 'score') ? v.score : '';
      row.play_cnt = num(v, 'play_cnt');
      row.hot = str(v, 'rec_text');
      row.copyright = str(v, 'copyright');
      row.cover = str(v, 'cover');
      row.tags = coverTags(v);
      row.abstract = strip(str(v, 'video_desc'), 50);
      results.push(row);
    }
    hasMore = cv !== null && Json.optBool(cv.has_more, false);
    const adv = (cv !== null && cv.next_offset !== null && cv.next_offset !== undefined)
      ? Json.optInt(cv.next_offset, cur + cells.length)
      : cur + cells.length;
    // 游标没前进说明上游在原地打转，再翻下去会无限重复同一页
    if (adv <= cur) { hasMore = false; break; }
    cur = adv;
    if (!hasMore) break;
  }

  const out = results.slice(0, Math.min(limit1, results.length));
  // 结果放满说明可能还有后续页；否则上游已明确没有
  const more = hasMore && out.length >= limit1;
  Safeguards.cacheSet(ck, [out, more, cur], 1800);
  return new RankPage(out, more, cur);
}

/**
 * 最新上架。
 * - 短剧：官方有"今日上新"标签，only_today=true 精确返回今日上新；
 * - 漫剧/AI：官方最细 7 天粒度，统一返回"7天内上新·最新上架"。
 */
async function latest(genre, onlyToday, maxItems, refresh) {
  return (await latestPage(genre, onlyToday, maxItems, refresh, null, 0)).items;
}

/** 分页结果（通用）。 */
class Page {
  constructor(items, hasMore, nextSkip) {
    this.items = items;
    this.hasMore = hasMore;
    this.nextSkip = nextSkip;
  }

  /**
   * 从「已抓到的累积结果」里切出 [skip, skip+limit) 这一页。
   *
   * 上游不支持直接跳到第 N 条，续页只能从头多抓再丢掉前面的，
   * 所以切片集中放在这里，便于自检直接验证（search 需真实上游响应）。
   *
   * has_more 的判据是"这一页确实凑满了 limit 条、且上游还有后续"。
   * 攒不满即已到末尾，必须报 false —— 否则前端会一直显示「加载更多」，
   * 点了却永远拿不到内容。
   */
  static slice(all, skip, limit, upstreamHasMore) {
    const skipN = Math.max(0, skip);
    const lim = Math.max(1, limit);
    const size = (all === null || all === undefined) ? 0 : all.length;
    const from = Math.min(skipN, size);
    const to = Math.min(skipN + lim, size);
    const out = (all === null || all === undefined) ? [] : all.slice(from, to);
    const more = out.length >= lim && upstreamHasMore;
    return new Page(out, more, skipN + out.length);
  }
}

/**
 * landpage 列表条目 -> 前端行的公共字段。
 * latestPage 与 browsePage 对同一条目各补自己的差异字段
 * （category/today/tags 等），这九个公共字段不再重复抄写。
 */
function parseFeedRow(it, sid) {
  const row = Json.obj();
  row.series_id = sid;
  row.title = str(it, 'title');
  row.episode_cnt = num(it, 'episode_cnt');
  row.score = hasOwn(it, 'score') ? it.score : '';
  row.play_cnt = num(it, 'play_cnt');
  row.cover = str(it, 'cover');
  row.copyright = str(it, 'copyright');
  row.abstract = strip(str(it, 'video_desc'), 50);
  row.vid = str(it, 'vid');
  return row;
}

/**
 * 最新上架的一页（供无限滚动）。
 *
 * @param seenIds 已经展示过的 series_id。landpage 接口靠 filter_ids 去重，
 *                把已看过的 id 原样回传即可拿到后续内容且不与前面重复。
 */
async function latestPage(genre, onlyToday, maxItems, refresh, seenIds, skip) {
  const gv = GENRES[genre];
  if (gv === undefined) {
    throw new Error('genre 必须是 ' + Object.keys(GENRES).join('|'));
  }
  const scene = gv[0];
  const g = gv[1];
  const tagToday = genre === 'short_play';
  const onlineTime = [];
  if (!tagToday) onlineTime.push('days_7');
  const wantToday = tagToday && onlyToday;

  const ck = Safeguards.cacheKey('latest', genre, String(onlyToday),
    String(maxItems));
  // 分页请求（skip>0 或带了已看列表）不进整页缓存：整页缓存是给
  // 首屏用的，带去重状态的中间页缓存起来既易失效又会占内存
  const paged = skip > 0 || (seenIds !== null && seenIds !== undefined && seenIds.length > 0);
  if (!refresh && !paged) {
    const c = Safeguards.cacheGet(ck);
    if (c !== null) return new Page(c, true, 0);
  }

  const out = [];
  // 已看过的 id 沿用上游去重参数，续页才不会重复返回同一批
  const shown = seenIds !== null && seenIds !== undefined ? seenIds.slice() : [];
  // 关键：offset 必须从已展示条数起步，否则上游每次都回第一页，
  // 前端表现为「续页内容与首页完全相同」
  let offset = Math.max(0, skip);
  let hasMore = false;

  for (let pages = 0; pages < 20 && out.length < maxItems; pages++) {
    const body = landpageBody(shown, scene, offset, 18, landpageSelect(onlineTime, g));
    const j = await api('POST', '/reading/distribution/category/landpage/v',
      body, null, 3, SIGN_LIST);
    const data = Json.optObj(j.data);
    const items = data === null ? [] : Json.optArr(data.video_data);
    if (items.length === 0) break;

    let pageToday = 0;
    for (const itObj of items) {
      const it = Json.optObj(itObj);
      if (it === null) continue;
      const sid = String(it.series_id);
      shown.push(sid);

      const subs = [];
      for (const sObj of Json.optArr(it.sub_title_list)) {
        const s = Json.optObj(sObj);
        if (s !== null) subs.push(str(s, 'content'));
      }
      const isToday = subs.includes('今日上新');
      if (isToday) pageToday++;
      if (wantToday && !isToday) continue;

      const cats = parseCategories(it.category_schema);
      if (cats.length === 0) {
        for (const s of subs) {
          if (s === '' || s === '今日上新' || /^\d+(\.\d+)?万/.test(s)
              || s.includes('播放') || /^\d+集$/.test(s)) continue;
          if (!cats.includes(s)) cats.push(s);
        }
      }

      const row = parseFeedRow(it, sid);
      row.category = cats.join(' / ');
      row.today = isToday;
      const tags = [];
      const tagText = str(Json.optObj(it.tag_info), 'text');
      if (tagText !== '') tags.push(tagText);
      row.tags = tags;
      out.push(row);
      if (out.length >= maxItems) break;
    }
    if (wantToday && pageToday === 0) break; // 整页无今日 => 已过今日簇
    hasMore = data !== null && data.has_more !== false;
    if (!hasMore) break;
    offset += items.length;
  }
  if (out.length >= maxItems && out.length > skip) {
    Safeguards.cacheSet(ck, out, 600);
  }
  return new Page(out, hasMore, skip + out.length);
}

/**
 * landpage 接口的 select 段：genre 维度 + 上架时间过滤，排序固定「最新上架」。
 * 供 latestPage 使用；browsePage 的筛选维度更多，自行组装后传给 landpageBody。
 */
function landpageSelect(onlineTime, g) {
  const select = Json.obj();
  select.category_dim_epoch = [];
  select.online_time = onlineTime;
  select.gender = [];
  select.category_dim_role = [];
  select.genre = [g];
  select.sort = ['online_time'];
  select.category_dim_theme = [];
  return select;
}

/** landpage 接口请求体（latestPage 与 browsePage 共用，select 由调用方给）。 */
function landpageBody(shown, scene, offset, limit, select) {
  const body = Json.obj();
  body.filter_ids = shown.join(',');
  body.req_scene = scene;
  body.offset = offset;
  body.need_selector_panel = false;
  body.limit = limit;
  body.select_items = select;
  body.session_id = '';
  body.req_type = 'only_content';
  body.client_req_type = 3;
  return body;
}

/** 取某体裁的实时筛选面板。 */
async function filters(genre) {
  let gv = GENRES[genre];
  if (gv === undefined) gv = GENRES.short_play;

  const select = Json.obj();
  select.category_dim_epoch = [];
  select.online_time = [];
  select.gender = [];
  select.category_dim_role = [];
  select.genre = [gv[1]];
  select.sort = [];
  select.category_dim_theme = [];

  const body = Json.obj();
  body.filter_ids = '';
  body.req_scene = gv[0];
  body.offset = 0;
  body.limit = 1;
  body.need_selector_panel = true;
  body.req_type = 'default';
  body.client_req_type = 3;
  body.select_items = select;
  body.session_id = '';

  const j = await api('POST', '/reading/distribution/category/landpage/v',
    body, null, 3, SIGN_LIST);
  const data = Json.optObj(j.data);
  const rows = data === null ? [] : Json.optArr(data.selector_rows);
  const out = [];
  for (const rObj of rows) {
    const r = Json.optObj(rObj);
    if (r === null) continue;
    const row = Json.obj();
    row.type = str(r, 'type');
    row.row_name = str(r, 'row_name');
    row.selection_type = str(r, 'selection_type');
    const items = [];
    for (const itObj of Json.optArr(r.items)) {
      const it = Json.optObj(itObj);
      if (it === null) continue;
      const im = Json.obj();
      im.id = it.selector_item_id !== undefined ? it.selector_item_id : null;
      im.name = it.show_name !== undefined ? it.show_name : null;
      items.push(im);
    }
    row.items = items;
    out.push(row);
  }
  return out;
}

/** 单值或数组 -> id 数组；名称按 mapping 映射，已是 id/未知则原样透传。 */
function toIds(csv, mapping) {
  const out = [];
  if (csv === null || csv === undefined || csv === '') return out;
  const parts = Http.splitCsv(csv);
  if (parts === null) return out;
  for (const v of parts) {
    const mapped = mapping[v];
    out.push(mapped !== undefined && mapped !== null ? mapped : v);
  }
  return out;
}

/** 按筛选条件浏览。 */
async function browse(genre, opts) {
  return (await browsePage(genre, opts, null, 0)).items;
}

/**
 * 筛选浏览的一页（供无限滚动）。
 *
 * @param seenIds 已展示过的 series_id，经 filter_ids 回传给上游做去重。
 */
async function browsePage(genre, opts, seenIds, skip) {
  const gv = GENRES[genre];
  if (gv === undefined) {
    throw new Error('genre 必须是 ' + Object.keys(GENRES).join('|'));
  }
  if (opts === null || opts === undefined) opts = {};
  const maxItems = Math.min(Json.optInt(opts.limit, 60), 120);

  const select = Json.obj();
  select.genre = [gv[1]];
  select.category_dim_theme = toIds(opts.theme, FILTER_CATE);
  select.category_dim_role = toIds(opts.setting, FILTER_CATE);
  select.category_dim_epoch = toIds(opts.background, FILTER_CATE);
  const sortIds = toIds(opts.sort, FILTER_SORT);
  select.sort = sortIds.length === 0 ? ['online_time'] : sortIds;
  select.gender = toIds(opts.gender, FILTER_GENDER);
  select.creation_status = toIds(opts.status, FILTER_STATUS);
  select.online_time = toIds(opts.days, FILTER_DAYS);

  const out = [];
  const shown = seenIds !== null && seenIds !== undefined ? seenIds.slice() : [];
  // 与 latestPage 同理：offset 必须从已展示条数起步
  let offset = Math.max(0, skip);
  let hasMore = false;

  for (let pages = 0; pages < 20 && out.length < maxItems; pages++) {
    const body = landpageBody(shown, gv[0], offset, 18, select);

    const j = await api('POST', '/reading/distribution/category/landpage/v',
      body, null, 3, SIGN_LIST);
    const data = Json.optObj(j.data);
    const items = data === null ? [] : Json.optArr(data.video_data);
    if (items.length === 0) break;

    for (const itObj of items) {
      const it = Json.optObj(itObj);
      if (it === null) continue;
      const sid = String(it.series_id);
      shown.push(sid);

      const row = parseFeedRow(it, sid);
      row.category = parseCategories(it.category_schema).join(' / ');
      row.tags = coverTags(it);
      row.comment_count = num(it, 'comment_count');
      row.duration = num(it, 'duration');
      row.horiz_cover = str(it, 'horiz_cover');
      out.push(row);
      if (out.length >= maxItems) break;
    }
    // 上方 items.isEmpty() 已拦截 data == null，此处 data 必非空。
    // 上游只在下页无内容时才给出 has_more=false，故按其值决定是否继续。
    if (data.has_more === false) break;
    hasMore = true;
    offset += items.length;
  }
  return new Page(out, hasMore, skip + out.length);
}

// ==================== 工具 ====================

/** 文件名安全化（保留 60 字上限）。 */
function sanitize(name) {
  const t = (name === null || name === undefined) ? ''
    : String(name).replace(/[\\/:*?"<>|]/g, '_').trim();
  return t.length > 60 ? t.substring(0, 60) : t;
}

/**
 * 归一化制作方名称用于比较。
 * 上游同一家公司偶尔带不同空格 / 全角括号，直接 === 会误杀同制作方的剧。
 * NFKC 统一全半角，去掉所有空白并转小写；不去标点，避免不同公司名被抹平。
 */
function normalizeCopyright(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .toLowerCase();
}

/**
 * 制作方是否视为一致。
 *
 * want 为空表示「当前剧制作方未知」（分享解析、单集播放、官网降级等入口），
 * 此时不启用过滤，保留原有全部结果，避免关联剧集按钮直接失效。
 * want 非空时严格匹配：条目没给 copyright 也视为不一致而过滤。
 */
function copyrightMatches(want, got) {
  const w = normalizeCopyright(want);
  if (w === '') return true;
  return w === normalizeCopyright(got);
}

/**
 * 查找同一剧的其他季。
 *
 * 原理：把当前剧名解析为「基础名 + 季数」，再用「基础名 + 第」做模糊搜索，
 * 把搜到的所有条目按季数归组，排除当前 series_id，返回其他季列表。
 *
 * 搜索关键词策略：
 *  - 首选「基础名 + 第」（去掉季数修饰词后追加「第」），一次覆盖所有季。
 *    直接用剧名搜索会先命中同名正片、解说、剪辑等噪声，而「第」正好是
 *    「<剧名>第X季 / 第X部」的锚点，命中率明显更高；
 *  - 仅当该关键词完全无结果时，才降级用不带「第」的剧名补搜一次，
 *    避免上游把后缀当整词匹配时功能整体失效。
 *
 * 传入当前剧制作方 copyright 时，只保留制作方一致的条目（两次搜索的结果
 * 都在下面同一个循环里过滤）；不传或为空则不启用过滤，维持原行为。
 *
 * 返回结构：
 *   {
 *     series_id,      当前剧 id
 *     series_title,   当前剧名
 *     base_title,     解析出的基础名（如「xxx」，去掉「第X季」）
 *     season,         当前季数（默认 1）
 *     copyright,      本次用于过滤的制作方（空串表示未启用）
 *     seasons: [      其他季列表
 *       { series_id, title, cover, episode_cnt, copyright, season, score }
 *     ]
 *   }
 *
 * @param {string} seriesId 当前剧 id
 * @param {string} seriesTitle 当前剧名（用于解析基础名）
 * @param {string} [currentCopyright] 当前剧制作方；为空表示不启用过滤
 * @returns {Promise<object>}
 */
async function findOtherSeasons(seriesId, seriesTitle, currentCopyright) {
  const sid = String(seriesId === null || seriesId === undefined ? '' : seriesId).trim();
  const stitle = String(seriesTitle === null || seriesTitle === undefined ? '' : seriesTitle).trim();
  const copyright = String(currentCopyright === null || currentCopyright === undefined
    ? '' : currentCopyright).trim();
  if (sid === '' || stitle === '') {
    return { series_id: sid, series_title: stitle, base_title: stitle,
      season: 1, copyright, seasons: [] };
  }

  const { parseSeason, normalizeTitle, titleScore, seasonKeyword } = SeasonUtil;

  const cur = parseSeason(stitle);
  const baseTitle = cur.base;
  const curSeason = cur.season;
  // 基础名被解析空时（如剧名就叫「第四季」）退回完整剧名，保证关键词非空
  const searchKw = seasonKeyword(baseTitle) || seasonKeyword(stitle);

  const out = Json.obj();
  out.series_id = sid;
  out.series_title = stitle;
  out.base_title = baseTitle;
  out.season = curSeason;
  out.copyright = copyright;

  // 主搜：带「第」锚点的关键词，一次覆盖所有季
  let results = [];
  try {
    results = await search(searchKw, 20);
  } catch (e) {
    Log.warn('findOtherSeasons 主搜失败 (' + searchKw + '): ' + e.message);
  }

  // 降级补搜：仅在主关键词完全无结果时用不带「第」的剧名兜底，
  // 兼容上游按整词匹配、且 parseSeason 误裁基础名的情况。
  if (results.length === 0) {
    const fallbackKw = baseTitle !== stitle ? stitle : baseTitle;
    if (fallbackKw !== '' && fallbackKw !== searchKw) {
      try {
        results = await search(fallbackKw, 20);
      } catch (e) {
        Log.warn('findOtherSeasons 降级补搜失败 (' + fallbackKw + '): ' + e.message);
      }
    }
  }

  // 过滤当前剧本身、制作方不一致的条目，解析季数，只留同基础名不同季的候选。
  // 主搜与降级补搜的结果都在这里过一遍，过滤条件只写一次。
  const seasons = [];
  const seen = new Set([sid]);

  for (const raw of results) {
    const item = Json.optObj(raw);
    if (item === null) continue;
    const rid = Json.optStr(item.series_id, '');
    const rtitle = Json.optStr(item.title, '');
    if (rid === '' || rtitle === '') continue;
    if (rid === sid || seen.has(rid)) continue;
    // 仅显示与当前制作方一致的剧集；copyright 为空时不启用过滤
    if (!copyrightMatches(copyright, Json.optStr(item.copyright, ''))) continue;
    seen.add(rid);

    const rParsed = parseSeason(rtitle);
    // 只保留与当前剧同基础名的条目（相似度兜底）
    const similarity = titleScore(baseTitle, rtitle);
    if (similarity < 30) continue;
    // 同季同基础名 = 当前剧本身，跳过
    if (rParsed.season === curSeason && normalizeTitle(rParsed.base) === normalizeTitle(baseTitle)) continue;

    const entry = Json.obj();
    entry.series_id = rid;
    entry.title = rtitle;
    entry.cover = Json.optStr(item.cover, '');
    entry.episode_cnt = Json.optInt(item.episode_cnt, 0);
    // 搜索结果本就带 copyright，透传给前端，点开其他季时不必再查
    entry.copyright = Json.optStr(item.copyright, '');
    entry.season = rParsed.season;
    entry.score = similarity;
    seasons.push(entry);
  }

  // 按季数升序，同季数按相似度降序
  seasons.sort((a, b) => a.season - b.season || b.score - a.score);
  out.seasons = seasons.slice(0, 20);
  return out;
}

// 仅导出有外部调用方（server.js / selftest.js）的成员：
// 常量表、请求组装与解析函数（buildUrl/apiOnce/parseCategories 等）只在
// 本模块内部使用，曾长期挂在导出表上但无人引用，已收敛回私有。
module.exports = {
  HOST,
  MANAGED,
  SIGN_LIST,
  RANK_BOARDS,
  RANK_NAMES,
  GENRES,
  GENRE_NAMES,
  baseQuery,
  sessionHeaders,
  identity,
  parseEpisodeDetail,
  webEpisodesToDetail,
  search,
  searchPage,
  getEpisodes,
  getEpisodesBatch,
  findOtherSeasons,
  normalizeCopyright,
  copyrightMatches,
  rank,
  rankPage,
  latest,
  latestPage,
  filters,
  browse,
  browsePage,
  sanitize,
  Page,
};
