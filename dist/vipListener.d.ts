/**
 * VIP event listener — monitors a persistent CTPP channel for doorbell and call events.
 *
 * Binary CTPP message format:
 *   [prefix LE16] [timestamp LE32] [action BE16] [flags/param BE16]
 *   [extra bytes] [0xFFFFFFFF] [caller\0] [callee\0\0]
 */
import { IconaBridgeClient } from './client';
import { DeviceConfig, PushEvent } from './models';
export declare class VipEventListener {
    private readonly client;
    private readonly config;
    private readonly callback;
    private readonly log?;
    private channel?;
    private running;
    private loopPromise?;
    private lastFired;
    private lastSeenTs;
    constructor(client: IconaBridgeClient, config: DeviceConfig, callback: (event: PushEvent) => void, log?: {
        debug: (m: string, ...a: unknown[]) => void;
        info: (m: string, ...a: unknown[]) => void;
        warn: (m: string, ...a: unknown[]) => void;
    } | undefined);
    start(): Promise<void>;
    stop(): Promise<void>;
    private _listenLoop;
    private _processMessage;
    private _sendEventAck;
    private _sendRenewalAck;
    private _fireEvent;
}
//# sourceMappingURL=vipListener.d.ts.map