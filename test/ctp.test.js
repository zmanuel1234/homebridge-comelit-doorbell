const test = require('node:test');
const assert = require('node:assert');
const { ackWord, finWord, buildFrame, parseFrame } = require('../dist/ctp');
const { encodeCtppInit } = require('../dist/protocol');
const { hex, frames } = require('./helpers');

const word = (s) => hex(s).readUInt32LE(0);

test('ACK word for a received frame matches the captured ACKs', () => {
  assert.strictEqual(ackWord(word('3696 b4d7')), word('b696 d7b5')); // INVITE → our ACK
  assert.strictEqual(ackWord(0xf06a7554), 0x6bf075d4); // renewal → renewal ACK (log, 14:02:44)
  assert.strictEqual(ackWord(word('87d4 91f2')), word('07d4 f292'));
});

test('FIN word answers a FIN without advancing the sequence', () => {
  assert.strictEqual(finWord(word('87d4 91f2')), word('07d4 f291')); // captured 14:02:41
});

test('buildFrame reproduces the captured door-open request', () => {
  const body = Buffer.concat([hex('002d'), Buffer.from('SB100001\0\0', 'latin1'), hex('01')]);
  const frame = buildFrame({ flags: 0xc0, conn0: 0x07, conn1: 0xd4, seq: 0xf1, ack: 0x90, body, source: 'SB0000023', destination: 'SB100001' });
  assert.deepStrictEqual(frame, frames.openRequest);
});

test('parseFrame reads flags, connection and opcode', () => {
  const f = parseFrame(frames.invite);
  assert.strictEqual(f.flags, 0xc0);
  assert.deepStrictEqual([f.conn0, f.conn1, f.seq, f.ack], [0x36, 0x96, 0xb4, 0xd7]);
  assert.strictEqual(f.opcode, 0x0001);
  assert.strictEqual(parseFrame(frames.busyRelease).body[2], 8);
});

test('encodeCtppInit reproduces the captured registration', () => {
  assert.deepStrictEqual(encodeCtppInit('SB000002', 3, 0x6aef75d4), frames.register);
});
