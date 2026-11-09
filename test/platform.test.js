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
      Characteristic: { LockCurrentState: { SECURED: 1, UNSECURED: 0 }, LockTargetState: { SECURED: 1, UNSECURED: 0 }, MotionDetected: 'md', Manufacturer: 'm', Model: 'mo', SerialNumber: 's', Name: 'n' },
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
