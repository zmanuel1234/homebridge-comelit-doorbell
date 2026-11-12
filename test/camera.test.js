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
  for (const u of [[0x67, 1], [0x68, 2], [0x65, ...Array(2100).fill(3)], [0x41, 4]]) cam.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u]));
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
  for (const u of [[0x67, 1], [0x68, 2], [0x65, ...Array(2100).fill(3)], [0x41, 4]]) first.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u]));
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

function pictureCamera(config) {
  const cam = camera({ ringPreview: true, ...config });
  cam.lastVisitor = async () => (cam.keyframes.visitor() ? Buffer.from('visitor') : undefined);
  cam.placeholderImage = async () => Buffer.from('idle');
  cam.controller.ringDoorbell = () => undefined;
  cam.getCall = () => ({ previewOn: true });
  return cam;
}
const feed = (cam, callObj) => { for (const u of [[0x67, 1], [0x68, 2], [0x65, ...Array(2100).fill(3)], [0x41, 4]]) cam.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u])); };

test("a picture asked for right after a ring waits for the ring preview's picture (beta.28)", async () => {
  const cam = pictureCamera();
  cam.ring();
  let got;
  const asking = cam.snapshot({ width: 640, height: 480 }).then((b) => (got = b.toString()));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(got, undefined, 'still waiting');
  feed(cam, {});
  await asking;
  assert.strictEqual(got, 'visitor');
});

test('the wait ends when the preview stops without a picture (beta.28)', async () => {
  const cam = pictureCamera();
  cam.ring();
  const asking = cam.snapshot({ width: 640, height: 480 });
  cam.previewDone();
  assert.strictEqual((await asking).toString(), 'idle');
});

test('without the ring preview, a picture is never held (beta.28)', async () => {
  const cam = pictureCamera({ ringPreview: false });
  cam.ring();
  const t = Date.now();
  assert.strictEqual((await cam.snapshot({ width: 640, height: 480 })).toString(), 'idle');
  assert.ok(Date.now() - t < 100);
});

test('no wait when no ring preview can run (answering off, or no picture kept) (beta.29)', async () => {
  for (const [config, call] of [[{}, { previewOn: false }], [{ lastVisitorMinutes: 0 }, { previewOn: true }]]) {
    const cam = pictureCamera(config);
    cam.getCall = () => call;
    cam.ring();
    const t = Date.now();
    await cam.snapshot({ width: 640, height: 480 });
    assert.ok(Date.now() - t < 100, JSON.stringify(config));
  }
});

test('a second ring keeps a wait (beta.29)', async () => {
  const cam = pictureCamera();
  cam.ring();
  cam.ring();
  await new Promise((r) => setImmediate(r));
  assert.ok(cam.pictureWait, 'the second ring still waits');
  cam.previewStarted();
  let got;
  const asking = cam.snapshot({ width: 640, height: 480 }).then((b) => (got = b.toString()));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(got, undefined);
  feed(cam, {});
  await asking;
  assert.strictEqual(got, 'visitor');
});

test('the wait ends 1.5 s after the ring if no preview starts (beta.29)', async () => {
  const cam = pictureCamera();
  cam.ring();
  const t = Date.now();
  assert.strictEqual((await cam.snapshot({ width: 640, height: 480 })).toString(), 'idle');
  const waited = Date.now() - t;
  assert.ok(waited >= 1400 && waited < 2500, `waited ${waited} ms`);
});

test("with mediaCaptureDir, each ring's notification picture is saved once, last 10 kept (beta.30)", async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comelit-rings-'));
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `ring-20250101-0000${String(i).padStart(2, '0')}.jpg`), 'old');
  fs.writeFileSync(path.join(dir, 'call-20250101-000000.h264'), 'call');
  const cam = pictureCamera({ mediaCaptureDir: dir, ringPreview: false });
  cam.ring();
  const first = await cam.snapshot({ width: 640, height: 480 });
  await cam.snapshot({ width: 640, height: 480 });
  let files;
  for (let i = 0; i < 100; i++) {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('ring-')).sort();
    // wait until the new picture is written completely, not just created
    const fresh = files.find((f) => !f.startsWith('ring-2025'));
    if (fresh && fs.statSync(path.join(dir, fresh)).size === first.length) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.strictEqual(files.length, 10, files.join(' '));
  const saved = files.filter((f) => !f.startsWith('ring-2025'));
  assert.strictEqual(saved.length, 1, 'one picture per ring');
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, saved[0])), first);
  assert.ok(fs.existsSync(path.join(dir, 'call-20250101-000000.h264')), 'call recordings untouched');
  fs.rmSync(dir, { recursive: true });
});

test('without mediaCaptureDir nothing is saved, and pictures outside a ring are not saved (beta.30)', async () => {
  const cam = pictureCamera({ ringPreview: false });
  let saved = 0;
  cam.saveRingPicture = async () => { saved++; };
  cam.ring();
  await cam.snapshot({ width: 640, height: 480 });
  const withDir = pictureCamera({ ringPreview: false, mediaCaptureDir: '/tmp/x' });
  withDir.saveRingPicture = async () => { saved++; };
  await withDir.snapshot({ width: 640, height: 480 });
  assert.strictEqual(saved, 0);
});

