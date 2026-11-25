// Live view without a ring: our own call to the entrance panel (as the Comelit app's camera button).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { CallHandler } = require('../dist/call');
const { parseFrame, buildFrame } = require('../dist/ctp');
const { buildRtp } = require('../dist/media');
const { VipEventListener } = require('../dist/vipListener');
const { callHandlerMode, resolveSettings, settingsWarnings } = require('../dist/config');
const { frames, quietLog } = require('./helpers');

function fakeClient() {
  const c = new EventEmitter();
  let next = 0x2001;
  c.opened = [];
  c.closed = [];
  c.handlers = new Map();
  c.openChannel = async (name, _type, _extra, _trailing, wire = name) => { const h = next++; c.opened.push([name, wire, h]); return { serverChannelId: h }; };
  c.closeHandle = async (_name, h) => { c.closed.push(h); };
  c.binaryHandlerFor = (h) => c.handlers.get(h);
  c.setBinaryHandler = (h, fn) => (fn ? c.handlers.set(h, fn) : c.handlers.delete(h));
  c.sendOnHandle = async () => undefined;
  return c;
}

/**
 * A simulated panel answering our call the way the PCAP-verified implementations describe:
 * an acknowledgement of the INVITE, its capabilities and SETUP_ACK after ours, its media request
 * after our audio request. `script` overrides a step (return false to stay silent).
 */
function setup({ options = { liveViewWithoutRing: true, panelAddress: 'SB100001' }, mode = 'answer-on-view', script = {} } = {}) {
  const sent = [];
  const log = quietLog();
  let call;
  const reply = (f, flags, bodyHex) => {
    const seq = 0x50 + sent.length;
    const body = Buffer.from(bodyHex, 'hex');
    setImmediate(() =>
      call.onFrame({ flags, conn0: f.conn0 ^ 0x80, conn1: f.conn1, seq, ack: (f.seq + 1) & 0xff, body, opcode: body.length >= 2 ? body.readUInt16BE(0) : -1 }, ['SB100001']),
    );
  };
  call = new CallHandler(mode, 'SB0000023', 'SB000002', async (raw) => {
    sent.push(raw);
    const f = parseFrame(raw);
    if (f.flags === 0x60) {
      reply(f, 0x20, ''); // the panel answers our hang-up (DATA_FIN) with an empty FIN, as on a real one
    } else if (f.flags === 0xc0 && f.opcode === 0x0001) {
      if (script.invite?.(f, reply) !== false) reply(f, 0x00, '');
    } else if (f.opcode === 0x0003) {
      if (script.capabilities?.(f, reply) !== false) {
        reply(f, 0x40, '0003500327000000');
        reply(f, 0x40, '000c');
      }
    } else if (f.opcode === 0x0011 && f.body[2] === 0x18) {
      if (script.audio?.(f, reply) !== false) reply(f, 0x40, '00111802000000000130');
    }
  }, log, { startTimeoutMs: 10_000, silenceMs: 5_000, videoRefreshMs: 60_000 }, options);
  const client = fakeClient();
  call.attach(client);
  return { call, client, sent, log };
}

const parsed = (sent) => sent.map((f) => parseFrame(f));

/**
 * The fixture ring, on a connection id our own call doesn't use. Our call's id is random, so with
 * the fixture's fixed id they matched about once in 65,536 runs (a CI failure, 2026-11-20); the
 * plugin's handling of that collision is a separate edge case.
 */
const ringFrame = (call) => {
  const f = parseFrame(frames.invite);
  while (call.calls.has((f.conn1 << 8) | f.conn0)) f.conn1 = (f.conn1 + 1) & 0xff;
  return f;
};
const ops = (sent) => parsed(sent).filter((f) => f.body.length).map((f) => f.opcode.toString(16));

