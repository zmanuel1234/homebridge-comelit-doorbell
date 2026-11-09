import type { PlatformAccessory } from 'homebridge';
import type { Camera } from '../models';
import type { ComelitIntercomPlatform } from '../platform';

/**
 * Placeholder for an RTSP camera listed on the intercom: a motion sensor that never
 * triggers. No video yet; the camera's RTSP URL is written to the log.
 */
export class CameraAccessory {
  constructor(
    platform: ComelitIntercomPlatform,
    readonly accessory: PlatformAccessory,
    camera: Camera,
  ) {
    const { Service, Characteristic } = platform;
    accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Comelit')
      .setCharacteristic(Characteristic.Model, 'IP Camera')
      .setCharacteristic(Characteristic.SerialNumber, `cam-${camera.id}`)
      .setCharacteristic(Characteristic.Name, camera.name);
    const service = accessory.getService(Service.MotionSensor) || accessory.addService(Service.MotionSensor, camera.name);
    service.getCharacteristic(Characteristic.MotionDetected).onGet(() => false);
    if (camera.rtspUrl) {
      platform.log.debug(`Camera '${camera.name}' RTSP URL: ${camera.rtspUrl} (streaming not yet implemented)`);
    }
  }
}
