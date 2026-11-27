const test = require('node:test');
const assert = require('node:assert');
const { ComelitIntercomPlatform, OFFLINE_AFTER_MS } = require('../dist/platform');
const { quietLog, fakeApi } = require('./helpers');


const deviceConfig = { aptAddress: 'SB000002', aptSubaddress: 3, doors: [{ index: 0, name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, isActuator: false }], cameras: [] };

function platform(extra = {}) {
  const api = fakeApi();
  const p = new ComelitIntercomPlatform(quietLog(), { platform: 'ComelitIntercom', name: 'Comelit Intercom', ...extra }, api);
  return { api, p };
}

test('accessories are registered once across reconnects (fresh install)', () => {
  const { api, p } = platform();
  p.discoverAccessories(deviceConfig);
  p.discoverAccessories(deviceConfig);
  p.discoverAccessories(deviceConfig);
  assert.strictEqual(api.duplicates, 0);
  assert.deepStrictEqual([...api.registered].sort(), ['uuid:homebridge-comelit-intercom-doorbell', 'uuid:homebridge-comelit-intercom-lock-0']);
});

test('accessory UUIDs keep the original plugin name as seed', () => {
  const { api, p } = platform();
  p.discoverAccessories(deviceConfig);
  assert.ok([...api.registered].every((u) => u.startsWith('uuid:homebridge-comelit-intercom-')));
});

test('accessories that disappear from the intercom are removed', () => {
  const { api, p } = platform();
  p.discoverAccessories(deviceConfig);
  p.discoverAccessories({ ...deviceConfig, doors: [] });
  assert.deepStrictEqual([...api.registered], ['uuid:homebridge-comelit-intercom-doorbell']);
});

function lockOf(p) {
  p.discoverAccessories(deviceConfig);
  return [...p.lockAccessories.values()][0];
}

test('a refused open leaves the lock Locked; a confirmed one shows Unlocked', async () => {
  const { p } = platform();
  const lock = lockOf(p);
  p.openDoor = async () => { throw new Error('intercom refused (cause 8, busy)'); };
  await lock.triggerOpen();
  assert.strictEqual(lock.lockState, 1);
  p.openDoor = async () => ({ confirmed: true });
  await lock.triggerOpen();
  assert.strictEqual(lock.lockState, 0);
});

test('unlock is refused outside the ring window, allowed after a ring; lock is never blocked', () => {
  const { p } = platform();
  const lock = lockOf(p);
  let opened = 0;
  lock.triggerOpen = async () => { opened++; };
  const target = lock.service.getCharacteristic(p.Characteristic.LockTargetState);
  assert.throws(() => target.set(0));
  assert.doesNotThrow(() => target.set(1));
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002', timestamp: 0 });
  assert.doesNotThrow(() => target.set(0));
  assert.strictEqual(opened, 1);
});

test('ringWindowSeconds 0 allows unlocking at any time', () => {
  const { p } = platform({ ringWindowSeconds: 0 });
  assert.strictEqual(p.isUnlockAllowed(), true);
});

test('reconnects with the same doors do not rebuild or re-save the accessories', () => {
  const { api, p } = platform();
  let updates = 0;
  api.updatePlatformAccessories = () => { updates++; };
  p.discoverAccessories(deviceConfig);
  updates = 0; // the first build notes each tile's name with it
  const lock = [...p.lockAccessories.values()][0];
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  assert.strictEqual(updates, 0);
  assert.strictEqual([...p.lockAccessories.values()][0], lock);
});

test('a second tap while the door is opening sends one open', async () => {
  const { p } = platform({ ringWindowSeconds: 0 });
  const lock = lockOf(p);
  let opens = 0;
  let finish;
  p.openDoor = () => { opens++; return new Promise((r) => (finish = r)); };
  const target = lock.service.getCharacteristic(p.Characteristic.LockTargetState);
  target.set(0);
  target.set(0);
  assert.strictEqual(opens, 1);
  finish({ confirmed: true });
  await new Promise((r) => setImmediate(r));
  target.set(0);
  assert.strictEqual(opens, 2);
});

test('after shutdown no reconnect is scheduled', () => {
  const { p } = platform();
  p.teardown();
  p.scheduleReconnect(true);
  assert.strictEqual(p.reconnectTimer, undefined);
});

function doctor(extra) {
  const { api, p } = platform({ doctorModeDelaySeconds: 0, ...extra });
  p.deviceConfig = deviceConfig;
  p.discoverAccessories(deviceConfig);
  const opened = [];
  p.callHandler = { ringingCall: () => ({}), openInCall: async (door, force) => { opened.push([door.name, force]); return { confirmed: true }; } };
  const ring = async () => {
    p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
    await new Promise((r) => setTimeout(r, 20));
  };
  return { api, p, opened, ring };
}

test('doctor mode off: a ring opens nothing', async () => {
  const { opened, ring } = doctor({});
  await ring();
  assert.deepStrictEqual(opened, []);
});

test('doctor mode always: a ring answers and opens the first door inside the call', async () => {
  const { opened, ring, api } = doctor({ doctorMode: 'always' });
  await ring();
  assert.deepStrictEqual(opened, [[deviceConfig.doors[0].name, true]]);
  assert.ok(![...api.registered].some((u) => u.includes('doctor-mode')), 'no switch');
});

test('doctor mode switch: opens only while the HomeKit switch is on', async () => {
  const { p, opened, ring, api } = doctor({ doctorMode: 'switch' });
  assert.ok([...api.registered].some((u) => u.includes('doctor-mode')), 'switch accessory');
  await ring();
  assert.deepStrictEqual(opened, [], 'switch off');
  p.doctorSwitch.accessory.context.on = true;
  await ring();
  assert.strictEqual(opened.length, 1);
  // a call that is already over (answered on a phone) is not opened
  p.doctorSwitch.accessory.context.on = true;
  p.callHandler.ringingCall = () => undefined;
  await ring();
  assert.strictEqual(opened.length, 1);
});

test('doctor mode / Next Visitor: only our own live view call is up (no ring to open in): not opening', async () => {
  const { opened, ring, p } = doctor({ doctorMode: 'always' });
  // The call handler has our own call to the panel, but no ring: ringingCall() finds none.
  p.callHandler.activeCall = () => ({ outbound: true });
  p.callHandler.ringingCall = () => undefined;
  await ring();
  assert.deepStrictEqual(opened, []);
});

