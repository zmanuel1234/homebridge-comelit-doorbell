const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { spawnSync, spawn } = require('child_process');
const hap = require('@homebridge/hap-nodejs');
const { Mp4Splitter, RingRecorder, RingSource, recordingArgs } = require('../dist/recording');
const { DoorbellCamera } = require('../dist/camera');
const { callHandlerMode, resolveSettings, settingsWarnings } = require('../dist/config');
const { quietLog } = require('./helpers');

const box = (type, size = 16) => {
  const b = Buffer.alloc(size, 0);
  b.writeUInt32BE(size, 0);
  b.write(type, 4, 'latin1');
  return b;
};

// HomeKit's choice, as a hub sends it: 1280x720 15 fps, high profile, level 4.0, fragments of 4 s.
const configuration = (audio = {}) => ({
  prebufferLength: 4000,
  mediaContainerConfiguration: { type: 0, fragmentLength: 4000 },
  videoCodec: { type: 0, parameters: { profile: 2, level: 2, bitRate: 800, iFrameInterval: 4000 }, resolution: [1280, 720, 15] },
  audioCodec: { type: 0, audioChannels: 1, samplerate: 1, bitrate: 32, ...audio },
});

// Video units as the depacketizer gives them: a start code, then the NAL unit.
const nal = (...bytes) => Buffer.from([0, 0, 0, 1, ...bytes]);
const sps = nal(0x67, 1, 2);
const pps = nal(0x68, 3);
const idr = (size) => Buffer.concat([nal(0x65), Buffer.alloc(size - 5, 7)]);
const p = nal(0x41, 1);

function fakeProcess() {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.stdin = { written: [], ended: false, write(b) { proc.stdin.written.push(b); return true; }, end() { proc.stdin.ended = true; }, destroy() {} };
  proc.signalCode = null;
  proc.stdin = Object.assign(proc.stdin, { writable: true });
  proc.stdout = new EventEmitter();
  // Like a real child process: 'exit', then 'close' a moment later.
  proc.kill = () => {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.signalCode = 'SIGKILL';
      setImmediate(() => { proc.emit('exit', null, 'SIGKILL'); setImmediate(() => proc.emit('close', null, 'SIGKILL')); });
    }
  };
  return proc;
}

function recorder({ active = true, audio = false, spawn } = {}) {
  const motion = [];
  const spawned = [];
  const r = new RingRecorder(quietLog(), (on) => motion.push(on), () => audio, (what, args) => {
    const proc = fakeProcess();
    proc.on('error', () => undefined); // as spawnFfmpeg does
    spawned.push({ what, args, proc });
    if (spawn) spawn(proc);
    return proc;
  });
  r.attached();
  if (active) {
    r.updateRecordingActive(true);
    r.updateRecordingConfiguration(configuration());
  }
  return { r, motion, spawned };
}

const tick = () => new Promise((r) => setImmediate(r));

test('Mp4Splitter: the init is everything up to moov, each fragment ends with its mdat, in any chunk sizes', () => {
  const stream = Buffer.concat([box('ftyp', 24), box('moov', 40), box('moof', 20), box('mdat', 100), box('styp'), box('moof', 20), box('mdat', 50)]);
  const s = new Mp4Splitter();
  const out = [];
  for (let i = 0; i < stream.length; i += 7) {
    out.push(...s.push(stream.subarray(i, i + 7)));
  }
  assert.deepStrictEqual(out.map((o) => [o.type, o.data.length]), [['init', 64], ['fragment', 120], ['fragment', 86]]);
  assert.strictEqual(out[1].data.toString('latin1', 4, 8), 'moof');
});

test('Mp4Splitter: a box with a 64-bit size, and an invalid size is reported', () => {
  const big = Buffer.alloc(24);
  big.writeUInt32BE(1, 0);
  big.write('mdat', 4, 'latin1');
  big.writeBigUInt64BE(24n, 8);
  const s = new Mp4Splitter();
  s.push(Buffer.concat([box('ftyp'), box('moov')]));
  assert.deepStrictEqual(s.push(Buffer.concat([box('moof'), big])).map((o) => o.data.length), [40]);
  assert.throws(() => new Mp4Splitter().push(Buffer.concat([Buffer.from([0, 0, 0, 4]), Buffer.from('ftyp')])), /invalid MP4 box size/);
});

