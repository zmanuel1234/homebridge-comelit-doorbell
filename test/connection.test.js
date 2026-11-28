// The platform's connection to a fake intercom over TCP: start-up, failures, drops and reconnects.

import test from 'node:test';
import assert from 'node:assert';
import { ComelitIntercomPlatform } from '../dist/platform.js';
import { FakeIntercom } from './fake-intercom.js';
import { quietLog, fakeApi } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A platform pointed at `port`, with 1 s reconnects; torn down after the test. */
function platformFor(t, port, extra = {}) {
  const api = fakeApi();
  const log = quietLog();
  const p = new ComelitIntercomPlatform(log, { platform: 'ComelitIntercom', name: 'Comelit Intercom', host: '127.0.0.1', port, token: 'secret', reconnectDelay: 1, ...extra }, api);
  t.after(() => p.teardown());
  const has = (re) => log.lines.some((l) => re.test(l));
  const count = (re) => log.lines.filter((l) => re.test(l)).length;
  return { api, log, p, has, count };
}

async function intercom(t, options) {
  const fake = await new FakeIntercom(options).start();
  t.after(() => fake.close());
  return fake;
}

test('start-up: connects, logs in, reads the configuration, registers for rings and is ready', async (t) => {
  const fake = await intercom(t);
  const { p, has, api } = platformFor(t, fake.port);
  await p.setupDevice();
  assert.ok(has(/^I Comelit Intercom ready$/), 'ready');
  assert.deepStrictEqual(fake.opened, ['UAUT', 'UCFG', 'INFO', 'CTPP', 'CSPB']);
  assert.deepStrictEqual(fake.requests.map((r) => `${r.channel}:${r.msg.message}`), ['UAUT:access', 'UCFG:get-configuration', 'INFO:server-info']);
  assert.strictEqual(fake.requests[0].msg['user-token'], 'secret');
  assert.ok(fake.binary.some((b) => b.channel === 'CTPP'), 'the CTPP registration was sent');
  assert.ok(p.client?.connected && p.callHandler && p.vipListener, 'connected, with a call handler and listener');
  assert.deepStrictEqual([...api.registered].sort(), ['uuid:homebridge-comelit-intercom-doorbell', 'uuid:homebridge-comelit-intercom-lock-0'], 'the doorbell and the door\'s lock');
  assert.ok(!has(/^W |^E /), 'no warnings or errors');
});

test('start-up without rings (enableNotifications off): no CTPP channels, still ready', async (t) => {
  const fake = await intercom(t);
  const { p, has } = platformFor(t, fake.port, { enableNotifications: false });
  await p.setupDevice();
  assert.ok(has(/^I Comelit Intercom ready$/));
  assert.deepStrictEqual(fake.opened, ['UAUT', 'UCFG', 'INFO']);
  assert.strictEqual(p.vipListener, undefined);
});

test('no intercom on the port: the failure is logged and a reconnect scheduled', async (t) => {
  const fake = await new FakeIntercom().start();
  const port = fake.port;
  await fake.close(); // nothing listens there now
  const { p, has } = platformFor(t, port);
  await p.setupDevice();
  assert.ok(has(/^E Connection failed: /));
  assert.ok(has(/^I Reconnecting in 1 s/));
  assert.strictEqual(p.client, undefined);
});

test('a wrong token: "Authentication failed", the connection is closed, and it tries again', async (t) => {
  const fake = await intercom(t, { answers: (m) => (m.message === 'access' ? { 'response-code': 403, 'response-string': 'Forbidden' } : undefined) });
  const { p, has } = platformFor(t, fake.port);
  await p.setupDevice();
  assert.ok(has(/^E Authentication failed: Authentication failed: 403 Forbidden$/));
  assert.ok(has(/^I Reconnecting in 1 s/));
  await waitFor(() => fake.sockets.size === 0, 'the plugin to close the connection');
  assert.deepStrictEqual(fake.opened, ['UAUT'], 'nothing after the failed login');
});

