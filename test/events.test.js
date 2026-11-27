// Recent events: the history the plugin keeps, how it is shown, and where it is recorded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventLog, readEvents, describeEvents, EVENTS_FILE } = require('../dist/events');
const { ComelitIntercomPlatform } = require('../dist/platform');
const { quietLog, fakeApi } = require('./helpers');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'comelit-events-'));

test('event log: keeps the newest events, saves them whole, and reads them back', async () => {
  const dir = tmpDir();
  const file = path.join(dir, EVENTS_FILE);
  const log = new EventLog(file, 3);
  for (const n of [1, 2, 3, 4]) log.add('view', `View ${n}`, Date.now() + n); // (rings this close would be one ring)
  assert.deepStrictEqual(log.list().map((e) => e.text), ['View 2', 'View 3', 'View 4'], 'the oldest goes');
  await log.flush();
  assert.deepStrictEqual(readEvents(file).map((e) => e.text), ['View 2', 'View 3', 'View 4']);
  assert.ok(!fs.existsSync(`${file}.tmp`), 'written via a temporary file, renamed');
  // a restart: the history is still there
  assert.deepStrictEqual(new EventLog(file, 3).list().map((e) => e.text), ['View 2', 'View 3', 'View 4']);
});

test('event log: kept by days (30 by default), with a cap; old events go at start-up too', async () => {
  const dir = tmpDir();
  const file = path.join(dir, EVENTS_FILE);
  const day = 86_400_000;
  fs.writeFileSync(file, JSON.stringify([
    { t: Date.now() - 40 * day, kind: 'ring', text: '40 days ago' },
    { t: Date.now() - 20 * day, kind: 'ring', text: '20 days ago' },
    { t: Date.now() - 2 * day, kind: 'ring', text: '2 days ago' },
  ]));
  assert.deepStrictEqual(new EventLog(file).list().map((e) => e.text), ['20 days ago', '2 days ago'], '30 days by default');
  assert.deepStrictEqual(new EventLog(file, undefined, 7).list().map((e) => e.text), ['2 days ago'], '7 days');
  assert.deepStrictEqual(new EventLog(file, undefined, 365).list().length, 3, 'a year');
  const capped = new EventLog(undefined, 3, 365);
  for (let n = 0; n < 5; n++) capped.add('view', `View ${n}`, Date.now() - (5 - n) * 1000);
  assert.deepStrictEqual(capped.list().map((e) => e.text), ['View 2', 'View 3', 'View 4'], 'the cap still applies');
  const { MAX_EVENTS, DEFAULT_EVENT_DAYS } = require('../dist/events');
  assert.strictEqual(MAX_EVENTS, 2000);
  assert.strictEqual(DEFAULT_EVENT_DAYS, 30);
});

test('event log: the days setting (eventHistoryDays), 1 to 365, 30 by default', () => {
  const { resolveSettings } = require('../dist/config');
  assert.strictEqual(resolveSettings({}).eventHistoryDays, 30);
  assert.strictEqual(resolveSettings({ eventHistoryDays: '90' }).eventHistoryDays, 90);
  for (const bad of [0, 366, 2.5, 'x']) {
    const s = resolveSettings({ eventHistoryDays: bad });
    assert.strictEqual(s.eventHistoryDays, 30, String(bad));
    assert.strictEqual(s.invalid.length, 1, String(bad));
  }
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.schema.json'), 'utf8'));
  assert.deepStrictEqual([schema.schema.properties.eventHistoryDays.minimum, schema.schema.properties.eventHistoryDays.maximum], [1, 365]);
});

test('event log: a ring reported twice is one ring; no IP addresses; events in time order', () => {
  const log = new EventLog(undefined);
  log.add('ring', 'Ring');
  log.add('ring', 'Ring'); // the same ring, from the other channel
  log.add('open-failed', "Unlock failed (Can't connect to 192.168.1.50:64100: timeout)");
  log.add('view', 'Live view, 200 s', Date.now() - 200_000); // noted at its end, timed from its start
  const list = log.list();
  assert.deepStrictEqual(list.map((e) => e.kind), ['view', 'ring', 'open-failed']);
  assert.strictEqual(list[2].text, "Unlock failed (Can't connect to the intercom: timeout)");
});

