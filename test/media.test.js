const test = require('node:test');
const assert = require('node:assert');
const { parseRtp, buildRtp, H264Depacketizer, KeyframeCache, nalType } = require('../dist/media');

const rtp = (seq, payload, pt = 96) => buildRtp({ marker: false, payloadType: pt, sequence: seq, timestamp: 0, ssrc: 1 }, Buffer.from(payload));

test('RTP round trip', () => {
  const p = parseRtp(rtp(7, [1, 2, 3], 8));
  assert.strictEqual(p.payloadType, 8);
  assert.strictEqual(p.sequence, 7);
  assert.deepStrictEqual([...p.payload], [1, 2, 3]);
  assert.strictEqual(parseRtp(Buffer.from([0, 1, 2])), null);
});

test('H.264: single NAL, STAP-A and FU-A become Annex-B units', () => {
  const d = new H264Depacketizer();
  assert.deepStrictEqual(d.push(parseRtp(rtp(1, [0x41, 0xaa]))), [Buffer.from([0, 0, 0, 1, 0x41, 0xaa])]);
  const stap = d.push(parseRtp(rtp(2, [0x18, 0, 2, 0x67, 0x01, 0, 2, 0x68, 0x02])));
  assert.deepStrictEqual(stap, [Buffer.from([0, 0, 0, 1, 0x67, 0x01]), Buffer.from([0, 0, 0, 1, 0x68, 0x02])]);
  assert.deepStrictEqual(d.push(parseRtp(rtp(3, [0x7c, 0x85, 0x10]))), []);
  assert.deepStrictEqual(d.push(parseRtp(rtp(4, [0x7c, 0x05, 0x11]))), []);
  assert.deepStrictEqual(d.push(parseRtp(rtp(5, [0x7c, 0x45, 0x12]))), [Buffer.from([0, 0, 0, 1, 0x65, 0x10, 0x11, 0x12])]);
});

test('H.264: a lost FU-A fragment drops the unit', () => {
  const d = new H264Depacketizer();
  d.push(parseRtp(rtp(10, [0x7c, 0x85, 0x10])));
  assert.deepStrictEqual(d.push(parseRtp(rtp(12, [0x7c, 0x45, 0x12]))), []);
});

test('keyframe cache keeps SPS, PPS and the latest keyframe', () => {
  const k = new KeyframeCache();
  const u = (b) => Buffer.from([0, 0, 0, 1, ...b]);
  assert.strictEqual(k.keyframe(), undefined);
  [u([0x67, 1]), u([0x68, 2]), u([0x65, 3]), u([0x65, 4]), u([0x41, 5]), u([0x65, 6])].forEach((x) => k.push(x));
  assert.deepStrictEqual(k.keyframe(), Buffer.concat([u([0x67, 1]), u([0x68, 2]), u([0x65, 6])]));
  assert.strictEqual(nalType(u([0x65])), 5);
});

test('the built-in still picture ships with the package and ffmpeg is found in known places', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { DEFAULT_STILL, resolveFfmpeg } = require('../dist/camera');
  const jpg = fs.readFileSync(DEFAULT_STILL);
  assert.ok(jpg[0] === 0xff && jpg[1] === 0xd8, 'JPEG');
  assert.ok(require('../package.json').files.includes('assets'));
  assert.strictEqual(resolveFfmpeg('/opt/my/ffmpeg'), '/opt/my/ffmpeg');
  // ffmpeg inside the scoped camera-ffmpeg package
  const nm = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-'));
  const nested = path.join(nm, '@homebridge-plugins', 'homebridge-camera-ffmpeg', 'node_modules', 'ffmpeg-for-homebridge', 'ffmpeg');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, '');
  assert.strictEqual(resolveFfmpeg('', nm), nested);
});

test('an old keyframe is not used', async () => {
  const k = new KeyframeCache();
  const u = (b) => Buffer.from([0, 0, 0, 1, ...b]);
  [u([0x67]), u([0x68]), u([0x65])].forEach((x) => k.push(x));
  assert.ok(k.keyframe(1000));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(k.keyframe(10), undefined);
  assert.ok(k.keyframe());
});

