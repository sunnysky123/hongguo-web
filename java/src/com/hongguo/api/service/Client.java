package com.hongguo.api.service;

import com.hongguo.api.core.Device;
import com.hongguo.api.core.Safeguards;
import com.hongguo.api.util.Crypto;
import com.hongguo.api.util.Http;
import com.hongguo.api.util.Json;
import com.hongguo.api.util.Log;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * 红果短剧 API 客户端。
 *
 * 移植自 server/src/client.js。保留原有语义：设备身份池、_rticket 时间戳、
 * x-ss-stub MD5、列表类接口免签、video_model 直链5 小时缓存、风控/登录态退避重试。
 */
public final class Client {

    private Client() {}

    // ==================== 配置装载 ====================

    @SuppressWarnings("unchecked")
    private static Map<String, Object> loadConfig() {
        List<String> candidates = new ArrayList<>();
        String env = Log.env("HONGGUO_CONTENT_CONFIG", null);
        if (env != null) candidates.add(env);
        candidates.add(Paths.get("server", "config", "content-config.json").toString());
        candidates.add(Paths.get("backend", "guest-config.json").toString());

        for (String c : candidates) {
            try {
                Path p = Paths.get(c);
                if (!Files.exists(p)) continue;
                String raw = new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
                if (!raw.isEmpty() && raw.charAt(0) == '﻿') raw = raw.substring(1);
                return Json.parseObject(raw);
            } catch (Exception e) {
                // 尝试下一个
            }
        }
        throw new RuntimeException("未找到内容配置（content-config.json / guest-config.json）");
    }

    private static final Map<String, Object> CFG = loadConfig();

    public static final String HOST = Log.env("HONGGUO_HOST", Json.optStr(CFG.get("api_host"), ""));

    @SuppressWarnings("unchecked")
    public static Map<String, Object> baseQuery() {
        Map<String, Object> q = Json.optObj(CFG.get("base_query"));
        return q != null ? q : Json.obj();
    }

    @SuppressWarnings("unchecked")
    public static Map<String, String> sessionHeaders() {
        Map<String, Object> h = Json.optObj(CFG.get("session_headers"));
        Map<String, String> out = new LinkedHashMap<>();
        if (h != null) {
            for (Map.Entry<String, Object> e : h.entrySet()) {
                if (e.getValue() != null) out.put(e.getKey(), String.valueOf(e.getValue()));
            }
        }
        return out;
    }

    // search/tab/v 等接口校验 query 里的 device_id，缺失一律返回 code=100103
    // PARAM_INVALID。这里补齐一个本机稳定且持久化的值。
    private static final Map<String, Object> BASE_QUERY = baseQuery();
    private static final Device.Identity IDENTITY = Device.ensureDeviceId(BASE_QUERY);

    /** 桌面托管模式标志：存在则禁止刷新登录态、禁止降级容错。 */
    public static final boolean MANAGED =
            Log.env("HONGGUO_SESSION_API_KEY", null) != null;

    /** 仅 landpage/cell 系列列表接口免签（原 SIGN_LIST 语义）。 */
    public static final boolean SIGN_LIST = Arrays.asList("1", "true", "yes", "on")
            .contains(Log.env("HG_SIGN_LIST", "").toLowerCase());

    private static final String USER_AGENT = Log.env("HONGGUO_UA",
            sessionHeaders().getOrDefault("user-agent", "hongguo-web/1.0"));

    /** 设备身份池（DEVICE_POOL_SIZE > 0 时启用；托管模式固定单设备）。 */
    private static final Safeguards.DevicePool POOL = Safeguards.loadDevicePool(
            BASE_QUERY,
            Log.envInt("DEVICE_POOL_SIZE", 0),
            MANAGED,
            IDENTITY.deviceId);

    private static Safeguards.PoolDevice currentDevice() {
        return POOL == null ? null : POOL.current();
    }

    public static Safeguards.PoolDevice rotateDevice() {
        return POOL == null ? null : POOL.rotate();
    }

    public static Device.Identity identity() { return IDENTITY; }

    // ==================== 榜单 / 体裁常量 ====================

    public static final Map<String, String> RANK_BOARDS = new LinkedHashMap<>();
    public static final Map<String, String> RANK_NAMES = new LinkedHashMap<>();
    static {
        RANK_BOARDS.put("recommend", "comic_series_hot_rank");
        RANK_BOARDS.put("hot", "comic_series_hot_play");
        RANK_BOARDS.put("new", "comic_series_new_rank");
        RANK_NAMES.put("recommend", "漫剧推荐榜");
        RANK_NAMES.put("hot", "漫剧热播榜");
        RANK_NAMES.put("new", "漫剧新剧榜");
    }

    public static final String COMIC_RANK_CELL = "7470092475068071998";

    /** genre -> [req_scene, genre] */
    public static final Map<String, String[]> GENRES = new LinkedHashMap<>();
    public static final Map<String, String> GENRE_NAMES = new LinkedHashMap<>();
    static {
        GENRES.put("short_play", new String[]{"default", "short_play"});
        GENRES.put("comic_series", new String[]{"comic_series", "comic_series"});
        GENRES.put("ai_series", new String[]{"ai_series", "ai_series"});
        GENRE_NAMES.put("short_play", "短剧");
        GENRE_NAMES.put("comic_series", "漫剧");
        GENRE_NAMES.put("ai_series", "AI短剧");
    }

