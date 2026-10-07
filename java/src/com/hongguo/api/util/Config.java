package com.hongguo.api.util;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 启动配置装载：server/config/config.json。
 *
 * <p>取值优先级（高到低）：
 * <ol>
 *   <li>系统属性 -Dxxx（Launcher 内部编排用，见 {@link Log#env}）</li>
 *   <li>环境变量（如 {@code PORT=9000}，CI 与临时覆盖用）</li>
 *   <li>本配置文件 {@code server/config/config.json}</li>
 *   <li>代码内默认值</li>
 * </ol>
 * 环境变量优先于配置文件，是为了保住既有的 30+ 环境变量注入方式
 * （CI、临时调试无需改文件）；配置文件则提供开箱即用的默认值，
 * 避免用户为改一个端口就去记环境变量名。
 *
 * <p>约定：配置文件用<b>小写蛇形</b>键名（{@code api.port}），
 * 环境变量用<b>大写下划线</b>（{@code API_PORT}），
 * 二者通过 {@link #ENV_OF} 映射到同一配置项。
 *
 * <p>配置文件缺失或解析失败时静默降级为「无配置」，不影响启动 ——
 * 配置是可选的便利项，不该成为启动的硬依赖。
 */
public final class Config {

    private Config() {}

    /** 配置项候选路径，按优先级尝试。 */
    private static final String[] PATHS = {
            "server/config/config.json",
            "scripts/config.json",
            "config.json",
    };

    /**
     * 配置键 → 环境变量名。
     * 键名用小写蛇形，与 JSON 里的键一一对应。
     */
    private static final Map<String, String> ENV_OF = Map.ofEntries(
            // ---- API 服务 ----
            Map.entry("api.enabled", "HG_API_ENABLED"),
            Map.entry("api.host", "BIND_HOST"),
            Map.entry("api.port", "PORT"),
            // ---- 签名服务 ----
            Map.entry("signer.enabled", "HG_SIGN_ENABLED"),
            Map.entry("signer.port", "SIGN_PORT"),
            Map.entry("signer.server", "SIGN_SERVER"),
            Map.entry("signer.jvm_xmx", "SIGN_JVM_XMX"),
            Map.entry("signer.ready_timeout_ms", "READY_TIMEOUT_MS"),
            // ---- 启动器行为 ----
            Map.entry("launcher.open_browser", "HG_OPEN_BROWSER"),
            // HG_SKIP_JRE_INSTALL 刻意不在此列：它必须由 start.bat 在 JVM
            // 启动之前判断，而那时还没有 JVM 能读配置文件，所以只能走
            // 环境变量。Java 侧不需要、也不应该知道它。
            // ---- 运行时调优 ----
            Map.entry("runtime.transcode", "HG_TRANSCODE"),
            Map.entry("runtime.show_metasec", "HG_SHOW_METASEC"),
            Map.entry("runtime.data_dir", "HONGGUO_DATA_DIR"),
            Map.entry("runtime.device_id", "HG_DEVICE_ID"),
            Map.entry("runtime.cache.max_files", "HONGGUO_CACHE_MAX_FILES"),
            Map.entry("runtime.cache.mem_max", "HG_MEM_CACHE_MAX"),
            Map.entry("runtime.cache.mem_max_mb", "HG_MEM_CACHE_MAX_MB"),
            Map.entry("runtime.cache.img_max_mb", "HG_IMG_CACHE_MAX_MB"),
            Map.entry("runtime.cache.img_max_kb", "HG_IMG_MAX_KB"),
            Map.entry("runtime.throttle_ms", "HG_THROTTLE_MS"),
            Map.entry("runtime.rate_buckets_max", "HG_RATE_BUCKETS_MAX"),
            Map.entry("runtime.rate_bucket_idle_ms", "HG_RATE_BUCKET_IDLE_MS"),
            Map.entry("runtime.sweep_interval_ms", "HG_SWEEP_INTERVAL_MS"));

    /** 配置对象；解析失败或文件缺失时为 null，表示「无配置」。 */
    private static final Map<String, Object> CFG = load();

    private static Map<String, Object> load() {
        // 允许用环境变量直接指定配置文件路径（与 HONGGUO_CONTENT_CONFIG 同一套用法）
        String custom = Log.env("HONGGUO_CONFIG", null);
        List<String> candidates = new ArrayList<>();
        if (custom != null) candidates.add(custom);
        for (String p : PATHS) candidates.add(p);

        for (String c : candidates) {
            try {
                Path p = Paths.get(c);
                if (!Files.exists(p)) continue;
                byte[] raw = Files.readAllBytes(p);
                if (raw.length == 0) return null;
                // 容忍 BOM：记事本存 UTF-8 时会加 EF BB BF，直接喂给 JSON 解析器会失败
                int off = (raw.length >= 3 && raw[0] == (byte) 0xEF
                        && raw[1] == (byte) 0xBB && raw[2] == (byte) 0xBF) ? 3 : 0;
                String text = new String(raw, off, raw.length - off, StandardCharsets.UTF_8);
                if (text.trim().isEmpty()) return null;
                Map<String, Object> m = Json.parseObject(text);
                return (m == null || m.isEmpty()) ? null : m;
            } catch (Exception e) {
                // 试下一个候选路径；都失败则视为无配置
            }
        }
        return null;
    }

    /** 配置文件是否已成功装载（供启动日志提示用）。 */
    public static boolean loaded() {
        return CFG != null;
    }

    /** 配置文件实际路径，未装载时返回 null。 */
    public static String loadedFrom() {
        if (CFG == null) return null;
        String custom = Log.env("HONGGUO_CONFIG", null);
        if (custom != null && Files.exists(Paths.get(custom))) return custom;
        for (String c : PATHS) {
            if (Files.exists(Paths.get(c))) return c;
        }
        return null;
    }

    /**
     * 按点分键路径取原始对象，如 {@code get("api")}、{@code get("api.port")}。
     * 未配置时返回 null。
     */
    public static Object get(String dottedKey) {
        if (CFG == null) return null;
        Object cur = CFG;
        for (String seg : dottedKey.split("\\.")) {
            if (!(cur instanceof Map)) return null;
            cur = ((Map<?, ?>) cur).get(seg);
            if (cur == null) return null;
        }
        return cur;
    }

    /**
     * 读取字符串配置，优先级：系统属性 &gt; 环境变量 &gt; 配置文件 &gt; 默认值。
     *
     * @param key 配置键（点分路径），同时用于反查环境变量名
     * @param def 默认值
     */
    public static String str(String key, String def) {
        String env = envNameOf(key);
        if (env != null) {
            String v = Log.env(env, null);
            if (v != null) return v;
        }
        Object o = get(key);
        if (o == null) return def;
        String s = Json.optStr(o, "").trim();
        return s.isEmpty() ? def : s;
    }

    /** 读取整型配置，非法值回落到默认值。 */
    public static int num(String key, int def) {
        String env = envNameOf(key);
        if (env != null) {
            String v = Log.env(env, null);
            if (v != null) {
                try {
                    return Integer.parseInt(v.trim());
                } catch (NumberFormatException ignored) {
                    // 落到配置文件
                }
            }
        }
        Object o = get(key);
        if (o == null) return def;
        if (o instanceof Number) return ((Number) o).intValue();
        try {
            return Integer.parseInt(Json.optStr(o, "").trim());
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /** 读取布尔配置：true/1/yes/on 视为真；false/0/no/off 视为假。 */
    public static boolean bool(String key, boolean def) {
        String env = envNameOf(key);
        if (env != null) {
            String v = Log.env(env, null);
            if (v != null) return parseBool(v, def);
        }
        Object o = get(key);
        if (o == null) return def;
        if (o instanceof Boolean) return (Boolean) o;
        return parseBool(Json.optStr(o, ""), def);
    }

    private static boolean parseBool(String s, boolean def) {
        if (s == null) return def;
        String t = s.trim().toLowerCase();
        if (t.isEmpty()) return def;
        if (t.equals("1") || t.equals("true") || t.equals("yes") || t.equals("on")) return true;
        if (t.equals("0") || t.equals("false") || t.equals("no") || t.equals("off")) return false;
        return def;
    }

    /** 该键对应的环境变量名；未登记则返回 null（只能靠配置文件）。 */
    private static String envNameOf(String key) {
        return ENV_OF.get(key);
    }

    /** 列出全部可配置键，供 {@code --help} 与文档同步。 */
    public static List<String> keys() {
        List<String> l = new ArrayList<>(ENV_OF.keySet());
        java.util.Collections.sort(l);
        return l;
    }
}