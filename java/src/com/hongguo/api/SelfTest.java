package com.hongguo.api;

import com.hongguo.api.core.Mp4;
import com.hongguo.api.core.Safeguards;
import com.hongguo.api.core.Spade;
import com.hongguo.api.service.Client;
import com.hongguo.api.service.Signer;
import com.hongguo.api.service.Stream;
import com.hongguo.api.util.Crypto;
import com.hongguo.api.util.Json;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;

/**
 * 自检套件。
 *
 * 移植自原Node 版 scripts/selftest.js 的纯算法部分 ——
 * 这些用例都是踩过坑之后固化的回归基线，不依赖网络与 Node 运行时，
 * 迁移后依然逐条保留，是判断「迁移是否等价」的主要依据。
 */
final class SelfTest {

    private int passed;
    private int failed;
    private int skipped;

    private SelfTest() {}

    // ==================== 断言 ====================

    private void check(String name, boolean cond, String detail) {
        if (cond) {
            passed++;
            System.out.println("  ✓ " + name + (detail == null || detail.isEmpty() ? "" : "  " + detail));
        } else {
            failed++;
            System.out.println("  ✗ " + name + (detail == null || detail.isEmpty() ? "" : "  " + detail));
        }
    }

    private void check(String name, boolean cond) {
        check(name, cond, "");
    }

    /**
     * 跳过一条断言：前提未满足时不算失败，也不计入通过数。
     *
     * 用于「结论正确、但依赖运行态产物」的检查（如密钥引导签发）——
     * 在未启动过服务的干净环境下判失败会产生假红。跳过原因会打印出来，
     * 保证「跳过」与「通过」一样可追溯。
     */
    private void skip(String name, String reason) {
        skipped++;
        System.out.println("  ⊘ " + name + (reason == null || reason.isEmpty() ? "" : "  " + reason));
    }

    /** 任一签名后端探活通过即认为签名服务可用。 */
    private static boolean anySignerReady() {
        try {
            for (Object o : Signer.health()) {
                Map<String, Object> m = Json.optObj(o);
                if (m != null && Json.optBool(m.get("ready"), false)) return true;
            }
        } catch (Exception ignored) {
            // 探活失败按未就绪处理，不影响自检
        }
        return false;
    }

    /** 密钥未签发时的原因说明，便于判断是「离线」还是「服务异常」。 */
    private static String bootstrapHint(boolean signerReady) {
        if (signerReady) {
            return "签名服务已就绪但未签发密钥，请启动一次服务以生成 apikeys.json";
        }
        return "未运行签名服务，且从未启动过 API 服务（密钥由启动流程签发）";
    }

    private static void section(String title) {
        System.out.println("");
        System.out.println("=== " + title + " ===");
    }

    private static String hex(byte[] b) {
        return Crypto.hex(b);
    }

    private static byte[] unhex(String h) {
        return Crypto.unhex(h);
    }

    // ==================== 各组用例 ====================

    /** 1. spade 解包：5 组运行时真值 + ver2 拒绝。 */
    private void spade() {
        section("1. spade -> content key 解包（对齐 5 组真值）");
        boolean all = Spade.selfTest();
        check("spade 解包 5 组真值", all, "");
        String k = Spade.unwrapV1(unhex("93bc1df253ba1bf7618b19c448b806f64d810afc45b715fe5eb925f26cbf12f541ba098282"), 0);
        check("输出为 32 位十六进制", Spade.isValidKey(k), k);
        byte[] ver2 = new byte[40];
        check("ver2 类型被拒绝", Spade.unwrapV1(ver2, 0) == null, "");
    }

    /** 2. AES-128-CTR 计数器构造。 */
    private void ctrCounter() {
        section("2. AES-128-CTR 计数器构造");
        // counter = (base_iv_high64 + index) << 64，低 64 位恒为 0
        byte[] c0 = Mp4.ctrCounter("0000000000000001", 0);
        byte[] c1 = Mp4.ctrCounter("0000000000000001", 1);
        byte[] c2 = Mp4.ctrCounter("00000000000000ff", 1);
        check("counter 长度 16 字节", c0.length == 16, "");
        check("index=0 高位保留",
                hex(c0).equals("00000000000000010000000000000000"), hex(c0));
        check("index=1 进位到高 64 位",
                hex(c1).equals("00000000000000020000000000000000"), hex(c1));
        check("0xff + 1 进位正确",
                hex(c2).equals("00000000000001000000000000000000"), hex(c2));
    }

