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
 * 2026-11-11 上游 6.9（b364419）：空响应的真正原因是播放签名无效 ——
 *   此前 x-argus / x-ladon 只是 be32/le32(khronos) 的 base64 占位，6.9 换成了
 *   真正的 551 Argus（Simon + protobuf + AES）与 Ladon（见 core/playback-sign.js）。
 *   同时按 6.9 调整了三个行为：
 *   1) 优先打 video_tab 签名 GET（无正文、无需 gzip），空响应才退回旧 POST；
 *      签名绑定最终 query 与实际 body，不再抖动 _rticket 找 branchOf === 0
 *      —— 那条分支规则是占位签名时代的产物，真实签名不需要；
 *   2) 播放取流（含匿名注册）走同一条共享节奏：同一时刻只放行一个请求，
 *      两次之间至少间隔 PLAYBACK_INTERVAL_MS，避免整剧预热/下载突发；
 *   3) 签名头绑定 URL，所以带签名的跳转一律拒绝（POST 本来就不跟随）。
 *
 *   实测（2026-11-11）：修复前同一分集 PLAYBACK_EMPTY_RESPONSE；换成真实签名后
 *   同一分集 ~300ms 返回 25KB 完整模型，GET / POST 两条路径都成立。
 *
 * 2026-11-16 上游变化（同步自 N3urda/hongguoTV，SIGNING_V5.md / 0.16.6）：
 *   551 Argus/Ladon 签名再次被上游拒绝（HTTP 200 空 body）。播放取流整体换到
 *   Android v04.10.03 的 v5 签名链：
 *   1) 端点换成 a 域名 POST /novel/player/multi_video_model/player/v1（gzip JSON）；
 *   2) 签名头改为 x-khronos / x-helios / x-medusa 三个（v5 Medusa/Helios/Khronos，
 *      由 core/pure-sign.js 的 signPlaybackV5 计算），并抖动 _rticket 选 branch 0；
 *   3) 请求体 device_level=1、带 disable_video_relate_book 与 dr_scene="player"；
 *   4) 响应模型从 data.1004[vid].video_model（1004 缺失退回 data[vid]）提取。
 *
 * 2026-11-20 空响应恢复（同步自 N3urda/hongguoTV 0.16.10 / 478f006）：
 *   v5 POST 仍会间歇性返回 HTTP 200 + 0 字节。上游的恢复方式不是换身份、也不是
 *   重复同一条 POST，而是用**同一个注册身份**补一次签名 GET video_tab：
 *   1) 端点 b 域名 /reading/bookapi/video_tab/multi_video_model/v1/，无正文，
 *      签名仍是 v5 Medusa/Helios/Khronos（body 传 null，不签 Content-Type /
 *      x-ss-stub），query 用 73932 / 7.3.9.32 版本族 + video_id 等业务参数；
 *   2) 严格只认本集：从 data.video_model_data[vid]（旧形态 data[vid]）取，
 *      响应对不上这一集时按原样抛回**最初的空响应错误**，绝不拿别的分集顶替；
 *   3) 响应带 Retry-After 时判为限流，不做这次补请求，直接交给熔断退避。
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

/** 接口主机（自检与排障用）。旧 b 域名；v5 播放已换到 a 域名的 V5_PLAYER_API。 */
const VIDEO_API_HOST = 'api5-normal-sinfonlineb.fqnovel.com';

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

// ==================== v5 播放取流（Android v04.10.03 Medusa/Helios/Khronos） ====================
// 2026-11-16 起上游改用 /novel/player/multi_video_model/player/v1（a 域名），并校验
// 真正的 v5 medusa/helios/khronos 签名（此前 551 Argus/Ladon 被拒，返回 HTTP 200 空 body）。
// 移植自 N3urda/hongguoTV（SIGNING_V5.md / MobilePlayback.kt / Signer.kt，GPL-3.0-only）。

/** v5 播放模型接口（a 域名，POST + gzip JSON）。 */
const V5_PLAYER_API = 'https://api5-normal-sinfonlinea.fqnovel.com'
  + '/novel/player/multi_video_model/player/v1';

