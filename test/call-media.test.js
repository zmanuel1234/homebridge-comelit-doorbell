const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { CallHandler, videoSettings } = require('../dist/call');
const { parseFrame } = require('../dist/ctp');
const { buildRtp } = require('../dist/media');
const { frames, quietLog } = require('./helpers');

// Fake connection: channels get handles 0x2001, 0x2002, ... in order of opening.
function fakeClient() {
  const c = new EventEmitter();
  let next = 0x2001;
  c.opened = [];
  c.closed = [];
  c.handlers = new Map();
  c.media = [];
  c.openChannel = async (name, _type, _extra, _trailing, wire = name) => { const h = next++; c.opened.push([name, wire, h]); return { serverChannelId: h }; };
  c.closeHandle = async (_name, h) => { c.closed.push(h); };
  c.binaryHandlerFor = (h) => c.handlers.get(h);
  c.setBinaryHandler = (h, fn) => (fn ? c.handlers.set(h, fn) : c.handlers.delete(h));
  c.sendOnHandle = async (h, data) => c.media.push([h, data]);
  return c;
}

function setup(mode, timing) {
  const sent = [];
  let call;
  call = new CallHandler(mode, 'SB0000023', 'SB000002', async (f) => {
    sent.push(f);
    // Simulate the intercom: answer the audio request with its own, naming channel 0x3001.
    const fr = parseFrame(f);
    if (fr.opcode === 0x0011 && fr.body[2] === 0x18) {
      setImmediate(() => call.onFrame({ flags: 0x40, conn0: 0x36, conn1: 0x96, seq: 0xb6, ack: 0xd9, body: Buffer.from('00111802000000000130', 'hex'), opcode: 0x0011 }, ['SB000002']));
    }
  }, quietLog(), timing);
  const client = fakeClient();
  call.attach(client);
  return { call, client, sent };
}

async function ring(call) {
  await call.onFrame(parseFrame(frames.invite), ['SB000002']);
  await call.onFrame(parseFrame(frames.capabilities), ['SB000002']);
}

const ops = (sent) => sent.map((f) => parseFrame(f)).filter((f) => f.body.length).map((f) => f.opcode.toString(16));

test('video settings block matches the layout used by the Comelit app', () => {
  // <HIHHHHBB: max payload, bitrate, max 800x480, preferred, 16 fps, 0
  assert.strictEqual(videoSettings([320, 240], 0).toString('hex'), 'ffff00000000' + '2003' + 'e001' + '4001' + 'f000' + '1000');
});

test('answer-on-view: viewing answers the ring and requests audio and video', async () => {
  const { call, client, sent } = setup('answer-on-view');
  await ring(call);
  const session = await call.startMedia(false);
  assert.ok(session);
  assert.deepStrictEqual(client.opened.map((o) => o[1]), ['UDPM', 'RTPC', 'RTPC']);
  // echo, capabilities, answer, audio request, voice status 1, audio request again, video request
  assert.deepStrictEqual(ops(sent), ['1', '3', 'c', '11', '70', '11', '11']);
  const video = parseFrame(sent.at(-1));
  assert.strictEqual(video.body.subarray(0, 8).toString('hex'), '0011143200000000');
  assert.strictEqual(video.body.readUInt16LE(8), 0x2003);
  const voice = parseFrame(sent.at(-3));
  assert.strictEqual(voice.body.subarray(2, 10).toString('latin1'), 'SB100001');
  // the intercom's video arrives on the handle after the one offered, its audio as PT 8
  const got = { video: [], audio: [] };
  session.on('video', (u) => got.video.push(u));
  session.on('audio', (a) => got.audio.push(a));
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 2 }, Buffer.from([0x65, 9])));
  client.handlers.get(0x2002)(buildRtp({ marker: false, payloadType: 8, sequence: 1, timestamp: 0, ssrc: 3 }, Buffer.alloc(160, 0xd5)));
  assert.deepStrictEqual(got.video, [Buffer.from([0, 0, 0, 1, 0x65, 9])]);
  assert.strictEqual(got.audio[0].length, 160);
  // talk-back goes to the channel the intercom named (0x3001)
  await session.sendAudio(Buffer.alloc(160));
  assert.strictEqual(client.media[0][0], 0x3001);
  assert.strictEqual(client.media[0][1][1], 0x88); // marker + PT 8
  // closing the view: voice status 0, audio stop, hang up, channels closed
  await session.end('viewer closed');
  assert.deepStrictEqual(ops(sent).slice(-3), ['70', '11', 'e']);
  assert.deepStrictEqual(client.closed.sort(), [0x2001, 0x2002, 0x2003]);
});

