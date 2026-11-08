// Accessory registration across reconnects, and the lock's behavior on refused and confirmed opens.
const D = require('path').join(__dirname, '..', 'dist');
const { ComelitIntercomPlatform } = require(D + '/platform.js');
const mkChar = () => { const c = { v: undefined, onGet(f) { c.get = f; return c; }, onSet(f) { c.set = f; return c; }, updateValue(v) { c.v = v; return c; } }; return c; };
class Svc { constructor(n) { this.n = n; this.chars = new Map(); } getCharacteristic(k) { if (!this.chars.has(k)) this.chars.set(k, mkChar()); return this.chars.get(k); } setCharacteristic() { return this; } updateCharacteristic(k, v) { this.getCharacteristic(k).v = v; return this; } }
const Service = { AccessoryInformation: 'info', LockMechanism: 'lock', MotionSensor: 'motion', Switch: function (n) { return new Svc(n); }, Doorbell: 'db', Speaker: 'sp' };
const Characteristic = { LockCurrentState: { SECURED: 1, UNSECURED: 0 }, LockTargetState: { SECURED: 1, UNSECURED: 0 }, MotionDetected: 'md', On: 'on', Manufacturer: 'm', Model: 'mo', SerialNumber: 's' };
class Acc { constructor(name, uuid) { this.displayName = name; this.UUID = uuid; this.s = { info: new Svc('info') }; this.context = {}; } getService(t) { return this.s[t]; } addService(t) { return (this.s[t] = new Svc(t)); } removeService() {} }
const registered = new Set(); let errors = 0;
const api = { hap: { Service, Characteristic, uuid: { generate: (s) => 'u-' + s }, HapStatusError: class extends Error {}, HAPStatus: {} }, on() {}, platformAccessory: Acc,
  registerPlatformAccessories(p, n, accs) { for (const a of accs) { if (registered.has(a.UUID)) { errors++; throw new Error('Cannot add a bridged Accessory with the same UUID'); } registered.add(a.UUID); } },
  updatePlatformAccessories() {}, unregisterPlatformAccessories(p, n, accs) { for (const a of accs) registered.delete(a.UUID); } };
const log = { info() {}, warn() {}, error(m) { console.log('ERR', m); }, debug() {} };
const plat = new ComelitIntercomPlatform(log, { name: 'Comelit Intercom' }, api);
const cfg = { doors: [{ index: 0, name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1 }], cameras: [] };
let ok = true; const check = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); ok = ok && c; };
try { plat.discoverAccessories(cfg); plat.discoverAccessories(cfg); plat.discoverAccessories(cfg); } catch (e) { console.log('threw', e.message); }
check(errors === 0 && registered.size === 2, `fresh install + 2 reconnects: ${registered.size} accessories, ${errors} duplicate registrations`);
// lock flow: busy refusal snaps back to Locked, success shows Unlocked
(async () => {
  const lock = [...plat.lockAccessories.values()].pop();
  plat.openDoor = async () => { throw new Error("Failed to open door 'Entrance lock': intercom refused (cause 8, busy)"); };
  await lock.triggerOpen();
  check(lock.lockState === 1, 'refused open leaves the lock Locked');
  plat.openDoor = async () => ({ confirmed: true });
  await lock.triggerOpen();
  check(lock.lockState === 0, 'confirmed open shows Unlocked');
  global.__zmanRingWindowMs = 90000; global.__zmanLastRing = 0;
  let threw = false; try { lock.service.getCharacteristic(Characteristic.LockTargetState).set(1); } catch { threw = true; }
  check(!threw, 'Lock command is not blocked by the ring window');
  threw = false; try { lock.service.getCharacteristic(Characteristic.LockTargetState).set(0); } catch { threw = true; }
  check(threw, 'Unlock outside the ring window is refused');
  console.log(ok ? 'ALL PASS' : 'SOME FAILED'); process.exit(ok ? 0 : 1);
})();