test('live view without a ring: calls the panel, then asks for video, without VOICESTATUS', async () => {
  const { call, client, sent } = setup();
  const session = await call.startMedia(false);
  assert.ok(session, 'a media session');
  // invite, capabilities, audio request, video request (no 0x70 voice status)
  assert.deepStrictEqual(ops(sent).slice(0, 4), ['1', '3', '11', '11']);
  assert.ok(!ops(sent).includes('70'));
  const [invite, caps] = parsed(sent);
  assert.strictEqual(invite.flags, 0xc0);
  // body: opcode, our address, the panel's, session block 01 20 + 4 bytes, our address, "II"
  assert.strictEqual(invite.body.length, 40);
  assert.strictEqual(invite.body.subarray(2, 12).toString('latin1'), 'SB0000023\0');
  assert.strictEqual(invite.body.subarray(12, 22).toString('latin1'), 'SB100001\0\0');
  assert.strictEqual(invite.body.subarray(22, 24).toString('hex'), '0120');
  assert.strictEqual(invite.body.subarray(28, 38).toString('latin1'), 'SB0000023\0');
  assert.strictEqual(invite.body.subarray(38).toString('latin1'), 'II');
  // same connection for the whole call, our capabilities as the app's
  assert.strictEqual(caps.conn0, invite.conn0);
  assert.strictEqual(caps.conn1, invite.conn1);
  assert.strictEqual(caps.body.toString('hex'), '0003490027000000');
  // the trailer is addressed to the panel
  assert.strictEqual(sent[0].subarray(-10).toString('latin1').replace(/\0+$/, ''), 'SB100001');
  // after the panel's media request: an empty DATA frame (ready)
  const last = parsed(sent).at(-1);
  assert.strictEqual(last.flags, 0x40);
  assert.strictEqual(last.body.length, 0);
  assert.deepStrictEqual(client.opened.map((o) => o[1]), ['UDPM', 'RTPC', 'RTPC']);
  // its video arrives as for an answered ring
  const got = [];
  session.on('video', (u) => got.push(u));
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 2 }, Buffer.from([0x65, 9])));
  assert.deepStrictEqual(got, [Buffer.from([0, 0, 0, 1, 0x65, 9])]);
  // closing the view hangs up, still without VOICESTATUS
  await session.end('viewer closed');
  assert.ok(!ops(sent).includes('70'));
  assert.strictEqual(ops(sent).at(-1), 'e');
  assert.deepStrictEqual(client.closed.sort(), [0x2001, 0x2002, 0x2003]);
});

test('live view without a ring is off by default: no ring, no call, the picture', async () => {
  const { call, sent } = setup({ options: {} });
  assert.strictEqual(await call.startMedia(false), null);
  assert.strictEqual(sent.length, 0);
});

test('without the panel address, no call is placed', async () => {
  const { call, sent } = setup({ options: { liveViewWithoutRing: true, panelAddress: '' } });
  assert.strictEqual(await call.startMedia(false), null);
  assert.strictEqual(sent.length, 0);
});

test('a ringing call is answered as before, not replaced by our own call', async () => {
  const { call, sent } = setup();
  await call.onFrame(ringFrame(call), ['SB100001']);
  await call.onFrame(parseFrame(frames.capabilities), ['SB100001']);
  const session = await call.startMedia(false);
  assert.ok(session);
  const first = parsed(sent)[0];
  assert.notStrictEqual(first.flags, 0xc0, 'no INVITE of ours');
  assert.ok(ops(sent).includes('c'), 'the ring was answered');
  await session.end('test');
});

test('the panel refusing our call: the live view gets an error (and shows the picture)', async () => {
  const { call, sent } = setup({ script: { invite: (f, reply) => (reply(f, 0x60, '000e0800'), false) } });
  await assert.rejects(call.startMedia(false), /refused our call \(cause 8\)/);
  assert.deepStrictEqual(ops(sent), ['1'], 'nothing more sent');
});

test('two viewers opening at once share one call to the panel', async () => {
  const { call, sent } = setup();
  const [a, b] = await Promise.all([call.startMedia(false), call.startMedia(false)]);
  assert.strictEqual(a, b);
  assert.strictEqual(parsed(sent).filter((f) => f.flags === 0xc0).length, 1);
  await a.end('test');
});

test('our own call is never recorded and its frames are known as ours', async () => {
  const { call, client } = setup();
  const heard = [];
  call.setCallListener({ video: () => heard.push('video'), ended: () => heard.push('ended') });
  const session = await call.startMedia(false);
  const own = call.activeCall();
  assert.ok(call.isOwnCall(own.conn0, own.conn1));
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 2 }, Buffer.from([0x65, 9])));
  await session.end('test');
  assert.deepStrictEqual(heard, []);
});

test('frames of our own call are not taken as a ring or a door event by the listener', async () => {
  const log = quietLog();
  const events = [];
  const sentRaw = [];
  const client = {
    channel: { name: 'CTPP', isOpen: true, serverChannelId: 1, responseQueue: { clear() {}, dequeue: () => new Promise(() => {}) } },
    sendBinary: async (_ch, b) => { sentRaw.push(Buffer.from(b)); },
  };
  let listener;
  const call = new CallHandler('answer-on-view', 'SB0000023', 'SB000002', (f) => listener.sendFrame(f), log, undefined, { liveViewWithoutRing: true, panelAddress: 'SB100001' });
  listener = new VipEventListener(client, { aptAddress: 'SB000002', aptSubaddress: 3, doors: [], cameras: [] }, (e) => events.push(e.eventType), log, call);
  listener.channel = client.channel;
  listener.running = true;
  call.attach(fakeClient());
  const placing = call.startMedia(false).catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  const invite = parseFrame(sentRaw[0]);
  // The panel answers on our connection with frames that would otherwise look like events:
  // a 1-byte DATA+FIN body (IN_ALERTING's shape) and a 3-byte release-shaped one.
  for (const body of ['01', '002d00']) {
    await listener.processMessage(buildFrame({ flags: 0x60, conn0: invite.conn0 ^ 0x80, conn1: invite.conn1, seq: 1, ack: 1, body: Buffer.from(body, 'hex'), source: 'SB100001', destination: 'SB0000023' }));
  }
  assert.deepStrictEqual(events, []);
  await placing;
});

