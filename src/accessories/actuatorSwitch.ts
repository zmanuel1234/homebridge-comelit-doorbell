import type { PlatformAccessory, Service } from 'homebridge';
import type { ActuatorType } from '../config';
import type { Door } from '../models';
import type { ComelitIntercomPlatform } from '../platform';

/** How long the button shows On after a press. */
const SHOW_ON_MS = 1_000;

/**
 * An actuator shown as a HomeKit switch or light (setting `actuators`), for a relay that isn't a
 * door, such as the stair light. Turning it on sends the actuator's command, as the Comelit app's
 * button does, and it turns itself off again: the relay's own timer decides how long the light
 * stays on. Unlike a lock it needs no ring, and HomeKit asks for no confirmation: not for doors.
 */
export class ActuatorSwitchAccessory {
  private readonly service: Service;
  private sending = false;
  private offTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
    private readonly door: Door,
    type: Exclude<ActuatorType, 'lock'>,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'ViP actuator')
      .setCharacteristic(Characteristic.SerialNumber, `actuator-${door.index}`);
    const kind = type === 'light' ? Service.Lightbulb : Service.Switch;
    // The type was changed in the settings: drop the other kind from the cached accessory.
    const other = accessory.getService(type === 'light' ? Service.Switch : Service.Lightbulb);
    if (other) {
      accessory.removeService(other);
    }
    this.service = accessory.getService(kind) || accessory.addService(kind, door.name);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.sending || this.offTimer !== undefined)
      .onSet((value) => {
        if (value) {
          void this.press();
        }
      });
  }

  /** Sends the actuator's command; shows On briefly, then Off. Catches its own errors. */
  async press(): Promise<void> {
    if (this.sending) {
      return;
    }
    this.sending = true;
    clearTimeout(this.offTimer);
    this.offTimer = undefined;
    const label = `Actuator '${this.door.name}'`;
    try {
      const result = await this.platform.pressActuator(this.door);
      this.platform.log.info(result.confirmed ? `${label}: on` : `${label}: on (sent; an actuator gives no confirmation)`);
      this.platform.events.add('open', `Actuator '${this.door.name}' turned on from HomeKit`);
      this.offTimer = setTimeout(() => this.showOff(), SHOW_ON_MS);
    } catch (e) {
      this.platform.log.warn(`${label}: failed: ${(e as Error).message}`);
      this.platform.events.add('open-failed', `Actuator '${this.door.name}' failed (${(e as Error).message})`);
      this.showOff();
    } finally {
      this.sending = false;
    }
  }

  private showOff(): void {
    clearTimeout(this.offTimer);
    this.offTimer = undefined;
    this.service.updateCharacteristic(this.platform.Characteristic.On, false);
  }
}
