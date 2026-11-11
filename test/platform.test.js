const test = require('node:test');
const assert = require('node:assert');
const { ComelitIntercomPlatform } = require('../dist/platform');
const { quietLog } = require('./helpers');

function fakeApi() {
  const mkChar = () => {
    const c = { onGet(f) { c.get = f; return c; }, onSet(f) { c.set = f; return c; } };
    return c;
  };
  class Svc {
    constructor() { this.chars = new Map(); }
    getCharacteristic(k) { if (!this.chars.has(k)) this.chars.set(k, mkChar()); return this.chars.get(k); }
    setCharacteristic() { return this; }
    updateCharacteristic(k, v) { this.getCharacteristic(k).value = v; return this; }
  }
  class Acc {
    constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.context = {}; this.s = { info: new Svc() }; }
    getService(t) { return this.s[t]; }
    addService(t) { return (this.s[t] = new Svc()); }
    removeService() {}
  }
  class HapStatusError extends Error { constructor(status) { super(String(status)); this.hapStatus = status; } }
  const registered = new Set();
  const api = {
    registered,
    duplicates: 0,
    hap: {
      Service: { AccessoryInformation: 'info', LockMechanism: 'lock', MotionSensor: 'motion', Doorbell: 'db', Speaker: 'sp', Switch: 'sw' },
      Characteristic: { LockCurrentState: { SECURED: 1, UNSECURED: 0 }, LockTargetState: { SECURED: 1, UNSECURED: 0 }, MotionDetected: 'md', Manufacturer: 'm', Model: 'mo', SerialNumber: 's', Name: 'n', On: 'on' },
      uuid: { generate: (s) => `uuid:${s}` },
      HapStatusError,
      HAPStatus: { NOT_ALLOWED_IN_CURRENT_STATE: -70412, SERVICE_COMMUNICATION_FAILURE: -70402 },
    },
    on() {},
    platformAccessory: Acc,
    registerPlatformAccessories(_p, _n, accs) {
      for (const a of accs) {
        if (registered.has(a.UUID)) { api.duplicates++; throw new Error('Cannot add a bridged Accessory with the same UUID'); }
        registered.add(a.UUID);
      }
    },
    updatePlatformAccessories() {},
    unregisterPlatformAccessories(_p, _n, accs) { for (const a of accs) registered.delete(a.UUID); },
  };
  return api;
}

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
  p.callHandler = { activeCall: () => ({}), openInCall: async (door, force) => { opened.push([door.name, force]); return { confirmed: true }; } };
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
  p.callHandler.activeCall = () => undefined;
  await ring();
  assert.strictEqual(opened.length, 1);
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
  p.callHandler.activeCall = () => undefined; // answered on a phone first
  await ring();
  assert.strictEqual(nextOn(p).get(), true);
  p.callHandler.activeCall = () => ({});
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
