import http from 'http';
import https from 'https';
import type { PlatformAccessory, Service } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform';

const RING_DURATION_MS = 5_000;
const TRIGGER_TIMEOUT_MS = 5_000;

/**
 * The ring, as a motion sensor that is detected for a few seconds on every ring. Each ring
 * also calls the doorbell trigger URL (for a homebridge-camera-ffmpeg doorbell, which is
 * what produces the HomeKit doorbell notification).
 */
export class DoorbellAccessory {
  private readonly sensor: Service;
  private active = false;
  private offTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'ViP doorbell')
      .setCharacteristic(Characteristic.SerialNumber, 'doorbell');
    // Services published by earlier versions.
    for (const stale of [Service.Doorbell, Service.Speaker, Service.Switch]) {
      const svc = accessory.getService(stale);
      if (svc) {
        accessory.removeService(svc);
      }
    }
    this.sensor = accessory.getService(Service.MotionSensor) || accessory.addService(Service.MotionSensor, accessory.displayName);
    this.sensor.getCharacteristic(Characteristic.MotionDetected).onGet(() => this.active);
  }

  triggerRing(): void {
    this.platform.log.info('Doorbell ring');
    this.callTrigger();
    this.active = true;
    this.sensor.updateCharacteristic(this.platform.Characteristic.MotionDetected, true);
    clearTimeout(this.offTimer);
    this.offTimer = setTimeout(() => this.setOff(), RING_DURATION_MS);
  }

  private setOff(): void {
    this.active = false;
    this.sensor.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
  }

  private callTrigger(): void {
    const url = this.platform.settings.doorbellTriggerUrl;
    if (!url) {
      return;
    }
    const fail = (e: Error) => this.platform.log.warn(`Doorbell camera trigger failed: ${e.message}`);
    try {
      const u = new URL(url);
      const req = (u.protocol === 'https:' ? https : http).get(u, { timeout: TRIGGER_TIMEOUT_MS }, (res) => res.resume());
      req.on('timeout', () => req.destroy(new Error(`timed out after ${TRIGGER_TIMEOUT_MS / 1000} s`)));
      req.on('error', fail);
    } catch (e) {
      fail(e as Error);
    }
  }
}