test('event log: a missing, broken or odd file means no events, never an error', () => {
  const dir = tmpDir();
  assert.deepStrictEqual(readEvents(path.join(dir, 'missing.json')), []);
  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{not json');
  assert.deepStrictEqual(readEvents(broken), []);
  const odd = path.join(dir, 'odd.json');
  fs.writeFileSync(odd, JSON.stringify([{ t: 1, kind: 'ring', text: 'Ring', extra: 'x' }, { t: 'x', kind: 'ring', text: 'a' }, { t: 2, kind: 'hack', text: 'b' }, null]));
  assert.deepStrictEqual(readEvents(odd), [{ t: 1, kind: 'ring', text: 'Ring' }], 'only valid events, only known fields');
  assert.deepStrictEqual(new EventLog(undefined).list(), [], 'no storage folder: memory only');
});

test('event log: a folder it cannot write to does not throw', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'file'), '');
  const log = new EventLog(path.join(dir, 'file', 'nested', EVENTS_FILE)); // a file where a folder should be
  log.add('ring', 'Ring');
  await log.flush();
  assert.strictEqual(log.list().length, 1);
});

test('shown: each ring says what followed it (viewed, opened, or not opened by Homebridge), newest first', () => {
  const t0 = 1_700_000_000_000;
  const shown = describeEvents([
    { t: t0, kind: 'ring', text: 'Ring' },
    { t: t0 + 10_000, kind: 'view', text: 'Live view, 20 s' },
    { t: t0 + 28_000, kind: 'open', text: "Door 'Entrance lock' opened from HomeKit" },
    { t: t0 + 600_000, kind: 'ring', text: 'Ring' },
    { t: t0 + 610_000, kind: 'view', text: 'Live view, 14 s' },
    { t: t0 + 620_000, kind: 'view', text: 'Live view, 3 s' },
    { t: t0 + 1_200_000, kind: 'ring', text: 'Ring' },
    { t: t0 + 1_210_000, kind: 'ring', text: 'Ring' }, // rang again: the first ring's outcome stops here
    { t: t0 + 1_230_000, kind: 'open', text: "Door 'Entrance lock' opened by Doctor Mode" },
    { t: t0 + 2_000_000, kind: 'ring', text: 'Ring' },
    { t: t0 + 2_000_000 + 130_000, kind: 'open', text: 'too late to count' },
  ]);
  assert.strictEqual(shown[0].t, t0 + 2_000_000 + 130_000, 'newest first');
  const rings = shown.filter((e) => e.kind === 'ring').reverse();
  assert.deepStrictEqual(rings.map((r) => r.note), [
    'viewed, opened 28 s later',
    'viewed 2 times, not opened by Homebridge',
    'not opened by Homebridge',
    'opened 20 s later',
    'not opened by Homebridge',
  ]);
  assert.ok(shown.filter((e) => e.kind !== 'ring').every((e) => e.note === undefined));
});

function platform(extra = {}) {
  const api = fakeApi();
  const p = new ComelitIntercomPlatform(quietLog(), { platform: 'ComelitIntercom', name: 'Comelit Intercom', host: '10.0.0.1', token: 't', ...extra }, api);
  return { p, api };
}

test('recorded: start, rings, mode switches, Doctor Mode opens', async () => {
  const { p } = platform({ doctorMode: 'switch', doctorModeDelaySeconds: 0 });
  p.deviceConfig = { doors: [{ index: 0, name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false }], cameras: [] };
  p.discoverAccessories(p.deviceConfig);
  p.callHandler = { ringingCall: () => ({}), openInCall: async () => ({ confirmed: true }) };
  p.doctorSwitch.service.getCharacteristic('on').set(true);
  p.doctorSwitch.service.getCharacteristic('on').set(true); // on again: not a second row
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await new Promise((r) => setTimeout(r, 150));
  p.doctorSwitch.service.getCharacteristic('on').set(false);
  const kinds = p.events.list().map((e) => [e.kind, e.text.replace(/\(until [^)]*\)/, '(until …)')]);
  assert.deepStrictEqual(kinds[0][0], 'start');
  assert.match(kinds[0][1], /Homebridge started the plugin \(plugin \d/);
  assert.deepStrictEqual(kinds.slice(1).map((k) => k[0]), ['mode', 'ring', 'open', 'mode'], JSON.stringify(kinds));
  assert.match(kinds[1][1], /^Doctor Mode on \(until …\)$/);
  assert.strictEqual(kinds[3][1], "Door 'Entrance lock' opened by Doctor Mode");
  assert.strictEqual(kinds[4][1], 'Doctor Mode off: turned off');
  p.doctorSwitch.dispose();
});

