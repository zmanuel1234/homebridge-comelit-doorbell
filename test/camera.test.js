const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const hap = require('@homebridge/hap-nodejs');
const { DoorbellCamera } = require('../dist/camera');
const { resolveSettings } = require('../dist/config');
const { quietLog } = require('./helpers');

function fakeProcess() {
  const p = new EventEmitter();
  p.exitCode = null;
  p.stdin = Object.assign(new EventEmitter(), { written: [], write(b) { p.stdin.written.push(b); return true; }, end() {}, destroy() {} });
  p.stdout = new EventEmitter();
  p.kill = () => { p.exitCode = 0; };
  return p;
}

function fakeMedia() {
  const m = new EventEmitter();
  m.ended = 0;
  m.end = async () => { m.ended++; };
  m.describe = () => 'fake';
  m.sendAudio = async () => undefined;
  return m;
}

function camera(config = {}, media) {
  const settings = resolveSettings({ camera: true, answerMode: 'answer-on-view', host: 'h', token: 't', ...config });
  const call = media ? { startMedia: async () => media } : undefined;
  const cam = new DoorbellCamera({ hap }, quietLog(), settings, () => call);
  cam.spawned = [];
  cam.spawnProcess = (what) => { const p = fakeProcess(); cam.spawned.push([what, p]); return p; };
  return cam;
}

function pending(cam, id) {
  cam.pending.set(id, {
    address: '127.0.0.1', ipv6: false, videoPort: 9, videoReturnPort: 0, videoSrtp: Buffer.alloc(30), videoSsrc: 1,
    audioPort: 9, audioReturnPort: 0, audioSrtp: Buffer.alloc(30), audioSsrc: 2,
  });
}

const request = (id) => ({
  type: 'start', sessionID: id,
  video: { width: 640, height: 480, fps: 15, max_bit_rate: 300, pt: 99, mtu: 1378, rtcp_interval: 0.5 },
  audio: { sample_rate: 16, max_bit_rate: 24, pt: 110 },
});

test('a viewer that leaves while the still picture is prepared starts no ffmpeg (beta.26)', async () => {
  const cam = camera();
  let release;
  cam.lastVisitor = () => new Promise((r) => (release = r));
  cam.placeholderPath = async () => '/nonexistent.jpg';
  pending(cam, 'aaaaaaaa-1');
  const starting = cam.startStream('aaaaaaaa-1', request('aaaaaaaa-1'));
  await new Promise((r) => setImmediate(r));
  await cam.stopStream('aaaaaaaa-1', 'viewer closed');
  release(Buffer.from('jpeg'));
  await starting;
  assert.deepStrictEqual(cam.spawned, []);
  assert.strictEqual(cam.active.size, 0);
});

test('a viewer that leaves while the recording starts starts no ffmpeg and closes the recording (beta.26)', async () => {
  const media = fakeMedia();
  const cam = camera({ mediaCaptureDir: '/tmp/x', talkBack: false }, media);
  let release;
  let closed = 0;
  cam.startCapture = () => new Promise((r) => (release = r));
  pending(cam, 'bbbbbbbb-1');
  const starting = cam.startStream('bbbbbbbb-1', request('bbbbbbbb-1'));
  while (!release) await new Promise((r) => setImmediate(r));
  await cam.stopStream('bbbbbbbb-1', 'viewer closed');
  release({ close: () => closed++, video: { write() {} }, audio: { write() {} }, talk: { write() {} } });
  await starting;
  assert.deepStrictEqual(cam.spawned, []);
  assert.strictEqual(closed, 1);
  assert.strictEqual(media.ended, 1, 'ended once, by the viewer leaving');
  assert.strictEqual(media.listenerCount('video'), 0);
});

test('two viewers of one call feed the keyframe cache once (beta.26)', async () => {
  const media = fakeMedia();
  const cam = camera({ talkBack: false }, media);
  let pushes = 0;
  const push = cam.keyframes.push.bind(cam.keyframes);
  cam.keyframes.push = (u) => { pushes++; push(u); };
  for (const id of ['cccccccc-1', 'cccccccc-2']) {
    pending(cam, id);
    await cam.startStream(id, request(id));
  }
  media.emit('video', Buffer.from([0, 0, 0, 1, 0x67, 1]));
  assert.strictEqual(pushes, 1);
  // both views got it
  const videos = cam.spawned.filter(([w]) => w === 'video').map(([, p]) => p.stdin.written.length);
  assert.deepStrictEqual(videos, [1, 1]);
  await cam.stopStream('cccccccc-1', 'test');
  await cam.stopStream('cccccccc-2', 'test');
  assert.strictEqual(media.ended, 1);
});
