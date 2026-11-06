'use strict';
/**
 * App 签名取直链，算法参考 jackotom/hongguo-drama 的 src/native/app-source.js。
 *
 * 为什么需要这个模块：老的 multi_video_model/preload/v1 链路对部分分集
 * （实测 vid=7693917197759958040）已不再返回 video_model 数据 —— data 为 null，
 * 表现为「预热失败：无直链 / video_model」。修复方式是换一条路：
 *   1. 改打 b 域名（api5-normal-sinfonlineb）的 multi_video_model/v1；
 *      设备身份见下方「2026-10-27 上游变化」；
 *   2. 响应里的 video_model 可能内联 video_list，也可能只给一个 fallback_api
 *      地址，二次 GET 才拿到 video_info.data.video_list；
 *   3. 媒体 URL 可能被 key_seed 加密（AES-128-CBC），需先解密；
 *   4. spade_a -> content key 的推导复用 Spade.unwrapV1。
 *
 * 2026-10-27 上游变化（同步自 jackotom/hongguo-drama 3.9 / 5febca2）：
 *   上游开始校验播放请求的设备身份：每次随机合成、互不关联的 iid/device_id
 *   会被软拦截 —— HTTP 200 + 0 字节 body，表现为「预热失败：App 接口未返回 data」。
 *   改为「匿名设备注册」：playback-device.js 调 device_register 注册匿名设备
 *   （进程内复用），播放请求 query 用注册返回的 device_id/iid。
 *
 * 2026-11-02 上游变化（同步自 jackotom/hongguo-drama 5.4 / 93e694e3）：
 *   只带注册身份已经不够，接口重新要求签名。现在按上游 5.4 的方式组装：
 *   1) query 末尾追加 ts（秒）与 _rticket（毫秒，递增到 branchOf === 0）；
 *   2) 带六个签名头（x-gorgon / x-khronos / x-ladon / x-argus / x-helios / x-medusa）；
 *   3) 空响应时换备用域 api5-normal-hl.fqnovel.com，并重新注册设备身份；
 *   4) 片源内联在 video_model.video_list 时无需再请求 fallback_api。
 *
 * 注意：本轮排查中最容易踩的坑不是「要不要签名」，而是签名算错 ——
 * core/pure-sign.js 的 hashF13 branch 0 曾经少推进一次状态，导致约 1/3 的请求
 * （iv 低 4 位落在 branch 0）签名无效、上游一律回 0 字节，表现和「限流」一模一样。
 */
const crypto = require('crypto');
const Spade = require('../core/spade');
const PureSign = require('../core/pure-sign');
const Safeguards = require('../core/safeguards');
const { getPlaybackDevice, resetPlaybackDevice } = require('./playback-device');
const Guard = require('./upstream-guard');
const Crypto = require('../util/crypto');
const Http = require('../util/http');
const Json = require('../util/json');
const Log = require('../util/log');

/** 接口主机（自检与排障用）。完整 URL 由 postPlayback 按 host 现拼。 */
const VIDEO_API_HOST = 'api5-normal-sinfonlineb.fqnovel.com';

/** 备用接口主机：主域空响应时换这条链路重签重发（上游 5.4 同款退路）。 */
const FALLBACK_VIDEO_HOST = 'api5-normal-hl.fqnovel.com';

const VIDEO_UA = 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; '
  + 'Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 '
  + 'QuicVersion:c67e9834 2025-09-08)';

/** 播放请求 UA（与「注册身份 + 六头签名」路径配套，区别于列表/搜索的 UA）。 */
const PLAYBACK_UA = 'com.phoenix.read/71532 (Linux; U; Android 9; SM-N9860; '
  + 'Build/PQ3A.190705.10241111;tt-ok/3.12.13.20)';

const VERSION_NAME = '7.1.3.32';

/** 请求域名白名单（他的 checkedUrl 域名表，防签名 body 被带往第三方）。 */
const API_DOMAINS = ['fqnovel.com', 'snssdk.com'];

