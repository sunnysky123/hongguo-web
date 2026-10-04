'use strict';
/**
 * 红果短剧 Web 服务
 *
 * 移植自原 Python 模块 server.py（FastAPI）的 Node.js 等价实现，
 * 并按"浏览器直接打开网页"的要求做了适配：
 *  - 同源托管前端静态文件（web/），无需额外前端服务器；
 *  - <video> 无法带自定义头，故 /stream 同时支持 ?api_key=；
 *  - 全量 CORS，便于前端独立部署到任意端口。
 *
 * 路由与原版保持一致：/search /rank /latest /filters /browse /episodes
 *                  /play /stream /video_url /img /download /stats
 */

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const client = require('./client');
const signer = require('./signer');
const stream = require('./stream');
const { KeyStore } = require('./keystore');
const safeguards = require('./safeguards');

const HOST = process.env.BIND_HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '8000', 10);
// 本文件位于 <项目根>/server/src/，前端在 <项目根>/web/，故需上溯两级。
const WEB_DIR = process.env.WEB_DIR || path.join(__dirname, '..', '..', 'web');

const keys = new KeyStore();
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(32).toString('hex');
const RATE_PER_MIN = parseInt(process.env.RATE_PER_MIN || '120', 10);

const stats = {
  start: Date.now(), requests: 0, errors: 0, risk: 0, authFail: 0,
};

// ---------------- 工具 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(payload);
}

function json(res, status, obj) { send(res, status, obj); }

function fail(res, status, detail, extra = {}) {
  json(res, status, { detail, ...extra });
}

const EXEMPT = new Set(['/', '/ui', '/img', '/favicon.ico', '/health', '/api-key']);

// 限流桶
const buckets = new Map();
function rateLimit(key) {
  const now = Date.now();
  let arr = buckets.get(key) || [];
  arr = arr.filter((t) => t > now - 60000);
  if (arr.length >= RATE_PER_MIN) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

function getKey(req, url) {
  return req.headers['x-api-key'] || url.searchParams.get('api_key') || '';
}

function checkAdmin(req, url) {
  const tok = req.headers['x-admin-token'] || url.searchParams.get('admin_token') || '';
  return !!tok && tok === ADMIN_TOKEN;
}

/** 解析集号参数：'1' / '1-10' / 'all' -> 集号数组 */
function parseRange(ep, total) {
  if (!ep || ep === 'all') return Array.from({ length: total }, (_, i) => i + 1);
  const m = /^(\d+)-(\d+)$/.exec(ep);
  if (m) {
    const out = [];
    for (let i = Number(m[1]); i <= Number(m[2]); i++) out.push(i);
    return out;
  }
  if (/^\d+$/.test(ep)) return [Number(ep)];
  return [];
}

// ---------------- 路由 ----------------
const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z_]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  }) + '$');
  routes.push({ method, pattern, rx, keys, handler });
}

route('GET', '/', async (req, res) => {
  json(res, 200, {
    service: '红果短剧 Web API', ui: '/ui', managed: client.MANAGED,
    endpoints: [
      '/search?q=', '/rank?board=recommend|hot|new&limit=',
      '/latest?genre=short_play|comic_series|ai_series&only_today=true',
      '/filters?genre=short_play', '/browse?genre=ai_series&theme=玄幻&sort=hot_score&days=7',
      '/episodes?series_id=', '/play?series_id=&ep=1-10',
      '/stream?series_id=&ep=1', '/stream?vid=&quality=1080p',
      '/prewarm?vid=', '/stats',
    ],
  });
});

route('GET', '/health', async (req, res) => {
  json(res, 200, {
    ok: true, uptime_s: Math.floor((Date.now() - stats.start) / 1000),
    sign_backends: await signer.health(),
    api_host: client.HOST,
    // 转码默认关闭（HG_TRANSCODE=1 才开）。缺 ffmpeg 时 CENC 信令无法剥离，
    // 部分播放器会拒绝播放，前端据此提示。
    ffmpeg: stream.ffmpegAvailable(),
    transcode: stream.transcodeEnabled(),
    h264_encoder: stream.h264EncoderName(),
  });
});

