package com.hongguo.api;

import com.hongguo.api.core.Mp4;
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
        check("至少一把启用密钥", ks.countEnabled() > 0, "" + ks.countEnabled());
        com.hongguo.api.core.KeyStore.Rec first = ks.firstEnabled();
        check("首把密钥格式为 hg_ 前缀",
                first != null && first.key.startsWith("hg_"), "");
        check("无效密钥被拒绝", !ks.isValid("hg_nonexistent"), "");
        check("空密钥被拒绝", !ks.isValid(""), "");
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
        System.out.println("  结果：" + t.passed + "/" + total
                + (t.failed == 0 ? " 全部通过" : "，失败 " + t.failed + " 项"));
        System.out.println("");
        return t.failed == 0 ? 0 : 1;
    }
}
