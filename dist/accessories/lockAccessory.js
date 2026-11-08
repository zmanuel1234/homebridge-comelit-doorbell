"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LockAccessory = void 0;
/**
 * LockAccessory — represents one door relay as a HAP LockMechanism.
 *
 * HomeKit shows it as "Secured". When the user presses Open, the
 * characteristic briefly transitions to Unsecured, the door relay fires,
 * then it auto-returns to Secured after 3 s.
 */
class LockAccessory {
    platform;
    accessory;
    door;
    service;
    lockState;
    constructor(platform, accessory, door) {
        this.platform = platform;
        this.accessory = accessory;
        this.door = door;
        const { Service, Characteristic } = platform;
        const SECURED = Characteristic.LockCurrentState.SECURED;
        const UNSECURED = Characteristic.LockCurrentState.UNSECURED;
        this.lockState = SECURED;
        accessory
            .getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
            .setCharacteristic(Characteristic.Model, '6701W')
            .setCharacteristic(Characteristic.SerialNumber, `door-${door.index}`);
        this.service =
            accessory.getService(Service.LockMechanism) ||
                accessory.addService(Service.LockMechanism, door.name);
        this.service
            .getCharacteristic(Characteristic.LockCurrentState)
            .onGet(() => this.lockState);
        this.service
            .getCharacteristic(Characteristic.LockTargetState)
            .onGet(() => this.lockState === UNSECURED
            ? Characteristic.LockTargetState.UNSECURED
            : Characteristic.LockTargetState.SECURED)
            .onSet((value) => {
                if (value === Characteristic.LockTargetState.UNSECURED) { const zw = global.__zmanRingWindowMs === undefined ? 90000 : global.__zmanRingWindowMs; // zman: ring window
                  if (zw > 0 && Date.now() - (global.__zmanLastRing || 0) > zw) {
                    if (Date.now() - (global.__zmanRefusedLog || 0) > 5000) { global.__zmanRefusedLog = Date.now(); this.platform.log.warn(`Open refused: no ring in the last ${zw / 1000} s`); }
                    const zh = this.platform.api && this.platform.api.hap;
                    throw (zh && zh.HapStatusError) ? new zh.HapStatusError(zh.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE) : new Error('no recent ring'); } }
            if (value === Characteristic.LockTargetState.UNSECURED) {
                // zman: answer HomeKit right away; don't wait for the door command
                void this.triggerOpen();
            }
        });
    }
    async triggerOpen() {
        const { Characteristic } = this.platform;
        const SECURED = Characteristic.LockCurrentState.SECURED;
        const UNSECURED = Characteristic.LockCurrentState.UNSECURED;
        const relock = () => {
            this.lockState = SECURED;
            this.service.updateCharacteristic(Characteristic.LockCurrentState, SECURED);
            this.service.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
        };
        // Show Unlocked only once the intercom confirms; otherwise snap back to Locked.
        try {
            const result = await this.platform.openDoor(this.door);
            if (result && result.confirmed === false) {
                this.platform.log.warn(`Door '${this.door.name}': open sent, but the intercom did not confirm it`);
            }
            else {
                this.platform.log.info(`Door '${this.door.name}' opened`);
            }
        }
        catch (e) {
            this.platform.log.error(`Door open failed: ${e.message}`);
            relock();
            return;
        }
        this.lockState = UNSECURED;
        this.service.updateCharacteristic(Characteristic.LockCurrentState, UNSECURED);
        // Back to Locked after 3 s
        setTimeout(() => {
            this.lockState = SECURED;
            this.service.updateCharacteristic(Characteristic.LockCurrentState, SECURED);
            this.service.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
        }, 3_000);
    }
    onDisconnect() {
        // Could set to UNKNOWN if desired — leave as SECURED for now
    }
}
exports.LockAccessory = LockAccessory;
