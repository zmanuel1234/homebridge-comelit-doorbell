const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { spawnSync, spawn } = require('child_process');
const hap = require('@homebridge/hap-nodejs');
const { FlvWriter, Mp4Splitter, PREBUFFER_MS, RingFeeder, RingRecorder, RingSource, recordingArgs, spawnFfmpeg } = require('../dist/recording');
const P = PREBUFFER_MS; // every recording starts with this much of its first picture held still

/** The tags of an FLV stream: type (8 sound, 9 video), time in ms, and the data. */
function flvTags(buffers) {
  const b = Buffer.concat(buffers);
  const tags = [];
  for (let i = 13; i + 11 <= b.length;) {
    const size = b.readUIntBE(i + 1, 3);
    const ms = b.readUIntBE(i + 4, 3) | (b[i + 7] << 24);
    tags.push({ type: b[i], ms, data: b.subarray(i + 11, i + 11 + size) });
    i += 11 + size + 4;
  }
  return tags;
}
const videoTags = (buffers) => flvTags(buffers).filter((t) => t.type === 9);
const soundBytes = (buffers) => flvTags(buffers).filter((t) => t.type === 8).reduce((n, t) => n + t.data.length - 1, 0);
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
// Slices that start a frame (first_mb_in_slice 0: the top bit of the byte after the header).
const idr = (size) => Buffer.concat([nal(0x65, 0x88), Buffer.alloc(size - 6, 7)]);
const p = nal(0x41, 0x81);

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
  r.leftoverGapMs = 0; // the old-picture check has its own tests
  r.attached();
  if (active) {
    r.updateRecordingActive(true);
    r.updateRecordingConfiguration(configuration());
  }
  return { r, motion, spawned };
}

const tick = () => new Promise((r) => setTimeout(r, 30)); // a feeder tick (20 ms) and more

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

