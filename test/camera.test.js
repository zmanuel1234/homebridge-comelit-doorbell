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

test('a call that ends while the recording starts ends the view instead of starting ffmpeg (beta.26)', async () => {
  const media = fakeMedia();
  const cam = camera({ mediaCaptureDir: '/tmp/x', talkBack: false }, media);
  let release;
  let closed = 0;
  let forced = 0;
  cam.controller.forceStopStreamingSession = () => forced++;
  cam.startCapture = () => new Promise((r) => (release = r));
  pending(cam, 'dddddddd-1');
  const starting = cam.startStream('dddddddd-1', request('dddddddd-1'));
  while (!release) await new Promise((r) => setImmediate(r));
  Object.defineProperty(media, 'isEnded', { value: true });
  media.emit('end', 'the intercom ended the call');
  release({ close: () => closed++, video: { write() {} }, audio: { write() {} }, talk: { write() {} } });
  await starting;
  assert.deepStrictEqual(cam.spawned, []);
  assert.strictEqual(closed, 1);
  assert.strictEqual(forced, 1);
  assert.strictEqual(cam.active.size, 0);
});

test('media that already ended when the view starts gives the still picture (beta.26)', async () => {
  const media = fakeMedia();
  Object.defineProperty(media, 'isEnded', { value: true });
  const cam = camera({ talkBack: false }, media);
  cam.lastVisitor = async () => undefined;
  cam.placeholderPath = async () => '/nonexistent.jpg';
  pending(cam, 'eeeeeeee-1');
  await cam.startStream('eeeeeeee-1', request('eeeeeeee-1'));
  assert.deepStrictEqual(cam.spawned.map(([w]) => w), ['video']);
  assert.strictEqual(media.listenerCount('video'), 0);
  await cam.stopStream('eeeeeeee-1', 'test');
});

test("ring preview video becomes the visitor's picture (test build)", () => {
  const cam = camera({ ringPreview: true });
  const callObj = {};
  for (const u of [[0x67, 1], [0x68, 2], [0x65, 3], [0x41, 4]]) cam.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u]));
  const v = cam.keyframes.visitor(60_000);
  assert.ok(v && v.includes(0x65));
});

test("the last visitor's picture survives a restart, and expires with lastVisitorMinutes (beta.27)", async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comelit-visitor-'));
  const make = (config = {}) => {
    const settings = resolveSettings({ camera: true, answerMode: 'answer-on-view', host: 'h', token: 't', ...config });
    return new DoorbellCamera({ hap, user: { storagePath: () => dir } }, quietLog(), settings, () => undefined);
  };
  const file = path.join(dir, 'comelit-last-visitor.h264');
  const first = make();
  const callObj = {};
  for (const u of [[0x67, 1], [0x68, 2], [0x65, 3], [0x41, 4]]) first.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u]));
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fs.existsSync(file), 'saved');
  const restarted = make();
  for (let i = 0; i < 100 && !restarted.keyframes.visitor(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(restarted.keyframes.visitor(), first.keyframes.visitor());
  // older than lastVisitorMinutes: not shown
  const old = (Date.now() - 2 * 60_000) / 1000;
  fs.utimesSync(file, old, old);
  const later = make({ lastVisitorMinutes: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(later.keyframes.visitor(), undefined);
  fs.rmSync(dir, { recursive: true });
});