/** 媒体 CDN 域名白名单。 */
const VOD_DOMAINS = ['qznovelvod.com', 'fqnovelvod.com', 'douyinvod.com'];

/** decryptSpadeUrl 的常量段（app-source.js constants，64 字节）。 */
const URL_CONSTANTS = Crypto.unhex(
  '4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524'
  + 'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58');

// ==================== 入口 ====================

/** ByteVC2 的 codec_type 取值（字节 BVC2，即 H.266/VVC 系）。 */
const CODEC_BYTEVC2 = 'bytevc2';

/** 「只有 BVC2 片源」的稳定错误码，供调用方分支判断（不要靠文案匹配）。 */
const ERR_BVC2_ONLY = 'BVC2_ONLY';

/** 只有 BVC2 时给用户的文案（前端另有同义文案，改这里要同步 web/app.js）。 */
const BVC2_ONLY_MSG = '本集仅提供 ByteVC2（H.266/VVC）片源，浏览器无法解码播放；'
  + '可下载到本地，用支持这种编码的播放器观看（播放器选择见 README）';

/**
 * 取某集的 App 直链。quality 为空 / best / auto 时按「H.264 优先、清晰度优先」
 * 自动选流；指定数值（如 1080p）时按短边尺寸升序偏好。
 *
 * @param {string|number} vid 分集 id
 * @param {string} [quality] 清晰度偏好，空 / best / auto 为自动
 * @param {object} [opts] 选项
 * @param {boolean} [opts.allowBvc2] 是否接受仅 BVC2 的片源。默认 false：
 *   BVC2 浏览器解不了，只有「下载到本地」与诊断才需要放行（放行后取到的
 *   仍是标准 mp4，落盘可用支持 VVC 的播放器播放）
 * @returns {Promise<{url,spadeA,encrypt,definition,size,codec}>} 可用轨道；
 *   任何一步失败都抛异常，由调用方决定是否回落老路
 */
