package com.hongguo.api.core;

import com.hongguo.api.util.Crypto;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 纯文件 / 纯算法 MP4 CENC 解密。
 *
 * 移植自 server/src/mp4.js。与原实现的关键差异：不使用正则扫描字节流，
 * 而是完整解析 ISO BMFF 盒结构，因此对多 trak、大小端、64 位偏移都更稳健。
 *
 * 解密方案：CENC 的 AES-128-CTR，计数器为 128 位大端，
 *   counter = (base_iv_high64 + sampleIndex) << 64，即低 64 位恒为 0。
 */
public final class Mp4 {

    /** 需要在 trak 内递归查找的容器盒。 */
    private static final Set<String> CONTAINERS = new HashSet<>(java.util.Arrays.asList(
            "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "mvex", "moof", "traf"));

    private Mp4() {}

    // ==================== 盒结构 ====================

    /** MP4 盒。 */
    public static final class Box {
        public final String type;
        public final long start;        // 盒起始绝对偏移
        public final int headerSize;    // 盒头长度
        public final long size;         // 盒总长度（含头）
        public final List<Box> children = new ArrayList<>();

        Box(String type, long start, int headerSize, long size) {
            this.type = type;
            this.start = start;
            this.headerSize = headerSize;
            this.size = size;
        }

        public long end() { return start + size; }
        public long payloadStart() { return start + headerSize; }

        public Box child(String t) {
            for (Box c : children) if (c.type.equals(t)) return c;
            return null;
        }

        public List<Box> childrenOf(String t) {
            List<Box> out = new ArrayList<>();
            for (Box c : children) if (c.type.equals(t)) out.add(c);
            return out;
        }
    }

    /** 轨道信息。 */
    public static final class Track {
        public long trackId;
        public String handler;          // 'vide' | 'soun' | ...
        public int width;
        public int height;
        public int sampleCount;
        public long[] sizes = new long[0];
        public long[] offsets = new long[0];
        public String[] ivs;            // hex，元素为 8 或 16 字节
        public int ivSize = 16;
        public String kid;
        public String constantIv;
    }

    /** 解析结果。 */
    public static final class Analysis {
        public final List<Track> tracks = new ArrayList<>();
        public long timescale = 90000;
    }

    // ==================== 大小端读取 ====================

    private static int u8(byte[] b, long p) { return b[(int) p] & 0xFF; }

    private static int u16(byte[] b, long p) {
        return ((b[(int) p] & 0xFF) << 8) | (b[(int) p + 1] & 0xFF);
    }

    private static long u32(byte[] b, long p) {
        return ((long) (b[(int) p] & 0xFF) << 24)
             | ((long) (b[(int) p + 1] & 0xFF) << 16)
             | ((long) (b[(int) p + 2] & 0xFF) << 8)
             | (b[(int) p + 3] & 0xFF);
    }

    private static long u64(byte[] b, long p) {
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (b[(int) p + i] & 0xFF);
        return v;
    }

    private static long i32(byte[] b, long p) {
        long v = u32(b, p);
        // JS 的 >> 0 转有符号 32 位
        return (v & 0x80000000L) != 0 ? v - 0x100000000L : v;
    }

    /** latin1 字符串（等价 JS 的 toString('latin1')）。 */
    private static String latin1(byte[] b, long from, long to) {
        StringBuilder sb = new StringBuilder();
        for (long i = from; i < to && i < b.length; i++) {
            sb.append((char) (b[(int) i] & 0xFF));
        }
        return sb.toString();
    }

    private static String hex(byte[] b, long from, long to) {
        StringBuilder sb = new StringBuilder();
        for (long i = from; i < to && i < b.length; i++) {
            sb.append(String.format("%02x", b[(int) i] & 0xFF));
        }
        return sb.toString();
    }

    // ==================== 盒解析 ====================

    /**
     * 解析 buf 中 offset 起的盒树。
     *
     * @param offset 起始偏移
     * @param end    结束偏移（不含）
     */
    public static List<Box> parseBoxes(byte[] buf, long offset, long end) {
        List<Box> boxes = new ArrayList<>();
        long p = offset;
        while (p + 8 <= end) {
            long size = u32(buf, p);
            String type = latin1(buf, p + 4, p + 8);
            int headerSize = 8;

            if (size == 1) {
                if (p + 16 > end) break;
                size = u64(buf, p + 8);
                headerSize = 16;
            } else if (size == 0) {
                size = end - p; // 延伸到文件末尾
            }

            if (size < headerSize || p + size > end || size < 0) break;
            Box box = new Box(type, p, headerSize, size);
            if (CONTAINERS.contains(type)) {
                box.children.addAll(parseBoxes(buf, box.payloadStart(), box.end()));
            } else if (type.equals("stsd")) {
                // stsd: version/flags(4) + entry_count(4)，之后是 sample entry
                box.children.addAll(parseBoxes(buf, box.payloadStart() + 8, box.end()));
            }
            boxes.add(box);
            p += size;
        }
        return boxes;
    }

    /** 递归收集指定类型的全部盒。 */
    public static List<Box> collect(Box box, String type) {
        List<Box> acc = new ArrayList<>();
        collectInto(box, type, acc);
        return acc;
    }

    private static void collectInto(Box box, String type, List<Box> acc) {
        for (Box c : box.children) {
            if (c.type.equals(type)) acc.add(c);
            collectInto(c, type, acc);
        }
    }

    /** 递归查找第一个指定类型的盒。 */
    public static Box findBox(Box box, String type) {
        for (Box c : box.children) {
            if (c.type.equals(type)) return c;
            Box hit = findBox(c, type);
            if (hit != null) return hit;
        }
        return null;
    }

    // ==================== 元信息 ====================

    /** 解析 mvhd，取 timescale。 */
    private static long readTimescale(byte[] buf, Box moov) {
        Box mvhd = moov.child("mvhd");
        if (mvhd == null) return 90000;
        long p = mvhd.payloadStart();
        int version = u8(buf, p);
        if (version == 1) return u32(buf, p + 20);
        return u32(buf, p + 12);
    }

    /** tenc 信息。 */
    private static final class Tenc {
        String kid;
        String constantIv;
        int ivSize;
        boolean isProtected;
    }

    /** 解析 trak 的 tkhd，取 track_ID 与宽高。 */
    private static Track readTrackHeader(byte[] buf, Box trak) {
        Track t = new Track();
        Box tkhd = trak.child("tkhd");
        if (tkhd == null) return t;
        long p = tkhd.payloadStart();
        int version = u8(buf, p);
        if (version == 1) {
            t.trackId = u32(buf, p + 20);
            t.width = (int) (u32(buf, p + 88) / 65536);
            t.height = (int) (u32(buf, p + 92) / 65536);
        } else {
            t.trackId = u32(buf, p + 12);
            t.width = (int) (u32(buf, p + 76) / 65536);
            t.height = (int) (u32(buf, p + 80) / 65536);
        }
        return t;
    }

    /** 解析 mdia/hdlr，取处理类型（vide / soun）。 */
    private static String readHandler(byte[] buf, Box trak) {
        Box mdia = trak.child("mdia");
        Box hdlr = mdia == null ? null : mdia.child("hdlr");
        if (hdlr == null) return null;
        return latin1(buf, hdlr.payloadStart() + 8, hdlr.payloadStart() + 12);
    }

    /**
     * 解析 stbl 的样本表，得到每个样本在文件中的绝对偏移与长度。
     */
    private static void readSampleTable(byte[] buf, Box stbl, Track track) {
        List<Long> sizes = new ArrayList<>();
        List<Long> offsets = new ArrayList<>();

        // stsz：样本大小（size==0 时逐样本读取）
        Box stsz = stbl.child("stsz");
        if (stsz != null) {
            long p = stsz.payloadStart() + 4; // 跳过 version/flags
            long uniform = u32(buf, p);
            long count = u32(buf, p + 4);
            if (uniform > 0) {
                for (long i = 0; i < count; i++) sizes.add(uniform);
            } else {
                for (long i = 0; i < count; i++) sizes.add(u32(buf, p + 8 + i * 4));
            }
        }

        // stsc：样本到 chunk 的映射
        List<long[]> stscEntries = new ArrayList<>(); // {firstChunk, samplesPerChunk, descIndex}
        Box stsc = stbl.child("stsc");
        if (stsc != null) {
            long p = stsc.payloadStart() + 4;
            long n = u32(buf, p);
            for (long i = 0; i < n; i++) {
                long q = p + 4 + i * 12;
                stscEntries.add(new long[]{u32(buf, q), u32(buf, q + 4), u32(buf, q + 8)});
            }
        }

        // stco / co64：chunk 偏移
        List<Long> chunkOffsets = new ArrayList<>();
        Box stco = stbl.child("stco");
        if (stco != null) {
            long p = stco.payloadStart() + 4;
            long n = u32(buf, p);
            for (long i = 0; i < n; i++) chunkOffsets.add(u32(buf, p + 4 + i * 4));
        } else {
            Box co64 = stbl.child("co64");
            if (co64 != null) {
                long p = co64.payloadStart() + 4;
                long n = u32(buf, p);
                for (long i = 0; i < n; i++) chunkOffsets.add(u64(buf, p + 4 + i * 8));
            }
        }

        // 依据 stsc 把 chunk 展开为样本偏移
        for (int e = 0; e < stscEntries.size(); e++) {
            long[] cur = stscEntries.get(e);
            long[] next = (e + 1 < stscEntries.size()) ? stscEntries.get(e + 1) : null;
            long lastChunk = next != null ? next[0] - 1 : chunkOffsets.size();
            for (long ch = cur[0]; ch <= lastChunk; ch++) {
                int ci = (int) (ch - 1);
                if (ci < 0 || ci >= chunkOffsets.size()) break;
                long off = chunkOffsets.get(ci);
                for (long s = 0; s < cur[1]; s++) {
                    int idx = offsets.size();
                    if (idx >= sizes.size()) break;
                    offsets.add(off);
                    off += sizes.get(idx);
                }
            }
        }

        track.sizes = new long[sizes.size()];
        for (int i = 0; i < sizes.size(); i++) track.sizes[i] = sizes.get(i);
        track.offsets = new long[offsets.size()];
        for (int i = 0; i < offsets.size(); i++) track.offsets[i] = offsets.get(i);
        track.sampleCount = sizes.size();
    }

    /**
     * 读取 tenc 盒的 default_KID、default_IV_size 与 constant IV（若有）。
     */
    private static Tenc readTenc(byte[] buf, Box trak) {
        Box sinf = findBox(trak, "sinf");
        Box schm = sinf == null ? null : sinf.child("schm");
        if (schm != null) {
            long p = schm.payloadStart() + 4;
            String scheme = latin1(buf, p, p + 4);
            if (!scheme.equals("cenc")) return null; // 仅处理 CENC
        }
        Box tenc = sinf == null ? null : sinf.child("tenc");
        if (tenc == null) return null;
        Tenc out = new Tenc();
        long p = tenc.payloadStart();
        int version = u8(buf, p);
        int flags = ((buf[(int) p + 1] & 0xFF) << 16) | ((buf[(int) p + 2] & 0xFF) << 8)
                  | (buf[(int) p + 3] & 0xFF);
        long q;
        if (version == 0) {
            out.ivSize = u8(buf, p + 4);
            q = p + 5;
        } else {
            out.ivSize = u8(buf, p + 9);
            q = p + 10;
        }
        out.kid = hex(buf, q, q + 16);
        if ((flags & 0x01) != 0) {
            out.constantIv = hex(buf, q + 16, q + 16 + out.ivSize);
        }
        out.isProtected = (flags & 0x02) != 0;
        return out;
    }

    /**
     * 存在 subsample 信息时，无法直接用长度反推 IV 大小；
     * 改为假定 16 字节走一遍，若最终偏移不吻合再退回 8 字节。
     */
    private static long estimateWithoutSubsample(byte[] buf, long start, long end, int count) {
        long q = start;
        int n = 0;
        while (q + 18 <= end && n < count) {
            int subsampleCount = u16(buf, q + 16);
            q += 16 + 2 + subsampleCount * 6L;
            n++;
        }
        if (q > end) return (end - start);
        return q - start;
    }

    /**
     * 解析 senc 盒，取每个样本的 IV。
     *
     * 重要：IV 长度并非总是 16 字节。本项目实测两种都存在：
     *   - 16 字节：标准 CENC，per-sample IV 为完整 128 位；
     *   - 8 字节：PIFF/简化形态，盒长度恰好等于 8 + count*IV_size。
     * 因此用「盒剩余长度 / 样本数」反推实际 IV 长度，并以 tenc 声明交叉校验。
     */
    private static String[] readSencIVs(byte[] buf, Box senc, int tencIvSize) {
        long p = senc.payloadStart();
        int flags = ((buf[(int) p + 1] & 0xFF) << 16) | ((buf[(int) p + 2] & 0xFF) << 8)
                  | (buf[(int) p + 3] & 0xFF);
        int count = (int) u32(buf, p + 4);
        boolean hasSubsample = (flags & 0x02) != 0;

        // 反推 IV 长度：剩余字节里先扣掉 subsample 开销
        long payload = senc.end() - (p + 8);
        if (hasSubsample) payload = estimateWithoutSubsample(buf, p + 8, senc.end(), count);
        int ivSize = count > 0 ? (int) (payload / count) : 16;
        if (ivSize != 8 && ivSize != 16) {
            ivSize = (tencIvSize == 8) ? 8 : 16;
        }
        // tenc 声明优先（它是权威来源）
        if (tencIvSize == 8 || tencIvSize == 16) ivSize = tencIvSize;

        List<String> ivs = new ArrayList<>();
        long q = p + 8;
        for (int i = 0; i < count; i++) {
            if (q + ivSize > senc.end()) break;
            ivs.add(hex(buf, q, q + ivSize));
            q += ivSize;
            if (hasSubsample) {
                if (q + 2 > senc.end()) break;
                int subsampleCount = u16(buf, q);
                q += 2 + subsampleCount * 6L;
            }
        }
        return ivs.toArray(new String[0]);
    }

    /**
     * 收集密文 mp4 中所有加密轨（视频 + 音频）及其样本表与 IV。
     */
    public static Analysis analyzeEncryptedTracks(byte[] buf) {
        List<Box> top = parseBoxes(buf, 0, buf.length);
        Box moov = null;
        for (Box b : top) if (b.type.equals("moov")) moov = b;
        if (moov == null) throw new IllegalArgumentException("不是有效的 MP4：缺少 moov 盒");

        Analysis out = new Analysis();
        out.timescale = readTimescale(buf, moov);

        for (Box trak : moov.childrenOf("trak")) {
            Box mdia = trak.child("mdia");
            Box minf = mdia == null ? null : mdia.child("minf");
            Box stblBox = minf == null ? null : minf.child("stbl");
            if (stblBox == null) continue;

            Track t = new Track();
            t.handler = readHandler(buf, trak);
            Track header = readTrackHeader(buf, trak);
            t.trackId = header.trackId;
            t.width = header.width;
            t.height = header.height;
            readSampleTable(buf, stblBox, t);
            if (t.sampleCount == 0) continue;

            // senc 可能在 stbl 内（明文 CENC），或经 saiz/saio 指向
            Box senc = stblBox.child("senc");
            if (senc == null) senc = findBox(trak, "senc");
            Tenc tenc = readTenc(buf, trak);
            // tenc 的 default_IV_size 是 IV 长度的权威来源
            t.ivs = senc != null ? readSencIVs(buf, senc, tenc != null ? tenc.ivSize : 0) : null;
            t.ivSize = tenc != null ? tenc.ivSize : 16;
            t.kid = tenc != null ? tenc.kid : null;
            t.constantIv = tenc != null ? tenc.constantIv : null;

            out.tracks.add(t);
        }
        return out;
    }

    // ==================== CTR计数器 ====================

    /**
     * 逐样本 IV（senc/PIFF 常为 8 字节）直接作为 CTR 计数器的高 64 位，低 64 位补 0。
     *
     * 本项目实测：senc 里的 IV 是「逐样本递增」的 8 字节序列，
     * 即 iv[i] = base_iv + i。因此「取 iv[i] 当高 64 位」与「base_iv 加 i 后左移」
     * 完全等价，但前者能天然兼容 16 字节 IV 的标准 CENC。
     */
    public static byte[] ivToCounter(String ivHex) {
        String h = ivHex == null ? "" : ivHex.trim();
        // 16 字节标准 IV：本身就是 128 位计数器
        if (h.length() >= 32) {
            return Crypto.unhex(h.substring(0, 32).length() % 2 == 0
                    ? h.substring(0, 32) : h.substring(0, 31) + "0");
        }
        // 8 字节 IV（PIFF 形态）：位于高 64 位，低 64 位补 0
        StringBuilder sb = new StringBuilder(h);
        while (sb.length() < 32) sb.append('0');
        return Crypto.unhex(sb.substring(0, 32));
    }

    /** 构造 AES-128-CTR 的初始计数器：counter = (baseIvHi64 + index) << 64。 */
    public static byte[] ctrCounter(String baseIvHex, int index) {
        java.math.BigInteger hi = new java.math.BigInteger(baseIvHex, 16);
        java.math.BigInteger counter = hi.add(java.math.BigInteger.valueOf(index))
                .shiftLeft(64)
                .and(java.math.BigInteger.ONE.shiftLeft(128).subtract(java.math.BigInteger.ONE));
        String hex = counter.toString(16);
        StringBuilder sb = new StringBuilder();
        while (sb.length() + hex.length() < 32) sb.append('0');
        sb.append(hex);
        return Crypto.unhex(sb.substring(0, 32));
    }

    /** 取第 i 个样本的 CTR 计数器：优先用逐样本 IV，缺失时回退 base_iv + i。 */
    public static byte[] counterFor(Track track, String baseIvHex, int i) {
        if (track.ivs != null && i >= 0 && i < track.ivs.length && track.ivs[i] != null) {
            return ivToCounter(track.ivs[i]);
        }
        return ctrCounter(baseIvHex, i);
    }

    // ==================== 解密 ====================

    /** 解密结果。 */
    public static final class DecryptResult {
        public final int decrypted;
        public final int total;
        DecryptResult(int d, int t) { decrypted = d; total = t; }
    }

    /**
     * 就地解密单轨的全部样本（AES-128-CTR）。
     *
     * @param keyHex    content key（32 位十六进制）
     * @param baseIvHex 该轨 base_iv 高 8 字节（仅在无逐样本 IV 时使用）
     */
    public static DecryptResult decryptTrack(byte[] buf, Track track, String keyHex, String baseIvHex) {
        byte[] key = Crypto.unhex(keyHex);
        if (key.length != 16) throw new IllegalArgumentException("content key 长度非法");
        boolean hasIvs = track.ivs != null && track.ivs.length > 0;
        if (!hasIvs && baseIvHex == null) {
            throw new IllegalArgumentException("该轨既无逐样本 IV 也无 base_iv，无法解密");
        }
        int done = 0;
        for (int i = 0; i < track.sampleCount; i++) {
            long off = track.offsets[i];
            long size = track.sizes[i];
            if (off == 0 && track.offsets.length > 0 && i == 0) {
                // offsets[0] 为 0 是合法情况，不跳过
            }
            if (size <= 0) continue;
            if (off < 0 || off + size > buf.length) continue;
            byte[] counter = counterFor(track, baseIvHex, i);
            byte[] plain = Crypto.aes128Ctr(key, counter,
                    java.util.Arrays.copyOfRange(buf, (int) off, (int) (off + size)));
            System.arraycopy(plain, 0, buf, (int) off, plain.length);
            done++;
        }
        return new DecryptResult(done, track.sampleCount);
    }

    /**
     * 取该轨的 base_iv 候选（16 位 hex =计数器高 64 位）。
     */
    public static List<String> trackBaseIvCandidates(Track track) {
        final List<String> out = new ArrayList<>();
        class Pusher {
            void push(String hx) {
                if (hx == null || hx.isEmpty()) return;
                String hi = hx.length() >= 16 ? hx.substring(0, 16) : hx;
                if (hi.length() == 16 && !out.contains(hi)) out.add(hi);
            }
        }
        Pusher p = new Pusher();
        p.push(track.constantIv);
        if (track.ivs != null) {
            for (String iv : track.ivs) {
                p.push(iv);
                if (out.size() >= 4) break;
            }
        }
        return out;
    }

    // ==================== IV 自证 ====================

    /**
     * AVCC 自证：4 字节大端长度前缀链必须自洽地走完整个样本，且每个 NAL 类型合法。
     * 也接受 Annex-B 起始码（00 00 00 01/ 00 00 01）。
     *
     * 关键点：一个视频样本通常含多个 NAL（SPS/PPS/SEI/IDR），
     * 所以必须遍历整条长度链，只看首个 NAL 会误判。
     */
    public static boolean avccSelfOk(byte[] plain, int size) {
        int n = Math.min(plain.length, size > 0 ? size : plain.length);
        if (n < 5) return false;
        // Annex-B 起始码
        if (plain[0] == 0 && plain[1] == 0
                && (plain[2] == 1 || (plain[2] == 0 && plain[3] == 1))) {
            return true;
        }
        int off = 0;
        int nals = 0;
        while (off + 5 <= n) {
            long len = u32(plain, off);
            if (len <= 0 || off + 4 + len > n) return false;
            // NAL 头：1 bit forbidden_zero + 2 bit nal_ref_idc + 5 bit nal_unit_type
            if ((plain[off + 4] & 0x80) != 0) return false;
            off += 4 + len;
            if (++nals > 64) return false;
        }
        return nals > 0 && (off == n || n - off <= 3);
    }

    /**
     * 挑选探测样本：首个 + 中段若干 + 末尾，跳过 size 过小的样本。
     */
    public static int[] pickProbeIndices(Track track) {
        int n = track.sampleCount;
        if (n == 0) return new int[0];
        int[] cand = {0, 1, 2, n >> 2, n >> 1, n - 1};
        List<Integer> out = new ArrayList<>();
        java.util.Set<Integer> seen = new java.util.HashSet<>();
        for (int i : cand) {
            if (i < 0 || i >= n) continue;
            if (!seen.add(i)) continue;
            if (track.sizes[i] >= 8) out.add(i);
        }
        int[] arr = new int[out.size()];
        for (int i = 0; i < arr.length; i++) arr[i] = out.get(i);
        java.util.Arrays.sort(arr);
        return arr;
    }

    /**
     * 用候选 base_iv 试解一个视频轨，返回能通过 AVCC 自证的 base_iv；失败返回 null。
     */
    public static String verifyVideoIv(byte[] buf, Track track, String keyHex, List<String> candidates) {
        byte[] key;
        try {
            key = Crypto.unhex(keyHex);
        } catch (Exception e) {
            return null;
        }
        if (key.length != 16) return null;

        boolean hasIvs = track.ivs != null && track.ivs.length >= track.sampleCount;
        List<String> list;
        if (hasIvs) {
            list = new ArrayList<>();
            list.add(track.ivs[0]);
        } else {
            list = candidates != null ? candidates : new ArrayList<>();
        }
        for (String cand : list) {
            int ok = 0;
            int tested = 0;
            for (int i : pickProbeIndices(track)) {
                long off = track.offsets[i];
                long size = track.sizes[i];
                if (size == 0 || off + size > buf.length) continue;
                tested++;
                byte[] counter = counterFor(track, cand, i);
                byte[] plain = Crypto.aes128Ctr(key, counter,
                        java.util.Arrays.copyOfRange(buf, (int) off, (int) (off + size)));
                if (avccSelfOk(plain, (int) size)) ok++;
            }
            // 全部探测样本都自洽才算通过：避免 60% 阈值被噪声蒙混
            if (tested > 0 && ok == tested) return cand;
        }
        return null;
    }
}