test('answer-on-view: unlocking during a ring without viewing answers, opens and hangs up (beta.28)', async () => {
  const { call, sent } = setup('answer-on-view');
  await ring(call);
  const result = await call.openInCall({ aptAddress: 'SB100001', outputIndex: 1 });
  assert.ok(result && result.confirmed);
  // echo, capabilities, answer, open, hang up; no media
  assert.deepStrictEqual(ops(sent), ['1', '3', 'c', '2d', 'e']);
});

test('answer-on-view: unlocking with no call opens the normal way', async () => {
  const { call } = setup('answer-on-view');
  assert.strictEqual(await call.openInCall({ aptAddress: 'SB100001', outputIndex: 1 }), null);
});

test('other modes never start media', async () => {
  for (const mode of ['off', 'handshake', 'answer-on-open']) {
    const { call } = setup(mode);
    await ring(call);
    assert.strictEqual(await call.startMedia(false), null, mode);
  }
});

test('media timing: no media within mediaStartTimeoutSeconds ends the call', async () => {
  const { call, sent } = setup('answer-on-view', { startTimeoutMs: 100, silenceMs: 100, videoRefreshMs: 60_000 });
  await ring(call);
  const session = await call.startMedia(false);
  const reason = await new Promise((r) => session.once('end', r));
  assert.strictEqual(reason, 'no media from the intercom');
  assert.strictEqual(ops(sent).at(-1), 'e'); // hung up
});

test('two viewers at once share one answer and one media setup', async () => {
  const { call, client, sent } = setup('answer-on-view');
  await ring(call);
  const [a, b] = await Promise.all([call.startMedia(false), call.startMedia(false)]);
  assert.strictEqual(a, b);
  assert.strictEqual(ops(sent).filter((o) => o === 'c').length, 1);
  assert.strictEqual(client.opened.length, 3);
  await a.end('test');
});

test('a failed media setup leaves nothing behind and keeps the call', async () => {
  const { call, client, sent } = setup('answer-on-view');
  await ring(call);
  const open = client.openChannel;
  client.openChannel = async (name, ...rest) => {
    if (name === 'RTPC-video') throw new Error('refused');
    return open(name, ...rest);
  };
  await assert.rejects(call.startMedia(false), /refused/);
  assert.ok(!ops(sent).includes('e'), 'not hung up');
  assert.deepStrictEqual(client.closed.sort(), [0x2001, 0x2002]);
  client.openChannel = open;
  const retry = await call.startMedia(false); // the next viewer tries again
  assert.ok(retry);
  await retry.end('test');
});

test('a new ring drops calls that have ended', async () => {
  const { call } = setup('handshake');
  await ring(call);
  call.activeCall().ended = true;
  const next = parseFrame(frames.invite);
  next.conn0 ^= 0x01; // another connection: a new call
  await call.onFrame(next, ['SB000002']);
  assert.strictEqual(call.calls.size, 1);
  assert.strictEqual(call.activeCall().conn0, next.conn0);
});

test('the intercom audio request that arrives before ours is used for talk-back, without waiting (6741W, 2026-11-08)', async () => {
  const sent = [];
  let call;
  call = new CallHandler('answer-on-view', 'SB0000023', 'SB000002', async (f) => {
    sent.push(f);
    // As captured: right after our answer the intercom sends its own audio request, naming
    // the RTPC channel it opened (0xb567 = 46439).
    if (parseFrame(f).opcode === 0x000c) {
      setImmediate(() => call.onFrame({ flags: 0x40, conn0: 0x36, conn1: 0x96, seq: 177, ack: 143, body: Buffer.from('001118020000000067b5', 'hex'), opcode: 0x0011 }, ['SB000002']));
    }
  }, quietLog());
  const client = fakeClient();
  call.attach(client);
  await ring(call);
  const t0 = Date.now();
  const session = await call.startMedia(false);
  // 1.5 s for the answer (the intercom sends no SETUP_ACK back), but not 3 s more for its audio request
  assert.ok(Date.now() - t0 < 2500, `media started in ${Date.now() - t0} ms`);
  await session.sendAudio(Buffer.alloc(160));
  assert.strictEqual(client.media[0][0], 0xb567);
  await session.end('done');
});

