/**
 * Listens on the CTPP channel for rings and other intercom messages, and acknowledges them.
 *
 * Frames are read here in the "legacy" layout: a little-endian prefix (0x18 << 8 | flags),
 * a 32-bit "timestamp" (connection id, seq, ack), then the body length (`action`) and the
 * opcode (`flags`). See ctp.ts for the frame format.
 */
import type { Logging } from 'homebridge';
import type { Channel } from './channels';
import type { IconaBridgeClient } from './client';
import type { CallHandler } from './call';
import { ackWord, finWord, Opcode, parseFrame, peerKey } from './ctp';
import type { DeviceConfig, IntercomEvent, IntercomEventType } from './models';
import { encodeCallResponseAck } from './protocol';

const PREFIX_VIDEO_EVENT = 0x1840;
/** The intercom acknowledging a frame. */
const PREFIX_ACK = 0x1800;
const PREFIX_VIP_EVENT = 0x1860;
const PREFIX_CALL_INIT = 0x18c0;
const ACTION_IN_ALERTING = 0x0001;
const ACTION_RELEASE_LEN = 0x0003;
const ACTION_REGISTRATION_RENEWAL = 0x0010;
const DEDUP_WINDOW_MS = 10_000;

interface CtppMessage {
  prefix: number;
  timestamp: number;
  /** Body length. */
  action: number;
  /** Opcode (first 16 bits of the body), when present. */
  opcode?: number;
  addresses: string[];
  raw: Buffer;
}

