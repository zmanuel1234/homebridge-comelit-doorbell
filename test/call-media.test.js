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
  c.closeHandle = async (_name, h) => { c.closed.push(h); c.handlers.delete(h); };
  c.setBinaryHandler = (h, fn) => (fn ? c.handlers.set(h, fn) : c.handlers.delete(h));
  c.sendOnHandle = async (h, data) => c.media.push([h, data]);
  return c;
}

function setup(mode) {
  const sent = [];
  let call;
  call = new CallHandler(mode, 'SB0000023', 'SB000002', async (f) => {
    sent.push(f);
    // Simulate the intercom: answer the audio request with its own, naming channel 0x3001.
    const fr = parseFrame(f);
    if (fr.opcode === 0x0011 && fr.body[2] === 0x18) {
      setImmediate(() => call.onFrame({ flags: 0x40, conn0: 0x36, conn1: 0x96, seq: 0xb6, ack: 0xd9, body: Buffer.from('00111802000000000130', 'hex'), opcode: 0x0011 }, ['SB000002']));
    }
  }, quietLog());
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

test('answer-on-view: unlocking without viewing opens the normal way', async () => {
  const { call } = setup('answer-on-view');
  await ring(call);
  assert.strictEqual(await call.openInCall({ aptAddress: 'SB100001', outputIndex: 1 }), null);
});

test('other modes never start media', async () => {
  for (const mode of ['off', 'handshake', 'answer-on-open']) {
    const { call } = setup(mode);
    await ring(call);
    assert.strictEqual(await call.startMedia(false), null, mode);
  }
});
