'use strict';
/**
 * 剧集批量下载：把选定的集数范围下载并解密为 mp4，
 * 按 <下载根>/<剧名>/第N集.mp4 落盘。
 *
 * 本服务不重复实现下载/解密：统一复用 Stream.ensureDecrypted
 * （取直链 -> 下载密文 -> spade 解密 -> 减壳 -> 缓存），
 * 这里只负责四件事：
 *   1) 任务管理：一个剧同时只跑一个任务，任务表供 /download/task 查询进度；
 *   2) 目录规划：download/<剧名>/第N集.mp4（剧名做文件名安全化）；
 *   3) 失败重试：每集最多尝试 MAX_ATTEMPTS 次（含首次）；
 *   4) 日志：单集成功不输出（批量下载时量太大）；只有每集最终失败
 *      （MAX_ATTEMPTS 次均未成功）与任务结束时各输出一行，便于对照排查。
 *
 * 同步/异步：凡触网或文件 IO 的入口都是 async；路径计算保持同步。
 */

const fs = require('fs');
const path = require('path');

const Config = require('../util/config');
const Log = require('../util/log');
const Json = require('../util/json');
const Safeguards = require('../core/safeguards');
const Client = require('./client');
const Stream = require('./stream');

/** 仓库根目录（本文件位于 <root>/server/src/service）。 */
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** 每集最多尝试次数（含首次），即失败后额外重试 2 次。 */
const MAX_ATTEMPTS = 3;

/** 同一集两次尝试之间的间隔（毫秒），给瞬时故障一个恢复窗口。 */
const RETRY_DELAY_MS = 800;

/** 同时下载的集数上限。解密是 CPU 密集操作，并发过高会拖慢播放主链路。 */
function concurrency() {
  const n = Config.num('runtime.download.concurrency', 2);
  return Math.max(1, Math.min(n, 8));
}

/** 下载根目录：环境变量 HONGGUO_DOWNLOAD_DIR > 配置 runtime.download.dir > 'download'。 */
function downloadDir() {
  const d = Config.str('runtime.download.dir', 'download');
  return path.isAbsolute(d) ? path.resolve(d) : path.resolve(ROOT, d);
}

/**
 * 任务表：id -> task。仅内存保存，重启即丢（正在下的文件不受影响，
 * 已落盘的成品都在 download 目录里）。为防无限增长，只保留最近
 * TASK_KEEP 个任务，超出时淘汰最旧的已结束任务。
 */
const TASKS = new Map();
const TASK_KEEP = 50;
let taskSeq = 0;

/** 取异常文案。 */
function errMsg(e) {
  if (e === null || e === undefined) return 'null';
  return (e.message !== undefined && e.message !== null) ? String(e.message) : String(e);
}

/**
 * 剧名 -> 文件夹名。
 * 直接复用 Client.sanitize（替换 \\/:*?"<>| 并截断 60 字），
 * 再剥掉首尾的点与空格 —— Windows 下 "abc." / "abc " 不是合法目录名。
 * 全被剥掉时退回 series_id，保证目录名非空。
 */
function seriesDirName(title, seriesId) {
  let name = Client.sanitize(title === '' ? seriesId : title).replace(/^[. ]+|[. ]+$/g, '');
  if (name === '') name = Client.sanitize(seriesId);
  if (name === '') name = '未命名';
  return name;
}

/** 新建任务并登记到任务表（此时尚未开始执行）。 */
function createTask(seriesId, title, sel) {
  const t = {
    id: 'dl_' + Date.now().toString(36) + '_' + (++taskSeq),
    seriesId: String(seriesId),
    title: title,
    dir: path.join(downloadDir(), seriesDirName(title, seriesId)),
    total: sel.length,
    done: 0,
    files: [],   // 成功项 {index, size}
    failed: [],  // 失败项 {index, vid, error}
    status: 'running', // running | done | failed（全集失败才算 failed）
    error: null,
    reused: false,     // 是否复用了同剧已在跑的任务
    startedAt: Date.now(),
    finishedAt: 0,
  };
  pruneTasks();
  TASKS.set(t.id, t);
  return t;
}

