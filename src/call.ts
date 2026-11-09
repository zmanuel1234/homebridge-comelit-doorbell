/**
 * Experimental: taking part in an incoming call (a ring).
 *
 * While a ring is unanswered, the intercom refuses a door release from anyone who didn't
 * answer it (RELEASE cause 8, busy). The Comelit app answers first, then opens inside the
 * call. This module mirrors that, guided by the outgoing-call setup known from
 * comelit-vip and ttmx/comelit-vip:
 *
 *   intercom → INVITE (SYN)         we → echo the INVITE
 *   intercom → CAPABILITIES         we → our CAPABILITIES   ("handshake": stop here)
 *   we → SETUP_ACK (answer)
 *   we → open UDPM + 2 × RTPC, audio and video media requests (0x0011), VOICESTATUS (0x0070)
 *   intercom → RTP: H.264 video, G.711 A-law audio; our talk-back audio goes back as RTP
 *   we → OPEN_DOOR inside the call; RELEASE (0x000E) to hang up
 *
 * Every frame of a call is logged with the prefix `call:`.
 */
import { EventEmitter } from 'events';
import type { Logging } from 'homebridge';
import { ChannelType } from './channels';
import type { IconaBridgeClient } from './client';
import { buildFrame, CtpFrame, Flag, logicalAddress, Opcode } from './ctp';
import { ALAW_PAYLOAD_TYPE, buildRtp, H264Depacketizer, nalType, parseRtp, parseSps } from './media';
import type { Door, OpenResult } from './models';

export type AnswerMode = 'off' | 'handshake' | 'answer-on-open' | 'answer-on-view';

/** The capabilities the Comelit app sends. */
const APP_CAPABILITIES = Buffer.from('0003490027000000', 'hex');
const SETUP_ACK = Buffer.from('000c000000000000', 'hex');
const AUDIO_OFFER = Buffer.from('0011180200000000', 'hex');
const AUDIO_STOP = Buffer.from('0011980200000000', 'hex');
const VIDEO_OFFER = Buffer.from('0011143200000000', 'hex');
const OP_VOICESTATUS = 0x0070;
const CALL_MAX_AGE_MS = 120_000;

/** Media timing (settings mediaStartTimeoutSeconds, mediaSilenceSeconds, videoRefreshSeconds). */
export interface MediaTiming {
  startTimeoutMs: number;
  silenceMs: number;
  videoRefreshMs: number;
}
export const DEFAULT_MEDIA_TIMING: MediaTiming = { startTimeoutMs: 10_000, silenceMs: 5_000, videoRefreshMs: 15_000 };
const STATS_INTERVAL_MS = 5_000;
/** If the video has no SPS this long after it starts, ask for video again (it may bring a keyframe). */
const NO_KEYFRAME_RETRY_MS = 1_500;
/** After a call's channels are closed, its late packets are dropped quietly this long. */
const LATE_PACKETS_MS = 5_000;
export const SD_RESOLUTION: [number, number] = [320, 240];
export const HD_RESOLUTION: [number, number] = [800, 480];

interface Call {
  conn0: number;
  conn1: number;
  /** Our next sequence number on this connection. */
  seq: number;
  /** Their last sequence number + 1. */
  ack: number;
  /** Address in the frame trailer (where our frames go). */
  peer: string;
  /** Calling address from the INVITE body (the entrance panel). */
  caller: string;
  born: number;
  seen: Set<string>;
  answered: boolean;
  ended: boolean;
  media?: MediaSession;
  /** In flight, so a second viewer joins instead of answering again. */
  answering?: Promise<void>;
  mediaStarting?: Promise<MediaSession | null>;
  /**
   * The channel the intercom wants our talk-back audio on, from its own audio media request.
   * The intercom sends that request right after the answer, often before ours.
   */
  panelAudioHandle?: number;
}

interface Waiter {
  call: Call;
  opcode: number;
  resolve: (r: { opcode: number; body: Buffer } | null) => void;
}

const hex = (b: Buffer) => b.toString('hex');
const le16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff, 0);
  return b;
};

