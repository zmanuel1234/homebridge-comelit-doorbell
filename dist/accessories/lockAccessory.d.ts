import { PlatformAccessory } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';
import { Door } from '../models';
/**
 * LockAccessory — represents one door relay as a HAP LockMechanism.
 *
 * HomeKit shows it as "Secured". When the user presses Open, the
 * characteristic briefly transitions to Unsecured, the door relay fires,
 * then it auto-returns to Secured after 3 s.
 */
export declare class LockAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly door;
    private readonly service;
    private lockState;
    constructor(platform: ComelitIntercomPlatform, accessory: PlatformAccessory, door: Door);
    private triggerOpen;
    onDisconnect(): void;
}
//# sourceMappingURL=lockAccessory.d.ts.map