test('the configuration refused: "Config fetch failed", closed, and it tries again', async (t) => {
  const fake = await intercom(t, { answers: (m) => (m.message === 'get-configuration' ? { 'response-code': 500 } : undefined) });
  const { p, has } = platformFor(t, fake.port);
  await p.setupDevice();
  assert.ok(has(/^E Config fetch failed: Config request returned code 500$/));
  assert.ok(has(/^I Reconnecting in 1 s/));
  await waitFor(() => fake.sockets.size === 0, 'the plugin to close the connection');
});

test('a failed attempt doubles the wait before the next (1 s, then 2 s)', async (t) => {
  const fake = await intercom(t, { answers: (m) => (m.message === 'access' ? { 'response-code': 403 } : undefined) });
  const { p, has } = platformFor(t, fake.port);
  await p.setupDevice();
  assert.ok(has(/^I Reconnecting in 1 s/));
  await waitFor(() => has(/^I Reconnecting in 2 s/), 'the second, longer wait', 4000);
  assert.strictEqual(fake.connections, 2);
});

test('a push registration that fails is not fatal: still ready', async (t) => {
  const fake = await intercom(t, { answers: (m) => (m.message === 'server-info' ? Buffer.from([1, 2, 3]) : undefined) });
  const { p, has } = platformFor(t, fake.port);
  await p.setupDevice();
  assert.ok(has(/^W Push registration failed \(non-fatal\): /));
  assert.ok(has(/^I Comelit Intercom ready$/));
});

test('an intercom that never answers the CTPP registration: a warning, then ready anyway', async (t) => {
  const fake = await intercom(t, { ctppAnswers: false });
  const { p, has } = platformFor(t, fake.port);
  await p.setupDevice();
  assert.ok(has(/^W CTPP init: the intercom did not answer the registration/));
  assert.ok(has(/^I Comelit Intercom ready$/));
});

test('the intercom dropping the connection: "Connection lost", then it reconnects and is ready again', async (t) => {
  const fake = await intercom(t);
  const { p, has, count } = platformFor(t, fake.port);
  await p.setupDevice();
  fake.dropAll();
  await waitFor(() => has(/^I Connection lost/), 'the drop to be noticed');
  assert.ok(has(/^W Device disconnected — scheduling reconnect$/));
  await waitFor(() => count(/^I Comelit Intercom ready$/) === 2, 'the reconnect', 4000);
  assert.strictEqual(fake.connections, 2);
  assert.ok(p.client?.connected);
});

test('the intercom closing the ring channel (CTPP): the plugin reconnects at once to keep rings coming', async (t) => {
  const fake = await intercom(t);
  const { p, count, has } = platformFor(t, fake.port);
  await p.setupDevice();
  fake.closeChannel('CTPP');
  await waitFor(() => has(/the intercom closed the ring channel \(CTPP\)/), 'the drop');
  await waitFor(() => count(/^I Comelit Intercom ready$/) === 2, 'the reconnect', 4000);
  assert.strictEqual(fake.opened.filter((n) => n === 'CTPP').length, 2, 'CTPP opened again');
});

test('a push ring from the intercom reaches the platform as an event', async (t) => {
  const fake = await intercom(t);
  const { p, has } = platformFor(t, fake.port);
  await p.setupDevice();
  fake.push({ message: 'incoming-call', 'apt-address': 'SB000002' });
  await waitFor(() => has(/^D Event: doorbell_ring from SB000002$/), 'the event');
});

test('shutting down while connecting: the connection is closed and nothing is retried', async (t) => {
  const fake = await intercom(t, { answers: (m) => (m.message === 'access' ? null : undefined) }); // the login never answers
  const { p, has } = platformFor(t, fake.port);
  const setup = p.setupDevice();
  await waitFor(() => fake.requests.length === 1, 'the login request');
  p.teardown();
  fake.dropAll(); // the pending login fails
  await setup;
  assert.ok(!has(/^I Reconnecting/), 'no reconnect after shutdown');
  assert.ok(!has(/^I Comelit Intercom ready$/));
});