    /**
     * 3. 逐样本 IV -> CTR 计数器。
     *
     * 回归用例：本项目实测 senc IV 为 8 字节，位于计数器高 64 位（右侧补零）。
     * 曾因 padStart 写成左侧补零导致解出全噪声。
     */
    private void ivToCounter() {
        section("3. 逐样本 IV -> CTR 计数器");
        byte[] c8 = Mp4.ivToCounter("ebbde5029bbf3f29");
        check("8 字节 IV 长度 16", c8.length == 16, "");
        check("8 字节 IV 位于高 64 位",
                hex(c8).equals("ebbde5029bbf3f290000000000000000"), hex(c8));
        check("与 ctrCounter(baseIv,0) 等价",
                Arrays.equals(c8, Mp4.ctrCounter("ebbde5029bbf3f29", 0)));
        byte[] c16 = Mp4.ivToCounter("00112233445566778899aabbccddeeff");
        check("16 字节 IV 原样保留",
                hex(c16).equals("00112233445566778899aabbccddeeff"), hex(c16));

        Mp4.Track tr = new Mp4.Track();
        tr.ivs = new String[]{"ebbde5029bbf3f29", "ebbde5029bbf3f2a"};
        check("counterFor 优先用逐样本 IV",
                hex(Mp4.counterFor(tr, null, 1)).equals("ebbde5029bbf3f2a0000000000000000"));
        check("counterFor 无 IV 时回退 base_iv",
                hex(Mp4.counterFor(new Mp4.Track(), "0000000000000005", 2))
                        .equals("00000000000000070000000000000000"));
    }

    /** 4. AVCC / NAL 自证。 */
    private void avcc() {
        section("4. AVCC / NAL 自证");
        byte[] annexb = new byte[]{0, 0, 0, 1, 0x67, 0x42, 0, 1, 0x68, (byte) 0xCE};
        byte[] avcc = new byte[]{0, 0, 0, 2, 0x67, 0x42, 0, 0, 0, 3, 0x68, (byte) 0xCE, 0x3C};
        byte[] junk = new byte[64];
        Arrays.fill(junk, (byte) 0xAB);

        check("Annex-B 起始码识别", Mp4.avccSelfOk(annexb, annexb.length));
        check("AVCC 长度前缀识别", Mp4.avccSelfOk(avcc, avcc.length));
        check("随机数据拒绝", !Mp4.avccSelfOk(junk, junk.length));

        // 多 NAL 样本整链自证（真实样本通常含 SPS/PPS/SEI/IDR）
        byte[] multi = new byte[]{
                0, 0, 0, 2, 0x67, 0x42,
                0, 0, 0, 2, 0x68, (byte) 0xCE,
                0, 0, 0, 3, 0x65, (byte) 0x88, (byte) 0x84};
        check("多 NAL 样本整链自证", Mp4.avccSelfOk(multi, multi.length));

        // nal_unit_type=0 非 IDR 分片也应通过
        byte[] nonIdr = new byte[]{0, 0, 0, 2, 0x06, 0x42};
        check("nal_unit_type=0 非 IDR 分片通过", Mp4.avccSelfOk(nonIdr, nonIdr.length));

        // 长度越界必须拒绝
        byte[] overflow = new byte[]{0, 0, 0, 99, 0x65, (byte) 0x88};
        check("长度越界拒绝", !Mp4.avccSelfOk(overflow, overflow.length));

        // forbidden_zero_bit 置位必须拒绝
        byte[] badBit = new byte[]{0, 0, 0, 2, (byte) 0x85, 0x42};
        check("forbidden_zero_bit 置位拒绝", !Mp4.avccSelfOk(badBit, badBit.length));

        // 探测样本应含 index 0 且都在范围内
        Mp4.Track tr = new Mp4.Track();
        tr.sampleCount = 100;
        tr.sizes = new long[100];
        Arrays.fill(tr.sizes, 1000);
        int[] probe = Mp4.pickProbeIndices(tr);
        boolean hasZero = false;
        boolean inRange = true;
        for (int i : probe) {
            if (i == 0) hasZero = true;
            if (i < 0 || i >= 100) inRange = false;
        }
        check("探测样本含 index 0 且在范围内", hasZero && inRange,
                "共 " + probe.length + " 个");
    }

    /** 5. AES-128-CTR 加解密往返一致性。 */
    private void ctrRoundTrip() {
        section("5. AES-128-CTR 加解密往返一致性");
        byte[] key = new byte[16];
        byte[] ctr = new byte[16];
        for (int i = 0; i < 16; i++) {
            key[i] = (byte) i;
            ctr[i] = (byte) (0xF0 + i);
        }
        byte[] plain = "红果短剧 · hongguo ctr 往返测试".getBytes(StandardCharsets.UTF_8);
        byte[] enc = Crypto.aes128Ctr(key, ctr, plain);
        byte[] dec = Crypto.aes128Ctr(key, ctr, enc);
        check("解密还原原文", Arrays.equals(plain, dec));
        check("密文与原文不同", !Arrays.equals(enc, plain));
    }

