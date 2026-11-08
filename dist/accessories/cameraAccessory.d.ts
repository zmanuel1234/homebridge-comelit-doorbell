import { PlatformAccessory } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';
import { Camera } from '../models';
/**
 * CameraAccessory — exposes an RTSP camera from the device config.
 *
 * Full HomeKit camera streaming requires a CameraController + streaming
 * delegate (FFmpeg) and is out of scope for the initial plugin version.
 * This accessory registers the camera in HomeKit so it appears in the
 * Home app; a future update will add live streaming support.
 */
export declare class CameraAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly camera;
    private readonly service;
    constructor(platform: ComelitIntercomPlatform, accessory: PlatformAccessory, camera: Camera);
}
//# sourceMappingURL=cameraAccessory.d.ts.map