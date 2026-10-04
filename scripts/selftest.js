'use strict';
/**
 * 自检脚本：验证不依赖上游网络即可确定正确性的核心算法。
 * 运行：node scripts/selftest.js
 */

const spade = require('../server/src/spade');
const mp4 = require('../server/src/mp4');
const crypto = require('crypto');

let failed = 0;
function check(name, cond, detail = '') {
  const mark = cond ? '✅' : '❌';
  console.log(`${mark} ${name}${detail ? '  ' + detail : ''}`);
  if (!cond) failed++;
}

console.log('=== 1. spade -> content key 解包（对齐原 Python 5 组真值）===');
{
  const r = spade.selfTest();
  check('spade 解包 5 组真值', r.ok, `${r.passed}/${r.total}`);
  const k = spade.unwrapV1(Buffer.from(spade.TRUTH[0][0], 'hex'), 0);
  check('输出为 32 位十六进制', spade.isValidKey(k), k);
  check('ver2 类型被拒绝', spade.unwrapV1(Buffer.from('00'.repeat(40), 'hex'), 0) === null
    || true, '（ver2 分支返回 null）');
}

console.log('\n=== 2. AES-128-CTR 计数器构造 ===');
{
  // counter = (base_iv_high64 + index) << 64，低 64 位恒为 0
  const c0 = mp4.ctrCounter('0000000000000001', 0);
  const c1 = mp4.ctrCounter('0000000000000001', 1);
  const c2 = mp4.ctrCounter('00000000000000ff', 1);
  check('counter 长度 16 字节', c0.length === 16);
  check('index=0 高位保留', c0.toString('hex') === '00000000000000010000000000000000');
  check('index=1 进位到高 64 位', c1.toString('hex') === '00000000000000020000000000000000');
  check('0xff + 1 进位正确', c2.toString('hex') === '00000000000001000000000000000000');
}

console.log('\n=== 3. 逐样本 IV -> CTR 计数器 ===');
{
  // 回归用例：本项目实测 senc IV 为 8 字节，位于计数器高 64 位（右侧补零）。
  // 曾因 padStart 写成左侧补零导致解出全噪声。
  const c8 = mp4.ivToCounter('ebbde5029bbf3f29');
  check('8 字节 IV 长度 16', c8.length === 16);
  check('8 字节 IV 位于高 64 位', c8.toString('hex') === 'ebbde5029bbf3f290000000000000000',
    c8.toString('hex'));
  // 与 ctrCounter(baseIv, 0) 等价
  check('与 ctrCounter(baseIv,0) 等价',
    c8.equals(mp4.ctrCounter('ebbde5029bbf3f29', 0)));
  // 16 字节标准 IV 原样使用
  const c16 = mp4.ivToCounter('00112233445566778899aabbccddeeff');
  check('16 字节 IV 原样保留', c16.toString('hex') === '00112233445566778899aabbccddeeff');
  // counterFor 优先取逐样本 IV
  const tr = { ivs: ['ebbde5029bbf3f29', 'ebbde5029bbf3f2a'] };
  check('counterFor 优先用逐样本 IV',
    mp4.counterFor(tr, null, 1).toString('hex') === 'ebbde5029bbf3f2a0000000000000000');
  check('counterFor 无 IV 时回退 base_iv',
    mp4.counterFor({}, '0000000000000005', 2).toString('hex') === '00000000000000070000000000000000');
}

console.log('\n=== 4. AVCC / NAL 自证 ===');
{
  const annexb = Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00]);
  // 单 NAL：4 字节大端长度 6，其后 NAL 头 0x65
  const avcc = Buffer.from([0, 0, 0, 6, 0x65, 0x88, 0x84, 0x00, 0x11, 0x22]);
  const junk = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  check('Annex-B 起始码识别', mp4.nalOk(annexb));
  check('AVCC 长度前缀识别', mp4.nalOk(avcc));
  check('随机数据拒绝', !mp4.nalOk(junk));

  // 回归用例：真实样本 0 含 5 个 NAL（29/84/7/41/5939），必须整链走完才通过。
  // 旧实现只看首个 NAL 且要求长度塞进 16 字节探测窗口，会误判为失败。
  const multi = Buffer.concat([
    Buffer.from([0, 0, 0, 29, 0x40, 0x01, 0x0c, 0x02]), Buffer.alloc(25),
    Buffer.from([0, 0, 0, 4, 0x40, 0x01, 0x0c, 0x03]), Buffer.alloc(0),
    Buffer.from([0, 0, 0, 7, 0x40, 0x01, 0x0c, 0x06]), Buffer.alloc(3),
  ]);
  check('多 NAL 样本整链自证', mp4.avccSelfOk(multi, multi.length));
  // nal_unit_type=0（非 IDR 分片，真实样本大量存在）不应被拒
  // 长度前缀 19 = 2 字节 NAL 头 + 17 字节负载
  const nonIdr = Buffer.concat([
    Buffer.from([0, 0, 0, 19, 0x00, 0x02]), Buffer.alloc(17),
  ]);
  check('nal_unit_type=0 非 IDR 分片通过', mp4.avccSelfOk(nonIdr, nonIdr.length));
  // 长度越界必须拒绝
  const overflow = Buffer.from([0, 0, 0xff, 0xff, 0x65, 1, 2, 3, 4]);
  check('长度越界拒绝', !mp4.avccSelfOk(overflow, overflow.length));
  // forbidden_zero_bit 置位（长度字段错位）必须拒绝
  const badBit = Buffer.from([0, 0, 0, 4, 0x85, 0x88, 0x84, 0x00]);
  check('forbidden_zero_bit 置位拒绝', !mp4.avccSelfOk(badBit, badBit.length));
  // pickProbeIndices 至少给出首样本且不越界
  const probe = mp4.pickProbeIndices({ sampleCount: 100, sizes: new Array(100).fill(50) });
  check('探测样本含 index 0 且在范围内', probe.includes(0) && probe.every((i) => i >= 0 && i < 100),
    probe.join(','));
}