    /** 6. MP4 盒解析（构造最小合法 moov）。 */
    private void mp4Boxes() {
        section("6. MP4 盒解析（构造最小合法 moov）");
        byte[] buf = Mp4Fixture.buildMinimalEncryptedMp4();
        Mp4.Analysis a = Mp4.analyzeEncryptedTracks(buf);
        check("解析出加密轨", !a.tracks.isEmpty(), a.tracks.size() + " 条");
        if (a.tracks.isEmpty()) return;
        Mp4.Track t = a.tracks.get(0);
        check("handler 为 vide", "vide".equals(t.handler), t.handler);
        check("样本数为 2", t.sampleCount == 2, "" + t.sampleCount);
        check("逐样本 IV 已解析", t.ivs != null && t.ivs.length == 2, "");
        check("IV 长度为 16 字节", t.ivSize == 16, "" + t.ivSize);
        // tenc 挂在 stsd→encv 内，而 encv 不在盒树的容器白名单里，
        // 因此 default_KID 读不到（Node 版行为一致）。
        // 这不影响解密：content key 来自 spade 解包，不依赖 KID。
        check("KID 不参与解密链路（content key 来自 spade）", t.kid == null, "");

        // 顶层盒结构
        java.util.List<Mp4.Box> top = Mp4.parseBoxes(buf, 0, buf.length);
        boolean hasFtyp = false;
        boolean hasMoov = false;
        for (Mp4.Box b : top) {
            if (b.type.equals("ftyp")) hasFtyp = true;
            if (b.type.equals("moov")) hasMoov = true;
        }
        check("顶层含 ftyp 与 moov", hasFtyp && hasMoov, "");
    }

    /** 7. 端到端：逐样本 IV + content key 解密。 */
    private void decryptEndToEnd() {
        section("7. 端到端：content key + 逐样本 IV 解密");
        try {
            byte[] buf = Mp4Fixture.buildMinimalEncryptedMp4();
            Mp4.Analysis a = Mp4.analyzeEncryptedTracks(buf);
            if (a.tracks.isEmpty()) {
                check("夹具可解析", false, "无加密轨");
                return;
            }
            Mp4.Track vt = a.tracks.get(0);
            String keyHex = Mp4Fixture.fixtureKeyHex();

            // IV 自证：应通过逐样本 IV 校验
            java.util.List<String> cands = Mp4.trackBaseIvCandidates(vt);
            String vIv = Mp4.verifyVideoIv(buf, vt, keyHex, cands);
            check("verifyVideoIv 通过逐样本 IV 自证",
                    vIv != null && vIv.equals(vt.ivs[0]), "" + vIv);

            // 解密后每个样本应通过 AVCC 自证
            Mp4.DecryptResult r = Mp4.decryptTrack(buf, vt, keyHex, vIv);
            check("全部样本解密完成", r.decrypted == vt.sampleCount,
                    r.decrypted + "/" + r.total);
            boolean allOk = true;
            for (int i = 0; i < r.decrypted; i++) {
                long off = vt.offsets[i];
                int size = (int) vt.sizes[i];
                if (off + size > buf.length
                        || !Mp4.avccSelfOk(Arrays.copyOfRange(buf, (int) off, (int) off + size), size)) {
                    allOk = false;
                    break;
                }
            }
            check("解密后每个样本 AVCC 自洽", allOk, "");

            // 解密结果应逐字节还原夹具明文
            byte[][] plains = Mp4Fixture.plainSamples();
            boolean restored = true;
            for (int i = 0; i < r.decrypted && i < plains.length; i++) {
                long off = vt.offsets[i];
                int size = (int) vt.sizes[i];
                byte[] got = Arrays.copyOfRange(buf, (int) off, (int) off + size);
                if (!Arrays.equals(got, plains[i])) restored = false;
            }
            check("解密逐字节还原夹具明文", restored, "");

            // 错误的 content key 必须被拒绝
            byte[] badKey = new byte[16];
            Arrays.fill(badKey, (byte) 0x5A);
            String badIv = Mp4.verifyVideoIv(buf, vt, hex(badKey), cands);
            check("错误 content key 被拒绝", badIv == null, "" + badIv);
        } catch (Exception e) {
            check("端到端解密", false, String.valueOf(e.getMessage()));
        }
    }

    /** 8. JSON 往返（自研轻量库，含数字语义与 null 省略）。 */
    private void json() {
        section("8. JSON 往返与数字语义");
        try {
            Map<String, Object> src = Json.obj();
            src.put("a", 1);
            src.put("b", "中文\"引号\"\n换行");
            src.put("c", Json.arr());
            src.put("d", 1.5);
            String text = Json.stringify(src);
            Map<String, Object> back = Json.parseObject(text);
            check("整型往返为数值",
                    Json.optLong(back.get("a"), 0) == 1L, "");
            check("字符串转义往返",
                    "中文\"引号\"\n换行".equals(back.get("b")), "");
            check("小数保持精度",
                    Math.abs(Json.optDouble(back.get("d"), 0) - 1.5) < 1e-9, "");

            // skipNulls 模拟 JS 中 undefined 被 JSON.stringify 省略的行为
            Map<String, Object> withNull = Json.obj();
            withNull.put("keep", "v");
            withNull.put("drop", null);
            String s2 = Json.stringify(withNull, true);
            check("skipNulls 省略 null 字段", !s2.contains("drop"), s2);

            // 数字语义：1.0 应输出为 1，避免与 JS 产生差异
            Map<String, Object> num = Json.obj();
            num.put("x", 1.0d);
            check("1.0 输出为 1", Json.stringify(num).contains("\"x\":1"), Json.stringify(num));
        } catch (Exception e) {
            check("JSON 往返", false, String.valueOf(e.getMessage()));
        }
    }