const door = { name: 'Entrance', index: 0, outputIndex: 1, aptAddress: 'SB100001' };
const opens = (sent) => parsed(sent).filter((f) => f.body.length >= 2 && f.opcode === 0x2d);

test('our own live view call is never used to open the door (doctor mode, Next Visitor, the lock)', async () => {
  const { call, sent } = setup();
  const session = await call.startMedia(false);
  assert.ok(call.activeCall()?.outbound, 'our call is up');
  assert.strictEqual(call.ringingCall(), undefined, 'and it is not a ring');
  assert.strictEqual(await call.openInCall(door, true), null, 'doctor mode / Next Visitor: not opened in our call');
  assert.strictEqual(await call.openInCall(door, false), null, 'the lock: opens the normal way instead');
  assert.deepStrictEqual(opens(sent), [], 'no open sent on our call');
  await session.end('test');
});

test('a ring arriving during our own live view: the forced open goes into the ring, not our call', async () => {
  const { call, sent } = setup();
  const session = await call.startMedia(false);
  const own = call.activeCall();
  await call.onFrame(ringFrame(call), ['SB100001']);
  await call.onFrame(parseFrame(frames.capabilities), ['SB100001']);
  const ringCall = call.ringingCall();
  assert.ok(ringCall && !ringCall.outbound && ringCall !== own);
  const result = await call.openInCall(door, true);
  assert.deepStrictEqual(result, { confirmed: true });
  const sentOpens = opens(sent);
  assert.strictEqual(sentOpens.length, 1);
  assert.strictEqual(sentOpens[0].conn1, ringCall.conn1, 'on the ring\'s connection');
  assert.notStrictEqual((sentOpens[0].conn1 << 8) | (sentOpens[0].conn0 & 0x7f), (own.conn1 << 8) | (own.conn0 & 0x7f), 'not on ours');
  await session.end('test');
});

test('settings: off by default; on, calls are followed and it needs the camera and rings', () => {
  assert.strictEqual(resolveSettings({ platform: 'x' }).liveViewWithoutRing, false);
  const on = resolveSettings({ platform: 'x', camera: true, liveViewWithoutRing: true });
  assert.strictEqual(on.liveViewWithoutRing, true);
  assert.strictEqual(callHandlerMode(on), 'handshake', 'calls are followed even with answering off');
  assert.ok(settingsWarnings(resolveSettings({ platform: 'x', liveViewWithoutRing: true })).some((w) => /needs the doorbell camera/.test(w)));
  assert.ok(settingsWarnings(resolveSettings({ platform: 'x', camera: true, liveViewWithoutRing: true, enableNotifications: false })).some((w) => /Listen for rings/.test(w)));
});

test('an own call that ends without video warns once per run; closing the view early does not', async () => {
  const { call } = setup();
  const warns = [];
  call.log = { debug() {}, info() {}, error() {}, warn: (m) => warns.push(m) };
  let session = await call.startMedia(false);
  await session.end('viewer closed');
  session = await call.startMedia(false);
  await session.end('viewer left');
  assert.deepStrictEqual(warns, [], 'the viewer left before any video was due: no warning');
  session = await call.startMedia(false);
  await session.end('no media from the intercom');
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /took the call but sent no video \(no media from the intercom\).*Entrance button/);
  session = await call.startMedia(false);
  await session.end('the intercom ended the call');
  assert.strictEqual(warns.length, 1, 'only once');
});

test('no video shortly after a ring or a call with sound: explained as the panel being busy, not a setup problem', async () => {
  const { call } = setup();
  const warns = [];
  const infos = [];
  call.log = { debug() {}, error() {}, info: (m) => infos.push(m), warn: (m) => warns.push(m) };
  call.lastRingAt = Date.now() - 28_000; // as on the author's kit: a ring, then a live view 28 s later
  let session = await call.startMedia(false);
  await session.end('the intercom ended the call');
  assert.deepStrictEqual(warns, []);
  assert.strictEqual(infos.length, 1);
  assert.match(infos[0], /no video \(the intercom ended the call\); the intercom was still busy after the ring 28 s earlier .*Try again in a few seconds/);

  call.lastRingAt = 0;
  call.lastSoundCallEndedAt = Date.now() - 5_000;
  session = await call.startMedia(false);
  await session.end('no media from the intercom');
  assert.match(infos[1], /after the call with sound 5 s earlier/);
  assert.deepStrictEqual(warns, []);

  // A minute later it is a setup problem again: the usual warning (still once per run).
  call.lastSoundCallEndedAt = Date.now() - 61_000;
  session = await call.startMedia(false);
  await session.end('no media from the intercom');
  assert.strictEqual(warns.length, 1);
  assert.match(warns[0], /took the call but sent no video .*Entrance button/);
});