test('cached accessories answer HomeKit before the first connection (beta.26)', async () => {
  const { api, p } = platform({ ringWindowSeconds: 0 });
  const cached = new api.platformAccessory('Entrance lock', 'uuid:homebridge-comelit-intercom-lock-0');
  cached.context.door = deviceConfig.doors[0];
  p.configureAccessory(cached);
  p.configureAccessory(new api.platformAccessory('Comelit Intercom', 'uuid:homebridge-comelit-intercom-doorbell'));
  p.restoreCached();
  assert.strictEqual(api.duplicates, 0);
  const lock = [...p.lockAccessories.values()][0];
  assert.ok(lock, 'the lock has its handlers');
  const target = lock.service.getCharacteristic(p.Characteristic.LockTargetState);
  target.set(0);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(lock.lockState, 1, 'not connected: stays Locked');
  // the first connection, with the same doors, keeps them
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  assert.strictEqual([...p.lockAccessories.values()][0], lock);
});

test('shutting down while connecting closes the new connection (beta.26)', async () => {
  const net = require('node:net');
  let closed;
  const gone = new Promise((r) => (closed = r));
  const server = net.createServer((s) => { s.on('close', closed); s.on('error', () => undefined); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { p } = platform({ host: '127.0.0.1', port: server.address().port, token: 'x' });
  const setup = p.setupDevice();
  p.teardown();
  await setup;
  await gone;
  assert.strictEqual(p.client, undefined);
  assert.strictEqual(p.reconnectTimer, undefined);
  server.close();
});

test('restored accessories with two cameras in another order are not rebuilt; the cache gets renamed doors (beta.26)', () => {
  const { api, p } = platform();
  const config = { ...deviceConfig, cameras: [{ id: 'a', name: 'Cam A' }, { id: 'b', name: 'Cam B' }] };
  const lockA = new api.platformAccessory('Entrance lock', 'uuid:homebridge-comelit-intercom-lock-0');
  lockA.context.door = { ...deviceConfig.doors[0] };
  p.configureAccessory(lockA);
  for (const c of [...config.cameras].reverse()) {
    const a = new api.platformAccessory(c.name, `uuid:homebridge-comelit-intercom-camera-${c.id}`);
    a.context.camera = c;
    p.configureAccessory(a);
  }
  p.restoreCached();
  const lock = [...p.lockAccessories.values()][0];
  p.discoverAccessories(JSON.parse(JSON.stringify(config)));
  assert.strictEqual([...p.lockAccessories.values()][0], lock, 'not rebuilt');
  const renamed = { ...config, doors: [{ ...deviceConfig.doors[0], name: 'Front door' }] };
  p.discoverAccessories(renamed);
  assert.strictEqual(lockA.context.door.name, 'Front door');
});

test('the lock shows No Response after 30 s without the intercom, and recovers (beta.28)', () => {
  const { p } = platform({ ringWindowSeconds: 0 });
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  const lock = [...p.lockAccessories.values()][0];
  const current = lock.service.getCharacteristic(p.Characteristic.LockCurrentState);
  const target = lock.service.getCharacteristic(p.Characteristic.LockTargetState);
  const noResponse = (e) => e.hapStatus === -70402;
  // within the grace period: normal
  assert.strictEqual(p.unreachable(), false);
  assert.strictEqual(current.get(), 1);
  // unreachable for longer than 30 s
  p.downSince = Date.now() - 31_000;
  assert.throws(() => current.get(), noResponse);
  assert.throws(() => target.get(), noResponse);
  assert.throws(() => target.set(0), noResponse);
  // back: refresh() pushes the state again
  p.downSince = undefined;
  lock.refresh();
  assert.strictEqual(current.get(), 1);
  assert.strictEqual(current.value, 1);
});

// ─── Next Visitor switch (2.1.1-beta.2) ───

const nextOn = (p) => p.nextVisitor.service.getCharacteristic('on');

test('next visitor: no switch unless the setting is on', () => {
  const { api } = doctor({});
  assert.ok(![...api.registered].some((u) => u.includes('next-visitor')));
});

test('next visitor: the next ring opens the door, then the switch turns itself off', async () => {
  const { p, opened, ring, api } = doctor({ nextVisitorSwitch: true });
  assert.ok([...api.registered].some((u) => u.includes('next-visitor')), 'switch accessory');
  await ring();
  assert.deepStrictEqual(opened, [], 'off: nothing opens');
  nextOn(p).set(true);
  assert.strictEqual(nextOn(p).get(), true);
  assert.ok(p.nextVisitor.accessory.context.until > Date.now() + 119 * 60_000, 'time limit 2 h');
  await ring();
  assert.deepStrictEqual(opened, [[deviceConfig.doors[0].name, true]], 'opened inside the call');
  assert.strictEqual(nextOn(p).get(), false, 'used: off');
  assert.strictEqual(nextOn(p).value, false, 'HomeKit told');
  await ring();
  assert.strictEqual(opened.length, 1, 'later rings ring normally');
});

test('next visitor: stays on when the open fails or the call was answered elsewhere', async () => {
  const { p, opened, ring } = doctor({ nextVisitorSwitch: true });
  nextOn(p).set(true);
  p.callHandler.ringingCall = () => undefined; // answered on a phone first
  await ring();
  assert.strictEqual(nextOn(p).get(), true);
  p.callHandler.ringingCall = () => ({});
  p.callHandler.openInCall = async () => { throw new Error('Not connected'); };
  await ring();
  assert.strictEqual(nextOn(p).get(), true);
  p.callHandler.openInCall = async () => null; // no call to answer
  await ring();
  assert.strictEqual(nextOn(p).get(), true);
  assert.deepStrictEqual(opened, []);
});

test('next visitor with doctor mode on: one open per ring; Next Visitor counts as used', async () => {
  const { p, opened, ring } = doctor({ doctorMode: 'switch', nextVisitorSwitch: true });
  p.doctorSwitch.accessory.context.on = true;
  nextOn(p).set(true);
  await ring();
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(nextOn(p).get(), false);
  assert.strictEqual(p.doctorSwitch.on, true, 'doctor mode unchanged');
});

test('next visitor: turns itself off at its time limit, also across a restart', async () => {
  const { NextVisitorSwitch } = require('../dist/accessories/nextVisitorSwitch');
  const { api, p } = platform({ nextVisitorSwitch: true });
  const acc = new api.platformAccessory('Next', 'uuid:x');
  const sw = new NextVisitorSwitch(p, acc, 50);
  sw.service.getCharacteristic('on').set(true);
  assert.strictEqual(sw.on, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sw.on, false, 'time limit');
  // restart while on, limit not yet reached: stays on, and its timer is set again
  acc.context.on = true;
  acc.context.until = Date.now() + 60;
  const after = new NextVisitorSwitch(p, acc, 50);
  assert.strictEqual(after.on, true);
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(after.on, false);
  // restart after the limit passed: off at once
  acc.context.on = true;
  acc.context.until = Date.now() - 1;
  assert.strictEqual(new NextVisitorSwitch(p, acc, 50).on, false);
});

test('next visitor: a rebuild of the accessories stops the old time limit', () => {
  const { p } = doctor({ nextVisitorSwitch: true });
  nextOn(p).set(true);
  const old = p.nextVisitor;
  assert.ok(old.timer);
  p.builtFrom = undefined;
  p.discoverAccessories(JSON.parse(JSON.stringify({ ...deviceConfig, doors: [{ ...deviceConfig.doors[0], name: 'Front door' }] })));
  assert.notStrictEqual(p.nextVisitor, old);
  assert.strictEqual(old.timer, undefined, 'old timer cleared');
  assert.strictEqual(p.nextVisitor.on, true, 'state kept');
  assert.ok(p.nextVisitor.timer, 'new object keeps the limit');
  p.nextVisitor.dispose();
});

test('next visitor: turning it off during the delay cancels the open (review)', async () => {
  const { p, opened } = doctor({ nextVisitorSwitch: true, doctorModeDelaySeconds: 0.05 });
  nextOn(p).set(true);
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  nextOn(p).set(false);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(opened, []);
});

test('next visitor: a ring from before it was turned on does not use it up (review)', async () => {
  const { p, opened } = doctor({ doctorMode: 'switch', nextVisitorSwitch: true, doctorModeDelaySeconds: 0.05 });
  p.doctorSwitch.accessory.context.on = true;
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' }); // doctor mode opens this one
  nextOn(p).set(true); // for a guest coming later
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(nextOn(p).get(), true, 'still on for the guest');
});

test('next visitor: the log says which switch opened the door (review)', async () => {
  const { p, ring } = doctor({ doctorMode: 'switch', nextVisitorSwitch: true });
  const lines = [];
  p.log = { info: (m) => lines.push(m), warn() {}, error() {}, debug() {} };
  nextOn(p).set(true);
  await ring();
  assert.ok(lines.some((l) => l.startsWith("Next visitor: opening 'Entrance lock'")), lines.join('\n'));
  p.doctorSwitch.accessory.context.on = true;
  nextOn(p).set(true);
  await ring();
  assert.ok(lines.some((l) => l.startsWith("Doctor mode and Next visitor: opening")), lines.join('\n'));
});

// ─── 2.2.0 review ───

test('doctor mode: turning the switch off during the delay cancels the open (2.2.0 review)', async () => {
  const { p, opened } = doctor({ doctorMode: 'switch', doctorModeDelaySeconds: 0.05 });
  p.doctorSwitch.accessory.context.on = true;
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  p.doctorSwitch.accessory.context.on = false;
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(opened, []);
});

test('doctor mode: one open per ring even if the ring repeats during the delay (2.2.0 review)', async () => {
  const { p, opened } = doctor({ doctorMode: 'always', doctorModeDelaySeconds: 0.05 });
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(opened.length, 1);
});

test('only a ring opens the unlock window, not other intercom events (2.2.0 review)', () => {
  const { p } = platform();
  for (const eventType of ['missed_call', 'door_opened', 'something_else']) {
    p.onEvent({ eventType, aptAddress: 'SB000002' });
  }
  assert.strictEqual(p.isUnlockAllowed(), false);
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  assert.strictEqual(p.isUnlockAllowed(), true);
});

test("a door the intercom no longer has leaves the plugin's lock list (2.2.0 review)", () => {
  const { p } = platform();
  p.discoverAccessories({ ...deviceConfig, doors: [...deviceConfig.doors, { index: 1, name: 'Back', aptAddress: 'SB100001', outputIndex: 2, isActuator: false }] });
  assert.strictEqual(p.lockAccessories.size, 2);
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  assert.strictEqual(p.lockAccessories.size, 1);
});

test('recording: the call listener reaches a camera made after it (first connect after a restart, 2.3.0)', () => {
  const { p } = platform({ camera: true, recording: true });
  const listener = p.recordingListener(p.settings);
  assert.ok(listener, 'set even before the camera exists');
  listener.video('call', Buffer.alloc(1)); // no camera yet: ignored
  const heard = [];
  p.camera = { recorder: { onCallVideo: (c) => heard.push(['video', c]), onCallEnded: (c) => heard.push(['ended', c]) } };
  listener.video('call', Buffer.alloc(1));
  listener.ended('call');
  assert.deepStrictEqual(heard, [['video', 'call'], ['ended', 'call']]);
  assert.strictEqual(platform({ camera: true }).p.recordingListener(platform({ camera: true }).p.settings), undefined);
});

test('next visitor: turned off after the delay, while the call is being answered, still cancels (2.3.0)', async () => {
  const { p, opened } = doctor({ nextVisitorSwitch: true });
  const asked = [];
  p.callHandler.openInCall = async (door, force, stillWanted) => {
    nextOn(p).set(false); // turned off while answering
    asked.push(stillWanted());
    return null; // openInCall hangs up when no longer wanted
  };
  nextOn(p).set(true);
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepStrictEqual(asked, [false], 'asked again just before the open');
  assert.deepStrictEqual(opened, []);
});

test('the lock shows Unlocked at once while the open is on its way, and Locked again if the intercom refuses (2.3.0-beta.6)', async () => {
  const { p } = platform();
  const lock = lockOf(p);
  let finish;
  p.openDoor = () => new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const opening = lock.triggerOpen();
  assert.strictEqual(lock.lockState, 0, 'Unlocked before the intercom answers');
  finish.reject(new Error('intercom refused (cause 8, busy)'));
  await opening;
  assert.strictEqual(lock.lockState, 1, 'Locked again after a refusal');
});

test('debug log: renewals every 2 min are summed up once an hour instead of logged each time; none answered is a warning (2.3.0-beta.6)', async () => {
  const { p } = platform();
  const lines = [];
  const warnings = [];
  p.log = { ...p.log, debug: (m) => lines.push(m), info: () => undefined, warn: (m) => warnings.push(m) };
  p.deviceConfig = deviceConfig;
  const client = { getChannel: () => ({}), sendBinary: async () => undefined };
  await p.reregister(client);
  await p.reregister(client);
  assert.deepStrictEqual(lines, [], 'nothing per renewal');
  // A reconnect in the hour: the old listener's count is kept.
  let checks = 2;
  p.vipListener = { takeRenewalChecks: () => { const n = checks; checks = 0; return n; }, stop: async () => undefined };
  p.scheduleReconnect = () => undefined;
  p.onClientDisconnect(true);
  p.logRoutineSummary();
  assert.match(lines.at(-1), /registration renewed 2 time\(s\), 2 renewal check\(s\) from the intercom answered, 0 planned reconnect\(s\)$/);
  assert.deepStrictEqual(warnings, []);
  await p.reregister(client);
  p.logRoutineSummary();
  assert.match(warnings[0], /renewed 1 time\(s\), 0 renewal check\(s\).*answered none of the renewals/, 'renewals with no answer at all are worth a warning');
});

test('talk-back ffmpeg starts without buffering, so the door hears the phone sooner (2.3.0-beta.6)', () => {
  const { TALK_BACK_ARGS } = require('../dist/camera');
  const j = TALK_BACK_ARGS.join(' ');
  for (const opt of ['-fflags nobuffer', '-flags low_delay', '-probesize 512', '-analyzeduration 0', '-max_delay 0', '-reorder_queue_size 0', '-flush_packets 1']) {
    assert.ok(j.includes(opt), opt);
  }
  assert.ok(j.indexOf('-fflags nobuffer') < j.indexOf('-i pipe:0'), 'input options before the input');
});

test('lock: an earlier open\'s relock doesn\'t show Locked while a second open is on its way (2.3.0-beta.6 review)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { p } = platform();
  const lock = lockOf(p);
  p.openDoor = async () => ({ confirmed: true });
  await lock.triggerOpen(); // relock due in 3 s
  t.mock.timers.tick(1000);
  let finish;
  p.openDoor = () => new Promise((resolve) => { finish = resolve; });
  const second = lock.triggerOpen();
  t.mock.timers.tick(2500); // past the first open's relock
  assert.strictEqual(lock.lockState, 0, 'still Unlocked during the second open');
  finish({ confirmed: true });
  await second;
  t.mock.timers.tick(3000);
  assert.strictEqual(lock.lockState, 1);
});

test('buzzes per unlock: the release is sent openRepeat times, openRepeatSeconds apart; a later failure does not stop the rest', async () => {
  const { p } = platform({ openRepeat: 3, openRepeatSeconds: 1 });
  const at = [];
  let n = 0;
  p.openOnce = async () => {
    at.push(Date.now());
    await new Promise((r) => setTimeout(r, 300)); // the intercom takes a moment to confirm
    if (++n === 2) throw new Error('busy');
    return { confirmed: true };
  };
  const t0 = Date.now();
  const result = await p.openDoor(deviceConfig.doors[0]);
  assert.deepStrictEqual(result, { confirmed: true });
  assert.strictEqual(at.length, 3);
  // start to start: the 300 ms the intercom takes to confirm is not added to the gap
  for (const gap of [at[1] - at[0], at[2] - at[1]]) assert.ok(gap >= 950 && gap < 1250, `about 1 s apart (${gap} ms)`);
  assert.ok(Date.now() - t0 < 4000);
});

test('buzzes per unlock: a refused first open sends no more; the default is one buzz', async () => {
  const { p } = platform({ openRepeat: 3, openRepeatSeconds: 1 });
  let n = 0;
  p.openOnce = async () => { n++; throw new Error('intercom refused (cause 8, busy)'); };
  await assert.rejects(p.openDoor(deviceConfig.doors[0]), /refused/);
  assert.strictEqual(n, 1);
  const one = platform().p;
  let m = 0;
  one.openOnce = async () => { m++; return { confirmed: true }; };
  await one.openDoor(deviceConfig.doors[0]);
  assert.strictEqual(m, 1);
  assert.strictEqual(one.settings.openRepeatMs, 6000);
});

test('buzzes per unlock: doctor mode spaces its buzzes start to start too', async () => {
  const { p } = doctor({ doctorMode: 'always', openRepeat: 2, openRepeatSeconds: 1 });
  const at = [];
  p.callHandler.openInCall = async () => {
    at.push(Date.now());
    await new Promise((r) => setTimeout(r, 400)); // answering and the open's confirmation take a moment
    return { confirmed: true };
  };
  p.openOnce = async () => { at.push(Date.now()); return { confirmed: true }; };
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(at.length, 2);
  const gap = at[1] - at[0];
  assert.ok(gap >= 950 && gap < 1250, `about 1 s from the start of the first open (${gap} ms)`);
});

test('buzzes per unlock: the time between buzzes is capped at 15 s', () => {
  assert.strictEqual(platform({ openRepeatSeconds: 15 }).p.settings.openRepeatMs, 15000);
  assert.strictEqual(platform({ openRepeatSeconds: 20 }).p.settings.openRepeatMs, 6000, 'over the cap: the default');
});

test('the lock during a live view without a ring: all its buzzes inside one pause of the view, with the busy retry', async () => {
  const { p } = platform({ openRepeat: 3, openRepeatSeconds: 1 });
  const events = [];
  p.callHandler = {
    ringingCall: () => undefined,
    openWithLiveViewPaused: async (open) => { events.push('pause'); const r = await open(); events.push('resume'); return r; },
  };
  p.openOnce = async (door, retryBusy) => { events.push(`open retry=${retryBusy}`); return { confirmed: true }; };
  assert.deepStrictEqual(await p.openDoor(deviceConfig.doors[0]), { confirmed: true });
  assert.deepStrictEqual(events, ['pause', 'open retry=true', 'open retry=true', 'open retry=true', 'resume']);
});

test('the lock: a ring is not paused around (opened inside the ring); no live view: the normal way', async () => {
  for (const [ring, paused] of [[{}, null], [undefined, null]]) {
    const { p } = platform();
    const events = [];
    p.callHandler = { ringingCall: () => ring, openWithLiveViewPaused: async (open) => (events.push('pause'), paused === null ? null : open()) };
    p.openOnce = async (door, retryBusy) => { events.push(`open retry=${retryBusy}`); return { confirmed: true }; };
    await p.openDoor(deviceConfig.doors[0]);
    assert.deepStrictEqual(events, ring ? ['open retry=false'] : ['pause', 'open retry=false']);
  }
});

test("doctor mode's extra buzzes never pause a live view", async () => {
  const { p } = doctor({ doctorMode: 'always', openRepeat: 2, openRepeatSeconds: 1 });
  let paused = 0;
  p.callHandler.openWithLiveViewPaused = async () => { paused++; return null; };
  const retries = [];
  p.openOnce = async (door, retryBusy) => { retries.push(retryBusy); return { confirmed: true }; };
  p.onEvent({ eventType: 'doorbell_ring', aptAddress: 'SB000002' });
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepStrictEqual(retries, [false]);
  assert.strictEqual(paused, 0);
});

test("an actuator's unconfirmed open is logged as info (actuators never confirm), an entrance's as a warning", async () => {
  const lines = [];
  const log = Object.assign((...a) => lines.push(['log', a.join(' ')]), {
    info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]), debug: () => undefined, success: () => undefined,
  });
  const api = fakeApi();
  const p = new ComelitIntercomPlatform(log, { platform: 'ComelitIntercom', name: 'Comelit Intercom' }, api);
  p.discoverAccessories({ ...deviceConfig, doors: [{ ...deviceConfig.doors[0], name: 'Actuator', isActuator: true }] });
  const lock = [...p.lockAccessories.values()][0];
  p.openDoor = async () => ({ confirmed: false });
  await lock.triggerOpen();
  assert.ok(lines.some(([l, m]) => l === 'info' && /Actuator': open sent \(an actuator gives no confirmation\)/.test(m)), JSON.stringify(lines));
  assert.ok(!lines.some(([l]) => l === 'warn'));
});

test('unlock: a live view without a ring counts like a ring (while it shows the entrance, and for the window after)', () => {
  const { p } = platform(); // window 90 s
  const live = { showing: false, endedAt: 0 };
  p.callHandler = { liveViewShowing: () => live.showing, get liveViewEndedAt() { return live.endedAt; }, ringingCall: () => undefined };
  assert.strictEqual(p.isUnlockAllowed(), false, 'no ring, no live view');
  live.showing = true;
  assert.strictEqual(p.isUnlockAllowed(), true, 'a live view showing the entrance');
  live.showing = false;
  live.endedAt = Date.now() - 30_000;
  assert.strictEqual(p.isUnlockAllowed(), true, '30 s after it closed');
  live.endedAt = Date.now() - 120_000;
  assert.strictEqual(p.isUnlockAllowed(), false, '2 min after it closed');
  const any = platform({ ringWindowSeconds: 0 }).p;
  assert.strictEqual(any.isUnlockAllowed(), true, '0: at any time, as before');
});

test('unlock: refused outside a ring and a live view (the message says so), allowed while a live view shows the entrance', () => {
  const { p } = platform();
  const lock = lockOf(p);
  const warnings = [];
  p.log.warn = (m) => warnings.push(m);
  let opened = 0;
  lock.triggerOpen = async () => { opened++; };
  let showing = false;
  p.callHandler = { liveViewShowing: () => showing, liveViewEndedAt: 0, ringingCall: () => undefined };
  const target = lock.service.getCharacteristic(p.Characteristic.LockTargetState);
  assert.throws(() => target.set(0));
  assert.match(warnings[0], /no ring or live view in the last 90 s/);
  showing = true;
  assert.doesNotThrow(() => target.set(0));
  assert.strictEqual(opened, 1);
});

// 2.5.0: doctor mode's time limit, and contact sensors for doctor mode and Next Visitor.

test('doctor mode switch: turns itself off at its time limit, also across a restart; 0 means never', async () => {
  const { DoctorModeSwitch } = require('../dist/accessories/doctorModeSwitch');
  const { api, p } = platform({ doctorMode: 'switch' });
  const acc = new api.platformAccessory('Doctor', 'uuid:d');
  const sw = new DoctorModeSwitch(p, acc, 50);
  sw.service.getCharacteristic('on').set(true);
  assert.strictEqual(sw.on, true);
  assert.ok(acc.context.until > Date.now(), 'time limit kept');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sw.on, false, 'time limit');
  assert.strictEqual(sw.service.getCharacteristic('on').value, false, 'HomeKit told');
  // restart while on, limit not yet reached: stays on until it
  acc.context.on = true;
  acc.context.until = Date.now() + 60;
  const after = new DoctorModeSwitch(p, acc, 50);
  assert.strictEqual(after.on, true);
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(after.on, false);
  // restart after the limit passed: off at once
  acc.context.on = true;
  acc.context.until = Date.now() - 1;
  assert.strictEqual(new DoctorModeSwitch(p, acc, 50).on, false);
  // a limit stored with a longer setting: never more than the configured limit
  acc.context.on = true;
  acc.context.until = Date.now() + 60_000;
  const capped = new DoctorModeSwitch(p, acc, 50);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(capped.on, false, 'capped at the current limit');
  // 0: no time limit
  const never = new DoctorModeSwitch(p, acc, 0);
  never.service.getCharacteristic('on').set(true);
  assert.strictEqual(acc.context.until, undefined);
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(never.on, true, 'stays on');
  never.dispose();
});