test('recordingArgs: video and the intercom\'s sound from one FLV input, the sound turned up like the live view, in AAC-LC or AAC-ELD at HomeKit\'s rate', () => {
  const lc = recordingArgs(configuration(), true, 12);
  const j = lc.join(' ');
  assert.ok(j.includes('-f flv -i pipe:0'));
  assert.ok(j.includes('-map 0:v -map 0:a'));
  assert.ok(j.includes('-af volume=12dB,alimiter=limit=0.9,aresample=16000'));
  assert.strictEqual(lc[lc.indexOf('-profile:a') + 1], 'aac_low');
  assert.ok(!lc.includes('-an') && !j.includes('anullsrc'));
  const eld = recordingArgs(configuration({ type: 1, samplerate: 3 }), true);
  assert.strictEqual(eld[eld.indexOf('-profile:a') + 1], 'aac_eld');
  assert.ok(eld.join(' ').includes('-af aresample=32000'));
  assert.match(lc[lc.indexOf('-vf') + 1], /^setpts=PTS-STARTPTS,/, 'frames keep the times they arrived with');
  assert.ok(!recordingArgs(configuration(), false).includes('0:a'));
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
  assert.ok(args.includes('libfdk_aac'), 'sound with HomeKit audio on');
  const v = videoTags(proc.stdin.written);
  assert.deepStrictEqual(v.map((t) => [t.data[0], t.data[1]]), [[0x17, 0], [0x17, 1], [0x17, 1]], 'the decoder setup (SPS, PPS), the keyframe held still (prebuffer), then live');
  r.onCallVideo(call, nal(0x41, 0x80));
  r.onCallVideo(call, nal(0x41, 0x80));
  r.onCallVideo(call, nal(0x41, 0x80));
  r.onCallAudio(call, Buffer.alloc(160, 1));
  await tick();
  assert.deepStrictEqual(videoTags(proc.stdin.written).slice(3).map((t) => t.data[0]), [0x27, 0x27, 0x27], 'and the frames as they come (a frame is written when the next one starts)');
  assert.ok(flvTags(proc.stdin.written).some((t) => t.type === 8 && t.data.length === 161 && t.data[1] === 1), 'and the intercom\'s sound');
  fmp4(proc);
  await tick();
  r.onCallEnded(call);
  await tick();
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
  assert.strictEqual(videoTags(proc.stdin.written).length, 4, 'the decoder setup, the prebuffer, the keyframe and the frame after it');
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
  const v2 = videoTags(spawned[1].proc.stdin.written);
  assert.strictEqual(v2[1].data.length, 5 + 4 + 2496, 'starts with the latest keyframe');
  assert.strictEqual(v2[1].ms, 0, 'held still as the prebuffer');
  assert.ok(Math.abs(v2[2].ms - P) <= 5, `then live at the end of the prebuffer: ${v2[2].ms} ms`);
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

test('RingFeeder: frames are stamped with when they arrived, also when the request comes late; a split keyframe is one frame', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const s = new RingSource('call', [sps, pps, nal(0x65, 0x80, 1), nal(0x65, 0x00, 2)]); // a keyframe in two slices
  t.mock.timers.tick(125);
  s.push(nal(0x41, 0x80));
  t.mock.timers.tick(125);
  s.push(nal(0x41, 0x80));
  t.mock.timers.tick(2000); // the request comes 2 s later
  const out = [];
  let ended = false;
  new RingFeeder(s, 0, (b) => out.push(b), false, () => (ended = true));
  t.mock.timers.tick(100);
  s.push(nal(0x41, 0x80)); // live
  s.end();
  t.mock.timers.tick(40);
  assert.strictEqual(ended, true);
  const v = videoTags(out);
  assert.deepStrictEqual(v.map((x) => [x.data[0], x.ms]), [[0x17, 0], [0x17, 0], [0x17, P], [0x27, P + 125], [0x27, P + 250], [0x27, P + 2350]]);
  assert.strictEqual(v[1].data.length, 5 + (4 + 3) * 2, 'the keyframe\'s two slices, in one frame');
  assert.deepStrictEqual(flvTags(out).filter((x) => x.type === 8), [], 'no sound without HomeKit audio');
});

test('RingFeeder: the sound keeps time with the picture: silence until the call\'s sound starts, and in its gaps', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 2_000_000 });
  const s = new RingSource('call', [sps, pps, idr(3000)]);
  const out = [];
  const f = new RingFeeder(s, 0, (b) => out.push(b), true, () => undefined);
  const step = (sound) => { s.push(p); if (sound) s.pushAudio(sound); t.mock.timers.tick(20); }; // the picture keeps coming
  for (let i = 0; i < 100; i++) step(); // 2 s of ringing without sound
  assert.ok(Math.abs(soundBytes(out) - (P + 2000 - 200) * 8) <= 160, `silence up to 200 ms behind: ${soundBytes(out)}`);
  assert.ok(flvTags(out).filter((x) => x.type === 8).every((x) => x.data[0] === 0x70 && x.data.subarray(1).every((b) => b === 0xd5)), 'A-law silence');
  for (let i = 0; i < 50; i++) step(Buffer.alloc(160, 1)); // 1 s of the call's sound
  assert.ok(Math.abs(soundBytes(out) - (P + 3000) * 8) <= 2 * 160, `the sound starts where it belongs in time: ${soundBytes(out)}`);
  const first = flvTags(out).find((x) => x.type === 8 && x.data[1] === 1);
  assert.ok(Math.abs(first.ms - (P + 2000)) <= 20, `stamped at 2 s after the prebuffer: ${first.ms}`);
  for (let i = 0; i < 50; i++) step(); // 1 s gap
  step(Buffer.alloc(160, 2));
  assert.ok(Math.abs(soundBytes(out) - (P + 4000) * 8 - 160) <= 2 * 160, `after a gap, too: ${soundBytes(out)}`);
  f.stop();
  s.end();
});

