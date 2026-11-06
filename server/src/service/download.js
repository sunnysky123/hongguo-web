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
const { errMsg } = require('../util/common');
const Client = require('./client');
const Stream = require('./stream');

/** 仓库根目录（本文件位于 <root>/server/src/service）。 */
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** 每集最多尝试次数（含首次），即失败后额外重试 2 次。 */
const MAX_ATTEMPTS = 3;

/** 同一集两次尝试之间的间隔（毫秒），给瞬时故障一个恢复窗口。 */
const RETRY_DELAY_MS = 800;

/** 同一集最多允许用户手动重试几次（每次重试内部仍按 MAX_ATTEMPTS 尝试）。 */
const MAX_RETRIES = 3;

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
        retried: new Map(), // 集号 -> 用户手动重试次数
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
      o.retries = t.retried.get(f.index) || 0;
    return o;
  });
    s.max_retries = MAX_RETRIES;
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
 *
 * @param {object} t 任务
 * @param {object[]} sel 本次要下载的剧集
 * @param {boolean} [isRetry] 是否为失败重试（影响结束日志文案）
 */
async function run(t, sel, isRetry) {
  const t0 = Date.now();
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
  // 一集都没成功才算任务失败；部分失败仍算完成（失败集号在快照里给前端展示）。
  // 用 done 判定而不是「失败数 === 本次集数」：重试时 failed 里还留着
  // 本次没重试的其它失败集，按后者判定会把有成功的任务误标成失败。
  t.status = t.done === 0 ? 'failed' : 'done';
  const secs = ((t.finishedAt - t0) / 1000).toFixed(1);
  const failPart = t.failed.length > 0
    ? '，失败 ' + t.failed.length + ' 集（集号：' + t.failed.map((f) => f.index).join('、') + '）'
    : '';
  Log.info((isRetry ? '下载任务 ' + t.id + ' 重试结束：' : '下载任务 ' + t.id + ' 结束：')
    + t.title + ' 成功 ' + t.done + '/' + t.total + ' 集' + failPart + '，用时 ' + secs + 's');
}

/**
 * 重试任务里最终失败的剧集（用户在「下载进度」卡片里手动触发）。
 *
 * 与 start 的区别：
 *   - 不新建任务，直接在原任务对象上继续跑，前端看到的 id 不变、进度条延续；
 *   - 本次要下的不是集号范围，而是失败列表里的集号，需要重新取剧集拿 vid；
 *   - 同一集最多手动重试 MAX_RETRIES 次，防止无限重试。
 *
 * @param {string} id 任务 id
 * @param {number[]|null} indexes 指定重试的集号；null / 空数组 = 全部失败集
 * @returns {Promise<object>} 任务（已回到 running）
 * @throws {Error} 任务不存在 / 进行中 / 无失败集 / 集号不在失败列表 / 已达重试上限
 */
async function retry(id, indexes) {
  const t = get(id);
  if (t === null) throw new Error('任务不存在或已过期');
  if (t.status === 'running') throw new Error('该任务正在下载中，请等待当前任务结束');
  if (t.failed.length === 0) throw new Error('该任务没有失败的剧集');

  const want = (indexes === null || indexes === undefined || indexes.length === 0)
    ? null : indexes.map((i) => Number(i));
  const picked = want === null ? t.failed.slice() : t.failed.filter((f) => want.indexOf(Number(f.index)) !== -1);
  if (picked.length === 0) throw new Error('指定的集号不在失败列表中');

  const allowed = picked.filter((f) => (t.retried.get(Number(f.index)) || 0) < MAX_RETRIES);
  if (allowed.length === 0) {
    throw new Error('失败剧集已达重试上限（每集最多 ' + MAX_RETRIES + ' 次）');
  }

  const detail = await Client.getEpisodes(t.seriesId);
  const epsAll = Json.optArr(detail === null || detail === undefined ? null : detail.episodes);
  const byIndex = new Map();
  for (const eObj of epsAll) {
    const e = Json.optObj(eObj);
    if (e !== null) byIndex.set(Number(e.index), e);
  }

  const sel = [];
  for (const f of allowed) {
    const idx = Number(f.index);
    const ep = byIndex.get(idx);
    if (ep === undefined) {
      // 上游已没有这一集：保留原失败记录，只提示，不静默吞掉
      Log.warn('重试下载 ' + t.title + ' 第 ' + idx + ' 集失败：上游已无该集，跳过');
      continue;
    }
    t.retried.set(idx, (t.retried.get(idx) || 0) + 1);
    sel.push(ep);
  }
  if (sel.length === 0) throw new Error('失败剧集在上游已不存在，无法重试');

  // 先把待重试的失败项摘掉：downloadOne 失败时会重新 push 一条，
  // 不摘的话同一集会在列表里出现两次（成功时也不会残留旧失败记录）。
  const retrySet = new Set(sel.map((e) => Number(e.index)));
  t.failed = t.failed.filter((f) => !retrySet.has(Number(f.index)));

  t.status = 'running';
  t.error = null;
  t.finishedAt = 0;
  Log.info('下载任务 ' + t.id + ' 重试 ' + sel.length + ' 集：' + t.title
    + ' 第 ' + sel.map((e) => Number(e.index)).join('、') + ' 集');

  // 与 start 一样不 await：立即返回快照，任务在后台跑。
  run(t, sel, true).catch((e) => {
    t.status = 'failed';
    t.error = errMsg(e);
    t.finishedAt = Date.now();
    Log.error('下载任务 ' + t.id + ' 重试异常终止：' + errMsg(e));
  });
  return t;
}

module.exports = {
  downloadDir,
  start,
  retry,
  get,
  runningOf,
  snapshot,
  MAX_ATTEMPTS,
  MAX_RETRIES,
};
