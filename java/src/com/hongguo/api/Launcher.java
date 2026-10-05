package com.hongguo.api;

import com.hongguo.api.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 跨平台启动器：先拉起 unidbg 签名服务，就绪后再拉起本地 API 服务。
 *
 * 取代原 Node 版 scripts/launcher.js。迁移后整条链路不再需要 Node.js 运行时，
 * 只需一个 JRE —— 因为签名服务本身就是 Java，API 服务现在也是 Java。
 *
 * 用法：
 *   java -jar hongguo-api.jar                    # 完整模式（含签名服务）
 *   java -jar hongguo-api.jar --no-sign          # 仅 API（免签列表页）
 *   java -jar hongguo-api.jar --sign-only        # 仅签名服务
 *   java -jar hongguo-api.jar --port 9000        # 指定签名服务端口
 *   java -jar hongguo-api.jar --selftest         # 跑自检
 *
 * 环境变量：
 *   JAVA_HOME / PATH        用于探测 java
 *   SIGN_SERVER             显式指定签名服务地址（不启动本地服务）
 *   SIGN_PORT               签名服务端口，默认 9099
 *   PORT / BIND_HOST        API 服务监听，默认 8000 / 127.0.0.1
 *   SIGN_JVM_XMX            签名服务堆上限，默认 512m
 *   READY_TIMEOUT_MS        签名服务就绪超时，默认 90000（unidbg 初始化较慢）
 *   HG_SHOW_METASEC=1       保留 so 内部的 METASEC 告警，便于排查
 */
public final class Launcher {

    /** 签名服务要求的最低 Java 主版本。 */
    private static final int JAVA_MIN_MAJOR = 17;

    private static final Path SIGN_DIR = Paths.get("signer");
    private static final Path JAR = SIGN_DIR.resolve("unidbg-sign.jar");
    /** 自带 JRE 位于仓库根目录（与 signer/ 平级，避免改动 signer 目录时被误删）。 */
    private static final Path BUNDLED_JRE = Paths.get("jre");
    private static final Path CAPTURE = Paths.get("capture", "fq_oversea");
    private static final String[] REQUIRED_SO = {
            "libmetasec_ml.so", "libc++_shared.so", "ms_16777218.bin"};

    private Launcher() {}

    // ==================== 入口 ====================