test('a ring, and the end of a call with sound, are remembered for that explanation', async () => {
  const { call } = setup();
  const silent = await call.startMedia(false);
  await silent.end('viewer closed');
  assert.strictEqual(call.lastSoundCallEndedAt, 0, 'a silent live view without a ring does not count');
  assert.strictEqual(call.lastRingAt, 0);
  const before = Date.now();
  await call.onFrame(ringFrame(call), ['SB100001']);
  assert.ok(call.lastRingAt >= before, 'ring time noted');
  const ring = await call.startMedia(false); // the view uses the ring's call
  await ring.end('viewer closed');
  assert.ok(call.lastSoundCallEndedAt >= before, "the end of a ring's media is noted");
});

test('sound in live view without a ring: our call is answered like a ring, with VOICESTATUS before the video request', async () => {
  const { call, sent } = setup({ options: { liveViewWithoutRing: true, liveViewSound: 'always', panelAddress: 'SB100001' } });
  const session = await call.startMedia(false);
  const o = ops(sent);
  // invite, capabilities, audio request, voice status 1, audio request again, video request
  assert.deepStrictEqual(o.slice(0, 6), ['1', '3', '11', '70', '11', '11']);
  const kinds = parsed(sent).filter((f) => f.opcode === 0x11).map((f) => f.body[2].toString(16));
  assert.deepStrictEqual(kinds.slice(0, 3), ['18', '18', '14'], 'audio, audio again, then video');
  const voice = parsed(sent).find((f) => f.opcode === 0x70);
  assert.strictEqual(voice.body[voice.body.length - 2], 1, 'voice status 1');
  assert.ok(voice.body.includes(Buffer.from('SB100001')), "with the caller's (the panel's) address, as for a ring");
  const closing = sent.length;
  await session.end('viewer closed');
  const off = parsed(sent.slice(closing)).find((f) => f.opcode === 0x70);
  assert.ok(off && off.body[off.body.length - 2] === 0, 'voice status 0 when the view closes');
});

test('sound in live view without a ring: off by default, and needs live view without a ring', () => {
  const r = (v) => resolveSettings({ platform: 'x', camera: true, liveViewWithoutRing: true, liveViewSound: v });
  assert.strictEqual(resolveSettings({ platform: 'x' }).liveViewSound, 'off');
  assert.strictEqual(r('talk').liveViewSound, 'talk');
  assert.strictEqual(r('always').liveViewSound, 'always');
  assert.strictEqual(r(true).liveViewSound, 'always', "2.4.0-beta.2's true");
  assert.strictEqual(r(false).liveViewSound, 'off');
  assert.strictEqual(r('loud').liveViewSound, 'off');
  assert.ok(r('loud').invalid.some((m) => /liveViewSound/.test(m)), 'an unknown value is reported');
  assert.ok(settingsWarnings(resolveSettings({ platform: 'x', camera: true, liveViewSound: 'always' })).some((w) => /needs 'Live view without a ring'/.test(w)));
  assert.ok(settingsWarnings(resolveSettings({ platform: 'x', camera: true, liveViewWithoutRing: true, liveViewSound: 'talk', talkBack: false })).some((w) => /needs 'Talk-back'/.test(w)));
  assert.deepStrictEqual(settingsWarnings(r('talk')), []);
  assert.deepStrictEqual(settingsWarnings(r('always')), []);
});

test('sound in live view without a ring: the panel hanging up during setup ends it with the cause, and nothing more is sent', async () => {
  const { call, sent } = setup({
    options: { liveViewWithoutRing: true, liveViewSound: 'always', panelAddress: 'SB100001' },
    script: { audio: (f, reply) => { reply(f, 0x40, '000e07'); return false; } },
  });
  await assert.rejects(call.startMedia(false), /the intercom ended our call \(cause 7\)/);
  assert.ok(!ops(sent).includes('70'), 'no voice status on a released call');
  assert.ok(!parsed(sent).some((f) => f.opcode === 0x11 && f.body[2] === 0x14), 'no video request either');
});