    // 主题 / 设定 / 背景 共用 cate_ 命名空间
    private static final Map<String, String> FILTER_CATE = new LinkedHashMap<>();
    private static final Map<String, String> FILTER_SORT = new LinkedHashMap<>();
    private static final Map<String, String> FILTER_GENDER = new LinkedHashMap<>();
    private static final Map<String, String> FILTER_DAYS = new LinkedHashMap<>();
    private static final Map<String, String> FILTER_STATUS = new LinkedHashMap<>();
    static {
        String[][] cate = {
            {"脑洞", "cate_755"}, {"奇幻", "cate_6"}, {"剧情", "cate_316"}, {"玄幻", "cate_7"},
            {"末世", "cate_68"}, {"豪门", "cate_936"}, {"科幻", "cate_1092"}, {"冒险", "cate_1182"},
            {"重生", "cate_36"}, {"穿越", "cate_37"}, {"逆袭", "cate_739"}, {"异能", "cate_598"},
            {"系统", "cate_19"}, {"反转", "cate_756"}, {"娱乐圈", "cate_43"}, {"总裁", "cate_29"},
            {"架空", "cate_452"}, {"都市", "cate_1"}, {"古代", "cate_758"}, {"异界", "cate_599"},
            {"校园", "cate_4"}, {"职场", "cate_127"}, {"年代", "cate_79"}, {"乡村", "cate_11"},
            {"民国", "cate_390"},
        };
        for (String[] c : cate) FILTER_CATE.put(c[0], c[1]);

        FILTER_SORT.put("最新上架", "online_time");
        FILTER_SORT.put("最新", "online_time");
        FILTER_SORT.put("最高热度", "hot_score");
        FILTER_SORT.put("热度", "hot_score");
        FILTER_SORT.put("hot", "hot_score");
        FILTER_SORT.put("最高收藏", "hot_collect");
        FILTER_SORT.put("收藏", "hot_collect");

        FILTER_GENDER.put("男频", "1");
        FILTER_GENDER.put("男", "1");
        FILTER_GENDER.put("女频", "0");
        FILTER_GENDER.put("女", "0");

        FILTER_DAYS.put("7", "days_7");
        FILTER_DAYS.put("14", "days_14");
        FILTER_DAYS.put("30", "days_30");
        FILTER_DAYS.put("90", "days_90");
        FILTER_DAYS.put("7天内上新", "days_7");
        FILTER_DAYS.put("14天内上新", "days_14");
        FILTER_DAYS.put("30天内上新", "days_30");
        FILTER_DAYS.put("90天内上新", "days_90");

        FILTER_STATUS.put("已完结", "creation_status_0");
        FILTER_STATUS.put("完结", "creation_status_0");
        FILTER_STATUS.put("连载中", "creation_status_1");
        FILTER_STATUS.put("连载", "creation_status_1");
    }

    public static Map<String, String> filterCate() { return FILTER_CATE; }

    // ==================== 请求组装 ====================

    /** 组装完整 URL（含 base_query、设备身份、_rticket）。 */
    public static String buildUrl(String pathname, Map<String, Object> extra) {
        Map<String, Object> q = new LinkedHashMap<>(BASE_QUERY);
        Safeguards.PoolDevice dev = currentDevice();
        if (dev != null) q.putAll(dev.query);
        if (extra != null) q.putAll(extra);
        q.put("_rticket", String.valueOf(System.currentTimeMillis()));

        StringBuilder qs = new StringBuilder();
        for (Map.Entry<String, Object> e : q.entrySet()) {
            if (qs.length() > 0) qs.append('&');
            qs.append(e.getKey()).append('=')
              .append(Http.urlencode(String.valueOf(e.getValue())));
        }
        return "https://" + HOST + pathname + "?" + qs;
    }

    /** 构造基础请求头与请求体。 */
    private static Object[] buildHeaders(Object body) {
        Map<String, String> headers = new LinkedHashMap<>(sessionHeaders());
        Safeguards.PoolDevice dev = currentDevice();
        if (dev != null) {
            if (dev.userAgent != null) headers.put("user-agent", dev.userAgent);
            headers.remove("x-tt-token");
            headers.remove("cookie");
        }
        if (!headers.containsKey("user-agent")) headers.put("user-agent", USER_AGENT);
        headers.put("content-type", "application/json; charset=utf-8");

        byte[] data = null;
        if (body != null) {
            data = Json.stringify(body).getBytes(StandardCharsets.UTF_8);
            headers.put("x-ss-stub", Crypto.md5HexUpper(data));
            headers.put("Content-Length", String.valueOf(data.length));
        } else {
            headers.remove("Content-Length");
        }
        return new Object[]{headers, data};
    }

    /** 单次 API 调用（不含重试）。 */
    private static Map<String, Object> apiOnce(String method, String pathname, Object body,
                                               Map<String, Object> extraQuery, boolean signed)
            throws Exception {
        String url = buildUrl(pathname, extraQuery);
        Object[] built = buildHeaders(body);
        @SuppressWarnings("unchecked")
        Map<String, String> headers = (Map<String, String>) built[0];
        byte[] data = (byte[]) built[1];

        if (signed) {
            try {
                headers.putAll(Signer.sign(url, headers));
            } catch (IOException e) {
                Safeguards.UpstreamResponseError err =
                        new Safeguards.UpstreamResponseError(e.getMessage());
                throw err;
            }
        }
        headers.remove("accept-encoding");
        Safeguards.throttle().wait_();

        Http.Req req = new Http.Req(url).method(method).timeout(30000);
        for (Map.Entry<String, String> e : headers.entrySet()) {
            req.header(e.getKey(), e.getValue());
        }
        if (data != null) req.body(data);

        Http.Resp res = Http.send(req);
        String text = res.text();
        Map<String, Object> j;
        try {
            j = Json.parseObject(text);
        } catch (Exception e) {
            if (signed && Signer.signServers().isEmpty()) {
                Safeguards.UpstreamResponseError err = new Safeguards.UpstreamResponseError(
                        "该接口需要 X-Argus 签名。请启动 Java 签名服务并设置环境变量 "
                        + "SIGN_SERVER=http://127.0.0.1:9099");
                Map<String, Object> diag = Json.obj();
                diag.put("http_status", res.status);
                diag.put("body_bytes", text.getBytes(StandardCharsets.UTF_8).length);
                err.diagnostic = diag;
                throw err;
            }
            Safeguards.UpstreamResponseError err =
                    new Safeguards.UpstreamResponseError("上游未返回 JSON");
            Map<String, Object> diag = Json.obj();
            diag.put("http_status", res.status);
            diag.put("body_bytes", text.getBytes(StandardCharsets.UTF_8).length);
            err.diagnostic = diag;
            throw err;
        }
        Safeguards.checkResponse(j);
        return j;
    }