    public static void main(String[] args) throws Exception {
        boolean noSign = false;
        boolean signOnly = false;
        int signPort = Log.envInt("SIGN_PORT", 9099);

        for (int i = 0; i < args.length; i++) {
            String a = args[i];
            if (a.equals("--no-sign")) noSign = true;
            else if (a.equals("--sign-only")) signOnly = true;
            else if (a.equals("--port") && i + 1 < args.length) {
                try {
                    signPort = Integer.parseInt(args[++i]);
                } catch (NumberFormatException ignored) {
                    // 端口非法时沿用默认值
                }
            }
        }

        int apiPort = Log.envInt("PORT", 8000);
        String bindHost = Log.env("BIND_HOST", "127.0.0.1");
        String jvmXmx = Log.env("SIGN_JVM_XMX", "512m");
        int readyTimeout = Log.envInt("READY_TIMEOUT_MS", 90000);
        String externalSign = Log.env("SIGN_SERVER", "");

        banner();

        String signBase = null;
        // 已配置外部签名时不再拉起本地进程
        boolean needLocalSign = !noSign && externalSign.isEmpty();
        AtomicBoolean signStarting = new AtomicBoolean(false);

        if (needLocalSign) {
            List<String> missing = checkAssets();
            if (!missing.isEmpty()) {
                Log.info("签名资产不完整：");
                for (String m : missing) Log.info("  - " + m);
                Log.info("目录应为：");
                Log.info("  <根>/signer/unidbg-sign.jar");
                Log.info("  <根>/capture/fq_oversea/{libmetasec_ml.so,libc++_shared.so,ms_16777218.bin}");
                System.exit(1);
            }

            JavaBin java = findJava();
            if (java == null) {
                Log.info("未找到 Java 运行时。");
                Log.info("  Windows：把 JRE 放到 jre/，或安装 Temurin 25+ 并加入 PATH");
                Log.info("  也可运行 scripts\\install-jre.bat 自动下载安装。");
                System.exit(1);
            }
            Log.info("Java：" + java.bin);
            Log.info("     来源：" + java.from);

            // unidbg 依赖 JVM 内部 API，低版本 JRE 会在初始化时抛
            // InaccessibleObjectException 或缺签名头。这里提前拦下并说清原因。
            if (java.major != null) {
                if (java.major < JAVA_MIN_MAJOR) {
                    Log.info("Java 版本过低：" + java.major + " < " + JAVA_MIN_MAJOR);
                    Log.info("  签名服务需要 Java 17 或更高版本（推荐 25 LTS）。");
                    Log.info("  处理：把 Temurin JRE 25 解压到 jre/ 覆盖旧目录，");
                    Log.info("        或安装 Temurin 25 后清空 JAVA_HOME 再重试。");
                    System.exit(1);
                }
                String tag = java.major >= 25 ? "（LTS）" : "";
                Log.info("     版本：" + java.major + tag);
            } else {
                Log.info("[warn] 无法探测 Java 版本，若签名失败请确认 JRE >= 17");
            }

            signBase = "http://127.0.0.1:" + signPort;
            signStarting.set(true);
            Process proc = startSignService(java.bin, jvmXmx, signPort);

            Log.info("等待签名服务就绪（unidbg 初始化约需 10~30 秒）...");
            boolean ok = waitReady(signBase, readyTimeout, proc, signStarting);
            if (!ok) {
                if (proc != null && !proc.isAlive()) {
                    Log.info("签名服务进程已退出（code=" + proc.exitValue() + "）");
                    Log.info("  常见原因：端口被占用。可换端口重试，例如");
                    Log.info("    set SIGN_PORT=" + (signPort + 1) + " && start.bat");
                } else {
                    Log.info("签名服务 " + (readyTimeout / 1000) + "s 内未就绪");
                    Log.info("  排查：1) Java 版本 >= 17  2) capture/fq_oversea 下三个文件是否齐全");
                }
                shutdown(new ArrayList<>());
                System.exit(1);
            }
            Log.info("签名服务就绪 " + signBase);
        } else if (!externalSign.isEmpty()) {
            signBase = externalSign;
            while (signBase.endsWith("/")) signBase = signBase.substring(0, signBase.length() - 1);
            Log.info("使用外部签名服务：" + signBase);
        } else {
            Log.info("--no-sign：仅免签接口可用（推荐/榜单/最新/筛选）");
        }

        if (signOnly) {
            Log.info("签名服务独立运行中：" + signBase);
            Log.info("  按 Ctrl-C 停止");
            return;
        }

        // 把编排结果下发给同进程内的 API 服务。
        // 走系统属性而非环境变量：JVM 里无法改写自身环境变量，
        // 而 Log.env 会优先读系统属性，因此这一行等价于设置 SIGN_SERVER。
        if (signBase != null) System.setProperty("SIGN_SERVER", signBase);

        // 同进程内直接建Server，避免再 fork 一个 JVM
        Server server = new Server();
        String boot = server.ensureBootstrap();
        if (boot != null) Log.info("已签发本地链路密钥   " + boot);
        Log.info("管理口令(ADMIN_TOKEN) " + server.adminToken());

        server.start(bindHost, apiPort);
        Log.info("");
        Log.info("  ----------------------------------------");
        Log.info("  网页版  http://" + bindHost + ":" + apiPort + "/");
        Log.info("  ----------------------------------------");
        if (signBase != null) Log.info("  签名服务" + signBase);
        Log.info("  ----------------------------------------");
        Log.info("  按 Ctrl-C 停止 API 服务");
        Log.info("");
    }

    private static void banner() {
        Log.info("");
        Log.info("  红果短剧 · 网页版启动器（Java 版）");
        Log.info("  " + System.getProperty("os.name") + " "
                + System.getProperty("os.arch") + "  Java "
                + System.getProperty("java.version"));
        Log.info("");
    }

    // ==================== 签名服务 ====================

    /**
     * 启动 unidbg 签名服务子进程。
     *
     * --add-opens：unidbg 需要反射访问 java.lang（Unsafe / 内部类）
     * --enable-native-access：Java 24+ 对 System.loadLibrary 收紧了限制，
     *   unidbg 加载 libmetasec_ml.so 会打出 "Restricted methods will be blocked
     *   in a future release" 警告，显式开启可避免未来版本直接失败。
     *   低版本 JRE 不认识这个参数会直接退出，故仅在 >=24 时附加。
     */
    private static Process startSignService(String javaBin, String jvmXmx, int signPort) {
        Integer major = javaMajor(javaBin);
        List<String> cmd = new ArrayList<>(Arrays.asList(
                javaBin,
                "--add-opens", "java.base/java.lang=ALL-UNNAMED"));
        if (major != null && major >= 24) {
            cmd.add("--enable-native-access=ALL-UNNAMED");
        }
        cmd.add("-Xmx" + jvmXmx);
        cmd.add("-cp");
        cmd.add("unidbg-sign.jar");
        cmd.add("com.hongguo.sign.FqTrace");
        cmd.add("serve");
        cmd.add(String.valueOf(signPort));

        Log.info("[signer] " + String.join(" ", cmd));

        ProcessBuilder pb = new ProcessBuilder(cmd);
        // 关键：so 以 ../capture/ 相对路径加载，必须以 signer/ 为工作目录
        pb.directory(SIGN_DIR.toFile());
        pb.redirectErrorStream(true);
        try {
            Process p = pb.start();
            // 后台线程转发子进程输出，主线程继续等就绪
            Thread t = new Thread(() -> pipeSigner(p.getInputStream()));
            t.setDaemon(true);
            t.start();
            return p;
        } catch (IOException e) {
            Log.info("[signer] 启动失败：" + e.getMessage());
            return null;
        }
    }