async function fetch(vid, quality, opts) {
  if (vid === null || vid === undefined || !/^\d{1,30}$/.test(String(vid))) {
    throw new Error('分集编号无效');
  }

  // ---- 1. 签名 POST multi_video_model/v1（注册身份 + 六个签名头）----
  const body = Buffer.from(Json.stringify(payload(vid)));
  const identity = await getPlaybackDevice();
  const j = await postPlaybackWithRetry(body, identity);
  if (Json.optInt(j.Code, 0) !== 0 || Json.optInt(j.code, 0) !== 0) {
    throw new Error('App 接口暂未提供本集播放信息');
  }
  const data = Json.optObj(j.data);
  const entry = data === null ? null : Json.optObj(data[vid]);
  if (entry === null || isEmpty(entry)) {
    throw new Error('App 接口未返回所选分集');
  }
  const model = asObject(entry.video_model);
  if (isEmpty(model)) {
    throw new Error('App 接口未返回 video_model');
  }

  // ---- 2. 片源模型：新版可能直接内联在 video_model.video_list ----
  let info = model;
  if (!Array.isArray(model.video_list) || model.video_list.length === 0) {
    const fallback = parseFallback(model.fallback_api);
    if (fallback === null || fallback === '') {
      throw new Error('App 接口未返回本集片源地址');
    }
    const outer = await getPlain(checkedUrl(fallback, API_DOMAINS));
    const outerInfo = Json.optObj(outer.video_info);
    if (Json.optInt(outer.Code, 0) !== 0
        || Json.optInt(outer.code, 0) !== 0
        || Json.optInt(outerInfo === null ? null : outerInfo.Code, 0) !== 0) {
      throw new Error('App 接口暂未提供本集播放信息');
    }
    info = outerInfo === null ? null : Json.optObj(outerInfo.data);
  }
  if (info === null || isEmpty(info)) {
    throw new Error('App 接口未返回本集片源模型');
  }
  // video_list 可能是对象 map，也可能是数组（内联模型常见）
  const videoList = Json.optObj(info.video_list)
    || (Array.isArray(info.video_list) ? info.video_list : null);
  // key_seed 存在说明媒体 URL 是密文，需 AES 解密
  let seed = null;
  const seedStr = Json.optStr(info.key_seed, '');
  if (seedStr !== '') {
    seed = Crypto.base64Decode(seedStr);
  }

  // ---- 3. 选流（H.264 优先，其次清晰度）----
  const rows = [];
  if (videoList !== null) {
    for (const k of Object.keys(videoList)) {
      const r = toRow(Json.optObj(videoList[k]));
      if (r !== null) rows.push(r);
    }
  }
  const auto = quality === null || quality === undefined || quality === ''
    || quality === 'best' || quality === 'auto';
  const wantPx = auto ? 0 : pixelsOf(quality);
  const allowBvc2 = !!(opts && opts.allowBvc2);
  const ok = [];
  for (const r of rows) {
    // 浏览器只认 H.264 / HEVC，默认把它们之外的（含 bytevc2）全过滤掉。
    // allowBvc2 只给「下载到本地 / 诊断」用：这些片源浏览器播不了，
    // 但落盘后是剥净加密信令的普通 mp4，支持 ByteVC2 的播放器可以放。
    if (r.codecRank >= 2 && !(allowBvc2 && r.codec === CODEC_BYTEVC2)) continue;
    if (!auto && wantPx > 0 && r.shortSide < wantPx) continue;
    ok.push(r);
  }
  if (auto) {
    ok.sort((a, b) => a.codecRank !== b.codecRank
      ? a.codecRank - b.codecRank : b.pixels - a.pixels);
  } else {
    ok.sort((a, b) => a.shortSide !== b.shortSide
      ? a.shortSide - b.shortSide : a.codecRank - b.codecRank);
  }
  if (ok.length === 0) {
    // 整集只有 BVC2：给出可判断的错误码，让上层提示「请下载后本地播放」，
    // 而不是笼统的「暂未提供兼容片源」。
    if (rows.length > 0 && rows.every((r) => r.codec === CODEC_BYTEVC2)) {
      const vvcError = new Error(BVC2_ONLY_MSG);
      vvcError.code = ERR_BVC2_ONLY;
      vvcError.codec = CODEC_BYTEVC2;
      throw vvcError;
    }
    throw new Error('本集暂未提供兼容的 H.264/HEVC 片源');
  }

  // ---- 4. 逐候选解 URL 与密钥，取第一个可用的 ----
  // 注意返回的 spadeA 契约是「原始 base64 spade_a」——解包由
  // Stream.offlineDecrypt 统一完成（老路同此约定）。这里只预解一次
  // 用于判断该候选是否可用，不回存解出的 key。
  let last = null;
  for (const r of ok) {
    const spade = firstNonEmpty(r.item.spade_a,
      Json.optStr(child(r.item, 'encrypt_info').spade_a, ''));
    let keyOk = spade === '';
    if (spade !== '') {
      keyOk = Spade.isValidKey(Spade.unwrapV1(Crypto.base64Decode(spade), 0));
    }
    if (!keyOk) continue; // spade_a 解不出合法 key 的候选不可用
    for (const candidate of urlCandidates(r.item)) {
      try {
        const media = seed !== null
          ? decryptSpadeUrl(candidate, seed) : cleanUrl(candidate);
        const url = checkedUrl(media, VOD_DOMAINS);
        return {
          url,
          spadeA: spade,
          encrypt: spade !== '',
          definition: r.quality === '' ? '?' : r.quality,
          size: r.size,
          codec: r.codec,
        };
      } catch (ex) {
        last = ex;
      }
    }
  }
  throw new Error('本集片源地址或密钥无法解析: '
    + (last === null ? '无候选' : last.message));
}

// ==================== 请求构造 ====================

