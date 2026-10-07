package com.hongguo.api;

import com.hongguo.api.core.KeyStore;
import com.hongguo.api.core.Safeguards;
import com.hongguo.api.service.Client;
import com.hongguo.api.service.Res;
import com.hongguo.api.service.Signer;
import com.hongguo.api.service.Stream;
import com.hongguo.api.util.Crypto;
import com.hongguo.api.util.Http;
import com.hongguo.api.util.Json;
import com.hongguo.api.util.Config;
import com.hongguo.api.util.Log;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 红果短剧 Web 服务。
 *
 * 移植自 server/src/server.js（Node.js 版），
 * 改用 JDK 自带 com.sun.net.httpserver，零第三方依赖。
 *
 * 路由与原版保持一致：/ /health /api-key /search /rank /latest /filters
 *                  /browse /episodes /play /stream /video_url /img
 *                  /download /prewarm /stats /metrics/batch /admin/keys
 */
public class Server {

    private final KeyStore keys = new KeyStore();
    private final String adminToken;
    private final int ratePerMin;
    private final Path webDir;

    private final long startTime = System.currentTimeMillis();
    private final Map<String, long[]> buckets = new ConcurrentHashMap<>();
    private final Stats stats = new Stats();

    /** 运行统计。 */
    static final class Stats {
        long requests;
        long errors;
        long risk;
        long authFail;
    }

    /** 免鉴权路径。 */
    private static final Set<String> EXEMPT = new HashSet<>(Arrays.asList(
            "/", "/ui", "/img", "/favicon.ico", "/health", "/api-key"));

    public Server() {
        String tok = Log.env("ADMIN_TOKEN", null);
        this.adminToken = (tok != null) ? tok : randomHex(32);
        this.ratePerMin = Log.envInt("RATE_PER_MIN", 120);

        String wd = Log.env("WEB_DIR", null);
        this.webDir = (wd != null) ? Paths.get(wd) : Paths.get("web");
    }

    private static String randomHex(int bytes) {
        byte[] b = new byte[bytes];
        new java.security.SecureRandom().nextBytes(b);
        return Crypto.hex(b);
    }

    public String adminToken() { return adminToken; }

    /**
     * 首次启动自动签发一把本地链路密钥，避免用户手动配置。
     * 已有密钥时返回 null（不打扰）。
     */
    public String ensureBootstrap() {
        return keys.ensureBootstrap();
    }

    // ==================== 启动 ====================