    /** 被抑制的 METASEC 告警条数。 */
    private static final AtomicInteger METASEC_COUNT = new AtomicInteger();

    /**
     * 转发签名服务输出。
     *
     * libmetasec_ml.so 在每次签名时会向 stderr 打一行
     *   [main]E/METASEC: Fatal: SDK not init, crashing...
     * 实测（已验证）：启动阶段 0 次；每调用一次 /sign 恰好 1 次，严格 1:1。
     * 该行来自 so 内部一个非致命的旁路（证书/设备上报），主签名流程不依赖它，
     * 过滤前后每次/sign 都稳定返回 8 个签名头，搜索等接口实测 code=0。
     * 之所以过滤而非放任：它每次签名都刷一行，会把真正的错误淹没。
     */
    private static void pipeSigner(InputStream in) {
        boolean showMetasec = Log.envBool("HG_SHOW_METASEC", false);
        try {
            // so 的 stderr 不是按行吐的，而是把一句话拆成若干独立事件
            // （"[main" / "]E/METASEC: Fatal..." / ...）。因此必须维护 pending
            // 缓冲，把不完整的尾部留到下一个块再判断，否则会漏出 "[signer] [main" 残片。
            StringBuilder pending = new StringBuilder();
            BufferedReader br = new BufferedReader(
                    new InputStreamReader(in, StandardCharsets.UTF_8));
            int c;
            while ((c = br.read()) >= 0) {
                pending.append((char) c);
                if (c != '\n') continue;
                // pending 以 '\n' 结尾：先剥离行尾换行再判断。
                // 教训：此前直接对含尾 \n 的串做 matches(".*E/METASEC.*")，
                // 而 matches 要求全串匹配、正则的 . 不吃换行 → 永远失配，
                // 过滤完全失效（实测每次 /sign 都漏出一行）。
                int end = pending.length() - 1;                          // 去掉 '\n'
                if (end > 0 && pending.charAt(end - 1) == '\r') end--;   // 去掉 '\r'（若有）
                String line = pending.substring(0, end);
                pending.setLength(0);
                if (line.isEmpty()) continue;
                if (line.toUpperCase().startsWith("SLF4J")) continue;
                if (line.contains("E/METASEC")) { // contains 足够，不引入正则语义坑
                    METASEC_COUNT.incrementAndGet();
                    if (!showMetasec) continue; // 抑制整行
                }
                System.out.println("[signer] " + line);
            }
        } catch (IOException e) {
            // 子进程结束属正常路径，这里静默
        }
    }

    /** TCP 探活：连得上即视为就绪（根路径 404 属预期）。 */
    private static boolean probe(String url, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            // 用 URI 而非 new URL(String)：后者在 JDK 20+ 已标记废弃
            conn = (HttpURLConnection) java.net.URI.create(url).toURL().openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("GET");
            conn.getResponseCode();
            return true;
        } catch (IOException e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * 等待签名服务就绪。
     *
     * 关键：必须同时盯住子进程是否已退出。若端口被别的进程占用，Java 会抛
     * BindException 退出，而探活请求会打到那个「占位」的旧服务上，
     * 从而误判为就绪（实测踩过：端口被沙箱代理占用，仍报"签名服务就绪"）。
     */
    private static boolean waitReady(String base, int timeoutMs, Process proc,
                                     AtomicBoolean signStarting) {
        String url = base + "/grab";
        long deadline = System.currentTimeMillis() + timeoutMs;
        int dots = 0;
        while (System.currentTimeMillis() < deadline) {
            if (proc != null && !proc.isAlive()) {
                signStarting.set(false);
                return false; // 子进程已退出，不再空等
            }
            if (probe(url, 3000)) {
                signStarting.set(false);
                return true;
            }
            System.out.print("\r  等待签名服务就绪 "
                    + ".".repeat((dots++ % 3) + 1) + "   ");
            System.out.flush();
            try {
                TimeUnit.MILLISECONDS.sleep(900);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                signStarting.set(false);
                return false;
            }
        }
        System.out.print("\r");
        System.out.flush();
        signStarting.set(false);
        return false;
    }

    // ==================== Java 探测 ====================

    /** 探测到的 java 可执行文件。 */
    static final class JavaBin {
        final String bin;
        final String from;
        final Integer major;

        JavaBin(String bin, String from, Integer major) {
            this.bin = bin;
            this.from = from;
            this.major = major;
        }
    }

    /** 读 java 主版本号；读不到返回 null。 */
    static Integer javaMajor(String bin) {
        File exe = new File(bin).getAbsoluteFile();
        File home = exe.getParentFile() == null ? null : exe.getParentFile().getParentFile();

        // 1) 优先读 JRE 自带的 release 文件（Temurin 都有，无需执行进程）
        if (home != null) {
            Path rel = home.toPath().resolve("release");
            try {
                if (Files.exists(rel)) {
                    String txt = new String(Files.readAllBytes(rel), StandardCharsets.UTF_8);
                    java.util.regex.Matcher m =
                            java.util.regex.Pattern
                                    .compile("^JAVA_VERSION=\"?(\\d+)",
                                            java.util.regex.Pattern.MULTILINE)
                                    .matcher(txt);
                    if (m.find()) return Integer.parseInt(m.group(1));
                }
            } catch (Exception ignored) {
                // 无 release 文件则退回 -version
            }
        }
        // 2) 退回 `java -version`（输出形如 openjdk version "25.0.4.1" 2026-08-18）
        try {
            ProcessBuilder pb = new ProcessBuilder(bin, "-version");
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8);
            p.waitFor();
            java.util.regex.Matcher m =
                    java.util.regex.Pattern.compile("version \"(\\d+)").matcher(out);
            if (m.find()) return Integer.parseInt(m.group(1));
        } catch (Exception ignored) {
            // 忽略
        }
        return null;
    }

