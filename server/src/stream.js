'use strict';
/**
 * 下载 + 纯离线解密流水线。
 * 移植自原 Python 模块 offline_dl.py + server.py 的 _ensure_decrypted。
 *
 * 流程：video_model 取 spade_a 与密文直链
 *      -> 下载密文 mp4
 *      -> spade 解包 content key（纯字节变换）
 *      -> AES-128-CTR 全轨解密（视频+音频各用自身 senc base_iv）
 *      -> 可选 ffmpeg remux 剥离 CENC 信令成普通 mp4
 *      -> 缓存复用
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const spade = require('./spade');
const mp4 = require('./mp4');
const client = require('./client');

const CACHE_DIR = process.env.HONGGUO_STREAM_CACHE
  || path.join(__dirname, '..', 'data', 'stream-cache');

/** 同键并发去重：同一集并发请求只解密一次。 */
const inflight = new Map();

/** 取该集指定清晰度的轨道信息。 */
async function videoTrack(vid, quality = 'best') {
  const tracks = await client.getVideoTracks([vid]);
  const list = tracks[String(vid)];
  if (!list || !list.length) return null;
  const picked = pickTrack(list, quality);
  if (!picked) return null;
  const enc = picked.encrypt_info || {};
  const meta = picked.video_meta || {};
  return {
    url: picked.main_url,
    spadeA: enc.spade_a,
    encrypt: !!enc.encrypt,
    definition: meta.definition || picked.definition || '?',
    size: meta.size || 0,
  };
}

/** 依据清晰度选择轨道：best 取最大体积；指定值按 definition 前缀匹配。 */
function pickTrack(tracks, quality = 'best') {
  if (!tracks || !tracks.length) return null;
  const list = [...tracks].sort(
    (a, b) => ((b.video_meta || {}).size || 0) - ((a.video_meta || {}).size || 0),
  );
  if (!quality || quality === 'best') return list[0];
  const want = String(quality).toLowerCase();
  return list.find((t) => {
    const def = String((t.video_meta || {}).definition || t.definition || '').toLowerCase();
    return def.includes(want) || want.includes(def);
  }) || list[0];
}

/** 带进度的文件下载（跟随重定向）。 */
async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (!out.write(value)) {
        await new Promise((r) => out.once('drain', r));
      }
      if (onProgress) onProgress(got, total);
    }
    await new Promise((r, j) => { out.end(r); out.on('error', j); });
  } catch (e) {
    out.destroy();
    try { await fsp.unlink(tmp); } catch { /* 忽略 */ }
    throw e;
  }
  await fsp.rename(tmp, dest);
  return got;
}

/**
 * 纯离线解密：spadeA(base64) + 密文 mp4 -> 明文 mp4。
 * @returns {Promise<{path:string, key:string, tracks:number, size:number}>}
 */
async function offlineDecrypt(spadeAB64, ctPath, outPath) {
  const { key } = spade.spadeToKey(spadeAB64, 0);
  if (!spade.isValidKey(key)) {
    throw new Error('spade 解包失败（可能为 ver2/AES-GCM 或格式异常）');
  }
  const buf = await fsp.readFile(ctPath);
  const { tracks } = mp4.analyzeEncryptedTracks(buf);
  if (!tracks.length) throw new Error('密文文件无加密轨');

  // 视频轨用于 IV 自证；随后所有加密轨（视频+音频）统一用同一 content key 解密
  const video = tracks.find((t) => t.handler === 'vide') || tracks[0];
  const cands = mp4.trackBaseIvCandidates(buf, video);
  const vIv = mp4.verifyVideoIv(buf, video, key, cands);
  if (!vIv) throw new Error('content key 与密文不匹配（spade 与该密文不对应，或为 ver2 视频）');

  let decrypted = 0;
  for (const t of tracks) {
    // 每条轨用各自的逐样本 IV；缺失时才回退到该轨的 base_iv
    const iv = t === video ? vIv : (mp4.trackBaseIvCandidates(buf, t)[0] || vIv);
    const r = mp4.decryptTrack(buf, t, key, iv);
    decrypted += r.decrypted;
  }

  await fsp.writeFile(outPath, buf);
  // 尝试 remux 剥离 CENC 信令；无 ffmpeg 则保留已解密的原始容器
  const playable = await remuxPlayable(outPath);
  return { path: playable, key, tracks: decrypted, size: buf.length };
}