test('doctor mode switch: on from before the update (no time limit stored) gets one starting now', async () => {
  const { DoctorModeSwitch } = require('../dist/accessories/doctorModeSwitch');
  const { api, p } = platform({ doctorMode: 'switch' });
  const acc = new api.platformAccessory('Doctor', 'uuid:d');
  acc.context.on = true; // 2.4.0 kept only this
  const sw = new DoctorModeSwitch(p, acc, 50);
  assert.strictEqual(sw.on, true, 'not turned off at once');
  assert.ok(acc.context.until > Date.now());
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sw.on, false);
  // a limit stored earlier, now set to 0: stays on, the stored limit dropped
  acc.context.on = true;
  acc.context.until = Date.now() - 1;
  const zero = new DoctorModeSwitch(p, acc, 0);
  assert.strictEqual(zero.on, true);
  assert.strictEqual(acc.context.until, undefined);
});

test('doctor mode switch: 2 hours by default, from the settings', () => {
  const { p } = doctor({ doctorMode: 'switch' });
  p.doctorSwitch.service.getCharacteristic('on').set(true);
  const left = p.doctorSwitch.accessory.context.until - Date.now();
  assert.ok(left > 119 * 60_000 && left <= 120 * 60_000);
  p.doctorSwitch.dispose();
});

