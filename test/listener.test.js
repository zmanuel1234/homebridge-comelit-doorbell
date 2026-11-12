const test = require('node:test');
const assert = require('node:assert');
const { VipEventListener } = require('../dist/vipListener');
const { CallHandler } = require('../dist/call');
const { openDoor } = require('../dist/door');
const { hex, frames, fakeClient, quietLog } = require('./helpers');

const config = { aptAddress: 'SB000002', aptSubaddress: 3, doors: [], cameras: [] };
const door = { name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false, index: 0 };

function setup(answerMode = 'off') {
  const client = fakeClient();
  const log = quietLog();
  const events = [];
  let listener;
  const call = new CallHandler(answerMode, 'SB0000023', 'SB000002', (f) => listener.sendFrame(f), log);
  listener = new VipEventListener(client, config, (e) => events.push(e.eventType), log, call);
  listener.channel = client.channel;
  listener.running = true;
  return { client, log, events, listener, call };
}

test('an INVITE is a ring, and is acknowledged', async () => {
  const { client, events, listener } = setup();
  await listener.processMessage(frames.invite);
  assert.deepStrictEqual(events, ['doorbell_ring']);
  assert.strictEqual(client.sent[0].subarray(0, 6).toString('hex'), '0018b696d7b5');
});

test('a new connection that is not an INVITE is not a ring', async () => {
  const { events, listener } = setup();
  await listener.processMessage(hex('c018 1111 2233 0008 0003 5003 3b00 0000 ffff ffff 5342 3130 3030 3031 0000 5342 3030 3030 3032 3300'));
  assert.deepStrictEqual(events, []);
});

test('a release is not reported as door_opened', async () => {
  const { events, listener } = setup();
  await listener.processMessage(frames.busyRelease);
  assert.deepStrictEqual(events, []);
});

async function openWithReply(listener, client, cause) {
  const p = openDoor(client, config, door, { listener });
  await new Promise((r) => setImmediate(r));
  const req = client.sent.at(-1);
  assert.strictEqual(req[0], 0xc0);
  assert.strictEqual(req.readUInt16BE(8), 0x002d);
  if (cause !== null) {
    await listener.processMessage(Buffer.concat([Buffer.from([0x60, 0x18, req[2] ^ 0x80, req[3], 0x90, 0xf2, 0x00, 0x03, 0x00, 0x0e, cause, 0x00]), hex('ffffffff')]));
  }
  return p;
}

test('the intercom confirming the open (cause 0)', async () => {
  const { client, listener } = setup();
  assert.deepStrictEqual(await openWithReply(listener, client, 0), { confirmed: true });
});

test('the intercom refusing the open as busy (cause 8)', async () => {
  const { client, listener } = setup();
  await assert.rejects(openWithReply(listener, client, 8), /cause 8, busy/);
});

test('without a listener the open is sent but not confirmed', async () => {
  const client = fakeClient();
  assert.deepStrictEqual(await openDoor(client, config, door, {}), { confirmed: false });
  assert.strictEqual(client.sent.length, 1);
});

test('handshake mode echoes the INVITE and replies with the app capabilities', async () => {
  const { client, events, listener } = setup('handshake');
  await listener.processMessage(frames.invite);
  await listener.processMessage(frames.invite); // retransmission: no second echo
  await listener.processMessage(frames.capabilities);
  assert.deepStrictEqual(events, ['doorbell_ring']);
  const data = client.sent.filter((b) => b[0] === 0x40);
  assert.strictEqual(data.length, 2);
  // echo: our side of the connection (b696), seq d7, acking their b4
  assert.strictEqual(data[0].subarray(0, 6).toString('hex'), '4018b696d7b5');
  assert.deepStrictEqual(data[0].subarray(8, 48), frames.invite.subarray(8, 48));
  // capabilities: next seq d8, acking their b5
  assert.strictEqual(data[1].subarray(0, 16).toString('hex'), '4018b696d8b600080003490027000000');
  assert.ok(data[1].includes(Buffer.from('SB0000023\0SB000002\0', 'latin1')));
});

test('off mode never takes part in the call', async () => {
  const { client, listener } = setup('off');
  await listener.processMessage(frames.invite);
  await listener.processMessage(frames.capabilities);
  assert.strictEqual(client.sent.filter((b) => b[0] === 0x40).length, 0);
});

test('debug log: the intercom\'s renewal checks and plain acknowledgements are answered and counted, not logged one by one; a ring still is (2.3.0-beta.6)', async () => {
  const { client, listener } = setup();
  const lines = [];
  listener.log = { ...quietLog(), debug: (m) => lines.push(m) };
  const msg = (prefix, action) => Buffer.concat([Buffer.from([prefix & 0xff, prefix >> 8, 0x01, 0x02, 0x03, 0x04, action >> 8, action & 0xff]), hex('ffffffff'), Buffer.from('SB000002\0')]);
  const sentBefore = client.sent.length;
  await listener.processMessage(msg(0x1860, 0x0010)); // renewal check
  await listener.processMessage(msg(0x1800, 0x0000)); // acknowledgement
  assert.strictEqual(client.sent.length - sentBefore, 2, 'the renewal check is still answered (ACK + FIN)');
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(listener.takeRenewalChecks(), 1);
  assert.strictEqual(listener.takeRenewalChecks(), 0, 'counted from the last summary');
  await listener.processMessage(frames.invite);
  assert.ok(lines.some((l) => l.startsWith('VIP msg: prefix=0x18c0')), 'a ring is still logged');
});
