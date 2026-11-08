import { ChannelState } from './channels';
import { IconaBridgeClient } from './client';
export declare const CTR_INCR_BOTH = 16842752;
type Logger = {
    debug: (m: string, ...a: unknown[]) => void;
    warn: (m: string, ...a: unknown[]) => void;
};
export declare function ctppInitSequence(client: IconaBridgeClient, channel: ChannelState, aptAddr: string, aptSub: number, ourAddr: string, timestamp: number, responseTimeoutMs?: number, sendAck?: boolean, log?: Logger): Promise<void>;
export declare function readResponseCtpp(client: IconaBridgeClient, channel: ChannelState, responseTimeoutMs?: number, log?: Logger, ackConfig?: {
    aptAddr: string;
    ourAddr: string;
}): Promise<void>;
export {};
//# sourceMappingURL=ctpp.d.ts.map