test('sound in live view without a ring: the sound of our own call never reaches recording', async () => {
  const { call, client } = setup({ options: { liveViewWithoutRing: true, liveViewSound: 'always', panelAddress: 'SB100001' } });
  const heard = [];
  call.setCallListener({ video: () => heard.push('video'), audio: () => heard.push('audio'), ended: () => heard.push('ended') });
  const session = await call.startMedia(false);
  const got = [];
  session.on('audio', (a) => got.push(a));
  client.handlers.get(0x2002)(buildRtp({ marker: false, payloadType: 8, sequence: 1, timestamp: 0, ssrc: 3 }, Buffer.alloc(160, 0xd5)));
  await session.end('test');
  assert.strictEqual(got.length, 1, 'the live view gets the sound');
  assert.deepStrictEqual(heard, [], 'recording gets nothing');
});

const talkOptions = { liveViewWithoutRing: true, liveViewSound: 'talk', panelAddress: 'SB100001' };
const invites = (sent) => parsed(sent).filter((f) => f.flags === 0xc0 && f.opcode === 0x0001);

test("sound 'when you talk': the view starts silent; the microphone places the call again with sound, on the same view", async () => {
  const { call, client, sent } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  assert.ok(!ops(sent).includes('70'), 'silent at first');
  const first = call.activeCall();
  let ended = 0;
  session.on('end', () => ended++);
  const before = sent.length;
  await session.openSound();
  const after = parsed(sent.slice(before));
  const oldConn = (f) => f.conn0 === (first.conn0 ^ 0x80) && f.conn1 === first.conn1;
  assert.ok(after.some((f) => oldConn(f) && f.opcode === 0x0e), 'the silent call is hung up');
  assert.strictEqual(invites(sent).length, 2, 'a new call');
  const next = call.activeCall();
  assert.notStrictEqual(next, first);
  assert.strictEqual(next.media, session, 'the same view, now on the new call');
  const newFrames = after.filter((f) => !oldConn(f));
  assert.deepStrictEqual(newFrames.filter((f) => f.body.length).map((f) => f.opcode.toString(16)), ['1', '3', '11', '70', '11', '11'], 'answered as a ring');
  assert.strictEqual(ended, 0, 'the view did not end');
  assert.strictEqual(session.isEnded, false);
  const heard = [];
  session.on('audio', (a) => heard.push(a));
  client.handlers.get(0x2002)(buildRtp({ marker: false, payloadType: 8, sequence: 1, timestamp: 0, ssrc: 3 }, Buffer.alloc(160, 0xd5)));
  assert.strictEqual(heard.length, 1, "the panel's sound reaches the view");
  const closing = sent.length;
  await session.end('viewer closed');
  const last = parsed(sent.slice(closing));
  assert.ok(last.some((f) => f.opcode === 0x70 && f.body[f.body.length - 2] === 0), 'voice status 0 on close');
  assert.ok(last.every((f) => !oldConn(f)), 'closing only touches the new call');
});

test("sound 'when you talk': more microphone sound, or two triggers at once, place one new call only", async () => {
  const { call, sent } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  await Promise.all([session.openSound(), session.openSound()]);
  await session.openSound();
  assert.strictEqual(invites(sent).length, 2);
  await session.end('test');
});

test("sound 'off' and 'always': the microphone changes nothing", async () => {
  for (const mode of ['off', 'always']) {
    const { call, sent } = setup({ options: { ...talkOptions, liveViewSound: mode } });
    const session = await call.startMedia(false);
    await session.openSound();
    assert.strictEqual(invites(sent).length, 1, mode);
    await session.end('test');
  }
});

test("sound 'when you talk': closing the view during the switch places no new call", async () => {
  const { call, sent } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  let ended = 0;
  session.on('end', () => ended++);
  const switching = session.openSound();
  await session.end('viewer closed');
  await switching;
  assert.strictEqual(invites(sent).length, 1);
  assert.strictEqual(ended, 1);
});

test("sound 'when you talk': if the panel refuses the new call three times, the view ends and says why", async () => {
  let n = 0;
  const { call, sent } = setup({
    options: talkOptions,
    script: { invite: (f, reply) => (++n === 1 ? undefined : (reply(f, 0x40, '000e08'), false)) },
  });
  const session = await call.startMedia(false);
  const why = new Promise((r) => session.once('end', r));
  await session.openSound();
  assert.strictEqual(await why, 'could not call the panel again with sound');
  assert.strictEqual(invites(sent).length, 4, 'the first call, then three tries');
});

test("sound 'when you talk': a second viewer during the switch joins the view", async () => {
  const { call, sent } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  const switching = session.openSound();
  await new Promise((r) => setImmediate(r));
  const second = await call.startMedia(false);
  await switching;
  assert.strictEqual(second, session);
  assert.strictEqual(invites(sent).length, 2);
  await session.end('test');
});

