import type { PlatformAccessory, Service } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform';

/**
 * The Next Visitor switch (nextVisitorSwitch): while it is on, the next ring opens the door, as
 * doctor mode does; then it turns itself off. It also turns off after nextVisitorMinutes if
 * nobody rings. Its state and time limit are kept in the accessory's context, so they survive
 * a restart.
 */
export class NextVisitorSwitch {
  private readonly service: Service;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
    private readonly limitMs: number,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'Next visitor')
      .setCharacteristic(Characteristic.SerialNumber, 'next-visitor');
    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, accessory.displayName);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet((value) => (value ? this.turnOn() : this.turnOff('turned off')));
    // After a restart: still on until its time limit, or off if that has passed.
    if (accessory.context.on === true) {
      const left = Number(accessory.context.until) - Date.now();
      if (left > 0) {
        this.schedule(left);
      } else {
        this.turnOff('its time limit passed during a restart');
      }
    }
  }

  get on(): boolean {
    return this.accessory.context.on === true;
  }

  /** Stops this object's time limit (the accessories are being rebuilt; a new object takes over). */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The door was opened for the visitor: the switch has done its job. */
  used(): void {
    this.turnOff('the visitor was let in');
  }

  private turnOn(): void {
    const until = Date.now() + this.limitMs;
    this.accessory.context.on = true;
    this.accessory.context.until = until;
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.schedule(this.limitMs);
    const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    this.platform.log.info(`Next visitor ON: the next ring opens the door (until ${at})`);
  }

  private turnOff(why: string): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const was = this.on;
    this.accessory.context.on = false;
    delete this.accessory.context.until;
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.service.updateCharacteristic(this.platform.Characteristic.On, false);
    if (was) {
      this.platform.log.info(`Next visitor off: ${why}`);
    }
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.turnOff('nobody rang within its time limit'), ms);
    this.timer.unref?.();
  }
}
