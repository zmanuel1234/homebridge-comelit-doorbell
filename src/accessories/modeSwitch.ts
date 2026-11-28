import type { PlatformAccessory, Service } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform.js';

export interface ModeSwitchOptions {
  /** Log label, e.g. 'Doctor mode'. */
  label: string;
  /** Its name in Recent events, as in the Home app, e.g. 'Doctor Mode'. */
  eventName: string;
  /** What the log says when it turns on, e.g. 'every ring opens the door'. */
  onText: string;
  model: string;
  serial: string;
  /** Why it turned off when its time limit passes, for the log. */
  expiredText: string;
  /** Turns itself off after this long; 0: no time limit. */
  limitMs: number;
  /** Also show the state as a contact sensor (Open while on), for Home app notifications. */
  sensor: boolean;
}

/**
 * A HomeKit switch for doctor mode or Next Visitor, with an optional time limit and an optional
 * contact sensor that follows it (Open while on, Closed while off), since the Home app can notify
 * about a sensor but not about a switch. Its state and time limit are kept in the accessory's
 * context, so they survive a restart.
 */
export class ModeSwitch {
  private readonly service: Service;
  private readonly sensorService?: Service;
  private timer?: NodeJS.Timeout;

  constructor(
    protected readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
    private readonly opts: ModeSwitchOptions,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, opts.model)
      .setCharacteristic(Characteristic.SerialNumber, opts.serial);
    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, accessory.displayName);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet((value) => (value ? this.turnOn() : this.turnOff('turned off')));

    const cached = accessory.getService(Service.ContactSensor);
    if (opts.sensor) {
      this.sensorService = cached || accessory.addService(Service.ContactSensor, `${accessory.displayName} Sensor`);
      this.sensorService.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.contactState());
    } else if (cached) {
      // The sensor setting was turned off: drop the sensor from the cached accessory.
      accessory.removeService(cached);
    }

    // After a restart (or an update that added the time limit): still on until its time limit,
    // or off if that has passed.
    if (this.on) {
      const until = Number(accessory.context.until);
      if (opts.limitMs <= 0) {
        if (accessory.context.until !== undefined) {
          delete accessory.context.until;
          platform.api.updatePlatformAccessories([accessory]);
        }
      } else if (!Number.isFinite(until) || until <= 0) {
        // On, but with no time limit yet: it starts now.
        accessory.context.until = Date.now() + opts.limitMs;
        platform.api.updatePlatformAccessories([accessory]);
        this.schedule(opts.limitMs);
      } else if (until > Date.now()) {
        // Never longer than the configured limit (it may have been lowered, or the clock was behind).
        this.schedule(Math.min(until - Date.now(), opts.limitMs));
      } else {
        this.turnOff('its time limit passed during a restart');
      }
    }
    this.sensorService?.updateCharacteristic(Characteristic.ContactSensorState, this.contactState());
  }

  get on(): boolean {
    return this.accessory.context.on === true;
  }

  /** Stops this object's time limit (the accessories are being rebuilt; a new object takes over). */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  protected turnOn(): void {
    const was = this.on;
    this.accessory.context.on = true;
    let until = '';
    if (this.opts.limitMs > 0) {
      const at = Date.now() + this.opts.limitMs;
      this.accessory.context.until = at;
      this.schedule(this.opts.limitMs);
      until = ` (until ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
    } else {
      delete this.accessory.context.until;
      this.dispose();
    }
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.updateSensor();
    this.platform.log.info(`${this.opts.label} ON: ${this.opts.onText}${until}`);
    if (!was) {
      this.platform.events?.add('mode', `${this.opts.eventName} on${until}`);
    }
  }

  protected turnOff(why: string): void {
    this.dispose();
    const was = this.on;
    this.accessory.context.on = false;
    delete this.accessory.context.until;
    this.platform.api.updatePlatformAccessories([this.accessory]);
    this.service.updateCharacteristic(this.platform.Characteristic.On, false);
    this.updateSensor();
    if (was) {
      this.platform.log.info(`${this.opts.label} off: ${why}`);
      this.platform.events?.add('mode', `${this.opts.eventName} off: ${why}`);
    }
  }

  private contactState(): number {
    const s = this.platform.Characteristic.ContactSensorState;
    return this.on ? s.CONTACT_NOT_DETECTED : s.CONTACT_DETECTED;
  }

  private updateSensor(): void {
    this.sensorService?.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.contactState());
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.turnOff(this.opts.expiredText), ms);
    this.timer.unref?.();
  }
}