/** 空响应恢复接口（b 域名，签名 GET，无正文；上游 0.16.10 同款）。 */
const VIDEO_TAB_API = 'https://' + VIDEO_API_HOST
  + '/reading/bookapi/video_tab/multi_video_model/v1/';

/** v5 播放请求 UA（对齐 N3urda/hongguoTV MobilePlayback 的厂商 UA）。 */
const V5_PLAYER_UA = 'com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; '
  + 'PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)';

/** v5 播放请求的固定设备字段（有序；iid/cdid/device_id 由注册身份注入，_rticket 由签名补齐）。 */
const V5_PLAYER_DEVICE = {
  aid: '8662',
  app_name: 'novelread',
  version_code: '74332',
  version_name: '7.4.3.32',
  channel: 'vivo_8662_64',
  device_platform: 'android',
  device_type: 'PGT-AN10',
  os_version: '12',
  update_version_code: '74332',
};

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

/** 两次播放取流之间的最小间隔（毫秒）：整剧预热/下载不会在瞬间打满上游。 */
const PLAYBACK_INTERVAL_MS = 1000;

/**
 * 播放取流（含匿名注册）共享一条节奏链：上游 6.9 同款。
 * 同一时刻只放行一个取流请求，两次之间至少间隔 PLAYBACK_INTERVAL_MS；
 * HTTP 403 / 429 这类整体拒绝会记住这次错误，链上后续排队的请求直接失败，
 * 不再白白多打一轮上游。
 *
 * 注意：业务拒绝（如 code=101113 CHAPTER_INFO_GET_ERROR）只对那一集成立，
 * 不锁存 —— 否则整剧下载里一个失效分集就会把其余分集一起判死。
 */
let playbackChain = Promise.resolve();
let playbackReadyAt = 0;
let playbackRejection = null;

/**
 * 把一个播放取流任务排进共享节奏链。
 * @param {Function} task 返回 Promise 的取流任务
 * @returns {Promise<*>} 任务结果（失败原样抛出）
 */
function paced(task) {
  const previousRejection = playbackRejection;
  const run = playbackChain.then(async () => {
    if (playbackRejection !== previousRejection) throw playbackRejection;
    const wait = playbackReadyAt - Date.now();
    if (wait > 0) await Safeguards.sleep(wait);
    try {
      return await task();
    } catch (error) {
      // 整体拒绝顺带终止这一批已经排队的取流
      if (error.status === 403 || error.status === 429) playbackRejection = error;
      throw error;
    } finally {
      playbackReadyAt = Date.now() + PLAYBACK_INTERVAL_MS;
    }
  });
  playbackChain = run.then(() => {}, () => {});
  return run;
}

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

  // ---- 1. 播放取流：注册身份 + v5 签名（Medusa/Helios/Khronos）----
  // 播放身份视为一次性：每次取流注册全新匿名身份（上游 6.6 同款）。
  const body = zlib.gzipSync(Buffer.from(Json.stringify(v5Payload(vid))));
  const model = await paced(async () => {
    const identity = await getPlaybackDevice({ fresh: true });
    try {
      return modelOfPlayer(await postPlaybackV5(body, vid, identity), vid);
    } catch (error) {
      // 空 body（HTTP 200 + 0 字节）是间歇性故障：按上游 0.16.10 的做法，用
      // 同一个注册身份补一次签名 GET video_tab，只认「就是这一集」的返回。
      if (!isRecoverableEmpty(error)) throw error;
      const recovered = await recoverFromVideoTab(vid, identity, error);
      // 空响应已先计入熔断；恢复成功要把它清掉，否则连着几次空就白熔断了
      Guard.reportOk();
      return recovered;
    }
  });

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

// ==================== 响应模型提取 ====================

/** 明确的业务拒绝：标错误码，让节奏链终止这一批已排队的取流。 */
function businessRejected(message) {
  const error = new Error(message);
  error.code = 'BUSINESS_REJECTED';
  return error;
}

/**
 * 从 v5 播放响应里取本集的 video_model。
 * 模型嵌在 data.1004[vid].video_model 下（1004 缺失时退回 data[vid]）。
 */
