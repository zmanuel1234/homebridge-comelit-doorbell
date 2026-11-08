"use strict";
/**
 * Node.js TCP client for the ICONA Bridge protocol.
 * Translates the Python asyncio-based IconaBridgeClient to Node.js net.Socket.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconaBridgeClient = exports.ProtocolError = exports.ConnectionError = void 0;
const net_1 = __importDefault(require("net"));
const events_1 = require("events");
const channels_1 = require("./channels");
const protocol_1 = require("./protocol");
const settings_1 = require("./settings");
class ConnectionError extends Error {
}
exports.ConnectionError = ConnectionError;
class ProtocolError extends Error {
}
exports.ProtocolError = ProtocolError;
class IconaBridgeClient extends events_1.EventEmitter {
    host;
    port;
    log;
    socket = null;
    rxBuffer = Buffer.alloc(0);
    requestIdCounter;
    sequenceCounter = 0;
    channels = new Map();
    pendingCallbacks = new Map();
    pushCallback;
    disconnectCallback;
    deadTimer;
    _connected = false;
    constructor(host, port = settings_1.ICONA_BRIDGE_PORT, log) {
        super();
        this.host = host;
        this.port = port;
        this.log = log;
        this.requestIdCounter = 8000 + Math.floor(Math.random() * 1000);
    }
    get connected() {
        return this._connected;
    }
    connect() {
        return new Promise((resolve, reject) => {
            const socket = net_1.default.createConnection({ host: this.host, port: this.port });
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new ConnectionError(`Connect to ${this.host}:${this.port} timed out`));
            }, settings_1.CONNECT_TIMEOUT_MS);
            socket.once('connect', () => {
                clearTimeout(timeout);
                this.socket = socket;
                this._connected = true;
                socket.setMaxListeners(0); // prevent accumulation across reconnect cycles
                socket.setKeepAlive(true, 60_000);
                socket.on('data', (chunk) => this._onData(chunk));
                socket.on('end', () => this._onDisconnect('EOF'));
                socket.on('error', (err) => this._onDisconnect(`socket error: ${err.message}`));
                socket.on('close', () => { if (this._connected)
                    this._onDisconnect('close'); });
                this._resetDeadTimer();
                this.log?.debug(`Connected to ${this.host}:${this.port}`);
                resolve();
            });
            socket.once('error', (err) => {
                clearTimeout(timeout);
                reject(new ConnectionError(`Failed to connect to ${this.host}:${this.port}: ${err.message}`));
            });
        });
    }
    async disconnect() {
        this._connected = false;
        this._clearDeadTimer();
        for (const ch of this.channels.values()) {
            ch.responseQueue.clear();
            if (ch._openReject)
                ch._openReject(new ConnectionError('Disconnected'));
        }
        this.channels.clear();
        for (const cb of this.pendingCallbacks.values()) {
            cb(Buffer.alloc(0));
        }
        this.pendingCallbacks.clear();
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        this.rxBuffer = Buffer.alloc(0);
        this.log?.debug(`Disconnected from ${this.host}:${this.port}`);
    }
    setDisconnectCallback(cb) {
        this.disconnectCallback = cb;
    }
    setPushCallback(cb) {
        this.pushCallback = cb;
    }
    // ─── Send ──────────────────────────────────────────────────────────────────
    _send(data) {
        if (!this.socket)
            return Promise.reject(new ConnectionError('Not connected'));
        return new Promise((resolve, reject) => {
            this.socket.write(data, (err) => {
                if (err)
                    reject(new ConnectionError(`Send failed: ${err.message}`));
                else
                    resolve();
            });
        });
    }
    // ─── Receive loop ─────────────────────────────────────────────────────────
    _onData(chunk) {
        this._resetDeadTimer();
        this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
        this._drainBuffer();
    }
    _drainBuffer() {
        while (this.rxBuffer.length >= protocol_1.HEADER_SIZE) {
            const { bodyLength, requestId } = (0, protocol_1.decodeHeader)(this.rxBuffer);
            const totalLen = protocol_1.HEADER_SIZE + bodyLength;
            if (this.rxBuffer.length < totalLen)
                break;
            const body = this.rxBuffer.subarray(protocol_1.HEADER_SIZE, totalLen);
            this.rxBuffer = this.rxBuffer.subarray(totalLen);
            this._dispatch(requestId, body);
        }
    }
    _onDisconnect(reason) {
        if (!this._connected)
            return;
        this._connected = false;
        this._clearDeadTimer();
        this.log?.info(`Connection lost (${reason})`);
        for (const ch of this.channels.values()) {
            ch.responseQueue.clear();
            if (ch._openReject)
                ch._openReject(new ConnectionError('Disconnected'));
        }
        for (const cb of this.pendingCallbacks.values())
            cb(Buffer.alloc(0));
        this.pendingCallbacks.clear();
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        if (this.disconnectCallback)
            this.disconnectCallback();
    }
    _resetDeadTimer() {
        this._clearDeadTimer();
        this.deadTimer = setTimeout(() => {
            this.log?.warn('No data for 120 s — marking connection dead');
            this._onDisconnect('120 s timeout');
        }, settings_1.DEAD_CONNECTION_TIMEOUT_MS);
    }
    _clearDeadTimer() {
        if (this.deadTimer) {
            clearTimeout(this.deadTimer);
            this.deadTimer = undefined;
        }
    }
    // ─── Dispatch ─────────────────────────────────────────────────────────────
    _dispatch(requestId, body) {
        if (requestId === 0) {
            this._handleControlMessage(body);
            return;
        }
        // Check waiting callback (send_json)
        const cb = this.pendingCallbacks.get(requestId);
        if (cb) {
            this.pendingCallbacks.delete(requestId);
            cb(body);
            return;
        }
        // Route to channel queue
        for (const ch of this.channels.values()) {
            if (ch.serverChannelId === requestId && ch.isOpen) {
                ch.responseQueue.enqueue(body);
                return;
            }
        }
        // Unsolicited JSON → push callback
        if ((0, protocol_1.isJsonBody)(body)) {
            try {
                const msg = (0, protocol_1.decodeJsonBody)(body);
                if (this.pushCallback)
                    this.pushCallback(msg);
            }
            catch {
                this.log?.debug(`Failed to decode unsolicited body on channel ${requestId}`);
            }
        }
    }
    _handleControlMessage(body) {
        if (body.length < 4)
            return;
        const { msgType, seq, serverChannelId } = (0, protocol_1.parseCommandResponse)(body);
        if (msgType === 0xabcd && seq === 1 && body.length >= 10) {
            // Device-initiated channel open: find request_id from body
            let devReqId = 0;
            const nameStart = 8;
            try {
                const nullIdx = body.indexOf(0, nameStart);
                devReqId = nullIdx >= 0 ? body.readUInt16LE(nullIdx + 1) : body.readUInt16LE(body.length - 3);
            }
            catch {
                devReqId = body.readUInt16LE(body.length - 3);
            }
            this.socket?.write((0, protocol_1.encodeChannelOpenResponse)(devReqId));
            // Assign to first placeholder channel
            for (const ch of this.channels.values()) {
                if (!ch.isOpen && ch.serverChannelId === 0 && ch.requestId === 0) {
                    ch.serverChannelId = devReqId;
                    ch.isOpen = true;
                    ch.sequence = 3;
                    ch.openBody = body;
                    if (ch._openResolve)
                        ch._openResolve(body);
                    return;
                }
            }
            return;
        }
        if (msgType === 0xabcd) {
            // Regular channel open response — assign to first pending channel
            for (const ch of this.channels.values()) {
                if (!ch.isOpen && ch.serverChannelId === 0 && ch.requestId !== 0) {
                    ch.serverChannelId = serverChannelId;
                    ch.isOpen = true;
                    ch.sequence = seq + 1;
                    ch.openBody = body;
                    if (ch._openResolve)
                        ch._openResolve(body);
                    return;
                }
            }
            return;
        }
        if (msgType === 0x01ef && body.length >= 8) {
            const subType = body.readUInt32LE(4);
            if (subType === 2) {
                // Device-initiated close — ACK with type=4
                const ackBody = Buffer.alloc(10);
                ackBody.writeUInt16LE(0x01ef, 0);
                ackBody.writeUInt16LE(4, 2);
                ackBody.writeUInt32LE(4, 4);
                ackBody.writeUInt16LE(serverChannelId, 8);
                const ack = Buffer.concat([
                    Buffer.from([0x00, 0x06]),
                    Buffer.alloc(2), // will be written below
                    Buffer.alloc(4),
                    ackBody,
                ]);
                ack.writeUInt16LE(ackBody.length, 2);
                this.socket?.write(ack);
            }
        }
    }
    // ─── Channel management ───────────────────────────────────────────────────
    openChannel(name, channelType, extraData, trailingByte = 0, wireName) {
        const protocolName = wireName ?? name;
        const requestId = ++this.requestIdCounter;
        const channel = (0, channels_1.createChannel)(name, channelType, requestId);
        this.channels.set(name, channel);
        const packet = (0, protocol_1.encodeChannelOpen)(protocolName, channelType, 1, requestId, extraData, trailingByte);
        return new Promise((resolve, reject) => {
            channel._openResolve = () => resolve(channel);
            channel._openReject = reject;
            const timer = setTimeout(() => {
                reject(new ProtocolError(`Timeout waiting for channel ${name} to open`));
            }, settings_1.READ_TIMEOUT_MS);
            const origResolve = channel._openResolve;
            channel._openResolve = (body) => {
                clearTimeout(timer);
                origResolve(body);
            };
            channel._openReject = (err) => {
                clearTimeout(timer);
                reject(err);
            };
            this._send(packet).catch(reject);
        });
    }
    async closeChannel(name) {
        const channel = this.channels.get(name);
        if (!channel)
            return;
        this.channels.delete(name);
        const seq = ++this.sequenceCounter;
        await this._send((0, protocol_1.encodeChannelClose)(seq, channel.serverChannelId));
    }
    async sendJson(channel, msg) {
        if (!channel.isOpen || channel.serverChannelId === 0) {
            throw new ProtocolError(`Channel ${channel.name} not open`);
        }
        await channel.sendMutex.acquire();
        try {
            const responsePromise = new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingCallbacks.delete(channel.serverChannelId);
                    reject(new ProtocolError(`Timeout waiting for response on ${channel.name}`));
                }, settings_1.READ_TIMEOUT_MS);
                this.pendingCallbacks.set(channel.serverChannelId, (body) => {
                    clearTimeout(timer);
                    resolve(body);
                });
            });
            await this._send((0, protocol_1.encodeJsonMessage)(msg, channel.serverChannelId));
            const body = await responsePromise;
            if (!(0, protocol_1.isJsonBody)(body))
                throw new ProtocolError(`Expected JSON on ${channel.name}`);
            return (0, protocol_1.decodeJsonBody)(body);
        }
        finally {
            channel.sendMutex.release();
        }
    }
    async sendBinary(channel, data) {
        if (!channel.isOpen || channel.serverChannelId === 0) {
            throw new ProtocolError(`Channel ${channel.name} not open`);
        }
        const packet = Buffer.concat([(0, protocol_1.encodeHeader)(data.length, channel.serverChannelId), data]);
        await this._send(packet);
    }
    readResponse(channel, timeoutMs = settings_1.READ_TIMEOUT_MS) {
        return channel.responseQueue.dequeue(timeoutMs);
    }
    registerPlaceholderChannel(name) {
        const channel = (0, channels_1.createChannel)(name, channels_1.ChannelType.UAUT, 0);
        this.channels.set(name, channel);
        return channel;
    }
    releasePlaceholderChannel(name) {
        this.channels.delete(name);
    }
    removeChannel(name) {
        this.channels.delete(name);
    }
    renameChannel(oldName, newName) {
        const ch = this.channels.get(oldName);
        if (ch) {
            this.channels.delete(oldName);
            ch.name = newName;
            this.channels.set(newName, ch);
        }
    }
    getChannel(name) {
        const ch = this.channels.get(name);
        return ch?.isOpen ? ch : undefined;
    }
}
exports.IconaBridgeClient = IconaBridgeClient;