/** 淘汰最旧的已结束任务，把任务表控制在 TASK_KEEP 以内。 */
function pruneTasks() {
  if (TASKS.size < TASK_KEEP) return;
  const finished = [];
  for (const t of TASKS.values()) {
    if (t.status !== 'running') finished.push(t);
  }
  finished.sort((a, b) => a.finishedAt - b.finishedAt);
  let i = 0;
  while (TASKS.size >= TASK_KEEP && i < finished.length) {
    TASKS.delete(finished[i].id);
    i++;
  }
}

/** 该剧是否已有进行中的任务；有则返回该任务（供复用），否则 null。 */
function runningOf(seriesId) {
  const sid = String(seriesId);
  for (const t of TASKS.values()) {
    if (t.seriesId === sid && t.status === 'running') return t;
  }
  return null;
}

/** 按 id 取任务；不存在（或已被淘汰）返回 null。 */
function get(id) {
  const t = TASKS.get(String(id));
  return t === undefined ? null : t;
}

/** 任务快照：只暴露前端/调用方需要的字段，不含内部状态。 */
function snapshot(t) {
  const s = Json.obj();
  s.id = t.id;
  s.series_id = t.seriesId;
  s.title = t.title;
  s.dir = t.dir;
  s.total = t.total;
  s.done = t.done;
  s.failed = t.failed.map((f) => {
    const o = Json.obj();
    o.index = f.index;
    o.error = f.error;
    return o;
  });
  s.status = t.status;
  s.error = t.error;
  s.reused = t.reused;
  s.started_at = t.startedAt;
  s.finished_at = t.finishedAt;
  return s;
}

/**
 * 启动下载任务（立即返回，任务在后台执行）。
 *
 * @param {string} seriesId 剧集 series_id
 * @param {number|null} startEp 起始集号（含）；null 表示第一集
 * @param {number|null} endEp 结束集号（含）；null 表示最后一集
 * @returns {Promise<object>} 任务快照；同剧已有任务在跑时返回那个任务（reused=true）
 * @throws {Error} 取不到剧集 / 范围内没有剧集时抛出（路由层转 400）
 */
async function start(seriesId, startEp, endEp) {
  const sid = String(seriesId === null || seriesId === undefined ? '' : seriesId).trim();
  if (sid === '') throw new Error('series_id 不能为空');

  // 同一剧只允许一个进行中的任务：两次任务的范围可能重叠，同时写同一目录
  // 会互相覆盖。直接复用旧任务，前端的进度视图也随之延续。
  const running = runningOf(sid);
  if (running !== null) {
    running.reused = true;
    Log.info('下载任务 ' + running.id + ' 已在进行中（' + running.done + '/' + running.total
      + '），复用该任务：' + running.title);
    return running;
  }

  const detail = await Client.getEpisodes(sid);
  const meta = Json.optObj(detail === null || detail === undefined ? null : detail.meta);
  const epsAll = Json.optArr(detail === null || detail === undefined ? null : detail.episodes);
  if (epsAll.length === 0) throw new Error('该剧暂无剧集');

  const eps = [];
  for (const eObj of epsAll) {
    const e = Json.optObj(eObj);
    if (e !== null) eps.push(e);
  }
  const firstIdx = Number(eps[0].index) || 1;
  const lastIdx = Number(eps[eps.length - 1].index) || eps.length;
  const lo = (startEp === null || startEp === undefined) ? firstIdx : startEp;
  const hi = (endEp === null || endEp === undefined) ? lastIdx : endEp;
  const sel = eps.filter((e) => Number(e.index) >= lo && Number(e.index) <= hi);
  if (sel.length === 0) {
    throw new Error('第 ' + lo + '-' + hi + ' 集范围内没有剧集（本剧集号为 '
      + firstIdx + '-' + lastIdx + '）');
  }

  const title = Json.optStr(meta === null ? null : meta.title, '');
  const t = createTask(sid, title === '' ? sid : title, sel);
  Log.info('下载任务 ' + t.id + ' 开始：' + t.title + ' 第 ' + lo + '-' + hi
    + ' 集（共 ' + t.total + ' 集）');

  // 故意不 await：让任务在后台跑，HTTP 请求立即返回。
  // run 内部已兜住所有异常（逐集 try + 总体 catch），这里再包一层是
  // 防止 pruneTasks/日志 itself 出意外时产生未处理的 rejection。
  run(t, sel).catch((e) => {
    t.status = 'failed';
    t.error = errMsg(e);
    t.finishedAt = Date.now();
    Log.error('下载任务 ' + t.id + ' 异常终止：' + errMsg(e));
  });
  return t;
}