/** 首次访问自动签发本地密钥（浏览器端一次调用即可拿到 key 并缓存到 localStorage）。 */
route('GET', '/api-key', async (req, res) => {
  let k = keys.list().find((x) => x.enabled);
  if (!k) {
    const nk = keys.generate('auto');
    k = keys.list().find((x) => x.key === nk);
  }
  json(res, 200, { api_key: k.key, note: k.note, rate_per_min: RATE_PER_MIN });
});

async function handleSearch(req, res, ctx) {
  const p = ctx.url.searchParams;
  const q = p.get('q') || '';
  if (!q) return fail(res, 400, '缺少 q');
  const limit = p.get('limit');
  const results = await client.search(q, limit ? Number(limit) : undefined);
  return json(res, 200, { query: q, count: results.length, results });
}

route('GET', '/search', handleSearch);
// 兼容原版别名：/search/page 与 /search 同源，翻页由前端控制
route('GET', '/search/page', handleSearch);

route('GET', '/rank', async (req, res, ctx) => {
  const board = ctx.url.searchParams.get('board') || 'recommend';
  const limit = Number(ctx.url.searchParams.get('limit') || 30);
  if (!Object.keys(client.RANK_BOARDS).includes(board)) {
    return fail(res, 400, `board 必须是 ${Object.keys(client.RANK_BOARDS).join('|')}`);
  }
  const items = await client.rank(board, limit);
  json(res, 200, { board, name: client.RANK_NAMES[board], items });
});

route('GET', '/latest', async (req, res, ctx) => {
  const p = ctx.url.searchParams;
  const genre = p.get('genre') || 'short_play';
  if (!client.GENRES[genre]) return fail(res, 400, `genre 必须是 ${Object.keys(client.GENRES).join('|')}`);
  const onlyToday = p.get('only_today') !== 'false';
  const limit = Number(p.get('limit') || 120);
  const refresh = p.get('refresh') === 'true' || p.get('no_cache') === 'true';
  const items = await client.latest(genre, onlyToday, limit, refresh);
  const mode = genre === 'short_play'
    ? (onlyToday ? '今日上新' : '最新上架')
    : '7天内上新·最新上架';
  json(res, 200, {
    genre, name: client.GENRE_NAMES[genre], mode, only_today: onlyToday,
    count: items.length, items,
  });
});

route('GET', '/filters', async (req, res, ctx) => {
  const genre = ctx.url.searchParams.get('genre') || 'short_play';
  if (!client.GENRES[genre]) return fail(res, 400, `genre 必须是 ${Object.keys(client.GENRES).join('|')}`);
  const rows = await client.filters(genre);
  json(res, 200, { genre, name: client.GENRE_NAMES[genre], rows });
});

route('GET', '/browse', async (req, res, ctx) => {
  const p = ctx.url.searchParams;
  const genre = p.get('genre') || 'short_play';
  if (!client.GENRES[genre]) return fail(res, 400, `genre 必须是 ${Object.keys(client.GENRES).join('|')}`);
  const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const items = await client.browse(genre, {
    theme: csv(p.get('theme')), setting: csv(p.get('setting')), background: csv(p.get('background')),
    sort: p.get('sort') || 'online_time', gender: p.get('gender') || undefined,
    days: p.get('days') || undefined, status: p.get('status') || undefined,
    limit: Number(p.get('limit') || 60),
  });
  for (const it of items) {
    const sid = it.series_id;
    it.stream_url = it.vid ? `/stream?vid=${it.vid}` : `/stream?series_id=${sid}&ep=1`;
    it.episodes_url = `/episodes?series_id=${sid}`;
  }
  json(res, 200, { genre, name: client.GENRE_NAMES[genre], count: items.length, items });
});

route('GET', '/episodes', async (req, res, ctx) => {
  const sid = ctx.url.searchParams.get('series_id');
  if (!sid) return fail(res, 400, '缺少 series_id');
  const { meta, episodes } = await client.getEpisodes(sid);
  json(res, 200, { meta, episodes });
});

route('POST', '/metrics/batch', async (req, res, ctx) => {
  const payload = await readJson(req);
  const raw = payload.series_ids || payload.series_id || [];
  const ids = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) return fail(res, 400, 'series_ids 不能为空');
  if (ids.length > 200) return fail(res, 400, 'series_ids 最多 200 个');
  const [items, failed] = await client.getEpisodesBatch(ids, Number(payload.batch_size || 20));
  const rows = ids.filter((s) => items[s]).map((s) => items[s]);
  json(res, 200, { count: rows.length, items: rows, failed });
});