/**
 * 调用 ffmpeg 产出浏览器可播放的 mp4。
 *
 * 默认只做「剥离 CENC 信令」（`-c copy` + `+faststart` 把 moov 前置，
 * 便于边下边播），**不做任何重编码**：源流是 HEVC(H.265)，
 * 目标机器既然支持 HEVC 硬件解码，直出即可，省 CPU 也省时间
 * （1080x1920 整集转码约 15 秒，copy 只需 1 秒内）。
 *
 * 若目标机器缺 HEVC 解码器（表现为画面全黑、videoWidth 报 0，
 * 但时间轴正常走），可设 HG_TRANSCODE=1 开启 HEVC -> H.264 转码。
 * 转码器带能力探测：不同发行版的 ffmpeg 带的编码器不一样，
 * 踩过的坑是精简版只有 libopenh264，硬写 libx264 会报
 * `Unknown encoder` 导致整条 remux 失败、落盘带 CENC 信令的裸容器。
 */
function remuxPlayable(rawPath) {
  return new Promise((resolve) => {
    // 目标名：去掉 .raw 段；没有 .raw 则用「基名 + .play.mp4」，避免出现 a.mp4.mp4
    const parsed = path.parse(rawPath);
    const stem = parsed.name.replace(/\.raw$/, '');
    const out = path.join(parsed.dir, `${stem}.play.mp4`);

    // 转码默认关闭（HG_TRANSCODE=1 才开）
    const want = process.env.HG_TRANSCODE === '1';
    const enc = want ? h264Encoder() : null;
    if (want && !enc) {
      console.log('[stream] HG_TRANSCODE=1 但未找到可用的 H.264 编码器，'
        + '本集退回 -c copy；若浏览器不支持 HEVC 会黑屏');
    }
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', rawPath,
      '-c:v', enc ? enc.name : 'copy',
      // 仅重编码时追加质量参数；copy 时必须保持裸参数，否则 ffmpeg 报错
      ...(enc ? enc.args : []),
      // 默认连音频一起 copy（源已是 AAC）；转码时才需要显式指定码率
      '-c:a', enc ? 'aac' : 'copy',
      ...(enc ? ['-b:a', '128k'] : []),
      '-movflags', '+faststart', out,
    ], { stdio: 'ignore' });
    let settled = false;
    const fail = () => { if (!settled) { settled = true; resolve(null); } };
    ff.on('error', fail);
    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0) {
        try { fs.unlinkSync(rawPath); } catch { /* 忽略 */ }
        resolve(out);
      } else resolve(null);
    });
  });
}

/**
 * 探测本机可用的 H.264 编码器（结果缓存）。
 * 仅在 HG_TRANSCODE=1 时才会用到。
 *
 * 优先级：环境变量指定 > libx264（画质/兼容性最佳）> libopenh264（纯软件，
 * 多数发行版都自带）> h264_qsv / h264_v4l2m2m 等硬件编码器。
 * 全都不可用时返回 null，调用方退回 `-c copy`。
 */
let _encoders = null;
function h264Encoder() {
  if (_encoders) return _encoders;
  const preset = (process.env.HG_H264_ENCODER || '').trim();
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
    encoding: 'utf8', maxBuffer: 8 << 20,
  });
  const list = r.stdout || '';
  const has = (n) => new RegExp(`\\s${n}\\s`).test(list);

  const table = preset && has(preset)
    ? [{ name: preset, args: [] }]
    : [
      { name: 'libx264', args: ['-preset', 'veryfast', '-crf', '23'] },
      { name: 'libopenh264', args: ['-b:v', '2500k'] },
      { name: 'h264_qsv', args: ['-preset', 'veryfast'] },
      { name: 'h264_v4l2m2m', args: [] },
    ];
  const hit = table.find((e) => has(e.name));
  // pix_fmt 与 crf 只对 x264/openh264 有意义，硬件编码器不认 -crf
  _encoders = hit
    ? { ...hit, args: [...hit.args, '-pix_fmt', 'yuv420p'] }
    : null;
  return _encoders;
}

