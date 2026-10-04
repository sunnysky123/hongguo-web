'use strict';
/**
 * 红果短剧 API 客户端
 *
 * 移植自原 Python 模块 hongguo.py（1063 行）的 Node.js 等价实现。
 * 保留原有语义：设备身份池、_rticket 时间戳、x-ss-stub MD5、
 * 列表类接口免签、video_model 直链 5 小时缓存、风控/登录态退避重试。
 *
 * 差异点（有意为之）：
 *  - 指纹伪装（curl_cffi JA3）改由 undici/fetch 的原生 TLS 完成；
 *    如需强伪装可注入自定义 Agent，此处保留 HONGGUO_PROXY 代理能力。
 *  - 桌面托管模式（HONGGUO_SESSION_API_KEY 存在）禁止刷新被抓包的登录态，
 *    与原实现一致。
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const signer = require('./signer');
const safeguards = require('./safeguards');
const device = require('./device');

const HERE = __dirname;

/** 加载内容配置：优先 HONGGUO_CONTENT_CONFIG，其次 backend 侧 config.json / guest-config.json。 */
function loadConfig() {
  const candidates = [
    process.env.HONGGUO_CONTENT_CONFIG,
    path.join(HERE, '..', 'config', 'content-config.json'),
    path.join(HERE, '..', '..', 'backend', 'guest-config.json'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        return JSON.parse(fs.readFileSync(c, 'utf8').replace(/^\uFEFF/, ''));
      }
    } catch { /* 尝试下一个 */ }
  }
  throw new Error('未找到内容配置（content-config.json / guest-config.json）');
}

const CFG = loadConfig();
const HOST = process.env.HONGGUO_HOST || CFG.api_host;
const PROXY = (process.env.HONGGUO_PROXY || '').trim();

// search/tab/v 等接口校验 query 里的 device_id，缺失一律返回 code=100103
// PARAM_INVALID（与签名是否正确无关）。这里补齐一个本机稳定且持久化的值，
// 详见 server/src/device.js 的实测结论。
const _identity = device.ensureDeviceId(CFG.base_query);

/** 桌面托管模式标志：存在则禁止刷新登录态、禁止降级容错。 */
const MANAGED = !!process.env.HONGGUO_SESSION_API_KEY;

/** 设备身份池（DEVICE_POOL_SIZE > 0 时启用；托管模式固定单设备）。 */
const _pool = safeguards.loadDevicePool(CFG.base_query, {
  size: parseInt(process.env.DEVICE_POOL_SIZE || '0', 10) || 0,
  managed: MANAGED,
  // 池内每个设备自带 device_id；单设备模式沿用上面持久化的稳定值
  baseDeviceId: _identity.device_id,
});
function rotateDevice() { return _pool ? _pool.rotate() : null; }
function currentDevice() { return _pool ? _pool.current() : null; }

// 注：RANK_BOARDS / RANK_NAMES / COMIC_RANK_CELL / GENRES / GENRE_NAMES
// 定义在文件下方"榜单 / 最新 / 筛选"一节，与数据接口同处，便于对照维护。

// 注：仅 landpage/cell 系列列表接口免签（原 SIGN_LIST 语义）。
// 搜索、剧集详情、video_model 在原版中均走默认 signed=true —— 这些接口
// 确实校验 X-Argus 等签名头，免签会得到空响应（body_bytes=0）。
const SIGN_LIST = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.HG_SIGN_LIST || '').trim().toLowerCase(),
);
const USER_AGENT = process.env.HONGGUO_UA || CFG.session_headers['user-agent'] || 'hongguo-web/1.0';

class UpstreamResponseError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = 'UpstreamResponseError';
    this.diagnostic = diagnostic || {};
  }
}
class RiskControlError extends Error { constructor(m) { super(m); this.name = 'RiskControlError'; } }
class AuthExpiredError extends Error { constructor(m) { super(m); this.name = 'AuthExpiredError'; } }

/** 组装完整 URL（含 base_query、设备身份、_rticket）。 */
function buildUrl(pathname, extra) {
  const q = { ...CFG.base_query };
  const dev = currentDevice();
  if (dev) Object.assign(q, dev.query);
  if (extra) Object.assign(q, extra);
  q._rticket = String(Date.now());
  const qs = Object.entries(q)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `https://${HOST}${pathname}?${qs}`;
}