/** The 16-byte settings block of a video request: max payload, bitrate, largest and preferred picture, fps. */
export function videoSettings(preferred: [number, number], bitrate: number): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(0xffff, 0);
  b.writeUInt32LE(bitrate >>> 0, 2);
  b.writeUInt16LE(HD_RESOLUTION[0], 6);
  b.writeUInt16LE(HD_RESOLUTION[1], 8);
  b.writeUInt16LE(preferred[0], 10);
  b.writeUInt16LE(preferred[1], 12);
  b[14] = 16;
  return b;
}

export class CallHandler {
  private readonly calls = new Map<number, Call>();
  private waiters: Waiter[] = [];
  private client?: IconaBridgeClient;

  constructor(
    private readonly mode: AnswerMode,
    private readonly ourAddress: string,
    private readonly defaultPeer: string,
    private readonly sendFrame: (frame: Buffer) => Promise<void>,
    private readonly log?: Logging,
    private readonly timing: MediaTiming = DEFAULT_MEDIA_TIMING,
  ) {}

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  get answerMode(): AnswerMode {
    return this.mode;
  }

  /** The connection used for media channels (needed for video and audio). */
  attach(client: IconaBridgeClient): void {
    this.client = client;
  }

  /** True while a call is answered, or its media is starting or running. */
  busy(): boolean {
    this.activeCall(); // drops ended and stale calls
    return [...this.calls.values()].some((c) => !c.ended && (c.answered || c.answering !== undefined || c.media !== undefined || c.mediaStarting !== undefined));
  }

  /** The most recent call still in progress, if any. */
  activeCall(): Call | undefined {
    const now = Date.now();
    for (const [key, call] of this.calls) {
      if (call.ended || (!call.media && now - call.born > CALL_MAX_AGE_MS)) {
        this.calls.delete(key);
      }
    }
    return [...this.calls.values()].pop();
  }

  async onFrame(frame: CtpFrame, addresses: string[]): Promise<void> {
    if (!this.enabled) {
      return;
    }
    const key = (frame.conn1 << 8) | frame.conn0;
    let call = this.calls.get(key);
    if (!call && frame.flags === Flag.SYN && frame.opcode === Opcode.INVITE) {
      this.activeCall(); // drops ended and stale calls, so they don't pile up
      call = {
        conn0: frame.conn0,
        conn1: frame.conn1,
        seq: frame.ack,
        ack: (frame.seq + 1) & 0xff,
        peer: addresses[0] ?? this.defaultPeer,
        caller: frame.body.length >= 12 ? frame.body.subarray(2, 12).toString('latin1').replace(/\0+$/, '') : '',
        born: Date.now(),
        seen: new Set(),
        answered: false,
        ended: false,
      };
      this.calls.set(key, call);
    }
    if (!call) {
      return;
    }
    this.log?.debug(
      `call: rx flags=0x${frame.flags.toString(16)} seq=${frame.seq} ack=${frame.ack} op=0x${(frame.opcode & 0xffff).toString(16)} body=${hex(frame.body)}`,
    );
    if (frame.body.length > 0) {
      call.ack = (frame.seq + 1) & 0xff;
    }
    if (frame.opcode === Opcode.MEDIA_REQUEST && frame.body.length >= 10 && call.panelAudioHandle === undefined) {
      call.panelAudioHandle = frame.body.readUInt16LE(8);
    }
    for (const w of this.waiters.slice()) {
      if (w.call === call && (w.opcode === frame.opcode || frame.opcode === Opcode.RELEASE)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve({ opcode: frame.opcode, body: frame.body });
      }
    }
    if (frame.opcode === Opcode.RELEASE || frame.flags & Flag.FIN) {
      call.ended = true;
      call.media?.end('the intercom ended the call');
      return;
    }
    // Data from the intercom must be acknowledged. Most of it is, by the next frame we send; what
    // isn't was sent again and again: the media request three times (2026-11-08 17:02), and the
    // empty frame the intercom sends after 20 s of unanswered ringing five times over 7 s
    // (22:07, a keepalive probe: its sequence number isn't consumed, so the ack stays the same).
    const needsAck = frame.flags === Flag.DATA;
    const tag = `${frame.seq}:${frame.opcode}`;
    if (call.seen.has(tag)) {
      if (needsAck) {
        await this.sendAck(call); // a retransmission: our acknowledgement was missed
      }
      return;
    }
    call.seen.add(tag);
    if (frame.opcode === Opcode.INVITE) {
      await this.send(call, Flag.DATA, Buffer.from(frame.body), 'invite echo');
    } else if (frame.opcode === Opcode.CAPABILITIES) {
      await this.send(call, Flag.DATA, APP_CAPABILITIES, 'capabilities'); // acknowledges it too
    } else if (needsAck) {
      await this.sendAck(call);
    }
  }