test('ffmpeg video arguments stream SRTP to HomeKit', () => {
  const { videoArgs, audioArgs, talkSdp } = require('../dist/camera');
  const srtp = Buffer.alloc(30, 1);
  const v = videoArgs({ width: 1280, height: 720, fps: 15, bitrate: 299, pt: 99, ssrc: 5, srtp, address: '10.0.0.9', port: 5000, mtu: 1316, codec: 'libx264' });
  assert.deepStrictEqual(v.slice(v.indexOf('-f'), v.indexOf('-f') + 2), ['-f', 'h264']);
  assert.ok(v.includes('libx264') && v.includes('299k') && v.includes('yuv420p'));
  assert.strictEqual(v.at(-1), 'srtp://10.0.0.9:5000?rtcpport=5000&pkt_size=1316');
  assert.ok(videoArgs({ width: 1, height: 1, fps: 1, bitrate: 1, pt: 1, ssrc: 1, srtp, address: 'a', port: 1, mtu: 1, codec: 'copy' }).join(' ').includes('-c:v copy'));
  const a = audioArgs({ sampleRate: 16, bitrate: 24, pt: 110, ssrc: 6, srtp, address: '10.0.0.9', port: 5002 });
  assert.ok(a.join(' ').includes('-f alaw -ar 8000 -ac 1 -i pipe:0') && a.includes('libfdk_aac') && a.includes('16k'));
  assert.ok(talkSdp('10.0.0.9', false, 5004, srtp).includes('m=audio 5004 RTP/AVP 110'));
});

test('a snapshotImage that does not exist falls back to the built-in picture, with one warning', async () => {
  const { DoorbellCamera, DEFAULT_STILL } = require('../dist/camera');
  const { quietLog } = require('./helpers');
  const log = quietLog();
  const self = { settings: { snapshotImage: '/nonexistent/doorbell.jpg' }, log, warnedMissingImage: false };
  const pick = DoorbellCamera.prototype.placeholderPath;
  assert.strictEqual(await pick.call(self), DEFAULT_STILL);
  assert.strictEqual(await pick.call(self), DEFAULT_STILL);
  assert.strictEqual(log.lines.filter((l) => /not found/.test(l)).length, 1);
  self.settings.snapshotImage = DEFAULT_STILL;
  assert.strictEqual(await pick.call(self), DEFAULT_STILL);
});

test('parseSps reads the picture size (SPS made by x264)', () => {
  const { parseSps } = require('../dist/media');
  const cases = {
    '000000016742c00cd90141fb011000000300100000030200f142a480': [320, 240, 66],
    '000000016742c01ed900c83db011000003000100000300200f162e48': [800, 480, 66],
    '000000016742c016d900a02ff97011000003000100000300200f162e48': [640, 360, 66],
    '000000016764001eacd940c83db011000003000100000300200f162d96': [800, 480, 100],
    '00000001674d401feca02802dd80880000030008000003010078c18cb0': [1280, 720, 77],
  };
  for (const [hex, [w, h, p]] of Object.entries(cases)) {
    const s = parseSps(Buffer.from(hex, 'hex'));
    assert.deepStrictEqual([s.width, s.height, s.profile], [w, h, p], hex);
  }
  assert.strictEqual(parseSps(Buffer.from('0000000165888000', 'hex')), undefined, 'not an SPS');
  assert.strictEqual(parseSps(Buffer.from('0000000167', 'hex')), undefined, 'too short');
});

test('countRtcpReports counts receiver and sender reports in a compound packet', () => {
  const { countRtcpReports } = require('../dist/camera');
  const rr = Buffer.from('81c90007' + '00'.repeat(28), 'hex'); // RR with one report block (8 words)
  const sdes = Buffer.from('81ca0002' + '00'.repeat(8), 'hex');
  assert.strictEqual(countRtcpReports(Buffer.concat([rr, sdes])), 1);
  assert.strictEqual(countRtcpReports(Buffer.concat([rr, rr, Buffer.alloc(10)])), 2, 'SRTCP trailer ignored');
  assert.strictEqual(countRtcpReports(Buffer.from('deadbeef', 'hex')), 0);
});

