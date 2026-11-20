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
    } else if (f.opcode === 0x0070) {
      script.voice?.(f, reply);
    }
  }, log, { startTimeoutMs: 10_000, silenceMs: 5_000, videoRefreshMs: 60_000 }, options);
  const client = fakeClient();
  call.attach(client);
  return { call, client, sent, log };
}

const parsed = (sent) => sent.map((f) => parseFrame(f));
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
  await call.onFrame(parseFrame(frames.invite), ['SB100001']);
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
  await call.onFrame(parseFrame(frames.invite), ['SB100001']);
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
  await call.onFrame(parseFrame(frames.invite), ['SB100001']);
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

// The panel's sound in tests: real-sounding levels, as A-law (G.711 encoder, for the test only).
function linearToAlaw(x) {
  let sign = 0x80;
  if (x < 0) { sign = 0; x = -x - 1; }
  x = Math.min(x, 32635);
  let exp = 7;
  for (let m = 0x4000; (x & m) === 0 && exp > 0; m >>= 1) exp--;
  const mant = exp === 0 ? (x >> 4) & 0x0f : (x >> (exp + 3)) & 0x0f;
  return (sign | (exp << 4) | mant) ^ 0x55;
}
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
/** 20 ms of noise at about `dbfs` (street noise through the panel: about -45 dBFS; a passing car: -25). */
const noise = (dbfs) => Buffer.from(Array.from({ length: 160 }, () => linearToAlaw(Math.round(gauss() * 32768 * 10 ** (dbfs / 20)))));
const SILENCE = Buffer.alloc(160, 0xd5);
const voiceOffs = (sent) => parsed(sent).filter((f) => f.opcode === 0x70 && f.body[f.body.length - 2] === 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, ms, what) => {
  for (const end = Date.now() + ms; !cond(); ) {
    assert.ok(Date.now() < end, `timed out waiting: ${what}`);
    await wait(50);
  }
};

/**
 * A 'when you talk' view switched to sound, with the panel sending `panel(msSinceVoiceOff)` every
 * 20 ms (null: nothing), and the microphone sending while `mic()` is true.
 */