    public void start(String host, int port) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 128);
        server.createContext("/", this::handle);
        // 用固定线程池，避免默认实现拒绝并发请求
        server.setExecutor(Executors.newFixedThreadPool(32));
        server.start();
        Log.info("红果短剧 Web API  http://" + host + ":" + port);
        Log.info("前端页面        http://" + host + ":" + port + "/ui");
        Log.info("签名后端        " + (Signer.signServers().isEmpty()
                ? "(未配置 SIGN_SERVER)" : String.join(", ", Signer.signServers())));
        Log.info("上游 host       " + Client.HOST);
    }

    // ==================== 主处理 ====================

    private void handle(HttpExchange ex) throws IOException {
        try {
            String rawPath = ex.getRequestURI().getRawPath();
            String pathname;
            try {
                pathname = Http.urldecode(rawPath);
            } catch (Exception e) {
                pathname = rawPath;
            }
            String method = ex.getRequestMethod();
            Map<String, String> q = Http.parseQuery(ex.getRequestURI().getRawQuery());

            // CORS 预检
            if (method.equals("OPTIONS")) {
                com.sun.net.httpserver.Headers h = ex.getResponseHeaders();
                h.set("Access-Control-Allow-Origin", "*");
                h.set("Access-Control-Allow-Methods", "GET,HEAD,POST,DELETE,OPTIONS");
                h.set("Access-Control-Allow-Headers",
                        "content-type,x-api-key,x-admin-token,range");
                h.set("Access-Control-Max-Age", "86400");
                ex.sendResponseHeaders(204, -1);
                ex.close();
                return;
            }

            // 静态资源优先：前端页面与 JS/CSS 不参与 API 鉴权
            if (method.equals("GET") && Res.isStaticPath(pathname)) {
                Res.serveStatic(ex, pathname, webDir);
                return;
            }

            // 鉴权：管理/统计自行校验；静态资源与健康检查免鉴权
            if (!EXEMPT.contains(pathname) && !pathname.startsWith("/admin")
                    && !pathname.equals("/stats")) {
                String key = header(ex, "x-api-key");
                if (key == null || key.isEmpty()) key = q.getOrDefault("api_key", "");
                if (!keys.isValid(key)) {
                    stats.authFail++;
                    Res.fail(ex, 401, "缺少或无效的 api_key"
                            + "（请在客户端配置本地链路密钥；首次访问可先请求 /api-key）");
                    return;
                }
                if (!rateLimit(key)) {
                    Res.fail(ex, 429, "超过限流 " + ratePerMin + "/分钟");
                    return;
                }
                stats.requests++;
            }

            route(ex, method, pathname, q);

        } catch (Exception e) {
            stats.errors++;
            if (e instanceof Safeguards.RiskControlError) stats.risk++;
            boolean isAuth = e instanceof Safeguards.AuthExpiredError;
            Map<String, Object> m = Json.obj();
            m.put("detail", String.valueOf(e.getMessage() == null ? e : e.getMessage()));
            if (e instanceof Safeguards.ApiError) {
                Safeguards.ApiError ae = (Safeguards.ApiError) e;
                if (ae.safeResponse != null) m.put("safe_response", ae.safeResponse);
                if (ae.diagnostic != null) m.put("response", ae.diagnostic);
                if (ae.modelShape != null) m.put("model_shape", ae.modelShape);
            }
            Res.json(ex, isAuth ? 401 : 502, m);
        } finally {
            ex.close();
        }
    }

    private static String header(HttpExchange ex, String name) {
        List<String> v = ex.getRequestHeaders().get(name);
        return (v == null || v.isEmpty()) ? null : v.get(0);
    }

    /**
     * 限流。
     *
     * 历史问题：桶 map 只增不减（key 为 api_key，永不清理），
     * 且每请求都 new long[] + ArrayList<Long> 装箱，在高频请求下产生大量短命对象。
     *
     * 现在改为单个 long[] 原地紧凑化（零装箱、零分配），
     * 并在桶数超阈值时顺带淘汰空闲桶。
     */
    private boolean rateLimit(String key) {
        long now = System.currentTimeMillis();
        // 清理时机：桶数量超过阈值时顺带淘汰空闲桶，避免每次请求都遍历
        if (buckets.size() > RATE_BUCKETS_MAX) sweepBuckets(now);

        long[] arr = buckets.computeIfAbsent(key, k -> new long[RATE_PER_MIN_SLOTS]);
        synchronized (arr) {
            // 原地压缩：保留最近 60s 内的记录。零分配。
            int n = 0;
            for (int i = 0; i < arr.length; i++) {
                long t = arr[i];
                if (t > now - 60000) arr[n++] = t;
            }
            if (n >= ratePerMin) {
                // 已超限：多余槽位无需清理，下次压缩会自然跳过
                return false;
            }
            if (n < arr.length) arr[n] = now;
            return true;
        }
    }

    /** 触发空闲清理的桶数量阈值：HG_RATE_BUCKETS_MAX，默认 4096。 */
    private static final int RATE_BUCKETS_MAX = Config.num("runtime.rate_buckets_max", 4096);

    /** 每个桶预分配的时间戳槽位；需 >= ratePerMin，否则超出部分无法记录。 */
    private static final int RATE_PER_MIN_SLOTS =
            Math.max(1024, Log.envInt("RATE_PER_MIN", 120) + 64);

    /** 桶空闲多久后回收：HG_RATE_BUCKET_IDLE_MS，默认 10 分钟。 */
    private static final long RATE_BUCKET_IDLE_MS =
            Config.num("runtime.rate_bucket_idle_ms", 600) * 1000L;

    /** 淘汰空闲超时的桶。 */
    private void sweepBuckets(long now) {
        buckets.entrySet().removeIf(e -> {
            long[] arr = e.getValue();
            if (arr == null) return true;
            long newest = 0;
            synchronized (arr) {
                for (long t : arr) if (t > newest) newest = t;
            }
            return now - newest > RATE_BUCKET_IDLE_MS;
        });
    }

    private boolean checkAdmin(HttpExchange ex, Map<String, String> q) {
        String tok = header(ex, "x-admin-token");
        if (tok == null || tok.isEmpty()) tok = q.getOrDefault("admin_token", "");
        return !tok.isEmpty() && tok.equals(adminToken);
    }

    // ==================== 路由分发 ====================

    private void route(HttpExchange ex, String method, String pathname, Map<String, String> q)
            throws Exception {
        // ---- 无需鉴权的基础接口 ----
        if (method.equals("GET") && pathname.equals("/")) {
            Map<String, Object> m = Json.obj();
            m.put("service", "红果短剧 Web API");
            m.put("ui", "/ui");
            m.put("managed", Client.MANAGED);
            m.put("endpoints", new ArrayList<>(Arrays.asList(
                    "/search?q=", "/rank?board=recommend|hot|new&limit=",
                    "/latest?genre=short_play|comic_series|ai_series&only_today=true",
                    "/filters?genre=short_play",
                    "/browse?genre=ai_series&theme=玄幻&sort=hot_score&days=7",
                    "/episodes?series_id=", "/play?series_id=&ep=1-10",
                    "/stream?series_id=&ep=1", "/stream?vid=&quality=1080p",
                    "/prewarm?vid=", "/stats")));
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/health")) {
            Map<String, Object> m = Json.obj();
            m.put("ok", true);
            m.put("uptime_s", (System.currentTimeMillis() - startTime) / 1000);
            m.put("sign_backends", Signer.health());
            m.put("api_host", Client.HOST);
            m.put("ffmpeg", Stream.ffmpegAvailable());
            m.put("transcode", Stream.transcodeEnabled());
            m.put("h264_encoder", Stream.h264EncoderName());
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/api-key")) {
            KeyStore.Rec k = keys.firstEnabled();
            if (k == null) {
                String nk = keys.generate("auto");
                k = keys.get(nk);
            }
            Map<String, Object> m = Json.obj();
            m.put("api_key", k.key);
            m.put("note", k.note);
            m.put("rate_per_min", ratePerMin);
            Res.json(ex, 200, m);
            return;
        }

        // ---- 数据接口 ----
        if (method.equals("GET") && (pathname.equals("/search") || pathname.equals("/search/page"))) {
            String query = q.getOrDefault("q", "");
            if (query.isEmpty()) {
                Res.fail(ex, 400, "缺少 q");
                return;
            }
            String lim = q.get("limit");
            int searchOff = Integer.parseInt(q.getOrDefault("offset", "0"));
            int searchLimit = lim == null || lim.isEmpty() ? 0 : Integer.parseInt(lim);
            Map<String, Object> m = Json.obj();
            m.put("query", query);
            // 首屏与续页走同一套逻辑，避免首屏拿不到 has_more 时前端只能乐观假设
            // 「还有更多」，结果总数不足一页时要多点一次才知道到底。
            Client.Page pg = Client.searchPage(query, searchLimit, searchOff);
            m.put("count", pg.items.size());
            m.put("results", pg.items);
            m.put("has_more", pg.hasMore);
            m.put("next_offset", pg.nextSkip);
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/rank")) {
            String board = q.getOrDefault("board", "recommend");
            int limit = Integer.parseInt(q.getOrDefault("limit", "30"));
            if (!Client.RANK_BOARDS.containsKey(board)) {
                Res.fail(ex, 400, "board 必须是 " + String.join("|", Client.RANK_BOARDS.keySet()));
                return;
            }
            // offset>0 走分页路径（供无限滚动）；缺省保持原行为，首屏不受影响
            int offset = Integer.parseInt(q.getOrDefault("offset", "0"));
            Map<String, Object> m = Json.obj();
            m.put("board", board);
            m.put("name", Client.RANK_NAMES.get(board));
            if (offset > 0) {
                Client.RankPage pg = Client.rankPage(board, limit, offset);
                m.put("items", pg.items);
                m.put("has_more", pg.hasMore);
                m.put("next_offset", pg.nextOffset);
            } else {
                m.put("items", Client.rank(board, limit));
            }
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/latest")) {
            String genre = q.getOrDefault("genre", "short_play");
            if (!Client.GENRES.containsKey(genre)) {
                Res.fail(ex, 400, "genre 必须是 " + String.join("|", Client.GENRES.keySet()));
                return;
            }
            boolean onlyToday = !"false".equals(q.get("only_today"));
            int limit = Integer.parseInt(q.getOrDefault("limit", "120"));
            boolean refresh = "true".equals(q.get("refresh")) || "true".equals(q.get("no_cache"));
            String mode = genre.equals("short_play")
                    ? (onlyToday ? "今日上新" : "最新上架")
                    : "7天内上新·最新上架";
            Map<String, Object> m = Json.obj();
            m.put("genre", genre);
            m.put("name", Client.GENRE_NAMES.get(genre));
            m.put("mode", mode);
            m.put("only_today", onlyToday);
            // offset>0 或带seen 走分页路径；前端把已看过的 series_id 以逗号串回传，
            // 上游据此去重，因此续页内容不会与前面重复
            int offset = Integer.parseInt(q.getOrDefault("offset", "0"));
            String seenRaw = q.get("seen");
            List<String> seen = null;
            if (seenRaw != null && !seenRaw.isEmpty()) {
                seen = new ArrayList<>(java.util.Arrays.asList(seenRaw.split(",")));
            }
            if (offset > 0 || seen != null) {
                Client.Page pg = Client.latestPage(genre, onlyToday, limit, refresh, seen, offset);
                m.put("count", pg.items.size());
                m.put("items", pg.items);
                m.put("has_more", pg.hasMore);
                m.put("next_offset", pg.nextSkip);
            } else {
                List<Object> items = Client.latest(genre, onlyToday, limit, refresh);
                m.put("count", items.size());
                m.put("items", items);
            }
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/filters")) {
            String genre = q.getOrDefault("genre", "short_play");
            if (!Client.GENRES.containsKey(genre)) {
                Res.fail(ex, 400, "genre 必须是 " + String.join("|", Client.GENRES.keySet()));
                return;
            }
            List<Object> rows = Client.filters(genre);
            Map<String, Object> m = Json.obj();
            m.put("genre", genre);
            m.put("name", Client.GENRE_NAMES.get(genre));
            m.put("rows", rows);
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/browse")) {
            String genre = q.getOrDefault("genre", "short_play");
            if (!Client.GENRES.containsKey(genre)) {
                Res.fail(ex, 400, "genre 必须是 " + String.join("|", Client.GENRES.keySet()));
                return;
            }
            Map<String, String> opts = new LinkedHashMap<>();
            for (String k : new String[]{"theme", "setting", "background", "sort",
                    "gender", "days", "status", "limit"}) {
                if (q.containsKey(k)) opts.put(k, q.get(k));
            }
            List<Object> items;
            boolean hasMore = false;
            int nextOffset = 0;
            int offset = Integer.parseInt(q.getOrDefault("offset", "0"));
            String seenRaw = q.get("seen");
            if (offset > 0 || (seenRaw != null && !seenRaw.isEmpty())) {
                List<String> seen = new ArrayList<>(java.util.Arrays.asList(seenRaw.split(",")));
                Client.Page pg = Client.browsePage(genre, opts, seen, offset);
                items = pg.items;
                hasMore = pg.hasMore;
                nextOffset = pg.nextSkip;
            } else {
                items = Client.browse(genre, opts);
            }
            // 补上播放与剧集入口
            for (Object itObj : items) {
                Map<String, Object> it = Json.optObj(itObj);
                if (it == null) continue;
                String sid = Json.optStr(it.get("series_id"), "");
                String vid = Json.optStr(it.get("vid"), "");
                it.put("stream_url", !vid.isEmpty() ? "/stream?vid=" + vid
                        : "/stream?series_id=" + sid + "&ep=1");
                it.put("episodes_url", "/episodes?series_id=" + sid);
            }
            Map<String, Object> m = Json.obj();
            m.put("genre", genre);
            m.put("name", Client.GENRE_NAMES.get(genre));
            m.put("count", items.size());
            m.put("items", items);
            if (hasMore || nextOffset > 0) {
                m.put("has_more", hasMore);
                m.put("next_offset", nextOffset);
            }
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/episodes")) {
            String sid = q.get("series_id");
            if (sid == null || sid.isEmpty()) {
                Res.fail(ex, 400, "缺少 series_id");
                return;
            }
            Res.json(ex, 200, Client.getEpisodes(sid));
            return;
        }

        if (method.equals("POST") && pathname.equals("/metrics/batch")) {
            Map<String, Object> payload = readJson(ex);
            Object raw = payload.containsKey("series_ids") ? payload.get("series_ids")
                    : payload.get("series_id");
            List<String> ids = new ArrayList<>();
            if (raw instanceof List) {
                for (Object o : (List<?>) raw) ids.add(String.valueOf(o).trim());
            } else {
                List<String> sp = Http.splitCsv(String.valueOf(raw));
                if (sp != null) ids.addAll(sp);
            }
            ids.removeIf(String::isEmpty);
            if (ids.isEmpty()) {
                Res.fail(ex, 400, "series_ids 不能为空");
                return;
            }
            if (ids.size() > 200) {
                Res.fail(ex, 400, "series_ids 最多 200 个");
                return;
            }
            Object[] r = Client.getEpisodesBatch(ids,
                    Json.optInt(payload.get("batch_size"), 20));
            @SuppressWarnings("unchecked")
            Map<String, Object> items = (Map<String, Object>) r[0];
            List<Object> rows = new ArrayList<>();
            for (String sid : ids) {
                if (items.containsKey(sid)) rows.add(items.get(sid));
            }
            Map<String, Object> m = Json.obj();
            m.put("count", rows.size());
            m.put("items", rows);
            m.put("failed", r[1]);
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/play")) {
            String sid = q.get("series_id");
            if (sid == null || sid.isEmpty()) {
                Res.fail(ex, 400, "缺少 series_id");
                return;
            }
            Map<String, Object> meta = Client.getEpisodes(sid);
            List<Object> eps = Json.optArr(meta.get("episodes"));
            Set<Long> want = parseRange(q.getOrDefault("ep", "all"), eps.size());

            List<Object> sel = new ArrayList<>();
            for (Object eObj : eps) {
                Map<String, Object> e = Json.optObj(eObj);
                if (e != null && want.contains(Json.optLong(e.get("index"), 0))) {
                    sel.add(e);
                }
            }
            List<String> vids = new ArrayList<>();
            for (Object eObj : sel) {
                vids.add(Json.optStr(Json.optObj(eObj).get("vid"), ""));
            }
            Map<String, Object> urls = Client.getVideoUrls(vids, false);

            List<Object> out = new ArrayList<>();
            for (Object eObj : sel) {
                Map<String, Object> e = Json.optObj(eObj);
                String vid = Json.optStr(e.get("vid"), "");
                Map<String, Object> info = Json.optObj(urls.get(vid));
                if (info == null) info = Json.obj();
                Map<String, Object> row = Json.obj();
                row.put("index", Json.optLong(e.get("index"), 0));
                row.put("vid", vid);
                row.put("title", Json.optStr(e.get("title"), ""));
                row.put("duration", Json.optLong(e.get("duration"), 0));
                row.put("encrypted_url", info.get("url"));
                row.put("backup", info.get("backup"));
                row.put("size", info.get("size"));
                row.put("definition", info.get("definition"));
                // 与 Node 版对齐：info.shape 为 undefined 时 JSON.stringify 会省略该键，
                // 因此这里只在真正有值时才放入，避免输出 "shape": null。
                if (info.get("shape") != null) row.put("shape", info.get("shape"));
                row.put("url_is_http", info.get("url_is_http"));
                row.put("stream_url", "/stream?vid=" + vid);
                out.add(row);
            }
            Map<String, Object> m = Json.obj();
            m.put("series_id", sid);
            m.put("title", Json.optStr(Json.optObj(meta.get("meta")).get("title"), ""));
            m.put("note", "encrypted_url 为 CENC 密文直链；可播放用 stream_url（服务端纯离线解密）");
            m.put("episodes", out);
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/prewarm")) {
            String vid = q.get("vid");
            if (vid == null || vid.isEmpty()) {
                Res.fail(ex, 400, "需 vid");
                return;
            }
            String state = Stream.prewarm(vid, q.getOrDefault("quality", "best"));
            Map<String, Object> m = Json.obj();
            m.put("ok", true);
            m.put("vid", vid);
            m.put("state", state);
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/video_url")) {
            String vid = q.get("vid");
            if (vid == null || vid.isEmpty()) {
                Res.fail(ex, 400, "缺少 vid");
                return;
            }
            Map<String, Object> urls = Client.getVideoUrls(
                    new ArrayList<>(Arrays.asList(vid)), false);
            Map<String, Object> info = Json.optObj(urls.get(String.valueOf(vid)));
            if (info == null || info.get("url") == null) {
                Res.fail(ex, 404, "无直链");
                return;
            }
            Map<String, Object> m = Json.obj();
            m.put("vid", vid);
            m.put("url", info.get("url"));
            m.put("backup", info.get("backup"));
            m.put("size", info.get("size"));
            m.put("definition", info.get("definition"));
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/stream")) {
            handleStream(ex, q);
            return;
        }

        if (method.equals("GET") && pathname.equals("/img")) {
            handleImg(ex, q);
            return;
        }

        if (method.equals("GET") && pathname.equals("/download")) {
            String vid = q.get("vid");
            String sid = q.get("series_id");
            if ((vid == null || vid.isEmpty()) && (sid == null || sid.isEmpty())) {
                Res.fail(ex, 400, "需 vid 或 series_id");
                return;
            }
            if (sid != null && !sid.isEmpty() && (vid == null || vid.isEmpty())) {
                Map<String, Object> meta = Client.getEpisodes(sid);
                int idx = Integer.parseInt(q.getOrDefault("ep", "1"));
                for (Object eObj : Json.optArr(meta.get("episodes"))) {
                    Map<String, Object> e = Json.optObj(eObj);
                    if (e != null && Json.optLong(e.get("index"), 0) == idx) {
                        vid = Json.optStr(e.get("vid"), "");
                        break;
                    }
                }
            }
            String file = Stream.ensureDecrypted(vid, q.getOrDefault("quality", "best"));
            Map<String, Object> m = Json.obj();
            m.put("ok", true);
            m.put("path", file);
            m.put("size", Files.size(Paths.get(file)));
            Res.json(ex, 200, m);
            return;
        }

        if (method.equals("GET") && pathname.equals("/stats")) {
            if (!checkAdmin(ex, q)) {
                Res.fail(ex, 401, "需要 admin_token");
                return;
            }
            Map<String, Object> m = Json.obj();
            m.put("uptime_s", (System.currentTimeMillis() - startTime) / 1000);
            m.put("requests", stats.requests);
            m.put("errors", stats.errors);
            m.put("risk", stats.risk);
            m.put("auth_fail", stats.authFail);
            m.put("cache_backend", "memory");
            m.put("sign_backends", Signer.health());
            m.put("enabled_keys", keys.countEnabled());
            Res.json(ex, 200, m);
            return;
        }

        // ---- 管理接口 ----
        if (pathname.startsWith("/admin/keys")) {
            if (!checkAdmin(ex, q)) {
                Res.fail(ex, 401, "admin_token 无效");
                return;
            }
            if (method.equals("GET") && pathname.equals("/admin/keys")) {
                Map<String, Object> m = Json.obj();
                m.put("keys", keys.list());
                m.put("enabled_count", keys.countEnabled());
                Res.json(ex, 200, m);
                return;
            }
            if (method.equals("POST") && pathname.equals("/admin/keys")) {
                String note = q.getOrDefault("note", "");
                String key = keys.generate(note);
                Map<String, Object> m = Json.obj();
                m.put("ok", true);
                m.put("key", key);
                m.put("note", note);
                Res.json(ex, 200, m);
                return;
            }
            if (method.equals("POST") && pathname.equals("/admin/keys/revoke")) {
                String k = q.getOrDefault("key", "");
                boolean enable = "true".equals(q.get("enable"));
                Map<String, Object> m = Json.obj();
                m.put("ok", keys.revoke(k, enable));
                Res.json(ex, 200, m);
                return;
            }
            if (method.equals("DELETE") && pathname.equals("/admin/keys")) {
                Map<String, Object> m = Json.obj();
                m.put("ok", keys.delete(q.getOrDefault("key", "")));
                Res.json(ex, 200, m);
                return;
            }
        }

        // GET 兜底：静态资源 / 404
        if (method.equals("GET")) {
            Res.serveStatic(ex, pathname, webDir);
            return;
        }
        Res.fail(ex, 404, "not found");
    }

    /** 处理 /stream：定位集号 -> 确保解密 -> Range 串流。 */
    private void handleStream(HttpExchange ex, Map<String, String> q) throws Exception {
        String vid = q.get("vid");
        String filename = null;

        if (vid == null || vid.isEmpty()) {
            String sid = q.get("series_id");
            if (sid == null || sid.isEmpty()) {
                Res.fail(ex, 400, "需 series_id+ep 或 vid");
                return;
            }
            Map<String, Object> meta = Client.getEpisodes(sid);
            String epStr = q.getOrDefault("ep", "1");
            int idx = epStr.matches("\\d+") ? Integer.parseInt(epStr) : 1;
            String targetVid = null;
            String title = "";
            for (Object eObj : Json.optArr(meta.get("episodes"))) {
                Map<String, Object> e = Json.optObj(eObj);
                if (e != null && Json.optLong(e.get("index"), 0) == idx) {
                    targetVid = Json.optStr(e.get("vid"), "");
                    break;
                }
            }
            if (targetVid == null) {
                Res.fail(ex, 404, "集号不存在");
                return;
            }
            vid = targetVid;
            title = Json.optStr(Json.optObj(meta.get("meta")).get("title"), "");
            filename = Client.sanitize(title) + "_第"
                    + String.format("%03d", idx) + "集.mp4";
        }

        String quality = q.getOrDefault("quality", "best");
        String file = Stream.ensureDecrypted(vid, quality);
        if (filename == null) filename = vid + ".mp4";
        Res.streamFile(ex, Paths.get(file), vid, filename);
    }

    /** 图片代理：红果封面常为 HEIC，浏览器不支持；此处透传。 */
    private static final List<String> IMG_HOSTS = Arrays.asList(
            "fqnovelpic.com", "byteimg.com", "qznovelvod.com", "douyinpic.com", "pstatp.com");

    /**
     * 图片字节缓存。
     *
     * 历史问题：只按「条数< 1000」判断能否写入，却**从不淘汰**，
     * 且完全不考虑单张图片的字节大小（HEIC 封面可达数百 KB）。
     * 结果是一旦访问过上千张不同封面，这些 byte[] 会永久驻留堆中。
     *
     * 现在改为访问序 LRU + 字节上限（HG_IMG_CACHE_MAX_MB，默认 64MB）。
     */
    private static final Map<String, byte[]> imgCache =
            java.util.Collections.synchronizedMap(
                    new LinkedHashMap<String, byte[]>(256, 0.75f, true) {
                        @Override
                        protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
                            return imgCacheBytes.get() > IMG_CACHE_MAX_BYTES;
                        }
                    });

    /** 图片缓存当前字节数。 */
    private static final java.util.concurrent.atomic.AtomicLong imgCacheBytes =
            new java.util.concurrent.atomic.AtomicLong();

    /** 图片缓存字节上限：HG_IMG_CACHE_MAX_MB，默认 64MB。 */
    private static final long IMG_CACHE_MAX_BYTES =
            (long) Config.num("runtime.cache.img_max_mb", 64) * 1024L * 1024L;

    /** 单张图片上限：HG_IMG_MAX_KB，默认 4MB，超限不缓存。 */
    private static final long IMG_MAX_BYTES =
            (long) Config.num("runtime.cache.img_max_kb", 4096) * 1024L;

    private static byte[] imgCacheGet(String url) {
        synchronized (imgCache) {
            return imgCache.get(url);
        }
    }

    private static void imgCachePut(String url, byte[] data) {
        if (data.length > IMG_MAX_BYTES) return;   // 过大不入缓存
        synchronized (imgCache) {
            byte[] old = imgCache.put(url, data);
            if (old != null) imgCacheBytes.addAndGet(-old.length);
            imgCacheBytes.addAndGet(data.length);
        }
        // 超过上限时按 LRU 裁剪
        synchronized (imgCache) {
            java.util.Iterator<Map.Entry<String, byte[]>> it = imgCache.entrySet().iterator();
            while (imgCacheBytes.get() > IMG_CACHE_MAX_BYTES && it.hasNext()) {
                byte[] v = it.next().getValue();
                it.remove();
                imgCacheBytes.addAndGet(-v.length);
            }
        }
    }

    private void handleImg(HttpExchange ex, Map<String, String> q) throws IOException {
        String raw = (q.getOrDefault("url", "")).trim();
        java.net.URI uri;
        try {
            uri = java.net.URI.create(raw);
        } catch (Exception e) {
            Res.fail(ex, 400, "图片 URL 非法");
            return;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
        boolean hostOk = false;
        for (String h : IMG_HOSTS) {
            if (host.equals(h) || host.endsWith("." + h)) {
                hostOk = true;
                break;
            }
        }
        if (scheme == null || !("http".equals(scheme) || "https".equals(scheme)) || !hostOk) {
            Res.fail(ex, 400, "图片域名不允许");
            return;
        }
        byte[] hit = imgCacheGet(raw);
        if (hit != null) {
            Res.send(ex, 200, hit, Res.headers("image/jpeg", "max-age=86400"));
            return;
        }
        try {
            Http.Resp r = Http.send(new Http.Req(raw)
                    .method("GET").header("user-agent", "Mozilla/5.0").timeout(30000));
            if (!r.ok()) {
                Res.fail(ex, 404, "图片读取失败 HTTP " + r.status);
                return;
            }
            String ct = r.header("content-type");
            if (ct == null) ct = "image/jpeg";
            ct = ct.toLowerCase(Locale.ROOT);
            byte[] data = r.body;
            imgCachePut(raw, data);
            Res.send(ex, 200, data, Res.headers(
                    ct.contains("heic") ? "image/jpeg" : ct, "max-age=86400"));
        } catch (Exception e) {
            Res.fail(ex, 404, "图片读取失败: " + e.getMessage());
        }
    }

    /** 解析集号参数：'1' / '1-10' / 'all' -> 集号集合。 */
    private static Set<Long> parseRange(String ep, int total) {
        Set<Long> out = new java.util.LinkedHashSet<>();
        if (ep == null || ep.isEmpty() || ep.equals("all")) {
            for (int i = 1; i <= total; i++) out.add((long) i);
            return out;
        }
        Matcher m = Pattern.compile("^(\\d+)-(\\d+)$").matcher(ep);
        if (m.find()) {
            int a = Integer.parseInt(m.group(1));
            int b = Integer.parseInt(m.group(2));
            for (int i = a; i <= b; i++) out.add((long) i);
            return out;
        }
        if (ep.matches("\\d+")) {
            out.add(Long.parseLong(ep));
        }
        return out;
    }

    /** 读取并解析 JSON 请求体。 */
    private static Map<String, Object> readJson(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            byte[] body = is.readAllBytes();
            if (body.length > 1_000_000) throw new IOException("body 过大");
            if (body.length == 0) return Json.obj();
            return Json.parseObject(new String(body, StandardCharsets.UTF_8));
        }
    }
}