test('media capture keeps the last 10 calls', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { MediaCapture } = require('../dist/camera');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  for (let i = 0; i < 12; i++) {
    for (const ext of ['.h264', '.alaw', '-talkback.alaw']) {
      fs.writeFileSync(path.join(dir, `call-20261108-1800${String(i).padStart(2, '0')}${ext}`), 'x');
    }
  }
  await MediaCapture.prepare(dir);
  const left = fs.readdirSync(dir).sort();
  assert.strictEqual(left.length, 27, '9 old calls x 3 files, room for the new one');
  assert.ok(left[0].startsWith('call-20261108-180003'));
  const c = new MediaCapture(dir);
  c.close();
  fs.rmSync(dir, { recursive: true });
});

test('the 6741W video: its SPS reads as 640x240, and the ffmpeg arguments handle it', () => {
  const { parseSps } = require('../dist/media');
  const { videoArgs, LIVE_INPUT } = require('../dist/camera');
  // SPS from a real call (2026-11-08); its timing says 1,200,000 fps.
  const s = parseSps(Buffer.from('000000016742001fe90140fd00b1021280', 'hex'));
  assert.deepStrictEqual([s.width, s.height, s.profile], [640, 240, 66]);
  const v = videoArgs({ width: 1280, height: 720, fps: 16, bitrate: 299, pt: 99, ssrc: 5, srtp: Buffer.alloc(30), address: 'a', port: 1, mtu: 1316, codec: 'libx264' });
  // arrival time instead of the SPS's timing, and showing from the first keyframe
  const i = v.indexOf(LIVE_INPUT[0]);
  assert.deepStrictEqual(v.slice(i, i + LIVE_INPUT.length), LIVE_INPUT);
  assert.ok(LIVE_INPUT.includes('+showall'));
  assert.strictEqual(v[v.indexOf('-g') + 1], '32', 'a keyframe every 2 s at 16 fps');
  // each frame gets its arrival time (works with ffmpeg 7.0 and 8), then 640x240 is stretched
  // back to 4:3 before fitting the Home app's size
  assert.match(v[v.indexOf('-vf') + 1], /^setpts=\(RTCTIME-RTCSTART\)\/\(TB\*1000000\),scale=w=iw:h='if\(gt\(iw\/ih,2\),2\*ih,ih\)',setsar=1,scale=1280:720/);
  // the still picture keeps its own timing
  const still = videoArgs({ width: 1280, height: 720, fps: 16, bitrate: 299, pt: 99, ssrc: 5, srtp: Buffer.alloc(30), address: 'a', port: 1, mtu: 1316, codec: 'libx264', live: false });
  assert.match(still[still.indexOf('-vf') + 1], /^scale=w=iw/);
});

test('the last visitor picture is the call\'s first keyframe, not its last', () => {
  const { KeyframeCache } = require('../dist/media');
  const k = new KeyframeCache();
  const u = (type, tag) => Buffer.from([0, 0, 0, 1, type, tag]);
  const call = {};
  k.newCall(call);
  for (const [t, tag] of [[7, 1], [8, 1], [5, 1], [1, 1], [1, 2], [7, 2], [8, 2], [5, 2], [1, 3]]) {
    k.push(u(t, tag));
  }
  assert.strictEqual(k.visitor().at(-1), 1, 'first keyframe of the call');
  assert.strictEqual(k.keyframe().at(-1), 2, 'live views still join at the latest keyframe');
  k.newCall(call); // the same call viewed again: keep its picture
  k.push(u(5, 3));
  k.push(u(1, 4));
  assert.strictEqual(k.visitor().at(-1), 1);
  k.newCall({}); // a new call: its first keyframe
  k.push(u(5, 4));
  k.push(u(1, 5));
  assert.strictEqual(k.visitor().at(-1), 4);
  assert.strictEqual(k.visitor(-1), undefined, 'too old');
});
