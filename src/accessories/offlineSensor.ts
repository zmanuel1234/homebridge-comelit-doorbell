import type { PlatformAccessory, Service } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform.js';

/**
 * A contact sensor that is Open while the intercom has been unreachable for a while
 * (OFFLINE_AFTER_MS), and Closed again once it is back. It never shows No Response itself:
 * it is how Home tells you the intercom is gone.
 */
export class OfflineSensor {
  private readonly service: Service;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'Connection')
      .setCharacteristic(Characteristic.SerialNumber, 'offline');
    this.service = accessory.getService(Service.ContactSensor) || accessory.addService(Service.ContactSensor, accessory.displayName);
    this.service.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.state());
  }

  private state(): number {
    const { ContactSensorState } = this.platform.Characteristic;
    return this.platform.offline() ? ContactSensorState.CONTACT_NOT_DETECTED : ContactSensorState.CONTACT_DETECTED;
  }

  /** Pushes the current state (on going offline and on coming back). */
  refresh(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.state());
  }
}
