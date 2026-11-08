"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AsyncMutex = exports.AsyncQueue = exports.ViperMessageId = exports.ChannelType = void 0;
exports.createChannel = createChannel;
exports.nextSequence = nextSequence;
/** Channel type IDs used in binary COMMAND packets when opening a channel. */
var ChannelType;
(function (ChannelType) {
    ChannelType[ChannelType["UAUT"] = 7] = "UAUT";
    ChannelType[ChannelType["UCFG"] = 2] = "UCFG";
    ChannelType[ChannelType["INFO"] = 20] = "INFO";
    ChannelType[ChannelType["CTPP"] = 16] = "CTPP";
    ChannelType[ChannelType["CSPB"] = 17] = "CSPB";
    // PUSH uses same wire type as UCFG; device distinguishes by channel name string
    ChannelType[ChannelType["PUSH"] = 2] = "PUSH";
})(ChannelType || (exports.ChannelType = ChannelType = {}));
/** Message IDs used in JSON message-id fields — different from ChannelType. */
var ViperMessageId;
(function (ViperMessageId) {
    ViperMessageId[ViperMessageId["UAUT"] = 2] = "UAUT";
    ViperMessageId[ViperMessageId["UCFG"] = 3] = "UCFG";
    ViperMessageId[ViperMessageId["SERVER_INFO"] = 20] = "SERVER_INFO";
    ViperMessageId[ViperMessageId["PUSH"] = 2] = "PUSH";
})(ViperMessageId || (exports.ViperMessageId = ViperMessageId = {}));
class AsyncQueue {
    items = [];
    waiters = [];
    enqueue(item) {
        if (this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter(item);
        }
        else {
            this.items.push(item);
        }
    }
    dequeue(timeoutMs = 30_000) {
        if (this.items.length > 0) {
            return Promise.resolve(this.items.shift());
        }
        return new Promise((resolve) => {
            // Remove this exact waiter on timeout. Removing `resolve` (never in the list) left an
            // expired waiter behind, and the next enqueued item went to it and was lost.
            const waiter = (item) => {
                clearTimeout(timer);
                resolve(item);
            };
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(waiter);
                if (idx >= 0)
                    this.waiters.splice(idx, 1);
                resolve(null);
            }, timeoutMs);
            this.waiters.push(waiter);
        });
    }
    clear() {
        for (const w of this.waiters)
            w(null);
        this.waiters = [];
        this.items = [];
    }
}
exports.AsyncQueue = AsyncQueue;
class AsyncMutex {
    locked = false;
    queue = [];
    acquire() {
        if (!this.locked) {
            this.locked = true;
            return Promise.resolve();
        }
        return new Promise((resolve) => this.queue.push(resolve));
    }
    release() {
        if (this.queue.length > 0) {
            this.queue.shift()();
        }
        else {
            this.locked = false;
        }
    }
}
exports.AsyncMutex = AsyncMutex;
function createChannel(name, channelType, requestId) {
    return {
        name,
        channelType,
        requestId,
        serverChannelId: 0,
        sequence: 1,
        isOpen: false,
        openBody: Buffer.alloc(0),
        responseQueue: new AsyncQueue(),
        sendMutex: new AsyncMutex(),
    };
}
function nextSequence(channel) {
    const seq = channel.sequence;
    channel.sequence += 2;
    return seq;
}
