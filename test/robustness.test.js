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
