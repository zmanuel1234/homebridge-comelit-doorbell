import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';
import { Door, PushEvent } from './models';
export interface ComelitConfig extends PlatformConfig {
    host: string;
    port?: number;
    token: string;
    enableNotifications?: boolean;
    reconnectDelay?: number;
}
export declare class ComelitIntercomPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly platformConfig: ComelitConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly cachedAccessories: PlatformAccessory[];
    private lockAccessories;
    private doorbellAccessory?;
    private cameraAccessories;
    private client?;
    private config_;
    private vipListener?;
    private keepaliveTimer?;
    private reconnectTimer?;
    private pushCallbacks;
    constructor(log: Logger, platformConfig: ComelitConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private setupDevice;
    private openCtppChannels;
    private teardown;
    private onClientDisconnect;
    private scheduleReconnect;
    private startKeepalive;
    private stopKeepalive;
    private onPushEvent;
    addPushCallback(cb: (event: PushEvent) => void): void;
    openDoor(door: Door): Promise<void>;
    private discoverAccessories;
}
//# sourceMappingURL=platform.d.ts.map