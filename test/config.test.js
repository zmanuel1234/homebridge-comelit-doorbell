const test = require('node:test');
const assert = require('node:assert');
const { resolveSettings } = require('../dist/config');

test('defaults', () => {
  const s = resolveSettings({ platform: 'ComelitIntercom', host: 'h', token: 't' });
  assert.strictEqual(s.leaseMode, 'reconnect');
  assert.strictEqual(s.leaseRefreshMs, 120_000);
  assert.strictEqual(s.leaseRecycleMs, 3_000_000);
  assert.strictEqual(s.ringWindowMs, 90_000);
  assert.strictEqual(s.doorbellTriggerUrl, '');
  assert.strictEqual(s.maxReconnectDelayMs, 300_000);
  assert.strictEqual(s.registerPush, false);
  assert.strictEqual(s.answerMode, 'off');
  assert.strictEqual(s.reconnectDelayMs, 10_000);
  assert.strictEqual(s.enableNotifications, true);
  assert.strictEqual(s.subaddress, undefined);
  assert.strictEqual(s.mediaStartTimeoutMs, 10_000);
  assert.strictEqual(s.mediaSilenceMs, 5_000);
  assert.strictEqual(s.videoRefreshMs, 15_000);
  assert.strictEqual(s.liveViewWaitMs, 8_000);
  assert.strictEqual(s.lastVisitorMs, 300_000);
  assert.strictEqual(s.camera, false);
  assert.strictEqual(s.talkBack, false);
});

test('explicit values', () => {
  const s = resolveSettings({ platform: 'x', subaddress: 3, leaseRefreshMode: 'inplace', leaseRefreshMinutes: 2, ringWindowSeconds: 0, doorbellTriggerUrl: '', answerMode: 'handshake', reconnectDelay: 5, mediaSilenceSeconds: 8, videoRefreshSeconds: 20 });
  assert.strictEqual(s.subaddress, 3);
  assert.strictEqual(s.leaseMode, 'inplace');
  assert.strictEqual(s.ringWindowMs, 0);
  assert.strictEqual(s.doorbellTriggerUrl, '');
  assert.strictEqual(s.answerMode, 'handshake');
  assert.strictEqual(s.reconnectDelayMs, 5000);
  assert.strictEqual(s.mediaSilenceMs, 8000);
  assert.strictEqual(s.videoRefreshMs, 20000);
});

test('warnings for settings that do not work together', () => {
  const { settingsWarnings } = require('../dist/config');
  const w = (c) => settingsWarnings(resolveSettings({ platform: 'x', ...c }));
  assert.strictEqual(w({}).length, 1 - 1);
  assert.match(w({ answerMode: 'answer-on-view' }).join(), /needs the doorbell camera/);
  assert.match(w({ talkBack: true }).join(), /talkBack only works/);
  assert.match(w({ camera: true, answerMode: 'answer-on-view', doorbellTriggerUrl: 'http://localhost:8089/doorbell?Doorbell' }).join(), /two notifications/);
  assert.deepStrictEqual(w({ camera: true, answerMode: 'answer-on-view' }), []);
});

test('lastVisitorMinutes 0 turns the last-visitor picture off', () => {
  assert.strictEqual(resolveSettings({ platform: 'x', lastVisitorMinutes: 0 }).lastVisitorMs, 0);
});