/** 请求体（biz_param 与老路一致；注意不带 dr_scene）。 */
function payload(vid) {
  const biz = Json.obj();
  biz.detail_page_version = 0;
  biz.device_level = 3;
  biz.disable_digg_stat = false;
  biz.need_all_video_definition = true;
  biz.need_mp4_align = false;
  biz.use_os_player = false;
  biz.use_server_dns = false;
  biz.video_platform = 1024;
  const mixed = Json.obj();
  mixed['1004'] = [vid];
  const out = Json.obj();
  out.biz_param = biz;
  out.mixed_video_id_map = mixed;
  return out;
}

/**
 * 查询类请求的基础设备参数（字段顺序固定 —— query 按插入序编码）。
 * 播放请求在此基础上追加注册身份的 device_id/iid 与 _rticket。
 */
const DEVICE_BASE = {
  ac: 'wifi',
  channel: 'update_64',
  aid: '8662',
  app_name: 'novelread',
  version_code: '71332',
  version_name: VERSION_NAME,
  device_platform: 'android',
  os: 'android',
  ssmix: 'a',
  device_type: '25053RT47C',
  device_brand: 'Redmi',
  language: 'zh',
  os_api: '36',
  os_version: '16',
  manifest_version_code: '71332',
  resolution: '1280*2772',
  dpi: '520',
  update_version_code: '71332',
  host_abi: 'arm64-v8a',
  dragon_device_type: 'phone',
  pv_player: '71332',
  compliance_status: '0',
  need_personal_recommend: '1',
  player_so_load: '1',
  is_android_pad_screen: '0',
};

/**
 * 合成设备身份仅保留 DEVICE_BASE：播放请求的 iid/device_id 由
 * playback-device 注册提供（2026-10-27 起随机身份会被上游软拦截），
 * 这里不再生成随机 ID。
 */

/**
 * 播放请求：注册身份 + 六个签名头。
 *
 * 2026-11-02 上游 5.4（jackotom/hongguo-drama 93e694e3）恢复了播放请求签名：
 * 接口重新校验 query + body + 时间戳的签名，只带注册身份的裸请求一律
 * HTTP 200 + 0 字节。同步过来的请求形态：
 *   1) query 在 device_id/iid 之后补 ts（秒级）与 _rticket（毫秒）；
 *   2) 抖动 _rticket 直到 branchOf(query, body, ts) === 0 —— 其它分支服务端不认；
 *   3) 六个签名头 + sdk-version / x-xs-from-web / x-tt-dt 等杂项头；
 *   4) 主域空响应时重新注册设备身份，换备用域重签重发（同身份连发会被判重）。
 *
 * query 编码必须与参考实现一致：python urllib.parse.quote 兜底只转 !'()，
 * `*` 保持原样（resolution=1280*2772）。签名对 query 字节级敏感，多编一个
 * 字符都会让服务端算出的摘要对不上。
 */