test('recordingArgs: follows HomeKit\'s configuration, with keyframes inside the fragment length', () => {
  const args = recordingArgs(configuration(), false);
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.strictEqual(after('-profile:v'), 'high');
  assert.strictEqual(after('-level:v'), '4.0');
  assert.strictEqual(after('-b:v'), '800k');
  assert.match(after('-vf'), /scale=1280:720:.*fps=15$/);
  const every = Number(/n_forced\*([\d.]+)\)/.exec(after('-force_key_frames'))[1]);
  assert.ok(every < 4 && every >= 3.5, `keyframe every ${every} s`);
  assert.ok(Number(after('-g')) >= every * 15, 'the GOP limit never adds a keyframe of its own');
  assert.ok(args.includes('-an'));
  assert.match(after('-movflags'), /frag_keyframe/);
  assert.strictEqual(args.at(-1), 'pipe:1');
});

test('recordingArgs: a silent sound track when HomeKit records sound, AAC-LC or AAC-ELD at its sample rate', () => {
  const lc = recordingArgs(configuration(), true);
  assert.ok(lc.join(' ').includes('anullsrc=channel_layout=mono:sample_rate=16000'));
  assert.strictEqual(lc[lc.indexOf('-profile:a') + 1], 'aac_low');
  assert.ok(lc.includes('-shortest') && !lc.includes('-an'));
  const eld = recordingArgs(configuration({ type: 1, samplerate: 3 }), true);
  assert.strictEqual(eld[eld.indexOf('-profile:a') + 1], 'aac_eld');
  assert.ok(eld.join(' ').includes('sample_rate=32000'));
});

test('recorder: off in the Home app, a ring changes nothing', () => {
  const { r, motion } = recorder({ active: false });
  const call = {};
  for (const u of [sps, pps, idr(3000), p]) r.onCallVideo(call, u);
  assert.strictEqual(r.recording, false);
  assert.deepStrictEqual(motion, [false], 'only the reset when attached');
});

const ring = (r, call) => { for (const u of [sps, pps, idr(3000), p]) r.onCallVideo(call, u); };

test('recorder: motion off at startup, on at the first real picture (an empty black keyframe is skipped), off when the call ends', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { r, motion } = recorder();
  assert.deepStrictEqual(motion, [false], 'a value cached from before a restart is cleared');
  const call = {};
  for (const u of [sps, pps, idr(1000), p]) r.onCallVideo(call, u);
  assert.deepStrictEqual(motion, [false], 'not on a 1 KB black keyframe');
  for (const u of [sps, pps, idr(1500), idr(1500), p]) r.onCallVideo(call, u); // a keyframe in two slices
  assert.deepStrictEqual(motion, [false, true]);
  r.onCallVideo({}, idr(3000)); // another call's video is ignored
  r.onCallEnded({});
  t.mock.timers.tick(3000);
  r.onCallVideo(call, p);
  t.mock.timers.tick(3000);
  assert.deepStrictEqual(motion, [false, true], 'only its own call ends it');
  r.onCallEnded(call);
  assert.deepStrictEqual(motion, [false, true, false]);
  r.shutdown();
});

test('recorder: motion stays on at least 5 s for a short ring', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { r, motion } = recorder();
  ring(r, 'call');
  r.onCallEnded('call');
  assert.deepStrictEqual(motion, [false, true], 'still on right after');
  t.mock.timers.tick(5000);
  assert.deepStrictEqual(motion, [false, true, false]);
});