  /** A plain acknowledgement (no data), as the intercom sends for ours. */
  private async sendAck(call: Call): Promise<void> {
    await this.send(call, Flag.ACK, Buffer.alloc(0), 'ack').catch(() => undefined);
  }

  /** Answers `call` (SETUP_ACK), once. */
  async answer(call: Call): Promise<void> {
    if (call.answered) {
      return;
    }
    call.answering ??= (async () => {
      const reply = this.wait(call, Opcode.SETUP_ACK, 1500);
      await this.send(call, Flag.DATA, SETUP_ACK, 'answer 000c');
      await reply;
      call.answered = true;
    })().finally(() => {
      call.answering = undefined;
    });
    await call.answering;
  }

  /**
   * Opens `door` inside the ringing call, answering it first. Used in `answer-on-open` mode,
   * and in `answer-on-view` mode once the call is answered. Returns null when there is
   * nothing to answer, so the caller opens the normal way.
   */
  /**
   * Opens the door inside the ringing call: answers it first if needed. `force` (doctor mode)
   * does so whatever the answer mode is.
   */
  async openInCall(door: Door, force = false): Promise<OpenResult | null> {
    const call = this.activeCall();
    if (!call || !(force || this.mode === 'answer-on-open' || (this.mode === 'answer-on-view' && call.answered))) {
      return null;
    }
    this.log?.debug('call: opening the door inside the call');
    await this.answer(call);
    const output = Number(door.outputIndex) || 1;
    const openBody = Buffer.concat([Buffer.from([0x00, 0x2d]), logicalAddress(door.aptAddress), Buffer.from([output & 0xff])]);
    const replyWait = this.wait(call, Opcode.OPEN_DOOR, 4000);
    await this.send(call, Flag.DATA, openBody, 'open in call');
    const reply = await replyWait;
    // Inside a call the intercom only acknowledges the open (seen on a 6741W, 2026-11-08: the
    // door opened, no reply). A refusal ends the call with a cause, so no reply means accepted.
    this.log?.debug(`call: open reply ${reply ? `op=0x${reply.opcode.toString(16)} body=${hex(reply.body)}` : 'none within 4 s (not refused)'}`);
    if (!call.ended && !call.media) {
      // Nobody is watching: hang up, as the app does after opening.
      await new Promise((r) => setTimeout(r, 1500));
      await this.hangUp(call);
    }
    const released = reply && reply.opcode === Opcode.RELEASE && reply.body.length >= 3;
    if (released && reply.body[2] !== 0) {
      throw new Error(`intercom refused the open in the call (cause ${reply.body[2]})`);
    }
    return { confirmed: !reply || Boolean(released && reply.body[2] === 0) };
  }

  /**
   * Answers the ringing call (if any) and starts video and audio. Returns null when there is
   * no call to answer or answering on view is off.
   */
  async startMedia(hd: boolean): Promise<MediaSession | null> {
    const call = this.activeCall();
    if (!call || this.mode !== 'answer-on-view') {
      return null;
    }
    if (!this.client) {
      throw new Error('no connection for media');
    }
    if (call.media) {
      return call.media;
    }
    const client = this.client;
    // A second viewer arriving while the first is still setting up joins that setup.
    call.mediaStarting ??= (async () => {
      await this.answer(call);
      const session = new MediaSession(this, client, call, hd, this.log, this.timing);
      try {
        await session.start();
      } catch (e) {
        // Leave nothing half-set-up behind; keep the call, so unlocking still works in it.
        await session.end(`media setup failed: ${(e as Error).message}`, false);
        throw e;
      }
      call.media = session;
      session.once('end', () => {
        call.media = undefined;
      });
      return session;
    })().finally(() => {
      call.mediaStarting = undefined;
    });
    return call.mediaStarting;
  }

