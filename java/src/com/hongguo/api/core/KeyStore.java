package com.hongguo.api.core;

import com.hongguo.api.util.Crypto;
import com.hongguo.api.util.Json;
import com.hongguo.api.util.Log;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 本地链路密钥管理。
 *
 * 设计：数据接口强制要求有效密钥（x-api-key 头或 ?api_key= 查询参数），
 * 管理接口另用 ADMIN_TOKEN 口令校验，两者分离。
 */
public final class KeyStore {

    private static final SecureRandom RND = new SecureRandom();

    private final Path file;
    /** key -> 记录。 */
    private final Map<String, Rec> keys = new LinkedHashMap<>();

    /** 密钥记录。 */
    public static final class Rec {
        public String key = "";
        public String note = "";
        public boolean enabled = true;
        public String createdAt = "";

        Map<String, Object> toMap() {
            Map<String, Object> m = Json.obj();
            m.put("key", key);
            m.put("note", note);
            m.put("enabled", enabled);
            m.put("createdAt", createdAt);
            return m;
        }
    }

    public KeyStore() {
        String d = Log.env("HONGGUO_DATA_DIR", null);
        Path dir = (d != null) ? Paths.get(d) : Paths.get("server", "data");
        this.file = dir.resolve("apikeys.json");
        load();
    }

    @SuppressWarnings("unchecked")
    private void load() {
        try {
            if (!Files.exists(file)) return;
            String raw = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            Object v = Json.parse(raw);
            Map<String, Object> root = Json.optObj(v);
            if (root == null) return;
            for (Object rowObj : Json.optArr(root.get("keys"))) {
                Map<String, Object> row = Json.optObj(rowObj);
                if (row == null) continue;
                String k = Json.optStr(row.get("key"), "");
                if (k.isEmpty()) continue;
                Rec r = new Rec();
                r.key = k;
                r.note = Json.optStr(row.get("note"), "");
                r.enabled = Json.optBool(row.get("enabled"), true);
                r.createdAt = Json.optStr(row.get("createdAt"), "");
                keys.put(k, r);
            }
        } catch (Exception e) {
            Log.warn("读取密钥文件失败，使用空集合: " + e.getMessage());
        }
    }

    private void save() {
        try {
            Files.createDirectories(file.getParent());
            List<Object> rows = new ArrayList<>();
            for (Rec r : keys.values()) rows.add(r.toMap());
            Map<String, Object> out = Json.obj();
            out.put("keys", rows);
            Files.write(file, Json.stringifyPretty(out).getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            Log.warn("写入密钥文件失败（仅内存生效）: " + e.getMessage());
        }
    }

    /** 首次启动时若无任何密钥，自动签发一把本地密钥，避免用户手动配置。 */
    public String ensureBootstrap() {
        if (!keys.isEmpty()) return null;
        return generate("bootstrap");
    }

    public String generate(String note) {
        byte[] raw = new byte[24];
        RND.nextBytes(raw);
        String key = "hg_" + Crypto.hex(raw);
        Rec r = new Rec();
        r.key = key;
        r.note = note == null ? "" : note;
        r.enabled = true;
        r.createdAt = Instant.now().toString();
        keys.put(key, r);
        save();
        return key;
    }

    public boolean isValid(String key) {
        if (key == null || key.isEmpty()) return false;
        Rec r = keys.get(key);
        return r != null && r.enabled;
    }

    public List<Object> list() {
        List<Object> out = new ArrayList<>();
        for (Rec r : keys.values()) out.add(r.toMap());
        return out;
    }

    /** 找出第一把启用的密钥（自动签发接口用）。 */
    public Rec firstEnabled() {
        for (Rec r : keys.values()) if (r.enabled) return r;
        return null;
    }

    public Rec get(String key) {
        return key == null ? null : keys.get(key);
    }

    public int countEnabled() {
        int n = 0;
        for (Rec r : keys.values()) if (r.enabled) n++;
        return n;
    }

    /** 撤销或启用一把密钥。 */
    public boolean revoke(String key, boolean enable) {
        Rec r = key == null ? null : keys.get(key);
        if (r == null) return false;
        r.enabled = enable;
        save();
        return true;
    }

    public boolean delete(String key) {
        if (key == null) return false;
        boolean ok = keys.remove(key) != null;
        if (ok) save();
        return ok;
    }
}
