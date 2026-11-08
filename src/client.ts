/**
 * TCP client for the ICONA bridge protocol (port 64100): framing, channels,
 * JSON request/response, and the registration lease.
 */
import net from 'net';
import { EventEmitter } from 'events';
import type { Logging } from 'homebridge';
import { Channel, createChannel } from './channels';
import {
  HEADER_SIZE,
  decodeHeader,
  decodeJsonBody,
  encodeChannelClose,
  encodeChannelCloseAck,
  encodeChannelOpen,
  encodeChannelOpenResponse,
  encodeHeader,
  encodeJsonMessage,
  isCommand,
  isEnd,
  isJsonBody,
  JsonMessage,
  parseCommandResponse,
} from './protocol';
import { CONNECT_TIMEOUT_MS, DEAD_CONNECTION_TIMEOUT_MS, ICONA_BRIDGE_PORT, READ_TIMEOUT_MS } from './settings';

export class ConnectionError extends Error {}
export class ProtocolError extends Error {}

/**
 * The intercom only routes calls to a registration for a short time after it is made,
 * so it has to be refreshed: either by reconnecting, or by re-registering in place.
 */
export interface LeaseOptions {
  intervalMs: number;
  mode: 'reconnect' | 'inplace';
  /** In `inplace` mode, still reconnect once the connection is this old. */
  recycleMs: number;
  /** Re-sends the registration on the open connection (used in `inplace` mode). */
  reregister?: () => Promise<void>;
}