test('video without a keyframe asks for video again; the SPS is logged with its size', async () => {
  const { call, client, sent } = setup('answer-on-view');
  const log = quietLog();
  call.log = log;
  await ring(call);
  const session = await call.startMedia(false);
  session.log = log;
  const before = ops(sent).filter((o) => o === '11').length;
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 2 }, Buffer.from([0x41, 9])));
  await new Promise((r) => setTimeout(r, 1700));
  assert.strictEqual(ops(sent).filter((o) => o === '11').length, before + 1, 'one extra video request');
  const sps = Buffer.from('6742c00cd90141fb011000000300100000030200f142a480', 'hex');
  client.handlers.get(0x2004)(buildRtp({ marker: true, payloadType: 96, sequence: 2, timestamp: 0, ssrc: 2 }, sps));
  assert.ok(log.lines.some((l) => /call: video 320x240/.test(l)), log.lines.join('\n'));
  await session.sendAudio(Buffer.alloc(160));
  await session.end('done');
  assert.ok(log.lines.some((l) => /talk-back sent=1/.test(l)));
  // after the end, late packets on the media channels are dropped quietly (released after 5 s)
  assert.ok(client.handlers.size > 0);
  for (const fn of client.handlers.values()) {
    fn(Buffer.alloc(20));
  }
  assert.ok(!log.lines.some((l) => /unknown channel/.test(l)));
});

test('doctor mode: a forced open answers and opens even with answering in handshake mode', async () => {
  const { call, sent } = setup('handshake');
  await ring(call);
  const door = { name: 'Entrance', index: 0, outputIndex: 1, aptAddress: 'SB100001' };
  assert.strictEqual(await call.openInCall(door, false), null, 'not without force');
  const result = await call.openInCall(door, true);
  assert.deepStrictEqual(result, { confirmed: true });
  const o = ops(sent);
  assert.ok(o.indexOf('c') >= 0 && o.indexOf('2d') > o.indexOf('c'), `answer, then open: ${o.join(' ')}`);
  assert.ok(o.indexOf('e') > o.indexOf('2d'), 'hung up afterwards');
});

test('data from the intercom is acknowledged, including the keepalive probe of an unanswered ring', async () => {
  const sent = [];
  const call = new CallHandler('answer-on-view', 'SB0000023', 'SB000002', async (f) => { sent.push(parseFrame(f)); }, quietLog());
  await ring(call); // INVITE (seq b4) and capabilities (seq b5): answered with our echo and capabilities
  const acks = () => sent.filter((f) => f.flags === 0x00);
  assert.strictEqual(acks().length, 0, 'capabilities are acknowledged by our own capabilities');
  const ackNow = sent.at(-1).ack;
  // 20 s later: an empty data frame that doesn't consume a sequence number (seen 2026-11-08 22:07)
  const probe = { flags: 0x40, conn0: 0x36, conn1: 0x96, seq: 0xb6, ack: 0xd9, body: Buffer.alloc(0), opcode: -1 };
  await call.onFrame(probe, ['SB000002']);
  assert.strictEqual(acks().length, 1);
  assert.strictEqual(acks()[0].ack, ackNow, 'probe acknowledged without advancing');
  assert.strictEqual(acks()[0].conn0, 0x36 ^ 0x80, 'on our side of the connection');
  // it was sent again: acknowledged again
  await call.onFrame(probe, ['SB000002']);
  assert.strictEqual(acks().length, 2);
  // the intercom's media request (data with a body): acknowledged, ack advanced
  await call.onFrame({ flags: 0x40, conn0: 0x36, conn1: 0x96, seq: 0xb6, ack: 0xd9, body: Buffer.from('001118020000000067b5', 'hex'), opcode: 0x0011 }, ['SB000002']);
  assert.strictEqual(acks().length, 3);
  assert.strictEqual(acks()[2].ack, 0xb7);
  // plain acks from the intercom are not acknowledged back
  await call.onFrame({ flags: 0x00, conn0: 0x36, conn1: 0x96, seq: 0xb7, ack: 0xd9, body: Buffer.alloc(0), opcode: -1 }, ['SB000002']);
  assert.strictEqual(acks().length, 3);
});

