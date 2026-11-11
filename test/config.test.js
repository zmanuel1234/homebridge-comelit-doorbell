const test = require('node:test');
const assert = require('node:assert');
const { callHandlerMode, resolveSettings, settingsWarnings } = require('../dist/config');

test('defaults', () => {
  const s = resolveSettings({ platform: 'ComelitIntercom', host: 'h', token: 't' });
  assert.strictEqual(s.leaseMode, 'inplace', 'in-place renewal is the default since 2.1.0');
  assert.strictEqual(s.leaseRefreshMs, 120_000);
  assert.strictEqual(s.leaseRecycleMs, 3_000_000);
  assert.strictEqual(s.ringWindowMs, 90_000);
  assert.strictEqual(s.doorbellTriggerUrl, '');
  assert.strictEqual(s.maxReconnectDelayMs, 300_000);
  assert.strictEqual(s.doorVolumeDb, 12);
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
  assert.strictEqual(s.talkBack, true, 'talk-back is on by default since 2.1.0');
});

test('explicit values', () => {
  const s = resolveSettings({ platform: 'x', subaddress: 3, leaseRefreshMode: 'reconnect', talkBack: false, leaseRefreshMinutes: 2, ringWindowSeconds: 0, doorbellTriggerUrl: '', answerMode: 'handshake', reconnectDelay: 5, mediaSilenceSeconds: 8, videoRefreshSeconds: 20 });
  assert.strictEqual(s.subaddress, 3);
  assert.strictEqual(s.leaseMode, 'reconnect');
  assert.strictEqual(s.talkBack, false);
  assert.strictEqual(s.ringWindowMs, 0);
  assert.strictEqual(s.doorbellTriggerUrl, '');
  assert.strictEqual(s.answerMode, 'handshake');
  assert.strictEqual(s.reconnectDelayMs, 5000);
  assert.strictEqual(s.mediaSilenceMs, 8000);
  assert.strictEqual(s.videoRefreshMs, 20000);
});

test('warnings for settings that do not work together', () => {
  // settingsWarnings is imported at the top
  const w = (c) => settingsWarnings(resolveSettings({ platform: 'x', ...c }));
  assert.strictEqual(w({}).length, 1 - 1);
  assert.match(w({ answerMode: 'answer-on-view' }).join(), /needs the doorbell camera/);
  assert.deepStrictEqual(w({ talkBack: true }), [], 'talk-back without the camera: no warning (on by default)');
  assert.match(w({ camera: true, answerMode: 'answer-on-view', doorbellTriggerUrl: 'http://localhost:8089/doorbell?Doorbell' }).join(), /two notifications/);
  assert.deepStrictEqual(w({ camera: true, answerMode: 'answer-on-view' }), []);
});

test('lastVisitorMinutes 0 turns the last-visitor picture off', () => {
  assert.strictEqual(resolveSettings({ platform: 'x', lastVisitorMinutes: 0 }).lastVisitorMs, 0);
});

test('an invalid ring window keeps the 90 s window instead of allowing unlock at any time', () => {
  for (const v of [-5, 'abc', 'ninety']) {
    const s = resolveSettings({ platform: 'x', ringWindowSeconds: v });
    assert.strictEqual(s.ringWindowMs, 90_000, String(v));
    assert.match(s.invalid.join(), /ringWindowSeconds/);
  }
  assert.strictEqual(resolveSettings({ platform: 'x', ringWindowSeconds: '0' }).ringWindowMs, 0);
  assert.strictEqual(resolveSettings({ platform: 'x', ringWindowSeconds: '120' }).ringWindowMs, 120_000);
});

test('numbers typed as text are accepted; host and token are trimmed', () => {
  const s = resolveSettings({ platform: 'x', host: ' 192.168.1.50 ', token: 'abc\n', subaddress: '3', port: '64100', reconnectDelay: '5' });
  assert.strictEqual(s.host, '192.168.1.50');
  assert.strictEqual(s.token, 'abc');
  assert.strictEqual(s.subaddress, 3);
  assert.strictEqual(s.port, 64100);
  assert.strictEqual(s.reconnectDelayMs, 5000);
  assert.deepStrictEqual(s.invalid, []);
});

test('a reconnect delay of 0 or less would retry in a tight loop: the default is used', () => {
  for (const v of [0, -1, 'x']) {
    const s = resolveSettings({ platform: 'x', reconnectDelay: v });
    assert.strictEqual(s.reconnectDelayMs, 10_000, String(v));
  }
});