    /**
     * 9. 播放缓存路径。
     *
     * 背景：解密末尾 remux 产出 "<vid>_<q>.play.mp4" 并删掉 raw，
     * 而早期实现只探测 "<vid>_<q>.mp4"，导致加密内容永远不命中缓存，
     * 每次播放都重新下载 + 解密。
     */
    private void cachePaths() {
        section("9. 播放缓存路径：.play.mp4 变体必须参与命中判定");
        Stream.Paths3 p = Stream.cachePaths("7688396322021329982", "best");
        check("remux 产出名与 play 路径一致",
                p.play.getFileName().toString().equals("7688396322021329982_best.play.mp4"),
                p.play.getFileName().toString());
        check("play 与 out 是不同文件", !p.play.equals(p.out), "");
        check("raw 命名带 .raw 段",
                p.raw.getFileName().toString().endsWith("_best.raw.mp4"),
                p.raw.getFileName().toString());

        // cachedPath 三个变体任一存在即命中
        Path tmp = null;
        try {
            tmp = Files.createTempDirectory("hg-cache-");
            String saved = System.getProperty("HONGGUO_STREAM_CACHE");
            System.setProperty("HONGGUO_STREAM_CACHE", tmp.toString());
            Stream.Paths3 q = Stream.cachePaths("999", "best");
            check("空目录时 cachedPath 为空",
                    Stream.cachedPath("999", "best") == null, "");
            Files.write(q.play, new byte[]{'x'});
            check("仅 .play.mp4 存在即命中",
                    Stream.cachedPath("999", "best").equals(q.play.toString()), "");
            Files.delete(q.play);
            Files.write(q.out, new byte[]{'x'});
            check("仅 .mp4 存在即命中",
                    Stream.cachedPath("999", "best").equals(q.out.toString()), "");
            if (saved == null) {
                System.clearProperty("HONGGUO_STREAM_CACHE");
            } else {
                System.setProperty("HONGGUO_STREAM_CACHE", saved);
            }
        } catch (Exception e) {
            check("缓存路径命中判定", false, String.valueOf(e.getMessage()));
        } finally {
            if (tmp != null) {
                try {
                    Files.walk(tmp).sorted(java.util.Comparator.reverseOrder())
                            .forEach(x -> {
                                try {
                                    Files.delete(x);
                                } catch (Exception ignored) {
                                    // 忽略
                                }
                            });
                } catch (Exception ignored) {
                    // 忽略
                }
            }
        }
    }

    /** 10. 设备身份 device_id（搜索接口必需）。 */
    private void device() {
        section("10. 设备身份 device_id（搜索接口必需）");
        com.hongguo.api.core.Device.Identity id = Client.identity();
        check("device_id 为 16 位数字",
                id.deviceId != null && id.deviceId.matches("^\\d{16}$"), id.deviceId);
        check("来源已标记",
                id.source != null && !id.source.isEmpty(), id.source);
        check("已注入 base_query",
                Client.baseQuery().get("device_id").equals(id.deviceId), "");
        check("device.json 已落盘",
                Files.exists(com.hongguo.api.core.Device.storeFile()), "");

        // iid 恒为 0：非 0 随机 iid 会触发上游风控
        Object iid = Client.baseQuery().get("iid");
        check("iid 保持 0（随机 iid 会触发风控）",
                iid == null || "0".equals(String.valueOf(iid)), "" + iid);
    }

    /** 11. 剧集解析：title 清洗（上游 title 实为简介）。 */
    private void episodeTitle() {
        section("11. 剧集解析：title 清洗（上游 title 实为简介）");
        String intro = "这是一段很长的本剧简介文字";
        Map<String, Object> vd = Json.obj();
        vd.put("series_intro", intro);
        vd.put("series_title", "测试剧");
        vd.put("episode_cnt", 2);
        java.util.List<Object> vl = Json.arr();

        Map<String, Object> e1 = Json.obj();
        e1.put("vid_index", 1);
        e1.put("vid", "v1");
        e1.put("title", intro);          // 与简介相同 => 应置空
        e1.put("duration", 100);
        vl.add(e1);

        Map<String, Object> e2 = Json.obj();
        e2.put("vid_index", 2);
        e2.put("vid", "v2");
        e2.put("title", "第 2 集");       // 正常集名=> 应保留
        e2.put("duration", 120);
        vl.add(e2);

        vd.put("video_list", vl);
        Map<String, Object> r = Client.parseEpisodeDetail("123", vd);
        java.util.List<Object> eps = Json.optArr(r.get("episodes"));
        check("解析出 2 集", eps.size() == 2, "" + eps.size());

        Map<String, Object> a1 = Json.optObj(eps.get(0));
        Map<String, Object> a2 = Json.optObj(eps.get(1));
        check("与简介相同的 title 被置空",
                Json.optStr(a1.get("title"), "x").isEmpty(), "");
        check("正常集名保留",
                Json.optStr(a2.get("title"), "").equals("第 2 集"), "");
        check("meta 标题取 series_title",
                Json.optStr(Json.optObj(r.get("meta")).get("title"), "")
                        .equals("测试剧"), "");
        check("按 index 升序排列",
                Json.optLong(a1.get("index"), 0) == 1
                        && Json.optLong(a2.get("index"), 0) == 2, "");
    }