test('recorder: the recording ends when the intercom stops sending video, even with the call still on', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { r, motion } = recorder();
  ring(r, 'call');
  t.mock.timers.tick(4000);
  r.onCallVideo('call', p);
  t.mock.timers.tick(4000);
  assert.deepStrictEqual(motion, [false, true], 'video still coming');
  t.mock.timers.tick(1000);
  assert.deepStrictEqual(motion, [false, true, false], '5 s without video');
  ring(r, 'call2');
  assert.deepStrictEqual(motion, [false, true, false, true], 'the next ring is recorded');
  r.shutdown();
});

test('recorder: the 3-minute limit ends the recording and lets the next ring be recorded', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { r, motion } = recorder();
  ring(r, 'call');
  for (let i = 0; i < 180; i++) {
    t.mock.timers.tick(1000);
    r.onCallVideo('call', p);
  }
  assert.deepStrictEqual(motion, [false, true, false]);
  ring(r, 'call2');
  assert.deepStrictEqual(motion, [false, true, false, true]);
  r.shutdown();
});

test('recorder: turning recording off in the Home app, or losing the intercom, ends the recording', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { r, motion } = recorder();
  ring(r, 'call');
  t.mock.timers.tick(6000);
  r.onCallVideo('call', p);
  r.updateRecordingActive(false);
  assert.deepStrictEqual(motion, [false, true, false]);
  r.updateRecordingActive(true);
  ring(r, 'call2');
  t.mock.timers.tick(6000);
  r.onCallVideo('call2', p);
  r.reset();
  assert.deepStrictEqual(motion, [false, true, false, true, false]);
});

async function readAll(gen) {
  const packets = [];
  for await (const packet of gen) packets.push(packet);
  return packets;
}