test('an invalid sub-address is reported, not used', () => {
  const s = resolveSettings({ platform: 'x', subaddress: 'three' });
  assert.strictEqual(s.subaddress, undefined);
  assert.match(settingsWarnings(s).join(), /subaddress/);
});

test("videoCodec 'copy' falls back to libx264, with a warning", () => {
  const s = resolveSettings({ platform: 'x', videoCodec: 'copy' });
  assert.strictEqual(s.videoCodec, 'libx264');
  assert.match(settingsWarnings(s).join(), /copy/);
  assert.strictEqual(resolveSettings({ platform: 'x', videoCodec: 'h264_v4l2m2m' }).videoCodec, 'h264_v4l2m2m');
});

test('values below the editor minimum, and invalid ones, are reported and replaced (beta.26)', () => {
  const s = resolveSettings({ leaseRefreshMinutes: 0.1, leaseRecycleMinutes: 'x', liveViewWaitSeconds: 1, maxReconnectDelay: -5, lastVisitorMinutes: 'abc' });
  assert.strictEqual(s.leaseRefreshMs, 2 * 60_000);
  assert.strictEqual(s.leaseRecycleMs, 50 * 60_000);
  assert.strictEqual(s.liveViewWaitMs, 8000);
  assert.strictEqual(s.maxReconnectDelayMs, 300_000);
  assert.strictEqual(s.lastVisitorMs, 5 * 60_000, 'an invalid value keeps the default, not 0 (off)');
  assert.strictEqual(s.invalid.length, 5, s.invalid.join('\n'));
});

test("enableNotifications accepts 'false' as text; off with a ring window warns the lock can't open (beta.26)", () => {
  assert.strictEqual(resolveSettings({ enableNotifications: 'false' }).enableNotifications, false);
  assert.strictEqual(resolveSettings({ enableNotifications: 'true' }).enableNotifications, true);
  assert.strictEqual(resolveSettings({ enableNotifications: 'nope' }).invalid.length, 1);
  assert.ok(settingsWarnings(resolveSettings({ enableNotifications: false })).some((w) => /ringWindowSeconds\) to 0/.test(w)));
  assert.ok(!settingsWarnings(resolveSettings({ enableNotifications: false, ringWindowSeconds: 0 })).some((w) => /refuses/.test(w)));
});

test('camera, talkBack and registerPush accept true/false as text (beta.26)', () => {
  const s = resolveSettings({ camera: 'true', talkBack: 'false', registerPush: 'true' });
  assert.deepStrictEqual([s.camera, s.talkBack, s.registerPush], [true, false, true]);
  assert.deepStrictEqual(s.invalid, []);
});

test('the settings screen shows every setting exactly once, and the README documents each (beta.29)', () => {
  const fs = require('fs');
  const path = require('path');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
  const keys = Object.keys(schema.schema.properties);
  const shown = schema.layout.flatMap((s) => s.items.map((i) => (typeof i === 'string' ? i : i.key)));
  assert.deepStrictEqual([...shown].sort(), [...keys].sort());
  assert.strictEqual(new Set(shown).size, shown.length);
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  for (const k of keys) {
    assert.ok(readme.includes(`(\`${k}\`)`), `README documents ${k}`);
  }
  // the defaults in the schema match the plugin's
  const s = resolveSettings({});
  assert.strictEqual(schema.schema.properties.ringPreview.default, s.ringPreview);
  assert.strictEqual(schema.schema.properties.talkBack.default, s.talkBack);
  assert.strictEqual(schema.schema.properties.camera.default, s.camera);
});

test('Next Visitor settings: defaults, text, limits (2.1.1-beta.2)', () => {
  const d = resolveSettings({});
  assert.strictEqual(d.nextVisitorSwitch, false);
  assert.strictEqual(d.nextVisitorMs, 120 * 60_000);
  const s = resolveSettings({ nextVisitorSwitch: 'true', nextVisitorMinutes: 30 });
  assert.strictEqual(s.nextVisitorSwitch, true);
  assert.strictEqual(s.nextVisitorMs, 30 * 60_000);
  const bad = resolveSettings({ nextVisitorMinutes: 0.5 });
  assert.strictEqual(bad.nextVisitorMs, 120 * 60_000);
  assert.strictEqual(bad.invalid.length, 1);
  assert.ok(settingsWarnings(resolveSettings({ nextVisitorSwitch: true, enableNotifications: false })).some((w) => /Next Visitor switch needs/.test(w)));
});

