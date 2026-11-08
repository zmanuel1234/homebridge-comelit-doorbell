"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DoorbellAccessory = void 0;
const RING_DURATION_MS = 5_000;
class DoorbellAccessory {
    platform;
    accessory;
    switchService;
    active = false;
    offTimer;
    constructor(platform, accessory) {
        this.platform = platform;
        this.accessory = accessory;
        const { Service, Characteristic } = platform;
        accessory
            .getService(Service.AccessoryInformation)
            .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
            .setCharacteristic(Characteristic.Model, '6701W')
            .setCharacteristic(Characteristic.SerialNumber, 'doorbell');
        // Remove stale services from previous versions
        for (const stale of [Service.Doorbell, Service.Speaker]) {
            const svc = accessory.getService(stale);
            if (svc)
                accessory.removeService(svc);
        }
        this.switchService =
            accessory.getService(Service.Switch) ||
                accessory.addService(Service.Switch, accessory.displayName);
        this.switchService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.active)
            .onSet((value) => {
            if (!value)
                this._setOff();
        });
    }
    /** Called by the platform when a doorbell_ring VIP event arrives. */
    triggerRing() {
        this.platform.log.info('Doorbell ring');
        this.active = true;
        this.switchService
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(true);
        clearTimeout(this.offTimer);
        this.offTimer = setTimeout(() => this._setOff(), RING_DURATION_MS);
    }
    _setOff() {
        this.active = false;
        this.switchService
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(false);
    }
}
exports.DoorbellAccessory = DoorbellAccessory;
