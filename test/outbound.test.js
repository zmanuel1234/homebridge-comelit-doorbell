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
    if (f.flags === 0xc0 && f.opcode === 0x0001) {
      if (script.invite?.(f, reply) !== false) reply(f, 0x00, '');
    } else if (f.opcode === 0x0003) {
      if (script.capabilities?.(f, reply) !== false) {
        reply(f, 0x40, '0003500327000000');
        reply(f, 0x40, '000c');
      }
    } else if (f.opcode === 0x0011 && f.body[2] === 0x18) {
      reply(f, 0x40, '00111802000000000130');
    }
  }, quietLog(), { startTimeoutMs: 10_000, silenceMs: 5_000, videoRefreshMs: 60_000 }, options);
  const client = fakeClient();
  call.attach(client);
  return { call, client, sent };
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