test('recorded: unlocks from HomeKit, refused ones, and failures', async () => {
  const { p } = platform({ ringWindowSeconds: 90 });
  p.unreachable = () => true; // not connected: the log says so, but no "refused" event (the open itself is noted)
  p.discoverAccessories({ doors: [{ index: 0, name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false }], cameras: [] });
  const lock = [...p.lockAccessories.values()][0];
  lock.checkReachable = () => undefined;
  const target = lock.service.getCharacteristic(p.Characteristic.LockTargetState);
  assert.throws(() => target.set(0), 'not connected and no ring: refused');
  assert.strictEqual(p.events.list().filter((e) => e.kind === 'refused').length, 1, 'one attempt, one row');
  p.events.list().splice(0); // (a copy: does not clear)
  p.unreachable = () => false;
  assert.throws(() => target.set(0), 'refused: no ring');
  p.lastRingAt = Date.now();
  p.openDoor = async () => ({ confirmed: true });
  target.set(0);
  await new Promise((r) => setTimeout(r, 20));
  lock.opening = false;
  p.openDoor = async () => { throw new Error('Not connected'); };
  await lock.triggerOpen();
  const got = p.events.list().filter((e) => e.kind !== 'start').map((e) => [e.kind, e.text]);
  assert.deepStrictEqual(got, [
    ['refused', "Unlock of 'Entrance lock' from HomeKit refused: no ring or live view in the last 90 s"],
    // the second refusal within the log's quiet period isn't repeated
    ['open', "Door 'Entrance lock' opened from HomeKit"],
    ['open-failed', "Unlock of 'Entrance lock' from HomeKit failed (Not connected)"],
  ]);
});

test('recorded: the plugin keeps the file in Homebridge storage, where the settings page reads it', async () => {
  const dir = tmpDir();
  const api = fakeApi();
  api.user = { storagePath: () => dir };
  const p = new ComelitIntercomPlatform(quietLog(), { platform: 'ComelitIntercom', name: 'Comelit Intercom' }, api);
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await p.events.flush();
  assert.deepStrictEqual(readEvents(path.join(dir, EVENTS_FILE)).map((e) => e.kind), ['start', 'ring']);
});

