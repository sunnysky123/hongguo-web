package com.hongguo.api.util;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/** 统一日志输出，格式与原 Node 版保持一致，便于用户对照排查。 */
public final class Log {

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private static boolean encodingFixed = false;

    private Log() {}

    /**
     * 把标准输出/错误流锁定为 UTF-8（幂等）。
     *
     * 背景：JDK 19 起 {@code stdout.encoding} 默认跟随控制台代码页。
     * 中文Windows 用户的 start.bat 已执行 {@code chcp 65001}（控制台按 UTF-8
     * 解码），而 JVM 却按 GBK 编码输出，双重编码导致每个汉字重复成
     * 「红红果果短短剧剧」。本项目所有文本（源码、配置、网页、转发给用户的
     * 签名日志）都是 UTF-8，输出统一到 UTF-8 才能与控制台解码一致。
     *
     * 幂等：重复调用只生效一次，避免多次包装。
     */
    public static void initEncoding() {
        if (encodingFixed) return;
        encodingFixed = true;
        System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true,
                StandardCharsets.UTF_8));
        System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true,
                StandardCharsets.UTF_8));
    }

    public static void info(String msg)  { write(System.out, msg, false); }
    public static void warn(String msg)  { write(System.out, msg, true); }
    public static void error(String msg) { write(System.err, msg, true); }

    public static void error(String msg, Throwable t) {
        write(System.err, msg, true);
        if (t != null) t.printStackTrace();
    }

    private static void write(PrintStream out, String msg, boolean isWarn) {
        out.println(String.format("%s [%s] %s",
                LocalDateTime.now().format(TS), isWarn ? "WARN" : "INFO", msg));
        out.flush();
    }

    /**
     * 读取配置项：优先系统属性，其次环境变量。
     *
     * 系统属性优先是为了让同进程内的编排结果能直接下发给各模块 ——
     * Launcher 用 System.setProperty("SIGN_SERVER", ...) 把刚拉起的签名服务
     * 地址告诉 API 服务，而不需要去改进程环境变量（JVM 环境下改env 不可行）。
     * 空字符串视为未设置（对齐 JS 里 process.env.X || default 的语义）。
     */
    public static String env(String name, String def) {
        String p = System.getProperty(name);
        if (p != null && !p.trim().isEmpty()) return p.trim();
        String v = System.getenv(name);
        if (v == null) return def;
        v = v.trim();
        return v.isEmpty() ? def : v;
    }

    /** 读取整型环境变量，非法时返回 def。 */
    public static int envInt(String name, int def) {
        String v = env(name, null);
        if (v == null) return def;
        try {
            return Integer.parseInt(v);
        } catch (NumberFormatException e) {
            return def;
        }
    }

    /** 读取布尔环境变量：1/true/yes/on 视为真。 */
    public static boolean envBool(String name, boolean def) {
        String v = env(name, null);
        if (v == null) return def;
        String s = v.toLowerCase();
        return s.equals("1") || s.equals("true") || s.equals("yes") || s.equals("on");
    }
}