export class IconaBridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private requestIdCounter: number;
  private sequenceCounter = 0;
  private readonly channels = new Map<string, Channel>();
  private readonly pendingCallbacks = new Map<number, (body: Buffer) => void>();
  private pushCallback?: (msg: JsonMessage) => void;
  private disconnectCallback?: () => void;
  private deadTimer?: NodeJS.Timeout;
  private leaseTimer?: NodeJS.Timeout;
  private connectedAt = 0;
  private _connected = false;

  constructor(
    private readonly host: string,
    private readonly port: number = ICONA_BRIDGE_PORT,
    private readonly log?: Logging,
    private readonly lease?: LeaseOptions,
  ) {
    super();
    this.requestIdCounter = 8000 + Math.floor(Math.random() * 1000);
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new ConnectionError(`Connect to ${this.host}:${this.port} timed out`));
      }, CONNECT_TIMEOUT_MS);
      socket.once('connect', () => {
        clearTimeout(timeout);
        this.socket = socket;
        this._connected = true;
        this.connectedAt = Date.now();
        this.scheduleLease();
        socket.setMaxListeners(0);
        socket.setKeepAlive(true, 60_000);
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('end', () => this.onDisconnect('EOF'));
        socket.on('error', (err) => this.onDisconnect(`socket error: ${err.message}`));
        socket.on('close', () => {
          if (this._connected) {
            this.onDisconnect('close');
          }
        });
        this.resetDeadTimer();
        this.log?.debug(`Connected to ${this.host}:${this.port}`);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(new ConnectionError(`Failed to connect to ${this.host}:${this.port}: ${err.message}`));
      });
    });
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.leaseTimer);
    this._connected = false;
    this.clearDeadTimer();
    this.failPending();
    this.channels.clear();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.rxBuffer = Buffer.alloc(0);
    this.log?.debug(`Disconnected from ${this.host}:${this.port}`);
  }

  setDisconnectCallback(cb: () => void): void {
    this.disconnectCallback = cb;
  }

  setPushCallback(cb: (msg: JsonMessage) => void): void {
    this.pushCallback = cb;
  }

  // ─── Registration lease ────────────────────────────────────────────────────

  private scheduleLease(): void {
    clearTimeout(this.leaseTimer);
    const lease = this.lease;
    if (!lease) {
      return;
    }
    this.leaseTimer = setTimeout(async () => {
      if (lease.mode === 'inplace' && lease.reregister && Date.now() - this.connectedAt < lease.recycleMs) {
        try {
          await lease.reregister();
          this.scheduleLease();
          return;
        } catch (e) {
          this.log?.warn(`In-place re-register failed (${(e as Error).message}); reconnecting`);
        }
      }
      this.onDisconnect(`registration lease refresh (${lease.intervalMs / 60000} min)`);
    }, lease.intervalMs);
  }

  // ─── Send / receive ────────────────────────────────────────────────────────

  private send(data: Buffer): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new ConnectionError('Not connected'));
    }
    return new Promise((resolve, reject) => {
      socket.write(data, (err) => (err ? reject(new ConnectionError(`Send failed: ${err.message}`)) : resolve()));
    });
  }

  private onData(chunk: Buffer): void {
    this.resetDeadTimer();
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    while (this.rxBuffer.length >= HEADER_SIZE) {
      const { bodyLength, requestId } = decodeHeader(this.rxBuffer);
      const totalLen = HEADER_SIZE + bodyLength;
      if (this.rxBuffer.length < totalLen) {
        break;
      }
      const body = this.rxBuffer.subarray(HEADER_SIZE, totalLen);
      this.rxBuffer = this.rxBuffer.subarray(totalLen);
      this.dispatch(requestId, body);
    }
  }

  private failPending(): void {
    for (const ch of this.channels.values()) {
      ch.responseQueue.clear();
      ch.openReject?.(new ConnectionError('Disconnected'));
    }
    for (const cb of this.pendingCallbacks.values()) {
      cb(Buffer.alloc(0));
    }
    this.pendingCallbacks.clear();
  }

  private onDisconnect(reason: string): void {
    clearTimeout(this.leaseTimer);
    if (!this._connected) {
      return;
    }
    this._connected = false;
    this.clearDeadTimer();
    this.log?.info(`Connection lost (${reason})`);
    this.failPending();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.disconnectCallback?.();
  }

  private resetDeadTimer(): void {
    this.clearDeadTimer();
    this.deadTimer = setTimeout(() => {
      this.log?.warn('No data for 120 s — marking connection dead');
      this.onDisconnect('120 s timeout');
    }, DEAD_CONNECTION_TIMEOUT_MS);
  }

  private clearDeadTimer(): void {
    clearTimeout(this.deadTimer);
    this.deadTimer = undefined;
  }

  // ─── Dispatch ──────────────────────────────────────────────────────────────

  private dispatch(requestId: number, body: Buffer): void {
    if (requestId === 0) {
      this.handleControlMessage(body);
      return;
    }
    const cb = this.pendingCallbacks.get(requestId);
    if (cb) {
      this.pendingCallbacks.delete(requestId);
      cb(body);
      return;
    }
    for (const ch of this.channels.values()) {
      if (ch.serverChannelId === requestId && ch.isOpen) {
        ch.responseQueue.enqueue(body);
        return;
      }
    }
    if (!isJsonBody(body)) {
      this.log?.info(`diag: frame on unknown channel ${requestId} (${body.length} B): ${body.subarray(0, 64).toString('hex')}`);
      return;
    }
    try {
      this.pushCallback?.(decodeJsonBody(body));
    } catch {
      this.log?.debug(`Failed to decode unsolicited body on channel ${requestId}`);
    }
  }

  private handleControlMessage(body: Buffer): void {
    if (body.length < 4) {
      return;
    }
    const { msgType, seq, serverChannelId } = parseCommandResponse(body);
    if (isCommand(msgType) && seq === 1 && body.length >= 10) {
      // The device opens a channel towards us.
      const nullIdx = body.indexOf(0, 8);
      const devReqId = nullIdx >= 0 && nullIdx + 3 <= body.length ? body.readUInt16LE(nullIdx + 1) : body.readUInt16LE(body.length - 3);
      this.socket?.write(encodeChannelOpenResponse(devReqId));
      this.log?.info(`diag: device opened channel ${devReqId}: ${body.subarray(8).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
      for (const ch of this.channels.values()) {
        if (!ch.isOpen && ch.serverChannelId === 0 && ch.requestId === 0) {
          ch.serverChannelId = devReqId;
          ch.isOpen = true;
          ch.sequence = 3;
          ch.openBody = body;
          ch.openResolve?.(body);
          return;
        }
      }
      return;
    }
    if (isCommand(msgType)) {
      // Response to a channel we opened: assign it to the first pending channel.
      for (const ch of this.channels.values()) {
        if (!ch.isOpen && ch.serverChannelId === 0 && ch.requestId !== 0) {
          ch.serverChannelId = serverChannelId;
          ch.isOpen = true;
          ch.sequence = seq + 1;
          ch.openBody = body;
          ch.openResolve?.(body);
          return;
        }
      }
      return;
    }
    if (isEnd(msgType) && body.length >= 8 && body.readUInt32LE(4) === 2) {
      this.socket?.write(encodeChannelCloseAck(serverChannelId));
    }
  }

  // ─── Channels ──────────────────────────────────────────────────────────────

  openChannel(name: string, channelType: number, extraData?: string, trailingByte = 0): Promise<Channel> {
    const requestId = ++this.requestIdCounter;
    const channel = createChannel(name, channelType, requestId);
    this.channels.set(name, channel);
    const packet = encodeChannelOpen(name, channelType, 1, requestId, extraData, trailingByte);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProtocolError(`Timeout waiting for channel ${name} to open`)), READ_TIMEOUT_MS);
      channel.openResolve = () => {
        clearTimeout(timer);
        resolve(channel);
      };
      channel.openReject = (err) => {
        clearTimeout(timer);
        reject(err);
      };
      this.send(packet).catch(channel.openReject);
    });
  }

  async closeChannel(name: string): Promise<void> {
    const channel = this.channels.get(name);
    if (!channel) {
      return;
    }
    this.channels.delete(name);
    await this.send(encodeChannelClose(++this.sequenceCounter, channel.serverChannelId));
  }

  removeChannel(name: string): void {
    this.channels.delete(name);
  }

  getChannel(name: string): Channel | undefined {
    const ch = this.channels.get(name);
    return ch?.isOpen ? ch : undefined;
  }

  async sendJson(channel: Channel, msg: JsonMessage): Promise<JsonMessage> {
    if (!channel.isOpen || channel.serverChannelId === 0) {
      throw new ProtocolError(`Channel ${channel.name} not open`);
    }
    await channel.sendMutex.acquire();
    try {
      const response = new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingCallbacks.delete(channel.serverChannelId);
          reject(new ProtocolError(`Timeout waiting for response on ${channel.name}`));
        }, READ_TIMEOUT_MS);
        this.pendingCallbacks.set(channel.serverChannelId, (body) => {
          clearTimeout(timer);
          resolve(body);
        });
      });
      await this.send(encodeJsonMessage(msg, channel.serverChannelId));
      const body = await response;
      if (!isJsonBody(body)) {
        throw new ProtocolError(`Expected JSON on ${channel.name}`);
      }
      return decodeJsonBody(body);
    } finally {
      channel.sendMutex.release();
    }
  }

  async sendBinary(channel: Channel, data: Buffer): Promise<void> {
    if (!channel.isOpen || channel.serverChannelId === 0) {
      throw new ProtocolError(`Channel ${channel.name} not open`);
    }
    await this.send(Buffer.concat([encodeHeader(data.length, channel.serverChannelId), data]));
  }

  readResponse(channel: Channel, timeoutMs = READ_TIMEOUT_MS): Promise<Buffer | null> {
    return channel.responseQueue.dequeue(timeoutMs);
  }
}
