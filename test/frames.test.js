// Door open, ring and release handling, using frames captured from a real 6741W (MSVU, firmware 2.1.0).
const D = require('path').join(__dirname, '..', 'dist');
const { VipEventListener } = require(D + '/vipListener.js');
const door = require(D + '/door.js');
const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const logs = []; const log = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), debug: (m) => logs.push('D ' + m), error: (m) => logs.push('E ' + m) };
const sent = [];
const channel = { isOpen: true, serverChannelId: 1, responseQueue: { clear() {} } };
const client = { sendBinary: async (ch, b) => { sent.push(Buffer.from(b)); }, getChannel: () => channel };
const events = [];
const vip = new VipEventListener(client, { aptAddress: 'SB000002', aptSubaddress: 3 }, (e) => events.push(e.eventType), log);
vip.channel = channel; vip.running = true;
(async () => {
  let ok = true; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); ok = ok && c; };
  // captured INVITE (14:01:57)
  await vip._processMessage(hex('c018 3696 b4d7 0028 0001 5342 3130 3030 3031 0000 5342 3030 3030 3032 0000 0100 c035 a838 5342 3130 3030 3031 0000 5050 ffff ffff 5342 3030 3030 3032 0000 5342 3030 3030 3032 3300'));
  check(events.join() === 'doorbell_ring', 'INVITE fires doorbell_ring');
  // a non-INVITE SYN must not ring (dedupe window reset first)
  vip.lastFired.clear(); events.length = 0;
  await vip._processMessage(hex('c018 1111 2233 0008 0003 5003 3b00 0000 ffff ffff 5342 3130 3030 3031 0000 5342 3030 3030 3032 3300'));
  check(events.length === 0, 'non-INVITE SYN does not ring');
  // captured busy release (conn 87d4) without a waiter: no door_opened
  await vip._processMessage(hex('6018 87d4 90f2 0003 000e 0800 ffff ffff 5342 3130 3030 3031 0000 5342 3030 3030 3032 3300'));
  check(events.length === 0, 'busy release is not reported as door_opened');
  // door open: refused as busy
  sent.length = 0;
  const p = door.openDoor(client, { aptAddress: 'SB000002', aptSubaddress: 3 }, { name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false });
  await new Promise((r) => setImmediate(r));
  const pkt = sent[0];
  check(pkt && pkt[0] === 0xc0 && pkt.readUInt16BE(8) === 0x002d, 'open request sent (SYN, opcode 0x002D)');
  const reply = (cause) => Buffer.concat([Buffer.from([0x60, 0x18, pkt[2] ^ 0x80, pkt[3], 0x90, 0xf2, 0x00, 0x03, 0x00, 0x0e, cause, 0x00]), hex('ffffffff 5342 3130 3030 3031 0000 5342 3030 3030 3032 3300')]);
  await vip._processMessage(reply(8));
  let err = null; try { await p; } catch (e) { err = e; }
  check(err && /cause 8, busy/.test(err.message), 'busy reply rejects the open: ' + (err && err.message));
  // door open: success
  sent.length = 0;
  const p2 = door.openDoor(client, { aptAddress: 'SB000002', aptSubaddress: 3 }, { name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false });
  await new Promise((r) => setImmediate(r));
  const pk2 = sent[0];
  await vip._processMessage(Buffer.concat([Buffer.from([0x60, 0x18, pk2[2] ^ 0x80, pk2[3], 1, 2, 0, 3, 0, 0x0e, 0, 0]), hex('ffffffff')]));
  const r2 = await p2;
  check(r2 && r2.confirmed === true, 'cause 0 confirms the open');
  // a message arriving after a timed-out wait must not be lost
  const { AsyncQueue } = require(D + '/channels.js');
  const q = new AsyncQueue();
  await q.dequeue(5);
  q.enqueue('ring');
  check((await q.dequeue(5)) === 'ring', 'message after a timed-out wait is delivered');
  console.log(ok ? 'ALL PASS' : 'SOME FAILED');
  process.exit(ok ? 0 : 1);
})();
