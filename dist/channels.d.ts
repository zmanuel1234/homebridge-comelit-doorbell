/** Channel type IDs used in binary COMMAND packets when opening a channel. */
export declare enum ChannelType {
    UAUT = 7,
    UCFG = 2,
    INFO = 20,
    CTPP = 16,
    CSPB = 17,
    PUSH = 2
}
/** Message IDs used in JSON message-id fields — different from ChannelType. */
export declare enum ViperMessageId {
    UAUT = 2,
    UCFG = 3,
    SERVER_INFO = 20,
    PUSH = 2
}
export declare class AsyncQueue<T> {
    private items;
    private waiters;
    enqueue(item: T): void;
    dequeue(timeoutMs?: number): Promise<T | null>;
    clear(): void;
}
export declare class AsyncMutex {
    private locked;
    private queue;
    acquire(): Promise<void>;
    release(): void;
}
export interface ChannelState {
    name: string;
    channelType: ChannelType;
    requestId: number;
    serverChannelId: number;
    sequence: number;
    isOpen: boolean;
    openBody: Buffer;
    _openResolve?: (body: Buffer) => void;
    _openReject?: (err: Error) => void;
    responseQueue: AsyncQueue<Buffer>;
    sendMutex: AsyncMutex;
}
export declare function createChannel(name: string, channelType: ChannelType, requestId: number): ChannelState;
export declare function nextSequence(channel: ChannelState): number;
//# sourceMappingURL=channels.d.ts.map