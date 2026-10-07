package com.hongguo.api.service;

import com.hongguo.api.core.Mp4;
import com.hongguo.api.core.Spade;
import com.hongguo.api.util.Json;
import com.hongguo.api.util.Config;
import com.hongguo.api.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 下载 + 纯离线解密流水线。
 * 移植自 server/src/stream.js。
 *
 * 流程：video_model 取spade_a 与密文直链
 *      -> 下载密文 mp4
 *      -> spade 解包 content key（纯字节变换）
 *      -> AES-128-CTR 全轨解密（视频+音频各用自身逐样本 IV）
 *      -> 可选 ffmpeg remux 剥离 CENC 信令成普通 mp4
 *      -> 缓存复用
 */
public final class Stream {

    private Stream() {}

    private static Path cacheDir() {
        String d = Log.env("HONGGUO_STREAM_CACHE", null);
        if (d != null) return Paths.get(d);
        String dd = Config.str("runtime.data_dir", null);
        Path base = (dd != null) ? Paths.get(dd) : Paths.get("server", "data");
        // 转绝对路径：/download 会把落盘路径回给调用方，相对路径不便定位文件
        return base.resolve("stream-cache").toAbsolutePath();
    }

    /** 同键并发去重：同一集并发请求只解密一次。 */
    private static final Map<String, CompletableTask> INFLIGHT = new ConcurrentHashMap<>();

    /** 一个可重复等待的异步任务。 */
    static final class CompletableTask {
        private final java.util.concurrent.CompletableFuture<String> fut =
                new java.util.concurrent.CompletableFuture<>();

        String get() throws Exception {
            try {
                return fut.get();
            } catch (java.util.concurrent.ExecutionException e) {
                Throwable c = e.getCause();
                if (c instanceof Exception) throw (Exception) c;
                throw new IOException(String.valueOf(c));
            }
        }

        void complete(String v) { fut.complete(v); }

        void fail(Exception e) { fut.completeExceptionally(e); }
    }

    /** 取该集指定清晰度的轨道信息。 */
    public static final class VideoTrack {
        public String url;
        public String spadeA;
        public boolean encrypt;
        public String definition = "?";
        public long size;
    }

    /** 依据清晰度选择轨道：best 取最大体积；指定值按 definition 前缀匹配。 */
    @SuppressWarnings("unchecked")
    static Map<String, Object> pickTrack(List<Object> tracks, String quality) {
        if (tracks == null || tracks.isEmpty()) return null;
        List<Object> list = new ArrayList<>(tracks);
        list.sort((a, b) -> Long.compare(sizeOf(b), sizeOf(a)));
        if (quality == null || quality.isEmpty() || quality.equals("best")) {
            return Json.optObj(list.get(0));
        }
        String want = quality.toLowerCase();
        for (Object tObj : list) {
            Map<String, Object> t = Json.optObj(tObj);
            if (t == null) continue;
            Map<String, Object> meta = Json.optObj(t.get("video_meta"));
            String def = meta != null
                    ? Json.optStr(meta.get("definition"), "")
                    : Json.optStr(t.get("definition"), "");
            def = def.toLowerCase();
            if (def.contains(want) || (!def.isEmpty() && want.contains(def))) return t;
        }
        return Json.optObj(list.get(0));
    }

    @SuppressWarnings("unchecked")
    private static long sizeOf(Object trackObj) {
        Map<String, Object> t = Json.optObj(trackObj);
        if (t == null) return 0;
        Map<String, Object> meta = Json.optObj(t.get("video_meta"));
        return meta == null ? 0 : Json.optLong(meta.get("size"), 0);
    }

    /** 取该集指定清晰度的轨道信息。 */
    @SuppressWarnings("unchecked")
    public static VideoTrack videoTrack(String vid, String quality) throws Exception {
        Map<String, Object> tracks =
                Client.getVideoTracks(new ArrayList<>(Arrays.asList(vid)), false, 5);
        Object listObj = tracks.get(String.valueOf(vid));
        List<Object> list = (listObj instanceof List) ? (List<Object>) listObj : new ArrayList<>();
        if (list.isEmpty()) return null;
        Map<String, Object> picked = pickTrack(list, quality);
        if (picked == null) return null;

        Map<String, Object> enc = Json.optObj(picked.get("encrypt_info"));
        Map<String, Object> meta = Json.optObj(picked.get("video_meta"));
        VideoTrack out = new VideoTrack();
        out.url = Json.optStr(picked.get("main_url"), "");
        out.spadeA = enc == null ? null : Json.optStr(enc.get("spade_a"), null);
        out.encrypt = enc != null && Json.optBool(enc.get("encrypt"), false);
        out.definition = meta != null
                ? Json.optStr(meta.get("definition"), "?")
                : Json.optStr(picked.get("definition"), "?");
        out.size = meta == null ? 0 : Json.optLong(meta.get("size"), 0);
        return out;
    }

