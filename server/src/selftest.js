'use strict';
/**
 * 自检套件。
 *
 * 共 23 组算法与环境探测基线，全部用例不依赖网络与外部服务。
 *
 * 运行态适配层：
 *  - 环境变量注入                   ->  process.env
 *  - 随机文件读写                   ->  fs fd + Mp4.RafStore
 *  - 后台清扫定时器存活判定         ->  Safeguards.sweeperActive()
 *  - 末尾运行环境打印               ->  Node 版本
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const Mp4 = require('./core/mp4');
const PureSign = require('./core/pure-sign');
const Safeguards = require('./core/safeguards');
const Spade = require('./core/spade');
const AppSource = require('./service/app-source');
const Client = require('./service/client');
const ShareLink = require('./service/share-link');
const Stream = require('./service/stream');
const KeyStore = require('./core/keystore');
const Device = require('./core/device');
const Config = require('./util/config');
const Crypto = require('./util/crypto');
const Json = require('./util/json');
const Mp4Fixture = require('./mp4-fixture');

// ==================== 断言 ====================

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + name + (detail === null || detail === undefined || detail === '' ? '' : '  ' + detail));
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail === null || detail === undefined || detail === '' ? '' : '  ' + detail));
  }
}

/**
 * 跳过一条断言：前提未满足时不算失败，也不计入通过数。
 * 保证「跳过」与「通过」一样可追溯。
 */
function skip(name, reason) {
  skipped++;
  console.log('  ⊘ ' + name + (reason === null || reason === undefined || reason === '' ? '' : '  ' + reason));
}

function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

function hex(b) { return Crypto.hex(b); }

function unhex(h) { return Crypto.unhex(h); }

function bufEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function arrEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 按 `[a, b, c]` 形态输出数组（便于断言失败时看清差异）。 */
function listStr(a) {
  return '[' + a.join(', ') + ']';
}

// ==================== 各组用例 ====================

/** 1. spade 解包：5 组运行时真值 + ver2 拒绝。 */
function spade() {
  section('1. spade -> content key 解包（对齐 5 组真值）');
  const all = Spade.selfTest();
  check('spade 解包 5 组真值', all, '');
  const k = Spade.unwrapV1(unhex('93bc1df253ba1bf7618b19c448b806f64d810afc45b715fe5eb925f26cbf12f541ba098282'), 0);
  check('输出为 32 位十六进制', Spade.isValidKey(k), k);
  const ver2 = Buffer.alloc(40);
  check('ver2 类型被拒绝', Spade.unwrapV1(ver2, 0) === null, '');
}

/** 2. AES-128-CTR 计数器构造。 */
function ctrCounter() {
  section('2. AES-128-CTR 计数器构造');
  // counter = (base_iv_high64 + index) << 64，低 64 位恒为 0
  const c0 = Mp4.ctrCounter('0000000000000001', 0);
  const c1 = Mp4.ctrCounter('0000000000000001', 1);
  const c2 = Mp4.ctrCounter('00000000000000ff', 1);
  check('counter 长度 16 字节', c0.length === 16, '');
  check('index=0 高位保留',
    hex(c0) === '00000000000000010000000000000000', hex(c0));
  check('index=1 进位到高 64 位',
    hex(c1) === '00000000000000020000000000000000', hex(c1));
  check('0xff + 1 进位正确',
    hex(c2) === '00000000000001000000000000000000', hex(c2));
}

/**
 * 3. 逐样本 IV -> CTR 计数器。
 * 回归用例：本项目实测 senc IV 为 8 字节，位于计数器高 64 位（右侧补零）。
 */
function ivToCounter() {
  section('3. 逐样本 IV -> CTR 计数器');
  const c8 = Mp4.ivToCounter('ebbde5029bbf3f29');
  check('8 字节 IV 长度 16', c8.length === 16, '');
  check('8 字节 IV 位于高 64 位',
    hex(c8) === 'ebbde5029bbf3f290000000000000000', hex(c8));
  check('与 ctrCounter(baseIv,0) 等价',
    bufEq(c8, Mp4.ctrCounter('ebbde5029bbf3f29', 0)));
  const c16 = Mp4.ivToCounter('00112233445566778899aabbccddeeff');
  check('16 字节 IV 原样保留',
    hex(c16) === '00112233445566778899aabbccddeeff', hex(c16));

  const tr = new Mp4.Track();
  tr.ivs = ['ebbde5029bbf3f29', 'ebbde5029bbf3f2a'];
  check('counterFor 优先用逐样本 IV',
    hex(Mp4.counterFor(tr, null, 1)) === 'ebbde5029bbf3f2a0000000000000000');
  check('counterFor 无 IV 时回退 base_iv',
    hex(Mp4.counterFor(new Mp4.Track(), '0000000000000005', 2))
      === '00000000000000070000000000000000');
}

/** 4. AVCC / NAL 自证。 */
function avcc() {
  section('4. AVCC / NAL 自证');
  const annexb = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 1, 0x68, 0xCE]);
  const avccBuf = Buffer.from([0, 0, 0, 2, 0x67, 0x42, 0, 0, 0, 3, 0x68, 0xCE, 0x3C]);
  const junk = Buffer.alloc(64, 0xAB);

  check('Annex-B 起始码识别', Mp4.avccSelfOk(annexb, annexb.length));
  check('AVCC 长度前缀识别', Mp4.avccSelfOk(avccBuf, avccBuf.length));
  check('随机数据拒绝', !Mp4.avccSelfOk(junk, junk.length));

  const multi = Buffer.from([
    0, 0, 0, 2, 0x67, 0x42,
    0, 0, 0, 2, 0x68, 0xCE,
    0, 0, 0, 3, 0x65, 0x88, 0x84]);
  check('多 NAL 样本整链自证', Mp4.avccSelfOk(multi, multi.length));

  const nonIdr = Buffer.from([0, 0, 0, 2, 0x06, 0x42]);
  check('nal_unit_type=0 非 IDR 分片通过', Mp4.avccSelfOk(nonIdr, nonIdr.length));

  const overflow = Buffer.from([0, 0, 0, 99, 0x65, 0x88]);
  check('长度越界拒绝', !Mp4.avccSelfOk(overflow, overflow.length));

  const badBit = Buffer.from([0, 0, 0, 2, 0x85, 0x42]);
  check('forbidden_zero_bit 置位拒绝', !Mp4.avccSelfOk(badBit, badBit.length));

  const tr = new Mp4.Track();
  tr.sampleCount = 100;
  tr.sizes = new Array(100).fill(1000);
  const probe = Mp4.pickProbeIndices(tr);
  let hasZero = false;
  let inRange = true;
  for (const i of probe) {
    if (i === 0) hasZero = true;
    if (i < 0 || i >= 100) inRange = false;
  }
  check('探测样本含 index 0 且在范围内', hasZero && inRange, '共 ' + probe.length + ' 个');
}

/** 5. AES-128-CTR 加解密往返一致性。 */
function ctrRoundTrip() {
  section('5. AES-128-CTR 加解密往返一致性');
  const key = Buffer.alloc(16);
  const ctr = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    key[i] = i;
    ctr[i] = 0xF0 + i;
  }
  const plain = Buffer.from('红果短剧 · hongguo ctr 往返测试');
  const enc = Crypto.aes128Ctr(key, ctr, plain);
  const dec = Crypto.aes128Ctr(key, ctr, enc);
  check('解密还原原文', bufEq(plain, dec));
  check('密文与原文不同', !bufEq(enc, plain));
}

/** 6. MP4 盒解析（构造最小合法 moov）。 */
function mp4Boxes() {
  section('6. MP4 盒解析（构造最小合法 moov）');
  const buf = Mp4Fixture.buildMinimalEncryptedMp4();
  const a = Mp4.analyzeEncryptedTracks(buf);
  check('解析出加密轨', a.tracks.length > 0, a.tracks.length + ' 条');
  if (a.tracks.length === 0) return;
  const t = a.tracks[0];
  check('handler 为 vide', t.handler === 'vide', t.handler);
  check('样本数为 2', t.sampleCount === 2, '' + t.sampleCount);
  check('逐样本 IV 已解析', t.ivs !== null && t.ivs.length === 2, '');
  check('IV 长度为 16 字节', t.ivSize === 16, '' + t.ivSize);
  // tenc 挂在 stsd→encv 内，而 encv 不在盒树的容器白名单里，
  // 因此 default_KID 读不到。不影响解密。
  check('KID 不参与解密链路（content key 来自 spade）', t.kid === null, '');

  const top = Mp4.parseBoxes(buf, 0, buf.length);
  let hasFtyp = false;
  let hasMoov = false;
  for (const b of top) {
    if (b.type === 'ftyp') hasFtyp = true;
    if (b.type === 'moov') hasMoov = true;
  }
  check('顶层含 ftyp 与 moov', hasFtyp && hasMoov, '');
}