/**
 * 计算某集指定清晰度的缓存路径。
 *
 * 注意 play 路径：offlineDecrypt 末尾会 remux 出「基名.play.mp4」（并删掉 raw），
 * 而基名不含 .raw 段，所以加密内容最终落盘的是 <vid>_<q>.play.mp4，
 * 不是 <vid>_<q>.mp4。三个变体都必须参与命中判定，
 * 否则加密集永远命中不了缓存，每次播放都要重新下载 + 解密。
 */
function cachePaths(vid, quality = 'best') {
  const safeQ = String(quality).replace(/[^\w]/g, '') || 'best';
  const base = path.join(CACHE_DIR, `${vid}_${safeQ}`);
  return {
    out: `${base}.mp4`,      // 未加密直下的成品
    play: `${base}.play.mp4`, // 加密解密 + remux 后的成品
    raw: `${base}.raw.mp4`,  // remux 前的解密产物（ffmpeg 不可用时保留）
  };
}

/** 命中缓存则返回可播放文件路径，否则 null（不触发解密）。 */
function cachedPath(vid, quality = 'best') {
  const { out, play, raw } = cachePaths(vid, quality);
  for (const p of [play, out, raw]) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return p; } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * 确保某集已解密并落盘缓存，返回可播放 mp4 路径。
 */
async function ensureDecrypted(vid, quality = 'best') {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const { out, play, raw } = cachePaths(vid, quality);

  // 三个变体任一命中即直接返回，避免重复下载解密
  const hit = cachedPath(vid, quality);
  if (hit) {
    // 只有残留的 raw（缺 play 成品）才需要补一次 remux
    if (hit !== raw) return hit;
    const p = await remuxPlayable(raw);
    if (p) return p;
  }

  if (inflight.has(out)) return inflight.get(out); // 同集并发只解一次

  const task = (async () => {
    try {
      const again = cachedPath(vid, quality);
      if (again && again !== raw) return again;
      const t = await videoTrack(vid, quality);
      if (!t || !t.url) throw new Error('无直链 / video_model');
      if (!t.encrypt) {
        await download(t.url, out);
        return out;
      }
      const ct = `${out}.enc`;
      await download(t.url, ct);
      try {
        const r = await offlineDecrypt(t.spadeA, ct, raw);
        // remux 成功时返回 .play.mp4，失败时回退 raw（两者都已在磁盘上）
        return r.path || raw;
      } finally {
        try { await fsp.unlink(ct); } catch { /* 忽略 */ }
      }
    } finally {
      inflight.delete(out);
    }
  })();

  inflight.set(out, task);
  return task;
}

/**
 * ffmpeg 是否可用（同步检查一次并缓存）。
 * 缺 ffmpeg 时仍能解密出 raw 容器，但 CENC 信令未剥离、
 * 且无法转码为 H.264，部分浏览器可能无法播放。
 */
let _ffmpeg = null;
function ffmpegAvailable() {
  if (_ffmpeg !== null) return _ffmpeg;
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  _ffmpeg = !r.error && r.status === 0;
  return _ffmpeg;
}

/** 转码是否启用（HG_TRANSCODE=1 才开），以及会用的编码器名。 */
function transcodeEnabled() {
  return process.env.HG_TRANSCODE === '1' && h264EncoderName() !== null;
}

/** 当前实际使用的 H.264 编码器名（未启用/不可用时返回 null）。 */
function h264EncoderName() {
  if (process.env.HG_TRANSCODE !== '1') return null;
  if (!ffmpegAvailable()) return null;
  const e = h264Encoder();
  return e ? e.name : null;
}

/**
 * 预热：后台触发解密，不阻塞响应。
 * 用于自动连播 —— 播放当前集时提前把下一集落盘，播完切集即可秒开。
 * 已缓存时 resolve('cached')，未缓存时 resolve('warming')。
 */
function prewarm(vid, quality = 'best') {
  const hit = cachedPath(vid, quality);
  if (hit) return Promise.resolve('cached');
  // 不 await：故意让解密在后台跑，调用方无需等待
  ensureDecrypted(vid, quality).catch((e) => {
    console.log(`[prewarm] ${vid} 预热失败: ${e.message}`);
  });
  return Promise.resolve('warming');
}

module.exports = {
  ensureDecrypted, offlineDecrypt, videoTrack, pickTrack, download,
  CACHE_DIR, cachePaths, cachedPath, prewarm,
  ffmpegAvailable, h264EncoderName, transcodeEnabled,
};