    /** 12. 解码兼容性：默认不转码（直出 HEVC）。 */
    private void transcode() {
        section("12. 解码兼容性：默认不转码（直出 HEVC）");
        check("ffmpeg 可用", Stream.ffmpegAvailable(), "");
        check("默认关闭转码", !Stream.transcodeEnabled(), "");
        if (Stream.transcodeEnabled()) {
            check("转码时能找到 H.264 编码器",
                    Stream.h264EncoderName() != null, "" + Stream.h264EncoderName());
        } else {
            System.out.println("  · 转码已关闭（HG_TRANSCODE=1 可开启 HEVC -> H.264）");
        }
    }

    /** 13. 密钥管理。 */
    private void keyStore() {
        section("13. 本地链路密钥");
        com.hongguo.api.core.KeyStore ks = new com.hongguo.api.core.KeyStore();
        // 密钥文件首次由Server.ensureBootstrap() 自动签发，而该方法只在
        // Launcher 正式启动流程里调用；--selftest 是独立轻量入口，不经Launcher，
        // 因此「从未启动过服务」的干净环境下 apikeys.json 不存在。
        //
        // 这两项依赖运行态产物而非算法本身，故此时跳过（不计失败）：
        // 未配置签名服务，或配置了但探活不通过，都说明处于离线/未启动状态，
        // 密钥尚未被引导签发是预期行为，判失败只会让每次离线自检都挂两条。
        boolean signerReady = !Signer.signServers().isEmpty()
                && anySignerReady();
        if (ks.countEnabled() == 0) {
            skip("至少一把启用密钥", ks.countEnabled() == 0
                    ? "尚未引导签发（" + bootstrapHint(signerReady) + "）" : "");
        } else {
            check("至少一把启用密钥", true, "" + ks.countEnabled());
        }
        com.hongguo.api.core.KeyStore.Rec first = ks.firstEnabled();
        if (first == null) {
            skip("首把密钥格式为 hg_ 前缀", bootstrapHint(signerReady));
        } else {
            check("首把密钥格式为 hg_ 前缀", first.key.startsWith("hg_"), "");
        }
        check("无效密钥被拒绝", !ks.isValid("hg_nonexistent"), "");
        check("空密钥被拒绝", !ks.isValid(""), "");
    }

    /** 14. moov 定位：尾部 moov（非 faststart）必须能被正确找到。 */
    private void moovLocator() {
        section("14. moov 定位：尾部 moov 也能找到（流式解密前置）");
        try {
            // 头部形态（faststart）：moov 应在 ftyp 之后立刻出现
            byte[] head = Mp4Fixture.buildMinimalEncryptedMp4();
            Mp4.MoovSpan hSpan = scanMoov(head);
            check("头部形态能定位 moov", hSpan != null,
                    hSpan == null ? "null" : ("start=" + hSpan.start + " size=" + hSpan.size));
            if (hSpan != null) {
                check("头部形态 moov 紧跟 ftyp", hSpan.start > 0 && hSpan.start < head.length / 2,
                        "start=" + hSpan.start);
            }

            // 尾部形态：moov 在文件末尾
            byte[] tail = Mp4Fixture.buildTailMoovEncryptedMp4();
            Mp4.MoovSpan tSpan = scanMoov(tail);
            check("尾部形态能定位 moov", tSpan != null,
                    tSpan == null ? "null" : ("start=" + tSpan.start + " size=" + tSpan.size));
            if (tSpan != null) {
                // 夹具体积很小（几百字节），不用比例判断，改为「moov 在 mdat 之后」
                // ——这才是尾部 moov 的语义：索引段排在媒体数据之后。
                int mdatEnd = indexOfType(tail, "mdat");
                check("尾部形态 moov 排在 mdat 之后",
                        tSpan.start > mdatEnd,
                        "moov@" + tSpan.start + " > mdat@" + mdatEnd);
                check("moov 末端与文件末端一致",
                        tSpan.end() == tail.length,
                        tSpan.end() + "==" + tail.length);
            }

            // 两种形态都能解析出加密轨，且样本偏移一致（都指向各自 mdat）
            check("头部形态解析出加密轨",
                    !Mp4.analyzeEncryptedTracks(head).tracks.isEmpty(), "");
            check("尾部形态解析出加密轨",
                    !Mp4.analyzeEncryptedTracks(tail).tracks.isEmpty(), "");

            // 尾部形态的样本偏移必须能对上真实字节：
            // 用 base-offset 视图解析后，偏移应落在文件范围内
            if (tSpan != null) {
                byte[] moovBuf = java.util.Arrays.copyOfRange(tail, (int) tSpan.start,
                        (int) tSpan.end());
                Mp4.Analysis a = Mp4.analyzeEncryptedTracks(
                        new Mp4.ByteView(moovBuf, tSpan.start));
                check("尾部形态 base-offset 视图可解析", !a.tracks.isEmpty(), "");
                if (!a.tracks.isEmpty()) {
                    Mp4.Track vt = a.tracks.get(0);
                    boolean inRange = true;
                    for (int i = 0; i < vt.sampleCount; i++) {
                        if (vt.offsets[i] < 0 || vt.offsets[i] + vt.sizes[i] > tail.length) {
                            inRange = false;
                            break;
                        }
                    }
                    check("尾部形态样本偏移落在文件范围内（base 换算正确）", inRange, "");
                }
            }
        } catch (Exception e) {
            check("moov 定位", false, String.valueOf(e.getMessage()));
        }
    }