  /** Hangs up `call` (RELEASE, cause 0). */
  async hangUp(call: Call): Promise<void> {
    if (call.ended) {
      return;
    }
    call.ended = true;
    await this.send(call, Flag.DATA_FIN, Buffer.from([0x00, 0x0e, 0x00]), 'hang up 000e').catch(() => undefined);
  }

  async send(call: Call, flags: number, body: Buffer, what: string): Promise<void> {
    const frame = buildFrame({
      flags,
      conn0: call.conn0 ^ 0x80,
      conn1: call.conn1,
      seq: call.seq,
      ack: call.ack,
      body,
      source: this.ourAddress,
      destination: call.peer,
    });
    if (flags & Flag.DATA) {
      call.seq = (call.seq + 1) & 0xff;
    }
    this.log?.debug(`call: tx ${what}: ${hex(frame.subarray(0, 8 + body.length))}`);
    await this.sendFrame(frame);
  }

  wait(call: Call, opcode: number, ms: number): Promise<{ opcode: number; body: Buffer } | null> {
    return new Promise((resolve) => {
      const waiter: Waiter = { call, opcode, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(null);
        }
      }, ms);
    });
  }
}

/**
 * Video and audio of an answered call. Emits:
 *   'video' (Annex-B H.264 NAL unit), 'audio' (G.711 A-law payload), 'end' (reason).
 */
export class MediaSession extends EventEmitter {
  private udpHandle?: number;
  private audioHandle?: number;
  private videoHandle?: number;
  /** Where the intercom wants our talk-back audio (from its media request). */
  private txHandle?: number;
  private readonly mediaHandles = new Set<number>();
  private readonly depacketizer = new H264Depacketizer();
  private timers: NodeJS.Timeout[] = [];
  private ended = false;
  private lastMedia = 0;
  private stats = { video: 0, audio: 0, other: 0, sent: 0 };
  /** When media started, the first video packet, the first SPS and the keyframes (for the log). */
  private startedAt = 0;
  private firstVideoAt = 0;
  private firstSpsAt = 0;
  private keyframeAt: number[] = [];
  private keyframeRetry?: NodeJS.Timeout;
  private videoSize?: string;
  /** A muted handler for channels being closed, so their last packets aren't logged as unknown. */
  private readonly drop = (): void => undefined;
  private tx = { seq: Math.floor(Math.random() * 0xffff), ts: Math.floor(Math.random() * 0xffffffff), ssrc: Math.floor(Math.random() * 0xffffffff), first: true };
  private readonly onChannel = (name: string, handle: number) => {
    if (name === 'RTPC') {
      this.log?.debug(`call: intercom opened media channel ${handle}`);
      this.route(handle);
    }
  };

  constructor(
    private readonly handler: CallHandler,
    private readonly client: IconaBridgeClient,
    private readonly call: Call,
    private readonly hd: boolean,
    private readonly log?: Logging,
    private readonly timing: MediaTiming = DEFAULT_MEDIA_TIMING,
  ) {
    super();
  }