const release = (call) => call.onFrame({ flags: 0x40, conn0: 0x36, conn1: 0x96, seq: 0xc0, ack: 0xd9, body: Buffer.from('000e0000', 'hex'), opcode: 0x000e }, ['SB000002']);

test('a call the intercom ends while its media is being set up is not kept (beta.26)', async () => {
  const { call, client } = setup('answer-on-view');
  await ring(call);
  const open = client.openChannel;
  client.openChannel = async (name, ...rest) => {
    const r = await open(name, ...rest);
    if (name === 'RTPC-video') await release(call);
    return r;
  };
  const session = await call.startMedia(false).catch(() => null);
  assert.strictEqual(session, null);
  assert.strictEqual(call.busy(), false);
  assert.deepStrictEqual(client.closed.sort(), client.opened.map((o) => o[2]).sort(), 'all channels closed');
});

test('an open without a viewer does not hang up if a live view starts meanwhile (beta.26)', async () => {
  const { call, sent } = setup('answer-on-view');
  await ring(call);
  const door = { name: 'Entrance', index: 0, outputIndex: 1, aptAddress: 'SB100001' };
  const opening = call.openInCall(door, true);
  // answering takes 1.5 s, the open waits 4 s for a reply, then 1.5 s before hanging up: view in that pause
  await new Promise((r) => setTimeout(r, 6000));
  const session = await call.startMedia(false);
  assert.ok(session);
  await opening;
  assert.ok(!ops(sent).includes('e'), `not hung up: ${ops(sent).join(' ')}`);
  await session.end('test');
});

test('a live view that fails to start in the pause after an open still lets the call be hung up (beta.26)', async () => {
  const { call, client, sent } = setup('answer-on-view');
  await ring(call);
  client.openChannel = async () => { throw new Error('refused'); };
  const door = { name: 'Entrance', index: 0, outputIndex: 1, aptAddress: 'SB100001' };
  const opening = call.openInCall(door, true);
  await new Promise((r) => setTimeout(r, 6000));
  await assert.rejects(call.startMedia(false), /refused/);
  await opening;
  assert.strictEqual(ops(sent).at(-1), 'e', `hung up: ${ops(sent).join(' ')}`);
});

const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('ring preview: asks for video during the ring without answering, takes the keyframe, then closes its channels (test build)', async () => {
  const { call, client, sent } = setup('answer-on-view');
  const units = [];
  call.enablePreview({ hd: false, onVideo: (c, u) => units.push(u) });
  await ring(call);
  await until(() => ops(sent).length >= 3);
  // echo, capabilities, then the video request; no answer (0c), no audio
  assert.deepStrictEqual(ops(sent), ['1', '3', '11']);
  assert.strictEqual(parseFrame(sent[2]).body.subarray(0, 8).toString('hex'), '0011143200000000');
  assert.deepStrictEqual(client.opened.map((o) => o[1]), ['UDPM', 'RTPC']);
  assert.strictEqual(call.busy(), true, 'a planned reconnect waits for the preview');
  client.handlers.get(0x2003)(buildRtp({ marker: true, payloadType: 96, sequence: 1, timestamp: 0, ssrc: 2 }, Buffer.from([0x67, 1])));
  client.handlers.get(0x2003)(buildRtp({ marker: true, payloadType: 96, sequence: 2, timestamp: 0, ssrc: 2 }, Buffer.concat([Buffer.from([0x65]), Buffer.alloc(2100, 9)])));
  client.handlers.get(0x2003)(buildRtp({ marker: true, payloadType: 96, sequence: 3, timestamp: 1, ssrc: 2 }, Buffer.from([0x41, 1])));
  assert.strictEqual(units.length, 3);
  await until(() => client.closed.length === 2);
  assert.deepStrictEqual(client.closed.sort(), [0x2001, 0x2002]);
  assert.strictEqual(call.busy(), false);
  assert.ok(!ops(sent).includes('e'), 'never hangs up');
});

test('ring preview: answering stops it first; the live view opens its own channels (test build)', async () => {
  const { call, client, sent } = setup('answer-on-view');
  call.enablePreview({ hd: false, onVideo: () => undefined });
  await ring(call);
  await until(() => ops(sent).length >= 3);
  const session = await call.startMedia(false);
  assert.ok(session);
  assert.deepStrictEqual(client.closed.sort(), [0x2001, 0x2002], 'the preview channels closed before answering');
  assert.deepStrictEqual(ops(sent).slice(2, 4), ['11', 'c']);
  await session.end('test');
});