    /** 带重试退避 + 登录态刷新的 API 调用。 */
    public static Map<String, Object> api(String method, String pathname, Object body,
                                          Map<String, Object> extraQuery, int maxRetries,
                                          boolean signed) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return apiOnce(method, pathname, body, extraQuery, signed);
            } catch (Safeguards.AuthExpiredError | Safeguards.RiskControlError e) {
                if (MANAGED) throw e; // 托管模式不刷新被抓包的登录态
                last = e;
                if (e instanceof Safeguards.AuthExpiredError) {
                    Log.info("登录态失效，刷新后重试 (" + pathname + ")");
                    refreshSession();
                    Safeguards.sleep(1000);
                } else {
                    int wait = (int) Math.pow(2, attempt) + 1;
                    Log.info("风控/异常，退避 " + wait + "s 重试 (" + pathname + "): " + e.getMessage());
                    Safeguards.sleep(wait * 1000L);
                }
            } catch (Safeguards.UpstreamResponseError e) {
                if (MANAGED) throw e;
                last = e;
                Safeguards.sleep(1500L * (attempt + 1));
            }
        }
        if (last != null) throw last;
        throw new IOException("api 失败");
    }

    private static long lastRefresh = 0;

    /** 从签名服务 /grab 刷新设备身份与 token（仅非托管模式）。 */
    public static synchronized void refreshSession() {
        if (System.currentTimeMillis() - lastRefresh < 20000) return; // 防抖
        if (Signer.signServers().isEmpty()) return;
        try {
            Map<String, Object> data = Signer.grab();
            if (data.get("error") != null) {
                Log.warn("grab 失败: " + data.get("error"));
                return;
            }
            Map<String, String> u = Http.parseQuery(
                    queryOf(Json.optStr(data.get("url"), "")));
            Set<String> deviceKeys = new LinkedHashSet<>(BASE_QUERY.keySet());
            deviceKeys.addAll(Arrays.asList("iid", "device_id", "cdid",
                    "klink_egdi", "channel", "update_version_code"));
            for (Map.Entry<String, String> e : u.entrySet()) {
                if (deviceKeys.contains(e.getKey()) && !e.getValue().isEmpty()) {
                    BASE_QUERY.put(e.getKey(), e.getValue());
                }
            }
            Map<String, Object> hs = Json.optObj(data.get("headers"));
            if (hs != null) {
                for (Map.Entry<String, Object> e : hs.entrySet()) {
                    String kl = e.getKey().toLowerCase();
                    if (Arrays.asList("cookie", "x-tt-token",
                            "x-tt-store-region", "x-tt-store-region-src").contains(kl)
                            && e.getValue() != null) {
                        sessionHeadersCache().put(kl,
                                String.valueOf(e.getValue()).replaceAll("^\\[|\\]$", ""));
                    }
                }
            }
            lastRefresh = System.currentTimeMillis();
            String tok = sessionHeadersCache().getOrDefault("x-tt-token", "");
            Log.info("登录态已刷新, token 长度=" + tok.length());
        } catch (Exception e) {
            Log.warn("刷新异常: " + e.getMessage());
        }
    }

    private static final Map<String, String> HDR_CACHE = new LinkedHashMap<>();

    private static Map<String, String> sessionHeadersCache() {
        if (HDR_CACHE.isEmpty()) {
            HDR_CACHE.putAll(sessionHeaders());
            sessionHeaders().keySet().forEach(k -> HDR_CACHE.putIfAbsent(k, ""));
        }
        return HDR_CACHE;
    }

    /** 取 ?query 部分。 */
    private static String queryOf(String url) {
        int i = url.indexOf('?');
        return i < 0 ? "" : url.substring(i + 1);
    }

    // ==================== 数据解析 ====================

    /** 从 category_schema 字符串中解析分类名（源数据为 JSON 字符串）。 */
    public static List<String> parseCategories(Object schema) {
        List<String> out = new ArrayList<>();
        if (schema == null) return out;
        String s = String.valueOf(schema);
        java.util.regex.Matcher rx = java.util.regex.Pattern
                .compile("\"name\"\\s*:\\s*\"([^\"]+)\"").matcher(s);
        while (rx.find()) {
            String m = rx.group(1);
            if (!m.isEmpty() && !out.contains(m)) out.add(m);
        }
        return out;
    }

    /** 提取封面角标文本（爆剧/新剧/独播…）。 */
    public static List<String> coverTags(Object d) {
        List<String> out = new ArrayList<>();
        Map<String, Object> m = Json.optObj(d);
        if (m == null) return out;
        for (Object t : Json.optArr(m.get("cover_tag_info_list"))) {
            Map<String, Object> tm = Json.optObj(t);
            if (tm != null) {
                Object v = firstNonNull(tm, "text", "content", "name", "tag_text", "title");
                if (v != null) out.add(String.valueOf(v).replaceAll("<[^>]+>", ""));
            } else if (t instanceof String && !((String) t).isEmpty()) {
                out.add((String) t);
            }
        }
        return out;
    }

    private static Object firstNonNull(Map<String, Object> m, String... keys) {
        for (String k : keys) {
            Object v = m.get(k);
            if (v != null && !String.valueOf(v).isEmpty()) return v;
        }
        return null;
    }

    private static String str(Map<String, Object> m, String k) {
        return m == null ? "" : Json.optStr(m.get(k), "");
    }

    private static long num(Map<String, Object> m, String k) {
        return m == null ? 0 : Json.optLong(m.get(k), 0);
    }

    /** 剥 HTML 标签并截断。 */
    private static String strip(String s, int max) {
        String t = s == null ? "" : s.replaceAll("<[^>]+>", "");
        return t.length() > max ? t.substring(0, max) : t;
    }

    /** 从搜索 cell 解析短剧条目；非短剧（无集数）或无 id 返回 null。 */
    public static Map<String, Object> parseSearchCell(Object cellObj) {
        Map<String, Object> cell = Json.optObj(cellObj);
        if (cell == null) return null;
        Object sid = cell.get("book_id");
        if (sid == null) sid = cell.get("search_result_id");
        if (sid == null) return null;
        Map<String, Object> vd = Json.optObj(cell.get("video_detail"));
        if (vd == null) vd = Json.obj();

        Object vdataObj = cell.get("video_data");
        if (vdataObj instanceof List && !((List<?>) vdataObj).isEmpty()) {
            vdataObj = ((List<?>) vdataObj).get(0);
        }
        Map<String, Object> vdata = Json.optObj(vdataObj);
        if (vdata == null) vdata = Json.obj();
        Map<String, Object> inner = Json.optObj(vdata.get("video_detail"));
        if (inner == null) inner = Json.obj();

        long ep = num(vd, "episode_cnt");
        if (ep == 0) ep = num(vdata, "episode_cnt");
        if (ep == 0) ep = num(inner, "episode_cnt");
        if (ep == 0) return null; // 只要短剧（有集数的）

        Map<String, Object> hl = Json.optObj(cell.get("search_high_light"));
        String hlText = "";
        if (hl != null) {
            Map<String, Object> t = Json.optObj(hl.get("title"));
            if (t != null) hlText = str(t, "text");
        }
        String title = hlText;
        if (title.isEmpty()) title = str(vd, "series_title");
        if (title.isEmpty()) title = str(vdata, "title");
        if (title.isEmpty()) title = str(inner, "series_title");

        Map<String, Object> out = Json.obj();
        out.put("series_id", String.valueOf(sid));
        out.put("title", strip(title, 9999));
        out.put("episode_cnt", ep);
        out.put("score", vdata.containsKey("score") ? vdata.get("score")
                : (inner.containsKey("score") ? inner.get("score") : ""));
        out.put("play_cnt", vdata.containsKey("play_cnt") ? vdata.get("play_cnt")
                : Json.optLong(inner.get("series_play_cnt"), 0));
        out.put("hot", str(vdata, "rec_text"));
        out.put("copyright", str(vdata, "copyright"));
        String cover = str(vdata, "cover");
        if (cover.isEmpty()) cover = str(inner, "series_cover");
        out.put("cover", cover);
        out.put("tags", coverTags(vdata));
        String intro = !str(inner, "series_intro").isEmpty() ? str(inner, "series_intro")
                : str(vd, "series_intro");
        out.put("abstract", strip(intro, 60));
        out.put("vid", str(vdata, "vid"));
        out.put("duration", num(vdata, "duration"));
        out.put("horiz_cover", str(vdata, "horiz_cover"));
        return out;
    }

    /** 剧集详情请求体（image_shrink 为抓包中的固定值）。 */
    private static final String IMAGE_SHRINK = "W3siaW1hZ2VfdHlwZSI6MywiaW1hZ2Vfd2lkdGgiOjkwMCwic2hyaW5rX3R5cGUiOjN9LHsiaW1hZ2VfdHlwZSI6NCwiaW1hZ2Vfd2lkdGgiOjU0LCJzaHJpbmtfdHlwZSI6NH1d";

    private static Map<String, Object> episodesBody(String seriesId) {
        Map<String, Object> biz = Json.obj();
        biz.put("detail_page_version", 0);
        biz.put("disable_digg_stat", false);
        biz.put("disable_video_relate_book", false);
        biz.put("image_shrink_datas_str", IMAGE_SHRINK);
        biz.put("need_all_video_definition", false);
        biz.put("need_mp4_align", false);
        biz.put("screen_width_px", "900");
        biz.put("source", 7);
        biz.put("use_os_player", false);
        biz.put("use_server_dns", false);

        Map<String, Object> out = Json.obj();
        out.put("biz_param", biz);
        out.put("series_id", String.valueOf(seriesId));
        return out;
    }

    /**
     * 解析剧集详情。
     *
     * 注意 title 字段：上游 video_list[].title 里装的其实是「本剧简介」，
     * 每一集都重复同一段文字。这里与 series_intro 比对，命中则视为无效标题。
     */
    public static Map<String, Object> parseEpisodeDetail(String sid, Map<String, Object> vd) {
        if (vd == null) vd = Json.obj();
        String intro = str(vd, "series_intro").trim();
        List<Object> eps = new ArrayList<>();

        for (Object eObj : Json.optArr(vd.get("video_list"))) {
            Map<String, Object> e = Json.optObj(eObj);
            if (e == null) continue;
            String title = str(e, "title").trim();
            if (!title.isEmpty() && !intro.isEmpty()
                    && (title.equals(intro) || intro.contains(title))) {
                title = "";
            }
            Map<String, Object> row = Json.obj();
            row.put("index", num(e, "vid_index"));
            Object v = e.get("vid");
            row.put("vid", v == null ? "" : String.valueOf(v));
            row.put("title", title.length() > 30 ? title.substring(0, 30) : title);
            row.put("duration", num(e, "duration"));
            String cover = str(e, "episode_cover");
            if (cover.isEmpty()) cover = str(e, "cover");
            row.put("cover", cover);
            row.put("comment_count", num(e, "comment_count"));
            row.put("digged_count", num(e, "digged_count"));
            eps.add(row);
        }

        eps.sort((a, b) -> Long.compare(
                Json.optLong(Json.optObj(a).get("index"), 0),
                Json.optLong(Json.optObj(b).get("index"), 0)));

        String firstEpCover = "";
        for (Object o : eps) {
            Map<String, Object> m = Json.optObj(o);
            if (m != null && !str(m, "cover").isEmpty()) {
                firstEpCover = str(m, "cover");
                break;
            }
        }

        List<Object> celebs = new ArrayList<>();
        for (Object cObj : Json.optArr(vd.get("celebrities"))) {
            Map<String, Object> c = Json.optObj(cObj);
            if (c == null) continue;
            Map<String, Object> cm = Json.obj();
            cm.put("演员", str(c, "nickname"));
            cm.put("角色", str(c, "role_name"));
            cm.put("头像", str(c, "avatar"));
            cm.put("简介", strip(str(c, "intro"), 80));
            celebs.add(cm);
        }

        Map<String, Object> meta = Json.obj();
        meta.put("series_id", String.valueOf(sid));
        String title = str(vd, "series_title");
        meta.put("title", title.isEmpty() ? String.valueOf(sid) : title);
        meta.put("abstract", str(vd, "series_intro"));
        long epCnt = num(vd, "episode_cnt");
        meta.put("episode_cnt", epCnt != 0 ? epCnt : eps.size());
        meta.put("status", Json.optLong(vd.get("series_status"), 0) == 1 ? "完结" : "连载中");
        meta.put("play_cnt", num(vd, "series_play_cnt"));
        meta.put("followed_cnt", num(vd, "followed_cnt"));
        meta.put("create_time", num(vd, "create_time"));
        String cover = str(vd, "series_cover");
        meta.put("cover", cover.isEmpty() ? firstEpCover : cover);
        meta.put("category", parseCategories(vd.get("category_schema")));
        meta.put("tags", coverTags(vd));
        meta.put("celebrities", celebs);

        Map<String, Object> out = Json.obj();
        out.put("meta", meta);
        out.put("episodes", eps);
        return out;
    }

    // ==================== 业务接口 ====================

    /**
     * 搜索短剧。按综合 tab 分页循环翻页，
     * 直到 has_more=false 或达到 max_items / 12 页安全上限。
     */
    public static List<Object> search(String query, int maxItemsArg) throws Exception {
        int limit = Math.max(1, Math.min(
                maxItemsArg > 0 ? maxItemsArg : Log.envInt("HG_SEARCH_MAX_ITEMS", 20), 40));
        String ck = Safeguards.cacheKey("search", query, limit);
        Object cached = Safeguards.cacheGet(ck);
        if (cached != null) return castList(cached);

        List<Object> results = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        int offset = 0;
        String passback = "";
        String searchId = "";

        for (int page = 0; page < 12; page++) {
            Map<String, Object> q = Json.obj();
            q.put("query", query);
            q.put("tab_name", "feed");
            q.put("search_source", "1");
            q.put("offset", String.valueOf(offset));
            q.put("count", "10");
            q.put("use_correct", "true");
            if (!passback.isEmpty()) q.put("passback", passback);
            if (!searchId.isEmpty()) q.put("search_id", searchId);

            Map<String, Object> j = api("GET", "/reading/bookapi/search/tab/v", null, q, 1, true);
            List<Object> tabs = Json.optArr(j.get("search_tabs"));
            if (tabs.isEmpty()) break;
            Map<String, Object> tab = Json.optObj(tabs.get(0));
            if (tab == null) break;
            List<Object> data = Json.optArr(tab.get("data"));
            for (Object cell : data) {
                Map<String, Object> item = parseSearchCell(cell);
                if (item == null) continue;
                String isid = str(item, "series_id");
                if (seen.contains(isid)) continue;
                seen.add(isid);
                results.add(item);
            }
            if (tab.get("next_offset") != null) offset = Json.optInt(tab.get("next_offset"), offset);
            String pb = str(tab, "passback");
            if (!pb.isEmpty()) passback = pb;
            String sid = str(tab, "search_id");
            if (!sid.isEmpty()) searchId = sid;
            if (!Json.optBool(tab.get("has_more"), false) || data.isEmpty()
                    || results.size() >= limit) break;
        }

        List<Object> out = new ArrayList<>(results.subList(0, Math.min(limit, results.size())));
        Safeguards.cacheSet(ck, out, 600);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> castList(Object o) {
        return (List<Object>) o;
    }

    /** 取单剧元信息 + 剧集列表（缓存 6 小时）。 */
    public static Map<String, Object> getEpisodes(String seriesId) throws Exception {
        String sid = String.valueOf(seriesId);
        String ck = Safeguards.cacheKey("episodes", sid);
        Object cached = Safeguards.cacheGet(ck);
        if (cached != null) return Json.optObj(cached);

        Map<String, Object> j = api("POST", "/novel/player/multi_video_detail/v1/",
                episodesBody(sid), null, 3, true);
        Map<String, Object> data = Json.optObj(j.get("data"));
        Map<String, Object> vd = data == null ? null
                : Json.optObj(Json.optObj(data.get(sid)).get("video_data"));
        Map<String, Object> result = parseEpisodeDetail(sid, vd);
        Safeguards.cacheSet(ck, result, 21600);
        return result;
    }

    /** 批量取剧集元数据。 */
    public static Object[] getEpisodesBatch(List<String> seriesIds, int batchSizeArg) throws Exception {
        List<String> ids = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String s : seriesIds) {
            String sid = s == null ? "" : s.trim();
            if (!sid.isEmpty() && seen.add(sid)) ids.add(sid);
        }
        int bs = Math.max(1, Math.min(batchSizeArg > 0 ? batchSizeArg : 20, 20));
        Map<String, Object> out = Json.obj();
        List<Object> failed = new ArrayList<>();
        List<String> todo = new ArrayList<>();

        for (String sid : ids) {
            Object c = Safeguards.cacheGet(Safeguards.cacheKey("episodes", sid));
            if (c != null) {
                out.put(sid, Json.optObj(c).get("meta"));
            } else {
                todo.add(sid);
            }
        }

        for (int i = 0; i < todo.size(); i += bs) {
            List<String> batch = todo.subList(i, Math.min(i + bs, todo.size()));
            try {
                Map<String, Object> j = api("POST", "/novel/player/multi_video_detail/v1/",
                        episodesBody(String.join(",", batch)), null, 3, true);
                Map<String, Object> data = Json.optObj(j.get("data"));
                for (String sid : batch) {
                    Map<String, Object> vd = data == null ? null
                            : Json.optObj(Json.optObj(data.get(sid)).get("video_data"));
                    if (vd == null || vd.isEmpty()) {
                        Map<String, Object> f = Json.obj();
                        f.put("series_id", sid);
                        f.put("error", "empty detail");
                        failed.add(f);
                        continue;
                    }
                    Map<String, Object> parsed = parseEpisodeDetail(sid, vd);
                    Safeguards.cacheSet(Safeguards.cacheKey("episodes", sid), parsed, 21600);
                    out.put(sid, parsed.get("meta"));
                }
            } catch (Exception e) {
                for (String sid : batch) {
                    Map<String, Object> f = Json.obj();
                    f.put("series_id", sid);
                    f.put("error", String.valueOf(e.getMessage()));
                    failed.add(f);
                }
            }
        }
        return new Object[]{out, failed};
    }

    /** 归一化 video_model 轨道结构，拒绝非法 URL 与结构。 */
    public static List<Object> videoModelTracks(Object model) throws Exception {
        Object tracks = model;
        if (model instanceof List) {
            // 保持
        } else if (model != null) {
            Map<String, Object> m = Json.optObj(model);
            if (m != null && m.containsKey("video_list")) tracks = m.get("video_list");
            else tracks = m;
        }
        if (tracks instanceof Map) {
            tracks = new ArrayList<>(((Map<?, ?>) tracks).values());
        }
        if (!(tracks instanceof List)) {
            Safeguards.ApiError err = new Safeguards.ApiError("不支持的 video_model 结构");
            Map<String, Object> shape = Json.obj();
            shape.put("modelType", model == null ? "null"
                    : (model instanceof List ? "list" : Json.typeName(model)));
            shape.put("tracksType", tracks instanceof List ? "list" : Json.typeName(tracks));
            err.modelShape = shape;
            throw err;
        }
        List<?> tl = (List<?>) tracks;
        for (Object t : tl) {
            if (Json.optObj(t) == null) {
                Safeguards.ApiError err = new Safeguards.ApiError("不支持的 video_model 结构");
                Map<String, Object> shape = Json.obj();
                shape.put("modelType", model == null ? "null"
                        : (model instanceof List ? "list" : Json.typeName(model)));
                shape.put("tracksType", "list");
                err.modelShape = shape;
                throw err;
            }
        }

        List<Object> out = new ArrayList<>();
        for (Object sourceObj : tl) {
            Map<String, Object> source = Json.optObj(sourceObj);
            Map<String, Object> track = new LinkedHashMap<>(source);
            for (String field : new String[]{"main_url", "backup_url"}) {
                Object valueObj = track.get(field);
                if (valueObj == null) continue;
                if (!(valueObj instanceof String)) {
                    throw new Safeguards.ApiError("媒体 URL 类型非法");
                }
                String value = (String) valueObj;
                if (!value.startsWith("http://") && !value.startsWith("https://")) {
                    // 上游可能返回 base64 编码的 URL
                    String decoded;
                    try {
                        decoded = new String(Crypto.base64Decode(value), StandardCharsets.UTF_8);
                    } catch (Exception e) {
                        throw new Safeguards.ApiError("非法编码的媒体 URL");
                    }
                    if (!decoded.startsWith("http")) {
                        throw new Safeguards.ApiError("非法编码的媒体 URL");
                    }
                    value = decoded;
                }
                java.net.URI parsed;
                try {
                    parsed = java.net.URI.create(value);
                } catch (Exception e) {
                    throw new Safeguards.ApiError("非法媒体 URL");
                }
                String scheme = parsed.getScheme();
                if (scheme == null || !("http".equals(scheme) || "https".equals(scheme))
                        || parsed.getHost() == null || parsed.getUserInfo() != null) {
                    throw new Safeguards.ApiError("非法媒体 URL");
                }
                track.put(field, value);
            }
            Map<String, Object> vm = Json.optObj(track.get("video_meta"));
            if (vm == null) vm = Json.obj();
            Map<String, Object> ei = Json.optObj(track.get("encrypt_info"));
            if (ei == null) ei = Json.obj();
            track.put("video_meta", mergePick(source, vm,
                    new String[]{"size", "definition", "codec_type", "vwidth", "vheight"}));
            track.put("encrypt_info", mergePick(source, ei,
                    new String[]{"encrypt", "spade_a"}));
            out.add(track);
        }
        return out;
    }

    /** source 中存在的字段优先，其次被嵌套对象覆盖（对齐 JS 的 { ...pick, ...vm }）。 */
    private static Map<String, Object> mergePick(Map<String, Object> source,
                                                 Map<String, Object> nested, String[] keys) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String k : keys) {
            if (source.containsKey(k)) out.put(k, source.get(k));
        }
        out.putAll(nested);
        return out;
    }

    /** video_model 批量请求体（每批 5 个 vid）。 */
    private static Map<String, Object> videoModelBody(List<String> batch) {
        Map<String, Object> biz = Json.obj();
        biz.put("detail_page_version", 0);
        biz.put("device_level", 3);
        biz.put("disable_digg_stat", false);
        biz.put("disable_video_relate_book", false);
        biz.put("need_all_video_definition", true);
        biz.put("need_mp4_align", false);
        biz.put("use_os_player", false);
        biz.put("use_server_dns", false);
        biz.put("video_platform", 1024);

        Map<String, Object> mixed = Json.obj();
        mixed.put("1", new ArrayList<Object>(batch));

        Map<String, Object> out = Json.obj();
        out.put("biz_param", biz);
        out.put("mixed_video_id_map", mixed);
        return out;
    }

    /** 批量取视频直链。返回 {vid: {url, backup, size, definition}}，缓存 5 小时。 */
    public static Map<String, Object> getVideoUrls(List<String> vids, boolean force) throws Exception {
        Map<String, Object> tracks = getVideoTracks(vids, force, 5);
        Map<String, Object> out = Json.obj();
        for (Map.Entry<String, Object> e : tracks.entrySet()) {
            List<Object> list = castList(e.getValue());
            Map<String, Object> best = null;
            long bestSize = 0;
            for (Object itemObj : list) {
                Map<String, Object> item = Json.optObj(itemObj);
                if (item == null) continue;
                Map<String, Object> meta = Json.optObj(item.get("video_meta"));
                long size = meta == null ? 0 : Json.optLong(meta.get("size"), 0);
                if (best == null || size > bestSize) {
                    Map<String, Object> b = Json.obj();
                    b.put("url", item.get("main_url"));
                    b.put("backup", item.get("backup_url"));
                    b.put("size", size);
                    b.put("definition", meta == null
                            ? "?" : Json.optStr(meta.get("definition"), "?"));
                    b.put("url_is_http", String.valueOf(
                            item.getOrDefault("main_url", "")).startsWith("http"));
                    best = b;
                    bestSize = size;
                }
            }
            if (best != null) {
                out.put(e.getKey(), best);
                Safeguards.cacheSet(Safeguards.cacheKey("vmodel", e.getKey()), best, 18000);
            }
        }
        return out;
    }

    /** 批量取每个 vid 的完整 video_list 轨道。 */
    public static Map<String, Object> getVideoTracks(List<String> vids, boolean force, int batchSizeArg)
            throws Exception {
        Map<String, Object> out = new LinkedHashMap<>();
        List<String> todo = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();

        for (String v : vids) {
            String s = v == null ? "" : v;
            if (s.isEmpty() || !seen.add(s)) continue;
            Object c = force ? null
                    : Safeguards.cacheGet(Safeguards.cacheKey("vmtracks", s));
            if (c != null) out.put(s, c);
            else todo.add(s);
        }

        int bs = Math.max(1, Math.min(batchSizeArg > 0 ? batchSizeArg : 5, 5));
        for (int i = 0; i < todo.size(); i += bs) {
            List<String> batch = todo.subList(i, Math.min(i + bs, todo.size()));
            Map<String, Object> j = api("POST", "/novel/player/multi_video_model/v1/",
                    videoModelBody(batch), null, 3, true);
            Map<String, Object> data = Json.optObj(j.get("data"));
            if (data == null) continue;
            for (Map.Entry<String, Object> e : data.entrySet()) {
                Map<String, Object> v = Json.optObj(e.getValue());
                if (v == null) continue;
                Object vmObj = v.get("video_model");
                if (vmObj == null) continue;
                Object parsed = vmObj;
                if (vmObj instanceof String) {
                    try {
                        parsed = Json.parse((String) vmObj);
                    } catch (Exception ex) {
                        continue;
                    }
                }
                List<Object> tracks = videoModelTracks(parsed);
                if (!tracks.isEmpty()) {
                    out.put(String.valueOf(e.getKey()), tracks);
                    Safeguards.cacheSet(
                            Safeguards.cacheKey("vmtracks", String.valueOf(e.getKey())), tracks, 18000);
                }
            }
        }
        return out;
    }

    /** 取漫剧榜单。board: recommend / hot / new。 */
    public static List<Object> rank(String board, int limit) throws Exception {
        String ck = Safeguards.cacheKey("rank", board, limit);
        Object cached = Safeguards.cacheGet(ck);
        if (cached != null) return castList(cached);

        String sub = RANK_BOARDS.getOrDefault(board, board);
        List<Object> results = new ArrayList<>();
        int offset = 0;
        String sessionUuid = UUID.randomUUID().toString();

        while (results.size() < limit) {
            Map<String, Object> q = Json.obj();
            q.put("cell_id", COMIC_RANK_CELL);
            q.put("tab_type", "26");
            q.put("client_req_type", "2");
            q.put("client_template", "2");
            q.put("screen_width_px", "1350");
            q.put("selected_items", "comic_series_rank");
            q.put("sub_selected_items", sub);
            q.put("session_uuid", sessionUuid);
            if (offset != 0) q.put("offset", String.valueOf(offset));

            Map<String, Object> j = api("GET", "/reading/bookapi/bookmall/cell/change/v",
                    null, q, 3, SIGN_LIST);
            Map<String, Object> data = Json.optObj(j.get("data"));
            Map<String, Object> cv = data == null ? null : Json.optObj(data.get("cell_view"));
            List<Object> cells = cv == null ? new ArrayList<>() : Json.optArr(cv.get("cell_data"));
            if (cells.isEmpty()) break;

            for (Object itemObj : cells) {
                Map<String, Object> item = Json.optObj(itemObj);
                if (item == null) continue;
                Object vo = item.get("video_data");
                if (vo instanceof List) {
                    List<?> l = (List<?>) vo;
                    vo = l.isEmpty() ? Json.obj() : l.get(0);
                }
                Map<String, Object> v = Json.optObj(vo);
                if (v == null) v = Json.obj();
                Object sid = v.get("series_id");
                if (sid == null) sid = v.get("book_id");
                if (sid == null) continue;

                Map<String, Object> row = Json.obj();
                row.put("rank", results.size() + 1);
                row.put("series_id", String.valueOf(sid));
                row.put("title", str(v, "title"));
                row.put("episode_cnt", num(v, "episode_cnt"));
                row.put("score", v.getOrDefault("score", ""));
                row.put("play_cnt", num(v, "play_cnt"));
                row.put("hot", str(v, "rec_text"));
                row.put("copyright", str(v, "copyright"));
                row.put("cover", str(v, "cover"));
                row.put("tags", coverTags(v));
                row.put("abstract", strip(str(v, "video_desc"), 50));
                results.add(row);
            }
            if (cv == null || !Json.optBool(cv.get("has_more"), false)) break;
            offset = cv.get("next_offset") != null
                    ? Json.optInt(cv.get("next_offset"), offset) : offset + cells.size();
        }

        List<Object> out = new ArrayList<>(results.subList(0, Math.min(limit, results.size())));
        Safeguards.cacheSet(ck, out, 1800);
        return out;
    }

    /**
     * 最新上架。
     * - 短剧：官方有"今日上新"标签，only_today=true 精确返回今日上新；
     * - 漫剧/AI：官方最细 7 天粒度，统一返回"7天内上新·最新上架"。
     */
    public static List<Object> latest(String genre, boolean onlyToday, int maxItems, boolean refresh)
            throws Exception {
        String[] gv = GENRES.get(genre);
        if (gv == null) throw new IllegalArgumentException("genre 必须是 "
                + String.join("|", GENRES.keySet()));
        String scene = gv[0];
        String g = gv[1];
        boolean tagToday = genre.equals("short_play");
        List<Object> onlineTime = new ArrayList<>();
        if (!tagToday) onlineTime.add("days_7");
        boolean wantToday = tagToday && onlyToday;

        String ck = Safeguards.cacheKey("latest", genre, String.valueOf(onlyToday),
                String.valueOf(maxItems));
        if (!refresh) {
            Object c = Safeguards.cacheGet(ck);
            if (c != null) return castList(c);
        }

        List<Object> out = new ArrayList<>();
        List<String> shown = new ArrayList<>();
        int offset = 0;

        for (int pages = 0; pages < 20 && out.size() < maxItems; pages++) {
            Map<String, Object> body = landpageBody(shown, scene, offset, 18, onlineTime, g);
            Map<String, Object> j = api("POST", "/reading/distribution/category/landpage/v",
                    body, null, 3, SIGN_LIST);
            Map<String, Object> data = Json.optObj(j.get("data"));
            List<Object> items = data == null ? new ArrayList<>() : Json.optArr(data.get("video_data"));
            if (items.isEmpty()) break;

            int pageToday = 0;
            for (Object itObj : items) {
                Map<String, Object> it = Json.optObj(itObj);
                if (it == null) continue;
                String sid = String.valueOf(it.get("series_id"));
                shown.add(sid);

                List<String> subs = new ArrayList<>();
                for (Object sObj : Json.optArr(it.get("sub_title_list"))) {
                    Map<String, Object> s = Json.optObj(sObj);
                    if (s != null) subs.add(str(s, "content"));
                }
                boolean isToday = subs.contains("今日上新");
                if (isToday) pageToday++;
                if (wantToday && !isToday) continue;

                List<String> cats = parseCategories(it.get("category_schema"));
                if (cats.isEmpty()) {
                    for (String s : subs) {
                        if (s.isEmpty() || s.equals("今日上新") || s.matches("^\\d+(\\.\\d+)?万")
                                || s.contains("播放") || s.matches("^\\d+集$")) continue;
                        if (!cats.contains(s)) cats.add(s);
                    }
                }

                Map<String, Object> row = Json.obj();
                row.put("series_id", sid);
                row.put("title", str(it, "title"));
                row.put("episode_cnt", num(it, "episode_cnt"));
                row.put("score", it.getOrDefault("score", ""));
                row.put("play_cnt", num(it, "play_cnt"));
                row.put("cover", str(it, "cover"));
                row.put("category", String.join(" / ", cats));
                row.put("today", isToday);
                row.put("copyright", str(it, "copyright"));
                List<Object> tags = new ArrayList<>();
                String tagText = str(Json.optObj(it.get("tag_info")), "text");
                if (!tagText.isEmpty()) tags.add(tagText);
                row.put("tags", tags);
                row.put("abstract", strip(str(it, "video_desc"), 50));
                row.put("vid", str(it, "vid"));
                out.add(row);
                if (out.size() >= maxItems) break;
            }
            if (wantToday && pageToday == 0) break; // 整页无今日 => 已过今日簇
            if (data != null && Boolean.FALSE.equals(data.get("has_more"))) break;
            offset += items.size();
        }
        Safeguards.cacheSet(ck, out, 600);
        return out;
    }

    /** landpage 接口请求体。 */
    private static Map<String, Object> landpageBody(List<String> shown, String scene, int offset,
                                                    int limit, List<Object> onlineTime, String g) {
        Map<String, Object> select = Json.obj();
        select.put("category_dim_epoch", new ArrayList<>());
        select.put("online_time", onlineTime);
        select.put("gender", new ArrayList<>());
        select.put("category_dim_role", new ArrayList<>());
        select.put("genre", new ArrayList<>(Arrays.asList(g)));
        select.put("sort", new ArrayList<>(Arrays.asList("online_time")));
        select.put("category_dim_theme", new ArrayList<>());

        Map<String, Object> body = Json.obj();
        body.put("filter_ids", String.join(",", shown));
        body.put("req_scene", scene);
        body.put("offset", offset);
        body.put("need_selector_panel", false);
        body.put("limit", limit);
        body.put("select_items", select);
        body.put("session_id", "");
        body.put("req_type", "only_content");
        body.put("client_req_type", 3);
        return body;
    }

    /** 取某体裁的实时筛选面板。 */
    public static List<Object> filters(String genre) throws Exception {
        String[] gv = GENRES.get(genre);
        if (gv == null) gv = GENRES.get("short_play");

        Map<String, Object> select = Json.obj();
        select.put("category_dim_epoch", new ArrayList<>());
        select.put("online_time", new ArrayList<>());
        select.put("gender", new ArrayList<>());
        select.put("category_dim_role", new ArrayList<>());
        select.put("genre", new ArrayList<>(Arrays.asList(gv[1])));
        select.put("sort", new ArrayList<>());
        select.put("category_dim_theme", new ArrayList<>());

        Map<String, Object> body = Json.obj();
        body.put("filter_ids", "");
        body.put("req_scene", gv[0]);
        body.put("offset", 0);
        body.put("limit", 1);
        body.put("need_selector_panel", true);
        body.put("req_type", "default");
        body.put("client_req_type", 3);
        body.put("select_items", select);
        body.put("session_id", "");

        Map<String, Object> j = api("POST", "/reading/distribution/category/landpage/v",
                body, null, 3, SIGN_LIST);
        Map<String, Object> data = Json.optObj(j.get("data"));
        List<Object> rows = data == null ? new ArrayList<>() : Json.optArr(data.get("selector_rows"));
        List<Object> out = new ArrayList<>();
        for (Object rObj : rows) {
            Map<String, Object> r = Json.optObj(rObj);
            if (r == null) continue;
            Map<String, Object> row = Json.obj();
            row.put("type", str(r, "type"));
            row.put("row_name", str(r, "row_name"));
            row.put("selection_type", str(r, "selection_type"));
            List<Object> items = new ArrayList<>();
            for (Object itObj : Json.optArr(r.get("items"))) {
                Map<String, Object> it = Json.optObj(itObj);
                if (it == null) continue;
                Map<String, Object> im = Json.obj();
                im.put("id", it.get("selector_item_id"));
                im.put("name", it.get("show_name"));
                items.add(im);
            }
            row.put("items", items);
            out.add(row);
        }
        return out;
    }

    /** 单值或数组 -> id 数组；名称按 mapping 映射，已是 id/未知则原样透传。 */
    private static List<Object> toIds(String csv, Map<String, String> mapping) {
        List<Object> out = new ArrayList<>();
        if (csv == null || csv.isEmpty()) return out;
        for (String v : Http.splitCsv(csv)) {
            String mapped = mapping.get(v);
            out.add(mapped != null ? mapped : v);
        }
        return out;
    }

    /** 按筛选条件浏览。 */
    public static List<Object> browse(String genre, Map<String, String> opts) throws Exception {
        String[] gv = GENRES.get(genre);
        if (gv == null) throw new IllegalArgumentException("genre 必须是 "
                + String.join("|", GENRES.keySet()));
        int maxItems = Math.min(Json.optInt(opts.get("limit"), 60), 120);

        Map<String, Object> select = Json.obj();
        select.put("genre", new ArrayList<>(Arrays.asList(gv[1])));
        select.put("category_dim_theme", toIds(opts.get("theme"), FILTER_CATE));
        select.put("category_dim_role", toIds(opts.get("setting"), FILTER_CATE));
        select.put("category_dim_epoch", toIds(opts.get("background"), FILTER_CATE));
        List<Object> sortIds = toIds(opts.get("sort"), FILTER_SORT);
        select.put("sort", sortIds.isEmpty()
                ? new ArrayList<>(Arrays.asList("online_time")) : sortIds);
        select.put("gender", toIds(opts.get("gender"), FILTER_GENDER));
        select.put("creation_status", toIds(opts.get("status"), FILTER_STATUS));
        select.put("online_time", toIds(opts.get("days"), FILTER_DAYS));

        List<Object> out = new ArrayList<>();
        List<String> shown = new ArrayList<>();
        int offset = 0;

        for (int pages = 0; pages < 20 && out.size() < maxItems; pages++) {
            Map<String, Object> body = Json.obj();
            body.put("filter_ids", String.join(",", shown));
            body.put("req_scene", gv[0]);
            body.put("offset", offset);
            body.put("need_selector_panel", false);
            body.put("limit", 18);
            body.put("select_items", select);
            body.put("session_id", "");
            body.put("req_type", "only_content");
            body.put("client_req_type", 3);

            Map<String, Object> j = api("POST", "/reading/distribution/category/landpage/v",
                    body, null, 3, SIGN_LIST);
            Map<String, Object> data = Json.optObj(j.get("data"));
            List<Object> items = data == null ? new ArrayList<>() : Json.optArr(data.get("video_data"));
            if (items.isEmpty()) break;

            for (Object itObj : items) {
                Map<String, Object> it = Json.optObj(itObj);
                if (it == null) continue;
                String sid = String.valueOf(it.get("series_id"));
                shown.add(sid);

                Map<String, Object> row = Json.obj();
                row.put("series_id", sid);
                row.put("title", str(it, "title"));
                row.put("episode_cnt", num(it, "episode_cnt"));
                row.put("score", it.getOrDefault("score", ""));
                row.put("play_cnt", num(it, "play_cnt"));
                row.put("cover", str(it, "cover"));
                row.put("copyright", str(it, "copyright"));
                row.put("category", String.join(" / ", parseCategories(it.get("category_schema"))));
                row.put("tags", coverTags(it));
                row.put("abstract", strip(str(it, "video_desc"), 50));
                row.put("vid", str(it, "vid"));
                row.put("comment_count", num(it, "comment_count"));
                row.put("duration", num(it, "duration"));
                row.put("horiz_cover", str(it, "horiz_cover"));
                out.add(row);
                if (out.size() >= maxItems) break;
            }
            if (data != null && Boolean.FALSE.equals(data.get("has_more"))) break;
            offset += items.size();
        }
        return out;
    }

    // ==================== 工具 ====================

    /** 文件名安全化（保留 60 字上限）。 */
    public static String sanitize(String name) {
        String t = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return t.length() > 60 ? t.substring(0, 60) : t;
    }

    /** 由封面 URL 推断扩展名。 */
    public static String imgExt(String url) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\\.(jpe?g|png|webp|heic)(?:\\?|$)", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(url == null ? "" : url);
        return m.find() ? "." + m.group(1).toLowerCase() : ".jpg";
    }
}