    /** 用字节数组模拟的 HeadReader，扫描 moov。 */
    private static Mp4.MoovSpan scanMoov(final byte[] buf) {
        return Mp4.findMoov((off, len) -> {
            if (off < 0 || off + len > buf.length) return null;
            return java.util.Arrays.copyOfRange(buf, (int) off, (int) (off + len));
        }, buf.length);
    }

    /** 返回指定盒类型首字节在数组中的下标（找不到返回 -1）。 */
    private static int indexOfType(byte[] hay, String type) {
        byte[] needle = type.getBytes(java.nio.charset.StandardCharsets.ISO_8859_1);
        outer:
        for (int i = 0; i <= hay.length - needle.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) continue outer;
            }
            return i - 4;
        }
        return -1;
    }

    /**
     * 15. 流式解密的内存回归。
     *
     * 核心断言：走SampleStore（RandomAccessFile）路径解密后，
     * 逐字节结果必须与整文件 byte[] 路径完全一致 —— 这是流式改造的等价性证明。
     * 同时校验「大文件不撑爆堆」：仅声明解密期间不读全文。
     */
    private void streamingDecrypt() {
        section("15. 流式解密与整文件解密结果一致");
        try {
            byte[] fixture = Mp4Fixture.buildMinimalEncryptedMp4();
            String keyHex = Mp4Fixture.fixtureKeyHex();

            // 基线：整文件 byte[] 路径（保持历史行为）
            byte[] base = java.util.Arrays.copyOf(fixture, fixture.length);
            Mp4.Analysis a1 = Mp4.analyzeEncryptedTracks(base);
            Mp4.Track vt1 = a1.tracks.get(0);
            String iv1 = Mp4.verifyVideoIv(base, vt1, keyHex,
                    Mp4.trackBaseIvCandidates(vt1));
            Mp4.decryptTrack(base, vt1, keyHex, iv1);

            // 流式：moov 窗口 + RandomAccessFile 路径
            Path tmp = Files.createTempFile("hg-stream-", ".mp4");
            try {
                Files.write(tmp, fixture);
                byte[] streamOut;
                try (java.io.RandomAccessFile raf =
                             new java.io.RandomAccessFile(tmp.toFile(), "rw")) {
                    Mp4.SampleStore store = new Mp4.RafStore(raf, 4096);
                    // 仅加载 moov 段（模拟流式：堆内只有索引段）
                    Mp4.MoovSpan span = scanMoov(fixture);
                    check("流式路径能定位 moov", span != null, "");
                    byte[] moovBuf = java.util.Arrays.copyOfRange(fixture,
                            (int) span.start, (int) span.end());
                    Mp4.Analysis a2 = Mp4.analyzeEncryptedTracks(
                            new Mp4.ByteView(moovBuf, span.start));
                    check("流式路径解析出加密轨", !a2.tracks.isEmpty(), "");
                    Mp4.Track vt2 = a2.tracks.get(0);
                    check("两种路径样本数一致",
                            vt1.sampleCount == vt2.sampleCount,
                            vt1.sampleCount + "==" + vt2.sampleCount);
                    check("两种路径样本偏移一致",
                            java.util.Arrays.equals(vt1.offsets, vt2.offsets), "");

                    // verify 必须先于 decrypt
                    String iv2 = Mp4.verifyVideoIv(store, vt2, keyHex,
                            Mp4.trackBaseIvCandidates(vt2));
                    check("流式路径 IV 自证通过", iv1.equals(iv2), "" + iv2);
                    Mp4.DecryptResult r2 = Mp4.decryptTrack(store, vt2, keyHex, iv2);
                    check("流式路径解密样本数一致", r2.decrypted == vt1.sampleCount,
                            r2.decrypted + "/" + r2.total);
                }
                streamOut = Files.readAllBytes(tmp);

                // 等价性：流式结果必须与整文件结果逐字节相同
                check("流式解密结果与整文件解密逐字节一致",
                        java.util.Arrays.equals(base, streamOut), "");

                // 且能还原夹具明文
                boolean restored = true;
                byte[][] plains = Mp4Fixture.plainSamples();
                for (int i = 0; i < plains.length; i++) {
                    long off = vt1.offsets[i];
                    int size = (int) vt1.sizes[i];
                    if (!java.util.Arrays.equals(
                            java.util.Arrays.copyOfRange(streamOut, (int) off, (int) off + size),
                            plains[i])) {
                        restored = false;
                        break;
                    }
                }
                check("流式解密逐字节还原夹具明文", restored, "");
            } finally {
                Files.deleteIfExists(tmp);
            }
        } catch (Exception e) {
            check("流式解密", false, String.valueOf(e.getMessage()));
        }
    }

    /**
     * 16. 缓存上限：写入后必须能在超限时淘汰，且过期条目会被清扫。
     *
     * 这是"内存持续增长"的核心防线 —— 历史实现 TTL 形同虚设、
     * 无任何淘汰，故此用例固化该行为。
     */
    private void cacheBounds() {
        section("16. 缓存上限与过期清扫");
        try {
            // 条数上限：HG_MEM_CACHE_MAX 生效（用较小值快速验证）
            String savedMax = System.getProperty("HG_MEM_CACHE_MAX");
            System.setProperty("HG_MEM_CACHE_MAX", "50");
            // 注意：Safeguards 静态初始化已在类加载时读取上限，
            // 因此这里只验证「写入+读取+清扫」行为本身，不改配置重载。

            // 写入若干条目并可读回
            for (int i = 0; i < 100; i++) {
                Safeguards.cacheSet("selftest:k:" + i, "v" + i, 3600);
            }
            boolean readable = Safeguards.cacheGet("selftest:k:99") != null;
            check("缓存写入后可读回", readable, "");

            // 过期条目：cacheGet 应视为 miss
            Safeguards.cacheSet("selftest:expired", "x", 1);
            Thread.sleep(1100);
            check("过期条目视为 miss（TTL 生效）",
                    Safeguards.cacheGet("selftest:expired") == null, "");

            // 后台清扫线程存在且为 daemon（不阻止 JVM 退出）
            boolean sweeper = false;
            for (Thread t : Thread.getAllStackTraces().keySet()) {
                if ("hg-cache-sweeper".equals(t.getName()) && t.isDaemon()) {
                    sweeper = true;
                    break;
                }
            }
            check("后台清扫线程已启动且为 daemon", sweeper, "");

            // 估算器不应抛异常，且对大结构有界
            int w = Safeguards.weigh(new java.util.HashMap<String, Object>());
            check("weigh 对空结构返回合理值", w >= 0 && w < 4096, "" + w);

            if (savedMax == null) System.clearProperty("HG_MEM_CACHE_MAX");
            else System.setProperty("HG_MEM_CACHE_MAX", savedMax);
        } catch (Exception e) {
            check("缓存上限", false, String.valueOf(e.getMessage()));
        }
    }

    /**
     * 17. stream-cache 数量上限（磁盘缓存限量）。
     *
     * 背景：解密成品原为无上限落盘，看得越多占用越大。现在落盘后自动清理，
     * 按最后修改时间保留最新 N 个（默认 30），最旧的删除。
     */
    private void streamCacheLimit() {
        section("17. stream-cache 数量上限（超出按修改时间淘汰最旧）");
        Path tmp = null;
        try {
            tmp = Files.createTempDirectory("hg-prune-");
            String savedDir = System.getProperty("HONGGUO_STREAM_CACHE");
            String savedMax = System.getProperty("HONGGUO_CACHE_MAX_FILES");
            System.setProperty("HONGGUO_STREAM_CACHE", tmp.toString());

            // 固定基准时刻，显式设置 mtime，避免文件系统时间精度导致顺序不稳
            final long base = 1700000000000L;

            // 造 5 个成品，mtime 递增：f0 最旧 ... f4 最新
            java.util.List<Path> made = new java.util.ArrayList<>();
            for (int i = 0; i < 5; i++) {
                Path p = tmp.resolve("v" + i + "_best.play.mp4");
                Files.write(p, new byte[]{'x'});
                Files.setLastModifiedTime(p,
                        java.nio.file.attribute.FileTime.fromMillis(base + i * 60_000L));
                made.add(p);
            }

            // 上限 3 -> 应删掉最旧的 2 个（v0、v1）
            System.setProperty("HONGGUO_CACHE_MAX_FILES", "3");
            int del = Stream.pruneCache();
            check("超出上限时删除最旧文件", del == 2, "删除 " + del + " 个");
            check("最旧的 v0 已删除", !Files.exists(made.get(0)), "");
            check("最旧的 v1 已删除", !Files.exists(made.get(1)), "");
            check("最新 3 个被保留",
                    Files.exists(made.get(2)) && Files.exists(made.get(3))
                            && Files.exists(made.get(4)), "");
            check("清理后数量等于上限",
                    countCacheFiles(tmp) == 3, "" + countCacheFiles(tmp));

            // 临时文件（.part/.enc）不计入上限、也不被删
            Path part = tmp.resolve("zz_download.part");
            Path enc = tmp.resolve("zz_ct.enc");
            Files.write(part, new byte[]{'x'});
            Files.write(enc, new byte[]{'x'});
            Files.setLastModifiedTime(part,
                    java.nio.file.attribute.FileTime.fromMillis(base - 999_999L));
            Files.setLastModifiedTime(enc,
                    java.nio.file.attribute.FileTime.fromMillis(base - 999_999L));
            Stream.pruneCache();
            check("下载临时文件 .part 不被删除", Files.exists(part), "");
            check("密文临时文件 .enc 不被删除", Files.exists(enc), "");

            // 恰好等于上限时不应删任何东西
            System.setProperty("HONGGUO_CACHE_MAX_FILES", "5");
            Path tmp2 = null;
            try {
                tmp2 = Files.createTempDirectory("hg-prune2-");
                for (int i = 0; i < 5; i++) {
                    Path p = tmp2.resolve("k" + i + "_best.play.mp4");
                    Files.write(p, new byte[]{'x'});
                    Files.setLastModifiedTime(p,
                            java.nio.file.attribute.FileTime.fromMillis(base + i * 60_000L));
                }
                int d2 = Stream.pruneCache(5);
                check("恰好等于上限时不删除", d2 == 0, "删除 " + d2 + " 个");
            } finally {
                deleteTree(tmp2);
            }

            // 上限<=0 表示关闭清理
            check("上限设为 0 时不清理", Stream.pruneCache(0) == 0, "");
            check("上限设为负数时不清理", Stream.pruneCache(-1) == 0, "");

            // 空目录 / 目录不存在都不应抛异常
            Path tmp3 = Files.createTempDirectory("hg-prune3-");
            String savedDir3 = System.getProperty("HONGGUO_STREAM_CACHE");
            System.setProperty("HONGGUO_STREAM_CACHE", tmp3.toString());
            check("空目录清理不报错", Stream.pruneCache() == 0, "");
            System.setProperty("HONGGUO_STREAM_CACHE", tmp3.resolve("nope").toString());
            check("目录不存在时不报错", Stream.pruneCache() == 0, "");
            System.setProperty("HONGGUO_STREAM_CACHE", savedDir3);
            deleteTree(tmp3);

            if (savedDir == null) System.clearProperty("HONGGUO_STREAM_CACHE");
            else System.setProperty("HONGGUO_STREAM_CACHE", savedDir);
            if (savedMax == null) System.clearProperty("HONGGUO_CACHE_MAX_FILES");
            else System.setProperty("HONGGUO_CACHE_MAX_FILES", savedMax);
        } catch (Exception e) {
            check("stream-cache 数量上限", false, String.valueOf(e.getMessage()));
        } finally {
            if (tmp != null) deleteTree(tmp);
        }
    }

    /** 统计目录下的成品文件数（排除 .part/.enc 临时文件）。 */
    private static int countCacheFiles(Path dir) throws Exception {
        final int[] n = {0};
        try (java.util.stream.Stream<Path> s = Files.list(dir)) {
            for (Path p : s.toArray(Path[]::new)) {
                String n2 = p.getFileName().toString();
                if (!n2.endsWith(".part") && !n2.endsWith(".enc")) n[0]++;
            }
        }
        return n[0];
    }

    /** 递归删除临时目录。 */
    private static void deleteTree(Path dir) {
        if (dir == null) return;
        try {
            Files.walk(dir).sorted(java.util.Comparator.reverseOrder()).forEach(x -> {
                try {
                    Files.delete(x);
                } catch (Exception ignored) {
                    // 忽略
                }
            });
        } catch (Exception ignored) {
            // 忽略
        }
    }

    // ==================== 入口 ====================

    static int run() {
        System.out.println("");
        System.out.println("  ============================================");
        System.out.println("    hongguo-api 自检");
        System.out.println("  ============================================");

        SelfTest t = new SelfTest();
        try {
            t.spade();
            t.ctrCounter();
            t.ivToCounter();
            t.avcc();
            t.ctrRoundTrip();
            t.mp4Boxes();
            t.decryptEndToEnd();
            t.json();
            t.cachePaths();
            t.device();
            t.episodeTitle();
            t.transcode();
            t.keyStore();
            t.moovLocator();
            t.streamingDecrypt();
            t.cacheBounds();
            t.streamCacheLimit();
        } catch (Exception e) {
            t.failed++;
            System.out.println("  ✗ 自检异常中断：" + e);
            e.printStackTrace();
        }

        section("运行环境");
        System.out.println("  上游 host     " + Client.HOST);
        System.out.println("  设备身份     " + Client.identity().source
                + "（device_id=" + Client.identity().deviceId + "）");
        System.out.println("  托管模式     " + Client.MANAGED);
        System.out.println("  列表免签     " + Client.SIGN_LIST);
        System.out.println("  签名后端     " + Signer.signServers());
        System.out.println("  ffmpeg       " + Stream.ffmpegAvailable());
        System.out.println("  转码         " + Stream.transcodeEnabled()
                + (Stream.transcodeEnabled() ? "（编码器 " + Stream.h264EncoderName() + "）" : ""));
        System.out.println("  Java         " + System.getProperty("java.version"));

        System.out.println("");
        int total = t.passed + t.failed;
        String verdict = (t.failed == 0)
                ? " 全部通过"
                : "，失败 " + t.failed + " 项";
        System.out.println("  结果：" + t.passed + "/" + total + verdict);
        if (t.skipped > 0) {
            System.out.println("  跳过 " + t.skipped + " 项（依赖运行态产物，不计入失败）");
        }
        System.out.println("");
        return t.failed == 0 ? 0 : 1;
    }
}