test('contact sensors: only when asked for; Open while the switch is on, Closed while off', async () => {
  const none = doctor({ doctorMode: 'switch', nextVisitorSwitch: true });
  assert.strictEqual(none.p.doctorSwitch.accessory.getService('cs'), undefined);
  assert.strictEqual(none.p.nextVisitor.accessory.getService('cs'), undefined);

  const { p, ring, opened } = doctor({ doctorMode: 'switch', doctorModeSensor: true, nextVisitorSwitch: true, nextVisitorSensor: true });
  const dSensor = p.doctorSwitch.accessory.getService('cs').getCharacteristic(p.Characteristic.ContactSensorState);
  const nSensor = p.nextVisitor.accessory.getService('cs').getCharacteristic(p.Characteristic.ContactSensorState);
  assert.strictEqual(dSensor.get(), 0, 'off: Closed');
  assert.strictEqual(dSensor.value, 0);
  p.doctorSwitch.service.getCharacteristic('on').set(true);
  assert.strictEqual(dSensor.get(), 1, 'on: Open');
  assert.strictEqual(dSensor.value, 1, 'HomeKit told (notification)');
  p.doctorSwitch.service.getCharacteristic('on').set(false);
  assert.strictEqual(dSensor.value, 0);

  nextOn(p).set(true);
  assert.strictEqual(nSensor.value, 1);
  await ring();
  assert.strictEqual(opened.length, 1);
  assert.strictEqual(nSensor.value, 0, 'used: Closed');
});