function modelOfPlayer(j, vid) {
  if (Json.optInt(j.Code, 0) !== 0 || Json.optInt(j.code, 0) !== 0) {
    throw businessRejected('App 接口暂未提供本集播放信息');
  }
  const data = Json.optObj(j.data);
  const map1004 = data === null ? null : Json.optObj(data['1004']);
  const entries = map1004 !== null ? map1004 : data;
  const entry = entries === null ? null : Json.optObj(entries[vid]);
  if (entry === null || isEmpty(entry)) {
    throw new Error('App 接口未返回所选分集');
  }
  const model = asObject(entry.video_model);
  if (isEmpty(model)) {
    throw new Error('App 接口未返回 video_model');
  }
  return model;
}

/** 只对「HTTP 200 空 body」做 video_tab 恢复；带 Retry-After 的限流不补请求。 */
function isRecoverableEmpty(error) {
  return error !== null && error !== undefined
    && error.code === 'PLAYBACK_EMPTY_RESPONSE' && error.backoff !== true;
}

/**
 * 空响应恢复：同一个注册身份签名 GET video_tab（上游 0.16.10 / 478f006）。
 *
 * 严格只认本集 —— data.video_model_data 里可能只有别的分集，拿它顶替会让
 * 播放器「播出别人的那一集」，所以对不上就原样抛回最初的空响应错误。
 *
 * @param {string} vid 分集 id
 * @param {{device_id,iid,cdid}} identity 这一步刚用过的注册身份
 * @param {Error} original 最初的空响应错误（恢复失败时原样抛出）
 * @returns {Promise<object>} 本集的 video_model
 */
async function recoverFromVideoTab(vid, identity, original) {
  // query 用 73932 / 7.3.9.32 版本族（VIDEO_TAB_DEVICE，与注册 body 版本一致），
  // 业务参数全字符串、含空的 from_video_id；_rticket 由签名函数补齐。
  const values = Object.assign({}, VIDEO_TAB_DEVICE, {
    iid: identity.iid,
    cdid: identity.cdid,
    device_id: identity.device_id,
    video_id: String(vid),
    video_id_type: '0',
    device_level: '1',
    need_all_video_definition: '1',
    need_mp4_align: '0',
    use_os_player: '0',
    video_platform: '1024',
    source: '0',
    from_video_id: '',
  });
  // GET 无正文：body 传 null，签名因此不带 Content-Type / x-ss-stub
  const signed = PureSign.signPlaybackV5(VIDEO_TAB_API, values, null, Date.now());

  const headers = {};
  headers['User-Agent'] = VIDEO_UA;
  headers['Accept-Language'] = 'zh-CN,zh;q=0.9';
  Object.assign(headers, signed.headers);

  const res = await Http.send({
    // 签名头绑定这条 URL：跳到别处签名即失效，直接当失败处理
    url: signed.url, method: 'GET', timeoutMs: 15000, headers, followRedirect: false,
  });
  if (res.status !== 200) {
    const error = new Error('App 接口 HTTP ' + res.status);
    error.status = res.status;
    throw error;
  }
  const text = res.text();
  let j = null;
  // 空 body / 非 JSON 一律当作「恢复没成功」，抛回最初的空响应错误
  try { j = Json.parseObject(text); } catch (e) { j = null; }
  if (j === null || text.trim() === '' || isEmpty(j)) throw original;
  if (Json.optInt(j.Code, 0) !== 0 || Json.optInt(j.code, 0) !== 0) {
    throw businessRejected('App 接口暂未提供本集播放信息');
  }
  const data = Json.optObj(j.data);
  const rows = data === null ? null : (Json.optObj(data.video_model_data) || data);
  // 严格同一集：不做「随便挑一个分集」的兜底
  const entry = rows === null ? null : Json.optObj(rows[String(vid)]);
  const model = entry === null ? Json.obj() : asObject(entry.video_model);
  if (isEmpty(model)) throw original;
  return model;
}

// ==================== 请求构造 ====================

