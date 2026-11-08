import { IconaBridgeClient } from './client';
import { DeviceConfig, PushEvent } from './models';
export declare function registerPush(client: IconaBridgeClient, config: DeviceConfig, callback: (event: PushEvent) => void): Promise<void>;
export declare function sendPushKeepalive(client: IconaBridgeClient, config: DeviceConfig): Promise<void>;
//# sourceMappingURL=push.d.ts.map