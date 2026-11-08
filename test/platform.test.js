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
  class HapStatusError extends Error {}
  const registered = new Set();
  const api = {
    registered,
    duplicates: 0,
    hap: {
      Service: { AccessoryInformation: 'info', LockMechanism: 'lock', MotionSensor: 'motion', Doorbell: 'db', Speaker: 'sp', Switch: 'sw' },
      Characteristic: { LockCurrentState: { SECURED: 1, UNSECURED: 0 }, LockTargetState: { SECURED: 1, UNSECURED: 0 }, MotionDetected: 'md', Manufacturer: 'm', Model: 'mo', SerialNumber: 's', Name: 'n' },
      uuid: { generate: (s) => `uuid:${s}` },
      HapStatusError,
      HAPStatus: { NOT_ALLOWED_IN_CURRENT_STATE: -70412 },
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