route('GET', '/play', async (req, res, ctx) => {
  const p = ctx.url.searchParams;
  const sid = p.get('series_id');
  if (!sid) return fail(res, 400, '缺少 series_id');
  const meta = await client.getEpisodes(sid);
  const want = new Set(parseRange(p.get('ep') || 'all', meta.episodes.length));
  const sel = meta.episodes.filter((e) => want.has(e.index || 0));
  const urls = await client.getVideoUrls(sel.map((e) => e.vid));
  const out = sel.map((e) => {
    const info = urls[e.vid] || {};
    return {
      index: e.index, vid: e.vid, title: e.title, duration: e.duration,
      encrypted_url: info.url, backup: info.backup, size: info.size,
      definition: info.definition, shape: info.shape, url_is_http: info.url_is_http,
      stream_url: `/stream?vid=${e.vid}`,
    };
  });
  json(res, 200, {
    series_id: sid, title: meta.meta.title,
    note: 'encrypted_url 为 CENC 密文直链；可播放用 stream_url（服务端纯离线解密）',
    episodes: out,
  });
});

/**
 * 预热下一集：立即返回，后台解密落盘。
 * 自动连播时提前调用，播完当前集切下一集就不用等下载解密。
 */
route('GET', '/prewarm', async (req, res, ctx) => {
  const p = ctx.url.searchParams;
  const vid = p.get('vid');
  if (!vid) return fail(res, 400, '需 vid');
  const state = await stream.prewarm(vid, p.get('quality') || 'best');
  json(res, 200, { ok: true, vid, state });
});

route('GET', '/video_url', async (req, res, ctx) => {
  const vid = ctx.url.searchParams.get('vid');
  if (!vid) return fail(res, 400, '缺少 vid');
  const urls = await client.getVideoUrls([vid]);
  const info = urls[String(vid)];
  if (!info || !info.url) return fail(res, 404, '无直链');
  json(res, 200, { vid, url: info.url, backup: info.backup, size: info.size, definition: info.definition });
});

