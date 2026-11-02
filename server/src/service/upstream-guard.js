'use strict';
/**
 * 上游取流熔断与日志节流。
 *
 * 背景（2026-11-02 实测）：播放接口 multi_video_model/v1 对整批请求返回
 * HTTP 200 + 0 字节，6 部不同剧全数如此、响应在 100ms 内返回；匿名设备
 * 注册本身正常，换一个新注册身份也照样空 —— 是上游按请求特征/出口 IP
 * 整体收紧，与「哪一集」「哪个设备身份」都无关。
 *
 * 这种故障有兩個副作用，本模块各管一个：
 *   1) 熔断：整剧下载 / 批量预热会对同一接口连打几十次，每次都白等超时。
 *      连续空响应达到阈值后进入冷却，冷却期内直接快速失败，冷却结束只
 *      放行一个探测请求；再次失败则冷却时间翻倍（退避），直到恢复。
 *   2) 日志节流：同一句话刷几十行会把真正有用的信息埋掉，还会让用户以为
 *      每一集各有各的毛病。改为首次告警 + 每 60 秒最多一条汇总。
 *
 * 状态是进程级的（Node 单线程，无需加锁）。计时只用时间戳，不挂定时器，
 * 避免进程被长期运行的 timer 拖住无法退出。
 */
const Log = require('../util/log');

/** 连续多少次空响应后进入熔断。 */
const FAIL_THRESHOLD = 3;

/** 首次熔断的冷却时长（毫秒）。 */
const BASE_COOLDOWN_MS = 30 * 1000;

/** 退避上限：反复熔断时冷却时间翻倍，但不超过 5 分钟。 */
const MAX_COOLDOWN_MS = 5 * 60 * 1000;

/** 同类告警的最小间隔（毫秒），间隔内的失败只计数不输出。 */
const WARN_INTERVAL_MS = 60 * 1000;

/** 同一设备身份的最短换新间隔（毫秒），避免失败时反复打注册接口。 */
const ROTATE_INTERVAL_MS = 60 * 1000;

/** 当前连续空响应次数；成功即清零。 */
let consecutive = 0;

/** 熔断截止时间戳；0 表示未熔断。 */
let openUntil = 0;

/** 下一次熔断的冷却时长，成功后退回 BASE_COOLDOWN_MS。 */
let cooldownMs = BASE_COOLDOWN_MS;

/** 本次熔断实际使用的冷却时长（毫秒），仅用于恢复日志。 */
let openMs = 0;

/** 本进程累计熔断次数，仅用于日志里的「第 N 次」。 */
let trips = 0;

/** 半开状态下是否已有探测请求在路上（冷却结束只放一个）。 */
let probing = false;

/** 上次告警时间戳；0 表示本进程还没告警过。 */
let warnAt = 0;

/** 自上次告警以来被压掉的条数。 */
let suppressed = 0;

/** 上一次被换掉的设备身份与时间，用于限制换新频率。 */
let lastRotateId = '';
let lastRotateAt = 0;

/**
 * 申请一次上游请求许可。
 * @returns {boolean} true 允许；false 表示熔断中，调用方应直接快速失败
 */
function acquire() {
  const t = Date.now();
  if (t < openUntil) return false;
  // 冷却已过：进入半开，只放行一个探测，避免恢复瞬间被并发请求打满
  if (openUntil !== 0) {
    if (probing) return false;
    probing = true;
  }
  return true;
}

/** 上报一次成功：退出熔断、清零计数，恢复时打一条 INFO。 */
function reportOk() {
  if (openUntil !== 0) {
    Log.info('上游取流已恢复（此前连续 ' + consecutive + ' 次空响应，'
      + '熔断 ' + Math.round(openMs / 1000) + ' 秒）');
  }
  consecutive = 0;
  openUntil = 0;
  cooldownMs = BASE_COOLDOWN_MS;
  openMs = 0;
  probing = false;
  suppressed = 0;
  warnAt = 0;
}

/**
 * 上报一次空响应。
 * 达到阈值即熔断；若本次是半开探测失败，则按退避翻倍下一次的冷却时长。
 */
function reportEmpty() {
  const t = Date.now();
  consecutive += 1;
  probing = false;
  if (consecutive < FAIL_THRESHOLD) return;
  if (t < openUntil) return;          // 已在冷却中，不重复延时
  openMs = cooldownMs;
  openUntil = t + openMs;
  cooldownMs = Math.min(cooldownMs * 2, MAX_COOLDOWN_MS);
  trips += 1;
  // 状态变化单独报一条：逐条失败已被 warn() 节流，不说明白用户会以为只是某集坏了
  Log.warn('上游取流连续 ' + consecutive + ' 次空响应，暂停取流 '
    + Math.round(openMs / 1000) + ' 秒（第 ' + trips + ' 次熔断）；'
    + '期间请求直接失败，不再占用上游');
}

/**
 * 输出一条可节流的告警。
 * 首条、或距上次告警超过 WARN_INTERVAL_MS 时真正输出，并附上这期间被
 * 压掉的条数；其余情况只计数。
 * @param {string} msg 告警正文
 * @returns {boolean} 是否真的输出了
 */
function warn(msg) {
  const t = Date.now();
  if (warnAt === 0 || t - warnAt >= WARN_INTERVAL_MS) {
    const tail = suppressed > 0
      ? '（过去 ' + Math.round(WARN_INTERVAL_MS / 1000) + ' 秒内另有 '
        + suppressed + ' 次同类失败未逐条输出）'
      : '';
    Log.warn(msg + tail);
    warnAt = t;
    suppressed = 0;
    return true;
  }
  suppressed += 1;
  return false;
}

/**
 * 是否该为这次空响应换一个新的设备身份。
 * 同一身份 ROTATE_INTERVAL_MS 内只换一次：换身份对当前这轮限流无效（实测），
 * 而每次失败都重新注册会连着打注册接口，反而更像异常客户端。
 * @param {string} deviceId 刚被拒绝的设备身份
 */
function shouldRotateDevice(deviceId) {
  const id = deviceId === undefined || deviceId === null ? '' : String(deviceId);
  const t = Date.now();
  if (id === lastRotateId && t - lastRotateAt < ROTATE_INTERVAL_MS) return false;
  lastRotateId = id;
  lastRotateAt = t;
  return true;
}

/** 熔断中的提示文案（带剩余秒数），给调用方抛错用。 */
function blockedMessage() {
  const left = Math.max(0, Math.ceil((openUntil - Date.now()) / 1000));
  return '上游播放接口连续 ' + consecutive + ' 次返回空响应，已暂停请求 ' + left
    + ' 秒后再试（设备注册正常，非本机网络问题）';
}

/** 当前状态快照，供诊断与自检使用。 */
function state() {
  return {
    consecutive,
    openUntil,
    cooldownMs,
    probing,
    suppressed,
    trips,
    open: openUntil !== 0 && Date.now() < openUntil,
  };
}

/** 清空全部状态，仅测试使用。 */
function reset() {
  consecutive = 0;
  openUntil = 0;
  cooldownMs = BASE_COOLDOWN_MS;
  openMs = 0;
  trips = 0;
  probing = false;
  warnAt = 0;
  suppressed = 0;
  lastRotateId = '';
  lastRotateAt = 0;
}

module.exports = {
  acquire, reportOk, reportEmpty, warn, shouldRotateDevice, blockedMessage, state, reset,
  FAIL_THRESHOLD, BASE_COOLDOWN_MS, MAX_COOLDOWN_MS, WARN_INTERVAL_MS, ROTATE_INTERVAL_MS,
};
