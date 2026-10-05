package com.hongguo.api.service;

import com.hongguo.api.util.Json;

import java.io.IOException;
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * HTTP 响应辅助：统一 JSON 响应、静态文件、Range 串流。
 * 对应 server/src/server.js 里的 send / serveStatic / /stream 逻辑。
 */
public final class Res {

    private Res() {}

    /** 一次性写完响应（JSON / 文本 / 字节）。 */
    public static void send(com.sun.net.httpserver.HttpExchange ex, int status, byte[] body,
                            Map<String, String> headers) throws IOException {
        com.sun.net.httpserver.Headers h = ex.getResponseHeaders();
        if (headers != null) {
            for (Map.Entry<String, String> e : headers.entrySet()) {
                if (e.getValue() != null) h.set(e.getKey(), e.getValue());
            }
        }
        boolean hasLen = h.containsKey("Content-Length");
        if (!hasLen) h.set("Content-Length", String.valueOf(body.length));
        ex.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
        if (body.length > 0) {
            try (OutputStream os = ex.getResponseBody()) {
                os.write(body);
            }
        } else {
            ex.close();
        }
    }

    public static void json(com.sun.net.httpserver.HttpExchange ex, int status, Object obj)
            throws IOException {
        send(ex, status, Json.stringify(obj).getBytes(StandardCharsets.UTF_8),
                headers("application/json; charset=utf-8", null));
    }

    /** 统一响应头（默认 JSON + 全量 CORS）。 */
    public static Map<String, String> headers(String contentType, String cacheControl) {
        Map<String, String> h = new LinkedHashMap<>();
        h.put("Content-Type", contentType);
        h.put("Access-Control-Allow-Origin", "*");
        if (cacheControl != null) h.put("Cache-Control", cacheControl);
        return h;
    }

    public static void fail(com.sun.net.httpserver.HttpExchange ex, int status, String detail)
            throws IOException {
        Map<String, Object> m = Json.obj();
        m.put("detail", detail);
        json(ex, status, m);
    }

    public static void fail(com.sun.net.httpserver.HttpExchange ex, int status, String detail,
                            String extraKey, Object extraVal) throws IOException {
        Map<String, Object> m = Json.obj();
        m.put("detail", detail);
        if (extraKey != null) m.put(extraKey, extraVal);
        json(ex, status, m);
    }

    // ==================== 静态文件 ====================

    private static final Map<String, String> MIME = new LinkedHashMap<>();
    static {
        MIME.put(".html", "text/html; charset=utf-8");
        MIME.put(".js", "application/javascript; charset=utf-8");
        MIME.put(".css", "text/css; charset=utf-8");
        MIME.put(".json", "application/json; charset=utf-8");
        MIME.put(".svg", "image/svg+xml");
        MIME.put(".png", "image/png");
        MIME.put(".ico", "image/x-icon");
        MIME.put(".mp4", "video/mp4");
    }

    /** 内联 favicon（SVG）。省掉一个二进制资源。 */
    private static final String FAVICON_SVG =
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 64 64\">"
            + "<rect width=\"64\" height=\"64\" rx=\"14\" fill=\"#e11d48\"/>"
            + "<text x=\"32\" y=\"44\" font-size=\"34\" font-family=\"sans-serif\" font-weight=\"bold\""
            + " text-anchor=\"middle\" fill=\"#fff\">红</text></svg>";

    /** 判断是否前端静态资源路径。 */
    public static boolean isStaticPath(String pathname) {
        if (pathname.equals("/") || pathname.equals("/ui") || pathname.equals("/ui/")) return true;
        return Pattern.compile(
                "\\.(html|js|mjs|css|svg|png|jpg|jpeg|gif|ico|webp|woff2?|ttf|map)$",
                Pattern.CASE_INSENSITIVE).matcher(pathname).find();
    }

    /** 静态文件服务（含 SPA 回退与目录穿越防护）。 */
    public static void serveStatic(com.sun.net.httpserver.HttpExchange ex, String pathname,
                                   Path webDir) throws IOException {
        if (pathname.equals("/favicon.ico") || pathname.equals("/favicon.svg")) {
            send(ex, 200, FAVICON_SVG.getBytes(StandardCharsets.UTF_8),
                    headers("image/svg+xml; charset=utf-8", "max-age=604800"));
            return;
        }
        String rel = pathname;
        if (rel.equals("/ui") || rel.equals("/ui/")) rel = "/index.html";
        if (rel.equals("/")) rel = "/index.html";

        Path root = webDir.toAbsolutePath().normalize();
        Path file = root.resolve("." + normalizePosix(rel)).normalize();
        if (!file.equals(root) && !file.startsWith(root)) {
            fail(ex, 403, "forbidden");
            return;
        }
        try {
            byte[] data = Files.readAllBytes(file);
            String ext = extOf(file.getFileName().toString());
            send(ex, 200, data, headers(MIME.getOrDefault(ext, "application/octet-stream"), null));
        } catch (Exception e) {
            // SPA 回退：无扩展名的路径一律回落到 index.html
            if (extOf(file.getFileName().toString()).isEmpty()) {
                try {
                    byte[] data = Files.readAllBytes(root.resolve("index.html"));
                    send(ex, 200, data, headers(MIME.get(".html"), null));
                    return;
                } catch (Exception e2) {
                    // 落到 404
                }
            }
            fail(ex, 404, "not found");
        }
    }