/** v5 请求体（device_level=1，带 disable_video_relate_book 与 dr_scene，对齐 hongguoTV）。 */
function v5Payload(vid) {
  const biz = Json.obj();
  biz.detail_page_version = 0;
  biz.device_level = 1;
  biz.disable_digg_stat = false;
  biz.disable_video_relate_book = false;
  biz.need_all_video_definition = true;
  biz.need_mp4_align = false;
  biz.use_os_player = false;
  biz.use_server_dns = false;
  biz.video_platform = 1024;
  const mixed = Json.obj();
  mixed['1004'] = [String(vid)];
  const out = Json.obj();
  out.biz_param = biz;
  out.mixed_video_id_map = mixed;
  out.dr_scene = 'player';
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
 * v5 播放请求：注册身份 + v5 签名（Medusa/Helios/Khronos）。
 * 单条 POST 到 /novel/player/multi_video_model/player/v1（a 域名），签名头绑定
 * 最终 query 与实际发送的 gzip body；空响应计入熔断（整剧下载不会白等几十次）。
 *
 * @param {Buffer} body gzip 压缩体
 * @param {string} vid 分集 id
 * @param {{device_id,iid,cdid}} identity 匿名注册身份
 */
async function postPlaybackV5(body, vid, identity) {
  // 熔断中：直接快速失败，不再打上游（整剧下载会连试几十集，每次都白等超时）
  if (!Guard.acquire()) {
    const blocked = new Error(Guard.blockedMessage());
    blocked.code = 'PLAYBACK_CIRCUIT_OPEN';
    blocked.deviceId = identity.device_id;
    throw blocked;
  }

  // acquire() 可能把状态推进到半开并占用唯一的探测位。只有 reportOk /
  // reportEmpty 会释放它，而 HTTP 403/429、超时、注册失败等分支都是直接
  // 抛错 —— 不在这里兜底释放，probing 会永久为 true，进程再也取不到流。
  try {
    const values = Object.assign({}, V5_PLAYER_DEVICE, {
      iid: identity.iid,
      cdid: identity.cdid,
      device_id: identity.device_id,
    });
    const signed = PureSign.signPlaybackV5(V5_PLAYER_API, values, body, Date.now());

    const headers = {};
    headers['User-Agent'] = V5_PLAYER_UA;
    headers.Accept = 'application/json';
    headers['Content-Encoding'] = 'gzip';
    headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
    Object.assign(headers, signed.headers);

    const res = await Http.send({
      url: signed.url, method: 'POST', timeoutMs: 15000, headers, body,
      // 签名头绑定这条 URL：跳到别处签名即失效，直接当失败处理
      followRedirect: false,
    });
    if (res.status !== 200) {
      const error = new Error('App 接口 HTTP ' + res.status);
      error.status = res.status;
      throw error;
    }
    const text = res.text();
    const j = Json.parseObject(text);
    const code = j === null ? 0
      : Number((j.Code !== undefined ? j.Code : (j.code !== undefined ? j.code : 0)) || 0);
    if ((j !== null && code !== 0) || j === null || Json.optObj(j.data) === null) {
      // 空响应（HTTP 200 + 空 body 或缺 data）：上游未公开具体原因，文案不给结论。
      const emptyBody = text.trim() === '';
      const hint = emptyBody ? '（HTTP 200 空响应，原因尚未确认）' : '';
      const error = new Error('App 接口未返回 data' + hint
        + (Log.env('HG_APPSOURCE_DEBUG', null) !== null
          ? '（原始响应: ' + text + '）' : ''));
      if (emptyBody) {
        error.code = 'PLAYBACK_EMPTY_RESPONSE';
        error.deviceId = identity.device_id;
        // 有 Retry-After 说明上游在限流：补请求只会加重，交给熔断退避
        const retryAfter = res.header('Retry-After');
        error.backoff = retryAfter !== null && retryAfter !== '';
        Guard.reportEmpty();
      } else if (j !== null && code !== 0) {
        error.code = 'BUSINESS_REJECTED';
        error.businessCode = code;
      }
      throw error;
    }
    Guard.reportOk();
    return j;
  } finally {
    // 幂等：reportOk / reportEmpty 已复位时这里不会带来副作用
    Guard.releaseProbe();
  }
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
  PLAYBACK_INTERVAL_MS,
  ERR_BVC2_ONLY,
  BVC2_ONLY_MSG,
  pyEncode,
  pixelsOf,
  cleanUrl,
  decryptSpadeUrl,
  checkedUrl,
  VIDEO_API_HOST,
  VOD_DOMAINS,
};