/** 7. 端到端：逐样本 IV + content key 解密。 */
function decryptEndToEnd() {
  section('7. 端到端：content key + 逐样本 IV 解密');
  try {
    const buf = Mp4Fixture.buildMinimalEncryptedMp4();
    const a = Mp4.analyzeEncryptedTracks(buf);
    if (a.tracks.length === 0) {
      check('夹具可解析', false, '无加密轨');
      return;
    }
    const vt = a.tracks[0];
    const keyHex = Mp4Fixture.fixtureKeyHex();

    const cands = Mp4.trackBaseIvCandidates(vt);
    const vIv = Mp4.verifyVideoIv(buf, vt, keyHex, cands);
    check('verifyVideoIv 通过逐样本 IV 自证',
      vIv !== null && vIv === vt.ivs[0], '' + vIv);

    const r = Mp4.decryptTrack(buf, vt, keyHex, vIv);
    check('全部样本解密完成', r.decrypted === vt.sampleCount,
      r.decrypted + '/' + r.total);
    let allOk = true;
    for (let i = 0; i < r.decrypted; i++) {
      const off = vt.offsets[i];
      const size = vt.sizes[i];
      if (off + size > buf.length
        || !Mp4.avccSelfOk(buf.subarray(off, off + size), size)) {
        allOk = false;
        break;
      }
    }
    check('解密后每个样本 AVCC 自洽', allOk, '');

    const plains = Mp4Fixture.plainSamples();
    let restored = true;
    for (let i = 0; i < r.decrypted && i < plains.length; i++) {
      const off = vt.offsets[i];
      const size = vt.sizes[i];
      const got = buf.subarray(off, off + size);
      if (!bufEq(got, plains[i])) restored = false;
    }
    check('解密逐字节还原夹具明文', restored, '');

    const badKey = Buffer.alloc(16, 0x5A);
    const badIv = Mp4.verifyVideoIv(buf, vt, hex(badKey), cands);
    check('错误 content key 被拒绝', badIv === null, '' + badIv);
  } catch (e) {
    check('端到端解密', false, String(e.message));
  }
}

/** 8. JSON 往返（自研轻量库，含数字语义与 null 省略）。 */
function json() {
  section('8. JSON 往返与数字语义');
  try {
    const src = Json.obj();
    src.a = 1;
    src.b = '中文"引号"\n换行';
    src.c = Json.arr();
    src.d = 1.5;
    const text = Json.stringify(src);
    const back = Json.parseObject(text);
    check('整型往返为数值',
      Json.optLong(back.a, 0) === 1, '');
    check('字符串转义往返',
      '中文"引号"\n换行' === back.b, '');
    check('小数保持精度',
      Math.abs(Json.optDouble(back.d, 0) - 1.5) < 1e-9, '');

    const withNull = Json.obj();
    withNull.keep = 'v';
    withNull.drop = null;
    const s2 = Json.stringify(withNull, true);
    check('skipNulls 省略 null 字段', !s2.includes('drop'), s2);

    const num = Json.obj();
    num.x = 1.0;
    check('1.0 输出为 1', Json.stringify(num).includes('"x":1'), Json.stringify(num));
  } catch (e) {
    check('JSON 往返', false, String(e.message));
  }
}

/**
 * 9. 播放缓存路径。
 * 背景：解密末尾减壳产出 "<vid>_<q>.play.mp4" 并删掉 raw，
 * 而早期实现只探测 "<vid>_<q>.mp4"，导致加密内容永远不命中缓存。
 */
