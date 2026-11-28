
import test from 'node:test';
import assert from 'node:assert';
import { IconaBridgeClient } from '../dist/client.js';
import { encodeHeader } from '../dist/protocol.js';
import { quietLog } from './helpers.js';

test('a channel the intercom opens is acknowledged and reported with its name and handle', () => {
  const client = new IconaBridgeClient('127.0.0.1', 1, quietLog());
  const written = [];
  client.socket = { write: (b) => written.push(b), destroy() {} };
  let seen;
  client.on('channel', (name, handle) => (seen = [name, handle]));
  // [cd ab 01 00][type 7][RTPC][handle 0x3001][00]
  const body = Buffer.from('cdab010007000000525450430130' + '00', 'hex');
  client.onData(Buffer.concat([encodeHeader(body.length, 0), body]));
  assert.deepStrictEqual(seen, ['RTPC', 0x3001]);
  assert.strictEqual(written[0].subarray(8).toString('hex'), 'cdab0200040000000130' + '0000');
  client.disconnect();
});

test('frames on a media handle go to its handler', () => {
  const client = new IconaBridgeClient('127.0.0.1', 1, quietLog());
  const got = [];
  client.setBinaryHandler(0x2004, (b) => got.push(b));
  client.onData(Buffer.concat([encodeHeader(3, 0x2004), Buffer.from([1, 2, 3])]));
  assert.deepStrictEqual(got, [Buffer.from([1, 2, 3])]);
  client.disconnect();
});