test('ring preview: the intercom ending the call stops it, without hanging up (test build)', async () => {
  const { call, client, sent } = setup('answer-on-view');
  call.enablePreview({ hd: false, onVideo: () => undefined });
  await ring(call);
  await until(() => ops(sent).length >= 3);
  await release(call);
  await until(() => client.closed.length === 2);
  assert.deepStrictEqual(client.closed.sort(), [0x2001, 0x2002]);
  assert.ok(!ops(sent).includes('e'));
});

test('ring preview off: nothing is asked during the ring', async () => {
  const { call, client, sent } = setup('answer-on-view');
  await ring(call);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(ops(sent), ['1', '3']);
  assert.deepStrictEqual(client.opened, []);
});

test('an open whose call ends while answering opens the normal way (beta.29)', async () => {
  const { call, sent } = setup('answer-on-view');
  await ring(call);
  const opening = call.openInCall({ aptAddress: 'SB100001', outputIndex: 1 });
  await until(() => ops(sent).includes('c'));
  await release(call);
  assert.strictEqual(await opening, null);
  assert.ok(!ops(sent).includes('2d'), 'no open sent into the ended call');
});

test('previewOn: only with calls followed and the preview set', () => {
  const a = setup('off').call;
  a.enablePreview({ hd: false, onVideo: () => undefined });
  assert.strictEqual(a.previewOn, false);
  const b = setup('answer-on-view').call;
  assert.strictEqual(b.previewOn, false);
  b.enablePreview({ hd: false, onVideo: () => undefined });
  assert.strictEqual(b.previewOn, true);
});

test('ring preview: an empty (black) first keyframe is skipped, the next real one stops the preview (2.1.1)', async () => {
  const { call, client } = setup('answer-on-view');
  let empty = 0;
  call.enablePreview({ hd: false, onVideo: () => undefined, onEmptyKeyframe: () => empty++ });
  await ring(call);
  await until(() => client.handlers.get(0x2003));
  const send = (seq, payload) => client.handlers.get(0x2003)(buildRtp({ marker: true, payloadType: 96, sequence: seq, timestamp: seq, ssrc: 2 }, payload));
  send(1, Buffer.from([0x67, 1]));
  send(2, Buffer.concat([Buffer.from([0x65]), Buffer.alloc(1000)])); // black: about 1 KB
  send(3, Buffer.from([0x41, 1]));
  await new Promise((r) => setTimeout(r, 700));
  assert.strictEqual(empty, 1);
  assert.deepStrictEqual(client.closed, [], 'still waiting for a real picture');
  send(4, Buffer.concat([Buffer.from([0x65]), Buffer.alloc(3000, 7)]));
  send(5, Buffer.from([0x41, 2]));
  await until(() => client.closed.length === 2);
  assert.strictEqual(client.closed.length, 2, 'stopped after the real picture');
});

test('recording: the preview keeps running after the picture while a ring is recorded, and the listener hears the video and the end (2.3.0)', async () => {
  const { call, client } = setup('handshake');
  const heard = [];
  call.setCallListener({ video: (c, u) => heard.push(['video', u.length]), ended: () => heard.push(['ended']) });
  call.enablePreview({ hd: false, onVideo: () => undefined, keepRunning: () => true });
  await ring(call);
  await until(() => client.handlers.get(0x2003));
  const send = (seq, payload) => client.handlers.get(0x2003)(buildRtp({ marker: true, payloadType: 96, sequence: seq, timestamp: seq, ssrc: 2 }, payload));
  send(1, Buffer.from([0x67, 1]));
  send(2, Buffer.concat([Buffer.from([0x65]), Buffer.alloc(3000, 7)]));
  send(3, Buffer.from([0x41, 1]));
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepStrictEqual(client.closed, [], 'still receiving video for the recording');
  send(4, Buffer.from([0x41, 2]));
  assert.strictEqual(heard.filter((h) => h[0] === 'video').length, 4);
  await release(call);
  await until(() => client.closed.length === 2);
  assert.deepStrictEqual(heard.at(-1), ['ended']);
});