async function talkView({ panel, mic = () => false, script = {} }) {
  const t = setup({ options: talkOptions, script });
  const session = await t.call.startMedia(false);
  await session.openSound();
  let seq = 1;
  let offAt = 0;
  const timer = setInterval(() => {
    if (!offAt && voiceOffs(t.sent).length) offAt = Date.now();
    const payload = panel(offAt ? Date.now() - offAt : -1);
    if (payload) t.client.handlers.get(0x2002)?.(buildRtp({ marker: false, payloadType: 8, sequence: seq++, timestamp: seq * 160, ssrc: 3 }, payload));
    if (mic()) void session.sendAudio(SILENCE);
  }, 20);
  t.session = session;
  t.stop = async () => { clearInterval(timer); await session.end('viewer closed'); };
  return t;
}
const verdictLine = (log) => log.lines.find((l) => /closed the sound|kept the sound open|can't tell/.test(l));

test("sound 'when you talk': the microphone off asks the panel to close the sound; a silent panel means closed; the microphone on again calls it again", async () => {
  let micOn = true;
  const t = await talkView({ panel: (since) => (since < 0 ? noise(-45) : SILENCE), mic: () => micOn });
  try {
    await wait(500);
    micOn = false;
    await until(() => voiceOffs(t.sent).length === 1, 5_000, 'voice status 0');
    assert.strictEqual(t.session.isEnded, false, 'the view goes on');
    await until(() => verdictLine(t.log), 5_000, 'the verdict');
    assert.match(verdictLine(t.log), /closed the sound/);
    assert.strictEqual(invites(t.sent).length, 2);
    micOn = true;
    await until(() => invites(t.sent).length === 3, 3_000, 'a new call with sound');
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': a panel that stops its sound 2.2 s late still counts as closed", async () => {
  let micOn = true;
  const t = await talkView({ panel: (since) => (since < 2_200 ? noise(-45) : null), mic: () => micOn });
  try {
    await wait(300);
    micOn = false;
    await until(() => verdictLine(t.log), 9_000, 'the verdict');
    assert.match(verdictLine(t.log), /closed the sound/);
    assert.strictEqual(t.call.soundOffOpenVerdicts, 0);
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': a car passing just before doesn't make an ignored request look closed", async () => {
  let micOn = true;
  let micOffAt = 0;
  // street noise throughout (the panel ignores the request), and a car for 0.8 s in the street sample taken before asking
  const car = (t) => voiceOffs(t.sent).length === 0 && micOffAt && Date.now() - micOffAt > 2_200 && Date.now() - micOffAt < 3_000;
  let t;
  t = await talkView({ panel: () => (t && car(t) ? noise(-25) : noise(-45)), mic: () => micOn });
  try {
    await wait(300);
    micOn = false;
    micOffAt = Date.now();
    await until(() => verdictLine(t.log), 9_000, 'the verdict');
    assert.match(verdictLine(t.log), /kept the sound open/);
    assert.strictEqual(t.call.soundOffIgnored, false, 'one verdict is not enough to stop asking');
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': a quiet street can't tell, and says the microphone may be open", async () => {
  let micOn = true;
  const t = await talkView({ panel: () => noise(-70), mic: () => micOn });
  try {
    await wait(300);
    micOn = false;
    await until(() => verdictLine(t.log), 9_000, 'the verdict');
    assert.match(verdictLine(t.log), /can't tell.*may still be open/);
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': two 'kept open' verdicts stop the asking, with a warning", async () => {
  let micOn = true;
  const t = await talkView({ panel: () => noise(-45), mic: () => micOn });
  try {
    for (const n of [1, 2]) {
      micOn = true;
      await wait(300);
      micOn = false;
      await until(() => t.call.soundOffOpenVerdicts === n, 9_000, `verdict ${n}`);
    }
    assert.strictEqual(t.call.soundOffIgnored, true);
    assert.ok(t.log.lines.some((l) => l.startsWith('W') && /ignore the request/.test(l)));
    micOn = true;
    await wait(300);
    micOn = false;
    await wait(4_500);
    assert.strictEqual(voiceOffs(t.sent).length, 2, 'not asked a third time');
    assert.strictEqual(invites(t.sent).length, 2, 'no new calls: the sound stayed open');
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': if the panel's sound stops while the microphone is on, it calls again with sound", async () => {
  let stopped = false;
  const t = await talkView({ panel: () => (stopped ? null : noise(-45)), mic: () => true });
  try {
    await wait(500);
    stopped = true;
    await until(() => invites(t.sent).length === 3, 6_000, 'a new call with sound');
    assert.ok(t.log.lines.some((l) => /stopped its sound while the microphone is on/.test(l)));
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': the microphone back during the check calls again, with no verdict on the old call", async () => {
  let micOn = true;
  const t = await talkView({ panel: () => noise(-45), mic: () => micOn });
  try {
    await wait(300);
    micOn = false;
    await until(() => voiceOffs(t.sent).length === 1, 5_000, 'voice status 0');
    await wait(500);
    micOn = true;
    await until(() => invites(t.sent).length === 3, 3_000, 'a new call with sound');
    await wait(3_000);
    assert.strictEqual(verdictLine(t.log), undefined, 'no verdict');
    assert.strictEqual(t.call.soundOffOpenVerdicts, 0);
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': closing and opening the sound doesn't pile up listeners", async () => {
  let micOn = true;
  const t = await talkView({ panel: (since) => (since < 0 ? noise(-45) : SILENCE), mic: () => micOn });
  try {
    const start = t.session.listenerCount('end');
    for (let i = 0; i < 2; i++) {
      micOn = true;
      await wait(300);
      micOn = false;
      await until(() => voiceOffs(t.sent).length === i + 1, 6_000, 'voice status 0');
      await until(() => verdictLine(t.log) && t.log.lines.filter((l) => /closed the sound/.test(l)).length === i + 1, 6_000, 'the verdict');
      micOn = true;
      await until(() => invites(t.sent).length === 3 + i, 4_000, 'a new call');
    }
    assert.strictEqual(t.session.listenerCount('end'), start);
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': while someone rings, the microphone after a close doesn't flood the log", async () => {
  let micOn = true;
  const t = await talkView({ panel: (since) => (since < 0 ? noise(-45) : SILENCE), mic: () => micOn });
  try {
    await wait(300);
    micOn = false;
    await until(() => verdictLine(t.log), 9_000, 'the verdict');
    await t.call.onFrame(parseFrame(frames.invite), ['SB100001']);
    micOn = true;
    await wait(1_000);
    assert.strictEqual(t.log.lines.filter((l) => /someone is ringing/.test(l)).length, 1);
    assert.strictEqual(invites(t.sent).length, 2, 'no new call');
  } finally {
    await t.stop();
  }
});

test("sound 'always': the microphone turned off doesn't close the sound", async () => {
  const { call, sent } = setup({ options: { liveViewWithoutRing: true, liveViewSound: 'always', panelAddress: 'SB100001' } });
  const session = await call.startMedia(false);
  await session.sendAudio(SILENCE);
  await wait(4_500);
  assert.strictEqual(voiceOffs(sent).length, 0);
  await session.end('viewer closed');
});

test('judging whether the panel closed the sound, from the street noise', () => {
  const { judgeSoundOff, soundLevelOf } = require('../dist/call');
  const { alawLevel, alawToLinear } = require('../dist/media');
  assert.deepStrictEqual([0xd5, 0x55, 0x80, 0xaa, 0x2a].map(alawToLinear), [8, -8, 5504, 32256, -32256]);
  assert.strictEqual(alawLevel(SILENCE), 8, 'A-law digital silence');
  const street = alawLevel(noise(-45));
  assert.ok(street > 100 && street < 220, `street noise at -45 dBFS: ${street}`);
  const floor = soundLevelOf([[0, 400], [1, 410], [2, 420], [3, 9000]], 0, 4).floor;
  assert.strictEqual(floor, 410, 'the noise floor ignores a loud moment');
  const street400 = { packets: 100, floor: 400 };
  assert.strictEqual(judgeSoundOff(street400, { packets: 0, floor: 0 }, 3_000), 'closed', 'the stream stopped');
  assert.strictEqual(judgeSoundOff(street400, { packets: 35, floor: 400 }, 800), 'closed', 'stopped late: none for the last 0.8 s');
  assert.strictEqual(judgeSoundOff(street400, { packets: 75, floor: 8 }, 20), 'closed', 'packets go on, but silent');
  assert.strictEqual(judgeSoundOff(street400, { packets: 75, floor: 380 }, 20), 'open', 'as loud as before');
  assert.strictEqual(judgeSoundOff(street400, { packets: 75, floor: 380 }, 300), 'open', 'a short network pause is not a stop');
  assert.strictEqual(judgeSoundOff(street400, { packets: 75, floor: 150 }, 20), 'unknown', 'in between');
  assert.strictEqual(judgeSoundOff({ packets: 100, floor: 10 }, { packets: 75, floor: 9 }, 20), 'unknown', 'a quiet street');
  assert.strictEqual(judgeSoundOff({ packets: 100, floor: 10 }, { packets: 75, floor: 300 }, 20), 'open', 'quiet before, loud after');
});

test("sound 'when you talk': if the panel hangs up after the sound is closed (as for the Comelit app), the view goes on with a silent call", async () => {
  let micOn = true;
  // voice status 0 (body ends 00 00): the panel hangs up 2 s later, as it does for the Comelit app
  const script = { voice: (f, reply) => f.body[f.body.length - 2] === 0 && setTimeout(() => reply(f, 0x40, '000e10'), 2_000) };
  const t = await talkView({ panel: () => noise(-45), mic: () => micOn, script });
  try {
    await wait(300);
    micOn = false;
    await until(() => invites(t.sent).length === 3, 9_000, 'a silent call after the panel hung up');
    assert.strictEqual(t.session.isEnded, false, 'the view goes on');
    assert.ok(t.log.lines.some((l) => /hung up .* after being asked to close the sound/.test(l)));
    await wait(500);
    const third = t.call.activeCall();
    assert.ok(third && third.outbound && !third.ended);
    const onThird = parsed(t.sent).filter((f) => f.conn0 === (third.conn0 ^ 0x80) && f.conn1 === third.conn1);
    assert.ok(!onThird.some((f) => f.opcode === 0x70), 'the new call is silent: no voice status');
    assert.strictEqual(verdictLine(t.log), undefined, 'no verdict on a hung-up call');
    // the microphone on again: sound again; off again: straight to a silent call, without asking
    micOn = true;
    await until(() => invites(t.sent).length === 4, 4_000, 'a call with sound');
    await wait(300);
    micOn = false;
    await until(() => invites(t.sent).length === 5, 9_000, 'straight to a silent call');
    assert.strictEqual(voiceOffs(t.sent).length, 1, 'not asked again: the panel would hang up');
    assert.strictEqual(t.session.isEnded, false);
  } finally {
    await t.stop();
  }
});

test("sound 'when you talk': the panel hanging up with the sound open still ends the view", async () => {
  const t = await talkView({ panel: () => noise(-45), mic: () => false });
  try {
    const current = t.call.activeCall();
    await t.call.onFrame({ flags: 0x40, conn0: current.conn0, conn1: current.conn1, seq: 0x70, ack: 0, body: Buffer.from('000e10', 'hex'), opcode: 0x000e }, ['SB100001']);
    await until(() => t.session.isEnded, 2_000, 'the view ends');
    assert.strictEqual(invites(t.sent).length, 2, 'no new call');
  } finally {
    await t.stop();
  }
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

test('the lock: a ring is opened inside the ring, a live view without a ring with the view paused, otherwise the normal way; busy once is tried again', async () => {
  const { openDoor, DoorOpenError } = require('../dist/door');
  const config = { aptAddress: 'SB000002', aptSubaddress: '3' };
  const door = { name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false };
  const order = [];
  const client = { getChannel: () => ({}), sendBinary: async () => { order.push('send'); }, removeChannel() {} };
  const listener = (causes) => ({ waitForRelease: () => ({ result: Promise.resolve(causes.shift()), cancel() {} }) });
  const ctx = (ring, view, causes = [0]) => ({
    listener: listener(causes),
    call: {
      openInCall: async () => (order.push('ring'), ring ? { confirmed: true } : null),
      openWithLiveViewPaused: async (open) => (order.push('view'), view ? open() : null),
    },
  });
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(true, true)), { confirmed: true });
  assert.deepStrictEqual(order, ['ring'], 'a ring: inside it, nothing else');
  order.length = 0;
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(false, true)), { confirmed: true });
  assert.deepStrictEqual(order, ['ring', 'view', 'send'], 'a live view: opened while it is paused');
  order.length = 0;
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(false, false)), { confirmed: true });
  assert.deepStrictEqual(order, ['ring', 'view', 'send'], 'neither: the normal way');
  order.length = 0;
  assert.deepStrictEqual(await openDoor(client, config, door, ctx(false, true, [8, 0])), { confirmed: true });
  assert.deepStrictEqual(order, ['ring', 'view', 'send', 'send'], 'still busy just after the hang-up: once more');
  order.length = 0;
  await assert.rejects(openDoor(client, config, door, ctx(false, false, [8])), /cause 8/, 'busy without a live view: not retried');
  assert.ok(DoorOpenError);
});
