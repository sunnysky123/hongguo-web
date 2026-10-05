package com.hongguo.api.core;

import com.hongguo.api.util.Json;
import com.hongguo.api.util.Log;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Map;

/**
 * 本机稳定设备身份。
 *
 * 背景（实测结论）：
 *   红果的 search/tab/v 接口会校验 query 里的 device_id。缺失时上游直接返回
 *   code=100103 PARAM_INVALID —— 与签名是否正确无关，签名齐全也一样。
 *   对照实验（同一时刻、同一签名服务）：
 *     无device_id                -> code=100103（53 字节）
 *     有 device_id，任意随机值           -> code=0，正常返回
 *     有 device_id + 不匹配的 iid       -> 空响应（风控拦截）
 *     有 device_id + iid=0-> code=0
 *   结论：device_id 是必需项；iid 反而不能乱填，非 0 的随机 iid 会被风控。
 *   因此本模块只生成 device_id，不生成 iid。
 *
 * 为什么必须持久化：
 *   device_id 相当于本机的「设备指纹」。若每次启动都随机生成，短时间内的
 *   身份跳变会被上游判定为异常流量。落盘后长期保持稳定，符合真实设备行为。
 *
 * 优先级：
 *   1. 环境变量 HONGGUO_DEVICE_ID / HG_DEVICE_ID（便于多实例隔离）
 *   2. 配置里已有的 device_id（content-config.json base_query）
 *   3. server/data/device.json 中持久化的值
 *   4. 以上都没有时生成新的并落盘
 */
public final class Device {

    private static final SecureRandom RND = new SecureRandom();

    private static Path dataDir() {
        String d = Log.env("HONGGUO_DATA_DIR", null);
        if (d != null) return Paths.get(d);
        return Paths.get("server", "data");
    }

    private static Path deviceFile() {
        return dataDir().resolve("device.json");
    }

    /** device.json 的落盘路径（自检与诊断用）。 */
    public static Path storeFile() {
        return deviceFile();
    }

    /** 设备 ID 取值范围：与抓包一致，16 位十进制（1e15 ~ 1e16-1）。 */
    public static String randomDeviceId() {
        java.math.BigInteger n = new java.math.BigInteger(64, RND)
                .mod(java.math.BigInteger.valueOf(9000000000000000L));
        return n.add(java.math.BigInteger.valueOf(1000000000000000L)).toString();
    }

    /** 校验格式：仅接受 10~20 位十进制数字，避免把脏值带进 query。 */
    public static boolean isValidId(String v) {
        if (v == null) return false;
        String t = v.trim();
        if (t.length() < 10 || t.length() > 20) return false;
        for (int i = 0; i < t.length(); i++) {
            if (t.charAt(i) < '0' || t.charAt(i) > '9') return false;
        }
        return true;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readStore() {
        try {
            Path f = deviceFile();
            if (!Files.exists(f)) return Json.obj();
            String raw = new String(Files.readAllBytes(f), StandardCharsets.UTF_8);
            if (!raw.isEmpty() && raw.charAt(0) == '﻿') raw = raw.substring(1);
            Object v = Json.parse(raw);
            return Json.optObj(v);
        } catch (Exception e) {
            return Json.obj();
        }
    }

    private static boolean writeStore(Map<String, Object> obj) {
        try {
            Path f = deviceFile();
            Files.createDirectories(f.getParent());
            Files.write(f, Json.stringifyPretty(obj).getBytes(StandardCharsets.UTF_8));
            return true;
        } catch (Exception e) {
            Log.warn("写入设备身份文件失败（仅本次运行有效）: " + e.getMessage());
            return false;
        }
    }

    /** 取得本机稳定 device_id 的结果。 */
    public static final class Identity {
        public final String deviceId;
        public final String source;

        Identity(String deviceId, String source) {
            this.deviceId = deviceId;
            this.source = source;
        }
    }

    /**
     * 取得本机稳定 device_id。
     *
     * @param baseQuery 上游配置里的 base_query（可能被就地补全）
     */
    public static Identity ensureDeviceId(Map<String, Object> baseQuery) {
        // 1) 环境变量优先：支持同一台机器跑多个实例并各自隔离身份
        String fromEnv = Log.env("HONGGUO_DEVICE_ID",
                Log.env("HG_DEVICE_ID", "")).trim();
        if (!fromEnv.isEmpty() && isValidId(fromEnv)) {
            if (baseQuery != null && !isValidId(Json.optStr(baseQuery.get("device_id"), ""))) {
                baseQuery.put("device_id", fromEnv);
            }
            return new Identity(fromEnv, "env");
        }

        // 2) 配置里已显式提供：尊重配置，不覆盖
        if (baseQuery != null) {
            String cfg = Json.optStr(baseQuery.get("device_id"), "").trim();
            if (isValidId(cfg)) return new Identity(cfg, "config");
        }

        // 3) 复用上次持久化的值
        Map<String, Object> store = readStore();
        String saved = Json.optStr(store.get("device_id"), "").trim();
        if (isValidId(saved)) {
            if (baseQuery != null) baseQuery.put("device_id", saved);
            return new Identity(saved, "stored");
        }

        // 4) 首次生成并落盘
        String id = randomDeviceId();
        if (baseQuery != null) baseQuery.put("device_id", id);
        Map<String, Object> out = Json.obj();
        out.put("device_id", id);
        // 刻意不写 iid：随机 iid 会触发风控（见文件头实测结论）
        out.put("created_at", Instant.now().toString());
        out.put("note", "本机稳定设备标识；删除此文件会重新生成并可能触发上游风控");
        writeStore(out);
        return new Identity(id, "generated");
    }

    /** 当前生效的 device_id（不修改任何配置）。 */
    public static String currentDeviceId() {
        String fromEnv = Log.env("HONGGUO_DEVICE_ID",
                Log.env("HG_DEVICE_ID", "")).trim();
        if (isValidId(fromEnv)) return fromEnv;
        return Json.optStr(readStore().get("device_id"), "").trim();
    }
}