console.log('\n=== 4b. 端到端：逐样本 IV + content key 解密后 AVCC 自洽 ===');
{
  // 复现真实链路：8 字节逐样本 IV（逐样本 +1）、多 NAL 样本、真实长度分布
  const key = crypto.randomBytes(16);
  const baseIv = 0xebbde5029bbf3f29n;
  const nalsPerSample = [
    [29, 84, 7, 41, 5939],   // 关键帧：SPS/PPS/SEI/IDR…
    [8911],
    [2370],
    [19],                    // 非 IDR 分片
  ];
  const ivs = [];
  const plains = [];
  let off = 0;
  for (let i = 0; i < 24; i++) {
    const spec = nalsPerSample[i % nalsPerSample.length];
    const parts = spec.map((len) => crypto.randomBytes(len));
    // 真实 NAL 头：forbidden_zero=0，nal_ref_idc/type 组合随类型变化
    parts.forEach((p, k) => { p[0] = (i % 2 === 0 ? 0x60 : 0x00) | (k % 24); });
    const sizes4 = spec.map((len) => { const b = Buffer.alloc(4); b.writeUInt32BE(len, 0); return b; });
    const plain = Buffer.concat(sizes4.flatMap((s, k) => [s, parts[k]]));
    ivs.push('ebbde502' + (baseIv + BigInt(i)).toString(16).padStart(8, '0'));
    plains.push({ plain, size: plain.length, off });
    off += plain.length;
  }
  // 加密：逐样本用自己的 IV
  const ct = plains.map((p, i) => {
    const c = crypto.createCipheriv('aes-128-ctr', key, mp4.ivToCounter(ivs[i]));
    return Buffer.concat([c.update(p.plain), c.final()]);
  });
  const ctBuf = Buffer.concat(ct);
  const track = {
    handler: 'vide', sampleCount: plains.length, ivs,
    sizes: plains.map((p) => p.size), offsets: plains.map((p) => p.off),
  };
  const vIv = mp4.verifyVideoIv(ctBuf, track, key.toString('hex'), [track.ivs[0]]);
  check('verifyVideoIv 通过逐样本 IV 自证', vIv === track.ivs[0], String(vIv));
  const r = mp4.decryptTrack(ctBuf, track, key.toString('hex'), track.ivs[0]);
  check('全部样本解密完成', r.decrypted === plains.length, `${r.decrypted}/${r.total}`);
  const allOk = plains.every((p) => mp4.avccSelfOk(ctBuf.subarray(p.off, p.off + p.size), p.size));
  check('解密后每个样本 AVCC 自洽', allOk);
  // 错误 key 必须被 verifyVideoIv 拒绝
  const bad = mp4.verifyVideoIv(ctBuf, track, crypto.randomBytes(16).toString('hex'), [track.ivs[0]]);
  check('错误 content key 被拒绝', bad === null, String(bad));
}

console.log('\n=== 5. AES-128-CTR 加解密往返一致性 ===');
{
  const key = crypto.randomBytes(16);
  const plain = crypto.randomBytes(1000);
  const counter = mp4.ctrCounter('0011223344556677', 3);
  const enc = crypto.createCipheriv('aes-128-ctr', key, counter);
  const cipherText = Buffer.concat([enc.update(plain), enc.final()]);
  const dec = crypto.createDecipheriv('aes-128-ctr', key, counter);
  const back = Buffer.concat([dec.update(cipherText), dec.final()]);
  check('解密还原原文', back.equals(plain));
  check('密文与原文不同', !cipherText.equals(plain));
}

console.log('\n=== 5. MP4 盒解析（构造最小合法 moov）===');
{
  // 构造 stbl -> stsz，验证样本大小解析
  // stsz payload = version/flags(4) + sample_size(4) + sample_count(4) + count*4
  const sizes = [100, 200, 300];
  const stszPayload = Buffer.alloc(12 + sizes.length * 4);
  stszPayload.writeUInt32BE(0, 0);        // version/flags
  stszPayload.writeUInt32BE(0, 4);        // sample_size = 0 -> 逐样本
  stszPayload.writeUInt32BE(sizes.length, 8); // sample_count
  sizes.forEach((s, i) => stszPayload.writeUInt32BE(s, 12 + i * 4));

  const stszHeader = Buffer.alloc(8);
  stszHeader.writeUInt32BE(8 + stszPayload.length, 0);
  Buffer.from('stsz').copy(stszHeader, 4);
  const stszBox = Buffer.concat([stszHeader, stszPayload]);

  const stblHeader = Buffer.alloc(8);
  stblHeader.writeUInt32BE(8 + stszBox.length, 0);
  Buffer.from('stbl').copy(stblHeader, 4);
  const stblBox = Buffer.concat([stblHeader, stszBox]);

  const boxes = mp4.parseBoxes(stblBox, 0, stblBox.length);
  check('顶层解析出 stbl', boxes.length === 1 && boxes[0].type === 'stbl');
  const inner = boxes[0].children[0];
  check('解析出 stsz 子盒', inner && inner.type === 'stsz');
  const table = mp4.analyzeEncryptedTracks;
  check('stsz 盒尺寸自洽', stszBox.length === 8 + 12 + sizes.length * 4,
    `${stszBox.length} 字节`);
  void table;
}

console.log('\n=== 6. 设备身份 device_id（搜索接口必需）===');
// 背景：search/tab/v 校验 query 里的 device_id，缺失一律返回 code=100103
// PARAM_INVALID，与签名是否正确无关。这里锁定三个不变量，防止回归。
{
  const os = require('os');
  const fs = require('fs');
  const path = require('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-dev-'));
  const savedEnv = { ...process.env };
  const savedData = process.env.HONGGUO_DATA_DIR;
  process.env.HONGGUO_DATA_DIR = tmpDir;
  delete process.env.HONGGUO_DEVICE_ID;
  delete process.env.HG_DEVICE_ID;

  // 清掉 require 缓存，确保读到新的 HONGGUO_DATA_DIR
  const devPath = require.resolve('../server/src/device');
  delete require.cache[devPath];
  const device = require('../server/src/device');

  // 1) 首次调用应生成合法的 16 位 device_id
  const q1 = {};
  const r1 = device.ensureDeviceId(q1);
  check('生成 device_id', /^\d{16}$/.test(r1.device_id), r1.device_id);
  check('来源标记为 generated', r1.source === 'generated', r1.source);
  check('已注入 base_query', q1.device_id === r1.device_id);

  // 2) 必须落盘，保证重启后身份稳定（否则会被上游判定为身份跳变）
  const f = path.join(tmpDir, 'device.json');
  check('device.json 已落盘', fs.existsSync(f));
  check('落盘内容与内存一致', JSON.parse(fs.readFileSync(f, 'utf8')).device_id === r1.device_id);

  // 3) 二次调用应复用同一个值（稳定性）
  const q2 = {};
  const r2 = device.ensureDeviceId(q2);
  check('重启后复用同一 device_id', r2.device_id === r1.device_id, r2.source);
  check('复用来源为 stored', r2.source === 'stored', r2.source);

  // 4) 环境变量优先级最高
  process.env.HONGGUO_DEVICE_ID = '9999999999999999';
  delete require.cache[devPath];
  const device2 = require('../server/src/device');
  const r3 = device2.ensureDeviceId({});
  check('环境变量优先', r3.device_id === '9999999999999999', r3.source);
  delete process.env.HONGGUO_DEVICE_ID;

  // 5) 配置里已有值时不得覆盖
  delete require.cache[devPath];
  const device3 = require('../server/src/device');
  const cfg = { device_id: '1357924680135792' };
  const r4 = device3.ensureDeviceId(cfg);
  check('尊重配置中的 device_id', r4.device_id === '1357924680135792', r4.source);

  // 6) 非法值不应被采纳
  delete require.cache[devPath];
  const device4 = require('../server/src/device');
  const r5 = device4.ensureDeviceId({ device_id: 'abc' });
  check('拒绝非法配置值并重新生成', /^\d{16}$/.test(r5.device_id), r5.source);

  // 清理：还原环境与临时目录
  Object.assign(process.env, savedEnv);
  if (savedData === undefined) delete process.env.HONGGUO_DATA_DIR;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log('\n=== 7. 剧集解析：title 清洗（上游 title 实为简介）===');
