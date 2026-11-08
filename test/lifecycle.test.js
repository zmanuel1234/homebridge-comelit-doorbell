const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { IconaBridgeClient } = require('../dist/client');
const { CallHandler } = require('../dist/call');
const { reconnectDelay, resolveSettings } = require('../dist/config');
const { quietLog } = require('./helpers');

/** A TCP server that accepts and stays silent, so the client's lease timer is all that acts. */
async function silentServer() {
  const sockets = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => { sockets.forEach((s) => s.destroy()); server.close(); } };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until `cond()` is true (polling), so slow CI machines don't make the tests flaky. */
async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting');
    }
    await sleep(5);
  }
}

test('reconnect lease: the client reconnects at the interval and says it was planned', async () => {
  const srv = await silentServer();
  const client = new IconaBridgeClient('127.0.0.1', srv.port, quietLog(), { intervalMs: 50, mode: 'reconnect', recycleMs: 1e9 });
  const calls = [];
  client.setDisconnectCallback((planned) => calls.push(planned));
  await client.connect();
  await waitFor(() => calls.length > 0);
  assert.deepStrictEqual(calls, [true]);
  await client.disconnect();
  srv.close();
});

test('in-place lease: re-registers on the open connection, then reconnects after the recycle time', async () => {
  const srv = await silentServer();
  let reregs = 0;
  const client = new IconaBridgeClient('127.0.0.1', srv.port, quietLog(), {
    intervalMs: 40, mode: 'inplace', recycleMs: 600, reregister: async () => { reregs++; },
  });
  const calls = [];
  client.setDisconnectCallback((planned) => calls.push(planned));
  await client.connect();
  await waitFor(() => reregs >= 1);
  assert.deepStrictEqual(calls, [], 'renewed in place, no reconnect');
  await waitFor(() => calls.length > 0);
  assert.deepStrictEqual(calls, [true]);
  assert.ok(reregs >= 2);
  await client.disconnect();
  srv.close();
});

test('a planned reconnect waits while a call is busy', async () => {
  const srv = await silentServer();
  let busy = true;
  const client = new IconaBridgeClient('127.0.0.1', srv.port, quietLog(), {
    intervalMs: 30, mode: 'reconnect', recycleMs: 1e9, isBusy: () => busy, busyRecheckMs: 20,
  });
  const calls = [];
  client.setDisconnectCallback((planned) => calls.push(planned));
  await client.connect();
  await sleep(250);
  assert.deepStrictEqual(calls, [], 'no reconnect during the call');
  assert.ok(client.connected);
  busy = false;
  await waitFor(() => calls.length > 0);
  assert.deepStrictEqual(calls, [true]);
  await client.disconnect();
  srv.close();
});

test('a dropped connection is reported as not planned', async () => {
  const srv = await silentServer();
  const client = new IconaBridgeClient('127.0.0.1', srv.port, quietLog());
  const calls = [];
  client.setDisconnectCallback((planned) => calls.push(planned));
  await client.connect();
  srv.close();
  await waitFor(() => calls.length > 0);
  assert.deepStrictEqual(calls, [false]);
  await client.disconnect();
});

test('CallHandler.busy: only an answered call, or one with media, counts', () => {
  const h = new CallHandler('answer-on-view', 'SB000002', 'SB000001', async () => undefined, quietLog());
  assert.strictEqual(h.busy(), false);
  const call = { answered: false, ended: false, born: Date.now() };
  h.calls.set(1, call);
  assert.strictEqual(h.busy(), false, 'ringing but not answered');
  call.answered = true;
  assert.strictEqual(h.busy(), true);
  call.ended = true;
  assert.strictEqual(h.busy(), false);
  h.calls.set(2, { answered: false, ended: false, born: Date.now(), mediaStarting: Promise.resolve() });
  assert.strictEqual(h.busy(), true, 'media starting');
  h.calls.clear();
  h.calls.set(3, { answered: true, ended: false, born: Date.now() - 10 * 60_000 });
  assert.strictEqual(h.busy(), false, 'a stale call without media does not hold the reconnect');
});

test('a planned reconnect stops waiting after maxBusyWaitMs', async () => {
  const srv = await silentServer();
  const client = new IconaBridgeClient('127.0.0.1', srv.port, quietLog(), {
    intervalMs: 30, mode: 'reconnect', recycleMs: 1e9, isBusy: () => true, busyRecheckMs: 20, maxBusyWaitMs: 60,
  });
  const calls = [];
  client.setDisconnectCallback((planned) => calls.push(planned));
  await client.connect();
  await waitFor(() => calls.length > 0);
  assert.deepStrictEqual(calls, [true]);
  await client.disconnect();
  srv.close();
});

test('reconnect back-off doubles from reconnectDelay up to maxReconnectDelay', () => {
  const s = resolveSettings({ platform: 'x', reconnectDelay: 10, maxReconnectDelay: 60 });
  assert.deepStrictEqual([0, 1, 2, 3, 4, 50].map((n) => reconnectDelay(s, n) / 1000), [10, 20, 40, 60, 60, 60]);
  const t = resolveSettings({ platform: 'x', reconnectDelay: 120, maxReconnectDelay: 60 });
  assert.strictEqual(reconnectDelay(t, 3), 120_000, 'never shorter than reconnectDelay');
  assert.strictEqual(reconnectDelay(s, -1), 2_000, 'a planned reconnect waits at most 2 s');
  assert.strictEqual(reconnectDelay(resolveSettings({ platform: 'x', reconnectDelay: 1 }), -1), 1_000);
});