test('RingFeeder: ffmpeg finds the sound at once, even after a large buffered keyframe', () => {
  const s = new RingSource('call', [sps, pps, idr(34_000)]);
  const out = [];
  const f = new RingFeeder(s, 0, (b) => out.push(b), true, () => undefined);
  const tags = flvTags(out);
  assert.strictEqual(tags[0].type, 8, 'a piece of silence before any video');
  f.stop();
  s.end();
});

test('RingFeeder: sound delayed by a Wi-Fi stall is dropped, not appended late (picture and sound stay together)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 3_000_000 });
  const s = new RingSource('call', [sps, pps, idr(3000)]);
  const out = [];
  const f = new RingFeeder(s, 0, (b) => out.push(b), true, () => undefined);
  const step = (sound) => { s.push(p); if (sound) s.pushAudio(sound); t.mock.timers.tick(20); };
  for (let i = 0; i < 50; i++) step(Buffer.alloc(160, 1)); // 1 s of sound
  for (let i = 0; i < 50; i++) step(); // a 1 s stall
  for (let i = 0; i < 50; i++) s.pushAudio(Buffer.alloc(160, 3)); // the stalled second arrives at once
  for (let i = 0; i < 50; i++) step(Buffer.alloc(160, 1)); // and on as normal
  const ahead = soundBytes(out) / 8 - P - 3000;
  assert.ok(ahead <= 100, `the sound is at most 100 ms off the picture after the stall: ${ahead} ms`);
  f.stop();
  s.end();
});

test('RingFeeder: when the picture stops before the ring ends, the sound stops with it (the last fragment stays short)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 4_000_000 });
  const s = new RingSource('call', [sps, pps, idr(3000)]);
  const out = [];
  let ended = false;
  new RingFeeder(s, 0, (b) => out.push(b), true, () => (ended = true));
  for (let i = 0; i < 50; i++) { s.push(p); s.pushAudio(Buffer.alloc(160, 1)); t.mock.timers.tick(20); }
  for (let i = 0; i < 300; i++) { s.pushAudio(Buffer.alloc(160, 1)); t.mock.timers.tick(20); } // no more picture: the ring ends 5 s later
  assert.ok(ended);
  const sound = soundBytes(out) / 8;
  // At most 250 ms past the last frame (it may run that far ahead while waiting for the picture),
  // which the keyframe interval (3.75 s for 4 s fragments) leaves room for.
  assert.ok(sound <= P + 1000 + 250 + 20, `the sound ends with the last frame (1 s after the prebuffer): ${sound} ms`);
});

