/**
 * Node.js TCP client for the ICONA Bridge protocol.
 * Translates the Python asyncio-based IconaBridgeClient to Node.js net.Socket.
 */
import { EventEmitter } from 'events';
import { ChannelState, ChannelType } from './channels';
export declare class ConnectionError extends Error {
}
export declare class ProtocolError extends Error {
}
export declare class IconaBridgeClient extends EventEmitter {
    readonly host: string;
    readonly port: number;
    private readonly log?;
    private socket;
    private rxBuffer;
    private requestIdCounter;
    private sequenceCounter;
    private channels;
    private pendingCallbacks;
    private pushCallback?;
    private disconnectCallback?;
    private deadTimer?;
    private _connected;
    constructor(host: string, port?: number, log?: {
        debug: (m: string, ...a: unknown[]) => void;
        info: (m: string, ...a: unknown[]) => void;
        warn: (m: string, ...a: unknown[]) => void;
        error: (m: string, ...a: unknown[]) => void;
    } | undefined);
    get connected(): boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    setDisconnectCallback(cb: () => void): void;
    setPushCallback(cb: ((msg: Record<string, unknown>) => void) | undefined): void;
    private _send;
    private _onData;
    private _drainBuffer;
    private _onDisconnect;
    private _resetDeadTimer;
    private _clearDeadTimer;
    private _dispatch;
    private _handleControlMessage;
    openChannel(name: string, channelType: ChannelType, extraData?: string, trailingByte?: number, wireName?: string): Promise<ChannelState>;
    closeChannel(name: string): Promise<void>;
    sendJson(channel: ChannelState, msg: Record<string, unknown>): Promise<Record<string, unknown>>;
    sendBinary(channel: ChannelState, data: Buffer): Promise<void>;
    readResponse(channel: ChannelState, timeoutMs?: number): Promise<Buffer | null>;
    registerPlaceholderChannel(name: string): ChannelState;
    releasePlaceholderChannel(name: string): void;
    removeChannel(name: string): void;
    renameChannel(oldName: string, newName: string): void;
    getChannel(name: string): ChannelState | undefined;
}
//# sourceMappingURL=client.d.ts.map