/**
 * 下载单集：最多 MAX_ATTEMPTS 次尝试。
 * 成功 -> 复制成品到 第N集.mp4（先写 .part 再改名，不留半成品），**不打印日志**
 *         （批量下载时每集一行会淹没控制台，进度由 /download/task 查询）；
 * 全部失败 -> 记入 task.failed 并输出一行 WARN。
 *
 * @returns {Promise<boolean>} 是否成功
 */
async function downloadOne(t, ep) {
  const idx = Number(ep.index) || 0;
  const label = t.title + ' 第 ' + idx + ' 集';
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // ensureDecrypted 自带同集并发去重与磁盘缓存：播过的一集会直接命中，
      // 复制即可，不必重新下载解密。
      // allowBvc2：下载与在线播放的诉求不同 —— 浏览器解不了的 ByteVC2
      // 片源照样要能存到本地，否则「只有新编码」的剧会整批失败。
      const src = await Stream.ensureDecrypted(String(ep.vid), 'best', { allowBvc2: true });
      const dest = path.join(t.dir, '第' + idx + '集.mp4');
      fs.mkdirSync(t.dir, { recursive: true });
      const tmp = dest + '.part';
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, dest);
      t.done++;
      t.files.push({ index: idx, size: fs.statSync(dest).size });
      return true;
    } catch (e) {
      lastErr = e;
      // 重试中的单次失败同样不打印：噪音大且信息量少，
      // 最终失败那行会带上最后一次错误的完整文案。
      if (attempt < MAX_ATTEMPTS) await Safeguards.sleep(RETRY_DELAY_MS);
    }
  }
  t.failed.push({ index: idx, vid: String(ep.vid), error: errMsg(lastErr) });
  Log.warn('下载失败 ' + label + '：已尝试 ' + MAX_ATTEMPTS + ' 次仍不成功（'
    + errMsg(lastErr) + '），跳过该集');
  return false;
}

/**
 * 任务执行体：有界并发地逐集下载，全部结束后收尾。
 * 单集异常已在 downloadOne 内消化，这里只可能被队列本身的问题打断。
 */
async function run(t, sel) {
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= sel.length) return;
      await downloadOne(t, sel[i]);
    }
  };
  const n = Math.max(1, Math.min(concurrency(), sel.length));
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  t.finishedAt = Date.now();
  // 全集失败才算任务失败；部分失败仍算完成（失败集号在快照里给前端展示）
  t.status = (sel.length > 0 && t.failed.length === sel.length) ? 'failed' : 'done';
  const secs = ((t.finishedAt - t.startedAt) / 1000).toFixed(1);
  const failPart = t.failed.length > 0
    ? '，失败 ' + t.failed.length + ' 集（集号：' + t.failed.map((f) => f.index).join('、') + '）'
    : '';
  Log.info('下载任务 ' + t.id + ' 结束：' + t.title + ' 成功 ' + t.done + '/'
    + t.total + ' 集' + failPart + '，用时 ' + secs + 's');
}

module.exports = {
  downloadDir,
  start,
  get,
  runningOf,
  snapshot,
  MAX_ATTEMPTS,
};