test('contact sensors: the sensor follows the time limit, and is removed when the setting is turned off', async () => {
  const { DoctorModeSwitch } = require('../dist/accessories/doctorModeSwitch');
  const { api, p } = platform({ doctorMode: 'switch' });
  const acc = new api.platformAccessory('Doctor', 'uuid:d');
  const sw = new DoctorModeSwitch(p, acc, 50, true);
  const sensor = acc.getService('cs').getCharacteristic(p.Characteristic.ContactSensorState);
  sw.service.getCharacteristic('on').set(true);
  assert.strictEqual(sensor.value, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(sensor.value, 0, 'time limit: Closed');
  // restored from the cache with the setting off: the sensor goes
  new DoctorModeSwitch(p, acc, 50, false);
  assert.strictEqual(acc.getService('cs'), undefined);
});

test('contact sensors: turning the setting on or off rebuilds the accessories on the next connect', () => {
  const { p } = doctor({ doctorMode: 'switch' });
  const before = p.doctorSwitch;
  p.settings.doctorModeSensor = true;
  p.discoverAccessories(deviceConfig);
  assert.notStrictEqual(p.doctorSwitch, before);
  assert.ok(p.doctorSwitch.accessory.getService('cs'));
});

// Actuators as a switch or light (setting actuators), e.g. the stair light.

const stairLight = { index: 1, name: 'Stair Light', aptAddress: 'SBIO0255', outputIndex: 0, isActuator: true, moduleIndex: 0 };
const withLight = { ...deviceConfig, doors: [deviceConfig.doors[0], stairLight] };

function logged() {
  const lines = [];
  const log = Object.assign((...a) => lines.push(['log', a.join(' ')]), {
    info: (m) => lines.push(['info', m]), warn: (m) => lines.push(['warn', m]), error: (m) => lines.push(['error', m]), debug: () => undefined, success: () => undefined,
  });
  return { lines, log };
}

test('actuators: one set to light is a lightbulb that sends its command at any time, then shows Off', async () => {
  const { lines, log } = logged();
  const api = fakeApi();
  const p = new ComelitIntercomPlatform(log, { platform: 'ComelitIntercom', name: 'Comelit Intercom', actuators: [{ name: '  stair   light ', type: 'light' }] }, api);
  p.discoverAccessories(withLight);
  assert.deepStrictEqual([...api.registered].sort(), [
    'uuid:homebridge-comelit-intercom-actuator-1', 'uuid:homebridge-comelit-intercom-doorbell', 'uuid:homebridge-comelit-intercom-lock-0',
  ]);
  assert.strictEqual(p.lockAccessories.size, 1, 'only the entrance is a lock');
  const acc = p.accessories.get('uuid:homebridge-comelit-intercom-actuator-1');
  const on = acc.getService('lb').getCharacteristic('on');
  const sent = [];
  p.openOnce = async (door) => { sent.push(door.name); return { confirmed: false }; };
  assert.strictEqual(p.isUnlockAllowed(), false, 'no ring');
  on.set(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(sent, ['Stair Light'], 'sent without a ring');
  assert.strictEqual(on.get(), true, 'shows On for a moment');
  assert.ok(lines.some(([l, m]) => l === 'info' && /Actuator 'Stair Light': on \(sent/.test(m)), JSON.stringify(lines));
  assert.deepStrictEqual(p.events.list().filter((e) => e.kind !== 'start').map((e) => e.kind), ['actuator'], 'Recent events: a press, not a door open');
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual(on.get(), false);
  assert.strictEqual(on.value, false, 'HomeKit told');
  on.set(false); // turning it off does nothing
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(sent.length, 1);
});

test('actuators: a failed command is logged and the button shows Off', async () => {
  const { lines, log } = logged();
  const api = fakeApi();
  const p = new ComelitIntercomPlatform(log, { platform: 'ComelitIntercom', name: 'Comelit Intercom', actuators: [{ name: 'Stair Light', type: 'switch' }] }, api);
  p.discoverAccessories(withLight);
  const on = p.accessories.get('uuid:homebridge-comelit-intercom-actuator-1').getService('sw').getCharacteristic('on');
  p.openOnce = async () => { throw new Error('Not connected'); };
  on.set(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(on.value, false);
  assert.ok(lines.some(([l, m]) => l === 'warn' && /Stair Light': failed: Not connected/.test(m)));
});

test('actuators: doctor mode and Next Visitor never use one shown as a switch or light', async () => {
  const { p, opened, ring } = doctor({ doctorMode: 'always', actuators: [{ name: 'Stair Light', type: 'light' }] });
  p.deviceConfig = { ...deviceConfig, doors: [stairLight, deviceConfig.doors[0]] }; // the light listed first
  p.discoverAccessories(p.deviceConfig);
  await ring();
  assert.deepStrictEqual(opened, [['Entrance lock', true]]);

  const only = doctor({ doctorMode: 'always', actuators: [{ name: 'Stair Light', type: 'light' }] });
  only.p.deviceConfig = { ...deviceConfig, doors: [stairLight] };
  const sent = [];
  only.p.openOnce = async (d) => { sent.push(d.name); return { confirmed: true }; };
  await only.ring();
  assert.deepStrictEqual(only.opened, []);
  assert.deepStrictEqual(sent, [], 'the light is not turned on by a ring');
});

test('actuators: lock stays the default; pressActuator refuses locks and entrance doors', async () => {
  const { p } = platform();
  p.discoverAccessories(withLight);
  assert.strictEqual(p.lockAccessories.size, 2, 'no setting: both are locks');
  assert.strictEqual(p.actuatorType(stairLight), 'lock');
  await assert.rejects(p.pressActuator(stairLight), /not an actuator shown as a switch or light/);
  const named = platform({ actuators: [{ name: 'Entrance lock', type: 'light' }] }).p;
  assert.strictEqual(named.actuatorType(deviceConfig.doors[0]), 'lock', 'an entrance door is always a lock');
});

test('actuators: changing the type rebuilds, and a switch turned light keeps one service', () => {
  const api = fakeApi();
  const cfg = { platform: 'ComelitIntercom', name: 'Comelit Intercom', actuators: [{ name: 'Stair Light', type: 'switch' }] };
  const p = new ComelitIntercomPlatform(quietLog(), cfg, api);
  p.discoverAccessories(withLight);
  const acc = p.accessories.get('uuid:homebridge-comelit-intercom-actuator-1');
  assert.ok(acc.getService('sw'));
  p.settings.actuatorTypes = { 'stair light': 'light' };
  p.discoverAccessories(withLight);
  assert.ok(acc.getService('lb'));
  assert.strictEqual(acc.getService('sw'), undefined);
  p.settings.actuatorTypes = {};
  p.discoverAccessories(withLight);
  assert.ok(!p.accessories.has('uuid:homebridge-comelit-intercom-actuator-1'), 'back to a lock: the button accessory is removed');
  assert.strictEqual(p.lockAccessories.size, 2);
});

test('actuators: a name that matches no actuator is reported, with the actuators the intercom has', () => {
  const { lines, log } = logged();
  const p = new ComelitIntercomPlatform(log, { platform: 'ComelitIntercom', name: 'Comelit Intercom', actuators: [{ name: 'Stairs', type: 'light' }] }, fakeApi());
  p.discoverAccessories(withLight);
  assert.ok(lines.some(([l, m]) => l === 'warn' && /no actuator named 'stairs' on the intercom \(its actuators: 'Stair Light'\)/.test(m)), JSON.stringify(lines));
});

test('actuators: a relay saved before a restart is checked against the intercom before sending', async () => {
  const { p } = platform({ actuators: [{ name: 'Stair Light', type: 'switch' }] });
  p.discoverAccessories(withLight); // as restored from the cache
  const sent = [];
  p.openOnce = async (d) => { sent.push(d.outputIndex); return { confirmed: true }; };
  p.deviceConfig = { ...deviceConfig, doors: [deviceConfig.doors[0], { ...stairLight, outputIndex: 3 }] }; // moved since
  await assert.rejects(p.pressActuator(stairLight), /no longer has this actuator as saved/);
  p.deviceConfig = withLight;
  await p.pressActuator(stairLight);
  assert.deepStrictEqual(sent, [0]);
});

test('actuators: two actuators with the listed name are reported', () => {
  const { lines, log } = logged();
  const p = new ComelitIntercomPlatform(log, { platform: 'ComelitIntercom', name: 'Comelit Intercom', actuators: [{ name: 'Stair Light', type: 'light' }] }, fakeApi());
  p.discoverAccessories({ ...withLight, doors: [...withLight.doors, { ...stairLight, index: 2, outputIndex: 1 }] });
  assert.ok(lines.some(([l, m]) => l === 'warn' && /more than one actuator is named 'stair light'/.test(m)), JSON.stringify(lines));
});

// ─── No Response, Offline sensor and firmware (2.8.0-beta.2) ───

const withCamera = { ...deviceConfig, cameras: [{ id: 'c1', name: 'Gate camera', rtspUrl: '' }] };

test('the ring sensor and cameras answer No Response after 30 s without the intercom, and recover', () => {
  const { p } = platform();
  p.discoverAccessories(JSON.parse(JSON.stringify(withCamera)));
  const ring = p.doorbellAccessory.sensor.getCharacteristic('md');
  const cam = p.cameraAccessories[0].service.getCharacteristic('md');
  assert.strictEqual(ring.get(), false);
  assert.strictEqual(cam.get(), false);
  p.downSince = Date.now() - 31_000;
  assert.throws(() => ring.get(), (e) => e.hapStatus === -70402);
  assert.throws(() => cam.get(), (e) => e.hapStatus === -70402);
  // back: the state is sent again
  p.downSince = undefined;
  p.refreshReachability();
  assert.strictEqual(ring.get(), false);
  assert.strictEqual(ring.value, false);
  assert.strictEqual(cam.value, false);
  const lock = [...p.lockAccessories.values()][0];
  assert.strictEqual(lock.service.getCharacteristic(p.Characteristic.LockCurrentState).value, 1);
});

test('going offline opens the Offline sensor once the 2 minutes are up (timer)', async () => {
  const { p } = platform({ offlineSensor: true });
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  const state = p.offlineSensor.service.getCharacteristic(p.Characteristic.ContactSensorState);
  p.downSince = Date.now() - OFFLINE_AFTER_MS;
  p.watchDown();
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(state.value, 1);
  p.clearDownTimers();
  assert.strictEqual(p.offlineTimer, undefined);
});

test('markDown keeps the first moment the connection went down', () => {
  const { p } = platform();
  p.downSince = undefined;
  p.markDown();
  const first = p.downSince;
  assert.ok(first > 0);
  p.downSince = first - 5_000;
  p.markDown();
  assert.strictEqual(p.downSince, first - 5_000);
  p.clearDownTimers();
});

test('offline sensor: only when turned on; Open after 2 minutes away, Closed when back', () => {
  const off = platform();
  off.p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  assert.ok(![...off.api.registered].some((u) => u.includes('offline')));

  const { p, api } = platform({ offlineSensor: true });
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  assert.ok(api.registered.has('uuid:homebridge-comelit-intercom-offline'));
  const state = p.offlineSensor.service.getCharacteristic(p.Characteristic.ContactSensorState);
  p.downSince = undefined;
  assert.strictEqual(state.get(), 0);
  // unreachable but not yet offline: still Closed, and never No Response
  p.downSince = Date.now() - 31_000;
  assert.strictEqual(state.get(), 0);
  p.downSince = Date.now() - OFFLINE_AFTER_MS - 1;
  assert.strictEqual(state.get(), 1);
  p.offlineSensor.refresh();
  assert.strictEqual(state.value, 1);
  p.downSince = undefined;
  p.offlineSensor.refresh();
  assert.strictEqual(state.value, 0);
});

test('offline sensor: turning the setting off removes it', () => {
  const { p, api } = platform({ offlineSensor: true });
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  p.settings.offlineSensor = false;
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  assert.ok(![...api.registered].some((u) => u.includes('offline')));
  assert.strictEqual(p.offlineSensor, undefined);
});

function infoClient(reply, existing) {
  const sent = [];
  const channel = { name: 'INFO', isOpen: true };
  return {
    sent,
    opened: 0,
    closed: 0,
    getChannel(name) { return existing && name === 'INFO' ? channel : undefined; },
    async openChannel() { this.opened++; return channel; },
    async closeChannel() { this.closed++; },
    async sendJson(_ch, msg) { sent.push(msg); if (reply instanceof Error) { throw reply; } return reply; },
  };
}

test('firmware: the intercom version goes on every accessory, also ones added later', async () => {
  const { p, api } = platform({ offlineSensor: true });
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  const client = infoClient({ model: 'MSVU', version: '2.1.0' }, true);
  await p.readFirmware(client);
  assert.strictEqual(client.opened, 0, 'reuses the open INFO channel');
  assert.strictEqual(client.closed, 0, 'and leaves it open for the keepalive');
  assert.strictEqual(client.sent[0].message, 'server-info');
  assert.strictEqual(p.firmware, '2.1.0');
  for (const a of p.accessories.values()) {
    assert.strictEqual(a.getService('info').getCharacteristic('fw').value, '2.1.0', a.displayName);
  }
  p.discoverAccessories(JSON.parse(JSON.stringify(withCamera)));
  const cam = [...p.accessories.values()].find((a) => a.UUID.includes('camera-c1'));
  assert.strictEqual(cam.getService('info').getCharacteristic('fw').value, '2.1.0');
  assert.ok(api.registered.has('uuid:homebridge-comelit-intercom-offline'));
});

test('firmware: a version HomeKit cannot take, or no answer, leaves the row alone', async () => {
  const { p } = platform();
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  const bad = infoClient({ version: '2.1.0-rc1' }, false);
  await p.readFirmware(bad);
  assert.strictEqual(bad.opened, 1);
  assert.strictEqual(bad.closed, 1, 'its own channel is closed again');
  assert.strictEqual(p.firmware, '', 'not asked again');
  for (const a of p.accessories.values()) {
    assert.strictEqual(a.getService('info').getCharacteristic('fw').value, undefined);
  }
  const { p: p2 } = platform();
  p2.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  await p2.readFirmware(infoClient(new Error('timeout'), true));
  assert.strictEqual(p2.firmware, undefined, 'asked again on the next connection');
  await p2.readFirmware(infoClient(new Error('timeout'), true));
  assert.strictEqual(p2.firmwareTries, 2, 'then no more');
});

// ─── Names follow the settings (2.8.0-beta.3) ───

test('names: a new Name renames the tiles named by the plugin, not ones renamed in the Home app', () => {
  const api = fakeApi();
  const cache = new Map();
  const start = (name) => {
    const p = new ComelitIntercomPlatform(quietLog(), { platform: 'ComelitIntercom', name, doctorMode: 'switch', doctorModeSensor: true, offlineSensor: true }, api);
    for (const a of cache.values()) p.configureAccessory(a);
    const register = api.registerPlatformAccessories;
    api.registerPlatformAccessories = (pl, n, accs) => { for (const a of accs) cache.set(a.UUID, a); register(pl, n, accs); };
    p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
    api.registerPlatformAccessories = register;
    return p;
  };
  const shown = (seed, svc) => cache.get(`uuid:homebridge-comelit-intercom-${seed}`).getService(svc).getCharacteristic('cn').value;
  start('Comelit Intercom');
  // first start: only noted, nothing renamed
  assert.strictEqual(shown('doorbell', 'motion'), undefined);
  // renamed in the Home app (after the plugin had a ConfiguredName on it): kept
  start('Intercom');
  assert.strictEqual(shown('doorbell', 'motion'), 'Intercom');
  assert.strictEqual(shown('offline', 'cs'), 'Intercom Offline');
  assert.strictEqual(shown('doctor-mode', 'sw'), 'Intercom Doctor Mode');
  assert.strictEqual(shown('doctor-mode', 'cs'), 'Intercom Doctor Mode Sensor');
  assert.strictEqual(cache.get('uuid:homebridge-comelit-intercom-doorbell').displayName, 'Intercom');
  assert.strictEqual(shown('lock-0', 'lock'), undefined, "the door's name didn't change");
  cache.get('uuid:homebridge-comelit-intercom-offline').getService('cs').getCharacteristic('cn').value = 'Intercom gone';
  start('Front');
  assert.strictEqual(shown('doorbell', 'motion'), 'Front');
  assert.strictEqual(shown('offline', 'cs'), 'Intercom gone', 'renamed in Home: kept');
});

test('names: a door renamed on the intercom renames its lock', () => {
  const { p, api } = platform();
  p.discoverAccessories(JSON.parse(JSON.stringify(deviceConfig)));
  p.discoverAccessories({ ...deviceConfig, doors: [{ ...deviceConfig.doors[0], name: 'Front gate' }] });
  const lock = [...p.lockAccessories.values()][0];
  assert.strictEqual(lock.service.getCharacteristic('cn').value, 'Front gate');
  assert.ok(api.registered.has('uuid:homebridge-comelit-intercom-lock-0'));
});