  async start(): Promise<void> {
    const started = Date.now();
    this.startedAt = started;
    this.client.on('channel', this.onChannel);
    this.udpHandle = (await this.client.openChannel('UDPM', ChannelType.UAUT)).serverChannelId;
    this.audioHandle = (await this.client.openChannel('RTPC-audio', ChannelType.UAUT, undefined, 0, 'RTPC')).serverChannelId;
    this.videoHandle = (await this.client.openChannel('RTPC-video', ChannelType.UAUT, undefined, 0, 'RTPC')).serverChannelId;
    // The intercom sends video on the handle after the one offered.
    for (const h of [this.audioHandle, this.videoHandle, (this.videoHandle + 1) & 0xffff]) {
      this.route(h);
    }
    this.log?.debug(`call: media channels udp=${this.udpHandle} audio=${this.audioHandle} video=${this.videoHandle}`);

    // The intercom usually sends its own audio request right after the answer, before ours:
    // only wait for it if it hasn't come yet.
    const panelAudio = this.call.panelAudioHandle === undefined ? this.handler.wait(this.call, Opcode.MEDIA_REQUEST, 3000) : undefined;
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_OFFER, le16(this.audioHandle), Buffer.alloc(2)]), 'audio request');
    await panelAudio;
    this.txHandle = this.call.panelAudioHandle;
    if (this.txHandle !== undefined) {
      this.log?.debug(`call: intercom takes our audio on channel ${this.txHandle}`);
    } else {
      this.log?.warn('call: the intercom sent no audio request; talk-back goes to our audio channel');
    }
    // Without VOICESTATUS the intercom accepts the audio request but sends no audio.
    await this.voiceStatus(1);
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_OFFER, le16(this.audioHandle), Buffer.alloc(2)]), 'audio request');
    await this.requestVideo();

    this.timers.push(setInterval(() => void this.requestVideo().catch(() => undefined), this.timing.videoRefreshMs));
    this.timers.push(
      setInterval(() => {
        const now = Date.now();
        if (this.lastMedia === 0 && now - started > this.timing.startTimeoutMs) {
          void this.end('no media from the intercom');
        } else if (this.lastMedia > 0 && now - this.lastMedia > this.timing.silenceMs) {
          void this.end('media stopped');
        }
      }, 1000),
    );
    this.timers.push(
      setInterval(() => {
        this.log?.debug(`call: media received video=${this.stats.video} audio=${this.stats.audio} other=${this.stats.other} packets; talk-back sent=${this.stats.sent}`);
      }, STATS_INTERVAL_MS),
    );
  }

  private route(handle: number): void {
    this.mediaHandles.add(handle);
    this.client.setBinaryHandler(handle, (body) => this.onMedia(body));
  }

  private onMedia(body: Buffer): void {
    const rtp = parseRtp(body);
    if (!rtp) {
      this.stats.other++;
      return;
    }
    this.lastMedia = Date.now();
    if (rtp.payloadType === ALAW_PAYLOAD_TYPE) {
      this.stats.audio++;
      this.emit('audio', rtp.payload);
      return;
    }
    this.stats.video++;
    if (this.firstVideoAt === 0) {
      this.firstVideoAt = Date.now();
      // Joining a stream that is already running, the first keyframe can be seconds away;
      // until then nothing can be shown. Asking for video again may bring one sooner.
      this.keyframeRetry = setTimeout(() => {
        if (this.firstSpsAt === 0 && !this.ended) {
          this.log?.debug('call: no keyframe yet; asking for video again');
          void this.requestVideo().catch(() => undefined);
        }
      }, NO_KEYFRAME_RETRY_MS);
    }
    for (const unit of this.depacketizer.push(rtp)) {
      this.noteUnit(unit);
      this.emit('video', unit);
    }
  }

  /** One line for the live view summary: what the intercom sent and when. */
  describe(): string {
    const t = (at: number) => (at ? `${((at - this.startedAt) / 1000).toFixed(1)} s` : 'never');
    const every = this.keyframeAt.length >= 2 ? `${((this.keyframeAt[this.keyframeAt.length - 1] - this.keyframeAt[0]) / (this.keyframeAt.length - 1) / 1000).toFixed(1)} s` : 'n/a';
    return (
      `intercom: ${this.videoSize ?? 'size unknown'}, first video ${t(this.firstVideoAt)}, first keyframe ${t(this.firstSpsAt)}, keyframe every ${every}, ` +
      `packets video=${this.stats.video} audio=${this.stats.audio} other=${this.stats.other}, talk-back sent=${this.stats.sent}`
    );
  }

  /** Logs the picture size, how long the first keyframe took, and the keyframe interval. */
  private noteUnit(unit: Buffer): void {
    const type = nalType(unit);
    const now = Date.now();
    if (type === 7 && this.firstSpsAt === 0) {
      this.firstSpsAt = now;
      clearTimeout(this.keyframeRetry);
      const sps = parseSps(unit);
      const size = sps ? `${sps.width}x${sps.height}, profile ${sps.profile}, level ${sps.level / 10}` : 'size unknown';
      this.videoSize = sps ? `${sps.width}x${sps.height}` : undefined;
      this.log?.debug(
        `call: video ${size}; first keyframe ${((now - this.startedAt) / 1000).toFixed(1)} s after the media request, ` +
          `${((now - this.firstVideoAt) / 1000).toFixed(1)} s after the first video packet`,
      );
    } else if (type === 5 && (this.keyframeAt.length === 0 || now - this.keyframeAt[this.keyframeAt.length - 1] > 200)) {
      this.keyframeAt.push(now);
      if (this.keyframeAt.length === 3) {
        const [a, , c] = this.keyframeAt;
        this.log?.debug(`call: a keyframe every ${((c - a) / 2000).toFixed(1)} s`);
      }
    }
  }

  private async requestVideo(): Promise<void> {
    if (this.ended || this.videoHandle === undefined) {
      return;
    }
    const settings = this.hd ? videoSettings(HD_RESOLUTION, 1000) : videoSettings(SD_RESOLUTION, 0);
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([VIDEO_OFFER, le16(this.videoHandle), settings]), 'video request');
  }

  private async voiceStatus(status: 0 | 1): Promise<void> {
    const body = Buffer.concat([Buffer.from([0x00, OP_VOICESTATUS]), logicalAddress(this.call.caller || this.call.peer), Buffer.from([status, 0])]);
    await this.handler.send(this.call, Flag.DATA, body, `voice status ${status}`);
  }

  /** Sends 20 ms of G.711 A-law (160 bytes) to the intercom's speaker. */
  async sendAudio(alaw: Buffer): Promise<void> {
    const handle = this.txHandle ?? this.audioHandle;
    if (this.ended || handle === undefined) {
      return;
    }
    const packet = buildRtp({ marker: this.tx.first, payloadType: ALAW_PAYLOAD_TYPE, sequence: this.tx.seq, timestamp: this.tx.ts, ssrc: this.tx.ssrc }, alaw);
    this.tx.first = false;
    this.tx.seq = (this.tx.seq + 1) & 0xffff;
    this.tx.ts = (this.tx.ts + alaw.length) >>> 0;
    this.stats.sent++;
    await this.client.sendOnHandle(handle, packet);
  }

  /** Stops the media and, with `hangUp`, hangs up (unless the intercom already ended the call). */
  async end(reason: string, hangUp = true): Promise<void> {
    if (this.ended) {
      return;
    }
    this.ended = true;
    for (const t of this.timers) {
      clearInterval(t);
    }
    this.timers = [];
    clearTimeout(this.keyframeRetry);
    this.client.off('channel', this.onChannel);
    this.log?.debug(`call: media ended (${reason}); video=${this.stats.video} audio=${this.stats.audio} packets; talk-back sent=${this.stats.sent}`);
    if (!this.call.ended) {
      await this.voiceStatus(0).catch(() => undefined);
      if (this.audioHandle !== undefined) {
        await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_STOP, le16(this.audioHandle), Buffer.alloc(2)]), 'audio stop').catch(() => undefined);
      }
      if (hangUp) {
        await this.handler.hangUp(this.call);
      }
    }
    // Packets keep coming until the channels are closed: drop them quietly, then let go.
    for (const h of this.mediaHandles) {
      this.client.setBinaryHandler(h, this.drop);
    }
    for (const [name, h] of [['RTPC-audio', this.audioHandle], ['RTPC-video', this.videoHandle], ['UDPM', this.udpHandle]] as const) {
      if (h !== undefined) {
        await this.client.closeHandle(name, h);
      }
    }
    // The intercom keeps sending for a moment after the close: stay quiet a little longer.
    const handles = [...this.mediaHandles];
    const release = setTimeout(() => {
      for (const h of handles) {
        if (this.client.binaryHandlerFor(h) === this.drop) {
          this.client.setBinaryHandler(h);
        }
      }
    }, LATE_PACKETS_MS);
    release.unref?.();
    this.emit('end', reason);
  }
}
