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
 * 2026-11-10 上游变化（同步自 jackotom/hongguo-drama 6.6 / d0410c8）：
 *   上游调整了 multi_video_model/v1 的请求格式，按新格式修补空响应问题：
 *   1) 请求体改为 gzip 压缩 JSON，x-ss-stub 摘要与六个签名头都对实际发送
 *      的同一份压缩 Buffer 计算，并带 Content-Encoding: gzip；
 *   2) 播放专用客户端版本统一提升到 74332 / 7.4.3.32：UA、query 设备字段、
 *      x-medusa 签名内设备字段三处一致（见 PLAYBACK_DEVICE）；
 *   3) 补齐 x-ss-stub（正文摘要）、x-ss-dp（应用标识）、passport-sdk-version 头；
 *   4) 每次取流注册全新匿名身份（播放身份视为一次性；同一身份短时间内重复
 *      取流会被上游判重返回空响应，见 playback-device.js 的 fresh 模式）；
 *   5) 空响应文案改为「原因尚未确认」——签名、身份、限流等归因均未经证实。
 *
 * 2026-11-10 上游 6.7（549d4d1，整合 ZainCheung PR #133）：空响应的恢复
 *   路径换成签名 GET video_tab，实测修复播放（同一网络同一剧号修复前
 *   EMPTY_RESPONSE、修复后取到完整片源）：
 *   1) 旧 POST multi_video_model/v1 空响应后，第二次请求不再换备用域重复
 *      同一路径（实测照样空），改为签名 GET
 *      /reading/bookapi/video_tab/multi_video_model/v1/；
 *   2) GET 用 73932 / 7.3.9.32 版本字段（VIDEO_TAB_DEVICE，与注册 body 的
 *      版本资料一致），query 带 video_id 等业务参数（含空的 from_video_id），
 *      无正文：不带 gzip / Content-Type / x-ss-stub，带 x-tt-request-tag；
 *   3) 响应从 data.video_model_data[vid].video_model 提取（旧 POST 仍在
 *      data[vid]），video_list 兼容对象 map 与数组两种形态；
 *   4) 片源模型仍走原有画质 / 域名白名单 / 密钥与 fallback 校验。
 *   参数与响应结构参考 tsukiyo-zero/hongguoTV 的 tabVideoModel（GPL-3.0-only）。
 *
 * 注意：本轮排查中最容易踩的坑不是「要不要签名」，而是签名算错 ——
 * core/pure-sign.js 的 hashF13 branch 0 曾经少推进一次状态，导致约 1/3 的请求
 * （iv 低 4 位落在 branch 0）签名无效、上游一律回 0 字节，表现和「限流」一模一样。
 */
const crypto = require('crypto');
const zlib = require('zlib');
const Spade = require('../core/spade');
const PureSign = require('../core/pure-sign');
const Safeguards = require('../core/safeguards');
const { getPlaybackDevice, resetPlaybackDevice } = require('./playback-device');
const Guard = require('./upstream-guard');
const Crypto = require('../util/crypto');
const Http = require('../util/http');
const Json = require('../util/json');
const Log = require('../util/log');

/** 接口主机（自检与排障用）。完整 URL 由 postPlayback 现拼。 */
const VIDEO_API_HOST = 'api5-normal-sinfonlineb.fqnovel.com';

/**
 * video_tab 恢复接口（上游 6.7）：旧 POST 空响应后的签名 GET 退路。
 * 实测换备用域重复同一条 POST 路径照样空，只有这条 GET 能拿到模型。
 */
const VIDEO_TAB_API = 'https://' + VIDEO_API_HOST
  + '/reading/bookapi/video_tab/multi_video_model/v1/';

const VIDEO_UA = 'com.phoenix.read/71332 (Linux; U; Android 16; zh_CN; 25053RT47C; '
  + 'Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 '
  + 'QuicVersion:c67e9834 2025-09-08)';

