import { ChannelState } from './channels';
import { IconaBridgeClient } from './client';
import { DeviceConfig, Door } from './models';
export declare class DoorOpenError extends Error {
}
export declare function openDoor(client: IconaBridgeClient, config: DeviceConfig, door: Door): Promise<void>;
export declare function openCtppChannel(client: IconaBridgeClient, config: DeviceConfig): Promise<ChannelState>;
//# sourceMappingURL=door.d.ts.map