async function postPlayback(body, identity, host) {
  const khronos = Math.floor(Date.now() / 1000);
  const ticketBase = Date.now();
  const api = 'https://' + host + '/novel/player/multi_video_model/v1/';
  let url = '';
  let ticket = ticketBase;
  let branch = -1;
  // 分支为 0 才算签名可用；失败概率约 1/3，抖动通常 1-3 次就命中。
  for (let n = 0; n < 128; n += 1) {
    ticket = ticketBase + n;
    const q = Object.assign({}, DEVICE_BASE, {
      device_id: identity.device_id,
      iid: identity.iid,
      ts: String(khronos),
      _rticket: String(ticket),
    });
    let qs = '';
    for (const k of Object.keys(q)) {
      if (qs.length > 0) qs += '&';
      qs += pyEncode(k) + '=' + pyEncode(String(q[k]));
    }
    url = api + '?' + qs;
    branch = PureSign.branchOf(url, body, khronos);
    if (branch === 0) break;
  }
  if (branch !== 0) {
    const error = new Error('无法生成播放请求签名');
    error.code = 'PLAYBACK_SIGN_FAILED';
    throw error;
  }

  const headers = {};
  headers['User-Agent'] = PLAYBACK_UA;
  headers.Accept = 'application/json; charset=utf-8,application/x-protobuf';
  headers['Content-Type'] = 'application/json; charset=UTF-8';
  headers['x-ss-req-ticket'] = String(ticket);
  headers['sdk-version'] = '2';
  headers['x-xs-from-web'] = '0';
  Object.assign(headers, PureSign.sign(url, body, khronos));
  headers['x-tt-dt'] = '';
  headers['x-tt-store-region'] = 'cn';
  headers['x-tt-store-region-src'] = 'did';

  const res = await Http.send({
    url, method: 'POST', timeoutMs: 15000, headers, body,
  });
  if (res.status !== 200) {
    throw new Error('App 接口 HTTP ' + res.status);
  }
  const text = res.text();
  const j = Json.parseObject(text);
  if (j === null || Json.optObj(j.data) === null) {
    // 空响应：签名/身份被拒，或同一设备身份重复取流被判重（重试时会换身份）。
    // 文案不要把排查引向本机网络 —— 本机到上游是通的，注册也正常。
    const emptyBody = text.trim() === '';
    const hint = emptyBody ? '（空响应，疑似上游限流或设备身份被判重，非本机网络问题）' : '';
    const error = new Error('App 接口未返回 data' + hint
      + (Log.env('HG_APPSOURCE_DEBUG', null) !== null
        ? '（原始响应: ' + text + '）' : ''));
    if (emptyBody) {
      error.code = 'PLAYBACK_EMPTY_RESPONSE';
      error.deviceId = identity.device_id;
    }
    throw error;
  }
  return j;
}

/**
 * 带备用域、身份轮换与熔断计数的播放请求。
 *
 * 一次 fetch 只消耗一次熔断预算：主域空响应 → 重新注册身份、换备用域再试一次，
 * 两次都空才记一次失败。上游 5.4 的说法是「备用主机或更新设备后重新签名」，
 * 换域本身不保证成功，所以不做无限重试，只留这一条确定的退路。
 */
async function postPlaybackWithRetry(body, identity) {
  // 熔断中：直接快速失败，不再打上游（整剧下载会连试几十集，每次都白等超时）
  if (!Guard.acquire()) {
    const blocked = new Error(Guard.blockedMessage());
    blocked.code = 'PLAYBACK_CIRCUIT_OPEN';
    blocked.deviceId = identity.device_id;
    throw blocked;
  }

  const hosts = [VIDEO_API_HOST, FALLBACK_VIDEO_HOST];
  let current = identity;
  let last = null;
  for (let i = 0; i < hosts.length; i += 1) {
    try {
      const j = await postPlayback(body, current, hosts[i]);
      Guard.reportOk();
      return j;
    } catch (error) {
      last = error;
      // 签名生成失败、HTTP 5xx 这类不是「空响应」，换域也没意义
      if (error.code !== 'PLAYBACK_EMPTY_RESPONSE') throw error;
      if (i + 1 < hosts.length) {
        await Safeguards.sleep(300);
        // 空响应基本是「同一设备身份短时间内重复取流」被判重（同一集隔几秒
        // 单发就能过）。换域只是换入口，身份不变照样空，所以这里连身份一起换：
        // 丢掉被判重的注册结果、重新注册，再用新身份打备用域。
        try {
          await resetPlaybackDevice(current.device_id);
          current = await getPlaybackDevice();
        } catch (e) {
          // 注册失败就沿用原身份，让备用域还有一次机会
        }
      }
    }
  }
  Guard.reportEmpty();
  throw last;
}

/** fallback_api 的普通 GET：不带签名，只带 UA。 */
async function getPlain(url) {
  const res = await Http.send({
    url, method: 'GET', timeoutMs: 15000, headers: { 'User-Agent': VIDEO_UA },
  });
  if (res.status !== 200) {
    throw new Error('fallback HTTP ' + res.status);
  }
  return Json.parseObject(res.text());
}