test('the debug log gives the size of each picture HomeKit asks for after a ring (beta.31)', async () => {
  const cam = pictureCamera({ ringPreview: false });
  const lines = [];
  cam.log = { info() {}, warn() {}, error() {}, debug: (m) => lines.push(m) };
  await cam.snapshot({ width: 1280, height: 720 });
  assert.deepStrictEqual(lines, [], 'nothing outside a ring');
  cam.ring();
  await cam.snapshot({ width: 640, height: 360 });
  assert.ok(lines.some((l) => /HomeKit asked for a 640x360 picture 0\.\d s after the ring; gave the idle picture/.test(l)), lines.join('\n'));
});

test('after an empty first keyframe, picture requests wait for the next real one, up to 7 s after the ring (2.1.1)', async () => {
  const cam = pictureCamera();
  cam.ring();
  cam.previewStarted();
  const callObj = {};
  for (const u of [[0x67, 1], [0x68, 2], [0x65, ...Array(900).fill(0)], [0x41, 4]]) cam.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u]));
  cam.previewEmptyKeyframe();
  let got;
  const t = Date.now();
  const asking = cam.snapshot({ width: 640, height: 480 }).then((b) => (got = b.toString()));
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(got, undefined, 'no black picture: still waiting');
  for (const u of [[0x65, ...Array(2100).fill(5)], [0x41, 6]]) cam.previewVideo(callObj, Buffer.from([0, 0, 0, 1, ...u]));
  await asking;
  assert.strictEqual(got, 'visitor');
  assert.ok(Date.now() - t < 1000);
});

test('the extended wait still ends: no real keyframe gives the earlier picture, not a black one (2.1.1)', async () => {
  const cam = pictureCamera();
  cam.ring();
  cam.previewStarted();
  cam.previewEmptyKeyframe();
  const t = Date.now();
  cam.pictureWait.resolve(); // as the 7 s timer would
  assert.strictEqual((await cam.snapshot({ width: 640, height: 480 })).toString(), 'idle');
  assert.ok(Date.now() - t < 500);
});

test('after an empty keyframe the wait really runs to 7 s after the ring, beyond the usual 4.5 s (2.1.1)', async () => {
  const cam = pictureCamera();
  cam.ring();
  cam.previewStarted();
  cam.previewEmptyKeyframe();
  let got;
  const asking = cam.snapshot({ width: 640, height: 480 }).then((b) => (got = b.toString()));
  await new Promise((r) => setTimeout(r, 5000)); // past the usual 4.5 s
  assert.strictEqual(got, undefined, 'still waiting 5 s after the ring');
  feed(cam, {});
  await asking;
  assert.strictEqual(got, 'visitor');
});

test('stopping a view kills its ffmpeg; shutdown stops every view (2.2.0 review)', async () => {
  const cam = camera();
  cam.lastVisitor = async () => undefined;
  cam.placeholderPath = async () => '/nonexistent.jpg';
  const killed = [];
  cam.spawnProcess = (what) => { const p = fakeProcess(); p.kill = (sig) => { killed.push([what, sig]); p.exitCode = 0; }; cam.spawned.push([what, p]); return p; };
  for (const id of ['ffffffff-1', 'ffffffff-2']) {
    pending(cam, id);
    await cam.startStream(id, request(id));
  }
  assert.strictEqual(cam.active.size, 2);
  await cam.shutdown();
  assert.strictEqual(cam.active.size, 0);
  assert.deepStrictEqual(killed, [['video', 'SIGKILL'], ['video', 'SIGKILL']]);
});

test('short-lived live view files are kept in Homebridge\'s storage folder; a stopped process\'s leftovers are cleared at startup, another running one\'s kept (2.3.1)', async () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comelit-storage-'));
  try {
    const work = path.join(dir, 'comelit-doorbell');
    fs.mkdirSync(work);
    const dead = path.join(work, 'view-999999999-abcd1234.jpg'); // no such process
    const ours = path.join(work, `still-${process.pid}.jpg`); // an earlier process with our id
    const other = path.join(work, `view-${process.ppid}-ef567890.jpg`); // another running bridge
    const unrelated = path.join(work, 'notes.txt');
    for (const f of [dead, ours, other, unrelated]) fs.writeFileSync(f, 'x');
    const settings = resolveSettings({ camera: true, answerMode: 'answer-on-view', host: 'h', token: 't' });
    const cam = new DoorbellCamera({ hap, user: { storagePath: () => dir } }, quietLog(), settings, () => undefined);
    for (let i = 0; i < 100 && (fs.existsSync(dead) || fs.existsSync(ours)); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(!fs.existsSync(dead), "a stopped process's picture is removed");
    assert.ok(!fs.existsSync(ours), 'a leftover with our own process id is removed');
    assert.ok(fs.existsSync(other), "a running process's picture is kept");
    assert.ok(fs.existsSync(unrelated), 'other files are left alone');
    const file = await cam.workFile('x.jpg');
    assert.strictEqual(path.dirname(file), work);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
