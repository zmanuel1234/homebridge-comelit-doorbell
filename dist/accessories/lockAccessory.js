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
            .onSet(async (value) => {
            if (value === Characteristic.LockTargetState.UNSECURED) {
                await this.triggerOpen();
            }
        });
    }
    async triggerOpen() {
        const { Characteristic } = this.platform;
        const SECURED = Characteristic.LockCurrentState.SECURED;
        const UNSECURED = Characteristic.LockCurrentState.UNSECURED;
        this.lockState = UNSECURED;
        this.service.updateCharacteristic(Characteristic.LockCurrentState, UNSECURED);
        try {
            await this.platform.openDoor(this.door);
            this.platform.log.info(`Door '${this.door.name}' opened`);
        }
        catch (e) {
            this.platform.log.error(`Door open failed: ${e.message}`);
        }
        // Auto-secure after 3 s regardless of success
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
