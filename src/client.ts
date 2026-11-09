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
  encodeCloseChannel,
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
  /** While this returns true (a call is answered), planned reconnects wait. */
  isBusy?: () => boolean;
  /** How often to check again while busy (default 30 s). */
  busyRecheckMs?: number;
  /** Reconnect anyway once it has waited this long for a call (default 10 min). */
  maxBusyWaitMs?: number;
}

export class IconaBridgeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private requestIdCounter: number;
  private sequenceCounter = 0;
  private readonly channels = new Map<string, Channel>();
  private readonly pendingCallbacks = new Map<number, (body: Buffer) => void>();
  private readonly binaryHandlers = new Map<number, (body: Buffer) => void>();
  private readonly unknownFrames = new Map<number, number>();
  private pushCallback?: (msg: JsonMessage) => void;
  private disconnectCallback?: (planned: boolean) => void;
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

  /** Drops the connection and reports it as lost (the disconnect callback runs). */
  drop(reason: string): void {
    this.onDisconnect(reason);
  }

  /** `planned` is true for a reconnect the lease asked for, false for a dropped connection. */
  setDisconnectCallback(cb: (planned: boolean) => void): void {
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
      this.plannedReconnect(lease, Date.now());
    }, lease.intervalMs);
  }

  /** Reconnects for the lease, but not in the middle of a call: then it checks again later. */
  private plannedReconnect(lease: LeaseOptions, since: number): void {
    if (lease.isBusy?.() && Date.now() - since < (lease.maxBusyWaitMs ?? 600_000)) {
      const wait = lease.busyRecheckMs ?? 30_000;
      this.log?.info(`Registration refresh: a call is in progress, reconnecting after it (checking again in ${wait / 1000} s)`);
      this.leaseTimer = setTimeout(() => this.plannedReconnect(lease, since), wait);
      return;
    }
    this.onDisconnect(`registration lease refresh (${lease.intervalMs / 60000} min)`, true);
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
      try {
        this.dispatch(requestId, body);
      } catch (e) {
        // One bad frame must not take Homebridge down (this runs in the socket's data event).
        this.log?.warn(`Ignored a frame on channel ${requestId} that could not be handled: ${(e as Error).message}`);
      }
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

  private onDisconnect(reason: string, planned = false): void {
    clearTimeout(this.leaseTimer);
    if (!this._connected) {
      return;
    }
    this._connected = false;
    this.clearDeadTimer();
    this.log?.info(planned ? `Reconnecting (${reason})` : `Connection lost (${reason})`);
    this.failPending();
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.disconnectCallback?.(planned);
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
    const handler = this.binaryHandlers.get(requestId);
    if (handler) {
      handler(body);
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
      // Log the first few frames per channel, then only now and then (media can be many per second).
      const n = (this.unknownFrames.get(requestId) ?? 0) + 1;
      this.unknownFrames.set(requestId, n);
      if (n <= 3 || n % 500 === 0) {
        this.log?.info(`diag: frame #${n} on unknown channel ${requestId} (${body.length} B): ${body.subarray(0, 64).toString('hex')}`);
      }
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
      // The device opens a channel towards us: [cd ab 01 00][type LE32][name, 4 chars][handle LE16]...
      const name = body.length >= 14 ? body.subarray(8, 12).toString('latin1') : '';
      const devReqId = body.length >= 14 ? body.readUInt16LE(12) : body.readUInt16LE(body.length - 3);
      this.socket?.write(encodeChannelOpenResponse(devReqId));
      this.log?.info(`diag: device opened channel ${name || '?'} as ${devReqId}`);
      this.emit('channel', name, devReqId);
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
      // Forget the channel, so nothing keeps sending on (or waiting for) a closed handle.
      for (const [name, ch] of this.channels) {
        if (ch.isOpen && ch.serverChannelId === serverChannelId) {
          ch.isOpen = false;
          ch.responseQueue.clear();
          this.channels.delete(name);
          this.log?.info(`The intercom closed channel ${name}`);
          this.emit('channelClosed', name);
        }
      }
    }
  }

  // ─── Channels ──────────────────────────────────────────────────────────────

  /**
   * Opens a channel. `name` is the key it is kept under; `wireName` (default: `name`) is what
   * the device is told, so several channels with the same wire name (RTPC) can be open.
   */
  openChannel(name: string, channelType: number, extraData?: string, trailingByte = 0, wireName = name): Promise<Channel> {
    const requestId = ++this.requestIdCounter;
    const channel = createChannel(name, channelType, requestId);
    this.channels.set(name, channel);
    const packet = encodeChannelOpen(wireName, channelType, 1, requestId, extraData, trailingByte);
    return new Promise((resolve, reject) => {
      const fail = (err: Error) => {
        clearTimeout(timer);
        // Forget the channel, or the intercom's answer to the next open would be given to it.
        if (this.channels.get(name) === channel && !channel.isOpen) {
          this.channels.delete(name);
        }
        reject(err);
      };
      const timer = setTimeout(() => fail(new ProtocolError(`Timeout waiting for channel ${name} to open`)), READ_TIMEOUT_MS);
      channel.openResolve = () => {
        clearTimeout(timer);
        resolve(channel);
      };
      channel.openReject = fail;
      this.send(packet).catch(fail);
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

  /**
   * Closes a channel by handle and forgets it (used for media channels). Its binary handler is
   * left to the caller, since the intercom may still send a few packets after the close.
   */
  async closeHandle(name: string | undefined, handle: number): Promise<void> {
    if (name) {
      this.channels.delete(name);
    }
    await this.send(encodeCloseChannel(handle)).catch(() => undefined);
  }

  /** The handler for a channel, if any (to tell whose it is). */
  binaryHandlerFor(handle: number): ((body: Buffer) => void) | undefined {
    return this.binaryHandlers.get(handle);
  }

  /** Routes raw frames on `handle` to `handler` (or stops routing them with undefined). */

  setBinaryHandler(handle: number, handler?: (body: Buffer) => void): void {
    if (handler) {
      this.binaryHandlers.set(handle, handler);
    } else {
      this.binaryHandlers.delete(handle);
    }
  }

  /** Sends raw bytes on a channel handle (media). */
  async sendOnHandle(handle: number, data: Buffer): Promise<void> {
    await this.send(Buffer.concat([encodeHeader(data.length, handle), data]));
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
      try {
        await this.send(encodeJsonMessage(msg, channel.serverChannelId));
      } catch (e) {
        // Nothing will answer: stop waiting, so the timeout can't reject with no one listening.
        this.pendingCallbacks.get(channel.serverChannelId)?.(Buffer.alloc(0));
        this.pendingCallbacks.delete(channel.serverChannelId);
        response.catch(() => undefined);
        throw e;
      }
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