/** 已解密串流：支持 Range 拖动，<video> 用 ?api_key= 传密钥。 */
route('GET', '/stream', async (req, res, ctx) => {
  const p = ctx.url.searchParams;
  let vid = p.get('vid');
  let filename = null;
  if (!vid) {
    const sid = p.get('series_id');
    if (!sid) return fail(res, 400, '需 series_id+ep 或 vid');
    const meta = await client.getEpisodes(sid);
    const idx = /^\d+$/.test(p.get('ep') || '1') ? Number(p.get('ep')) : 1;
    const target = meta.episodes.find((e) => (e.index || 0) === idx);
    if (!target) return fail(res, 404, '集号不存在');
    vid = target.vid;
    filename = `${client.sanitize(meta.meta.title)}_第${String(idx).padStart(3, '0')}集.mp4`;
  }
  const quality = p.get('quality') || 'best';
  const file = await stream.ensureDecrypted(vid, quality);
  const stat = await fsp.stat(file);
  filename = filename || `${vid}.mp4`;

  const cd = `inline; filename="${vid}.mp4"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start) || start < 0) start = 0;
    if (Number.isNaN(end) || end >= stat.size) end = stat.size - 1;
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      'content-type': 'video/mp4',
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'content-disposition': cd,
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range, accept-ranges, content-length',
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, {
    'content-type': 'video/mp4',
    'content-length': stat.size,
    'accept-ranges': 'bytes',
    'content-disposition': cd,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-range, accept-ranges, content-length',
  });
  fs.createReadStream(file).pipe(res);
});

/** 图片代理：红果封面常为 HEIC，浏览器不支持；此处透传并尽力转换。 */
const IMG_HOSTS = ['fqnovelpic.com', 'byteimg.com', 'qznovelvod.com', 'douyinpic.com', 'pstatp.com'];
const imgCache = new Map();

route('GET', '/img', async (req, res, ctx) => {
  const raw = (ctx.url.searchParams.get('url') || '').trim();
  let u;
  try { u = new URL(raw); } catch { return fail(res, 400, '图片 URL 非法'); }
  const host = u.hostname.toLowerCase();
  const allowed = ['http:', 'https:'].includes(u.protocol)
    && IMG_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (!allowed) return fail(res, 400, '图片域名不允许');
  if (imgCache.has(raw)) {
    return send(res, 200, imgCache.get(raw), {
      'content-type': 'image/jpeg', 'cache-control': 'max-age=86400',
    });
  }
  try {
    const r = await fetch(raw, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!r.ok) return fail(res, 404, `图片读取失败 HTTP ${r.status}`);
    const ct = (r.headers.get('content-type') || 'image/jpeg').toLowerCase();
    let data = Buffer.from(await r.arrayBuffer());
    // 尽力用 sharp/heic 转换；未安装则原样返回
    if (ct.includes('heic') || u.pathname.toLowerCase().endsWith('.heic')) {
      const converted = await tryConvertHeic(data);
      if (converted) data = converted;
    }
    if (imgCache.size < 1000) {
      imgCache.set(raw, data);
    }
    send(res, 200, data, { 'content-type': ct.includes('heic') ? 'image/jpeg' : ct, 'cache-control': 'max-age=86400' });
  } catch (e) {
    fail(res, 404, `图片读取失败: ${e.message}`);
  }
});

async function tryConvertHeic(buf) {
  try {
    const sharp = require('sharp');
    return await sharp(buf).jpeg({ quality: 88 }).toBuffer();
  } catch { return null; }
}

route('GET', '/download', async (req, res, ctx) => {
  const p = ctx.url.searchParams;
  const vid = p.get('vid');
  const sid = p.get('series_id');
  if (!vid && !sid) return fail(res, 400, '需 vid 或 series_id');
  if (sid && !vid) {
    const meta = await client.getEpisodes(sid);
    const idx = Number(p.get('ep') || 1);
    const t = meta.episodes.find((e) => (e.index || 0) === idx);
    if (!t) return fail(res, 404, '集号不存在');
    vid = t.vid;
  }
  const file = await stream.ensureDecrypted(vid, p.get('quality') || 'best');
  json(res, 200, { ok: true, path: file, size: (await fsp.stat(file)).size });
});

route('GET', '/stats', async (req, res, ctx) => {
  if (!checkAdmin(req, ctx.url)) return fail(res, 401, '需要 admin_token');
  json(res, 200, {
    uptime_s: Math.floor((Date.now() - stats.start) / 1000),
    requests: stats.requests, errors: stats.errors,
    risk: stats.risk, auth_fail: stats.authFail,
    cache_backend: 'memory',
    sign_backends: await signer.health(),
    enabled_keys: keys.countEnabled(),
  });
});

route('GET', '/admin/keys', async (req, res, ctx) => {
  if (!checkAdmin(req, ctx.url)) return fail(res, 401, 'admin_token 无效');
  json(res, 200, { keys: keys.list(), enabled_count: keys.countEnabled() });
});
route('POST', '/admin/keys', async (req, res, ctx) => {
  if (!checkAdmin(req, ctx.url)) return fail(res, 401, 'admin_token 无效');
  const key = keys.generate(ctx.url.searchParams.get('note') || '');
  json(res, 200, { ok: true, key, note: ctx.url.searchParams.get('note') || '' });
});
route('POST', '/admin/keys/revoke', async (req, res, ctx) => {
  if (!checkAdmin(req, ctx.url)) return fail(res, 401, 'admin_token 无效');
  const k = ctx.url.searchParams.get('key') || '';
  const enable = ctx.url.searchParams.get('enable') === 'true';
  json(res, 200, { ok: keys.revoke(k, enable) });
});
route('DELETE', '/admin/keys', async (req, res, ctx) => {
  if (!checkAdmin(req, ctx.url)) return fail(res, 401, 'admin_token 无效');
  json(res, 200, { ok: keys.delete(ctx.url.searchParams.get('key') || '') });
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      if (chunks.reduce((a, b) => a + b.length, 0) > 1e6) reject(new Error('body 过大'));
    });
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8');
      try { resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * 内联 favicon（SVG）。浏览器总会请求 /favicon.ico，
 * 缺文件会在控制台刷 404，这里直接返回内联 SVG，省掉一个二进制资源。
 */
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" rx="14" fill="#e11d48"/>'
  + '<text x="32" y="44" font-size="34" font-family="sans-serif" font-weight="bold"'
  + ' text-anchor="middle" fill="#fff">红</text></svg>';

/** 判断是否前端静态资源路径（页面、JS、CSS、图标等）。 */
function isStaticPath(pathname) {
  if (pathname === '/' || pathname === '/ui' || pathname === '/ui/') return true;
  return /\.(html|js|mjs|css|svg|png|jpg|jpeg|gif|ico|webp|woff2?|ttf|map)$/i.test(pathname);
}

/** 静态文件服务（前端）。 */
async function serveStatic(req, res, pathname) {
  // /favicon.ico 与 /favicon.svg 都返回内联 SVG（isStaticPath 会先命中 .ico/.svg）
  if (pathname === '/favicon.ico' || pathname === '/favicon.svg') {
    return send(res, 200, FAVICON_SVG, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'max-age=604800',
    });
  }
  let rel = pathname === '/ui' || pathname === '/ui/' ? '/index.html' : pathname;
  if (rel === '/') rel = '/index.html';
  // 目录穿越防护：规范化后必须仍位于 WEB_DIR 之内
  const root = path.resolve(WEB_DIR);
  const file = path.resolve(root, '.' + path.posix.normalize(rel));
  if (file !== root && !file.startsWith(root + path.sep)) return fail(res, 403, 'forbidden');
  try {
    const data = await fsp.readFile(file);
    send(res, 200, data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  } catch {
    // SPA 回退：无扩展名的路径一律回落到 index.html
    if (!path.extname(file)) {
      try {
        const data = await fsp.readFile(path.join(root, 'index.html'));
        return send(res, 200, data, { 'content-type': MIME['.html'] });
      } catch { /* 落到 404 */ }
    }
    fail(res, 404, 'not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,HEAD,POST,DELETE,OPTIONS',
      'access-control-allow-headers': 'content-type,x-api-key,x-admin-token,range',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  // 静态资源优先：前端页面与 JS/CSS 不参与 API 鉴权，
  // 否则浏览器加载页面时拿不到 app.js/styles.css（它们无法携带 api_key 头）。
  if (req.method === 'GET' && isStaticPath(pathname)) {
    return serveStatic(req, res, pathname);
  }

  // 鉴权：管理/统计自行校验；静态资源与健康检查免鉴权
  if (!EXEMPT.has(pathname) && !pathname.startsWith('/admin') && pathname !== '/stats') {
    const key = getKey(req, url);
    if (!keys.isValid(key)) {
      stats.authFail++;
      return fail(res, 401, '缺少或无效的 api_key（请在客户端配置本地链路密钥；首次访问可先请求 /api-key）');
    }
    if (!rateLimit(key)) {
      return fail(res, 429, `超过限流 ${RATE_PER_MIN}/分钟`);
    }
    stats.requests++;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const ctx = { params: {}, url, query: url.searchParams };
    r.keys.forEach((k, i) => { ctx.params[k] = m[i + 1]; });
    try {
      return await r.handler(req, res, ctx);
    } catch (e) {
      stats.errors++;
      if (e instanceof safeguards.RiskControlError) stats.risk++;
      const isAuth = e instanceof safeguards.AuthExpiredError;
      const extra = {};
      if (e.safe_response) extra.safe_response = e.safe_response;
      if (e.diagnostic) extra.response = e.diagnostic;
      if (e.modelShape) extra.model_shape = e.modelShape;
      return fail(res, isAuth ? 401 : 502, String(e.message || e), extra);
    }
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  fail(res, 404, 'not found');
});

if (require.main === module) {
  const boot = keys.ensureBootstrap();
  server.listen(PORT, HOST, () => {
    console.log(`[server] 红果短剧 Web API  http://${HOST}:${PORT}`);
    console.log(`[server] 前端页面        http://${HOST}:${PORT}/ui`);
    console.log(`[server] 签名后端        ${signer.signServers().join(', ') || '(未配置 SIGN_SERVER)'}`);
    console.log(`[server] 上游 host       ${client.HOST}`);
    if (boot) console.log(`[server] 已签发本地密钥   ${boot}`);
  });
}

module.exports = { server, ADMIN_TOKEN, PORT, HOST };
