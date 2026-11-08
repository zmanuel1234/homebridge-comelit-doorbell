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
        for (const stale of [Service.Doorbell, Service.Speaker, Service.Switch]) { // zman: ring sensor instead of switch
            const svc = accessory.getService(stale);
            if (svc)
                accessory.removeService(svc);
        }
        this.switchService =
            new Service.Switch(accessory.displayName); // zman: internal only, not published
        this.switchService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.active)
            .onSet((value) => {
            if (!value)
                this._setOff();
        });
        this.sensorService =
            accessory.getService(Service.MotionSensor) ||
                accessory.addService(Service.MotionSensor, accessory.displayName);
        this.sensorService
            .getCharacteristic(Characteristic.MotionDetected)
            .onGet(() => this.active);
    }
    /** Called by the platform when a doorbell_ring VIP event arrives. */
    triggerRing() {
        this.platform.log.info('Doorbell ring');
        global.__zmanLastRing = Date.now(); // zman: ring window
        // zman: ring the HomeKit doorbell camera (homebridge-camera-ffmpeg, localhost-only)
        try {
            if (global.__zmanDoorbellUrl) require('http').get(global.__zmanDoorbellUrl, (res) => res.resume()) // zman: settings
                .on('error', (e) => this.platform.log.warn(`Doorbell camera trigger failed: ${e.message}`));
        } catch (e) { this.platform.log.warn(`Doorbell camera trigger failed: ${e.message}`); }
        this.sensorService.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);
        this.active = true;
        this.switchService
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(true);
        clearTimeout(this.offTimer);
        this.offTimer = setTimeout(() => this._setOff(), RING_DURATION_MS);
    }
    _setOff() {
        this.active = false;
        this.sensorService.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
        this.switchService
            .getCharacteristic(this.platform.Characteristic.On)
            .updateValue(false);
    }
}
exports.DoorbellAccessory = DoorbellAccessory;
