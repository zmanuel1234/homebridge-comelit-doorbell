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