const fmp4 = (proc) => {
  proc.stdout.emit('data', Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat')]));
  proc.stdout.emit('data', Buffer.concat([box('moof'), box('mdat', 32)]));
};

test('recorder: the hub\'s request gets the ring from its first picture, then fragments, the last marked as last', async () => {
  const { r, spawned } = recorder({ audio: true });
  const call = {};
  ring(r, call);
  const reading = readAll(r.handleRecordingStreamRequest(1));
  await tick();
  const { proc, args } = spawned[0];
  assert.ok(args.includes('libfdk_aac'), 'sound track with HomeKit audio on');
  assert.deepStrictEqual(proc.stdin.written, [sps, pps, idr(3000), p], 'the ring so far, from its keyframe');
  r.onCallVideo(call, nal(0x41, 2));
  assert.strictEqual(proc.stdin.written.length, 5, 'and the video as it comes');
  fmp4(proc);
  await tick();
  r.onCallEnded(call);
  assert.strictEqual(proc.stdin.ended, true, 'the end of the call ends ffmpeg\'s input');
  proc.emit('exit', 0);
  proc.emit('close', 0);
  const packets = await reading;
  assert.deepStrictEqual(packets.map((x) => [x.data.length, x.isLast]), [[32, false], [32, false], [48, true]]);
  r.shutdown();
});

test('recorder: a request that comes just after a short ring still gets it, once', async () => {
  const { r, spawned } = recorder();
  ring(r, 'call');
  r.onCallEnded('call');
  const reading = readAll(r.handleRecordingStreamRequest(1));
  await tick();
  const { proc } = spawned[0];
  assert.strictEqual(proc.stdin.written.length, 4);
  assert.strictEqual(proc.stdin.ended, true);
  fmp4(proc);
  proc.emit('close', 0);
  assert.strictEqual((await reading).at(-1).isLast, true);
  const abort = new AbortController();
  const again = r.handleRecordingStreamRequest(2, abort.signal).next();
  abort.abort();
  await assert.rejects(again, /no ring to record/, 'not recorded twice');
  r.shutdown();
});

test('recorder: a second request during the same ring starts from the latest keyframe, not the start', async () => {
  const { r, spawned } = recorder();
  ring(r, 'call');
  const first = readAll(r.handleRecordingStreamRequest(1));
  await tick();
  for (const u of [sps, pps, idr(2500), p]) r.onCallVideo('call', u);
  const second = readAll(r.handleRecordingStreamRequest(2));
  await tick();
  assert.deepStrictEqual(spawned[1].proc.stdin.written, [sps, pps, idr(2500), p]);
  for (const { proc } of spawned) { fmp4(proc); proc.emit('close', 0); }
  await Promise.all([first, second]);
  r.shutdown();
});

test('recorder: a request with no ring within the wait, or aborted, fails without starting ffmpeg', async () => {
  const { r, spawned } = recorder();
  const abort = new AbortController();
  const req = r.handleRecordingStreamRequest(2, abort.signal).next();
  abort.abort();
  await assert.rejects(req, /no ring to record/);
  assert.strictEqual(spawned.length, 0);
});

test('recorder: HomeKit closing the stream stops ffmpeg and ends the request', async () => {
  const { r, spawned } = recorder();
  ring(r, 'call');
  const reading = readAll(r.handleRecordingStreamRequest(3));
  await tick();
  r.closeRecordingStream(3, 5);
  assert.strictEqual(spawned[0].proc.signalCode, 'SIGKILL');
  await assert.rejects(reading, /no ring to record/, 'nothing was recorded yet');
  r.shutdown();
});

test('recorder: ffmpeg that fails to start (no exit event, only error and close) ends the request', async () => {
  const { r } = recorder({ spawn: (proc) => setImmediate(() => { proc.exitCode = -2; proc.emit('error', new Error('spawn ENOENT')); proc.emit('close', -2); }) });
  ring(r, 'call');
  await assert.rejects(readAll(r.handleRecordingStreamRequest(4)), /no ring to record/);
  r.shutdown();
});

test('recorder: aborted by hap while waiting for ffmpeg\'s output, the request ends', async () => {
  const { r } = recorder();
  ring(r, 'call');
  const abort = new AbortController();
  const reading = readAll(r.handleRecordingStreamRequest(5, abort.signal));
  await tick();
  abort.abort();
  await assert.rejects(reading, /no ring to record/);
  r.shutdown();
});

test('RingSource: replays what it has to a late follower, then ends it', () => {
  const s = new RingSource('call', [sps]);
  s.push(pps);
  const got = [];
  let ended = false;
  s.follow((u) => got.push(u), () => (ended = true));
  s.push(p);
  s.end();
  s.push(idr(10));
  assert.deepStrictEqual(got, [sps, pps, p]);
  assert.strictEqual(ended, true);
});

test('settings: recording follows calls even with answering off, and warns without the camera or rings', () => {
  assert.strictEqual(callHandlerMode(resolveSettings({ camera: true, recording: true })), 'handshake');
  assert.strictEqual(callHandlerMode(resolveSettings({ recording: true })), 'off');
  assert.strictEqual(resolveSettings({ recording: 'true' }).recording, true);
  assert.ok(settingsWarnings(resolveSettings({ recording: true })).some((w) => /doorbell camera/.test(w)));
  assert.ok(settingsWarnings(resolveSettings({ recording: true, camera: true, enableNotifications: false })).some((w) => /Listen for rings/.test(w)));
});

test('camera: with recording, HomeKit gets a motion sensor and recording management; without, neither', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const make = (recording) => {
    const cam = new DoorbellCamera({ hap }, quietLog(), resolveSettings({ camera: true, recording, host: 'h', token: 't' }), () => undefined);
    new hap.Accessory('Door', hap.uuid.generate(`door-${recording}`)).configureController(cam.controller);
    return cam;
  };
  const on = make(true);
  assert.ok(on.recorder);
  assert.ok(on.controller.motionService);
  assert.ok(on.controller.recordingManagement);
  on.recorder.updateRecordingActive(true);
  on.recorder.updateRecordingConfiguration(configuration());
  for (const u of [sps, pps, idr(3000), p]) on.recorder.onCallVideo('call', u);
  assert.strictEqual(on.controller.motionService.getCharacteristic(hap.Characteristic.MotionDetected).value, true, 'the ring turns the camera\'s motion sensor on');
  on.recorder.onCallEnded('call');
  t.mock.timers.tick(5000);
  assert.strictEqual(on.controller.motionService.getCharacteristic(hap.Characteristic.MotionDetected).value, false);
  on.shutdown();
  const off = make(false);
  assert.strictEqual(off.recorder, undefined);
  assert.strictEqual(off.controller.motionService, undefined);
  assert.strictEqual(off.controller.recordingManagement, undefined);
  off.shutdown();
});