export function parseCtppMessage(data: Buffer): CtppMessage | null {
  if (data.length < 8) {
    return null;
  }
  const msg: CtppMessage = {
    prefix: data.readUInt16LE(0),
    timestamp: data.readUInt32LE(2),
    action: data.readUInt16BE(6),
    addresses: [],
    raw: data,
  };
  if (data.length >= 10) {
    msg.opcode = data.readUInt16BE(8);
  }
  // Addresses: NUL-terminated ASCII strings after the 0xFFFFFFFF marker.
  const marker = data.indexOf(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  if (marker >= 0) {
    let i = marker + 4;
    while (i < data.length) {
      const nul = data.indexOf(0, i);
      if (nul < 0 || nul === i) {
        break;
      }
      msg.addresses.push(data.subarray(i, nul).toString('ascii'));
      i = nul + 1;
    }
  }
  return msg;
}

export class VipEventListener {
  private channel?: Channel;
  private running = false;
  private loopPromise?: Promise<void>;
  private readonly lastFired = new Map<IntercomEventType, number>();
  private readonly lastSeen = new Map<string, [number, number]>();
  /** Door-open requests waiting for the intercom's RELEASE, keyed by the connection the reply comes on. */
  private readonly releaseWaiters = new Map<string, (cause: number) => void>();

  constructor(
    private readonly client: IconaBridgeClient,
    private readonly config: DeviceConfig,
    private readonly callback: (event: IntercomEvent) => void,
    private readonly log?: Logging,
    private readonly call?: CallHandler,
  ) {}

  private get ourAddress(): string {
    return `${this.config.aptAddress}${this.config.aptSubaddress}`;
  }

  async start(): Promise<void> {
    const ctpp = this.client.getChannel('CTPP');
    if (!ctpp) {
      throw new Error('CTPP channel not open');
    }
    this.channel = ctpp;
    this.running = true;
    this.loopPromise = this.listenLoop().catch((e) => this.log?.warn(`VIP listener loop exited: ${(e as Error).message}`));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.channel?.responseQueue.clear();
    if (this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = undefined;
    }
  }

  /**
   * Waits for the RELEASE that answers a request we sent on connection (`conn0`, `conn1`).
   * Resolves with its cause (0 = done), or null after `timeoutMs`.
   */
  waitForRelease(conn0: number, conn1: number, timeoutMs: number): { result: Promise<number | null>; cancel: () => void } {
    const key = peerKey(conn0, conn1);
    let settle: (v: number | null) => void = () => undefined;
    const result = new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => settle(null), timeoutMs);
      settle = (v) => {
        clearTimeout(timer);
        this.releaseWaiters.delete(key);
        resolve(v);
      };
      this.releaseWaiters.set(key, (cause) => settle(cause));
    });
    return { result, cancel: () => settle(null) };
  }

  private async listenLoop(): Promise<void> {
    const channel = this.channel!;
    while (this.running) {
      const data = await channel.responseQueue.dequeue(60_000);
      if (!this.running) {
        break;
      }
      if (data !== null) {
        await this.processMessage(data).catch((e) => this.log?.warn(`VIP: error processing message: ${(e as Error).message}`));
      }
    }
  }

  /** Renewal checks from the intercom answered (not logged one by one). */
  private renewalChecks = 0;

  /** How many renewal checks were answered since the last call, for the hourly summary. */
  takeRenewalChecks(): number {
    const n = this.renewalChecks;
    this.renewalChecks = 0;
    return n;
  }

  async processMessage(data: Buffer): Promise<void> {
    const msg = parseCtppMessage(data);
    if (!msg) {
      return;
    }
    const { prefix, action } = msg;
    const now = Date.now();
    const key = `${prefix}:${action}`;
    const last = this.lastSeen.get(key);
    const isRetransmit = last !== undefined && last[0] === msg.timestamp && now - last[1] < 10_000;
    this.lastSeen.set(key, [msg.timestamp, now]);
    // Not logged: the intercom's renewal checks (every 2 min; counted, see takeRenewalChecks)
    // and its acknowledgements (0x1800: during a call, the call's own log shows them).
    const routine = (prefix === PREFIX_VIP_EVENT && action === ACTION_REGISTRATION_RENEWAL) || (prefix === PREFIX_ACK && action === 0);
    if (!routine) {
      this.log?.debug(
        `VIP msg: prefix=0x${prefix.toString(16).padStart(4, '0')} action=0x${action.toString(16).padStart(4, '0')} ts=0x${msg.timestamp.toString(16)} addrs=${msg.addresses.join(',')}`,
      );
    }

    // Periodic registration renewal: ACK + FIN pair.
    if (prefix === PREFIX_VIP_EVENT && action === ACTION_REGISTRATION_RENEWAL) {
      await this.sendRenewalAck(msg);
      return;
    }
    if (prefix === PREFIX_CALL_INIT || prefix === PREFIX_VIDEO_EVENT || prefix === PREFIX_VIP_EVENT) {
      await this.sendEventAck(msg, false);
    }
    // The intercom closed a connection (empty 0x1860): close it back.
    if (prefix === PREFIX_VIP_EVENT && action === 0) {
      await this.sendEventAck(msg, true);
    }

    const frame = parseFrame(data);
    if (frame && this.call?.enabled) {
      await this.call.onFrame(frame, msg.addresses).catch((e) => this.log?.warn(`call: ${(e as Error).message}`));
    }

    if (isRetransmit && prefix === PREFIX_VIDEO_EVENT) {
      return;
    }

    // Answer to one of our door-open requests.
    if (msg.opcode === Opcode.RELEASE && data.length >= 11) {
      const waiter = this.releaseWaiters.get(`${data[2]}:${data[3]}`);
      if (waiter) {
        waiter(data[10]);
        return;
      }
    }

    // A new call towards us: only an INVITE is a ring.
    if (prefix === PREFIX_CALL_INIT) {
      if (msg.opcode === Opcode.INVITE) {
        this.fireEvent('doorbell_ring', msg.addresses);
      } else {
        this.log?.debug(`VIP: new connection from the intercom, opcode 0x${(msg.opcode ?? 0).toString(16)} (not a ring)`);
      }
      return;
    }

    if (prefix === PREFIX_VIP_EVENT && action !== 0) {
      if (action === ACTION_IN_ALERTING) {
        this.fireEvent('doorbell_ring', msg.addresses);
      } else if (action === ACTION_RELEASE_LEN && msg.opcode === Opcode.RELEASE) {
        this.log?.debug(`VIP: release, cause ${data[10]}`);
      } else if (action === ACTION_RELEASE_LEN) {
        this.fireEvent('door_opened', msg.addresses);
      }
    }
  }

  /** Sends a CTP frame on the CTPP channel (used by the call handler). */
  async sendFrame(frame: Buffer): Promise<void> {
    if (this.running && this.channel) {
      await this.client.sendBinary(this.channel, frame);
    }
  }

  private async sendEventAck(msg: CtppMessage, fin: boolean): Promise<void> {
    if (!this.running || !this.channel) {
      return;
    }
    const entranceAddr = msg.addresses[0] ?? this.config.aptAddress;
    const word = fin ? finWord(msg.timestamp) : ackWord(msg.timestamp);
    try {
      await this.client.sendBinary(this.channel, encodeCallResponseAck(this.ourAddress, entranceAddr, word, fin ? 0x1820 : 0x1800));
    } catch (e) {
      this.log?.warn(`VIP: failed to send event ACK: ${(e as Error).message}`);
    }
  }

  private async sendRenewalAck(msg: CtppMessage): Promise<void> {
    if (!this.running || !this.channel) {
      return;
    }
    const aptAddr = this.config.aptAddress;
    const word = ackWord(msg.timestamp);
    try {
      await this.client.sendBinary(this.channel, encodeCallResponseAck(this.ourAddress, aptAddr, word));
      await this.client.sendBinary(this.channel, encodeCallResponseAck(this.ourAddress, aptAddr, word, 0x1820));
      this.renewalChecks++;
    } catch (e) {
      this.log?.warn(`VIP: failed to send renewal ACK: ${(e as Error).message}`);
    }
  }

  private fireEvent(eventType: IntercomEventType, addresses: string[]): void {
    const now = Date.now();
    if (now - (this.lastFired.get(eventType) ?? 0) < DEDUP_WINDOW_MS) {
      return;
    }
    this.lastFired.set(eventType, now);
    this.log?.debug(`VIP: firing ${eventType} (addrs=${addresses.join(',')})`);
    try {
      this.callback({ eventType, aptAddress: addresses[0] ?? '', timestamp: now / 1000, raw: { source: 'ctpp_vip', addresses } });
    } catch {
      // callback errors must not crash the listener
    }
  }
}
