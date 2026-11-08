import { PlatformAccessory } from 'homebridge';
import { ComelitIntercomPlatform } from '../platform';
export declare class DoorbellAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly switchService;
    private active;
    private offTimer?;
    constructor(platform: ComelitIntercomPlatform, accessory: PlatformAccessory);
    /** Called by the platform when a doorbell_ring VIP event arrives. */
    triggerRing(): void;
    private _setOff;
}
//# sourceMappingURL=doorbellAccessory.d.ts.map