function cachePaths() {
  section('9. 播放缓存路径：.play.mp4 变体必须参与命中判定');
  const p = Stream.cachePaths('7688396322021329982', 'best');
  check('减壳产出名与 play 路径一致',
    path.basename(p.play) === '7688396322021329982_best.play.mp4',
    path.basename(p.play));
  check('play 与 out 是不同文件', p.play !== p.out, '');
  check('raw 命名带 .raw 段',
    path.basename(p.raw).endsWith('_best.raw.mp4'),
    path.basename(p.raw));

  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cache-'));
    const saved = process.env.HONGGUO_STREAM_CACHE;
    process.env.HONGGUO_STREAM_CACHE = tmp;
    const q = Stream.cachePaths('999', 'best');
    check('空目录时 cachedPath 为空',
      Stream.cachedPath('999', 'best') === null, '');
    fs.writeFileSync(q.play, Buffer.from('x'));
    check('仅 .play.mp4 存在即命中',
      Stream.cachedPath('999', 'best') === q.play, '');
    fs.unlinkSync(q.play);
    fs.writeFileSync(q.out, Buffer.from('x'));
    check('仅 .mp4 存在即命中',
      Stream.cachedPath('999', 'best') === q.out, '');
    if (saved === undefined) delete process.env.HONGGUO_STREAM_CACHE;
    else process.env.HONGGUO_STREAM_CACHE = saved;
  } catch (e) {
    check('缓存路径命中判定', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/** 10. 设备身份 device_id（搜索接口必需）。 */
function device() {
  section('10. 设备身份 device_id（搜索接口必需）');
  const id = Client.identity();
  check('device_id 为 16 位数字',
    id.deviceId !== null && /^\d{16}$/.test(id.deviceId), id.deviceId);
  check('来源已标记',
    id.source !== null && id.source !== '', id.source);
  check('已注入 base_query',
    Client.baseQuery().device_id === id.deviceId, '');
  // upstream.base_query / session_headers 的注释键（_说明）不得泄漏
  let noUnderscoreQ = true;
  for (const k of Object.keys(Client.baseQuery())) {
    if (k.startsWith('_')) noUnderscoreQ = false;
  }
  check('base_query 无注释键泄漏', noUnderscoreQ, '');
  let noUnderscoreH = true;
  for (const k of Object.keys(Client.sessionHeaders())) {
    if (k.startsWith('_')) noUnderscoreH = false;
  }
  check('session_headers 无注释键泄漏', noUnderscoreH, '');
  check('device_id 已写入 apikeys.json（单例）',
    KeyStore.store().deviceId() === id.deviceId,
    id.source);
  let deviceRejected = false;
  try { Safeguards.checkResponse({ code: 100103, message: '设备ID被风控' }); }
  catch (e) {
    deviceRejected = e instanceof Safeguards.RiskControlError
      && e.safeResponse.device_id_rejected === true;
  }
  check('明确的 device_id 拒绝被识别', deviceRejected, '');
  let genericRiskIsNotDeviceRejection = false;
  try { Safeguards.checkResponse({ code: 110001, message: 'risk control' }); }
  catch (e) {
    genericRiskIsNotDeviceRejection = e instanceof Safeguards.RiskControlError
      && e.safeResponse.device_id_rejected === false;
  }
  check('普通风控响应不触发 device_id 拒绝', genericRiskIsNotDeviceRejection, '');
  const originalStore = KeyStore.store;
  let fakeDeviceId = id.deviceId;
  KeyStore.store = () => ({
    deviceId: () => fakeDeviceId,
    setDeviceId: (value) => { fakeDeviceId = String(value); },
  });
  const fakeQuery = { device_id: id.deviceId };
  const fakeIdentity = { deviceId: id.deviceId, source: 'stored' };
  let rotatedId = null;
  try { rotatedId = Device.rotateDeviceId(fakeQuery, fakeIdentity, id.deviceId); }
  finally { KeyStore.store = originalStore; }
  check('拒绝后生成新 ID 并更新 query 与存储',
    rotatedId !== null && rotatedId !== id.deviceId
      && fakeQuery.device_id === rotatedId && fakeIdentity.deviceId === rotatedId
      && fakeIdentity.source === 'rotated' && fakeDeviceId === rotatedId, '');
  const explicitIdentity = { deviceId: id.deviceId, source: 'config' };
  check('显式配置的 device_id 不自动覆盖',
    Device.rotateDeviceId(fakeQuery, explicitIdentity, id.deviceId) === null, '');
  try {
    const ksFile = KeyStore.store().storeFile();
    const raw = fs.existsSync(ksFile) ? fs.readFileSync(ksFile, 'utf8') : '';
    check('apikeys.json 文件内容含 device_id', raw.includes(id.deviceId), '');
  } catch (e) {
    check('apikeys.json 文件内容含 device_id', false, String(e.message));
  }

  const iid = Client.baseQuery().iid;
  check('iid 保持 0（随机 iid 会触发风控）',
    iid === null || iid === undefined || String(iid) === '0',
    iid === null || iid === undefined ? 'null' : String(iid));
}

/** 11. 本地纯代码签名。 */
function pureSign() {
  section('11. 本地纯代码签名（PureSign）');
  const base = 'https://api5-normal-sinfonlineb.fqnovel.com/novel/player/multi_video_model/v1/'
    + '?aid=8662&device_id=1234567890123456&version_code=71532'
    + '&version_name=7.1.5.32&device_type=SM-N9860';
  const url = base + '&_rticket=1700000000000';
  const body = Buffer.from('{"biz_param":{},"mixed_video_id_map":{"1":["7686715217652223038"]}}');

  const h = PureSign.sign(url, body);
  check('六个签名头齐全', Object.keys(h).length === 6, listStr(Object.keys(h)));
  for (const k of ['x-gorgon', 'x-khronos', 'x-ladon', 'x-argus', 'x-helios', 'x-medusa']) {
    check('含 ' + k, h[k] !== null && h[k] !== undefined && h[k] !== '', '');
  }

  const khronos = 1700000000;
  const h2 = PureSign.sign(url, body, khronos);
  check('x-khronos 与指定时间戳一致',
    String(khronos) === h2['x-khronos'], '' + h2['x-khronos']);

  const h3 = PureSign.sign(url, null);
  check('无 body 也可签名', Object.keys(h3).length === 6, listStr(Object.keys(h3)));

  const branches = [0, 0, 0];
  let safe = 0;
  for (let off = 0; off < 32; off++) {
    const b = PureSign.branchOf(base + '&_rticket=' + (1700000000000 + off), body, khronos);
    if (b >= 0 && b <= 2) branches[b]++;
    if (b !== 1) safe++;
  }
  check('branchOf 取值在 0/1/2', branches[0] + branches[1] + branches[2] === 32,
    'b0=' + branches[0] + ' b1=' + branches[1] + ' b2=' + branches[2]);
  check('32 个 _rticket 中可避开 branch==1', safe > 0, 'safe=' + safe + '/32');

  // hashF13 三分支固定向量（期望值取自参考实现）。
  // branch 0 曾因展开循环里的 di0 不前进而整段算错，签名被上游判为无效。
  const vectors = [
    ['aid=8662&device_id=700000000000000&ts=1793620000', 1793620000,
      'b93e5ea3f34b2ed5f8ebfecbe8968697bb6cb5c68df4652941caf652a366f2d875118e1b'],
    ['aid=8662&device_id=700000000000000&ts=1793620001', 1793620001,
      '9453f32d76ec1dc1df9e872f5d57f1957e141939'],
    ['aid=8662&device_id=700000000000000&ts=1793620008', 1793620008,
      '7f94ed4fe11d6eabf12267334798b66cd57d2845'],
  ];
  for (const [q, ts2, want] of vectors) {
    const got = PureSign.hashF13Hex(q, '{"a":1}', ts2);
    check('hashF13 向量 ts=' + ts2, got === want, got === want ? '' : got);
  }
}

/** 12. 剧集解析：title 清洗（上游 title 实为简介）。 */
function episodeTitle() {
  section('12. 剧集解析：title 清洗（上游 title 实为简介）');
  const intro = '这是一段很长的本剧简介文字';
  const vd = Json.obj();
  vd.series_intro = intro;
  vd.series_title = '测试剧';
  vd.copyright = '某某制作方';
  vd.episode_cnt = 2;
  const vl = Json.arr();

  const e1 = Json.obj();
  e1.vid_index = 1;
  e1.vid = 'v1';
  e1.title = intro;          // 与简介相同 => 应置空
  e1.duration = 100;
  vl.push(e1);

  const e2 = Json.obj();
  e2.vid_index = 2;
  e2.vid = 'v2';
  e2.title = '第 2 集';       // 正常集名 => 应保留
  e2.duration = 120;
  vl.push(e2);

  vd.video_list = vl;
  const r = Client.parseEpisodeDetail('123', vd);
  const eps = Json.optArr(r.episodes);
  check('解析出 2 集', eps.length === 2, '' + eps.length);

  const a1 = Json.optObj(eps[0]);
  const a2 = Json.optObj(eps[1]);
  check('与简介相同的 title 被置空',
    Json.optStr(a1.title, 'x') === '', '');
  check('正常集名保留',
    Json.optStr(a2.title, '') === '第 2 集', '');
  check('meta 标题取 series_title',
    Json.optStr(Json.optObj(r.meta).title, '') === '测试剧', '');
  check('meta 透传 Copyright 制作方',
    Json.optStr(Json.optObj(r.meta).copyright, '') === '某某制作方', '');
  check('按 index 升序排列',
    Json.optLong(a1.index, 0) === 1 && Json.optLong(a2.index, 0) === 2, '');

  // 官网回落：分集页内嵌 JSON 里的简介/标签/连载状态必须透传，
  // 否则一次风控空响应会让「简介」按钮整段消失。
  const web = Json.obj();
  web.series_id = '123';
  web.series_title = '官网剧';
  web.series_intro = intro;
  web.tags = ['剧情', '穿越'];
  web.series_status = 1;
  web.total = 1;
  web.cover = '';
  const we = Json.obj();
  we.vid = 'v9';
  we.vid_index = 1;
  we.title = '';
  we.cover = '';
  we.web_available = true;
  web.episodes = [we];
  const wd = Client.webEpisodesToDetail(web);
  const wm = Json.optObj(wd.meta);
  const wEps = Json.optArr(wd.episodes);
  check('官网回落: 简介透传', Json.optStr(wm.abstract, '') === intro, '');
  check('官网回落: 制作方为空串（由列表数据带入）',
    Json.optStr(wm.copyright, 'x') === '', '');
  check('官网回落: tags 进 category',
    Json.optArr(wm.category).length === 2 && Json.optStr(Json.optArr(wm.category)[1], '') === '穿越', '');
  check('官网回落: series_status=1 => 完结',
    Json.optStr(wm.status, '') === '完结', Json.optStr(wm.status, ''));
  check('官网回落: 标记 degraded',
    wm.degraded === true, '');
  check('官网回落: 分集数与 meta 对上',
    wEps.length === 1 && Json.optLong(wm.episode_cnt, 0) === 1, '');
  check('官网回落: 缺简介时不报错且为空串',
    Json.optStr(Json.optObj(Client.webEpisodesToDetail(Json.obj()).meta).abstract, 'x') === '', '');
}

/** 13. 本地链路密钥。 */
function keyStore() {
  section('13. 本地链路密钥');
  const ks = KeyStore.store();
  ks.ensureBootstrap();
  check('至少一把启用密钥', ks.countEnabled() >= 1, '' + ks.countEnabled());
  const first = ks.firstEnabled();
  check('首把密钥格式为 hg_ 前缀',
    first !== null && first.key.startsWith('hg_'), '');
  check('无效密钥被拒绝', !ks.isValid('hg_nonexistent'), '');
  check('空密钥被拒绝', !ks.isValid(''), '');
  const at1 = ks.ensureAdminToken();
  check('管理口令已生成（64 位 hex）', at1.length === 64, 'len=' + at1.length);
  const ks2 = KeyStore.store();
  check('管理口令持久化到 apikeys.json', at1 === ks2.ensureAdminToken(), '');
}

/** 用字节数组模拟的 HeadReader，扫描 moov。 */
function scanMoov(buf) {
  return Mp4.findMoov((off, len) => {
    if (off < 0 || off + len > buf.length) return null;
    return buf.subarray(off, off + len);
  }, buf.length);
}

/** 返回指定盒类型首字节在数组中的下标（找不到返回 -1）。 */
function indexOfType(hay, type) {
  const needle = Buffer.from(type, 'latin1');
  outer:
  for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i - 4;
  }
  return -1;
}

/** 14. moov 定位：尾部 moov（非 faststart）必须能被正确找到。 */
function moovLocator() {
  section('14. moov 定位：尾部 moov 也能找到（流式解密前置）');
  try {
    // 头部形态（faststart）：moov 应在 ftyp 之后立刻出现
    const head = Mp4Fixture.buildMinimalEncryptedMp4();
    const hSpan = scanMoov(head);
    check('头部形态能定位 moov', hSpan !== null,
      hSpan === null ? 'null' : ('start=' + hSpan.start + ' size=' + hSpan.size));
    if (hSpan !== null) {
      check('头部形态 moov 紧跟 ftyp', hSpan.start > 0 && hSpan.start < head.length / 2,
        'start=' + hSpan.start);
    }

    // 尾部形态：moov 在文件末尾
    const tail = Mp4Fixture.buildTailMoovEncryptedMp4();
    const tSpan = scanMoov(tail);
    check('尾部形态能定位 moov', tSpan !== null,
      tSpan === null ? 'null' : ('start=' + tSpan.start + ' size=' + tSpan.size));
    if (tSpan !== null) {
      const mdatEnd = indexOfType(tail, 'mdat');
      check('尾部形态 moov 排在 mdat 之后',
        tSpan.start > mdatEnd,
        'moov@' + tSpan.start + ' > mdat@' + mdatEnd);
      check('moov 末端与文件末端一致',
        tSpan.end() === tail.length,
        tSpan.end() + '==' + tail.length);
    }

    check('头部形态解析出加密轨',
      Mp4.analyzeEncryptedTracks(head).tracks.length > 0, '');
    check('尾部形态解析出加密轨',
      Mp4.analyzeEncryptedTracks(tail).tracks.length > 0, '');

    if (tSpan !== null) {
      const moovBuf = tail.subarray(tSpan.start, tSpan.end());
      const a = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, tSpan.start));
      check('尾部形态 base-offset 视图可解析', a.tracks.length > 0, '');
      if (a.tracks.length > 0) {
        const vt = a.tracks[0];
        let inRange = true;
        for (let i = 0; i < vt.sampleCount; i++) {
          if (vt.offsets[i] < 0 || vt.offsets[i] + vt.sizes[i] > tail.length) {
            inRange = false;
            break;
          }
        }
        check('尾部形态样本偏移落在文件范围内（base 换算正确）', inRange, '');
      }
    }
  } catch (e) {
    check('moov 定位', false, String(e.message));
  }
}

/**
 * 16. 流式解密的内存回归。
 * 核心断言：走 RafStore（随机读写句柄）路径解密后，逐字节结果必须与
 * 整文件 Buffer 路径完全一致 —— 这是流式改造的等价性证明。
 */