/**
 * query 键值编码：未保留字符编 %XX（大写）。
 * 保留集 = JS encodeURIComponent 的不编码集减去需显式转码的 !'()，
 * 因此直接用内置 encodeURIComponent，再补转这 4 个字符。
 * 注意 `*` 不转：参考实现（python urllib.parse.quote 兜底）原样保留，
 * resolution=1280*2772 里的星号就在此列，签名按 query 原文计算。
 */
function pyEncode(raw) {
  return encodeURIComponent(String(raw))
    .replace(/[!'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// ==================== 响应解析 ====================

/** video_model 可能是 JSON 字符串或对象。 */
function asObject(v) {
  if (typeof v === 'string') {
    try {
      return Json.parseObject(v);
    } catch (e) {
      return Json.obj();
    }
  }
  const m = Json.optObj(v);
  return m === null ? Json.obj() : m;
}

/** 取子对象；缺失返回空 map（Json.optObj 对 null 返回 null，链式调用会踩 NPE）。 */
function child(m, key) {
  if (m === null || m === undefined) return Json.obj();
  const c = Json.optObj(m[key]);
  return c === null ? Json.obj() : c;
}

function isEmpty(m) {
  return m === null || m === undefined || Object.keys(m).length === 0;
}

/**
 * fallback_api 可能是 URL 字符串、[url]、{"fallback_api": url}
 * 或内嵌 JSON 的字符串。
 */
function parseFallback(v) {
  if (typeof v === 'string') {
    let parsed;
    try {
      parsed = Json.parseObject(v);
    } catch (e) {
      return v;
    }
    const fb = parsed.fallback_api;
    return fb === null || fb === undefined ? v : String(fb);
  }
  if (Array.isArray(v)) {
    return v.length === 0 ? '' : String(v[0]);
  }
  const o = Json.optObj(v);
  const fb = o === null ? undefined : o.fallback_api;
  return fb === null || fb === undefined ? '' : String(fb);
}

/** 一条候选流的评分信息。 */
class Row {
  constructor(item, codec, codecRank, quality, pixels, shortSide, size) {
    this.item = item;
    this.codec = codec;
    this.codecRank = codecRank;
    this.quality = quality;
    this.pixels = pixels;
    this.shortSide = shortSide;
    this.size = size;
  }
}

function toRow(item) {
  if (item === null || isEmpty(item)) return null;
  const meta = child(item, 'video_meta');
  const codec = Json.optStr(item.codec_type,
    Json.optStr(meta.codec_type, '')).toLowerCase();
  const rankV = rank(codec);
  const quality = firstNonEmpty(
    Json.optStr(item.quality_desc, ''),
    Json.optStr(item.definition, ''),
    Json.optStr(item.height, ''),
    Json.optStr(item.vheight, ''),
    Json.optStr(meta.definition, ''));
  const px = pixelsOf(quality);
  let w = 0;
  let h = 0;
  const pairs = [
    [Json.optInt(item.vwidth, 0), Json.optInt(item.vheight, 0)],
    [Json.optInt(item.width, 0), Json.optInt(item.height, 0)],
    [Json.optInt(meta.vwidth, 0), Json.optInt(meta.vheight, 0)],
    [Json.optInt(meta.width, 0), Json.optInt(meta.height, 0)],
  ];
  for (const p of pairs) {
    if (p[0] > 0 && p[1] > 0) { w = p[0]; h = p[1]; break; }
  }
  let size = Json.optLong(meta.size, 0);
  if (size === 0) size = Json.optLong(item.size, 0);
  return new Row(item, codec, rankV, quality, px, Math.min(w, h), size);
}

function rank(codec) {
  if (codec === 'h264' || codec === 'avc' || codec === 'avc1') return 0;
  if (codec === 'hevc' || codec === 'h265' || codec === 'hvc1'
      || codec === 'hev1' || codec === 'bytevc1') return 1;
  return 2;
}

/** 取字符串里第一组数字；无则 0。 */
function pixelsOf(s) {
  if (s === null || s === undefined) return 0;
  const m = /(\d+)/.exec(String(s));
  return m ? parseInt(m[1], 10) : 0;
}

/** main_url / backup_url / backup_url_list 的候选序列。 */
function urlCandidates(item) {
  const out = [];
  addStr(out, item.main_url);
  addStr(out, item.backup_url);
  const list = item.backup_url_list;
  if (Array.isArray(list)) {
    for (const o of list) addStr(out, o);
  }
  return out;
}

function addStr(out, v) {
  if (typeof v === 'string' && v !== '') out.push(v);
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}

/** 清掉上游常见的转义形式（他的 cleanUrl）。 */
function cleanUrl(value) {
  return String(value).replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
}

// ==================== URL 解密与校验 ====================

/**
 * 解密 spade URL：seed 双 sha512 派生 AES-128-CBC 密钥/IV。
 * 布局：[0]=0xa8, [1]=?, [2]=0x01, [3]=0x00, [4:]=密文（16 字节整块）。
 */
function decryptSpadeUrl(value, seed) {
  const raw = Crypto.base64Decode(value);
  if (raw.length < 5) throw new Error('spade URL 密文过短');
  if ((raw[0] & 0xff) !== 0xa8 || (raw[2] & 0xff) !== 0x01 || (raw[3] & 0xff) !== 0x00) {
    throw new Error('spade URL 头格式错误');
  }
  const cipherLength = Math.floor((raw.length - 4) / 16) * 16;
  if (cipherLength === 0) throw new Error('spade URL 无完整块');

  const h1 = crypto.createHash('sha512').update(seed).digest();
  const h2 = crypto.createHash('sha512')
    .update(Buffer.concat([h1, URL_CONSTANTS])).digest();

  const decipher = crypto.createDecipheriv('aes-128-cbc',
    h2.subarray(0, 16), h2.subarray(16, 32));
  decipher.setAutoPadding(false);
  const pt = Buffer.concat([
    decipher.update(raw.subarray(4, 4 + cipherLength)),
    decipher.final(),
  ]);

  let end = pt.length;
  if (end > 0) {
    const pad = pt[end - 1] & 0xff;
    if (pad >= 1 && pad <= 16 && pad <= end) end -= pad;
  }
  while (end > 0 && pt[end - 1] === 0) end--;
  return pt.subarray(0, end).toString();
}

/**
 * 媒体/接口 URL 白名单校验：必须 https、无用户信息、端口为 443，
 * 且 host 等于白名单域名或其子域。防签名 body 被重定向带往第三方。
 */
function checkedUrl(value, domains) {
  let u;
  try {
    u = new URL(String(value));
  } catch (e) {
    throw new Error('URL 格式无效');
  }
  const scheme = u.protocol.replace(/:$/, '');
  const host = u.hostname;
  const port = u.port;
  const portOk = port === '' || port === '443';
  let hostOk = false;
  if (host !== '') {
    for (const d of domains) {
      if (host === d || host.endsWith('.' + d)) { hostOk = true; break; }
    }
  }
  const hasUserInfo = u.username !== '' || u.password !== '';
  if (scheme !== 'https' || hasUserInfo || !portOk || !hostOk) {
    throw new Error('不受支持的服务地址: ' + value);
  }
  return u.toString();
}

module.exports = {
  fetch,
  resetPlaybackDevice,
  DEVICE_BASE,
  CODEC_BYTEVC2,
  ERR_BVC2_ONLY,
  BVC2_ONLY_MSG,
  pyEncode,
  pixelsOf,
  cleanUrl,
  decryptSpadeUrl,
  checkedUrl,
  VIDEO_API_HOST,
  FALLBACK_VIDEO_HOST,
  VIDEO_UA,
  VERSION_NAME,
  API_DOMAINS,
  VOD_DOMAINS,
  URL_CONSTANTS,
};
