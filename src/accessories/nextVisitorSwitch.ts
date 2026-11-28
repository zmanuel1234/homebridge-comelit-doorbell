import type { PlatformAccessory } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform.js';
import { ModeSwitch } from './modeSwitch.js';

/**
 * The Next Visitor switch (nextVisitorSwitch): while it is on, the next ring opens the door, as
 * doctor mode does; then it turns itself off. It also turns off after nextVisitorMinutes if
 * nobody rings, and nextVisitorSensor adds a contact sensor that follows it. Its state and time
 * limit survive a restart.
 */
export class NextVisitorSwitch extends ModeSwitch {
  constructor(platform: ComelitIntercomPlatform, accessory: PlatformAccessory, limitMs: number, sensor = false) {
    super(platform, accessory, {
      label: 'Next visitor',
      eventName: 'Next Visitor',
      onText: 'the next ring opens the door',
      expiredText: 'nobody rang within its time limit',
      model: 'Next visitor',
      serial: 'next-visitor',
      limitMs,
      sensor,
    });
  }

  /** The door was opened for the visitor: the switch has done its job. */
  used(): void {
    this.turnOff('the visitor was let in');
  }
}