function streamingDecrypt() {
  section('15. 流式解密与整文件解密结果一致');
  let tmp = null;
  try {
    const fixture = Mp4Fixture.buildMinimalEncryptedMp4();
    const keyHex = Mp4Fixture.fixtureKeyHex();

    // 基线：整文件 Buffer 路径
    const base = Buffer.from(fixture);
    const a1 = Mp4.analyzeEncryptedTracks(base);
    const vt1 = a1.tracks[0];
    const iv1 = Mp4.verifyVideoIv(base, vt1, keyHex, Mp4.trackBaseIvCandidates(vt1));
    Mp4.decryptTrack(base, vt1, keyHex, iv1);

    // 流式：moov 窗口 + fd 句柄路径
    tmp = path.join(os.tmpdir(), 'hg-stream-' + process.pid + '-' + Date.now() + '.mp4');
    fs.writeFileSync(tmp, fixture);
    {
      const fd = fs.openSync(tmp, 'r+');
      try {
        const store = new Mp4.RafStore(fd, 4096);
        const span = scanMoov(fixture);
        check('流式路径能定位 moov', span !== null, '');
        const moovBuf = fixture.subarray(span.start, span.end());
        const a2 = Mp4.analyzeEncryptedTracks(new Mp4.ByteView(moovBuf, span.start));
        check('流式路径解析出加密轨', a2.tracks.length > 0, '');
        const vt2 = a2.tracks[0];
        check('两种路径样本数一致',
          vt1.sampleCount === vt2.sampleCount,
          vt1.sampleCount + '==' + vt2.sampleCount);
        check('两种路径样本偏移一致',
          arrEq(vt1.offsets, vt2.offsets), '');

        const iv2 = Mp4.verifyVideoIv(store, vt2, keyHex, Mp4.trackBaseIvCandidates(vt2));
        check('流式路径 IV 自证通过', iv1 === iv2, '' + iv2);
        const r2 = Mp4.decryptTrack(store, vt2, keyHex, iv2);
        check('流式路径解密样本数一致', r2.decrypted === vt1.sampleCount,
          r2.decrypted + '/' + r2.total);
      } finally {
        fs.closeSync(fd);
      }
    }
    const streamOut = fs.readFileSync(tmp);

    check('流式解密结果与整文件解密逐字节一致', bufEq(base, streamOut), '');

    let restored = true;
    const plains = Mp4Fixture.plainSamples();
    for (let i = 0; i < plains.length; i++) {
      const off = vt1.offsets[i];
      const size = vt1.sizes[i];
      if (!bufEq(streamOut.subarray(off, off + size), plains[i])) {
        restored = false;
        break;
      }
    }
    check('流式解密逐字节还原夹具明文', restored, '');
  } catch (e) {
    check('流式解密', false, String(e.message));
  } finally {
    if (tmp !== null) {
      try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
    }
  }
}

/** 16. 缓存上限与过期清扫。 */
async function cacheBounds() {
  section('16. 缓存上限与过期清扫');
  try {
    const savedMax = process.env.HG_MEM_CACHE_MAX;
    process.env.HG_MEM_CACHE_MAX = '50';
    // 注意：Safeguards 的上限在模块加载时读取，这里只验证
    // 「写入 + 读取 + 清扫」行为本身，不改配置重载。

    for (let i = 0; i < 100; i++) {
      Safeguards.cacheSet('selftest:k:' + i, 'v' + i, 3600);
    }
    const readable = Safeguards.cacheGet('selftest:k:99') !== null;
    check('缓存写入后可读回', readable, '');

    Safeguards.cacheSet('selftest:expired', 'x', 1);
    await Safeguards.sleep(1100);
    check('过期条目视为 miss（TTL 生效）',
      Safeguards.cacheGet('selftest:expired') === null, '');

    check('后台清扫线程已启动且为 daemon', Safeguards.sweeperActive(), '');

    const w = Safeguards.weigh({});
    check('weigh 对空结构返回合理值', w >= 0 && w < 4096, '' + w);

    if (savedMax === undefined) delete process.env.HG_MEM_CACHE_MAX;
    else process.env.HG_MEM_CACHE_MAX = savedMax;
  } catch (e) {
    check('缓存上限', false, String(e.message));
  }
}

/** 统计目录下的成品文件数（排除 .part/.enc 临时文件）。 */
function countCacheFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.part') && !name.endsWith('.enc')) n++;
  }
  return n;
}

/** 递归删除目录。 */
function deleteTree(dir) {
  if (dir === null || dir === undefined) return;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (fs.statSync(p).isDirectory()) deleteTree(p);
        else fs.unlinkSync(p);
      } catch (e) { /* 忽略 */ }
    }
    fs.rmdirSync(dir);
  } catch (e) { /* 忽略 */ }
}

