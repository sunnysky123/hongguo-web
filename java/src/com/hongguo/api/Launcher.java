package com.hongguo.api;

import com.hongguo.api.util.Config;
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
 *   java -jar hongguo-api.jar --config           # 打印当前生效配置后退出
 *   java -jar hongguo-api.jar --selftest         # 跑自检
 *
 * 配置来源（优先级由高到低）：
 *   命令行参数 &gt; 系统属性 -Dxxx &gt; 环境变量 &gt; server/config/config.json &gt; 内置默认值
 *   日常改配置请编辑 server/config/config.json，环境变量仅用于临时覆盖。
 *
 * 环境变量（覆盖配置文件用，一般不需要设）：
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
        // 配置默认值来自 config.json（环境变量优先级更高，见 Config.str）
        int signPort = Config.num("signer.port", 9099);
        // 配置里显式关掉签名服务，等价于命令行 --no-sign
        boolean signDisabledByConfig = !Config.bool("signer.enabled", true);
        if (signDisabledByConfig) noSign = true;

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

        // --config：只打印生效配置，不启动任何服务
        for (String a : args) {
            if (a.equals("--config") || a.equals("--show-config")) {
                printConfig(signPort, noSign, signOnly);
                return;
            }
        }

        // --stop：按 jar 路径找到并停掉在跑的实例，然后退出。
        // 放在 Java 侧是因为目标与端口都来自 config.json —— 脚本要拿到
        // 它们就得先把JSON 解析一遍，等于把配置逻辑在 bat 里重写一份。
        for (String a : args) {
            if (a.equals("--stop")) {
                boolean killed = stopRunning();
                // 只在真的有实例被杀时才查端口：没找到进程的情况下
                // 端口必然是空的，查了也只是噪声。
                if (killed) reportPorts(Config.num("api.port", 8000), signPort);
                // 两种结果都算成功：「停掉了」和「本来就没在跑」都是
                // 幂等停止的正常结局。返回非 0 会让stop.bat 打出
                // "Service exited with code 1"，把一次正常操作报成失败。
                System.exit(0);
                return;
            }
        }

        // 尽早注册关闭钩子：必须在启动签名服务之前，
        // 否则启动过程中被 Ctrl-C 就会漏掉子进程清理。
        List<Process> children = new ArrayList<>();
        AtomicBoolean shuttingDown = new AtomicBoolean(false);
        registerShutdownHook(children, shuttingDown);

        int apiPort = Config.num("api.port", 8000);
        String bindHost = Config.str("api.host", "127.0.0.1");
        String jvmXmx = Config.str("signer.jvm_xmx", "512m");
        int readyTimeout = Config.num("signer.ready_timeout_ms", 90000);
        String externalSign = Config.str("signer.server", "");

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

            // 签名服务固定绑回环地址：它只供本机 API 调用，
            // 不应跟随api.host 变成对外监听，否则外部流量会打到签名接口上。
            String signBindHost = "127.0.0.1";
            signBase = "http://" + signBindHost + ":" + signPort;
            signStarting.set(true);
            Process proc = startSignService(java.bin, jvmXmx, signPort, signBindHost);
            // 登记到子进程列表：Ctrl-C 时由关闭钩子统一收编，避免端口残留
            if (proc != null) children.add(proc);

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
                shutdown(children);
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
            // 必须阻塞：否则 main 返回后只剩非 daemon 线程撑着 JVM，
            // 关闭钩子不会触发，签名子进程也不会被收编。
            awaitShutdown(shuttingDown);
            shutdown(children);
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
        // 不再重复打印服务信息：Server.start() 已输出地址、签名后端与上游 host，
        // 这里只补一行停止提示，避免同一批信息在控制台出现两遍。
        Log.info("按 Ctrl-C 停止");

        // 浏览器交给 Java 侧开：launcher.open_browser 是配置项，
        // 启动脚本只负责把 JVM 拉起来，不参与任何编排。
        if (Config.bool("launcher.open_browser", true)) {
            openBrowserWhenReady(apiPort);
        }

        // 同上：阻塞等待 Ctrl-C，由关闭钩子负责清理签名子进程。
        // 没有这一步，main 返回后 JVM 不会退出，钩子也就不会跑。
        awaitShutdown(shuttingDown);
        shutdown(children);
    }

    /**
     * 服务就绪后打开浏览器。
     *
     * 之所以放在 Java 而不是 bat：host/port 都由 config.json 决定，
     * 脚本要拿到它们就得先把配置读一遍并回传，等于把配置解析
     * 逻辑在 bat 里重写一份。这里直接用刚启动的端口即可。
     *
     * 监听 0.0.0.0 时必须改用 127.0.0.1：0.0.0.0 是"监听所有网卡"的
     * 通配地址，浏览器拿它当目标去连会直接失败（与 bat 里原先
     * HG_BROWSER_HOST 的处理一致）。
     *
     * 单独起线程轮询 /health：Server.start() 返回时端口已经在听，
     * 但前端页面还要等签名服务与密钥就绪才能真正可用，过早打开
     * 会看到空白页。超时 90s 后放弃，不阻塞主流程。
     */
    private static void openBrowserWhenReady(int apiPort) {
        final String host = browserHost();
        final String url = "http://" + host + ":" + apiPort + "/ui";
        final String health = "http://127.0.0.1:" + apiPort + "/health";
        Log.info("就绪后自动打开 " + url);
        Thread t = new Thread(() -> {
            long deadline = System.currentTimeMillis() + 90_000L;
            while (System.currentTimeMillis() < deadline) {
                if (probe(health, 2000)) {
                    browse(url);
                    return;
                }
                try {
                    TimeUnit.MILLISECONDS.sleep(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            Log.warn("等待服务就绪超时，未自动打开浏览器，请手动访问 " + url);
        }, "hg-open-browser");
        t.setDaemon(true);
        t.start();
    }

    /** 浏览器可连接的地址：0.0.0.0 / :: 是监听通配符，不能作为连接目标。 */
    private static String browserHost() {
        String h = Config.str("api.host", "127.0.0.1");
        if (h.isEmpty() || h.equals("0.0.0.0") || h.equals("::")) return "127.0.0.1";
        return h;
    }

    /**
     * 调起系统默认浏览器。
     *
     * 优先用 Desktop.browse()，它在 Windows 上走 ShellExecute，
     * 不依赖 rundll32.exe 这个非公开入口。失败时静默：打不开浏览器
     * 不影响服务本身，用户手动访问即可。
     */
    private static void browse(String url) {
        try {
            if (java.awt.Desktop.isDesktopSupported()
                    && java.awt.Desktop.getDesktop().isSupported(java.awt.Desktop.Action.BROWSE)) {
                java.awt.Desktop.getDesktop().browse(java.net.URI.create(url));
                return;
            }
        } catch (Throwable ignored) {
            // 落到下面的命令行方案
        }
        try {
            new ProcessBuilder(isWindows() ? "rundll32" : "xdg-open", "url.dll,FileProtocolHandler", url)
                    .start();
        } catch (IOException ignored) {
            // 无图形环境（如 WSL/容器）：提示手动访问即可
            Log.warn("无法自动打开浏览器，请手动访问 " + url);
        }
    }

    /**
     * 注册 JVM 关闭钩子：Ctrl-C / SIGTERM 时收编所有子进程。
     *
     * 为什么必须注册：签名服务是本进程 fork 出来的子进程，
     * 父进程退出时不会自动带走它——它会被 init 收养并继续持有 9099 端口，
     * 表现为「Ctrl-C 后端口仍被占用、下次启动报端口被占用」。
     *
     * 注意注册时机必须早于任何 Process 的创建。
     */
    private static void registerShutdownHook(List<Process> children, AtomicBoolean shuttingDown) {
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            // 幂等：SIGINT 与 SIGTERM 可能同时到达，避免重复收编
            if (!shuttingDown.compareAndSet(false, true)) return;
            shutdown(children);
        }, "hg-shutdown"));
    }

    /**
     * 阻塞主线程直到关闭钩子开始执行。
     *
     * HttpServer 的工作线程与转发子进程输出的线程都是非 daemon，
     * main 返回后 JVM 不会自然退出；这里用锁等待把控制权交给关闭钩子，
     * 保证 Ctrl-C 之后一定能走到子进程清理。
     */
    private static void awaitShutdown(AtomicBoolean shuttingDown) {
        Log.info("");
        Log.info("服务运行中，按 Ctrl-C 停止并清理签名服务...");
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        // 关闭钩子开始执行时唤醒主线程，让它去完成子进程收编
        Runtime.getRuntime().addShutdownHook(new Thread(latch::countDown, "hg-shutdown-wait"));
        try {
            // 等钩子置位或用户直接关窗（最长等 1 小时兜底）
            while (!shuttingDown.get()) {
                if (latch.await(1, java.util.concurrent.TimeUnit.SECONDS)) break;
                if (shuttingDown.get()) break;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 启动横幅。只打印纯ASCII 的系统信息。
     *
     * 这里刻意不输出中文标题：控制台代码页与 JVM 编码一旦不一致，
     * 中文会变成「红红果果」式的重复乱码，而纯 ASCII 在任何代码页下
     * 都正常。需要中文标识时可看浏览器标题栏或日志文件。
     */
    private static void banner() {
        Log.info("");
        Log.info("  Hongguo Short Drama - Web Launcher (Java Edition)");
        Log.info("  " + System.getProperty("os.name") + " "
                + System.getProperty("os.arch") + "  Java "
                + System.getProperty("java.version"));
        Log.info("");
    }

    /**
     * 打印当前生效配置（{@code --config}）。
     *
     * 供用户确认「我改的配置到底生效没有」——排查配置问题时，
     * 比起逐层追问日志，直接看这一段最快。
     */
    private static void printConfig(int signPort, boolean noSign, boolean signOnly) {
        System.out.println();
        System.out.println("  生效配置（命令行 > 环境变量 > 配置文件 > 默认值）");
        System.out.println("  " + "-".repeat(56));
        String src = Config.loadedFrom();
        System.out.printf("    配置文件      : %s%n",
                src == null ? "未找到（使用内置默认值）" : src);
        System.out.printf("    api.host       : %s%n", Config.str("api.host", "127.0.0.1"));
        System.out.printf("    api.port       : %d%n", Config.num("api.port", 8000));
        System.out.printf("    signer.enabled : %s%n", Config.bool("signer.enabled", true));
        System.out.printf("    signer.port    : %d%n", signPort);
        String sv = Config.str("signer.server", "");
        System.out.printf("    signer.server  : %s%n", sv.isEmpty() ? "（本机自启）" : sv);
        System.out.printf("    signer.jvm_xmx : %s%n", Config.str("signer.jvm_xmx", "512m"));
        System.out.printf("    ready_timeout  : %d ms%n",
                Config.num("signer.ready_timeout_ms", 90000));
        System.out.printf("    transcode      : %s%n", Config.bool("runtime.transcode", false));
        System.out.printf("    show_metasec   : %s%n", Config.bool("runtime.show_metasec", false));
        System.out.printf("    运行模式       : %s%n",
                signOnly ? "仅签名服务" : (noSign ? "仅 API（免签）" : "完整"));
        System.out.println("  " + "-".repeat(56));
        System.out.println();
    }

    // ==================== 停止在跑的实例 ====================

    /**
     * 停掉本机在跑的服务进程（{@code --stop}）。
     *
     * <p>按 jar 路径匹配，而不是按端口：端口会随 config.json 变，
     * 而 jar 路径是稳定的。
     *
     * <p><b>两个条件缺一不可</b>：进程本体必须是 JVM 或 Node，
     * <i>并且</i>命令行里出现目标文件名。只看后者的教训很实际：
     * 任何提到这个文件名的进程都会被误杀——shell 里那句
     * {@code java -jar .../hongguo-api.jar --stop}、编辑器标签页、
     * 甚至一次 grep，都会命中，而它们与本服务毫无关系。
     * 加上进程类型这一层之后，能通过的只剩下真正在跑的实例。
     *
     * <p>兼容迁移前的 Node 进程：机器上可能还留着老版本留下的
     * {@code launcher.js} / {@code server.js}。
     *
     * @return 至少停掉一个进程时返回 true
     */
    private static boolean stopRunning() {
        String[] names = {"hongguo-api.jar", "unidbg-sign.jar",
                "launcher.js", "server.js"};
        long self = ProcessHandle.current().pid();
        List<ProcessHandle> targets = new ArrayList<>();
        ProcessHandle.allProcesses()
                .forEach(h -> {
                    if (h.pid() == self) return;          // 本进程（--stop 自己）
                    if (!isRuntimeProcess(h)) return;      // 必须是 JVM / Node
                    String cmd = commandLineOf(h);
                    if (cmd == null) return;
                    // 排除"正在执行停止"的进程（可能是本进程，也可能是
                    // 用户同时在另一个窗口敲了 stop）。一次停止不该打断
                    // 另一次停止：两个 --stop 并发时若互杀，双方都会被
                    // SIGTERM 打断，调用方拿到 128+15 的退出码，
                    // 看起来像失败，其实只是撞车。
                    if (cmd.contains("--stop")) return;
                    for (String n : names) {
                        if (cmd.contains(n)) { targets.add(h); return; }
                    }
                });

        if (targets.isEmpty()) {
            Log.info("没有找到正在运行的签名/API 进程。");
            return false;
        }
        for (ProcessHandle h : targets) {
            String cmd = commandLineOf(h);
            String tag = cmd != null && cmd.contains("unidbg-sign.jar") ? "signer" : "api";
            System.out.println("   停止 [" + tag + "] PID " + h.pid());
            kill(h);
        }
        // 给操作系统一点时间回收 socket，否则紧接着的端口检查仍会报占用
        try {
            Thread.sleep(1200);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return true;
    }

    /**
     * 进程本体是否是 Java 运行时或 Node。
     *
     * <p>这正是"进程类型"这一层需要的判据：凡是想杀的，都是这两个
     * 运行时起的；而误伤对象（shell、编辑器、grep）都不是。
     *
     * <p><b>必须截到基名再比</b>。{@code command()} 在 Linux 上返回
     * 完整路径（实测 {@code /root/.sdkman/.../bin/java}），在 Windows 上
     * 才是 {@code java.exe}。直接拿返回值比"java"会永远失配，
     * 结果是真实例一个也找不到。
     *
     * <p>读不到名字时返回 false（宁可不杀，不误杀）。
     */
    private static boolean isRuntimeProcess(ProcessHandle h) {
        String exe;
        try {
            // command() 是可执行文件路径（或基名），比 commandLine() 短得多，
            // 且不受"命令行是否可读"的权限限制
            exe = h.info().command().orElse("");
        } catch (Throwable t) {
            return false;
        }
        int cut = Math.max(exe.lastIndexOf('/'), exe.lastIndexOf('\\'));
        if (cut >= 0) exe = exe.substring(cut + 1);
        String n = exe.toLowerCase();
        if (n.endsWith(".exe")) n = n.substring(0, n.length() - 4);
        return n.equals("java") || n.equals("javaw") || n.equals("node");
    }

    /** 读进程命令行；无权限时返回 null。 */
    private static String commandLineOf(ProcessHandle h) {
        try {
            return h.info().commandLine().orElse(null);
        } catch (Throwable t) {
            // 安全策略或权限不足：跳过该进程
            return null;
        }
    }

    /**
     * 结束一个进程树：先 SIGTERM 给它走正常退出流程，仍在世就强杀。
     *
     * <p>只对直接子进程调 destroy() 不够：unidbg 可能再 fork 出孙进程，
     * 强杀父进程后孙进程会被 init 收养并继续持有端口，表现为
     * 「端口仍被占用」。因此先收编子孙再收编自己。
     */
    private static void kill(ProcessHandle h) {
        List<ProcessHandle> all = new ArrayList<>();
        try {
            h.descendants().forEach(all::add);
        } catch (Throwable ignored) {
            // 读不到子孙就只杀自己
        }
        all.add(h);
        for (ProcessHandle d : all) {
            if (!d.isAlive()) continue;
            try {
                d.destroy();
                d.onExit().get(2, TimeUnit.SECONDS);
            } catch (Exception ignored) {
                // 超时或不支持：落到强杀
            }
            if (d.isAlive()) {
                try {
                    d.destroyForcibly();
                    d.onExit().get(1, TimeUnit.SECONDS);
                } catch (Exception ignored) {
                    // 已经退出
                }
            }
        }
    }

    /**
     * 停掉在跑的实例后，顺带报告配置里的端口是否仍被占用。
     *
     * <p>停掉之后仍占用通常意味着有另一个实例在跑，或者杀进程需要
     * 管理员权限 —— 值得说一句，否则用户会以为脚本没生效。
     */
    private static void reportPorts(int apiPort, int signPort) {
        for (int port : new int[]{apiPort, signPort}) {
            if (netstatBusy(port)) {
                Log.warn("端口 " + port + " 仍被占用。若有其他实例在跑属正常；"
                        + "否则可尝试以管理员身份运行，或查看：" + portOwner(port));
            }
        }
    }

    /** 该端口是否处于 LISTENING。 */
    private static boolean netstatBusy(int port) {
        try {
            ProcessBuilder pb = new ProcessBuilder("netstat", "-ano");
            pb.redirectErrorStream(true);
            Process p = pb.start();
            String out = new String(readAll(p.getInputStream()), StandardCharsets.UTF_8);
            p.waitFor();
            for (String line : out.split("\r?\n")) {
                if (line.contains("LISTENING")
                        && line.matches(".*:\\s*" + port + "\\s+\\d+\\s+.*")) {
                    return true;
                }
            }
        } catch (Exception ignored) {
            // netstat 不可用时不阻断停止流程
        }
        return false;
    }

    private static String portOwner(int port) {
        return "netstat -ano | findstr " + port;
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
    private static Process startSignService(String javaBin, String jvmXmx, int signPort,
            String signBindHost) {
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
        // 签名服务只供本机 API 调用，固定绑定回环地址。
        //
        // 必须在环境里显式覆盖：Pq 不调用 environment() 时子进程会继承父进程
        // 全部环境变量，而父进程的 BIND_HOST 来自启动脚本的 api.host 配置。
        // 若用户在配置里把 api.host 设成 0.0.0.0 / 局域网 IP 甚至主机名，
        // 签名服务会拿它去绑端口，主机名在容器/部分网络环境下解析不了，
        // 直接抛 Unresolved addressException，服务起不来。
        pb.environment().put("BIND_HOST", signBindHost);
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
        boolean showMetasec = Config.bool("runtime.show_metasec", false);
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

    /**
     * 停止子进程并汇总被抑制的告警数。
     *
     * 三段式收编，保证端口一定释放：
     *   1. destroy()  发送 SIGTERM，让子进程走正常的 JVM 退出流程；
     *   2. 限时等待   避免子进程卡死不拖住主进程退出；
     *   3. destroyForcibly() 仍在世就 SIGKILL 强杀。
     *
     * 只调 destroy() 是不够的：若子进程内部卡住（如 unidbg 正在签名），
     * SIGTERM 可能被忽略，端口会一直留着。
     */
    static void shutdown(List<Process> children) {
        for (Process c : children) {
            if (c == null) continue;
            // 先收编子孙：unidbg 可能再 fork 出孙进程，
            // 只杀直接子进程会留下持有端口的孤儿。
            //
            // descendants() 在个别平台/权限下可能抛异常，而这里跑在关闭钩子里，
            // 一旦抛出就会中断整个循环，后面的子进程一个都收编不到 ——
            // 那正好复现「端口残留」这个 bug 本身。所以必须隔离。
            java.util.List<java.lang.ProcessHandle> descendants;
            try {
                descendants = c.descendants().collect(java.util.stream.Collectors.toList());
            } catch (Throwable t) {
                descendants = java.util.Collections.emptyList();
            }
            for (java.lang.ProcessHandle d : descendants) {
                if (!d.isAlive()) continue;
                try {
                    // SIGTERM 让子进程走正常的 JVM 退出流程
                    d.destroy();
                    // onExit().get() 返回 Process 对象，非 boolean：
                    // 用返回值是否为 null 判断是否等到退出结果
                    if (d.onExit().get(2, java.util.concurrent.TimeUnit.SECONDS) == null) {
                        d.destroyForcibly();
                    }
                } catch (java.util.concurrent.TimeoutException te) {
                    // 超时仍在世：强杀
                    if (d.isAlive()) d.destroyForcibly();
                } catch (Exception ignored) {
                    // 已退出，或平台不支持对应操作
                    try {
                        if (d.isAlive()) d.destroyForcibly();
                    } catch (Exception ignored2) {
                        // 已退出
                    }
                }
            }

            if (!c.isAlive()) continue;
            try {
                c.destroy();
                boolean exited = false;
                try {
                    exited = c.onExit().get(3, java.util.concurrent.TimeUnit.SECONDS) != null;
                } catch (Exception ignored) {
                    // 超时或中断：走强杀分支
                }
                if (!exited && c.isAlive()) {
                    c.destroyForcibly();
                    // 再给一点时间让内核回收 socket
                    c.onExit().get(2, java.util.concurrent.TimeUnit.SECONDS);
                }
            } catch (Throwable t) {
                // 兜底：无论如何都不能让子进程活下来占着端口
                try { c.destroyForcibly(); } catch (Throwable ignored2) { }
            }
        }

        int n = METASEC_COUNT.get();
        if (n > 0) {
            Log.info("");
            Log.info("[signer] 已抑制 " + n
                    + " 条 METASEC \"SDK not init\" 告警（不影响签名，上游实测 code=0）");
            if (!Config.bool("runtime.show_metasec", false)) {
                Log.info("  如需查看原始告警：设置 HG_SHOW_METASEC=1");
            }
        }
    }
}