test("sound 'when you talk': after the switch, the new call's video without a keyframe brings one more video request", async () => {
  const videoRequests = (sent) => parsed(sent).filter((f) => f.opcode === 0x0011 && f.body[2] === 0x14).length;
  for (const keyframe of [false, true]) {
    const { call, client, sent } = setup({ options: talkOptions });
    const session = await call.startMedia(false);
    const video = (seq, nal) => client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: seq, timestamp: seq, ssrc: 2 }, Buffer.from([nal, 1, 2])));
    video(1, 0x67); // the silent call's keyframe (SPS): no retry before the switch
    await session.openSound();
    const before = videoRequests(sent);
    video(2, keyframe ? 0x67 : 0x41);
    await new Promise((r) => setTimeout(r, 1_700));
    assert.strictEqual(videoRequests(sent) - before, keyframe ? 0 : 1, keyframe ? 'a keyframe came: no extra request' : 'no keyframe yet: asked again');
    await session.end('viewer closed');
  }
});

test("sound 'when you talk': a slow setup of the new call doesn't trip the silence watchdog afterwards", async () => {
  let audioRequests = 0;
  // the panel never sends its media request for the new call: the setup waits its full 5 s
  const { call, client, log } = setup({ options: talkOptions, script: { audio: () => ++audioRequests === 1 } });
  const session = await call.startMedia(false);
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 2 }, Buffer.from([0x67, 1])));
  await session.openSound();
  await new Promise((r) => setTimeout(r, 2_000));
  assert.strictEqual(session.isEnded, false, `still on 2 s after the switch (${log.lines.filter((l) => /ended/.test(l)).join('; ')})`);
  await session.end('viewer closed');
});

test("sound 'when you talk': closing the view during the new call's setup hangs it up, without a warning", async () => {
  let audioRequests = 0;
  const { call, sent, log } = setup({ options: talkOptions, script: { audio: () => ++audioRequests === 1 } });
  const session = await call.startMedia(false);
  const switching = session.openSound();
  await new Promise((r) => setTimeout(r, 1_500)); // the new call placed, its setup waiting
  const next = call.activeCall();
  await session.end('viewer closed');
  await switching;
  assert.ok(next && next.outbound && invites(sent).length === 2);
  assert.ok(parsed(sent).some((f) => f.conn0 === (next.conn0 ^ 0x80) && f.conn1 === next.conn1 && f.opcode === 0x0e), 'the new call is hung up');
  assert.deepStrictEqual(log.lines.filter((l) => l.startsWith('W')), [], 'no warning');
});

test("sound 'when you talk': while someone rings, the microphone doesn't call the panel again", async () => {
  const { call, sent, log } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  await call.onFrame(ringFrame(call), ['SB100001']);
  await session.openSound();
  assert.strictEqual(invites(sent).length, 1, 'no new call');
  assert.strictEqual(session.isEnded, false);
  assert.ok(log.lines.some((l) => /someone is ringing/.test(l)));
  await session.end('viewer closed');
});

test("sound 'when you talk': the intercom counts as busy during the switch (no planned reconnect)", async () => {
  const { call } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  const switching = session.openSound();
  await new Promise((r) => setTimeout(r, 100)); // the old call hung up, the new one not placed yet
  assert.strictEqual(call.busy(), true);
  await switching;
  assert.strictEqual(call.busy(), true);
  await session.end('viewer closed');
});

test("sound 'when you talk': while someone rings, 'someone is ringing' is logged once per ring", async () => {
  const { call, log } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  await call.onFrame(ringFrame(call), ['SB100001']);
  await session.openSound();
  await session.openSound();
  assert.strictEqual(log.lines.filter((l) => /someone is ringing/.test(l)).length, 1);
  await session.end('viewer closed');
});

test("the lock during a live view, again and again, doesn't pile up listeners", async () => {
  const { call } = setup();
  const session = await call.startMedia(false);
  const start = session.listenerCount('end');
  for (let i = 0; i < 4; i++) {
    await call.openWithLiveViewPaused(async () => ({ confirmed: true }));
  }
  assert.strictEqual(session.listenerCount('end'), start);
  assert.strictEqual(session.isEnded, false);
  await session.end('viewer closed');
});