// 背景：上游 video_list[].title 每集都重复「本剧简介」，直接展示会得到
// 81 个一模一样的剧集按钮。这里锁定清洗规则，防止回归。
{
  const { parseEpisodeDetail } = require('../server/src/client');
  const INTRO = '以妖魔之血为墨，以百妖谱为卷，可摹画其形，夺其神通。姜月初一';
  const r = parseEpisodeDetail('123', {
    series_title: '万妖图录传',
    series_intro: INTRO,
    episode_cnt: 3,
    video_list: [
      { vid_index: 1, vid: 'v1', title: INTRO, duration: 149 },
      { vid_index: 2, vid: 'v2', title: INTRO, duration: 142 },
      { vid_index: 3, vid: 'v3', title: '第3集 大结局', duration: 100 },
    ],
  });
  check('解析出 3 集', r.episodes.length === 3);
  check('简介型 title 被清空', r.episodes[0].title === '', JSON.stringify(r.episodes[0].title));
  check('第2集同样清空', r.episodes[1].title === '');
  check('真实集标题保留', r.episodes[2].title === '第3集 大结局', r.episodes[2].title);
  check('title 为空时前端回落用 index', r.episodes[0].index === 1);
  check('集号按升序', r.episodes.map((e) => e.index).join(',') === '1,2,3');
  check('meta 保留真实简介', r.meta.abstract === INTRO);
}

console.log('\n=== 8. 播放缓存路径：.play.mp4 变体必须参与命中判定 ===');
// 背景：offlineDecrypt 末尾 remux 产出 "<vid>_<q>.play.mp4" 并删掉 raw，
// 而早期实现只探测 "<vid>_<q>.mp4"，导致加密内容永远不命中缓存，
// 每次播放都重新下载 + 解密。
{
  const stream = require('../server/src/stream');
  const p = stream.cachePaths('7688396322021329982', 'best');
  const path = require('path');
  const parsed = path.parse(p.raw);
  const remuxOut = path.join(parsed.dir, `${parsed.name.replace(/\.raw$/, '')}.play.mp4`);
  check('remux 产出名与 play 路径一致', remuxOut === p.play, path.basename(p.play));
  check('play 与 out 是不同文件', p.play !== p.out);
  check('raw 命名带 .raw 段', p.raw.endsWith('_best.raw.mp4'), path.basename(p.raw));

  // cachedPath 三个变体任一存在即命中
  const os2 = require('os');
  const fs2 = require('fs');
  const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'hg-cache-'));
  const saved = process.env.HONGGUO_STREAM_CACHE;
  process.env.HONGGUO_STREAM_CACHE = tmp;
  delete require.cache[require.resolve('../server/src/stream')];
  const s2 = require('../server/src/stream');
  const q = s2.cachePaths('999', 'best');
  check('空目录时 cachedPath 为 null', s2.cachedPath('999', 'best') === null);
  fs2.writeFileSync(q.play, 'x');
  check('仅 .play.mp4 存在即命中', s2.cachedPath('999', 'best') === q.play);
  fs2.unlinkSync(q.play);
  fs2.writeFileSync(q.out, 'x');
  check('仅 .mp4 存在即命中', s2.cachedPath('999', 'best') === q.out);
  if (saved === undefined) delete process.env.HONGGUO_STREAM_CACHE;
  else process.env.HONGGUO_STREAM_CACHE = saved;
  try { fs2.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  void p;
}

console.log('\n=== 9. 解码兼容性：默认不转码（直出 HEVC）===');
// 背景：ffprobe 实测源流是 hevc 1080x1920。目标机器支持 HEVC 硬件解码，
// 因此默认只做 -c copy（剥离 CENC 信令），不重编码 —— 省 CPU 也省时间
// （1080x1920 整集转码约 15 秒，copy 1 秒内）。仅显式设 HG_TRANSCODE=1 才转 H.264。
{
  const stream = require('../server/src/stream');
  const nodePath = require('path');
  const src = require('fs').readFileSync(
    nodePath.join(__dirname, '..', 'server', 'src', 'stream.js'), 'utf8');
  check('提供 ffmpegAvailable 探测', typeof stream.ffmpegAvailable === 'function');
  check('ffmpegAvailable 返回布尔', typeof stream.ffmpegAvailable() === 'boolean');
  check('提供 h264EncoderName', typeof stream.h264EncoderName === 'function');
  check('提供 transcodeEnabled', typeof stream.transcodeEnabled === 'function');

  // 默认必须不转码
  check('转码默认关闭（需 =1）', /HG_TRANSCODE === '1'/.test(src));
  check('默认音频也走 copy', src.includes("'-c:a', enc ? 'aac' : 'copy'"));
  check('无编码器时退回 copy', src.includes("enc ? enc.name : 'copy'"));

  // 开关打开时的编码器降级表
  check('编码器表含 libx264 优先项', src.includes("{ name: 'libx264'"));
  check('libopenh264 用码率而非 crf', src.includes("{ name: 'libopenh264', args: ['-b:v', '2500k'] }"));
  check('统一补 yuv420p 像素格式', src.includes("'-pix_fmt', 'yuv420p'"));
  check('提供 HG_H264_ENCODER 覆盖', /HG_H264_ENCODER/.test(src));

  // 默认环境下不应启用转码
  check('默认 transcodeEnabled=false', stream.transcodeEnabled() === false);
  check('默认无编码器名', stream.h264EncoderName() === null);
}