test('settings page server: /events answers with the history, newest first, rings described', async () => {
  const dir = tmpDir();
  const t0 = Date.now() - 60_000;
  fs.writeFileSync(path.join(dir, EVENTS_FILE), JSON.stringify([{ t: t0, kind: 'ring', text: 'Ring' }, { t: t0 + 5_000, kind: 'open', text: 'opened' }]));
  const { fork } = require('node:child_process');
  const child = fork(path.join(__dirname, '..', 'homebridge-ui', 'server.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, HOMEBRIDGE_STORAGE_PATH: dir } });
  try {
    await new Promise((r) => child.on('message', (m) => m.action === 'ready' && r()));
    const reply = await new Promise((resolve) => {
      child.on('message', (m) => m.action === 'response' && m.payload.requestId === 1 && resolve(m.payload));
      child.send({ action: 'request', requestId: 1, path: '/events', body: {} });
    });
    assert.strictEqual(reply.success, true);
    assert.deepStrictEqual(reply.data.events.map((e) => [e.kind, e.note]), [['open', undefined], ['ring', 'opened 5 s later']]);
  } finally {
    child.kill();
  }
});

test('settings page: Settings and Recent events tabs; the settings form is hidden on Recent events', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="tabSettings"/);
  assert.match(html, /id="tabEvents"/);
  assert.match(html, /homebridge\.hideSchemaForm\(\)/);
  assert.match(html, /request\('\/events', \{ name:/, "asks for this intercom's events");
  assert.match(html, /max-height: 360px; overflow-y: auto/, 'a box that scrolls, so the page stays short');
  for (const r of ['0', '1', '7', '30', 'all']) assert.match(html, new RegExp(`<option value="${r}">`), r);
  assert.match(html, /body\.dark-mode \.form-select option \{ background-color: #333; color: #eee; \}/, "the menus' open lists in Homebridge's dark-menu colours");
});

test('settings page: several intercoms (2.8.0)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
  for (const id of ['which', 'addIntercom', 'removeIntercom', 'intercomNotes']) assert.match(html, new RegExp(`id="${id}"`), id);
  // Homebridge merges each block sent into the one at its place: settings a block lost are sent as
  // undefined, so another intercom's settings (actuators, say) don't stay behind.
  assert.match(html, /out\[k\] = undefined/);
  assert.match(html, /\[blocks\[i\], \.\.\.blocks\.filter\(\(_, j\) => j !== i\)\]/, 'the chosen intercom moves to the front, which the form edits');
  assert.match(html, /Child Bridge Config/, 'says where to give each intercom its own child bridge');
});

// Release review (2.7.0): two intercoms, actuator presses, the save at shutdown.

test('each intercom has its own events file (two child bridges share the storage folder)', async () => {
  const { eventsFileFor } = require('../dist/events');
  assert.strictEqual(eventsFileFor(undefined), EVENTS_FILE);
  assert.strictEqual(eventsFileFor(' Comelit Intercom '), EVENTS_FILE, 'the default name keeps the file it always had');
  assert.strictEqual(eventsFileFor('Back Gate'), 'comelit-doorbell-events-back-gate.json');
  assert.strictEqual(eventsFileFor('../../etc'), 'comelit-doorbell-events-etc.json', 'no path in the name');
  assert.strictEqual(eventsFileFor('!!!'), EVENTS_FILE);
  const dir = tmpDir();
  const make = (name) => {
    const api = fakeApi();
    api.user = { storagePath: () => dir };
    return new ComelitIntercomPlatform(quietLog(), { platform: 'ComelitIntercom', name }, api);
  };
  const a = make('Comelit Intercom');
  const b = make('Back Gate');
  a.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await a.events.flush();
  await b.events.flush();
  assert.deepStrictEqual(readEvents(path.join(dir, EVENTS_FILE)).map((e) => e.kind), ['start', 'ring']);
  assert.deepStrictEqual(readEvents(path.join(dir, 'comelit-doorbell-events-back-gate.json')).map((e) => e.kind), ['start'], 'not overwritten');
});

test('an actuator shown as a switch or light is its own event, not a door open after a ring', () => {
  const t0 = Date.now();
  const shown = describeEvents([
    { t: t0, kind: 'ring', text: 'Ring' },
    { t: t0 + 10_000, kind: 'actuator', text: "Actuator 'Stair light' turned on from HomeKit" },
  ]);
  assert.strictEqual(shown.find((e) => e.kind === 'ring').note, 'not opened by Homebridge');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify([{ t: 1, kind: 'actuator', text: 'a' }]));
  assert.strictEqual(readEvents(path.join(dir, 'x.json')).length, 1, 'a known kind');
});

test('at shutdown the history is written at once (Homebridge may not wait)', () => {
  const dir = tmpDir();
  const file = path.join(dir, EVENTS_FILE);
  const log = new EventLog(file);
  log.add('ring', 'Ring');
  log.flushSync();
  assert.deepStrictEqual(readEvents(file).map((e) => e.kind), ['ring'], 'on disk before any timer');
});

test('events: after a Name change, the events kept under the old Name are taken over once', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ev-'));
  const { EventLog: Log } = require('../dist/events');
  const old = path.join(dir, 'old.json');
  fs.writeFileSync(old, JSON.stringify([{ t: Date.now() - 1000, kind: 'ring', text: 'Ring' }]));
  const log = new Log(path.join(dir, 'new.json'));
  log.add('start', 'started');
  assert.strictEqual(log.adopt(old), 1);
  assert.strictEqual(log.adopt(old), 0, 'not twice');
  assert.deepStrictEqual(log.list().map((e) => e.kind).sort(), ['ring', 'start']);
  assert.strictEqual(log.adopt(path.join(dir, 'missing.json')), 0);
});