test('the lock during a live view without a ring: the view\'s call hangs up, the door opens, the view calls the panel again', async () => {
  const { call, sent, log } = setup();
  const session = await call.startMedia(false);
  const first = call.activeCall();
  const events = [];
  const result = await call.openWithLiveViewPaused(async () => {
    events.push(['open', first.ended, invites(sent).length]);
    return { confirmed: true };
  });
  assert.deepStrictEqual(result, { confirmed: true });
  assert.deepStrictEqual(events, [['open', true, 1]], 'opened after the hang-up, before calling again');
  assert.strictEqual(invites(sent).length, 2, 'called again');
  assert.ok(!parsed(sent).some((f) => f.opcode === 0x002d), 'nothing opened inside a call');
  assert.strictEqual(session.isEnded, false, 'the view goes on');
  assert.ok(call.activeCall() && !call.activeCall().ended && call.activeCall() !== first);
  assert.ok(log.lines.some((l) => /opening the door: the live view's call pauses/.test(l)));
  await session.end('viewer closed');
  assert.strictEqual(await call.openWithLiveViewPaused(async () => ({ confirmed: true })), null, 'no live view: null (open the normal way)');
});

test('the lock during a live view without a ring: a failed open is reported, and the view still comes back', async () => {
  const { call, sent } = setup();
  const session = await call.startMedia(false);
  await assert.rejects(call.openWithLiveViewPaused(async () => { throw new Error('intercom refused (cause 3)'); }), /cause 3/);
  assert.strictEqual(invites(sent).length, 2);
  assert.strictEqual(session.isEnded, false);
  await session.end('viewer closed');
});

test('the door: a ring is opened inside the ring, otherwise the normal way; a busy refusal is retried once only when asked', async () => {
  const { openDoor } = require('../dist/door');
  const config = { aptAddress: 'SB000002', aptSubaddress: '3' };
  const door = { name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false };
  const order = [];
  const client = { getChannel: () => ({}), sendBinary: async () => { order.push('send'); }, removeChannel() {} };
  const listener = (causes) => ({ waitForRelease: () => ({ result: Promise.resolve(causes.shift()), cancel() {} }) });
  const ctx = (ring, causes = [0], retryBusy = false) => ({
    listener: listener(causes),
    retryBusy,
    call: { openInCall: async () => (order.push('ring'), ring ? { confirmed: true } : null) },
  });
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(true)), { confirmed: true });
  assert.deepStrictEqual(order, ['ring'], 'a ring: inside it');
  order.length = 0;
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(false)), { confirmed: true });
  assert.deepStrictEqual(order, ['ring', 'send'], 'no ring: the normal way');
  order.length = 0;
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(false, [8, 0], true)), { confirmed: true });
  assert.deepStrictEqual(order, ['ring', 'send', 'send'], 'still busy just after the pause: once more');
  order.length = 0;
  await assert.rejects(openDoor(client, config, door, ctx(false, [8, 8], true)), /cause 8/, 'busy twice: refused');
  await assert.rejects(openDoor(client, config, door, ctx(false, [8])), /cause 8/, 'without retryBusy: not retried');
});

test('the lock during a live view: the microphone turned on during the pause gets sound after it', async () => {
  const { call, sent } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  let release;
  const opening = call.openWithLiveViewPaused(() => new Promise((r) => (release = r)));
  await new Promise((r) => setTimeout(r, 700)); // the pause: hung up, the open running
  const sound = session.openSound();
  release({ confirmed: true });
  await opening;
  await sound;
  assert.strictEqual(invites(sent).length, 3, 'placed again silent, then with sound');
  assert.ok(parsed(sent).some((f) => f.opcode === 0x70 && f.body[f.body.length - 2] === 1), 'voice status 1 sent');
  await session.end('viewer closed');
});

test('the lock during a live view: a ring during the pause ends the view instead of calling the panel', async () => {
  const { call, sent, log } = setup();
  const session = await call.startMedia(false);
  const result = await call.openWithLiveViewPaused(async () => {
    await call.onFrame(ringFrame(call), ['SB100001']); // someone rings meanwhile
    return { confirmed: true };
  });
  assert.deepStrictEqual(result, { confirmed: true });
  assert.strictEqual(invites(sent).length, 1, 'not called again');
  assert.strictEqual(session.isEnded, true);
  assert.ok(log.lines.some((l) => /someone rang while the door was opening/.test(l)));
});

test('the lock during a live view: the viewer closing during the pause still opens, and leaves no call', async () => {
  const { call, sent } = setup();
  const session = await call.startMedia(false);
  const result = await call.openWithLiveViewPaused(async () => {
    await session.end('viewer closed');
    return { confirmed: true };
  });
  assert.deepStrictEqual(result, { confirmed: true });
  assert.strictEqual(invites(sent).length, 1);
  assert.strictEqual(call.activeCall(), undefined);
});

test('an actuator during a ring gets its own command, never the entrance open inside the call', async () => {
  const { openDoor } = require('../dist/door');
  const config = { aptAddress: 'SB000002', aptSubaddress: '3' };
  const actuator = { name: 'Actuator', aptAddress: 'SB100001', outputIndex: 1, isActuator: true, moduleIndex: 0 };
  const entrance = { name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false };
  const order = [];
  const client = {
    getChannel: () => ({}),
    sendBinary: async () => { order.push('send'); },
    readResponse: async () => Buffer.alloc(0),
    removeChannel() {},
  };
  const ctx = { call: { openInCall: async () => (order.push('ring'), { confirmed: true }) } };
  assert.deepStrictEqual(await openDoor(client, config, actuator, ctx), { confirmed: false });
  assert.ok(!order.includes('ring'), 'not opened inside the ring');
  assert.ok(order.filter((o) => o === 'send').length >= 2, "the actuator's own command");
  order.length = 0;
  assert.deepStrictEqual(await openDoor(client, config, entrance, ctx), { confirmed: true });
  assert.deepStrictEqual(order, ['ring'], 'the entrance still opens inside the ring');
});