    private static String extOf(String name) {
        int i = name.lastIndexOf('.');
        return i < 0 ? "" : name.substring(i);
    }

    /** 规范化 POSIX 路径（等价 path.posix.normalize 的常见用法）。 */
    private static String normalizePosix(String p) {
        List<String> out = new ArrayList<>();
        for (String seg : p.split("/")) {
            if (seg.isEmpty() || seg.equals(".")) continue;
            if (seg.equals("..")) {
                if (!out.isEmpty()) out.remove(out.size() - 1);
            } else {
                out.add(seg);
            }
        }
        return "/" + String.join("/", out);
    }

    // ==================== 视频串流（支持 Range） ====================

    /**
     * 已解密视频串流：支持 Range 拖动，&lt;video&gt; 用 ?api_key= 传密钥。
     *
     * @param filename 建议文件名（中文需 RFC 5987 编码）
     */
    public static void streamFile(com.sun.net.httpserver.HttpExchange ex, Path file, String vid,
                                  String filename) throws IOException {
        long size = Files.size(file);
        String cd = "inline; filename=\"" + vid + ".mp4\"; filename*=UTF-8''"
                + com.hongguo.api.util.Http.urlencode(filename);

        String range = ex.getRequestHeaders().getFirst("Range");
        if (range != null && range.startsWith("bytes=")) {
            Matcher m = Pattern.compile("bytes=(\\d*)-(\\d*)").matcher(range);
            long start = 0;
            long end = size - 1;
            if (m.find()) {
                String gs = m.group(1);
                String ge = m.group(2);
                if (gs != null && !gs.isEmpty()) {
                    try {
                        start = Long.parseLong(gs);
                    } catch (NumberFormatException e) {
                        start = 0;
                    }
                }
                if (ge != null && !ge.isEmpty()) {
                    try {
                        end = Long.parseLong(ge);
                    } catch (NumberFormatException e) {
                        end = size - 1;
                    }
                }
            }
            if (start < 0) start = 0;
            if (end >= size) end = size - 1;
            if (end < start) {
                ex.getResponseHeaders().set("Content-Range", "bytes */" + size);
                ex.sendResponseHeaders(416, -1);
                ex.close();
                return;
            }
            long len = end - start + 1;
            com.sun.net.httpserver.Headers h = ex.getResponseHeaders();
            h.set("Content-Type", "video/mp4");
            h.set("Content-Length", String.valueOf(len));
            h.set("Content-Range", "bytes " + start + "-" + end + "/" + size);
            h.set("Accept-Ranges", "bytes");
            h.set("Content-Disposition", cd);
            h.set("Access-Control-Allow-Origin", "*");
            h.set("Access-Control-Expose-Headers", "content-range, accept-ranges, content-length");
            ex.sendResponseHeaders(206, len);
            try (OutputStream os = ex.getResponseBody()) {
                copyRange(file, os, start, len);
            }
            return;
        }

        com.sun.net.httpserver.Headers h = ex.getResponseHeaders();
        h.set("Content-Type", "video/mp4");
        h.set("Content-Length", String.valueOf(size));
        h.set("Accept-Ranges", "bytes");
        h.set("Content-Disposition", cd);
        h.set("Access-Control-Allow-Origin", "*");
        h.set("Access-Control-Expose-Headers", "content-range, accept-ranges, content-length");
        ex.sendResponseHeaders(200, size);
        try (OutputStream os = ex.getResponseBody()) {
            copyRange(file, os, 0, size);
        }
    }

    private static void copyRange(Path file, OutputStream os, long start, long len)
            throws IOException {
        try (java.io.InputStream is = Files.newInputStream(file)) {
            long skipped = 0;
            while (skipped < start) {
                long s = is.skip(start - skipped);
                if (s <= 0) break;
                skipped += s;
            }
            byte[] buf = new byte[65536];
            long remain = len;
            while (remain > 0) {
                int want = (int) Math.min(buf.length, remain);
                int n = is.read(buf, 0, want);
                if (n <= 0) break;
                os.write(buf, 0, n);
                remain -= n;
            }
        }
    }
}