test('calls are followed (handshake) for doctor mode or the Next Visitor switch with answering off (review)', () => {
  const { callHandlerMode } = require('../dist/config');
  assert.strictEqual(callHandlerMode(resolveSettings({})), 'off');
  assert.strictEqual(callHandlerMode(resolveSettings({ nextVisitorSwitch: true })), 'handshake');
  assert.strictEqual(callHandlerMode(resolveSettings({ doctorMode: 'switch' })), 'handshake');
  assert.strictEqual(callHandlerMode(resolveSettings({ nextVisitorSwitch: true, answerMode: 'answer-on-view' })), 'answer-on-view');
});


test('non-numbers never become 0: the ring window keeps 90 s and is reported (2.2.0 review)', () => {
  for (const v of [false, true, ' ', [], '0x0', '1e3', 'abc', {}]) {
    const s = resolveSettings({ ringWindowSeconds: v });
    assert.strictEqual(s.ringWindowMs, 90_000, JSON.stringify(v));
    assert.strictEqual(s.invalid.length, 1, JSON.stringify(v));
  }
  assert.strictEqual(resolveSettings({ ringWindowSeconds: 0 }).ringWindowMs, 0, 'an explicit 0 still allows any time');
  assert.strictEqual(resolveSettings({ ringWindowSeconds: '0' }).ringWindowMs, 0);
  assert.strictEqual(resolveSettings({ ringWindowSeconds: ' 45 ' }).ringWindowMs, 45_000);
});

test("values above the editor's maximum are reported and replaced (2.2.0 review)", () => {
  const s = resolveSettings({
    reconnectDelay: 301, maxReconnectDelay: 1e7, subaddress: 16, leaseRefreshMinutes: 100000, leaseRecycleMinutes: 56,
    ringWindowSeconds: 601, mediaStartTimeoutSeconds: 61, mediaSilenceSeconds: 61, videoRefreshSeconds: 61,
    liveViewWaitSeconds: 21, lastVisitorMinutes: 1441,
  });
  assert.strictEqual(s.invalid.length, 11, s.invalid.join('\n'));
  assert.strictEqual(s.leaseRefreshMs, 2 * 60_000);
  assert.strictEqual(s.maxReconnectDelayMs, 300_000);
  assert.strictEqual(s.ringWindowMs, 90_000);
  assert.strictEqual(s.subaddress, undefined);
  // the maximums themselves are fine
  const ok = resolveSettings({ reconnectDelay: 300, maxReconnectDelay: 3600, leaseRefreshMinutes: 55, ringWindowSeconds: 600, lastVisitorMinutes: 1440 });
  assert.deepStrictEqual(ok.invalid, []);
});

test('invalid choices are reported; non-text paths are reported instead of crashing (2.2.0 review)', () => {
  const s = resolveSettings({ answerMode: 'answer-on-veiw', doctorMode: 'sometimes', leaseRefreshMode: 'x', videoQuality: '4k' });
  assert.strictEqual(s.answerMode, 'off');
  assert.strictEqual(s.doctorMode, 'off');
  assert.strictEqual(s.leaseMode, 'inplace');
  assert.strictEqual(s.videoQuality, 'sd');
  assert.strictEqual(s.invalid.length, 4, s.invalid.join('\n'));
  const t = resolveSettings({ ffmpegPath: 7, videoCodec: ['x'], snapshotImage: true, host: 10 });
  assert.strictEqual(t.ffmpegPath, '');
  assert.strictEqual(t.videoCodec, 'libx264');
  assert.strictEqual(t.invalid.length, 4, t.invalid.join('\n'));
  // the valid ones still work
  const v = resolveSettings({ answerMode: 'answer-on-view', doctorMode: 'switch', leaseRefreshMode: 'reconnect', videoQuality: 'hd', ffmpegPath: ' /usr/local/bin/ffmpeg ' });
  assert.deepStrictEqual([v.answerMode, v.doctorMode, v.leaseMode, v.videoQuality, v.ffmpegPath], ['answer-on-view', 'switch', 'reconnect', 'hd', '/usr/local/bin/ffmpeg']);
  assert.deepStrictEqual(v.invalid, []);
});
