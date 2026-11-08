const test = require('node:test');
const assert = require('node:assert');
const { IconaBridgeClient } = require('../dist/client');
const { AsyncQueue, createChannel } = require('../dist/channels');
const { ctppInitSequence } = require('../dist/ctpp');
const { frames, quietLog } = require('./helpers');

test('a ring arriving during the CTPP registration is kept for the listener', async () => {
  const queue = new AsyncQueue();
  const answer = Buffer.from('60180000000000000000', 'hex');
  for (const b of [answer, frames.invite, answer]) {
    queue.enqueue(b);
  }
  const channel = { name: 'CTPP', isOpen: true, serverChannelId: 1, responseQueue: queue };
  const client = { sendBinary: async () => undefined, readResponse: (ch, ms) => ch.responseQueue.dequeue(ms) };
  await ctppInitSequence(client, channel, 'SB000002', 3, 'SB0000023', 0, 50);
  assert.deepStrictEqual(await queue.dequeue(10), frames.invite);
  assert.strictEqual(await queue.dequeue(10), null);
});

test('a channel whose open fails is forgotten, so the next open gets the right answer', async () => {
  const client = new IconaBridgeClient('127.0.0.1', 1, quietLog());
  await assert.rejects(client.openChannel('UCFG', 2), /Not connected/);
  assert.strictEqual(client.channels.has('UCFG'), false);
});

test('a JSON request whose send fails rejects once, with no stray rejection later', async () => {
  const client = new IconaBridgeClient('127.0.0.1', 1, quietLog());
  client.socket = { write: (_b, cb) => cb(new Error('EPIPE')), destroy() {} };
  const ch = createChannel('INFO', 20, 1);
  ch.isOpen = true;
  ch.serverChannelId = 0x1234;
  let stray = 0;
  const onStray = () => stray++;
  process.on('unhandledRejection', onStray);
  await assert.rejects(client.sendJson(ch, { message: 'server-info' }), /Send failed/);
  assert.strictEqual(client.pendingCallbacks.size, 0);
  await new Promise((r) => setImmediate(r));
  process.off('unhandledRejection', onStray);
  assert.strictEqual(stray, 0);
  client.disconnect();
});

test('a frame whose handler throws is logged and skipped, and the next frame still arrives', () => {
  const { encodeHeader } = require('../dist/protocol');
  const log = quietLog();
  const client = new IconaBridgeClient('127.0.0.1', 1, log);
  const got = [];
  client.setBinaryHandler(0x2001, () => { throw new Error('boom'); });
  client.setBinaryHandler(0x2002, (b) => got.push(b));
  const frame = (h, b) => Buffer.concat([encodeHeader(b.length, h), b]);
  assert.doesNotThrow(() => client.onData(Buffer.concat([frame(0x2001, Buffer.from([1])), frame(0x2002, Buffer.from([2]))])));
  assert.deepStrictEqual(got, [Buffer.from([2])]);
  assert.ok(log.lines.some((l) => /could not be handled: boom/.test(l)));
  client.disconnect();
});

test('a channel the intercom closes is forgotten; closing CTPP is reported', () => {
  const { encodeHeader } = require('../dist/protocol');
  const client = new IconaBridgeClient('127.0.0.1', 1, quietLog());
  const written = [];
  client.socket = { write: (b) => written.push(b), destroy() {} };
  const ch = createChannel('CTPP', 7, 1);
  ch.isOpen = true;
  ch.serverChannelId = 0x0043;
  client.channels.set('CTPP', ch);
  const closed = [];
  client.on('channelClosed', (n) => closed.push(n));
  // END (ef01), sub-type 2, handle 0x0043
  const body = Buffer.from('ef01030002000000' + '4300', 'hex');
  client.onData(Buffer.concat([encodeHeader(body.length, 0), body]));
  assert.deepStrictEqual(closed, ['CTPP']);
  assert.strictEqual(client.getChannel('CTPP'), undefined);
  assert.strictEqual(written.length, 1, 'close acknowledged');
  client.disconnect();
});
