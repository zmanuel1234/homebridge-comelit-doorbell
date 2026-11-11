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
  proc.stdout = new EventEmitter();
  proc.kill = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } };
  return proc;
}

function recorder({ active = true, audio = false } = {}) {
  const motion = [];
  const spawned = [];
  const r = new RingRecorder(quietLog(), (on) => motion.push(on), () => audio, (what, args) => {
    const proc = fakeProcess();
    spawned.push({ what, args, proc });
    return proc;
  });
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
  assert.deepStrictEqual(motion, []);
});

test('recorder: motion at the first real picture (an empty black keyframe is skipped), off when the call ends', () => {
  const { r, motion } = recorder();
  const call = {};
  for (const u of [sps, pps, idr(1000), p]) r.onCallVideo(call, u);
  assert.deepStrictEqual(motion, [], 'not on a 1 KB black keyframe');
  for (const u of [sps, pps, idr(1500), idr(1500), p]) r.onCallVideo(call, u); // a keyframe in two slices
  assert.deepStrictEqual(motion, [true]);
  r.onCallVideo({}, idr(3000)); // another call's video is ignored
  r.onCallEnded({});
  assert.deepStrictEqual(motion, [true], 'only its own call ends it');
  r.onCallEnded(call);
  assert.deepStrictEqual(motion, [true, false]);
});

test('recorder: turning recording off in the Home app, or losing the intercom, ends the recording', () => {
  const { r, motion } = recorder();
  for (const u of [sps, pps, idr(3000), p]) r.onCallVideo('call', u);
  r.updateRecordingActive(false);
  assert.deepStrictEqual(motion, [true, false]);
  r.updateRecordingActive(true);
  for (const u of [sps, pps, idr(3000), p]) r.onCallVideo('call2', u);
  r.reset();
  assert.deepStrictEqual(motion, [true, false, true, false]);
});

test('recorder: the hub\'s request gets the ring from its first picture, then fragments, the last marked as last', async () => {
  const { r, spawned } = recorder({ audio: true });
  const call = {};
  for (const u of [sps, pps, idr(3000), p]) r.onCallVideo(call, u);
  const packets = [];
  const reading = (async () => {
    for await (const packet of r.handleRecordingStreamRequest(1)) packets.push(packet);
  })();
  await tick();
  const { proc, args } = spawned[0];
  assert.ok(args.includes('libfdk_aac'), 'sound track with HomeKit audio on');
  assert.deepStrictEqual(proc.stdin.written, [sps, pps, idr(3000), p], 'the ring so far, from its keyframe');
  r.onCallVideo(call, nal(0x41, 2));
  assert.strictEqual(proc.stdin.written.length, 5, 'and the video as it comes');
  proc.stdout.emit('data', Buffer.concat([box('ftyp'), box('moov'), box('moof'), box('mdat')]));
  proc.stdout.emit('data', Buffer.concat([box('moof'), box('mdat', 32)]));
  await tick();
  r.onCallEnded(call);
  assert.strictEqual(proc.stdin.ended, true, 'the end of the call ends ffmpeg\'s input');
  proc.kill();
  await reading;
  assert.deepStrictEqual(packets.map((x) => [x.data.length, x.isLast]), [[32, false], [32, false], [48, true]]);
});

test('recorder: a request with no ring within the wait, or aborted, fails without starting ffmpeg', async () => {
  const { r, spawned } = recorder();
  const abort = new AbortController();
  const req = r.handleRecordingStreamRequest(2, abort.signal).next();
  abort.abort();
  await assert.rejects(req, /no ring to record/);
  assert.strictEqual(spawned.length, 0);
});

test('recorder: HomeKit closing the stream stops ffmpeg', async () => {
  const { r, spawned } = recorder();
  for (const u of [sps, pps, idr(3000), p]) r.onCallVideo('call', u);
  const gen = r.handleRecordingStreamRequest(3);
  const first = gen.next();
  await tick();
  r.closeRecordingStream(3, 5);
  assert.notStrictEqual(spawned[0].proc.exitCode, null);
  await first;
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

test('camera: with recording, HomeKit gets a motion sensor and recording management; without, neither', () => {
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
