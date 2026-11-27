import type { PlatformAccessory, Service } from 'homebridge';
import type { Camera } from '../models';
import type { ComelitIntercomPlatform } from '../platform';

/**
 * Placeholder for an RTSP camera listed on the intercom: a motion sensor that never
 * triggers. No video yet; the camera's RTSP URL is written to the log.
 */
export class CameraAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: ComelitIntercomPlatform,
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
    this.service = accessory.getService(Service.MotionSensor) || accessory.addService(Service.MotionSensor, camera.name);
    this.service.getCharacteristic(Characteristic.MotionDetected).onGet(() => {
      if (platform.unreachable()) {
        const { hap } = platform.api;
        throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
      return false;
    });
    if (camera.rtspUrl) {
      platform.log.debug(`Camera '${camera.name}' RTSP URL: ${camera.rtspUrl} (streaming not yet implemented)`);
    }
  }

  /** The intercom is back: tell Home the sensor's state again (clears No Response). */
  refresh(): void {
    this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, false);
  }
}
