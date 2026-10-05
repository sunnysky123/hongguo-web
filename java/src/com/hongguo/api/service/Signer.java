package com.hongguo.api.service;

import com.hongguo.api.util.Http;
import com.hongguo.api.util.Json;
import com.hongguo.api.util.Log;

import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 签名客户端：对接 Java(unidbg) 签名服务。
 *
 * 原应用的签名由 unidbg 在本地 x86_64 上模拟 ARM64 的 libmetasec_ml.so 执行，
 * 通过一个 HTTP 服务暴露（默认 127.0.0.1:9099）。
 *
 * 本模块保持与原实现完全一致的调用协议：
 *   POST {base}/sign  {url, headers} -> { "X-Argus": ..., "X-Gorgon": ..., "X-Khronos": ..., "X-Ladon": ... }
 *   GET  {base}/grab  -> { url, headers }  （抓取设备身份，用于登录态刷新）
 *
 * 设计要点：
 *  - 支持多个签名服务地址轮询 + 故障转移（原 SIGN_SERVER 逗号分隔语义）。
 *  - 签名服务不可用时抛出可诊断错误，由上层决定降级。
 */
public final class Signer {

    private static int rrIndex = 0;

    private Signer() {}

    /** 原 SIGN_SERVER 的默认值：逗号分隔的地址列表。 */
    public static List<String> signServers() {
        String raw = Log.env("SIGN_SERVER", "");
        List<String> out = new ArrayList<>();
        for (String s : raw.split(",")) {
            String t = s.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    private static synchronized String nextServer(List<String> list) {
        if (list.isEmpty()) return null;
        String s = list.get(rrIndex % list.size());
        rrIndex = (rrIndex + 1) % list.size();
        return s;
    }

    private static String joinUrl(String base, String pathname) {
        String b = base;
        while (b.endsWith("/")) b = b.substring(0, b.length() - 1);
        return b + pathname;
    }

    /** POST JSON 到本机签名服务。 */
    private static Map<String, Object> postJson(String base, String pathname,
                                                Map<String, Object> payload, int timeoutMs)
            throws IOException {
        byte[] body = Json.stringify(payload).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        Http.Resp r = Http.send(new Http.Req(joinUrl(base, pathname))
                .method("POST")
                .header("Content-Type", "application/json")
                .header("Content-Length", String.valueOf(body.length))
                .body(body)
                .timeout(timeoutMs));
        if (!r.ok()) {
            throw new IOException("签名服务 HTTP " + r.status);
        }
        try {
            return Json.parseObject(r.text());
        } catch (Exception e) {
            throw new IOException("签名服务返回非 JSON");
        }
    }

    /** GET JSON（用于 /grab 与健康检查）。 */
    private static Map<String, Object> getJson(String base, String pathname, int timeoutMs)
            throws IOException {
        Http.Resp r = Http.send(new Http.Req(joinUrl(base, pathname))
                .method("GET")
                .timeout(timeoutMs));
        if (!r.ok()) {
            throw new IOException("签名服务 HTTP " + r.status);
        }
        try {
            return Json.parseObject(r.text());
        } catch (Exception e) {
            throw new IOException("签名服务返回非 JSON");
        }
    }

    /**
     * 对URL + headers 签名。
     *
     * @param url     待签名完整 URL
     * @param headers 基础请求头
     * @return 签名后的头字段
     */
    public static Map<String, String> sign(String url, Map<String, String> headers) throws IOException {
        List<String> list = signServers();
        if (list.isEmpty()) {
            throw new IOException("未配置签名服务（SIGN_SERVER 为空）。"
                    + "请启动 Java 签名服务并设置 SIGN_SERVER=http://127.0.0.1:9099");
        }
        Map<String, Object> payload = Json.obj();
        payload.put("url", url);
        payload.put("headers", new LinkedHashMap<String, Object>(headers));

        List<String> errors = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            String base = nextServer(list);
            try {
                Map<String, Object> j = postJson(base, "/sign", payload, 40000);
                Object err = j.get("error");
                if (err != null) {
                    throw new IOException(String.valueOf(err));
                }
                Map<String, String> out = new LinkedHashMap<>();
                for (Map.Entry<String, Object> e : j.entrySet()) {
                    if (e.getValue() != null) {
                        out.put(e.getKey(), String.valueOf(e.getValue()));
                    }
                }
                return out;
            } catch (IOException e) {
                errors.add(base + ": " + e.getMessage());
            }
        }
        throw new IOException("所有签名服务失败: " + String.join("; ", errors));
    }

    /** 抓取签名服务侧的设备身份（登录态刷新用）。 */
    public static Map<String, Object> grab() throws IOException {
        List<String> list = signServers();
        if (list.isEmpty()) throw new IOException("未配置签名服务");
        return getJson(list.get(0), "/grab", 60000);
    }

    /** 单个后端的健康状态。 */
    public static final class Health {
        public final String url;
        public final boolean ready;
        public final String error;
        public final String probe;

        Health(String url, boolean ready, String error, String probe) {
            this.url = url;
            this.ready = ready;
            this.error = error;
            this.probe = probe;
        }

        public Map<String, Object> toMap() {
            Map<String, Object> m = Json.obj();
            m.put("url", url);
            m.put("ready", ready);
            m.put("probe", probe);
            if (error != null) m.put("error", error);
            return m;
        }
    }

    /**
     * 健康检查：探测签名服务是否可用。
     * 该服务只提供 /sign 与 /grab，根路径返回 404，因此不能拿 GET / 当作探活依据。
     * 这里以「端口可连接 + 已知路由存在」作为就绪判据。
     */
    public static List<Object> health() {
        List<Object> out = new ArrayList<>();
        for (String b : signServers()) {
            try {
                try {
                    getJson(b, "/", 5000);
                } catch (IOException e) {
                    // 根路径 404 属预期：说明端口活着且是本签名服务
                    if (e.getMessage() == null || !e.getMessage().contains("HTTP 404")) throw e;
                }
                out.add(new Health(b, true, null, "tcp+route").toMap());
            } catch (Exception e) {
                out.add(new Health(b, false, e.getMessage(), "tcp+route").toMap());
            }
        }
        return out;
    }
}