/**
 * 播放请求 UA（与「注册身份 + 六头签名」路径配套，区别于列表/搜索的 UA）。
 * 2026-11-10 起客户端版本统一提升到 74332：UA、query 设备字段与签名内
 * 设备字段三处一致（上游 6.6 同款，从 VIDEO_UA 派生保证机型段不变）。
 */
const PLAYBACK_UA = VIDEO_UA.replace('71332', '74332');

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
  // 2026-11-10 起请求体为 gzip 压缩 JSON：x-ss-stub 摘要与签名都按这份
  // 压缩 Buffer 计算，发送的也是它（上游 6.6：摘要、签名、正文同源）。
  const body = zlib.gzipSync(Buffer.from(Json.stringify(payload(vid))));
  // 播放身份视为一次性：每次取流注册全新匿名身份。同一身份短时间内重复
  // 取流会被上游判重返回空响应 —— 常驻复用身份正是「第一次能播、之后连
  // 续空响应进熔断」的根源。
  const identity = await getPlaybackDevice({ fresh: true });
  const j = await postPlaybackWithRetry(body, vid, identity);
  if (Json.optInt(j.Code, 0) !== 0 || Json.optInt(j.code, 0) !== 0) {
    throw new Error('App 接口暂未提供本集播放信息');
  }
  // video_tab 恢复响应的模型嵌在 data.video_model_data 下；旧 POST 直接在
  // data[vid]。两者都归一成「分集 id -> 条目」再取本集。
  const data = Json.optObj(j.data);
  const tabData = data === null ? null : Json.optObj(data.video_model_data);
  const entries = tabData !== null ? tabData : data;
  const entry = entries === null ? null : Json.optObj(entries[vid]);
  if (entry === null || isEmpty(entry)) {
    throw new Error('App 接口未返回所选分集');
  }
  const model = asObject(entry.video_model);
  if (isEmpty(model)) {
    throw new Error('App 接口未返回 video_model');
  }

  // ---- 2. 片源模型：新版可能直接内联在 video_model.video_list ----
  // video_tab 返回的 video_list 是对象 map，旧 POST 内联形态是数组，两种
  // 都算「有内联片源」；非空判断必须两种形态都覆盖。
  let info = model;
  const inlineList = model.video_list;
  const inlineObj = Array.isArray(inlineList) ? null : Json.optObj(inlineList);
  const hasInline = Array.isArray(inlineList)
    ? inlineList.length > 0
    : (inlineObj !== null && Object.keys(inlineObj).length > 0);
  if (!hasInline) {
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
 * 播放专用设备参数：在 DEVICE_BASE 基础上把客户端版本统一提升到 74332
 * （7.4.3.32，上游 6.6 同款）。UA、query、x-medusa 签名内的设备字段三处
 * 必须一致 —— pure-sign 的 x-medusa 直接取 query 里的 version_name/device_id，
 * 所以 query 用这份参数，签名内的版本自然同步。
 */
const PLAYBACK_DEVICE = Object.assign({}, DEVICE_BASE, {
  version_code: '74332',
  version_name: '7.4.3.32',
  manifest_version_code: '74332',
  update_version_code: '74332',
  pv_player: '74332',
});

/**
 * video_tab 恢复请求的设备参数：版本字段用 73932 / 7.3.9.32，与注册
 * body 里的版本资料一致（上游 6.7 同款，参考 hongguoTV 的 tabVideoModel）。
 */
const VIDEO_TAB_DEVICE = Object.assign({}, DEVICE_BASE, {
  version_code: '73932',
  version_name: '7.3.9.32',
  manifest_version_code: '73932',
  update_version_code: '73932',
  pv_player: '73932',
});

/**
 * 合成设备身份仅保留 DEVICE_BASE：播放请求的 iid/device_id 由
 * playback-device 注册提供（2026-10-27 起随机身份会被上游软拦截），
 * 这里不再生成随机 ID。
 */

/**
 * 播放请求：注册身份 + 六个签名头；两种形态由 videoId 区分。
 *
 * 旧 POST（videoId 为空，6.6 格式）：
 *   请求体 gzip 压缩 JSON，x-ss-stub 摘要与签名都对发送的同一份压缩体
 *   计算，带 Content-Encoding: gzip；客户端版本 74332 / 7.4.3.32
 *   （PLAYBACK_DEVICE），UA、query、签名内设备字段三处一致。
 *
 * video_tab GET（videoId 非空，6.7 恢复路径）：
 *   无正文签名（按 16 个零字节，不是空串 MD5），不带 gzip / Content-Type /
 *   x-ss-stub，带 x-tt-request-tag；客户端版本 73932 / 7.3.9.32
 *   （VIDEO_TAB_DEVICE，与注册 body 的版本资料一致）；query 带业务参数
 *   video_id / video_id_type / … / from_video_id（空串）。
 *
 * 共同形态（自 5.4 恢复签名起）：
 *   1) query 在设备字段与业务参数之后补 ts（秒级）与 _rticket（毫秒）；
 *   2) 抖动 _rticket 直到 branchOf(query, body, ts) === 0 —— 其它分支服务端不认；
 *   3) 六个签名头 + sdk-version / x-xs-from-web / passport-sdk-version 等杂项头。
 *
 * query 编码必须与参考实现一致：python urllib.parse.quote 兜底只转 !'()，
 * `*` 保持原样（resolution=1280*2772）。签名对 query 字节级敏感，多编一个
 * 字符都会让服务端算出的摘要对不上。
 *
 * @param {Buffer|null} body POST 模式的 gzip 压缩体；GET 模式忽略
 * @param {string|undefined} videoId video_tab 模式的分集 id；空串/undefined 走旧 POST
 * @param {boolean} [connectionClose] 重试那一次置 true：带 Connection: close，
 *   不复用上一请求的连接（上游同款）
 */
async function postPlayback(body, identity, videoId, connectionClose) {
  const tab = videoId !== null && videoId !== undefined && videoId !== '';
  const device = tab ? VIDEO_TAB_DEVICE : PLAYBACK_DEVICE;
  const khronos = Math.floor(Date.now() / 1000);
  const ticketBase = Date.now();
  const api = tab ? VIDEO_TAB_API
    : 'https://' + VIDEO_API_HOST + '/novel/player/multi_video_model/v1/';
  // video_tab 的业务参数（上游 6.7，参考 hongguoTV tabVideoModel）：
  // 全字符串、含空的 from_video_id，插在设备字段之后、ts/_rticket 之前。
  const values = tab ? {
    video_id: String(videoId),
    video_id_type: '0',
    device_level: '1',
    need_all_video_definition: '1',
    need_mp4_align: '0',
    use_os_player: '0',
    video_platform: '1024',
    source: '0',
    from_video_id: '',
  } : {};
  let url = '';
  let ticket = ticketBase;
  let branch = -1;
  // 分支为 0 才算签名可用；失败概率约 1/3，抖动通常 1-3 次就命中。
  for (let n = 0; n < 128; n += 1) {
    ticket = ticketBase + n;
    const q = Object.assign({}, device, {
      device_id: identity.device_id,
      iid: identity.iid,
      // 注册身份的第三个字段：参考实现 query 一直带 cdid
      cdid: identity.cdid,
    }, values, {
      ts: String(khronos),
      _rticket: String(ticket),
    });
    let qs = '';
    for (const k of Object.keys(q)) {
      if (qs.length > 0) qs += '&';
      qs += pyEncode(k) + '=' + pyEncode(String(q[k]));
    }
    url = api + '?' + qs;
    // 无正文 GET 按 16 个零字节参与签名（branchOf 对 null 的处理与上游一致）
    branch = PureSign.branchOf(url, tab ? null : body, khronos);
    if (branch === 0) break;
  }
  if (branch !== 0) {
    const error = new Error('无法生成播放请求签名');
    error.code = 'PLAYBACK_SIGN_FAILED';
    throw error;
  }

  const headers = {};
  headers['User-Agent'] = VIDEO_UA.replace('71332', device.version_code);
  headers.Accept = 'application/json; charset=utf-8,application/x-protobuf';
  headers['x-ss-req-ticket'] = String(ticket);
  headers['sdk-version'] = '2';
  headers['x-xs-from-web'] = '0';
  headers['passport-sdk-version'] = tab ? '50561' : '5051452';
  headers['x-ss-dp'] = String(device.aid);
  Object.assign(headers, PureSign.sign(url, tab ? null : body, khronos));
  headers['x-tt-dt'] = '';
  headers['x-tt-store-region'] = 'cn';
  headers['x-tt-store-region-src'] = 'did';
  if (tab) {
    headers['x-tt-request-tag'] = 't=0;n=0';
  } else {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
    headers['Content-Encoding'] = 'gzip';
    // 正文摘要对实际发送的 gzip Buffer 计算（上游 6.6：摘要与签名同源）
    headers['x-ss-stub'] = Crypto.md5HexUpper(body);
  }
  if (connectionClose === true) headers.Connection = 'close';

  const res = await Http.send({
    url, method: tab ? 'GET' : 'POST', timeoutMs: 15000, headers,
    body: tab ? null : body,
  });
  if (res.status !== 200) {
    throw new Error('App 接口 HTTP ' + res.status);
  }
  const text = res.text();
  const j = Json.parseObject(text);
  if (j === null || Json.optObj(j.data) === null) {
    // 空响应（HTTP 200 + 空 body 或缺 data）：上游未公开具体原因，签名、
    // 身份判重、限流等归因都未经证实，文案不给结论（上游 6.6 b0b2b5a 同款，
    // 避免把排查引向错误方向 —— 本机到上游是通的，注册也正常）。
    const emptyBody = text.trim() === '';
    const hint = emptyBody ? '（HTTP 200 空响应，原因尚未确认）' : '';
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
 * 两次尝试共用一次熔断预算：先走旧 POST；空响应后注册全新身份、改打签名
 * GET video_tab（上游 6.7）。实测换备用域重复同一条 POST 路径照样空，
 * 所以备用域退路已移除；明确的 HTTP / 业务拒绝不触发恢复。
 */
async function postPlaybackWithRetry(body, vid, identity) {
  // 熔断中：直接快速失败，不再打上游（整剧下载会连试几十集，每次都白等超时）
  if (!Guard.acquire()) {
    const blocked = new Error(Guard.blockedMessage());
    blocked.code = 'PLAYBACK_CIRCUIT_OPEN';
    blocked.deviceId = identity.device_id;
    throw blocked;
  }

  const attempts = ['', String(vid)];
  let current = identity;
  let last = null;
  for (let i = 0; i < attempts.length; i += 1) {
    try {
      // 第二次尝试带 Connection: close（上游同款），不复用上一请求的连接
      const j = await postPlayback(body, current, attempts[i], i > 0);
      Guard.reportOk();
      return j;
    } catch (error) {
      last = error;
      // 签名生成失败、HTTP 5xx 这类不是「空响应」，换路径也没意义
      if (error.code !== 'PLAYBACK_EMPTY_RESPONSE') throw error;
      if (i + 1 < attempts.length) {
        await Safeguards.sleep(300);
        // 空响应时连身份一起换：播放身份视为一次性，被判重/被拒的身份没有
        // 复用价值。注册失败就沿用原身份，让 video_tab 还有一次机会（上游同款）。
        try {
          current = await getPlaybackDevice({ fresh: true });
        } catch (e) {
          // 注册失败就沿用原身份，让 video_tab 还有一次机会
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
  PLAYBACK_DEVICE,
  VIDEO_TAB_DEVICE,
  PLAYBACK_UA,
  CODEC_BYTEVC2,
  ERR_BVC2_ONLY,
  BVC2_ONLY_MSG,
  pyEncode,
  pixelsOf,
  cleanUrl,
  decryptSpadeUrl,
  checkedUrl,
  VIDEO_API_HOST,
  VIDEO_UA,
  VERSION_NAME,
  API_DOMAINS,
  VOD_DOMAINS,
  URL_CONSTANTS,
};