/** 17. stream-cache 数量上限（超出按修改时间淘汰最旧）。 */
function streamCacheLimit() {
  section('17. stream-cache 数量上限（超出按修改时间淘汰最旧）');
  let tmp = null;
  try {
    check('上限配置键已登记（runtime.cache.max_files）',
      Config.keys().includes('runtime.cache.max_files'), '');

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-prune-'));
    const savedDir = process.env.HONGGUO_STREAM_CACHE;
    const savedMax = process.env.HONGGUO_CACHE_MAX_FILES;
    process.env.HONGGUO_STREAM_CACHE = tmp;

    const base = 1700000000000;

    const made = [];
    for (let i = 0; i < 5; i++) {
      const p = path.join(tmp, 'v' + i + '_best.play.mp4');
      fs.writeFileSync(p, Buffer.from('x'));
      const t = (base + i * 60000) / 1000;
      fs.utimesSync(p, t, t);
      made.push(p);
    }

    process.env.HONGGUO_CACHE_MAX_FILES = '3';
    const del = Stream.pruneCache();
    check('超出上限时删除最旧文件', del === 2, '删除 ' + del + ' 个');
    check('最旧的 v0 已删除', !fs.existsSync(made[0]), '');
    check('最旧的 v1 已删除', !fs.existsSync(made[1]), '');
    check('最新 3 个被保留',
      fs.existsSync(made[2]) && fs.existsSync(made[3]) && fs.existsSync(made[4]), '');
    check('清理后数量等于上限',
      countCacheFiles(tmp) === 3, '' + countCacheFiles(tmp));

    const part = path.join(tmp, 'zz_download.part');
    const enc = path.join(tmp, 'zz_ct.enc');
    fs.writeFileSync(part, Buffer.from('x'));
    fs.writeFileSync(enc, Buffer.from('x'));
    const oldT = (base - 999999) / 1000;
    fs.utimesSync(part, oldT, oldT);
    fs.utimesSync(enc, oldT, oldT);
    Stream.pruneCache();
    check('下载临时文件 .part 不被删除', fs.existsSync(part), '');
    check('密文临时文件 .enc 不被删除', fs.existsSync(enc), '');

    process.env.HONGGUO_CACHE_MAX_FILES = '5';
    let tmp2 = null;
    try {
      tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-prune2-'));
      for (let i = 0; i < 5; i++) {
        const p = path.join(tmp2, 'k' + i + '_best.play.mp4');
        fs.writeFileSync(p, Buffer.from('x'));
        const t = (base + i * 60000) / 1000;
        fs.utimesSync(p, t, t);
      }
      const d2 = Stream.pruneCache(5);
      check('恰好等于上限时不删除', d2 === 0, '删除 ' + d2 + ' 个');
    } finally {
      deleteTree(tmp2);
    }

    check('上限设为 0 时不清理', Stream.pruneCache(0) === 0, '');
    check('上限设为负数时不清理', Stream.pruneCache(-1) === 0, '');

    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-prune3-'));
    const savedDir3 = process.env.HONGGUO_STREAM_CACHE;
    process.env.HONGGUO_STREAM_CACHE = tmp3;
    check('空目录清理不报错', Stream.pruneCache() === 0, '');
    process.env.HONGGUO_STREAM_CACHE = path.join(tmp3, 'nope');
    check('目录不存在时不报错', Stream.pruneCache() === 0, '');
    process.env.HONGGUO_STREAM_CACHE = savedDir3;
    deleteTree(tmp3);

    if (savedDir === undefined) delete process.env.HONGGUO_STREAM_CACHE;
    else process.env.HONGGUO_STREAM_CACHE = savedDir;
    if (savedMax === undefined) delete process.env.HONGGUO_CACHE_MAX_FILES;
    else process.env.HONGGUO_CACHE_MAX_FILES = savedMax;
  } catch (e) {
    check('stream-cache 数量上限', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/**
 * 19. 搜索分页切片（skip 必须真正生效）。
 * 背景：searchPage 原先完全忽略 skip，每次都从上游第一页抓、
 * 返回同一批前 limit 条。这里直接验证 Page.slice 的切片与 has_more 判据。
 */
function searchPageSlice() {
  section('18. 搜索分页切片（skip 生效且 has_more 判据正确）');
  const all = [];
  for (let i = 0; i < 75; i++) all.push('item' + i);

  const p1 = Client.Page.slice(all, 0, 30, true);
  check('首屏返回 30 条', p1.items.length === 30, '' + p1.items.length);
  check('首屏为第 0..29 条', p1.items[0] === 'item0' && p1.items[29] === 'item29', '');
  check('首屏 nextSkip=30', p1.nextSkip === 30, '' + p1.nextSkip);
  check('上游有后续时 has_more=true', p1.hasMore, '');

  const p2 = Client.Page.slice(all, 30, 30, true);
  check('续页返回 30 条', p2.items.length === 30, '' + p2.items.length);
  check('续页从 item30 开始', p2.items[0] === 'item30', '');
  let overlap = false;
  for (const a of p1.items) for (const b of p2.items) if (a === b) overlap = true;
  check('续页与首页无重复条目', !overlap, overlap ? '存在重复' : '');
  check('续页 nextSkip=60', p2.nextSkip === 60, '' + p2.nextSkip);
  check('续页 has_more=true', p2.hasMore, '');

  const p3 = Client.Page.slice(all, 60, 30, true);
  check('第 3 页返回剩余 15 条', p3.items.length === 15, '' + p3.items.length);
  check('第 3 页从 item60 开始', p3.items[0] === 'item60', '');
  check('末页 has_more=false（攒不满即到末尾）', !p3.hasMore, '');
  check('末页 nextSkip=75', p3.nextSkip === 75, '' + p3.nextSkip);

  const p4 = Client.Page.slice(all, 0, 30, false);
  check('上游 has_more=false 时不谎报有更多', !p4.hasMore, '');

  const p5 = Client.Page.slice(all, 99, 30, true);
  check('skip 越界返回空列表', p5.items.length === 0, '' + p5.items.length);
  check('skip 越界 has_more=false', !p5.hasMore, '');

  const p6 = Client.Page.slice([], 0, 30, true);
  check('空结果返回空列表', p6.items.length === 0, '');
  check('空结果 has_more=false', !p6.hasMore, '');
  const p7 = Client.Page.slice(null, 0, 30, true);
  check('null 结果不抛异常', p7.items.length === 0 && !p7.hasMore, '');
}

function appSource() {
  section('19. App 取址链路：播放设备参数 / query 编码 / URL 白名单');

  check('pyEncode: * 原样保留（resolution=1280*2772，签名按原文计算）',
    AppSource.pyEncode('1280*2772') === '1280*2772',
    AppSource.pyEncode('1280*2772'));
  check("pyEncode: !'() 编码为 %21%27%28%29",
    AppSource.pyEncode("a!b'c(d)e") === 'a%21b%27c%28d%29e',
    AppSource.pyEncode("a!b'c(d)e"));
  check('pyEncode: 字母数字与 .-_~ 原样',
    AppSource.pyEncode('novelread-7.1.3_32~x') === 'novelread-7.1.3_32~x',
    AppSource.pyEncode('novelread-7.1.3_32~x'));

  const d = AppSource.DEVICE_BASE;
  check('设备身份: version_code=71332',
    String(d.version_code) === '71332', '');
  check('设备身份: channel=update_64',
    String(d.channel) === 'update_64', '');
  check('设备身份: device_type=25053RT47C',
    String(d.device_type) === '25053RT47C', '');
  check('设备身份: 基础参数不含 iid/device_id（播放身份由匿名注册提供）',
    d.iid === undefined && d.device_id === undefined, '');

  const pd = AppSource.PLAYBACK_DEVICE;
  check('播放设备参数: version_code=74332（2026-11-10 上游 6.6 请求格式）',
    String(pd.version_code) === '74332', '');
  check('播放设备参数: version_name=7.4.3.32（与 UA、签名内设备字段一致）',
    String(pd.version_name) === '7.4.3.32', '');
  check('播放设备参数: 版本族五字段全部同步为 74332',
    String(pd.manifest_version_code) === '74332'
    && String(pd.update_version_code) === '74332'
    && String(pd.pv_player) === '74332', '');
  check('播放设备参数: 其余字段继承 DEVICE_BASE',
    String(pd.channel) === 'update_64' && String(pd.device_type) === '25053RT47C'
    && pd.iid === undefined && pd.device_id === undefined, '');
  check('播放 UA: 版本号同步为 74332 且机型段不变',
    AppSource.PLAYBACK_UA.startsWith('com.phoenix.read/74332 ')
    && AppSource.PLAYBACK_UA.indexOf('25053RT47C') > 0,
    AppSource.PLAYBACK_UA);

  const vt = AppSource.VIDEO_TAB_DEVICE;
  check('video_tab 设备参数: 版本族为 73932 / 7.3.9.32（上游 6.7 恢复路径）',
    String(vt.version_code) === '73932' && String(vt.version_name) === '7.3.9.32'
    && String(vt.manifest_version_code) === '73932'
    && String(vt.update_version_code) === '73932'
    && String(vt.pv_player) === '73932', '');
  check('video_tab 设备参数: 其余字段继承 DEVICE_BASE 且不含身份',
    String(vt.channel) === 'update_64' && String(vt.device_type) === '25053RT47C'
    && vt.iid === undefined && vt.device_id === undefined, '');

  try {
    const u = AppSource.checkedUrl('https://p3.qznovelvod.com/a/b.mp4', AppSource.VOD_DOMAINS);
    check('checkedUrl: 白名单子域放行', u.startsWith('https://'), u);
  } catch (e) {
    check('checkedUrl: 白名单子域放行', false, String(e.message));
  }
  try {
    AppSource.checkedUrl('http://qznovelvod.com/a.mp4', AppSource.VOD_DOMAINS);
    check('checkedUrl: http 被拒绝', false, '未拒绝');
  } catch (expected) {
    check('checkedUrl: http 被拒绝', true, '');
  }
  try {
    AppSource.checkedUrl('https://evil.example/a.mp4', AppSource.VOD_DOMAINS);
    check('checkedUrl: 白名单外被拒绝', false, '未拒绝');
  } catch (expected) {
    check('checkedUrl: 白名单外被拒绝', true, '');
  }

  check('cleanUrl: 转义还原',
    AppSource.cleanUrl('https:\\/\\/x.com\\u0026a.mp4') === 'https://x.com&a.mp4', '');
  check('pixelsOf: 取第一组数字', AppSource.pixelsOf('1080p 高清') === 1080, '');
  check('pixelsOf: 无数字返回 0', AppSource.pixelsOf('蓝光') === 0, '');
  try {
    AppSource.decryptSpadeUrl('bm90LWEtc3BhZGUtdXJs', Buffer.alloc(32));
    check('decryptSpadeUrl: 非法布局被拒绝', false, '未拒绝');
  } catch (expected) {
    check('decryptSpadeUrl: 非法布局被拒绝', true, '');
  }
}

// ==================== CENC 减壳用例辅助 ====================

function u32At(b, p) { return b.readUInt32BE(p); }

function u64At(b, p) { return Number(b.readBigUInt64BE(p)); }

function putU32At(b, p, v) { b.writeUInt32BE(Number(BigInt.asUintN(32, BigInt(v))), p); }

function putU64At(b, p, v) { b.writeBigUInt64BE(BigInt.asUintN(64, BigInt(v)), p); }

/**
 * 从盒树中删除指定类型的第一个盒，并同步修补祖先链尺寸（自底向上）。
 * 删盒让 moov 缩小、mdat 前移，stco 的 chunk 偏移同步 -size。
 */
function dropBox(enc, type) {
  const pos = indexOfType(enc, type);
  if (pos < 0) return null;
  const size = u32At(enc, pos);
  const chain = [];
  if (!findAncestors(Mp4.parseBoxes(enc, 0, enc.length), enc, pos, chain)) return null;
  const out = Buffer.concat([enc.subarray(0, pos), enc.subarray(pos + size)]);
  for (const b of chain) {
    putU32At(out, b.start, u32At(out, b.start) - size);
  }
  const stcoPos = indexOfType(enc, 'stco');
  if (stcoPos >= 0) {
    const outStco = stcoPos > pos ? stcoPos - size : stcoPos;
    putU32At(out, outStco + 16, u32At(enc, stcoPos + 16) - size);
  }
  return out;
}

/** 把夹具里的 stco 盒替换为等义 co64 盒（32 位偏移 -> 64 位）。 */
function toCo64(enc) {
  const stcoPos = indexOfType(enc, 'stco');
  if (stcoPos < 0) return null;
  const oldSize = u32At(enc, stcoPos);
  const count = u32At(enc, stcoPos + 12);
  const newSize = 8 + 4 + 4 + 8 * count;
  const grow = newSize - oldSize;
  const out = Buffer.alloc(enc.length + grow);
  enc.copy(out, 0, 0, stcoPos);
  putU32At(out, stcoPos, newSize);
  out.write('co64', stcoPos + 4, 4, 'latin1');
  enc.copy(out, stcoPos + 8, stcoPos + 8, stcoPos + 16); // v/f + count 原样
  for (let i = 0; i < count; i++) {
    const v = u32At(enc, stcoPos + 16 + 4 * i);
    putU64At(out, stcoPos + 16 + 8 * i, v + grow);
  }
  enc.copy(out, stcoPos + newSize, stcoPos + oldSize, enc.length);
  const chain = [];
  if (!findAncestors(Mp4.parseBoxes(enc, 0, enc.length), enc, stcoPos, chain)) return null;
  for (const b of chain) {
    putU32At(out, b.start, u32At(out, b.start) + grow);
  }
  return out;
}

/**
 * 收集盒 pos 的严格祖先链（命中目标即停，目标自身不入链；自底向上）。
 */
function findAncestors(boxes, enc, pos, chain) {
  for (const b of boxes) {
    if (b.start === pos) return true;
    if (pos <= b.start || pos >= b.end()) continue;
    let kids = b.children;
    let inner = -1;
    if (b.type === 'encv') inner = b.start + 8 + 78;
    else if (b.type === 'enca') inner = b.start + 8 + 28;
    else if (b.type === 'sinf') inner = b.start + 8;
    if (kids.length === 0 && inner >= 0) {
      kids = Mp4.parseBoxes(enc, inner, b.end());
    }
    if (findAncestors(kids, enc, pos, chain)) {
      chain.push(b);
      return true;
    }
  }
  return false;
}

/** 20. CENC 信令纯 JS 减壳（唯一播放路径，不调用外部程序）。 */
function cencStrip() {
  section('20. CENC 信令纯 JS 减壳（sinf/senc 移除、stco 平移、mdat 原样）');
  let tmp = null;
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-strip-'));
    const enc = Mp4Fixture.buildMinimalEncryptedMp4();
    const inPath = path.join(tmp, 'in.mp4');
    fs.writeFileSync(inPath, enc);

    const sinfPos = indexOfType(enc, 'sinf');
    const sencPos = indexOfType(enc, 'senc');
    check('夹具含 sinf 与 senc', sinfPos >= 0 && sencPos >= 0,
      'sinf@' + sinfPos + ' senc@' + sencPos);
    if (sinfPos < 0 || sencPos < 0) return;
    const delta = u32At(enc, sinfPos) + u32At(enc, sencPos);
    check('信令尺寸非零', delta > 0, 'delta=' + delta);

    const stcoPos = indexOfType(enc, 'stco');
    const mdatPos = indexOfType(enc, 'mdat');
    const oldChunk = u32At(enc, stcoPos + 16);
    const oldMdatPayload = mdatPos + 8;

    const outp = path.join(tmp, 'out.mp4');
    check('头部形态减壳成功', Mp4.stripEncryption(inPath, outp), '');
    if (!fs.existsSync(outp)) return;
    const outBytes = fs.readFileSync(outp);

    check('输出尺寸 = 原尺寸 - 信令字节',
      outBytes.length === enc.length - delta,
      outBytes.length + ' vs ' + (enc.length - delta));

    const newMdatPos = indexOfType(outBytes, 'mdat');
    check('输出仍含 mdat', newMdatPos >= 0, '@' + newMdatPos);
    if (newMdatPos >= 0) {
      const newMdatPayload = newMdatPos + 8;
      let same = outBytes.length - newMdatPayload === enc.length - oldMdatPayload;
      if (same) {
        for (let i = 0; i < enc.length - oldMdatPayload; i++) {
          if (outBytes[newMdatPayload + i] !== enc[oldMdatPayload + i]) {
            same = false;
            break;
          }
        }
      }
      check('mdat 负载逐字节一致', same, '');
    }

    const newStcoPos = indexOfType(outBytes, 'stco');
    const newChunk = u32At(outBytes, newStcoPos + 16);
    check('stco 偏移平移量正确', newChunk === oldChunk - delta,
      newChunk + ' vs ' + (oldChunk - delta));
    if (newMdatPos >= 0) {
      check('stco 指向新 mdat 负载起点',
        newChunk === newMdatPos + 8,
        newChunk + ' vs ' + (newMdatPos + 8));
    }

    const top = Mp4.parseBoxes(outBytes, 0, outBytes.length);
    let moov = null;
    for (const b of top) {
      if (b.type === 'moov') { moov = b; break; }
    }
    check('输出盒链完整（末盒为 mdat 且收尾）',
      top.length > 0 && top[top.length - 1].type === 'mdat'
        && top[top.length - 1].end() === outBytes.length
        && moov !== null, '');
    if (moov !== null) {
      let clean = true;
      let entryType = null;
      for (const trak of moov.children) {
        if (trak.type !== 'trak') continue;
        const mdia = trak.child('mdia');
        const stbl = mdia === null ? null
          : (mdia.child('minf') === null ? null : mdia.child('minf').child('stbl'));
        if (stbl === null) continue;
        if (stbl.child('senc') !== null) clean = false;
        const stsd = stbl.child('stsd');
        if (stsd !== null) {
          for (const e of stsd.children) {
            entryType = e.type;
            const kids = Mp4.parseBoxes(outBytes, e.start + 8 + 78, e.end());
            for (const c of kids) {
              if (c.type === 'sinf') clean = false;
            }
          }
        }
      }
      check('sinf 与 senc 已除净', clean, '');
      check('条目类型改回 hvc1', entryType === 'hvc1', String(entryType));
    }

    const tailIn = path.join(tmp, 'tail.mp4');
    fs.writeFileSync(tailIn, Mp4Fixture.buildTailMoovEncryptedMp4());
    const tailOut = path.join(tmp, 'tail-out.mp4');
    check('尾部 moov 形态被拒（不产出成品）', !Mp4.stripEncryption(tailIn, tailOut), '');

    const junkIn = path.join(tmp, 'junk.mp4');
    const junk = Buffer.alloc(512);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 31) & 0xff;
    fs.writeFileSync(junkIn, junk);
    const junkOut = path.join(tmp, 'junk-out.mp4');
    check('垃圾输入被拒', !Mp4.stripEncryption(junkIn, junkOut), '');
    check('垃圾输入不产生输出', !fs.existsSync(junkOut), '');

    const big = toCo64(enc);
    if (big !== null) {
      const bigIn = path.join(tmp, 'co64.mp4');
      fs.writeFileSync(bigIn, big);
      const bigOut = path.join(tmp, 'co64-out.mp4');
      check('co64 形态减壳成功', Mp4.stripEncryption(bigIn, bigOut), '');
      if (fs.existsSync(bigOut)) {
        const bo = fs.readFileSync(bigOut);
        const bStco = indexOfType(bo, 'co64');
        const bChunk = bStco >= 0 ? u64At(bo, bStco + 16) : -1;
        const bMdat = indexOfType(bo, 'mdat');
        check('co64 偏移平移且指向新 mdat',
          bChunk >= 0 && bMdat >= 0 && bChunk === bMdat + 8,
          'chunk=' + bChunk + ' mdat=' + (bMdat + 8));
      }
    }
    const noFrma = dropBox(enc, 'frma');
    if (noFrma !== null) {
      const nfIn = path.join(tmp, 'nofrma.mp4');
      fs.writeFileSync(nfIn, noFrma);
      const nfOut = path.join(tmp, 'nofrma-out.mp4');
      check('无 frma 时减壳成功（子盒推断）', Mp4.stripEncryption(nfIn, nfOut), '');
      if (fs.existsSync(nfOut)) {
        const nb = fs.readFileSync(nfOut);
        const nfStsd = indexOfType(nb, 'stsd');
        const nfType = nfStsd >= 0
          ? nb.toString('latin1', nfStsd + 8 + 8 + 4, nfStsd + 8 + 8 + 8)
          : '?';
        check('无 frma 时按 hvcC 推断为 hvc1', nfType === 'hvc1', nfType);
      }
    }
  } catch (e) {
    check('CENC 减壳', false, String(e.message));
  } finally {
    if (tmp !== null) deleteTree(tmp);
  }
}

/**
 * 21. 分享链接解析（纯文本，不访问网络）。
 * 覆盖：整段分享文案抠 URL / 剧名、域名白名单防 SSRF、
 * 落地页 URL + SSR flight 分块解析、标题兜底与剧名归一化。
 */
function shareLink() {
  section('21. 分享链接解析（纯文本，不依赖网络）');

  const sample = '漫剧《冷宫开席：陛下又来蹭饭了第四季》 - 免费好剧，尽在红果\r\n'
    + '点击链接打开👉https://novelquickapp.com/s/5em_xJT-hmg/\r\n'
    + '复制本条消息后，打开「红果短剧App」后免费看全集~';
  const p = ShareLink.parseShareText(sample);
  check('整段分享文案抠出短链',
    p.url === 'https://novelquickapp.com/s/5em_xJT-hmg/', p.url);
  check('整段分享文案抠出剧名提示',
    p.titleHint === '冷宫开席：陛下又来蹭饭了第四季', p.titleHint);
  check('URL 尾部中文标点被剔除',
    ShareLink.parseShareText('https://novelquickapp.com/s/abc/，快来看').url
      === 'https://novelquickapp.com/s/abc/', '');
  check('裸链自动补协议',
    ShareLink.parseShareText('打开 novelquickapp.com/s/abc/ 看看').url
      === 'https://novelquickapp.com/s/abc/', '');
  check('无链接时返回空', ShareLink.parseShareText('随便一段文字').url === '', '');

  check('白名单-接受短链域名',
    ShareLink.allowedHost('https://novelquickapp.com/s/abc/') !== null, '');
  check('白名单-接受官网子域',
    ShareLink.allowedHost('https://www.hongguoduanju.com/player/7704293880799185982') !== null, '');
  check('白名单-拒绝内网',
    ShareLink.allowedHost('http://127.0.0.1:8000/') === null, '');
  check('白名单-拒绝无关域名',
    ShareLink.allowedHost('https://example.com/s/abc/') === null, '');
  check('白名单-拒绝带账号信息',
    ShareLink.allowedHost('https://u:p@novelquickapp.com/s/abc/') === null, '');
  check('白名单-拒绝非标端口',
    ShareLink.allowedHost('https://novelquickapp.com:22/s/abc/') === null, '');

  const flight = ['video-animation-share_page', 'pageData', {
    series_data: {
      title: '冷宫开席：陛下又来蹭饭了第四季',
      series_cover: 'https://p6-novel-sign.byteimg.com/cover.webp',
      series_intro: '冷宫之中长大的林小满',
      serial_count: 109,
    },
    chapter_ids: ['7704295597846563865', '7704295599830486041'],
    chapter_order: 1,
    used_chapter_id: '7704295597846563865',
  }];
  const escaped = Json.stringify(flight).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const html = '<html><head><title>红果短剧 ｜ 跟我一起免费看《冷宫开席：陛下又来蹭饭了第四季》'
    + '</title></head><body><script async data-fn-args="' + escaped + '"></script></body></html>';
  const landing = 'https://novelquickapp.com/hongguo/ug/pages/video-animation-share'
    + '?video_id=7704293880799185982&vid=7704295599830486041'
    + '&share_toast_vid=7704295597846563865&page_type=video-animation-share'
    + '&report_params=' + encodeURIComponent(Json.stringify({
      content_type: 'motion_comic', content_id: '7704295599830486041',
    }));
  const info = ShareLink.parseLanding(landing, html, '');
  check('落地页-video_id 即 series_id',
    info.seriesId === '7704293880799185982' && info.seriesIdFrom === 'video_id',
    info.seriesId + '/' + info.seriesIdFrom);
  check('落地页-SSR 剧名',
    info.title === '冷宫开席：陛下又来蹭饭了第四季', info.title);
  check('落地页-集数 / 封面 / 简介',
    info.episodeCnt === 109 && info.cover !== '' && info.intro === '冷宫之中长大的林小满', '');
  check('落地页-分享集 vid', info.vid === '7704295599830486041', info.vid);
  check('落地页-分集表', info.chapterIds.length === 2, String(info.chapterIds.length));
  check('落地页-页面/内容类型',
    info.pageType === 'video-animation-share' && info.contentType === 'motion_comic', '');

  const noFlight = ShareLink.parseLanding(
    'https://novelquickapp.com/hongguo/ug/pages/video-share?series_id=7704293880799185982',
    '<title>红果短剧 ｜ 跟我一起免费看《测试剧第二季》</title>', '');
  check('无 SSR 时用 <title> 兜底剧名', noFlight.title === '测试剧第二季', noFlight.title);
  check('显式 series_id 优先',
    noFlight.seriesId === '7704293880799185982' && noFlight.seriesIdFrom === 'series_id',
    noFlight.seriesIdFrom);
  const player = ShareLink.parseLanding(
    'https://hongguoduanju.com/player/7704293880799185982', '', '《提示剧名》');
  check('官网播放页路径取 series_id',
    player.seriesId === '7704293880799185982' && player.seriesIdFrom === 'player_path',
    player.seriesId);
  check('文案《...》最终兜底剧名', player.title === '提示剧名', player.title);

  check('剧名归一化忽略标点空白',
    ShareLink.normalizeTitle('冷宫开席：陛下又来蹭饭了 第四季')
      === '冷宫开席陛下又来蹭饭了第四季', '');
  check('同名相似度 100',
    ShareLink.titleScore('冷宫开席：陛下又来蹭饭了第四季', '冷宫开席:陛下又来蹭饭了第四季') === 100, '');
  check('不同季不等价',
    ShareLink.titleScore('冷宫开席：陛下又来蹭饭了第四季', '冷宫开席：陛下又来蹭饭了第三季') < 100, '');
  check('HTML 实体单次扫描解码',
    ShareLink.decodeHtml('&amp;quot;') === '&quot;', ShareLink.decodeHtml('&amp;quot;'));
}

// ==================== 季数解析工具 ====================

function seasonUtil() {
  section('util/season');
  const Season = require('./util/season');

  check('无季数剧名',
    Season.parseSeason('某某短剧').season === 1
    && Season.parseSeason('某某短剧').explicit === false,
    JSON.stringify(Season.parseSeason('某某短剧')));

  check('第N季格式',
    Season.parseSeason('冷宫开席第四季').season === 4
    && Season.parseSeason('冷宫开席第四季').explicit === true,
    JSON.stringify(Season.parseSeason('冷宫开席第四季')));

  check('第N部格式',
    Season.parseSeason('某某故事第二部').season === 2,
    JSON.stringify(Season.parseSeason('某某故事第二部')));

  check('（N）格式',
    Season.parseSeason('某某短剧（3）').season === 3
    && Season.parseSeason('某某短剧(3)').season === 3,
    JSON.stringify(Season.parseSeason('某某短剧(3)')));

  check('括号年份不误判（>99）',
    Season.parseSeason('某某短剧（2025）').season === 1
    && Season.parseSeason('某某短剧（2025）').explicit === false,
    JSON.stringify(Season.parseSeason('某某短剧（2025）')));

  check('Season N 格式',
    Season.parseSeason('My Show Season 2').season === 2
    && Season.parseSeason('My Show Season 2').explicit === true
    && Season.parseSeason('My Show Season 2').base === 'My Show',
    JSON.stringify(Season.parseSeason('My Show Season 2')));

  check('中文数字「两」',
    Season.parseSeason('某某剧第二部').season === 2
    && Season.parseSeason('某某剧第两部').season === 2,
    JSON.stringify(Season.parseSeason('某某剧第两部')));

  check('normalizeTitle 去标点全角',
    Season.normalizeTitle('冷宫开席：陛下（第四季）') === Season.normalizeTitle('冷宫开席陛下第四季'),
    Season.normalizeTitle('冷宫开席：陛下（第四季）'));

  check('titleScore 同名 = 100',
    Season.titleScore('冷宫开席', '冷宫开席') === 100, '');

  check('titleScore 含季名 > 50',
    Season.titleScore('冷宫开席', '冷宫开席第四季') > 50,
    String(Season.titleScore('冷宫开席', '冷宫开席第四季')));

  check('titleScore 无关剧 = 0',
    Season.titleScore('冷宫开席', '完全无关剧名') === 0,
    String(Season.titleScore('冷宫开席', '完全无关剧名')));

  check('关联剧集关键词 = 基础名 + 第',
    Season.seasonKeyword(Season.parseSeason('冷宫开席第四季').base) === '冷宫开席第'
    && Season.seasonKeyword('某某短剧') === '某某短剧第',
    Season.seasonKeyword('某某短剧'));

  check('关键词不重复追加「第」且去空白',
    Season.seasonKeyword('某某第') === '某某第'
    && Season.seasonKeyword('  某某短剧  ') === '某某短剧第',
    Season.seasonKeyword('某某第'));

  check('空剧名关键词为空',
    Season.seasonKeyword('') === '' && Season.seasonKeyword(null) === '', '');
}

/** 22. 制作方匹配（关联剧集按 Copyright 过滤的纯函数）。 */
function copyrightMatch() {
  section('22. 制作方匹配（关联剧集过滤）');
  const N = Client.normalizeCopyright;
  const M = Client.copyrightMatches;

  check('归一化去掉首尾与中间空白',
    N('  某某 文化  传媒 ') === '某某文化传媒', N('  某某 文化  传媒 '));
  check('归一化统一全角字符',
    N('ＡＢＣ（北京）文化') === N('ABC(北京)文化'),
    N('ＡＢＣ（北京）文化') + ' / ' + N('ABC(北京)文化'));
  check('归一化大小写', N('ABC Studio') === N('abc studio'), '');
  check('空值归一化为空白串',
    N(null) === '' && N(undefined) === '' && N('   ') === '', '');

  check('同名制作方匹配', M('青椒剪辑', '青椒剪辑'), '');
  check('空白 / 全角差异仍匹配',
    M(' 某某（北京）文化 ', '某某(北京)文化'), '');
  check('不同制作方被过滤', !M('青椒剪辑', '别的制作方'), '');
  check('结果缺 copyright 被过滤',
    !M('青椒剪辑', '') && !M('青椒剪辑', null), '');
  check('当前制作方为空时不过滤（避免按钮失效）',
    M('', '任意制作方') && M(null, '') && M(undefined, '任意'), '');
}

/** 23. 播放专用真实签名：551 Argus / Ladon（固定黄金向量，离线）。 */
function playbackSign() {
  section('23. 播放签名（551 Argus / Ladon）：固定向量与签名绑定');
  const PlaySign = require('./core/playback-sign');

  // Ladon：固定 4 字节随机量的黄金向量
  check('Ladon: 固定随机量向量一致',
    PlaySign.Ladon.encrypt(1700000000, 1611921764, 1967, Buffer.from('01020304', 'hex'))
    === 'AQIDBKM7Y7bWnOIUXmTybD6/MpGbuge4sBwUJsyHVivhtMsH', '');

  // Argus 摘要：无正文按 16 个零字节算，有正文按 stub 的 md5 算
  check('Argus: 无正文 bodyHash 为 sm3(16 零字节) 前 6 字节',
    PlaySign.Argus.bodyHash('').toString('hex') === '106e34a2b8c7',
    PlaySign.Argus.bodyHash('').toString('hex'));
  check('Argus: queryHash 为 sm3(query 原文) 前 6 字节',
    PlaySign.Argus.queryHash('aid=1967&device_id=123').toString('hex') === '925b8d86b20f',
    PlaySign.Argus.queryHash('aid=1967&device_id=123').toString('hex'));
  check('Argus: body 摘要取 md5(stub) 的 sm3 前 6 字节',
    PlaySign.Argus.bodyHash('ac3ef48caa08fa3ed5e025da69edc645').toString('hex') === '5048b6e949d0',
    PlaySign.Argus.bodyHash('ac3ef48caa08fa3ed5e025da69edc645').toString('hex'));

  // Simon：64 位运算必须全程 BigInt，否则轮密钥丢精度
  const simonKey = [1111111111111111111n, 2222222222222222222n,
    3333333333333333333n, 4444444444444444444n];
  const simon = PlaySign.Simon.encrypt(1234567890123456789n, 9876543210987654321n, simonKey);
  check('Simon: 分组加密向量一致',
    simon[0] === 6071150433487837324n && simon[1] === 2027321285990159935n,
    simon[0] + ',' + simon[1]);

  // Argus 密文：四条独立黄金向量（字段、时间、device_id 各不相同）
  const golden = [
    ['aid=1967&device_id=dev_aaaaaaaa&iid=111', 1700000000, 659662259,
      '8oHyrVYEy1xDCDlx64ko40qC6JC9VYY/ZkjJzEl50iSFDw8Yfph1hupLxfKrA9GswSEz0Yi4goA7OQ4u+H8ECdOaQDL4GduQ3LULSq9Q4iSEGbS3L6G24GXChtnmPr6n46M2PLlKpXvF7uE0lhH4yD+X69FpdM41gQwx5Y5U3NdwXFaxlqYFszyp7dlUE6BEBWqwDsiAH8Jk9TGKr/jfHt4fVmMc9zRyNRdGeV0x6aP//x7aV+8Po8a/9KK3UNG5KEpmIgzRT6NUttkBP9gRNUh3'],
    ['aid=1967&device_id=X&iid=333', 1234567890, 554000487,
      '8oEOCRTb0LQf+M+MsliYu4M9kBzAlzXvFgL/Ub198hyoBGxYfNXLAENmH+K/10JQ+Rbhm2zRxNtNv5wVd885xcb6C6F10zp/9jVeGHGz8plz8W3UXHHNrFKjJptjQElGDbyaVLSKt56+HfwO7ENYMfjVv/5PNi1upVciiHqyOPDDAtwi/fZkwBoU1kC7RolMOuedn4lCg/s0CjnNvxFT0QpF/K0yoW3Zpu30tkadIET7WbZ3+7KT3c1yAA6RKWI4mmw='],
    ['aid=1967&device_id=test_device_id&iid=456&version_name=6.5.1.32', 1700000000, 420072733,
      '8oHu8LnZm0OtJJIaSr1427D+yeH70h5aZTVjoSW7MfFi/hk1LhjTqsEEWYpwcHfK4/2SXuJxTtopRcPeHzVpeFpUD4B4yxEG7REejpCZ1OqeAaLsw/lMebwUjUHrUjnAZCKq0QyimnwdiTiYIsH3GfiK/xlPcFcARqwX7RkI1qnnWUgiJVDEacSm8yhBat6MvDVOa7+U2MgcLu7Q26pFzX8VX5F+ryP76ETs1nRGLmlhHkwyiKb6CETstvGQnJgocgZBNNvlHD2/P+4LWjFMvhNK'],
  ];
  for (const [query, ts, randField, want] of golden) {
    const deviceId = new URLSearchParams(query).get('device_id');
    check('Argus 密文向量: ' + deviceId,
      PlaySign.Argus.sign(query, '', ts, 1967, 1611921764, deviceId, '', randField) === want, '');
  }

  // 签名与最终 query / 实际 body 绑定
  const query = golden[2][0];
  const fixed = { query, ts: 1700000000, randField: 420072733,
    ladonRandom: Buffer.from('01020304', 'hex') };
  const empty = PlaySign.signPlayer(Object.assign({ body: null }, fixed));
  check('签名字段齐全（ticket / khronos / ladon / argus）',
    ['x-ss-req-ticket', 'x-khronos', 'x-ladon', 'x-argus'].every((k) => empty[k] !== undefined), '');
  check('x-ss-req-ticket 为秒级时间戳的毫秒值',
    empty['x-ss-req-ticket'] === '1700000000000' && empty['x-khronos'] === '1700000000', '');
  check('无正文不带 x-ss-stub',
    empty['x-ss-stub'] === undefined, String(empty['x-ss-stub']));
  check('空 Buffer 与 null 签名一致（无正文语义）',
    JSON.stringify(PlaySign.signPlayer(Object.assign({ body: Buffer.alloc(0) }, fixed))) === JSON.stringify(empty), '');

  const body = Buffer.from('{"x":1}');
  const signed = PlaySign.signPlayer(Object.assign({ body }, fixed));
  check('正文摘要对实际发送的 Buffer 计算',
    signed['x-ss-stub'] === 'ac3ef48caa08fa3ed5e025da69edc645', String(signed['x-ss-stub']));
  check('正文变化会改变 x-argus（摘要参与签名）',
    signed['x-argus'] !== empty['x-argus'], '');
  check('正文变化不影响 x-ladon（只绑时间与 aid）',
    signed['x-ladon'] === empty['x-ladon'], '');
  check('query 字节变化会改变 x-argus',
    PlaySign.signPlayer({ query: query + '&extra=*', body, ts: 1700000000, randField: 420072733 })
      ['x-argus'] !== PlaySign.signPlayer({ query: query + '&extra=%2A', body, ts: 1700000000, randField: 420072733 })
      ['x-argus'], '');
  check('时间戳变化会同时改变 x-argus 与 x-ladon',
    PlaySign.signPlayer({ query, body, ts: 1700000001, randField: 420072733 })['x-argus']
      !== signed['x-argus']
    && PlaySign.signPlayer({ query, body, ts: 1700000001, randField: 420072733 })['x-ladon']
      !== signed['x-ladon'], '');
  check('iid 不进入 Argus 的 field16（installId 由调用方给空）',
    signed['x-argus'] === PlaySign.Argus.sign(query, 'ac3ef48caa08fa3ed5e025da69edc645',
      1700000000, 1967, 1611921764, 'test_device_id', '', 420072733), '');

  // 播放请求必须走真实签名，不能退回占位头
  check('播放签名导出 signPlayer',
    typeof PlaySign.signPlayer === 'function', '');
  check('播放取流节奏间隔已导出',
    AppSource.PLAYBACK_INTERVAL_MS > 0, AppSource.PLAYBACK_INTERVAL_MS + 'ms');
}

/** 19. App 取址链路：播放设备参数、python 风格 query 编码、URL 白名单。 */
// ==================== 入口 ====================

async function run() {
  console.log('');
  console.log('  ============================================');
  console.log('    hongguo-api 自检');
  console.log('  ============================================');

  try {
    spade();
    ctrCounter();
    ivToCounter();
    avcc();
    ctrRoundTrip();
    mp4Boxes();
    decryptEndToEnd();
    json();
    cachePaths();
    device();
    pureSign();
    episodeTitle();
    keyStore();
    moovLocator();
    streamingDecrypt();
    await cacheBounds();
    streamCacheLimit();
    searchPageSlice();
    appSource();
    cencStrip();
    shareLink();
    seasonUtil();
    copyrightMatch();
    playbackSign();
  } catch (e) {
    failed++;
    console.log('  ✗ 自检异常中断：' + e);
    if (e && e.stack) console.log(e.stack);
  }

  section('运行环境');
  console.log('  上游 host     ' + Client.HOST);
  console.log('  App 源 host   ' + AppSource.VIDEO_API_HOST);
  console.log('  设备身份     ' + Client.identity().source
    + '（device_id=' + Client.identity().deviceId + '）');
  console.log('  托管模式     ' + Client.MANAGED);
  console.log('  列表签名     ' + (Client.SIGN_LIST ? '开启（上游 landpage 需签名，关闭会返回 0 字节）' : '关闭'));
  console.log('  签名方式     本地纯代码签名（PureSign）');
  console.log('  播放签名     551 Argus + Ladon（PlaybackSign）');
  console.log('  转码         不转码（源流 H.264 / HEVC 直出）');
  console.log('  Node         ' + process.version);

  console.log('');
  const total = passed + failed;
  const verdict = failed === 0 ? ' 全部通过' : '，失败 ' + failed + ' 项';
  console.log('  结果：' + passed + '/' + total + verdict);
  if (skipped > 0) {
    console.log('  跳过 ' + skipped + ' 项（依赖运行态产物，不计入失败）');
  }
  console.log('');
  return failed === 0 ? 0 : 1;
}

module.exports = { run };
