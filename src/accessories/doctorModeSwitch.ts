import type { PlatformAccessory, Service } from 'homebridge';
import type { ComelitIntercomPlatform } from '../platform';

/**
 * Doctor mode's HomeKit switch (doctorMode: switch): while it is on, every ring opens the door.
 * Its state is kept in the accessory's context, so it survives a restart.
 */
export class DoctorModeSwitch {
  private readonly service: Service;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'Doctor mode')
      .setCharacteristic(Characteristic.SerialNumber, 'doctor-mode');
    this.service = accessory.getService(Service.Switch) || accessory.addService(Service.Switch, accessory.displayName);
    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.on)
      .onSet((value) => {
        accessory.context.on = Boolean(value);
        platform.api.updatePlatformAccessories([accessory]);
        platform.log.info(`Doctor mode ${this.on ? 'ON: every ring opens the door' : 'off'}`);
      });
  }

  get on(): boolean {
    return this.accessory.context.on === true;
  }
}