    // ==================== 下载 ====================

    /** 带临时文件的下载（失败自动清理）。 */
    public static long download(String url, Path dest) throws IOException {
        Files.createDirectories(dest.getParent());
        Path tmp = Paths.get(dest.toString() + ".part");
        HttpURLConnection conn = (HttpURLConnection) URI.create(url).toURL().openConnection();
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(30000);
        conn.setReadTimeout(120000);
        conn.setRequestProperty("user-agent", "Mozilla/5.0");
        try {
            int status = conn.getResponseCode();
            if (status >= 400) {
                throw new IOException("下载失败 HTTP " + status);
            }
            long got = 0;
            try (InputStream in = conn.getInputStream();
                 OutputStream os = Files.newOutputStream(tmp)) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    got += n;
                }
            } catch (IOException e) {
                Files.deleteIfExists(tmp);
                throw e;
            }
            Files.move(tmp, dest, StandardCopyOption.REPLACE_EXISTING);
            return got;
        } finally {
            conn.disconnect();
        }
    }

    // ==================== 离线解密 ====================

    /** 解密结果。 */
    public static final class DecryptOut {
        public String path;
        public String key;
        public int tracks;
        public long size;
    }

    /**
     * 纯离线解密：spadeA(base64) + 密文 mp4 -> 明文 mp4。
     *
     * 内存策略（关键）：**全程不把整个 MP4 读进堆**。
     * 1) 16 字节盒头顺读定位 moov，仅把moov 段（几 MB）载入内存解析索引；
     * 2) 流式 copy 密文 -> outPath；
     * 3) 用 outPath 的随机读写句柄逐样本解密。
     * 因此峰值堆内存只与「moov 段大小 + 单个样本大小」有关，
     * 与视频总时长/文件大小无关（历史实现是 50~200MB/集，32 并发时会撑爆堆）。
     */
    public static DecryptOut offlineDecrypt(String spadeAB64, Path ctPath, Path outPath)
            throws Exception {
        Spade.Result sp = Spade.spadeToKey(spadeAB64, 0);
        String key = sp.key;
        if (!Spade.isValidKey(key)) {
            throw new IOException("spade 解包失败（可能为 ver2/AES-GCM 或格式异常）");
        }

        long outSize = Files.size(ctPath);

        // ---- 1. 定位并仅加载 moov 段 ----
        Mp4.Analysis analysis;
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(ctPath.toFile(), "r")) {
            Mp4.MoovSpan moov = Mp4.findMoov(new Mp4.FileHeadReader(raf), raf.length());
            if (moov == null) throw new IOException("密文文件无moov 盒（不是有效的 MP4）");
            if (moov.size > Integer.MAX_VALUE - 8) {
                throw new IOException("moov 段异常过大，无法载入内存");
            }
            byte[] moovBuf = new byte[(int) moov.size];
            raf.seek(moov.start);
            raf.readFully(moovBuf);
            analysis = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, moov.start));
        }
        if (analysis.tracks.isEmpty()) throw new IOException("密文文件无加密轨");

        // 视频轨用于 IV 自证；随后所有加密轨（视频+音频）统一用同一 content key 解密
        Mp4.Track video = null;
        for (Mp4.Track t : analysis.tracks) {
            if ("vide".equals(t.handler)) { video = t; break; }
        }
        if (video == null) video = analysis.tracks.get(0);

        // ---- 2. 流式复制密文到 outPath ----
        streamCopy(ctPath, outPath);

        // ---- 3. 逐样本原地解密 ----
        int decrypted = 0;
        // 样本缓冲取 256KB：足够覆盖绝大多数样本，又不会让并发时堆占用膨胀
        try (java.io.RandomAccessFile out = new java.io.RandomAccessFile(outPath.toFile(), "rw")) {
            Mp4.SampleStore store = new Mp4.RafStore(out, 256 * 1024);

            // ⚠️ 必须先verify 再 decrypt：若顺序颠倒，样本 0 已是明文，
            // avccSelfOk 仍会通过，导致错误的 content key 被误判为合法。
            List<String> cands = Mp4.trackBaseIvCandidates(video);
            String vIv = Mp4.verifyVideoIv(store, video, key, cands);
            if (vIv == null) {
                throw new IOException("content key 与密文不匹配（spade 与该密文不对应，或为 ver2 视频）");
            }

            for (Mp4.Track t : analysis.tracks) {
                // 每条轨用各自的逐样本 IV；缺失时才回退到该轨的 base_iv
                String iv;
                if (t == video) {
                    iv = vIv;
                } else {
                    List<String> tc = Mp4.trackBaseIvCandidates(t);
                    iv = tc.isEmpty() ? vIv : tc.get(0);
                }
                decrypted += Mp4.decryptTrack(store, t, key, iv).decrypted;
            }
        }

        // 尝试 remux 剥离 CENC 信令；无 ffmpeg 则保留已解密的原始容器
        String playable = remuxPlayable(outPath);

        DecryptOut out = new DecryptOut();
        out.path = playable;
        out.key = key;
        out.tracks = decrypted;
        out.size = outSize;
        return out;
    }

    /** 流式复制文件（固定 64KB 缓冲，不随文件大小增长内存）。 */
    private static void streamCopy(Path src, Path dst) throws IOException {
        byte[] buf = new byte[65536];
        try (InputStream is = Files.newInputStream(src);
             OutputStream os = Files.newOutputStream(dst)) {
            int n;
            while ((n = is.read(buf)) > 0) {
                os.write(buf, 0, n);
            }
        }
    }

    /** ffmpeg remux 结果（同步执行）。 */
    private static String remuxPlayable(Path rawPath) {
        Path parsed = rawPath;
        String name = parsed.getFileName().toString();
        String dir = parsed.getParent() == null ? "" : parsed.getParent().toString();
        // 对齐 Node 的 path.parse().name：先剥掉最后一段扩展名，再剥 .raw 段。
        //顺序不能反——raw 文件名是 <vid>_<q>.raw.mp4，
        // 若只去 .raw 会得到 <vid>_<q>.raw.mp4.play.mp4 这种双后缀名。
        String stem = name;
        int dot = stem.lastIndexOf('.');
        if (dot > 0) stem = stem.substring(0, dot);
        if (stem.endsWith(".raw")) stem = stem.substring(0, stem.length() - 4);
        if (stem.isEmpty()) stem = name;
        Path out = Paths.get(dir, stem + ".play.mp4");

        // 转码默认关闭（HG_TRANSCODE=1 才开）
        boolean want = Config.bool("runtime.transcode", false);
        Encoder enc = want ? h264Encoder() : null;
        if (want && enc == null) {
            Log.info("HG_TRANSCODE=1 但未找到可用的 H.264 编码器，本集退回 -c copy；"
                    + "若浏览器不支持 HEVC 会黑屏");
        }

        List<String> cmd = new ArrayList<>(Arrays.asList(
                "ffmpeg", "-y", "-loglevel", "error", "-i", rawPath.toString(),
                "-c:v", enc != null ? enc.name : "copy"));
        if (enc != null) cmd.addAll(enc.args);
        cmd.add("-c:a");
        cmd.add(enc != null ? "aac" : "copy");
        if (enc != null) {
            cmd.add("-b:a");
            cmd.add("128k");
        }
        cmd.add("-movflags");
        cmd.add("+faststart");
        cmd.add(out.toString());

        try {
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            Process p = pb.start();
            boolean done = p.waitFor() == 0;
            if (done && Files.exists(out) && Files.size(out) > 0) {
                try {
                    Files.deleteIfExists(rawPath);
                } catch (IOException e) {
                    // 忽略
                }
                return out.toString();
            }
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 编码器描述。 */
    static final class Encoder {
        final String name;
        final List<String> args;

        Encoder(String name, List<String> args) {
            this.name = name;
            this.args = args;
        }
    }

    private static Encoder cachedEncoder;
    private static boolean encoderProbed = false;

    /**
     * 探测本机可用的 H.264 编码器（结果缓存）。
     * 优先级：环境变量指定 > libx264 > libopenh264 > h264_qsv / h264_v4l2m2m。
     */
    static synchronized Encoder h264Encoder() {
        if (encoderProbed) return cachedEncoder;
        encoderProbed = true;

        String preset = Log.env("HG_H264_ENCODER", "").trim();
        String list = "";
        try {
            ProcessBuilder pb = new ProcessBuilder("ffmpeg", "-hide_banner", "-encoders");
            pb.redirectErrorStream(true);
            Process p = pb.start();
            byte[] out = p.getInputStream().readAllBytes();
            p.waitFor();
            list = new String(out, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
        final String fl = list;
        java.util.function.Predicate<String> has =
                (n) -> java.util.regex.Pattern.compile("\\s" + java.util.regex.Pattern.quote(n) + "\\s")
                        .matcher(fl).find();

        List<Encoder> table = new ArrayList<>();
        if (!preset.isEmpty() && has.test(preset)) {
            table.add(new Encoder(preset, new ArrayList<>()));
        } else {
            table.add(new Encoder("libx264",
                    new ArrayList<>(Arrays.asList("-preset", "veryfast", "-crf", "23"))));
            table.add(new Encoder("libopenh264", new ArrayList<>(Arrays.asList("-b:v", "2500k"))));
            table.add(new Encoder("h264_qsv", new ArrayList<>(Arrays.asList("-preset", "veryfast"))));
            table.add(new Encoder("h264_v4l2m2m", new ArrayList<>()));
        }
        for (Encoder e : table) {
            if (has.test(e.name)) {
                // pix_fmt 与 crf 只对 x264/openh264 有意义
                e.args.addAll(Arrays.asList("-pix_fmt", "yuv420p"));
                cachedEncoder = e;
                return cachedEncoder;
            }
        }
        return null;
    }

    // ==================== 缓存 ====================

    /** 缓存路径三变体。 */
    public static final class Paths3 {
        public final Path out;    // 未加密直下的成品
        public final Path play;   // 加密解密 + remux 后的成品
        public final Path raw;    // remux 前的解密产物

        Paths3(Path out, Path play, Path raw) {
            this.out = out;
            this.play = play;
            this.raw = raw;
        }
    }

    /**
     * 计算某集指定清晰度的缓存路径。
     *
     * 注意 play 路径：offlineDecrypt 末尾会 remux 出「基名.play.mp4」（并删掉 raw），
     * 而基名不含.raw 段，所以加密内容最终落盘的是 <vid>_<q>.play.mp4。
     * 三个变体都必须参与命中判定，否则加密集永远命中不了缓存。
     */
    public static Paths3 cachePaths(String vid, String quality) {
        String safeQ = quality.replaceAll("[^\\w]", "");
        if (safeQ.isEmpty()) safeQ = "best";
        Path base = cacheDir().resolve(vid + "_" + safeQ);
        return new Paths3(
                Paths.get(base + ".mp4"),
                Paths.get(base + ".play.mp4"),
                Paths.get(base + ".raw.mp4"));
    }

    /** 命中缓存则返回可播放文件路径，否则 null。 */
    public static String cachedPath(String vid, String quality) {
        Paths3 p = cachePaths(vid, quality);
        for (Path c : Arrays.asList(p.play, p.out, p.raw)) {
            try {
                if (Files.exists(c) && Files.size(c) > 0) return c.toString();
            } catch (IOException e) {
                // 忽略
            }
        }
        return null;
    }

    /** 确保某集已解密并落盘缓存，返回可播放 mp4 路径。 */
    public static String ensureDecrypted(String vid, String quality) throws Exception {
        Files.createDirectories(cacheDir());
        Paths3 p = cachePaths(vid, quality);

        String hit = cachedPath(vid, quality);
        if (hit != null) {
            // 只有残留的 raw（缺 play 成品）才需要补一次 remux
            if (!hit.equals(p.raw.toString())) return hit;
            String r = remuxPlayable(p.raw);
            if (r != null) return r;
        }

        String outKey = p.out.toString();
        CompletableTask exist = INFLIGHT.get(outKey);
        if (exist != null) return exist.get(); // 同集并发只解一次

        CompletableTask task = new CompletableTask();
        INFLIGHT.put(outKey, task);
        try {
            String again = cachedPath(vid, quality);
            if (again != null && !again.equals(p.raw.toString())) {
                task.complete(again);
                return again;
            }
            VideoTrack t = videoTrack(vid, quality);
            if (t == null || t.url == null || t.url.isEmpty()) {
                throw new IOException("无直链 / video_model");
            }
            if (!t.encrypt) {
                download(t.url, p.out);
                task.complete(p.out.toString());
                pruneCache();
                return p.out.toString();
            }
            Path ct = Paths.get(p.out + ".enc");
            download(t.url, ct);
            try {
                DecryptOut r = offlineDecrypt(t.spadeA, ct, p.raw);
                // remux 成功时返回 .play.mp4，失败时回退 raw
                String res = (r.path != null) ? r.path : p.raw.toString();
                task.complete(res);
                // 落盘完成后再清理：此时 play/raw 已是成品，不会误删半成品
                pruneCache();
                return res;
            } finally {
                try {
                    Files.deleteIfExists(ct);
                } catch (IOException e) {
                    // 忽略
                }
            }
        } catch (Exception e) {
            task.fail(e);
            throw e;
        } finally {
            INFLIGHT.remove(outKey);
        }
    }

    /**
     * 预热线程池：有界，避免高频调用 /prewarm 时无限建线程。
 *
     * 背景：原实现每次调用 new Thread()，而每次预热都会跑完整的
     * 下载 + 解密（各自持一份样本缓冲）。高频调用会让线程数与内存同步膨胀。
 * 有界池 + CallerRunsPolicy 让超出的请求在调用方线程执行（自然限流），
 * 而不是无限制地堆积。
     */
    private static final java.util.concurrent.ThreadPoolExecutor PREWARM_POOL =
            new java.util.concurrent.ThreadPoolExecutor(
                    2, 4,
                    60L, java.util.concurrent.TimeUnit.SECONDS,
                    new java.util.concurrent.LinkedBlockingQueue<>(64),
                    r -> {
                        Thread t = new Thread(r, "prewarm");
                        t.setDaemon(true);
                        return t;
                    },
                    new java.util.concurrent.ThreadPoolExecutor.CallerRunsPolicy());

    /** 预热失败后的最大重试次数（不含首次尝试）。 */
    private static final int PREWARM_MAX_RETRIES = 3;

    /** 两次预热重试之间的间隔（毫秒）。 */
    private static final long PREWARM_RETRY_DELAY_MS = 500L;

    /**
     * 预热执行体：失败时按 {@link #PREWARM_MAX_RETRIES} 重试，全数失败才抛出。
     *
     * 背景：预热失败多数源于瞬时问题（网络抖动、签名服务短暂不可用、
     * 视频直链偶发为空），立刻放弃会让一次预热白跑。重试能显著提升成功率。
     *
     * 注意 {@code ensureDecrypted} 自带INFLIGHT 去重与 finally 清理，
     * 失败后 INFLIGHT 已移除条目，重试不会命中上次的残留状态。
     *
     * @return 成功时的可播放路径
     * @throws Exception 全部尝试均失败时，抛出最后一次的异常
     */
    private static String prewarmOnce(String vid, String quality) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt <= PREWARM_MAX_RETRIES; attempt++) {
            if (attempt > 0) {
                // 重试前稍作等待，给瞬时故障一个恢复窗口
                try {
                    Thread.sleep(PREWARM_RETRY_DELAY_MS);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    throw ie;
                }
            }
            try {
                return ensureDecrypted(vid, quality);
            } catch (Exception e) {
                last = e;
                Log.warn("预热失败 " + vid + "（第 " + (attempt + 1) + "/"
                        + (PREWARM_MAX_RETRIES + 1) + " 次尝试）：" + e.getMessage());
            }
        }
        throw last;
    }

    /** 预热：后台触发解密，不阻塞响应。 */
    public static String prewarm(final String vid, final String quality) {
        String hit = cachedPath(vid, quality);
        if (hit != null) return "cached";
        // 故意不等待：让解密在后台跑
        try {
            PREWARM_POOL.execute(() -> {
                try {
                    prewarmOnce(vid, quality);
                } catch (Exception e) {
                    Log.warn("预热最终失败 " + vid + "：已重试 " + PREWARM_MAX_RETRIES
                            + " 次仍不成功，" + e.getMessage());
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException e) {
            // 队列与线程池都满：退化为当前线程同步执行，保证预热仍然生效
            try {
                prewarmOnce(vid, quality);
            } catch (Exception ex) {
                Log.warn("预热最终失败 " + vid + "：已重试 " + PREWARM_MAX_RETRIES
                        + " 次仍不成功，" + ex.getMessage());
                return "failed";
            }
        }
        return "warming";
    }

    // ==================== 缓存上限清理 ====================

    /** 默认保留的缓存文件数上限。 */
    public static final int CACHE_MAX_FILES = 30;

    /** 上限配置项：设为 0 或负数表示不限制。 */
    private static final String CACHE_MAX_ENV = "HONGGUO_CACHE_MAX_FILES";

    /**
     * 清理缓存目录，只保留最新的 {@link #CACHE_MAX_FILES} 个文件。
     *
     * 按**最后修改时间**倒序保留，最旧的先删。每个 {@code <vid>_<q>} 最多留下
     * 一个成品（play > out > raw），因此实际删除数会略多于「超出的个数」。
     *
     * 两种文件不参与清理、也不会被删：
     * - {@code *.part}：下载临时文件，仍在被写；
     * - {@code *.enc}：密文临时文件，解密中且 finally 还要用。
     *
     * 上限由 {@code HONGGUO_CACHE_MAX_FILES} 控制，默认 {@value #CACHE_MAX_FILES}；
     * 设为 0 或负数即关闭清理（不限数量）。
     *
     * 放在decrypt 落盘**之后**调用：此时 raw/play 才是成品，不会误删半成品。
     * 异常全程吞掉——清理失败不该让播放失败；只有失败时才记日志，
     * 正常清理保持静默（避免每次解密落盘都刷一行）。
     *
     * @return 被删除的文件数
     */
    public static int pruneCache() {
        return pruneCache(Log.envInt(CACHE_MAX_ENV, CACHE_MAX_FILES));
    }

    /** 清理缓存目录，limit<=0 时不做任何事。 */
    public static int pruneCache(int limit) {
        if (limit <= 0) return 0;
        Path dir = cacheDir();
        // 目录不存在说明还没落过盘，无需清理
        if (!Files.isDirectory(dir)) return 0;

        try {
            List<Path> keepable = new ArrayList<>();
            try (java.util.stream.Stream<Path> s = Files.list(dir)) {
                for (Path p : s.toArray(Path[]::new)) {
                    if (!Files.isRegularFile(p)) continue;
                    String n = p.getFileName().toString();
                    // 跳过下载/密文临时文件，避免删掉正在写或解密仍要用的
                    if (n.endsWith(".part") || n.endsWith(".enc")) continue;
                    keepable.add(p);
                }
            }
            if (keepable.size() <= limit) return 0;

            // 最后修改时间倒序：靠前的保留，靠后的（更旧）删除
            keepable.sort((a, b) -> Long.compare(mtime(b), mtime(a)));

            int deleted = 0;
            for (int i = limit; i < keepable.size(); i++) {
                Path victim = keepable.get(i);
                try {
                    Files.deleteIfExists(victim);
                    deleted++;
                } catch (IOException e) {
                    // 单个失败不影响其余，照常删；仅记录，不中断
                    Log.warn("缓存清理：删除 " + victim.getFileName()
                            + " 失败：" + e.getMessage());
                }
            }
            // 正常清理不打印日志（此前每次清理都会向控制台输出一行）
            return deleted;
        } catch (Exception e) {
            // 清理是尽力而为，失败不应影响播放
            Log.warn("缓存清理失败：" + e.getMessage());
            return 0;
        }
    }

    /** 最后修改时间，读取失败按 0 兜底（视作最旧，优先被删）。 */
    private static long mtime(Path p) {
        try {
            return Files.getLastModifiedTime(p).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    // ==================== 环境探测 ====================

    private static Boolean cachedFfmpeg = null;

    /** ffmpeg 是否可用（同步检查一次并缓存）。 */
    public static synchronized boolean ffmpegAvailable() {
        if (cachedFfmpeg != null) return cachedFfmpeg;
        try {
            ProcessBuilder pb = new ProcessBuilder("ffmpeg", "-version");
            pb.redirectOutput(ProcessBuilder.Redirect.DISCARD);
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            Process p = pb.start();
            boolean ok = p.waitFor() == 0;
            cachedFfmpeg = ok;
            return ok;
        } catch (Exception e) {
            cachedFfmpeg = false;
            return false;
        }
    }

    /** 转码是否启用（HG_TRANSCODE=1 且找到编码器）。 */
    public static boolean transcodeEnabled() {
        return Config.bool("runtime.transcode", false) && h264EncoderName() != null;
    }

    /** 当前实际使用的 H.264 编码器名（未启用/不可用时返回 null）。 */
    public static String h264EncoderName() {
        if (!Config.bool("runtime.transcode", false)) return null;
        if (!ffmpegAvailable()) return null;
        Encoder e = h264Encoder();
        return e != null ? e.name : null;
    }
}
