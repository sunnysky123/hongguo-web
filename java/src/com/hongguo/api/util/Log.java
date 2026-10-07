package com.hongguo.api.util;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.PrintStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/** 统一日志输出，格式与原 Node 版保持一致，便于用户对照排查。 */
public final class Log {

    private static final DateTimeFormatter TS = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private static boolean encodingFixed = false;

    /**
     * 当前控制台实际使用的编码。
     *
     * <p>供转发子进程输出时解码用：签名服务是另一个 JVM，它的输出遵循
     * 与本进程相同的规则（跟随控制台），所以这里解码才能对得上。
     */
    private static Charset consoleCharset = Charset.defaultCharset();

    private Log() {}

    public static Charset consoleCharset() {
        return consoleCharset;
    }

    /**
     * 让日志输出与控制台代码页一致（幂等）。
     *
     * <p><b>这里刻意不强制 UTF-8。</b>
     *
     * <p>代价来自一次真实的踩坑：中文Windows 的控制台代码页是 936(GBK)，
     * 而先前版本把 {@code -Dstdout.encoding=UTF-8} 与本方法强行包装的
     * UTF-8 叠加，结果 JVM 输出 UTF-8 字节、控制台按 GBK 解码，
     * 每个汉字都变成「Java锛歫re\bin\java.exe」这种形态：
     * {@code ：} 的 UTF-8 字节 {@code E3 80 82} 被按 GBK 读成「锛」。
     *
     * <p>正确做法是<b>顺着控制台，而不是跟它较劲</b>：
     * <ul>
     *   <li>JDK 19+ 的 {@code stdout.encoding} 默认就跟随控制台代码页，
     *       此时不干预即为正确；</li>
     *   <li>JDK 17/18 的 {@code System.out} 用 {@code file.encoding}
     *       （即平台默认，中文 Windows 上本就是 GBK），同样已对齐。</li>
     * </ul>
     * 也就是说<b>什么都不做才是对的</b>。本方法只负责两件事：把实际
     * 生效的编码记下来供转发子进程时复用，以及在用户显式指定
     * {@code HG_LOG_ENCODING} 时照办。
     *
     * <p>需要 UTF-8 时（例如把输出重定向进文件再交给别的工具分析），
     * 设 {@code HG_LOG_ENCODING=UTF-8} 即可，不必改JVM 参数。
     */
    public static void initEncoding() {
        if (encodingFixed) return;
        encodingFixed = true;

        String forced = env("HG_LOG_ENCODING", null);
        if (forced != null) {
            try {
                Charset cs = Charset.forName(forced);
                consoleCharset = cs;
                System.setOut(new PrintStream(new FileOutputStream(FileDescriptor.out), true, cs));
                System.setErr(new PrintStream(new FileOutputStream(FileDescriptor.err), true, cs));
                return;
            } catch (Exception e) {
                // 非法编码名不该拦住启动，退回默认行为
                System.err.println("[warn] HG_LOG_ENCODING=" + forced + " 不是有效编码名，已忽略");
            }
        }

        // 记录 JVM 实际选中的编码，供 pipeSigner 解码子进程输出时对齐。
        // stdout.encoding 是 JDK 19+ 才有；更早的版本只有 file.encoding。
        String enc = System.getProperty("stdout.encoding");
        if (enc == null) enc = System.getProperty("file.encoding");
        if (enc != null) {
            try {
                consoleCharset = Charset.forName(enc);
            } catch (Exception ignored) {
                consoleCharset = Charset.defaultCharset();
            }
        }
        // 注意：这里<b>不</b>替换 System.out/err。JVM 当前的实现已经与
        // 控制台代码页对齐，再包一层反而会把 UTF-8 字节塞进 GBK 控制台。
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