test('FlvWriter: an FLV header for video (and sound), and tags with 32-bit times', () => {
  const out = [];
  const w = new FlvWriter((b) => out.push(b), true);
  assert.deepStrictEqual([...out[0].subarray(0, 5)], [0x46, 0x4c, 0x56, 1, 5]);
  w.audio(Buffer.alloc(8, 0xd5), 0x1234567);
  const [tag] = flvTags(out);
  assert.strictEqual(tag.ms, 0x1234567);
  assert.strictEqual(new FlvWriter((b) => out.push(b), false) && out.at(-1)[4], 1);
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

// The real thing: the recorder and ffmpeg turn intercom-like video (640x240, 16 fps, a keyframe
// every 3 s) and A-law sound, fed at their real pace, into HomeKit fragments: each starts with a
// keyframe and lasts at most the fragment length, and the sound is as long as the picture.
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
const ffprobeOk = spawnSync('ffprobe', ['-version']).status === 0;
const ffmpegOk = encoders.includes('libx264') && ffprobeOk;
test('recording with ffmpeg: fragments start with a keyframe and are no longer than 4 s, with sound in step', { skip: !ffmpegOk && 'no ffmpeg with libx264, or no ffprobe', timeout: 30_000 }, async () => {
  const seconds = 9;
  const h264 = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc=size=640x240:rate=16:duration=${seconds}`,
    '-c:v', 'libx264', '-g', '48', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', 'pipe:1'], { maxBuffer: 64 << 20 }).stdout;
  // Split into NAL units with 4-byte start codes, as the depacketizer gives them.
  const starts = [];
  for (let i = 0; i + 3 <= h264.length; i++) if (h264[i] === 0 && h264[i + 1] === 0 && h264[i + 2] === 1) { starts.push(i); i += 2; }
  const units = starts.map((st, k) => {
    const end = k + 1 < starts.length ? (h264[starts[k + 1] - 1] === 0 ? starts[k + 1] - 1 : starts[k + 1]) : h264.length;
    return Buffer.concat([Buffer.from([0, 0, 0, 1]), h264.subarray(st + 3, end)]);
  });
  // The local ffmpeg may lack libfdk_aac: use its own AAC encoder for the test.
  const spawnTest = (what, args) => {
    const fixed = encoders.includes('libfdk_aac') ? args : args.map((a) => (a === 'libfdk_aac' ? 'aac' : a)).filter((a, i, arr) => a !== '-profile:a' && arr[i - 1] !== '-profile:a');
    return spawnFfmpeg('ffmpeg', quietLog())(what, fixed);
  };
  const r = new RingRecorder(quietLog(), () => undefined, () => true, spawnTest);
  r.leftoverGapMs = 0;
  r.updateRecordingActive(true);
  r.updateRecordingConfiguration(configuration());
  const call = {};
  // Live: 16 frames a second; the sound (50 packets a second) only from 3 s on, as after answering.
  let n = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    const due = Math.floor(((Date.now() - started) / 1000) * 16);
    while (n < units.length && units.slice(0, n).filter((u) => [1, 5].includes(u[4] & 0x1f)).length < due) r.onCallVideo(call, units[n++]);
    if (Date.now() - started > 3000) r.onCallAudio(call, Buffer.from({ length: 160 }, (_, k) => (k % 2 ? 0x2a : 0xaa))); // a loud tone
    if (n >= units.length) { clearInterval(timer); r.onCallEnded(call); }
  }, 20);
  const packets = [];
  for await (const packet of r.handleRecordingStreamRequest(1)) packets.push(packet);
  r.shutdown();
  assert.ok(packets.at(-1).isLast);
  const init = packets[0].data;
  const fragments = packets.slice(1);
  assert.ok(fragments.length >= 2, `${fragments.length} fragments`);
  for (const f of fragments) {
    // Each fragment on its own, after the init, as the hub sees it.
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'packet=duration_time,flags', '-of', 'csv=p=0', '-i', 'pipe:0'],
      { input: Buffer.concat([init, f.data]), encoding: 'utf8' });
    const rows = probe.stdout.trim().split('\n').map((l) => l.split(','));
    assert.match(rows[0][1], /K/, 'starts with a keyframe');
    const s = rows.reduce((t, row) => t + Number(row[0]), 0);
    assert.ok(s <= 4.0, `${s.toFixed(3)} s`);
  }
  // How long each track is: the end of its last packet.
  const end = (stream) => {
    const rows = spawnSync('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', '-i', 'pipe:0'],
      { input: Buffer.concat(packets.map((x) => x.data)), encoding: 'utf8', maxBuffer: 16 << 20 }).stdout.trim().split('\n').map((l) => l.split(',').map(Number));
    return Math.max(...rows.map(([pts, d]) => pts + (d || 0)));
  };
  const video = end('v');
  const audio = end('a');
  assert.ok(Math.abs(video - P / 1000 - (seconds - 0.25)) < 1.2, `picture ${video} s for ${seconds} s of video and the prebuffer`);
  assert.ok(Math.abs(audio - video) < 0.5, `sound ${audio} s, picture ${video} s`);
  // Silent until the call's sound starts at 3 s, loud after.
  const loudness = (at) => Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync('ffmpeg', ['-hide_banner', '-ss', String(at), '-t', '0.5', '-i', 'pipe:0', '-map', '0:a', '-af', 'volumedetect', '-f', 'null', '-'],
    { input: Buffer.concat(packets.map((x) => x.data)), encoding: 'utf8', maxBuffer: 16 << 20 }).stderr)[1]);
  assert.ok(loudness(P / 1000 + 1.5) < -60, `silent at 1.5 s: ${loudness(P / 1000 + 1.5)} dB`);
  assert.ok(loudness(P / 1000 + 4.5) > -30, `the sound at 4.5 s: ${loudness(P / 1000 + 4.5)} dB`);
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

test('camera: Record audio in the Home app reaches the recorder (beta.1-3 read it from the wrong service)', () => {
  const cam = new DoorbellCamera({ hap }, quietLog(), resolveSettings({ camera: true, recording: true, host: 'h', token: 't' }), () => undefined);
  new hap.Accessory('Door', hap.uuid.generate('door-audio')).configureController(cam.controller);
  const audio = cam.controller.recordingManagement.recordingManagementService.getCharacteristic(hap.Characteristic.RecordingAudioActive);
  assert.strictEqual(cam.recorder.audioActive(), false);
  audio.setValue(1);
  assert.strictEqual(cam.recorder.audioActive(), true, 'on in the Home app: the recording has sound');
  audio.setValue(0);
  assert.strictEqual(cam.recorder.audioActive(), false);
  cam.shutdown();
});

test('recorder log (debug): when HomeKit asked, when the first piece went, and the sound kept, gap-filled and dropped (2.3.0-beta.5)', async () => {
  const lines = [];
  const log = { ...quietLog(), debug: (m) => lines.push(m) };
  const procs = [];
  const r = new RingRecorder(log, () => undefined, () => true, () => { const p = fakeProcess(); p.on('error', () => undefined); procs.push(p); return p; });
  r.leftoverGapMs = 0;
  r.updateRecordingActive(true);
  r.updateRecordingConfiguration(configuration());
  const call = { born: Date.now() - 3000 };
  ring(r, call);
  const reading = readAll(r.handleRecordingStreamRequest(7));
  await tick();
  r.onCallAudio(call, Buffer.alloc(160, 1));
  r.onCallVideo(call, p);
  await tick();
  fmp4(procs[0]);
  procs[0].stdout.emit('data', Buffer.concat([box('moof'), box('mdat', 32)]));
  r.onCallEnded(call);
  await tick();
  procs[0].emit('close', 0);
  await reading;
  r.shutdown();
  const text = lines.join('\n');
  assert.match(text, /recording 7: HomeKit asked 3\.\d s after the ring; the recording starts at [\d:.]+ \(3\.\d s after the ring, the first picture\)/);
  assert.match(text, /recording 7: first piece to HomeKit at [\d:.]+, \d+\.\d s after the recording starts/);
  assert.match(text, /recording 7: sent the ring to HomeKit, 3 fragment\(s\), \d+\.\d s \(including the 4 s still at the start\), ending at [\d:.]+, with sound: 1 pieces of the intercom's sound, \d+\.\d s of gaps filled with silence, 0 dropped as late/);
});

test("recording: the intercom's old picture (a keyframe with another 1 s after it) is skipped; the clip starts at the fresh one (2.3.3)", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 3_000_000 });
  const firstFrame = (s) => {
    const out = [];
    const f = new RingFeeder(s, s.start, (b) => out.push(b), false, () => undefined);
    t.mock.timers.tick(40);
    f.stop();
    const v = videoTags(out);
    assert.strictEqual(v[0].data[0], 0x17, 'decoder configuration first');
    return v[1].data.length; // 5 + 4 + the keyframe's bytes
  };
  // The fresh keyframe with its own SPS/PPS, 1 s after the old one.
  let s = new RingSource('call', [sps, pps, idr(3000)]);
  s.push(p);
  t.mock.timers.tick(1000);
  for (const u of [sps, pps, idr(2500), p]) s.push(u);
  await s.ready;
  assert.strictEqual(s.start, 4, 'at the fresh keyframe\'s SPS');
  assert.deepStrictEqual(s.skipped, { bytes: 3000, gapMs: 1000 });
  assert.strictEqual(firstFrame(s), 5 + 4 + 2496, 'the clip starts with the fresh picture');
  s.end();
  // Without its own SPS/PPS: the ones before it are used.
  s = new RingSource('call', [sps, pps, idr(3000)]);
  s.push(p);
  t.mock.timers.tick(800);
  for (const u of [idr(2500), p]) s.push(u);
  await s.ready;
  assert.strictEqual(s.start, 4);
  assert.strictEqual(firstFrame(s), 5 + 4 + 2496);
  s.end();
  // The next keyframe only 3 s later: an ordinary start, the first keyframe is kept.
  s = new RingSource('call', [sps, pps, idr(3000)]);
  s.push(p);
  let settled = false;
  void s.ready.then(() => (settled = true));
  t.mock.timers.tick(2000);
  await Promise.resolve();
  assert.strictEqual(settled, true, 'decided 2 s after the first keyframe');
  t.mock.timers.tick(1000);
  for (const u of [sps, pps, idr(2500), p]) s.push(u);
  assert.strictEqual(s.start, 0);
  assert.strictEqual(s.skipped, undefined);
  assert.strictEqual(firstFrame(s), 5 + 4 + 2996);
  s.end();
  // The ring ending decides at once.
  s = new RingSource('call', [sps, pps, idr(3000)]);
  s.end();
  await s.ready;
  assert.strictEqual(s.start, 0);
  // A keyframe followed straight by SPS/PPS still counts as complete (review).
  s = new RingSource('call', [sps, pps, idr(3000)]);
  s.push(sps);
  t.mock.timers.tick(900);
  for (const u of [pps, idr(2500), sps]) s.push(u);
  await s.ready;
  assert.strictEqual(s.start, 3, 'the fresh keyframe, at the SPS/PPS that came right before it');
  s.end();
});

test('recorder: after an empty (black) keyframe the recording starts at the first real one at once (2.3.3 review)', async () => {
  const procs = [];
  const r = new RingRecorder(quietLog(), () => undefined, () => false, () => { const pr = fakeProcess(); pr.on('error', () => undefined); procs.push(pr); return pr; });
  r.attached();
  r.updateRecordingActive(true);
  r.updateRecordingConfiguration(configuration());
  const call = { born: Date.now() };
  for (const u of [sps, pps, idr(1000), p, sps, pps, idr(3000), p]) r.onCallVideo(call, u);
  const first = r.handleRecordingStreamRequest(1).next();
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(procs.length, 1, 'no 2 s wait');
  r.onCallEnded(call);
  r.shutdown();
  await Promise.race([first.catch(() => undefined), new Promise((res) => setTimeout(res, 200))]);
});

test('recorder: the request waits for the fresh keyframe and logs that the first was the old picture (2.3.3)', async () => {
  const lines = [];
  const log = { ...quietLog(), debug: (m) => lines.push(m) };
  const procs = [];
  const r = new RingRecorder(log, () => undefined, () => false, () => { const pr = fakeProcess(); pr.on('error', () => undefined); procs.push(pr); return pr; });
  r.attached();
  r.updateRecordingActive(true);
  r.updateRecordingConfiguration(configuration());
  const call = { born: Date.now() - 3000 };
  for (const u of [sps, pps, idr(3000), p]) r.onCallVideo(call, u);
  const gen = r.handleRecordingStreamRequest(1);
  const first = gen.next();
  await new Promise((res) => setTimeout(res, 300));
  assert.strictEqual(procs.length, 0, 'ffmpeg waits until it is known where the clip starts');
  for (const u of [sps, pps, idr(2500), p]) r.onCallVideo(call, u);
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(procs.length, 1);
  assert.ok(lines.some((l) => /the recording starts at .*the intercom's second keyframe: its first \(3000 bytes, 0\.3 s before\) was its old picture/.test(l)), lines.join('\n'));
  r.onCallEnded(call);
  procs[0].emit('exit', 0);
  procs[0].stdout.end?.();
  r.shutdown();
  await Promise.race([first.catch(() => undefined), new Promise((res) => setTimeout(res, 200))]);
});