    /**
     * 找可用的 java：优先项目自带 JRE，其次 JAVA_HOME，最后系统 PATH。
     * 自带 JRE 优先于系统 PATH —— 避免用户机器上的旧 JDK（如 8/11）抢先被选中，
     * 导致 unidbg 在旧 JRE 上异常（签名头缺失或直接崩溃）。
     */
    static JavaBin findJava() {
        String exe = isWindows() ? "java.exe" : "java";

        Path bundled = bundledJavaBin(exe);
        if (bundled != null) {
            return new JavaBin(bundled.toString(), "项目自带 JRE", javaMajor(bundled.toString()));
        }

        String jh = Log.env("JAVA_HOME", null);
        if (jh != null) {
            Path j = Paths.get(jh, "bin", exe);
            if (Files.isExecutable(j)) {
                return new JavaBin(j.toString(), "JAVA_HOME", javaMajor(j.toString()));
            }
        }
        for (String p : pathDirs()) {
            Path j = Paths.get(p, exe);
            if (Files.isExecutable(j)) {
                return new JavaBin(j.toString(), "系统 PATH", javaMajor(j.toString()));
            }
        }
        return null;
    }

    /**
     * 项目自带 JRE 的 java 可执行文件。
     * 兼容两种放置：jre/bin/java.exe，以及解压多了一层的
     * jre/&lt;目录名&gt;/bin/java.exe（Temurin zip 常见）。
     */
    private static Path bundledJavaBin(String exe) {
        Path direct = BUNDLED_JRE.resolve("bin").resolve(exe);
        if (Files.isExecutable(direct)) return direct;
        if (!Files.isDirectory(BUNDLED_JRE)) return null;
        try (java.util.stream.Stream<Path> sub = Files.list(BUNDLED_JRE)) {
            return sub.filter(Files::isDirectory)
                    .map(d -> d.resolve("bin").resolve(exe))
                    .filter(Files::isExecutable)
                    .findFirst().orElse(null);
        } catch (IOException e) {
            return null;
        }
    }

    private static List<String> pathDirs() {
        List<String> out = new ArrayList<>();
        String path = Log.env("PATH", "");
        for (String s : path.split(File.pathSeparator)) {
            String t = s.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    /** 校验签名资产齐备，返回缺失清单。 */
    static List<String> checkAssets() {
        List<String> missing = new ArrayList<>();
        if (!Files.exists(JAR)) missing.add("缺少签名 JAR：signer/unidbg-sign.jar");
        for (String f : REQUIRED_SO) {
            if (!Files.exists(CAPTURE.resolve(f))) {
                missing.add("缺少 so：capture/fq_oversea/" + f);
            }
        }
        return missing;
    }

    // ==================== 杂项 ====================

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /** 停止子进程并汇总被抑制的告警数。 */
    static void shutdown(List<Process> children) {
        for (Process c : children) {
            if (c != null && c.isAlive()) c.destroy();
        }
        int n = METASEC_COUNT.get();
        if (n > 0) {
            Log.info("");
            Log.info("[signer] 已抑制 " + n
                    + " 条 METASEC \"SDK not init\" 告警（不影响签名，上游实测 code=0）");
            if (!Log.envBool("HG_SHOW_METASEC", false)) {
                Log.info("  如需查看原始告警：设置 HG_SHOW_METASEC=1");
            }
        }
    }
}