const sps = (client, seq = 1, pt = 96) => client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: pt, sequence: seq, timestamp: seq, ssrc: 2 }, Buffer.from([0x67, 1])));

test('unlocking: a live view without a ring counts once a viewer gets its live picture, and records its last picture', async () => {
  const { call, client } = setup();
  const session = await call.startMedia(false);
  sps(client);
  assert.strictEqual(call.liveViewShowing(), false, 'video, but no viewer was given it (they got the still picture)');
  session.markWatched();
  assert.strictEqual(call.liveViewShowing(), true);
  assert.strictEqual(call.liveViewEndedAt, 0);
  const before = Date.now();
  await session.end('viewer closed');
  assert.strictEqual(call.liveViewShowing(), false);
  assert.ok(call.liveViewEndedAt >= before - 50, 'the window counts from the last picture');
});

test('unlocking: a view that never got a keyframe, or whose video stopped, does not count', async () => {
  const { call, client } = setup();
  const session = await call.startMedia(false);
  session.markWatched();
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 13, sequence: 1, timestamp: 1, ssrc: 2 }, Buffer.from([0x41, 1])));
  assert.strictEqual(call.liveViewShowing(), false, 'a packet, but no picture');
  sps(client, 2);
  assert.strictEqual(call.liveViewShowing(), true);
  session.lastVideoAt = Date.now() - 11_000; // the picture froze 11 s ago (sound may still come)
  assert.strictEqual(call.liveViewShowing(), false);
  await session.end('viewer closed');
  const none = setup();
  const s2 = await none.call.startMedia(false);
  await s2.end('no media from the intercom');
  assert.strictEqual(none.call.liveViewEndedAt, 0, 'no picture: no window');
});

test('unlocking: an answered ring view does not count as a live view without a ring', async () => {
  const { call, client } = setup();
  await call.onFrame(ringFrame(call), ['SB100001']);
  const session = await call.startMedia(false);
  assert.ok(session && !call.activeCall().outbound, 'the ring was answered');
  session.markWatched();
  sps(client);
  assert.strictEqual(call.liveViewShowing(), false);
  await session.end('viewer closed');
  assert.strictEqual(call.liveViewEndedAt, 0);
});

test('unlocking: the lock pause keeps the live view counting', async () => {
  const { call, client } = setup();
  const session = await call.startMedia(false);
  session.markWatched();
  sps(client);
  let during;
  await call.openWithLiveViewPaused(async () => { during = call.liveViewShowing(); return { confirmed: true }; });
  assert.strictEqual(during, true);
  assert.strictEqual(call.liveViewEndedAt, 0, 'the pause is not the end of the view');
  await session.end('viewer closed');
});

test('a ring while the live view calls the panel again ends the view instead of calling during the ring', async () => {
  const { call, sent, log } = setup({ options: talkOptions });
  const session = await call.startMedia(false);
  const switching = session.openSound(); // hangs up, waits 0.5 s, then calls again
  await new Promise((r) => setTimeout(r, 100));
  await call.onFrame(ringFrame(call), ['SB100001']);
  await switching;
  assert.strictEqual(invites(sent).length, 1, 'not called again');
  assert.strictEqual(session.isEnded, true);
  assert.ok(log.lines.some((l) => /someone rang while the live view was calling the panel again/.test(l)));
});

test('a ring on the live view\'s own connection id (about once in 65,536 rings) ends the view and comes through as a ring', async () => {
  const { call, sent, log } = setup({ options: { liveViewWithoutRing: true, liveViewSound: 'always', panelAddress: 'SB100001' } });
  const session = await call.startMedia(false);
  const own = call.activeCall();
  const ring = parseFrame(frames.invite);
  ring.conn0 = own.conn0; // the panel picked the id our call uses
  ring.conn1 = own.conn1;
  const before = sent.length;
  await call.onFrame(ring, ['SB100001']);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(session.isEnded, true, 'the live view ends');
  const ringing = call.ringingCall();
  assert.ok(ringing && !ringing.outbound, 'the ring is taken as a ring');
  const after = parsed(sent.slice(before));
  assert.ok(!after.some((f) => f.flags === 0x60 || f.opcode === 0x000e), 'no hang-up sent on the id, now the ring\'s');
  assert.ok(!after.some((f) => f.opcode === 0x0070), 'no voice status (the sound was open)');
  assert.ok(!after.some((f) => f.opcode === 0x0011 && f.body[2] === 0x98), 'no audio stop');
  assert.ok(log.lines.some((l) => /a ring came in on the live view's connection/.test(l)));
});