/** 构造基础请求头。 */
function buildHeaders(body) {
  const headers = { ...CFG.session_headers };
  const dev = currentDevice();
  if (dev) {
    if (dev.user_agent) headers['user-agent'] = dev.user_agent;
    delete headers['x-tt-token'];
    delete headers.cookie;
  }
  if (!headers['user-agent']) headers['user-agent'] = USER_AGENT;
  headers['content-type'] = 'application/json; charset=utf-8';
  if (body !== undefined && body !== null) {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    headers['x-ss-stub'] = crypto.createHash('md5').update(data).digest('hex').toUpperCase();
    headers['content-length'] = String(data.length);
    return { headers, data };
  }
  delete headers['content-length'];
  return { headers, data: undefined };
}

async function rawRequest(url, { method = 'GET', headers, data, timeout = 30000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const init = { method, headers, signal: ac.signal };
    if (data) init.body = data;
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

/** 单次 API 调用（不含重试）。 */
async function apiOnce(method, pathname, body, extraQuery, signed = true) {
  const url = buildUrl(pathname, extraQuery);
  const { headers, data } = buildHeaders(body);
  if (signed) {
    const sig = await signer.sign(url, headers);
    Object.assign(headers, sig);
  }
  delete headers['accept-encoding'];
  await safeguards.throttle.wait();

  const res = await rawRequest(url, { method, headers, data });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    // 该接口需签名；未配置签名服务时上游返回空体，这里给出可操作的提示
    if (signed && !signer.signServers().length) {
      const err = new Error(
        '该接口需要 X-Argus 签名。请启动 Java 签名服务并设置环境变量 '
        + 'SIGN_SERVER=http://127.0.0.1:9099',
      );
      err.name = 'SignerMissingError';
      err.diagnostic = { http_status: res.status, body_bytes: Buffer.byteLength(text) };
      throw err;
    }
    throw new UpstreamResponseError('上游未返回 JSON', {
      http_status: res.status, body_bytes: Buffer.byteLength(text),
    });
  }
  safeguards.checkResponse(j);
  return j;
}

/** 带重试退避 + 登录态刷新的 API 调用。 */
async function api(method, pathname, body, extraQuery, maxRetries = 3, signed = true) {
  let last = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await apiOnce(method, pathname, body, extraQuery, signed);
    } catch (e) {
      if (e instanceof AuthExpiredError || e instanceof RiskControlError) {
        if (MANAGED) throw e; // 托管模式不刷新被抓包的登录态
        last = e;
        if (e instanceof AuthExpiredError) {
          console.log(`[api] 登录态失效，刷新后重试 (${pathname})`);
          await refreshSession();
          await safeguards.sleep(1000);
        } else {
          const wait = 2 ** attempt + 1;
          console.log(`[api] 风控/异常，退避 ${wait}s 重试 (${pathname}): ${e.message}`);
          await safeguards.sleep(wait * 1000);
        }
        continue;
      }
      if (e instanceof UpstreamResponseError || e instanceof TypeError) {
        if (MANAGED) throw e;
        last = e;
        await safeguards.sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw last || new Error('api 失败');
}

let lastRefresh = 0;
/** 从签名服务 /grab 刷新设备身份与 token（仅非托管模式）。 */
async function refreshSession() {
  if (Date.now() - lastRefresh < 20000) return; // 防抖
  if (!signer.signServers().length) return;
  try {
    const data = await signer.grab();
    if (data.error) { console.log('[refresh] grab 失败:', data.error); return; }
    const u = new URL(data.url);
    const deviceKeys = new Set([
      ...Object.keys(CFG.base_query),
      'iid', 'device_id', 'cdid', 'klink_egdi', 'channel', 'update_version_code',
    ]);
    for (const [k, v] of u.searchParams) {
      if (deviceKeys.has(k) && v) CFG.base_query[k] = v;
    }
    for (const [k, v] of Object.entries(data.headers || {})) {
      const kl = k.toLowerCase();
      if (['cookie', 'x-tt-token', 'x-tt-store-region', 'x-tt-store-region-src'].includes(kl) && v) {
        CFG.session_headers[kl] = String(v).replace(/^\[|\]$/g, '');
      }
    }
    lastRefresh = Date.now();
    console.log(`[refresh] 登录态已刷新, token 长度=${(CFG.session_headers['x-tt-token'] || '').length}`);
  } catch (e) {
    console.log('[refresh] 异常:', e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 数据解析与业务接口 ----------------

/** 从 category_schema 字符串中解析分类名（源数据为 JSON 字符串）。 */
function parseCategories(schema) {
  const out = [];
  if (!schema) return out;
  const rx = /"name"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = rx.exec(String(schema))) !== null) {
    if (m[1] && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 提取封面角标文本（爆剧/新剧/独播…）。cover_tag_info_list 结构不定，容错取文本。 */
function coverTags(d) {
  const out = [];
  for (const t of (d && d.cover_tag_info_list) || []) {
    if (t && typeof t === 'object') {
      const v = t.text || t.content || t.name || t.tag_text || t.title;
      if (v) out.push(String(v).replace(/<[^>]+>/g, ''));
    } else if (typeof t === 'string' && t) {
      out.push(t);
    }
  }
  return out;
}

/** 从搜索 cell 解析短剧条目；非短剧（无集数）或无 id 返回 null。 */
function parseSearchCell(cell) {
  if (!cell || typeof cell !== 'object') return null;
  const sid = cell.book_id || cell.search_result_id;
  if (!sid) return null;
  const vd = cell.video_detail || {};
  // video_data 可能是数组或对象
  let vdata = cell.video_data;
  if (Array.isArray(vdata) && vdata.length) vdata = vdata[0];
  if (!vdata || typeof vdata !== 'object') vdata = {};
  const inner = vdata.video_detail || {};
  const ep = vd.episode_cnt || vdata.episode_cnt || inner.episode_cnt || 0;
  if (!ep) return null; // 只要短剧（有集数的）
  const hl = (((cell.search_high_light || {}).title || {}).text) || '';
  const title = String(hl || vd.series_title || vdata.title || inner.series_title || '')
    .replace(/<[^>]+>/g, '');
  return {
    series_id: String(sid),
    title,
    episode_cnt: ep,
    score: vdata.score || inner.score || '',
    play_cnt: vdata.play_cnt || inner.series_play_cnt || 0,
    hot: vdata.rec_text || '',
    copyright: vdata.copyright || '',
    cover: vdata.cover || inner.series_cover || '',
    tags: coverTags(vdata),
    abstract: (inner.series_intro || vd.series_intro || '').slice(0, 60),
    vid: vdata.vid || '',
    duration: vdata.duration || 0,
    horiz_cover: vdata.horiz_cover || '',
  };
}

/**
 * 搜索短剧。按综合 tab 分页（next_offset + passback + search_id）循环翻页，
 * 直到 has_more=false 或达到 max_items / 12 页安全上限。
 * max_items 越小翻页越少越快；默认 HG_SEARCH_MAX_ITEMS=20。
 */
async function search(query, maxItems) {
  const limit = Math.max(1, Math.min(
    maxItems || parseInt(process.env.HG_SEARCH_MAX_ITEMS || '20', 10), 40,
  ));
  const ck = safeguards.cacheKey('search', query, limit);
  const cached = safeguards.cacheGet(ck);
  if (cached) return cached;

  const results = [];
  const seen = new Set();
  let offset = 0;
  let passback = '';
  let searchId = '';
  for (let page = 0; page < 12; page++) {
    // 注意：device_id 由 buildUrl 从 CFG.base_query 统一注入，
    // 缺失时上游会返回 code=100103 PARAM_INVALID，故此处不再单独传。
    const q = {
      query, tab_name: 'feed', search_source: '1',
      offset: String(offset), count: '10', use_correct: 'true',
    };
    if (passback) q.passback = passback;
    if (searchId) q.search_id = searchId;
    const j = await api('GET', '/reading/bookapi/search/tab/v', null, q, 1, true);
    const tabs = j.search_tabs || [];
    if (!tabs.length) break;
    const tab = tabs[0]; // 综合 tab
    const data = tab.data || [];
    for (const cell of data) {
      const item = parseSearchCell(cell);
      if (!item || seen.has(item.series_id)) continue;
      seen.add(item.series_id);
      results.push(item);
    }
    if (tab.next_offset !== undefined && tab.next_offset !== null) offset = tab.next_offset;
    passback = tab.passback || passback;
    searchId = tab.search_id || searchId;
    if (!tab.has_more || !data.length || results.length >= limit) break;
  }
  const out = results.slice(0, limit);
  safeguards.cacheSet(ck, out, 600); // 10 分钟
  return out;
}

/** 剧集详情请求体（image_shrink 为抓包中的固定值）。 */
const IMAGE_SHRINK = 'W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d';

function episodesBody(seriesId) {
  return {
    biz_param: {
      detail_page_version: 0, disable_digg_stat: false,
      disable_video_relate_book: false, image_shrink_datas_str: IMAGE_SHRINK,
      need_all_video_definition: false, need_mp4_align: false,
      screen_width_px: '900', source: 7, use_os_player: false, use_server_dns: false,
    },
    series_id: String(seriesId),
  };
}

/**
 * 解析剧集详情。
 *
 * 注意 title 字段：上游 video_list[].title 里装的其实是「本剧简介」，
 * 每一集都重复同一段文字，并非集标题。若直接展示，剧集条上会出现
 * 81 个一模一样的长句。这里与 series_intro 比对，命中则视为无效标题，
 * 置空让前端回落到「第 N 集」。
 */
function parseEpisodeDetail(sid, vd) {
  const d = vd || {};
  const intro = String(d.series_intro || '').trim();
  const eps = [];
  for (const e of d.video_list || []) {
    let title = String(e.title || '').trim();
    // 与简介相同（或简介非空且标题被简介完全包含）=> 是简介不是集名
    if (title && intro && (title === intro || intro.includes(title))) title = '';
    eps.push({
      index: e.vid_index || 0,
      vid: e.vid === undefined || e.vid === null ? '' : String(e.vid),
      title: title.slice(0, 30),
      duration: e.duration || 0,
      cover: e.episode_cover || e.cover || '',
      comment_count: e.comment_count || 0,
      digged_count: e.digged_count || 0,
    });
  }
  eps.sort((a, b) => (a.index || 0) - (b.index || 0));
  const firstEpCover = (eps.find((e) => e.cover) || {}).cover || '';
  const celebs = (d.celebrities || []).map((c) => ({
    演员: c.nickname || '', 角色: c.role_name || '',
    头像: c.avatar || '', 简介: String(c.intro || '').slice(0, 80),
  }));
  const meta = {
    series_id: String(sid),
    title: d.series_title || String(sid),
    abstract: d.series_intro || '',
    episode_cnt: d.episode_cnt || eps.length,
    status: d.series_status === 1 ? '完结' : '连载中',
    play_cnt: d.series_play_cnt || 0,
    followed_cnt: d.followed_cnt || 0,
    create_time: d.create_time || 0,
    cover: d.series_cover || firstEpCover,
    category: parseCategories(d.category_schema),
    tags: coverTags(d),
    celebrities: celebs,
  };
  return { meta, episodes: eps };
}

/** 取单剧元信息 + 剧集列表（缓存 6 小时）。 */
async function getEpisodes(seriesId) {
  const sid = String(seriesId);
  const ck = safeguards.cacheKey('episodes', sid);
  const cached = safeguards.cacheGet(ck);
  if (cached) return cached;
  const j = await api('POST', '/novel/player/multi_video_detail/v1/', episodesBody(sid), null, 3, true);
  const data = j.data || {};
  const result = parseEpisodeDetail(sid, (data[sid] || {}).video_data);
  safeguards.cacheSet(ck, result, 21600);
  return result;
}

/** 批量取剧集元数据。multi_video_detail 的 series_id 支持逗号拼接，20 个/批稳定。 */
async function getEpisodesBatch(seriesIds, batchSize = 20) {
  const ids = [];
  const seen = new Set();
  for (const s of seriesIds || []) {
    const sid = String(s).trim();
    if (sid && !seen.has(sid)) { seen.add(sid); ids.push(sid); }
  }
  const bs = Math.max(1, Math.min(batchSize || 20, 20));
  const out = {};
  const failed = [];
  const todo = [];
  for (const sid of ids) {
    const cached = safeguards.cacheGet(safeguards.cacheKey('episodes', sid));
    if (cached) out[sid] = cached.meta;
    else todo.push(sid);
  }
  for (let i = 0; i < todo.length; i += bs) {
    const batch = todo.slice(i, i + bs);
    try {
      const j = await api('POST', '/novel/player/multi_video_detail/v1/',
        episodesBody(batch.join(',')), null, 3, true);
      const data = j.data || {};
      for (const sid of batch) {
        const vd = (data[sid] || {}).video_data;
        if (!vd || !Object.keys(vd).length) {
          failed.push({ series_id: sid, error: 'empty detail' });
          continue;
        }
        const parsed = parseEpisodeDetail(sid, vd);
        safeguards.cacheSet(safeguards.cacheKey('episodes', sid), parsed, 21600);
        out[sid] = parsed.meta;
      }
    } catch (e) {
      for (const sid of batch) failed.push({ series_id: sid, error: e.message });
    }
  }
  return [out, failed];
}

/** 归一化 video_model 轨道结构，拒绝非法 URL 与结构。 */
function videoModelTracks(model) {
  let tracks = Array.isArray(model) ? model
    : (model && typeof model === 'object' ? (model.video_list ?? model) : model);
  if (tracks && typeof tracks === 'object' && !Array.isArray(tracks)) tracks = Object.values(tracks);
  if (!Array.isArray(tracks) || tracks.some((t) => !t || typeof t !== 'object')) {
    const err = new Error('不支持的 video_model 结构');
    err.modelShape = {
      modelType: model === null ? 'null' : Array.isArray(model) ? 'list' : typeof model,
      tracksType: Array.isArray(tracks) ? 'list' : typeof tracks,
    };
    throw err;
  }
  return tracks.map((source) => {
    const track = { ...source };
    for (const field of ['main_url', 'backup_url']) {
      let value = track[field];
      if (!value) continue;
      if (typeof value !== 'string') throw new Error('媒体 URL 类型非法');
      if (!value.startsWith('http://') && !value.startsWith('https://')) {
        // 上游可能返回 base64 编码的 URL
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        if (!decoded.startsWith('http')) throw new Error('非法编码的媒体 URL');
        value = decoded;
      }
      let parsed;
      try { parsed = new URL(value); } catch { throw new Error('非法媒体 URL'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
          || parsed.username || parsed.password) {
        throw new Error('非法媒体 URL');
      }
      track[field] = value;
    }
    const vm = track.video_meta && typeof track.video_meta === 'object' ? track.video_meta : {};
    const ei = track.encrypt_info && typeof track.encrypt_info === 'object' ? track.encrypt_info : {};
    const pick = (o, keys) => Object.fromEntries(
      keys.filter((k) => source[k] !== undefined).map((k) => [k, source[k]]),
    );
    track.video_meta = { ...pick(source, ['size', 'definition', 'codec_type', 'vwidth', 'vheight']), ...vm };
    track.encrypt_info = { ...pick(source, ['encrypt', 'spade_a']), ...ei };
    return track;
  });
}

/** video_model 批量请求体（每批 5 个 vid，贴近 app 真实批量大小）。 */
function videoModelBody(batch) {
  return {
    biz_param: {
      detail_page_version: 0, device_level: 3, disable_digg_stat: false,
      disable_video_relate_book: false, need_all_video_definition: true,
      need_mp4_align: false, use_os_player: false, use_server_dns: false, video_platform: 1024,
    },
    mixed_video_id_map: { 1: batch },
  };
}

/** 批量取视频直链。返回 {vid: {url, backup, size, definition}}，缓存 5 小时。 */
async function getVideoUrls(vids, force = false) {
  const tracks = await getVideoTracks(vids, force);
  const out = {};
  for (const [vid, list] of Object.entries(tracks)) {
    let best = null;
    for (const item of list) {
      const meta = item.video_meta || {};
      const size = meta.size || 0;
      if (!best || size > best.size) {
        best = {
          url: item.main_url, backup: item.backup_url, size,
          definition: meta.definition || '?',
          url_is_http: String(item.main_url || '').startsWith('http'),
        };
      }
    }
    if (best) {
      out[vid] = best;
      safeguards.cacheSet(safeguards.cacheKey('vmodel', vid), best, 18000);
    }
  }
  return out;
}

/** 批量取每个 vid 的完整 video_list 轨道（含 spade_a 供离线解密、全部清晰度）。 */
async function getVideoTracks(vids, force = false, batchSize = 5) {
  const out = {};
  const todo = [];
  const seen = new Set();
  for (const v of vids) {
    const s = String(v);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    const c = force ? null : safeguards.cacheGet(safeguards.cacheKey('vmtracks', s));
    if (c) out[s] = c;
    else todo.push(s);
  }
  const bs = Math.max(1, Math.min(batchSize || 5, 5));
  for (let i = 0; i < todo.length; i += bs) {
    const batch = todo.slice(i, i + bs);
    const j = await api('POST', '/novel/player/multi_video_model/v1/',
      videoModelBody(batch), null, 3, true);
    for (const [vid, v] of Object.entries(j.data || {})) {
      const vm = v.video_model;
      if (!vm) continue;
      let parsed = vm;
      if (typeof vm === 'string') {
        try { parsed = JSON.parse(vm); } catch { continue; }
      }
      const tracks = videoModelTracks(parsed);
      if (tracks.length) {
        out[String(vid)] = tracks;
        safeguards.cacheSet(safeguards.cacheKey('vmtracks', String(vid)), tracks, 18000);
      }
    }
  }
  return out;
}

// ---------------- 榜单 / 最新 / 筛选 ----------------

// 榜单：cell_id 固定，sub_selected_items 区分三个榜
const RANK_BOARDS = {
  recommend: 'comic_series_hot_rank', // 推荐榜
  hot: 'comic_series_hot_play',       // 热播榜
  new: 'comic_series_new_rank',       // 新剧榜
};
const RANK_NAMES = { recommend: '漫剧推荐榜', hot: '漫剧热播榜', new: '漫剧新剧榜' };
const COMIC_RANK_CELL = '7470092475068071998';

/** 取漫剧榜单。board: recommend / hot / new。 */
async function rank(board = 'recommend', limit = 30) {
  const ck = safeguards.cacheKey('rank', board, limit);
  const cached = safeguards.cacheGet(ck);
  if (cached) return cached;

  const sub = RANK_BOARDS[board] || board;
  const results = [];
  let offset = 0;
  const sessionUuid = crypto.randomUUID();
  while (results.length < limit) {
    const q = {
      cell_id: COMIC_RANK_CELL, tab_type: '26', client_req_type: '2',
      client_template: '2', screen_width_px: '1350',
      selected_items: 'comic_series_rank', sub_selected_items: sub,
      session_uuid: sessionUuid,
    };
    if (offset) q.offset = String(offset);
    const j = await api('GET', '/reading/bookapi/bookmall/cell/change/v', null, q, 3, SIGN_LIST);
    const cv = (j.data || {}).cell_view || {};
    const cells = cv.cell_data || [];
    if (!cells.length) break;
    for (const item of cells) {
      let v = item.video_data;
      if (Array.isArray(v)) v = v.length ? v[0] : {};
      const sid = (v || {}).series_id || (v || {}).book_id;
      if (!sid) continue;
      results.push({
        rank: results.length + 1,
        series_id: String(sid),
        title: (v || {}).title || '',
        episode_cnt: (v || {}).episode_cnt || 0,
        score: (v || {}).score || '',
        play_cnt: (v || {}).play_cnt || 0,
        hot: (v || {}).rec_text || '',
        copyright: (v || {}).copyright || '',
        cover: (v || {}).cover || '',
        tags: coverTags(v || {}),
        abstract: String((v || {}).video_desc || '').slice(0, 50),
      });
    }
    if (!cv.has_more) break;
    offset = cv.next_offset ?? offset + cells.length;
  }
  const out = results.slice(0, limit);
  safeguards.cacheSet(ck, out, 1800); // 30 分钟
  return out;
}

// 体裁 -> [req_scene, genre]
const GENRES = {
  short_play: ['default', 'short_play'],
  comic_series: ['comic_series', 'comic_series'],
  ai_series: ['ai_series', 'ai_series'],
};
const GENRE_NAMES = { short_play: '短剧', comic_series: '漫剧', ai_series: 'AI短剧' };

/**
 * 最新上架。
 * - 短剧：官方有"今日上新"标签，only_today=true 精确返回今日上新；
 * - 漫剧/AI：官方最细 7 天粒度，统一返回"7天内上新·最新上架"。
 */
async function latest(genre = 'short_play', onlyToday = true, maxItems = 120, refresh = false) {
  if (!GENRES[genre]) throw new Error(`genre 必须是 ${Object.keys(GENRES).join('|')}`);
  const [scene, g] = GENRES[genre];
  const tagToday = genre === 'short_play';
  const onlineTime = tagToday ? [] : ['days_7'];
  const wantToday = tagToday && onlyToday;

  const ck = safeguards.cacheKey('latest', genre, String(onlyToday), String(maxItems));
  if (!refresh) {
    const c = safeguards.cacheGet(ck);
    if (c) return c;
  }

  const out = [];
  const shown = [];
  let offset = 0;
  for (let pages = 0; pages < 20 && out.length < maxItems; pages++) {
    const body = {
      filter_ids: shown.join(','), req_scene: scene, offset,
      need_selector_panel: false, limit: 18,
      select_items: {
        category_dim_epoch: [], online_time: onlineTime, gender: [],
        category_dim_role: [], genre: [g], sort: ['online_time'], category_dim_theme: [],
      },
      session_id: '', req_type: 'only_content', client_req_type: 3,
    };
    const j = await api('POST', '/reading/distribution/category/landpage/v', body, null, 3, SIGN_LIST);
    const data = j.data || {};
    const items = data.video_data || [];
    if (!items.length) break;
    let pageToday = 0;
    for (const it of items) {
      const sid = String(it.series_id);
      shown.push(sid);
      const subs = (it.sub_title_list || []).map((s) => s.content);
      const isToday = subs.includes('今日上新');
      if (isToday) pageToday++;
      if (wantToday && !isToday) continue; // 短剧今日模式：跳过非今日，但扫完本页
      let cats = parseCategories(it.category_schema);
      if (!cats.length) {
        for (const s of subs) {
          if (!s || s === '今日上新' || /^\d+(\.\d+)?万/.test(s)
              || s.includes('播放') || /^\d+集$/.test(s)) continue;
          if (!cats.includes(s)) cats.push(s);
        }
      }
      out.push({
        series_id: sid, title: it.title || '',
        episode_cnt: it.episode_cnt || 0, score: it.score || '',
        play_cnt: it.play_cnt || 0, cover: it.cover || '',
        category: cats.join(' / '), today: isToday,
        copyright: it.copyright || '',
        tags: [(it.tag_info || {}).text || ''].filter(Boolean),
        abstract: String(it.video_desc || '').slice(0, 50),
        vid: it.vid || '',
      });
      if (out.length >= maxItems) break;
    }
    if (wantToday && pageToday === 0) break; // 整页无今日 => 已过今日簇
    if (data.has_more === false) break;
    offset += items.length;
  }
  safeguards.cacheSet(ck, out, 600);
  return out;
}

// 主题/设定/背景 共用 cate_ 命名空间
const FILTER_CATE = {
  // 主题
  脑洞: 'cate_755', 奇幻: 'cate_6', 剧情: 'cate_316', 玄幻: 'cate_7',
  末世: 'cate_68', 豪门: 'cate_936', 科幻: 'cate_1092', 冒险: 'cate_1182',
  // 设定
  重生: 'cate_36', 穿越: 'cate_37', 逆袭: 'cate_739', 异能: 'cate_598',
  系统: 'cate_19', 反转: 'cate_756', 娱乐圈: 'cate_43', 总裁: 'cate_29',
  // 背景
  架空: 'cate_452', 都市: 'cate_1', 古代: 'cate_758', 异界: 'cate_599',
  校园: 'cate_4', 职场: 'cate_127', 年代: 'cate_79', 乡村: 'cate_11', 民国: 'cate_390',
};
const FILTER_SORT = {
  最新上架: 'online_time', 最新: 'online_time', 最高热度: 'hot_score',
  热度: 'hot_score', hot: 'hot_score', 最高收藏: 'hot_collect', 收藏: 'hot_collect',
};
const FILTER_GENDER = { 男频: '1', 男: '1', 女频: '0', 女: '0' };
const FILTER_DAYS = {
  7: 'days_7', 14: 'days_14', 30: 'days_30', 90: 'days_90',
  '7天内上新': 'days_7', '14天内上新': 'days_14', '30天内上新': 'days_30', '90天内上新': 'days_90',
};
const FILTER_STATUS = { 已完结: 'creation_status_0', 完结: 'creation_status_0', 连载中: 'creation_status_1', 连载: 'creation_status_1' };

/** 单值或数组 -> id 数组；名称按 mapping 映射，已是 id/未知则原样透传。 */
function toIds(val, mapping) {
  if (val === undefined || val === null || val === '') return [];
  const vals = Array.isArray(val) ? val : [val];
  const out = [];
  for (const v of vals) {
    const s = String(v).trim();
    if (s) out.push(mapping[s] !== undefined ? mapping[s] : s);
  }
  return out;
}

/** 取某体裁的实时筛选面板。 */
async function filters(genre = 'short_play') {
  const [scene, g] = GENRES[genre] || GENRES.short_play;
  const body = {
    filter_ids: '', req_scene: scene, offset: 0, limit: 1,
    need_selector_panel: true, req_type: 'default', client_req_type: 3,
    select_items: {
      category_dim_epoch: [], online_time: [], gender: [],
      category_dim_role: [], genre: [g], sort: [], category_dim_theme: [],
    },
    session_id: '',
  };
  const j = await api('POST', '/reading/distribution/category/landpage/v', body, null, 3, SIGN_LIST);
  const rows = (j.data || {}).selector_rows || [];
  return rows.map((r) => ({
    // type 即 select_items 的键
    type: r.type || '',
    row_name: r.row_name || '',
    selection_type: r.selection_type || '',
    items: (r.items || []).map((it) => ({ id: it.selector_item_id, name: it.show_name })),
  }));
}

/** 按筛选条件浏览。各维度可传中文名或 id，多选用逗号分隔。 */
async function browse(genre = 'short_play', opts = {}) {
  if (!GENRES[genre]) throw new Error(`genre 必须是 ${Object.keys(GENRES).join('|')}`);
  const [scene, g] = GENRES[genre];
  const maxItems = Math.min(opts.limit || 60, 120);
  const sel = {
    genre: [g],
    category_dim_theme: toIds(opts.theme, FILTER_CATE),
    category_dim_role: toIds(opts.setting, FILTER_CATE),
    category_dim_epoch: toIds(opts.background, FILTER_CATE),
    sort: toIds(opts.sort, FILTER_SORT).length ? toIds(opts.sort, FILTER_SORT) : ['online_time'],
    gender: toIds(opts.gender, FILTER_GENDER),
    creation_status: toIds(opts.status, FILTER_STATUS),
    online_time: toIds(opts.days, FILTER_DAYS),
  };
  const out = [];
  const shown = [];
  let offset = 0;
  for (let pages = 0; pages < 20 && out.length < maxItems; pages++) {
    const body = {
      filter_ids: shown.join(','), req_scene: scene, offset,
      need_selector_panel: false, limit: 18, select_items: sel,
      session_id: '', req_type: 'only_content', client_req_type: 3,
    };
    const j = await api('POST', '/reading/distribution/category/landpage/v', body, null, 3, SIGN_LIST);
    const data = j.data || {};
    const items = data.video_data || [];
    if (!items.length) break;
    for (const it of items) {
      const sid = String(it.series_id);
      shown.push(sid);
      out.push({
        series_id: sid, title: it.title || '',
        episode_cnt: it.episode_cnt || 0, score: it.score || '',
        play_cnt: it.play_cnt || 0, cover: it.cover || '',
        copyright: it.copyright || '',
        category: parseCategories(it.category_schema).join(' / '),
        tags: coverTags(it),
        abstract: String(it.video_desc || '').slice(0, 50),
        vid: it.vid || '',
        comment_count: it.comment_count || 0,
        duration: it.duration || 0,
        horiz_cover: it.horiz_cover || '',
      });
      if (out.length >= maxItems) break;
    }
    if (data.has_more === false) break;
    offset += items.length;
  }
  return out;
}

/** 文件名安全化（与原 Python sanitize 同语义，保留 60 字上限）。 */
function sanitize(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60);
}

/** 由封面 URL 推断扩展名（用于下载命名）。 */
function imgExt(url) {
  const m = String(url || '').match(/\.(jpe?g|png|webp|heic)(?:\?|$)/i);
  return m ? `.${m[1].toLowerCase()}` : '.jpg';
}

module.exports = {
  CFG, HOST, MANAGED, SIGN_LIST,
  DEVICE_IDENTITY: _identity,
  RANK_BOARDS, RANK_NAMES, COMIC_RANK_CELL, GENRES, GENRE_NAMES,
  FILTER_CATE, FILTER_SORT, FILTER_GENDER, FILTER_DAYS, FILTER_STATUS,
  UpstreamResponseError, RiskControlError, AuthExpiredError,
  buildUrl, buildHeaders, api, apiOnce, refreshSession, sleep,
  search, getEpisodes, getEpisodesBatch, videoModelTracks, getVideoUrls, getVideoTracks,
  rank, latest, filters, browse,
  coverTags, parseCategories, sanitize, imgExt, rotateDevice,
  parseEpisodeDetail, parseSearchCell,
};