// The real thing: ffmpeg turns intercom-like video (640x240, 16 fps, a keyframe every 3 s) into
// HomeKit fragments: each starts with a keyframe and lasts at most the fragment length.
const ffmpegOk = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout?.includes('libx264');
test('recording with ffmpeg: fragments start with a keyframe and are no longer than 4 s', { skip: !ffmpegOk && 'no ffmpeg with libx264' }, async () => {
  const source = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x240:rate=16:duration=13',
    '-c:v', 'libx264', '-g', '48', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1'], { maxBuffer: 64 << 20 }).stdout;
  const proc = spawn('ffmpeg', recordingArgs(configuration(), false));
  const splitter = new Mp4Splitter();
  const packets = [];
  proc.stdout.on('data', (d) => packets.push(...splitter.push(d)));
  proc.stdin.end(source);
  await new Promise((r) => proc.on('exit', r));
  assert.strictEqual(packets[0].type, 'init');
  const fragments = packets.slice(1);
  assert.ok(fragments.length >= 3, `${fragments.length} fragments`);
  for (const f of fragments) {
    // Each fragment on its own, after the init, as the hub sees it.
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=duration_time,flags', '-of', 'csv=p=0', '-i', 'pipe:0'],
      { input: Buffer.concat([packets[0].data, f.data]), encoding: 'utf8' });
    const rows = probe.stdout.trim().split('\n').map((l) => l.split(','));
    assert.match(rows[0][1], /K/, 'starts with a keyframe');
    const seconds = rows.reduce((t, r) => t + Number(r[0]), 0);
    assert.ok(seconds <= 4.0, `${seconds.toFixed(3)} s`);
  }
});

test('camera: a camera Homebridge already had gets the recording services and motion sensor, and loses them when recording is turned off', () => {
  const { PlatformAccessory } = require(require('path').join(__dirname, '../node_modules/homebridge/dist/platformAccessory.js'));
  const make = (recording) => new DoorbellCamera({ hap }, quietLog(), resolveSettings({ camera: true, recording, host: 'h', token: 't' }), () => undefined);
  const restart = (a) => PlatformAccessory.deserialize(JSON.parse(JSON.stringify(PlatformAccessory.serialize(a))));
  const has = (a, s, subtype) => a.services.some((x) => x.UUID === s.UUID && (subtype === undefined || x.subtype === subtype));
  let a = Object.assign(new PlatformAccessory('Door Camera', hap.uuid.generate('door-camera-cached')), { _associatedPlugin: 'p', _associatedPlatform: 'P' });
  make(false).attach(a);
  assert.ok(!has(a, hap.Service.MotionSensor));
  a = restart(a);
  const cam = make(true);
  cam.attach(a);
  assert.ok(has(a, hap.Service.MotionSensor, 'recording'), 'the motion sensor is on the accessory (hap-nodejs\'s own would not be)');
  assert.ok(has(a, hap.Service.CameraRecordingManagement) && has(a, hap.Service.CameraOperatingMode) && has(a, hap.Service.DataStreamTransportManagement));
  assert.ok(a.getService(hap.Service.CameraRecordingManagement).linkedServices.includes(cam.motionService));
  a = restart(a);
  make(true).attach(a);
  assert.strictEqual(a.services.filter((x) => x.UUID === hap.Service.MotionSensor.UUID).length, 1, 'one motion sensor after another restart');
  a = restart(a);
  make(false).attach(a);
  assert.ok(!has(a, hap.Service.MotionSensor) && !has(a, hap.Service.CameraRecordingManagement), 'all gone with recording off');
  cam.shutdown();
});
