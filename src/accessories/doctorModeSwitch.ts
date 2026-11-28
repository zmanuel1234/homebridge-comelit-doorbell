import type { PlatformAccessory } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform.js';
import { ModeSwitch } from './modeSwitch.js';

/**
 * Doctor mode's HomeKit switch (doctorMode: switch): while it is on, every ring opens the door.
 * It turns itself off after doctorModeMinutes (0: never), and doctorModeSensor adds a contact
 * sensor that follows it. Its state and time limit survive a restart.
 */
export class DoctorModeSwitch extends ModeSwitch {
  constructor(platform: ComelitIntercomPlatform, accessory: PlatformAccessory, limitMs = 0, sensor = false) {
    super(platform, accessory, {
      label: 'Doctor mode',
      eventName: 'Doctor Mode',
      onText: 'every ring opens the door',
      expiredText: 'its time limit passed',
      model: 'Doctor mode',
      serial: 'doctor-mode',
      limitMs,
      sensor,
    });
  }
}