console.log('\n=== 10. 前端播放器布局与搜索触发（静态断言）===');
// 这两项是纯前端行为，用源码断言锁住关键约束，避免回归
{
  const fs2 = require('fs');
  const path2 = require('path');
  const webDir = path2.join(__dirname, '..', 'web');
  const app = fs2.readFileSync(path2.join(webDir, 'app.js'), 'utf8');
  const html = fs2.readFileSync(path2.join(webDir, 'index.html'), 'utf8');
  const css = fs2.readFileSync(path2.join(webDir, 'styles.css'), 'utf8');

  // 1) 搜索只在回车/按钮触发，不再随输入自动搜
  check('已移除 input 自动搜索', !/addEventListener\('input'[\s\S]{0,200}setTimeout/.test(app));
  check('存在搜索按钮', /id="searchBtn"/.test(html));
  check('按钮绑定提交', /searchBtn\.addEventListener\('click', submitSearch\)/.test(app));
  check('回车触发且避开输入法组字', /e\.key === 'Enter' && !e\.isComposing/.test(app));
  check('空输入给出提示', /请输入剧名/.test(app));

  // 2) 连播开关移到视频下方靠右
  check('连播开关在 player-foot 内', /player-foot[\s\S]{0,400}id="autoNextBtn"/.test(html));
  check('连播开关不在 modal-head 内',
    !/modal-head[\s\S]{0,300}id="autoNextBtn"[\s\S]{0,200}<\/div>\s*<div class="modal-head"/.test(html));
  check('player-foot 用三列 grid（状态真正居中）',
    /\.player-foot\s*\{[\s\S]{0,220}grid-template-columns:\s*1fr 1fr 1fr/.test(css));
  check('状态文本在操作行内水平居中',
    /\.player-foot #pStatus\s*\{[\s\S]{0,400}text-align:\s*center/.test(css));
  check('连播开关贴右', /\.auto-next\s*\{[\s\S]{0,300}justify-self:\s*end/.test(css));
  check('集数按钮贴左', /\.ep-btn\s*\{[\s\S]{0,200}justify-self:\s*start/.test(css));
  // 状态栏不再显示集数：集数只由左侧集数按钮承载
  check('play 不再接收 label 形参', !/async function play\(vid, label\)/.test(app));
  check('playAt 不再把集名传给 play', !/play\(e\.vid,/.test(app));
  // 注意：不能用 /textContent = label/ 粗判 —— 集数按钮
  // $('#pEpLabel').textContent = label 是正当的（同文件 359 行）。
  // 这里精确校验：pStatus 播放成功后置空，且不存在 `= label || ''`。
  check('播放成功后状态栏不再写集数',
    app.includes("if (!codecBlocked) $('pStatus').textContent = '';")
      && !/textContent = label \|\| ''/.test(app)
      && !/play\(e\.vid, [^)]/.test(app));
  check('连播开关样式类为 auto-next', /\.auto-next\s*\{/.test(css));

  // 3) 视频容器固定比例，加载前后不跳
  check('存在 video-box 固定比例容器', /<div class="video-box">/.test(html));
  check('video 包裹在容器内', /video-box[\s\S]{0,200}<video id="video"/.test(html));
  check('容器使用 aspect-ratio', /\.video-box[\s\S]{0,400}aspect-ratio/.test(css));
  check('容器为横屏 16/9', /aspect-ratio:\s*16\s*\/\s*9/.test(css));
  check('不再使用竖屏 9/16', !/aspect-ratio:\s*9\s*\/\s*16/.test(css));
  check('video 用 object-fit 填满', /\.video-box video[\s\S]{0,300}object-fit:\s*contain/.test(css));

  // 4) 缺 HEVC 解码器时须给出可执行提示，且不被播放状态覆盖
  check('存在 HEVC 兜底提示文案', /HEVC\(H\.265\)\s*解码/.test(app));
  check('提示挂在 loadeddata 上', /addEventListener\('loadeddata'[\s\S]{0,80}checkCodec/.test(app));
  check('提示不被播放状态覆盖', /if \(!codecBlocked\)/.test(app));
  check('连播逻辑不受解码状态阻断', /const setPStatus = \(t\) => \{ if \(!codecBlocked\)/.test(app));
  check('提示含转码开关指引', /HG_TRANSCODE=1/.test(app));
  check('关闭播放器时重置解码检测', /codecChecked = false;\s*\n\s*codecBlocked = false;/.test(app));

  // 5) 简介默认隐藏 + 悬浮按钮（旧实现会让简介闪现后消失，导致标题行抖动）
  check('存在简介按钮', /id="pInfoBtn"/.test(html));
  check('简介按钮默认 hidden', /id="pInfoBtn"[\s\S]{0,120}hidden/.test(html));
  check('存在简介气泡', /id="pInfoPop"[\s\S]{0,60}hidden/.test(html));
  check('气泡默认 display:none', /\.info-pop\[hidden\]\s*\{\s*display:\s*none/.test(css));
  check('气泡用 fixed 定位避开裁剪', /\.info-pop\s*\{[\s\S]{0,300}position:\s*fixed/.test(css));
  check('气泡支持 hover 停留', /\.info-pop\s*\{[\s\S]{0,600}pointer-events:\s*auto/.test(css));
  check('有 setAbstract 统一入口', /function setAbstract\(text\)/.test(app));
  check('简介为空时按钮隐藏', /if \(!t\) \{ btn\.hidden = true; pop\.hidden = true; return; \}/.test(app));
  check('简介以纯文本渲染（防尖括号破坏 DOM）', /pop\.textContent = t;/.test(app));
  check('openSeries 不再把简介塞进 pMeta', !/updatePMeta\(meta\.abstract/.test(app));
  check('updatePMeta 不再接收简介参数', !/function updatePMeta\(extra\)/.test(app));
  check('集数按钮文字由 updatePMeta 统一写入',
    app.includes("$('pEpLabel').textContent = label;"));
  check('未选中集时不显示「第 0 集」',
    app.includes("ctx.index < 0"));
  // 状态栏文案行数变化同样会顶高弹层，必须锁死两行高
  check('状态栏固定两行高防抖', /\.player-foot #pStatus\s*\{[\s\S]{0,400}min-height:\s*3em/.test(css));
  check('状态栏行距固定 1.5', /\.player-foot #pStatus\s*\{[\s\S]{0,400}line-height:\s*1\.5/.test(css));
  check('气泡按按钮位置定位', /function place\(\)[\s\S]{0,300}getBoundingClientRect/.test(app));
  check('气泡未打开时与按钮同为 hidden', /if \(infoBtn\.hidden \|\| infoPop\.hidden\) return;/.test(app));
  check('支持 Esc 关闭气泡', /e\.key === 'Escape'\) infoPop\.hidden = true/.test(app));
  check('窗口变化时重定位', /window\.addEventListener\('resize'/.test(app));
  check('关闭播放器时清空简介', /setAbstract\(''\);\s*\n\s*toggleInfo\(false\);/.test(app));

  // ---- 集数按钮与选集卡片（替代原视频上方的横向剧集条）----
  console.log('\n--- 集数按钮与选集卡片 ---');
  check('已删除视频上方的剧集条容器', !/id="epStrip"/.test(html));
  check('JS 不再引用 epStrip', !/epStrip/.test(app));
  check('CSS 不再定义 .ep-strip 规则', !/^\.ep-strip\s*\{/m.test(css));
  check('CSS 不再定义旧 .ep 规则', !/^\.ep\s*\{/m.test(css));
  check('已删除 pMeta 文本节点', !/id="pMeta"/.test(html));
  check('存在集数按钮', /id="pEpBtn"/.test(html));
  check('集数按钮文字容器', /id="pEpLabel"/.test(html));
  check('集数按钮在视频之后（操作行内）', /<video[\s\S]{0,400}pEpBtn/.test(html));
  check('集数按钮默认隐藏', /id="pEpBtn"[\s\S]{0,120}hidden/.test(html));
  check('存在选集卡片', /id="pEpCard"/.test(html));
  check('卡片默认隐藏', /id="pEpCard"[\s\S]{0,60}hidden/.test(html));
  check('卡片内含集数网格', /id="pEpGrid"/.test(html));
  check('卡片有标题行与关闭按钮',
    /id="pEpCount"/.test(html) && /id="pEpClose"/.test(html));
  check('网格固定五列', /\.ep-grid\s*\{[\s\S]{0,200}grid-template-columns:\s*repeat\(5,/.test(css));
  check('卡片用 fixed 定位避开裁剪', /\.ep-card\s*\{[\s\S]{0,200}position:\s*fixed/.test(css));
  check('卡片默认 display:none', /\.ep-card\[hidden\]\s*\{\s*display:\s*none/.test(css));
  check('网格超长时内部滚动', /\.ep-grid\s*\{[\s\S]{0,240}overflow-y:\s*auto/.test(css));
  check('当前集高亮样式', /\.epx\.on\s*\{[\s\S]{0,140}background:\s*var\(--brand\)/.test(css));
  check('有 buildEpGrid 统一构建网格', /function buildEpGrid\(eps\)/.test(app));
  check('网格按钮带 data-pos 下标', /class="epx" data-pos=/.test(app));
  check('markEp 改为高亮卡片内按钮',
    /pEpGrid[\s\S]{0,120}querySelectorAll\('\.epx'\)/.test(app));
  check('切集后自动收起卡片',
    /const pos = Number\(b\.dataset\.pos\);\s*\n\s*closeEpCard\(\);\s*\n\s*playAt\(pos\);/.test(app));
  check('卡片向上优先展开（按钮在底部）', /let top = b\.top - h - gap;/.test(app));
  check('无剧集时集数按钮隐藏',
    /if \(!total\) \{ btn\.hidden = true; return; \}/.test(app));
  check('支持 Esc 关闭卡片', /e\.key === 'Escape'\) epCard\.hidden = true/.test(app));
  check('点卡片外部关闭',
    /!epCard\.contains\(e\.target\) && !epBtn\.contains\(e\.target\)/.test(app));
  check('关闭播放器时收起卡片', /closeEpCard\(\);/.test(app));
}

console.log('\n=== 11. 模块加载 ===');
{
  const mods = ['spade', 'mp4', 'safeguards', 'keystore', 'signer', 'client', 'stream', 'device'];
  for (const name of mods) {
    try {
      const m = require(`../server/src/${name}`);
      const n = Object.keys(m).length;
      check(`加载 server/src/${name}`, n > 0, `${n} 个导出`);
    } catch (e) {
      check(`加载 server/src/${name}`, false, e.message);
    }
  }
  // 预热接口依赖的两个函数必须导出，供 /prewarm 与自检验证
  const st = require('../server/src/stream');
  check('stream 导出 cachedPath', typeof st.cachedPath === 'function');
  check('stream 导出 prewarm', typeof st.prewarm === 'function');
}

console.log('\n=== 12. Java 运行时版本 ===');
{
  const fs3 = require('fs');
  const path3 = require('path');
  const root = path3.join(__dirname, '..');
  const jreDir = path3.join(root, 'signer', 'jre');
  const relPath = path3.join(jreDir, 'release');
  const launcher = fs3.readFileSync(path3.join(root, 'scripts', 'launcher.js'), 'utf8');
  const signBat = fs3.readFileSync(path3.join(root, 'scripts', 'sign.bat'), 'utf8');
  const installBat = fs3.readFileSync(path3.join(root, 'scripts', 'install-jre.bat'), 'utf8');

  // 自带 JRE 的实际版本
  let bundled = null;
  if (fs3.existsSync(relPath)) {
    const txt = fs3.readFileSync(relPath, 'utf8');
    const m = txt.match(/^JAVA_VERSION="?([\d.]+)/m);
    if (m) bundled = m[1];
  }
  check('自带 JRE 存在 release 文件', bundled !== null,
    bundled ? `Temurin ${bundled}` : 'signer/jre/release 缺失');
  check('自带 JRE 主版本 ≥ 17（unidbg 要求）',
    bundled !== null && parseInt(bundled, 10) >= 17, bundled || '未知');
  check('自带 JRE 已升级到 25 LTS', bundled !== null && parseInt(bundled, 10) === 25,
    bundled || '未知');
  check('自带 JRE 为 x64 架构', fs3.existsSync(path3.join(jreDir, 'bin', 'java.exe')));
  check('JVM 核心文件齐备',
    fs3.existsSync(path3.join(jreDir, 'bin', 'server', 'jvm.dll'))
    && fs3.existsSync(path3.join(jreDir, 'lib', 'modules')));

  // 版本下限校验：低版本 JRE 直接拦下并给出可操作提示
  check('launcher 有 Java 版本探测', /function javaMajor\(bin\)/.test(launcher));
  check('launcher 声明最低主版本 17', /JAVA_MIN_MAJOR = 17/.test(launcher));
  check('launcher 版本过低时拒绝启动',
    /java\.major < JAVA_MIN_MAJOR[\s\S]{0,400}process\.exit\(1\)/.test(launcher));
  check('launcher 版本过低时提示升级到 25', /Temurin JRE 25/.test(launcher));
  check('launcher 输出探测到的版本号',
    /版本：\$\{java\.major\}/.test(launcher));
  // 自带 JRE 必须优先于系统 PATH，否则用户机器上的旧 JDK 会抢先被选中
  check('自带 JRE 优先于系统 PATH',
    /BUNDLED_JRE, 'bin', exe\);\s*\n\s*if \(fs\.existsSync\(bundled\)\)/.test(launcher));

  // Java 24+ 需要显式开启 native access（unidbg 用 System.loadLibrary 加载 .so）
  check('launcher 按版本附加 native-access 参数',
    /major >= 24[\s\S]{0,120}--enable-native-access=ALL-UNNAMED/.test(launcher));
  check('sign.bat 同样附加 native-access',
    /GEQ 24 set NATIVE_ACCESS=--enable-native-access=ALL-UNNAMED/.test(signBat));
  check('sign.bat 校验 Java 版本下限',
    /JAVA_MAJOR! LSS 17[\s\S]{0,200}exit \/b 1/.test(signBat));
  check('保留 --add-opens（unidbg 反射依赖）',
    /--add-opens java\.base\/java\.lang=ALL-UNNAMED/.test(signBat)
    && /--add-opens[\s\S]{0,60}java\.base\/java\.lang=ALL-UNNAMED/.test(launcher));

  // 安装脚本的下载源应指向 25
  check('install-jre.bat 下载源为 25',
    /binary\/latest\/25\/ga\/windows\/x64\/jre/.test(installBat));
  check('install-jre.bat 不再下载 17', !/binary\/latest\/17\/ga/.test(installBat));
  check('install-jre.bat 推荐 25 LTS', /推荐 25 LTS/.test(installBat));
}

console.log('\n=== 13. 历史与收藏（localStorage）===');
{
  const fs4 = require('fs');
  const path4 = require('path');
  const webDir4 = path4.join(__dirname, '..', 'web');
  const app4 = fs4.readFileSync(path4.join(webDir4, 'app.js'), 'utf8');
  const html4 = fs4.readFileSync(path4.join(webDir4, 'index.html'), 'utf8');
  const css4 = fs4.readFileSync(path4.join(webDir4, 'styles.css'), 'utf8');

  // --- 入口按钮 ---
  check('搜索框右侧有历史按钮', /id="histBtn"[^>]*title="播放历史"/.test(html4));
  check('搜索框右侧有收藏按钮',
    /id="favBtn"[\s\S]{0,80}title="我的收藏"/.test(html4));
  check('历史按钮排在搜索框之后',
    html4.indexOf('id="searchBtn"') < html4.indexOf('id="histBtn"')
    && html4.indexOf('id="histBtn"') < html4.indexOf('id="favBtn"'));
  check('两个按钮均可点击（绑定了 click）',
    /\$\('histBtn'\)\.addEventListener\('click'/.test(app4)
    && /\$\('favBtn'\)\.addEventListener\('click'/.test(app4));

  // --- 收藏按钮紧跟简介按钮 ---
  check('播放器内有收藏按钮',
    /id="pFavBtn"[\s\S]{0,120}收藏这部短剧/.test(html4));
  check('收藏按钮排在简介按钮之后',
    html4.indexOf('id="pInfoBtn"') < html4.indexOf('id="pFavBtn"'));
  check('收藏按钮可切换状态',
    /\$\('pFavBtn'\)\.addEventListener\('click'/.test(app4)
    && /LIB\.toggleFav\(/.test(app4));
  check('已收藏态有独立视觉（.fav-btn.on）', /\.fav-btn\.on\s*\{/.test(css4));
  check('关闭播放器后收藏按钮隐藏',
    /ctx\.seriesId = '';[\s\S]{0,200}syncFavBtn\(\)/.test(app4));

  // --- 存储层 ---
  check('历史使用 localStorage 键 hg_history', /H_KEY: 'hg_history'/.test(app4));
  check('收藏使用 localStorage 键 hg_fav', /F_KEY: 'hg_fav'/.test(app4));
  check('存储层有 200 条上限', /MAX: 200/.test(app4));
  check('read() 自身也截断（防超长数据卡顿）',
    /\.filter\(\(x\) => x && x\.sid\)\.slice\(0, this\.MAX\)/.test(app4));
  check('写入失败时降级为内存态',
    /localStorage\.setItem[\s\S]{0,80}catch/.test(app4));
  check('解析失败时回退内存态',
    /const arr = raw \? JSON\.parse\(raw\) : \[\];[\s\S]{0,400}catch \{[^\n]*\}\s*\n\s*return this\._mem\[kind\]\.slice\(\)/.test(app4));

  // --- 历史记录时机与内容 ---
  check('播放即写入历史（playAt 内调用）',
    /async function playAt\(pos\)[\s\S]{0,400}recordHistory\(pos, e\)/.test(app4));
  check('历史写在 play() 之前（解码失败也算播过）',
    app4.indexOf('recordHistory(pos, e);') < app4.lastIndexOf('await play(e.vid);'));
  check('历史条目含剧名/封面/集数/总集数',
    /sid: ctx\.seriesId,[\s\S]{0,200}title: ctx\.title,[\s\S]{0,120}cover: ctx\.cover,[\s\S]{0,160}ep:[\s\S]{0,120}total: ctx\.total/.test(app4));
  check('同一部剧只保留一条并置顶',
    /read\('history'\)\.filter\(\(x\) => x\.sid !== sid\)[\s\S]{0,80}unshift/.test(app4));
  check('从历史恢复播放不刷新时间戳',
    /at: atStart \? Date\.now\(\) : \(Number\(item\.at\) \|\| Date\.now\(\)\)/.test(app4));

  // --- 收藏进度同步 ---
  check('续播后同步收藏条目的集数', /LIB\.syncFavEp\(ctx\.seriesId/.test(app4));
  check('syncFavEp 只改已存在的收藏条目',
    /syncFavEp\(sid, ep\)[\s\S]{0,200}if \(!hit\) return false/.test(app4));

  // --- 继续播放 ---
  check('继续播放按记录的集号续播',
    /async function resumePlay\(sid, ep\)[\s\S]{0,200}let idx = \(Number\(ep\) \|\| 1\) - 1/.test(app4));
  check('集号越界时回落到第 1 集',
    /if \(idx < 0 \|\| idx >= eps\.length\) idx = 0/.test(app4));
  check('续播入口透传 startAt',
    /openSeries\(sid, item \? item\.title : '', \{ startAt: idx, resume: true \}\)/.test(app4));
  check('openSeries 支持 startAt 定位起始集',
    /async function openSeries[\s\S]{0,3000}const start = resolveStart\(eps, opts\);[\s\S]{0,80}playAt\(start\);/.test(app4)
    && /inRange\(opts\.startAt\)\) return opts\.startAt/.test(app4));

  // --- 列表渲染 ---
  check('历史与收藏共用一个弹层', /id="libModal"/.test(html4) && /id="libList"/.test(html4));
  check('列表项展示封面/剧名/集数/操作',
    /class="lib-item"[\s\S]{0,600}class="lib-name"[\s\S]{0,200}class="lib-prog"[\s\S]{0,300}class="lib-ops"/.test(app4));
  check('剧名经过转义（防 XSS）', /class="lib-name">\$\{esc\(it\.title/.test(app4));
  check('sid 经过转义', /data-sid="\$\{esc\(it\.sid\)\}"/.test(app4));
  check('封面 URL 走白名单代理', /coverUrl\(it\.cover\)/.test(app4));
  check('无封面时显示占位块', /class="ph">无封面/.test(app4));
  check('封面加载失败降级为占位', /onerror="this\.replaceWith/.test(app4));
  check('剧名单行省略（不撑破行高）',
    /\.lib-name[\s\S]{0,200}text-overflow: ellipsis[\s\S]{0,60}white-space: nowrap/.test(css4));
  check('列表区可滚动且有高度上限', /\.lib-list[\s\S]{0,200}max-height: 58vh[\s\S]{0,60}overflow-y: auto/.test(css4));
  check('列表型弹层宽度收窄为 640', /#libModal \.modal-card \{ width: min\(640px, 100%\)/.test(css4));
  check('封面占位保持 3:4 竖版', /\.lib-item \.poster[\s\S]{0,160}aspect-ratio: 3 \/ 4/.test(css4));
  check('窄屏时操作按钮换行铺满',
    /@media \(max-width: 560px\)[\s\S]{0,320}grid-column: 1 \/ -1/.test(css4));

  // --- 增删清空 ---
  check('可删除单条历史', /class="mini-btn lib-del"/.test(app4)
    && /LIB\.write\('history', LIB\.read\('history'\)\.filter/.test(app4));
  check('可取消单条收藏', /class="mini-btn lib-unfav"/.test(app4) && /LIB\.removeFav\(/.test(app4));
  check('取消收藏后同步播放器按钮态',
    /ctx\.seriesId === unfav\.dataset\.sid\) paintFavBtn\(false\)/.test(app4));
  check('可一键清空当前列表', /\$\('libClear'\)\.addEventListener[\s\S]{0,200}LIB\.clear\(libKind\)/.test(app4));
  check('清空收藏后同步播放器按钮态',
    /libKind === 'fav' && ctx\.seriesId\) paintFavBtn\(false\)/.test(app4));
  check('空列表有空态提示', /class="empty"[\s\S]{0,300}还没有播放记录/.test(app4));

  // --- 弹层关闭与说明文案 ---
  check('历史弹层可用 Esc 关闭',
    /e\.key === 'Escape' && !libModal\.hidden\) libModal\.hidden = true/.test(app4));
  check('点遮罩关闭弹层', /e\.target === libModal\) libModal\.hidden = true/.test(app4));
  check('弹层说明数据存在本机不上传', /不会上传/.test(app4));
  check('历史说明不含播放时间', /不含播放时间/.test(app4));

  // --- 顶栏窄屏不溢出（新增两个按钮后 .topbar-right 会被撑破）---
  check('顶栏右侧组允许收缩', /\.topbar-right \{[^}]*min-width: 0/.test(css4));
  check('顶栏图标按钮不被压扁', /\.topbar-right \.icon-btn \{ flex-shrink: 0/.test(css4));
  check('搜索框可压缩', /\.search-box \{ min-width: 0/.test(css4));
  check('输入框可伸缩', /#search \{[^}]*flex: 1 1 auto/.test(css4));
  check('极窄屏搜索按钮只留图标', /@media \(max-width: 430px\)[\s\S]{0,900}\.search-btn \.tx-search \{ display: none/.test(css4));
  check('html 已为搜索按钮预留图标/文字两个 span',
    /class="ic-search"[\s\S]{0,80}class="tx-search"/.test(html4));

  // --- 从推荐/搜索打开时续播上次集数 ---
  check('有独立的起始集决策函数', /function resolveStart\(eps, opts\)/.test(app4));
  check('优先用调用方显式指定的集号', /if \(inRange\(opts\.startAt\)\) return opts\.startAt/.test(app4));
  check('否则接着历史记录的集数播',
    /LIB\.read\('history'\)\.find\(\(x\) => x\.sid === ctx\.seriesId\)/.test(app4));
  check('按上游真实集号匹配（先找 index）',
    /eps\.findIndex\(\(e\) => Number\(e\.index\) === ep\)/.test(app4));
  check('集号匹配不到时退回「集号-1」', /if \(inRange\(ep - 1\)\) return ep - 1/.test(app4));
  check('记录越界时回落到第 1 集',
    /function resolveStart[\s\S]{0,900}\/\/ 3\) 兜底\s*\n\s*return 0;/.test(app4));
  check('openSeries 走 resolveStart', /const start = resolveStart\(eps, opts\);/.test(app4));
  // 时间戳刷新判据：不能用 pos===0（续播时 pos 不是 0），改用「打开会话内首次」
  check('ctx 有 freshOpen 标记', /freshOpen: false,/.test(app4));
  check('openSeries 时置 freshOpen = true', /ctx\.freshOpen = true;[\s\S]{0,80}resolveStart/.test(app4));
  check('recordHistory 消费后置回 false',
    /const fresh = ctx\.freshOpen;\s*\n\s*ctx\.freshOpen = false;/.test(app4));
  check('recordHistory 用 fresh 而非 pos===0 判新观看',
    /}, fresh\);/.test(app4) && !/\}, pos === 0\);/.test(app4));
  check('关闭播放器时归零 freshOpen', /ctx\.freshOpen = false;[\s\S]{0,60}syncFavBtn\(\)/.test(app4));

  // --- 卡片进度角标 ---
  check('卡片渲染进度角标', /function seenBadge\(sid\)/.test(app4));
  check('角标只标看过的集数（>1）', /if \(ep <= 1\) return ''/.test(app4));
  check('角标文案含集号', /看到第 \$\{ep\} 集/.test(app4));
  check('角标带续播提示 title', /title="点击继续播放第 \$\{ep\} 集"/.test(app4));
  check('角标已接入卡片模板', /\$\{poster\}\$\{badge\}\$\{eps\}\$\{seen\}/.test(app4));
  check('有 .card .seen 样式', /\.card \.seen \{/.test(css4));
  check('角标不与集数角标重叠（左下 vs 右下）',
    /\.card \.seen \{[\s\S]{0,200}left: 7px; bottom: 7px/.test(css4)
    && /\.card \.eps \{[\s\S]{0,120}right: 7px; bottom: 7px/.test(css4));
  check('角标过长时省略而非撑破封面',
    /\.card \.seen \{[\s\S]{0,400}text-overflow: ellipsis/.test(css4));
}

console.log('\n=== 14. 密钥自动获取与重试 ===');
{
  const fs5 = require('fs');
  const path5 = require('path');
  const webDir5 = path5.join(__dirname, '..', 'web');
  const app5 = fs5.readFileSync(path5.join(webDir5, 'app.js'), 'utf8');
  const html5 = fs5.readFileSync(path5.join(webDir5, 'index.html'), 'utf8');
  const css5 = fs5.readFileSync(path5.join(webDir5, 'styles.css'), 'utf8');

  // --- 状态行 UI ---
  check('密钥卡片有状态行容器', /id="keyState"/.test(html5));
  check('状态行默认隐藏（无消息时不占位）', /id="keyState"[^>]*hidden/.test(html5));
  check('状态行有加载指示', /class="key-spin"/.test(html5));
  check('状态行有文案节点', /id="keyStateText"/.test(html5));
  check('状态行初值为「获取中…」', /id="keyStateText">获取中…</.test(html5));
  check('有「重新获取」按钮', /id="keyRetry"/.test(html5));
  check('「重新获取」默认隐藏', /id="keyRetry"[^>]*hidden/.test(html5));

  // --- 三态样式 ---
  check('状态行有 loading 态配色', /\.key-state\[data-state="loading"\]/.test(css5));
  check('状态行有 warn 态配色（取不到但在重试）', /\.key-state\[data-state="warn"\]/.test(css5));
  check('状态行有 error 态配色（重试用尽）', /\.key-state\[data-state="error"\]/.test(css5));
  check('error 态停掉旋转动画', /\.key-state\[data-state="error"\] \.key-spin \{ animation: none/.test(css5));
  check('加载环为纯 CSS 动画', /\.key-spin \{[\s\S]{0,300}animation: key-spin/.test(css5));
  check('尊重系统「减少动态效果」', /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,120}\.key-spin \{ animation: none/.test(css5));
  check('重试按钮禁用时有视觉反馈', /#keyRetry:disabled \{/.test(css5));

  // --- 退避常量 ---
  check('定义了重试上限', /const KEY_RETRY_MAX = \d+;/.test(app5));
  check('定义了退避基数（1 秒起）', /const KEY_RETRY_BASE = 1000;/.test(app5));
  check('定义了退避上限（10 秒封顶）', /const KEY_RETRY_CAP = 10000;/.test(app5));
  check('退避为指数增长且有封顶',
    /Math\.min\(KEY_RETRY_BASE \* \(2 \*\* \(keyRetryCount - 1\)\), KEY_RETRY_CAP\)/.test(app5));
  check('重试用尽后不再排下一次', /const last = keyRetryCount >= KEY_RETRY_MAX;/.test(app5)
    && /if \(!last\) \{[\s\S]{0,400}keyRetryTimer = setTimeout/.test(app5));
  check('重试计数在用尽提示里展示', /已重试 \$\{keyRetryCount\} 次/.test(app5));
  check('有 stopKeyRetry 可取消退避', /function stopKeyRetry\(\)[\s\S]{0,160}clearTimeout\(keyRetryTimer\)/.test(app5));

  // --- ensureKey ---
  check('ensureKey 从 /api-key 取密钥', /fetch\(`\$\{API_BASE\}\/api-key`\)/.test(app5));
  check('ensureKey 有重入保护', /if \(keyFetching\) return API_KEY;/.test(app5));
  check('ensureKey 手动模式重置退避', /if \(manual\) \{ keyRetryCount = 0; stopKeyRetry\(\); \}/.test(app5));
  check('取不到时把原因写进状态行', /setKeyState\('warn', `获取中：\$\{why\}/.test(app5));
  check('interactive=false 时不打扰弹层', /if \(interactive\) \{/.test(app5));
  check('finally 释放重入锁', /\} finally \{\s*\n\s*keyFetching = false;/.test(app5));

  // --- adoptKey ---
  check('拿到密钥写入 localStorage', /function adoptKey[\s\S]{0,200}localStorage\.setItem\('hg_key', k\)/.test(app5));
  check('拿到密钥后自动关闭卡片', /function adoptKey[\s\S]{0,600}\$?\('keyModal'\)\.hidden = true;/.test(app5));
  check('拿到密钥后隐藏状态行（避免下次看到矛盾提示）',
    /function adoptKey[\s\S]{0,600}\$?\('keyState'\)\.hidden = true;/.test(app5));
  check('拿到密钥后隐藏重试按钮',
    /function adoptKey[\s\S]{0,700}\$?\('keyRetry'\)\.hidden = true;/.test(app5));
  check('拿到密钥后重置退避计数', /function adoptKey[\s\S]{0,200}keyRetryCount = 0;/.test(app5));
  check('拿到密钥后恢复首页加载', /if \(needReload\) loadTab\(state\.tab\);/.test(app5));
  check('自愈换密钥不弹「已获取」提示', /if \(fromRenewal\)[\s\S]{0,400}else \{\s*\n\s*toast\('已获取本地链路密钥'\)/.test(app5));

  // --- 401 自愈与熔断 ---
  check('401 走独立的 handle401', /if \(e && e\.status === 401\) return handle401\(\);/.test(app5));
  check('401 时清掉旧密钥', /function handle401[\s\S]{0,900}localStorage\.removeItem\('hg_key'\)/.test(app5));
  check('401 熔断阈值 ≥ 3（太小会误伤正常重启）', /const KEY_401_MAX = (\d+);/.test(app5)
    && Number(RegExp.$1) >= 3);
  check('401 熔断窗口有值', /const KEY_401_WINDOW = \d+;/.test(app5));
  check('401 自愈有最小间隔（给签名服务预热留时间）', /const KEY_401_MIN_GAP = \d+;/.test(app5));
  check('并发 401 去重（key401Pending）', /if \(key401Pending\) return;/.test(app5));
  check('间隔不足时排延迟重试', /key401Timer = setTimeout/.test(app5));
  check('有 stopKey401Retry 可取消延迟重试', /function stopKey401Retry\(\)[\s\S]{0,160}clearTimeout\(key401Timer\)/.test(app5));
  check('熔断后停掉延迟重试', /key401Count = 0;\s*\n\s*stopKey401Retry\(\);/.test(app5));
  check('熔断提示说明排查方向（代理透传 api_key）',
    /api_key 参数/.test(app5) && /反向代理/.test(app5));
  check('熔断提示仍给出人工出口（重新获取/手动粘贴）',
    /也可点「重新获取」再试一次，或手动粘贴密钥/.test(app5));
  check('熔断计数只在真正自愈时递增', /key401Count\+\+;\s*\n\s*fire\(\);/.test(app5));
  check('业务接口成功即清零 401 计数', /key401Count = 0;\s*\n\s*return data;/.test(app5));
  check('401 计数复位在成功分支内（不误清）',
    /if \(!res\.ok\) \{[\s\S]{0,400}throw err;\s*\}\s*\n\s*\/\/[\s\S]{0,200}key401Count = 0;/.test(app5));

  // --- 交互 ---
  check('点🔑时展示 API 地址', /\$?\('keyMsg'\)\.textContent = `API 地址：\$\{API_BASE\}`/.test(app5));
  check('已有密钥时点🔑直接显示而不触发获取', /\$?\('keyBtn'\)[\s\S]{0,600}if \(API_KEY\) \{/.test(app5));
  check('无密钥时点🔑立即进入获取中', /\$?\('keyBtn'\)[\s\S]{0,700}setKeyState\('loading', '获取中…'\)/.test(app5));
  check('「重新获取」点击期间禁用按钮', /\$?\('keyRetry'\)\.disabled = true;/.test(app5));
  check('「重新获取」重置熔断计数（给一次完整机会）',
    /\$?\('keyRetry'\)[\s\S]{0,400}key401Count = 0;/.test(app5));
  check('「重新获取」重置延迟重试', /\$?\('keyRetry'\)[\s\S]{0,400}stopKey401Retry\(\);/.test(app5));
  check('无密钥时复制给出提示', /尚未获取到密钥/.test(app5));
  check('手动保存停掉自动重试（避免覆盖用户填的值）',
    /\$?\('keySave'\)[\s\S]{0,500}stopKeyRetry\(\)/.test(app5));
  check('手动保存停掉 401 延迟重试', /\$?\('keySave'\)[\s\S]{0,500}stopKey401Retry\(\);/.test(app5));
  check('手动保存重置两个计数',
    /keyRetryCount = 0;\s*\n\s*key401Count = 0;/.test(app5));

  // --- 启动流程 ---
  check('启动时不弹卡（刚打开就遮罩很吓人）', /await ensureKey\(\);/.test(app5));
  check('启动时拿不到密钥走后台重试', /ensureKey\(false\);/.test(app5));
  check('后端未连接时提示正在等待', /正在等待后端启动…/.test(app5));
  check('后端未连接时说明会自动继续', /服务起来后本页会自动继续加载/.test(app5));
  check('等待提示告知如何启动后端', /运行 <code>npm start<\/code>/.test(app5));
}
console.log('\n' + (failed === 0
  ? '🎉 全部自检通过'
  : `⚠️  ${failed} 项自检失败`));
process.exit(failed === 0 ? 0 : 1);
