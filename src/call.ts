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
 * Experimental, live view without a ring: when nobody is ringing, the plugin can place its own
 * call to the entrance panel, as the Comelit app's camera button does (the outgoing call of
 * PCAP-verified implementations such as antoiba86/hass-comelit-intercom-local; see placeCall):
 *
 *   we → INVITE (SYN): our address, the panel's, a session block, "II"
 *   intercom → echo/acknowledgement   we → our CAPABILITIES
 *   intercom → CAPABILITIES, then SETUP_ACK (the panel accepted)
 *   we → open UDPM + 2 × RTPC, audio and video media requests (no VOICESTATUS: video only)
 *   intercom → its media request, then RTP;  we → an empty DATA frame ("ready")
 *   (with Sound in live view without a ring, the media setup is instead an answered ring's:
 *   audio request, the panel's media request, VOICESTATUS 1, audio request again, video request)
 *   we → RELEASE (0x000E) to hang up when the live view closes
 *
 * Every frame of a call is logged with the prefix `call:`.
 */
import { randomBytes } from 'crypto';
import { KeyframeTrace, type VideoSource } from './keyframes';
import { EventEmitter } from 'events';
import type { Logging } from 'homebridge';
import { ChannelType } from './channels';
import type { IconaBridgeClient } from './client';
import { buildFrame, CtpFrame, Flag, logicalAddress, Opcode } from './ctp';
import { RECORDING_MAX_MS } from './settings';
import { ALAW_PAYLOAD_TYPE, buildRtp, H264Depacketizer, LEFTOVER_GAP_MS, MIN_PICTURE_BYTES, nalType, parseRtp, parseSps, alawLevel } from './media';
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
/** A waiter for any frame (see CallHandler.wait). */
const ANY_FRAME = -2;
/** Live view without a ring: the longest wait for each step of our call to the panel. */
const OUTBOUND_STEP_MS = 5_000;
/** Switching a live view to sound: tries to place the new call, and the pause before each. */
const SOUND_REDIAL_ATTEMPTS = 3;
const SOUND_REDIAL_PAUSE_MS = 500;
/** 'When you talk': no microphone sound this long means the Home app's microphone was turned off. */
const MIC_QUIET_MS = 2_000;
/** After asking the panel to close the sound, how long to count its sound packets (for the log). */
const SOUND_OFF_CHECK_MS = 3_000;
/** Sound packets in the first second after asking may have been on their way already. */
const SOUND_OFF_SETTLE_MS = 1_000;
/** The panel's sound level just before asking, to compare with. */
const SOUND_OFF_BEFORE_MS = 2_000;
/** Below this mean level (16-bit), the entrance is too quiet to tell an open microphone from a closed one. */
const QUIET_LEVEL = 60;

type SoundLevel = { packets: number; level: number };

/** The panel's sound between two times: how many packets, and their mean level. */
function soundLevelOf(log: ReadonlyArray<[number, number]>, from: number, to: number): SoundLevel {
  const inside = log.filter(([at]) => at >= from && at < to);
  return { packets: inside.length, level: inside.length ? inside.reduce((sum, [, l]) => sum + l, 0) / inside.length : 0 };
}

function describeLevel(s: SoundLevel): string {
  return `${s.packets} packets, level ${Math.round(s.level)}`;
}

/**
 * Did the panel close the sound after VOICESTATUS 0? Judged from the street noise, not from being at
 * the door: closed if its sound packets stop, or keep coming but drop from street noise to near
 * silence; open if they keep coming as loud as before; 'unknown' if the street was too quiet before
 * to tell (a closed microphone and a quiet street sound the same).
 */
export function judgeSoundOff(before: SoundLevel, after: SoundLevel, seconds: number): 'open' | 'closed' | 'unknown' {
  if (after.packets < 5 * seconds) {
    return 'closed'; // the stream stopped (it runs at 50 packets a second while open)
  }
  if (before.packets === 0 || before.level < QUIET_LEVEL) {
    return after.level >= QUIET_LEVEL ? 'open' : 'unknown';
  }
  return after.level < Math.max(QUIET_LEVEL, before.level / 4) ? 'closed' : 'open';
}
/** The session block of our INVITE starts with these two bytes (as the Comelit app's). */
const OUTBOUND_SESSION_FLAGS = Buffer.from([0x01, 0x20]);

/** Live view without a ring (setting liveViewWithoutRing, and the panel from the address book). */
export interface OutboundOptions {
  liveViewWithoutRing?: boolean;
  /**
   * Sound in live view without a ring: 'always' answers our own call as a ring is (sound from the
   * start); 'talk' places it silent, then again with the sound when the microphone is turned on.
   */
  liveViewSound?: 'off' | 'talk' | 'always';
  /** The entrance panel's address (the intercom's entrance-address-book). */
  panelAddress?: string;
}

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
  /** Our answer (SETUP_ACK) has been sent: media requests from now on are for the call. */
  answerSent?: boolean;
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
  /** The ring preview: video asked for during the ring, before anyone answers. */
  preview?: RingPreview;
  /** Our own call to the panel (live view without a ring), not a ring. */
  outbound?: boolean;
  /** Outbound: our CAPABILITIES have been sent. */
  capsSent?: boolean;
}

interface Waiter {
  call: Call;
  opcode: number;
  resolve: (r: { opcode: number; body: Buffer } | null) => void;
}

const hex = (b: Buffer) => b.toString('hex');
/** The ring preview stops this long after its first keyframe, or after PREVIEW_MAX_MS. */
/** After the first picture: long enough for a fresh keyframe to follow the intercom's old one (LEFTOVER_GAP_MS). */
const PREVIEW_AFTER_KEYFRAME_MS = LEFTOVER_GAP_MS + 300;
/** While a ring is recorded, the preview stops after this long without video. */
const PREVIEW_RECORDING_SILENCE_MS = 4_000;
const PREVIEW_MAX_MS = 8_000;

/** Ring preview settings: off unless set. `onVideo` gets the preview's H.264 units. */
/** Hears every call's video, sound and end (recording). */
export interface CallListener {
  video: (call: object, unit: Buffer) => void;
  audio?: (call: object, data: Buffer) => void;
  ended: (call: object) => void;
}

export interface RingPreviewOptions {
  hd: boolean;
  onVideo: (call: object, unit: Buffer) => void;
  /** The preview has started (its channels are being opened). */
  onStart?: (call: object) => void;
  /** Keep the video coming for the whole ring (recording), instead of stopping at the first picture. */
  keepRunning?: () => boolean;
  /** The intercom sent an empty (black) keyframe: the real picture will come with the next one. */
  onEmptyKeyframe?: (call: object) => void;
  /** The preview has stopped, with or without a picture. */
  onDone?: (call: object) => void;
}
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
    private readonly outboundOptions: OutboundOptions = {},
  ) {}

  /** Sound in live view without a ring: 'off', 'talk' or 'always'. */
  get liveViewSound(): 'off' | 'talk' | 'always' {
    return this.outboundOptions.liveViewSound ?? 'off';
  }

  /**
   * Places a new call of our own to the panel (for a live view switching to sound): the same
   * call as for live view without a ring, outside startMedia.
   */
  async placeOwnCall(): Promise<Call> {
    if (!this.client) {
      throw new Error('no connection for media');
    }
    return this.placeCall();
  }

  /** Live view without a ring is on, and the panel to call is known. */
  get canCallPanel(): boolean {
    return Boolean(this.outboundOptions.liveViewWithoutRing && this.outboundOptions.panelAddress) && this.enabled;
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /** Who hears each call's video (ring preview or live view) and its end: the recorder. */
  private listener?: CallListener;
  setCallListener(listener: CallListener | undefined): void {
    this.listener = listener;
  }
  /** Debug log of the keyframes at the start of each call (see keyframes.ts). */
  private readonly keyframes = new KeyframeTrace((line) => this.log?.debug(line));

  /** A call's video unit, for the listener. */
  callVideo(call: object, unit: Buffer, source: VideoSource = 'live view'): void {
    const own = (call as Partial<Call>).outbound === true;
    this.keyframes.video(call, (call as Partial<Call>).born ?? Date.now(), unit, own ? 'own call' : source);
    if (!own) {
      this.listener?.video(call, unit); // our own calls to the panel are not rings: not recorded
    }
  }
  /** A call's sound (A-law), for the listener. */
  callAudio(call: object, data: Buffer): void {
    if (!(call as Partial<Call>).outbound) {
      this.listener?.audio?.(call, data);
    }
  }
  private callEnded(call: Call): void {
    this.keyframes.ended(call);
    if (!call.outbound) {
      this.listener?.ended(call);
    }
  }

  /** Whether a frame from the intercom belongs to one of our own calls to the panel (not a ring). */
  isOwnCall(conn0: number, conn1: number): boolean {
    return this.calls.get((conn1 << 8) | conn0)?.outbound === true;
  }

  /** Whether a ring starts a ring preview (calls are followed and the preview is on). */
  get previewOn(): boolean {
    return this.enabled && this.preview !== undefined;
  }

  get answerMode(): AnswerMode {
    return this.mode;
  }

  /** The connection used for media channels (needed for video and audio). */
  attach(client: IconaBridgeClient): void {
    this.client = client;
  }

  /** Experimental: ask for video during the ring, before anyone answers (see RingPreview). */
  private preview?: RingPreviewOptions;
  enablePreview(options: RingPreviewOptions | undefined): void {
    this.preview = options;
  }

  /** True while a call is answered, or its media is starting or running. */
  busy(): boolean {
    this.activeCall(); // drops ended and stale calls
    if (this.placing !== undefined || this.soundSwitch !== undefined) {
      return true; // our own call is being placed (again, with sound): no call has the view yet
    }
    return [...this.calls.values()].some(
      (c) => !c.ended && (c.answered || c.answering !== undefined || c.media !== undefined || c.mediaStarting !== undefined || (c.preview !== undefined && !c.preview.done)),
    );
  }

  /**
   * The most recent ring still in progress, if any: like activeCall(), but never one of our own
   * calls to the panel (live view without a ring). Doors are only ever opened inside a ring.
   */
  ringingCall(): Call | undefined {
    this.activeCall(); // drops ended and stale calls
    return [...this.calls.values()].filter((c) => !c.outbound).pop();
  }

  private warnedNoVideo = false;

  /**
   * Our own call to the panel (live view without a ring) ended without any video: warns once
   * per run, since some systems accept the call but never send video.
   */
  noVideoFromOwnCall(reason: string): void {
    if (this.warnedNoVideo) {
      return;
    }
    this.warnedNoVideo = true;
    this.log?.warn(
      `Live view without a ring: the entrance panel took the call but sent no video (${reason}). ` +
        "Check that the entrance panel is at address 0 (on an EX-DSME, DIP 1-3 OFF) and the monitor in Kit mode; " +
        "if the Comelit app's Entrance button can't show the entrance without a ring either, turn Live view without a ring off.",
    );
  }

  /** The most recent call still in progress, if any. */
  activeCall(): Call | undefined {
    const now = Date.now();
    for (const [key, call] of this.calls) {
      if (call.ended || (!call.media && now - call.born > CALL_MAX_AGE_MS)) {
        this.calls.delete(key);
        this.callEnded(call);
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
    // Where the intercom takes our sound: from its media request after our answer (one in
    // reply to the ring preview's sound request is not for the call).
    if (frame.opcode === Opcode.MEDIA_REQUEST && frame.body.length >= 10 && call.panelAudioHandle === undefined && call.answerSent) {
      call.panelAudioHandle = frame.body.readUInt16LE(8);
    }
    for (const w of this.waiters.slice()) {
      if (w.call === call && (w.opcode === frame.opcode || w.opcode === ANY_FRAME || frame.opcode === Opcode.RELEASE)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve({ opcode: frame.opcode, body: frame.body });
      }
    }
    if (frame.opcode === Opcode.RELEASE || frame.flags & Flag.FIN) {
      call.ended = true;
      this.callEnded(call);
      call.media?.end('the intercom ended the call');
      void call.preview?.stop(`the intercom ended the call${frame.body.length >= 3 && frame.opcode === Opcode.RELEASE ? ` (cause ${frame.body[2]})` : ''}`);
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
    if (call.outbound) {
      // Our call to the panel: the panel's echo of our INVITE and its capabilities are only
      // acknowledged (placeCall sends our capabilities, unless the panel's come first). Never
      // a ring preview.
      if (frame.opcode === Opcode.CAPABILITIES && !call.capsSent) {
        call.capsSent = true;
        await this.send(call, Flag.DATA, APP_CAPABILITIES, 'capabilities'); // acknowledges it too
      } else if (needsAck) {
        await this.sendAck(call);
      }
      return;
    }
    if (frame.opcode === Opcode.INVITE) {
      await this.send(call, Flag.DATA, Buffer.from(frame.body), 'invite echo');
    } else if (frame.opcode === Opcode.CAPABILITIES) {
      await this.send(call, Flag.DATA, APP_CAPABILITIES, 'capabilities'); // acknowledges it too
      if (this.preview && this.client && !call.preview && !call.answered && call.answering === undefined) {
        // Not awaited: the call's frames must keep flowing while the preview waits for video.
        call.preview = new RingPreview(this, this.client, call, this.preview, this.log);
        this.preview.onStart?.(call);
        void call.preview.start();
      }
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
      // The preview's channels go before the call's own media starts.
      await call.preview?.stop('the call is being answered');
      const reply = this.wait(call, Opcode.SETUP_ACK, 1500);
      call.answerSent = true;
      await this.send(call, Flag.DATA, SETUP_ACK, 'answer 000c');
      await reply;
      call.answered = true;
    })().finally(() => {
      call.answering = undefined;
    });
    await call.answering;
  }

  /**
   * Opens `door` inside the ringing call, answering it first if needed, and hangs up afterwards
   * if nobody is watching. In `answer-on-open` and `answer-on-view` mode (so a ring can be let
   * in from the lock without opening the live view); `force` (doctor mode) whatever the mode.
   * Returns null when there is no call, so the caller opens the normal way. Only a ring counts:
   * our own call to the panel (live view without a ring) is never used to open, so doctor mode,
   * Next Visitor and the lock never open the door inside it (the lock then opens the normal way).
   */
  /**
   * `stillWanted` is asked once more after answering, just before the open (doctor mode and
   * Next Visitor: their switch may have been turned off meanwhile); if not, the call, now
   * answered, is hung up and null returned.
   */
  async openInCall(door: Door, force = false, stillWanted?: () => boolean): Promise<OpenResult | null> {
    const call = this.ringingCall();
    if (!call || !(force || this.mode === 'answer-on-open' || this.mode === 'answer-on-view')) {
      return null;
    }
    this.log?.debug('call: opening the door inside the call');
    // Whether this open answers the call, or a live view already is/was answering it.
    const ownAnswer = !call.answered && call.answering === undefined && call.mediaStarting === undefined && call.media === undefined;
    await this.answer(call);
    if (call.ended) {
      // Answered elsewhere, or the ringing ended, meanwhile: open the normal way instead.
      this.log?.debug('call: the call ended while answering; opening the normal way');
      return null;
    }
    if (stillWanted && !stillWanted()) {
      // Cancelled: hang up the call this open answered, but not one a live view is showing.
      if (ownAnswer && !call.media && !call.mediaStarting) {
        this.log?.debug('call: the open was cancelled while answering; hanging up');
        await this.hangUp(call);
      } else {
        this.log?.debug('call: the open was cancelled while answering; the live view keeps the call');
      }
      return null;
    }
    const output = Number(door.outputIndex) || 1;
    const openBody = Buffer.concat([Buffer.from([0x00, 0x2d]), logicalAddress(door.aptAddress), Buffer.from([output & 0xff])]);
    const replyWait = this.wait(call, Opcode.OPEN_DOOR, 4000);
    await this.send(call, Flag.DATA, openBody, 'open in call');
    const reply = await replyWait;
    // Inside a call the intercom only acknowledges the open (seen on a 6741W, 2026-11-08: the
    // door opened, no reply). A refusal ends the call with a cause, so no reply means accepted.
    this.log?.debug(`call: open reply ${reply ? `op=0x${reply.opcode.toString(16)} body=${hex(reply.body)}` : 'none within 4 s (not refused)'}`);
    if (!call.ended && !call.media) {
      // Nobody is watching: hang up, as the app does after opening. Check again after the
      // pause, in case a live view opened meanwhile (and wait for one that is starting: if it
      // fails, the call is still to be hung up).
      await new Promise((r) => setTimeout(r, 1500));
      await call.mediaStarting?.catch(() => undefined);
      if (!call.ended && !call.media) {
        await this.hangUp(call);
      }
    }
    const released = reply && reply.opcode === Opcode.RELEASE && reply.body.length >= 3;
    if (released && reply.body[2] !== 0) {
      throw new Error(`intercom refused the open in the call (cause ${reply.body[2]})`);
    }
    return { confirmed: !reply || Boolean(released && reply.body[2] === 0) };
  }

  /** The panel ignored a VOICESTATUS 0 mid-call (MediaSession.closeSound): don't ask again until a restart. */
  soundOffIgnored = false;

  /** A live view whose own call is being placed again with sound (MediaSession.openSound). */
  soundSwitch?: MediaSession;

  /**
   * Answers the ringing call (if any) and starts video and audio. Returns null when there is
   * no call to answer or answering on view is off.
   */
  async startMedia(hd: boolean): Promise<MediaSession | null> {
    const switching = this.soundSwitch;
    if (switching) {
      // A second viewer while a view switches to sound joins that view, not a call of its own.
      await switching.openSound();
      if (!switching.isEnded) {
        return switching;
      }
    }
    let call = this.activeCall();
    if (!call && this.canCallPanel) {
      // Nobody is ringing: with live view without a ring, call the panel ourselves. A second
      // viewer arriving while the call is being placed joins it.
      if (!this.client) {
        throw new Error('no connection for media');
      }
      this.placing ??= this.placeCall().finally(() => {
        this.placing = undefined;
      });
      call = await this.placing;
    }
    if (!call || (!call.outbound && this.mode !== 'answer-on-view')) {
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
      if (call.ended) {
        // The intercom ended the call while the media was being set up.
        await session.end('the intercom ended the call', false);
        return null;
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

  private placing?: Promise<Call>;

  /**
   * Places our own call to the entrance panel, as the Comelit app's camera button does, and
   * returns it once the panel has accepted it (its SETUP_ACK). The frames follow the Comelit
   * app's outgoing call (PCAP-verified by antoiba86/hass-comelit-intercom-local and used by
   * Jordi-14/ha-component-comelit-intercom on a 6741W), in this plugin's CTP terms: the INVITE
   * body is our address, the panel's, a session block (0x01 0x20 + 4 random bytes), our address
   * again and "II".
   */
  private async placeCall(): Promise<Call> {
    const panel = this.outboundOptions.panelAddress;
    if (!panel) {
      throw new Error('no entrance panel in the intercom config (entrance-address-book)');
    }
    this.activeCall(); // drops ended and stale calls
    // Our connection id. The intercom's frames on it come with the top bit of the first byte
    // flipped, and that is how a call is stored (send() flips it back), as for its own calls.
    let conn0 = 0;
    let conn1 = 0;
    do {
      const id = randomBytes(2);
      conn0 = id[0] ^ 0x80;
      conn1 = id[1];
    } while (this.calls.has((conn1 << 8) | conn0));
    const start = randomBytes(2);
    const call: Call = {
      conn0,
      conn1,
      seq: start[0],
      ack: start[1],
      peer: panel,
      caller: panel,
      born: Date.now(),
      seen: new Set(),
      answered: false,
      ended: false,
      outbound: true,
    };
    this.calls.set((conn1 << 8) | conn0, call);
    const invite = Buffer.concat([
      Buffer.from([0x00, Opcode.INVITE]),
      logicalAddress(this.ourAddress),
      logicalAddress(panel),
      OUTBOUND_SESSION_FLAGS,
      randomBytes(4),
      logicalAddress(this.ourAddress),
      Buffer.from('II', 'latin1'),
    ]);
    this.log?.debug(`call: calling the entrance panel ${panel} (live view without a ring)`);
    try {
      const first = this.wait(call, ANY_FRAME, OUTBOUND_STEP_MS);
      const accepted = this.wait(call, Opcode.SETUP_ACK, 2 * OUTBOUND_STEP_MS);
      await this.send(call, Flag.SYN, invite, 'outgoing call (invite)');
      const reply = await first;
      if (!reply) {
        throw new Error('the intercom did not answer our call');
      }
      if (reply.opcode === Opcode.RELEASE) {
        throw new Error(`the intercom refused our call${reply.body.length >= 3 ? ` (cause ${reply.body[2]})` : ''}`);
      }
      if (!call.capsSent) {
        call.capsSent = true;
        await this.send(call, Flag.DATA, APP_CAPABILITIES, 'capabilities');
      }
      const r = await accepted;
      if (r?.opcode === Opcode.RELEASE || call.ended) {
        throw new Error(`the intercom ended our call${r && r.body.length >= 3 ? ` (cause ${r.body[2]})` : ''}`);
      }
      if (!r) {
        // The media request that follows tells whether the panel took the call.
        this.log?.debug(`call: no SETUP_ACK from the panel within ${(2 * OUTBOUND_STEP_MS) / 1000} s; starting the media anyway`);
      }
      call.answered = true;
      call.answerSent = true; // media requests from now on are for this call
      return call;
    } catch (e) {
      await this.hangUp(call);
      throw e;
    }
  }

  /** Hangs up `call` (RELEASE, cause 0). */
  async hangUp(call: Call): Promise<void> {
    if (call.ended) {
      return;
    }
    call.ended = true;
    this.callEnded(call);
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

  /** True once the session has ended (by us or the intercom). */
  get isEnded(): boolean {
    return this.ended;
  }
  private lastMedia = 0;
  /** When the silence watchdog's "no media yet" time starts: the view's start, or the switch to a call with sound. */
  private watchStart = 0;
  private stats = { video: 0, audio: 0, other: 0, sent: 0 };
  /** The intercom's sound, for the log: packets missing by sequence number, and the longest pause. */
  private readonly sound = { lastSeq: -1, lastAt: 0, lost: 0, pauseMs: 0, pauseAt: 0 };
  /** When media started, the first video packet, the first SPS and the keyframes (for the log). */
  private startedAt = 0;
  private firstVideoAt = 0;
  private firstSpsAt = 0;
  private keyframeAt: number[] = [];
  private keyframeRetry?: NodeJS.Timeout;
  /** No keyframe yet in this call (at the start, and again after switching to a call with sound). */
  private awaitingKeyframe = true;
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
    private call: Call,
    private readonly hd: boolean,
    private readonly log?: Logging,
    private readonly timing: MediaTiming = DEFAULT_MEDIA_TIMING,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.watchStart = Date.now();
    this.startedAt = this.watchStart;
    this.client.on('channel', this.onChannel);
    this.udpHandle = (await this.client.openChannel('UDPM', ChannelType.UAUT)).serverChannelId;
    this.audioHandle = (await this.client.openChannel('RTPC-audio', ChannelType.UAUT, undefined, 0, 'RTPC')).serverChannelId;
    this.videoHandle = (await this.client.openChannel('RTPC-video', ChannelType.UAUT, undefined, 0, 'RTPC')).serverChannelId;
    // The intercom sends video on the handle after the one offered.
    for (const h of [this.audioHandle, this.videoHandle, (this.videoHandle + 1) & 0xffff]) {
      this.route(h);
    }
    this.log?.debug(`call: media channels udp=${this.udpHandle} audio=${this.audioHandle} video=${this.videoHandle}`);

    if (this.call.outbound && this.handler.liveViewSound === 'always') {
      // Sound in live view without a ring: the panel only opens the sound as part of the call's
      // setup (VOICESTATUS sent mid-call is ignored, 2026-11-19), so our own call is answered
      // exactly as a ring is, sound both ways from the start.
      await this.startAnswered(this.audioHandle);
    } else if (this.call.outbound) {
      await this.startOutbound(this.audioHandle);
    } else {
      await this.startAnswered(this.audioHandle);
    }

    this.timers.push(
      setInterval(() => {
        if (!this.switching) {
          void this.requestVideo().catch(() => undefined); // (while switching, the new call's setup asks for video in its own order)
        }
      }, this.timing.videoRefreshMs),
    );
    this.timers.push(
      setInterval(() => {
        if (this.switching) {
          return; // a pause while switching to sound is expected (openSound)
        }
        const now = Date.now();
        if (this.lastMicAt > 0 && now - this.lastMicAt > MIC_QUIET_MS) {
          this.lastMicAt = 0;
          void this.closeSound().catch(() => undefined);
        }
        if (this.lastMedia === 0 && now - this.watchStart > this.timing.startTimeoutMs) {
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

  /**
   * An answered ring: the Comelit app's answer (audio request, VOICESTATUS, video request). Also
   * our own call to the panel with Sound in live view without a ring.
   */
  private async startAnswered(audioHandle: number): Promise<void> {
    const own = this.call.outbound === true;
    // The intercom usually sends its own audio request right after the answer, before ours:
    // only wait for it if it hasn't come yet. Our own call waits as long as startOutbound does.
    const panelAudio = this.call.panelAudioHandle === undefined ? this.handler.wait(this.call, Opcode.MEDIA_REQUEST, own ? OUTBOUND_STEP_MS : 3000) : undefined;
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_OFFER, le16(audioHandle), Buffer.alloc(2)]), 'audio request');
    const r = await panelAudio;
    if (own && (r?.opcode === Opcode.RELEASE || this.call.ended)) {
      throw new Error(`the intercom ended our call${r && r.body.length >= 3 ? ` (cause ${r.body[2]})` : ''}`);
    }
    this.txHandle = this.call.panelAudioHandle;
    if (this.txHandle !== undefined) {
      this.log?.debug(`call: intercom takes our audio on channel ${this.txHandle}`);
    } else {
      this.log?.warn('call: the intercom sent no audio request; talk-back goes to our audio channel');
    }
    // Without VOICESTATUS the intercom accepts the audio request but sends no audio.
    await this.voiceStatus(1);
    if (own) {
      this.voiceOpen = true; // VOICESTATUS 0 when the view closes
    }
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_OFFER, le16(audioHandle), Buffer.alloc(2)]), 'audio request');
    await this.requestVideo();
  }

  /**
   * Our own call to the panel (live view without a ring), as the Comelit app's camera button:
   * the audio and video requests at once, then the panel's own media request, then an empty
   * DATA frame that tells the panel we're ready. No VOICESTATUS, so this is a video view (Sound
   * in live view without a ring uses startAnswered instead).
   */
  private async startOutbound(audioHandle: number): Promise<void> {
    const panelMedia = this.call.panelAudioHandle === undefined ? this.handler.wait(this.call, Opcode.MEDIA_REQUEST, OUTBOUND_STEP_MS) : undefined;
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_OFFER, le16(audioHandle), Buffer.alloc(2)]), 'audio request');
    await this.requestVideo();
    const r = await panelMedia;
    if (r?.opcode === Opcode.RELEASE || this.call.ended) {
      throw new Error(`the intercom ended our call${r && r.body.length >= 3 ? ` (cause ${r.body[2]})` : ''}`);
    }
    this.txHandle = this.call.panelAudioHandle;
    this.log?.debug(`call: the panel's media request ${this.txHandle !== undefined ? `(channel ${this.txHandle})` : 'did not come within 5 s'}`);
    await this.handler.send(this.call, Flag.DATA, Buffer.alloc(0), 'ready');
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
      this.noteSound(rtp.sequence);
      if (this.call.outbound && this.handler.liveViewSound === 'talk') {
        const now = Date.now();
        const entry: [number, number] = [now, alawLevel(rtp.payload)];
        this.recentLevels.push(entry);
        while (this.recentLevels.length && this.recentLevels[0][0] < now - SOUND_OFF_BEFORE_MS) {
          this.recentLevels.shift();
        }
        this.levelLog?.push(entry);
      }
      this.emit('audio', rtp.payload);
      this.handler.callAudio(this.call, rtp.payload);
      return;
    }
    this.stats.video++;
    if (this.firstVideoAt === 0) {
      this.firstVideoAt = Date.now();
    }
    if (this.awaitingKeyframe && !this.keyframeRetry) {
      // Joining a stream that is already running, the first keyframe can be seconds away;
      // until then nothing can be shown. Asking for video again may bring one sooner.
      // (Armed again when a call is swapped for one with sound.)
      this.keyframeRetry = setTimeout(() => {
        if (this.awaitingKeyframe && !this.ended) {
          this.log?.debug('call: no keyframe yet; asking for video again');
          void this.requestVideo().catch(() => undefined);
        }
      }, NO_KEYFRAME_RETRY_MS);
    }
    for (const unit of this.depacketizer.push(rtp)) {
      this.noteUnit(unit);
      this.emit('video', unit);
      this.handler.callVideo(this.call, unit);
    }
  }

  /** Counts sound packets that never came (gaps in the sequence numbers) and the longest pause. */
  private noteSound(seq: number): void {
    const s = this.sound;
    const now = Date.now();
    if (s.lastSeq >= 0) {
      const gap = (seq - s.lastSeq - 1) & 0xffff;
      if (gap > 0 && gap < 1000) {
        s.lost += gap; // (a late, out-of-order packet would show as a large gap and is not counted)
      }
      if (now - s.lastAt > s.pauseMs) {
        s.pauseMs = now - s.lastAt;
        s.pauseAt = s.lastAt;
      }
    }
    s.lastSeq = seq;
    s.lastAt = now;
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
    if (type === 7 && this.awaitingKeyframe) {
      this.awaitingKeyframe = false;
      clearTimeout(this.keyframeRetry);
      this.keyframeRetry = undefined;
    }
    if (type === 7 && this.firstSpsAt === 0) {
      this.firstSpsAt = now;
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
    if (this.ended || this.call.ended || this.videoHandle === undefined) {
      return;
    }
    const settings = this.hd ? videoSettings(HD_RESOLUTION, 1000) : videoSettings(SD_RESOLUTION, 0);
    await this.handler.send(this.call, Flag.DATA, Buffer.concat([VIDEO_OFFER, le16(this.videoHandle), settings]), 'video request');
  }

  /** Our own call opened the sound (sound in live view without a ring): close it at the end. */
  private voiceOpen = false;

  private async voiceStatus(status: 0 | 1): Promise<void> {
    const body = Buffer.concat([Buffer.from([0x00, OP_VOICESTATUS]), logicalAddress(this.call.caller || this.call.peer), Buffer.from([status, 0])]);
    await this.handler.send(this.call, Flag.DATA, body, `voice status ${status}`);
  }

  /** 'When you talk': when the Home app's microphone last sent sound (0: not since the sound closed). */
  private lastMicAt = 0;

  /** Sends 20 ms of G.711 A-law (160 bytes) to the intercom's speaker. */
  async sendAudio(alaw: Buffer): Promise<void> {
    const handle = this.txHandle ?? this.audioHandle;
    if (this.call.outbound && this.handler.liveViewSound === 'talk' && !this.ended) {
      this.lastMicAt = Date.now();
      if (!this.voiceOpen && !this.switching && this.soundClosedAt > 0) {
        void this.openSound().catch(() => undefined); // the microphone is on again: sound again
      }
    }
    if (this.ended || this.switching || handle === undefined) {
      return;
    }
    const packet = buildRtp({ marker: this.tx.first, payloadType: ALAW_PAYLOAD_TYPE, sequence: this.tx.seq, timestamp: this.tx.ts, ssrc: this.tx.ssrc }, alaw);
    this.tx.first = false;
    this.tx.seq = (this.tx.seq + 1) & 0xffff;
    this.tx.ts = (this.tx.ts + alaw.length) >>> 0;
    this.stats.sent++;
    await this.client.sendOnHandle(handle, packet);
  }

  /** While checking whether the panel closed the sound: when each of its sound packets came, and how loud. */
  private levelLog?: Array<[number, number]>;
  /** 'When you talk': the panel's sound over the last SOUND_OFF_BEFORE_MS (time, level). */
  private recentLevels: Array<[number, number]> = [];

  /** When the sound was last closed because the microphone went quiet (0: never). */
  private soundClosedAt = 0;

  /**
   * 'When you talk', experimental (2026-11-19): the Home app's microphone was turned off, so ask the
   * panel to close the sound (VOICESTATUS 0) and keep the video. A VOICESTATUS 1 later in a call is
   * ignored, but 0 may not be: the log says whether the panel's sound stopped. The next microphone
   * sound places the call again with sound (openSound).
   */
  private async closeSound(): Promise<void> {
    if (!this.call.outbound || this.handler.liveViewSound !== 'talk' || !this.voiceOpen || this.ended || this.switching || this.handler.soundOffIgnored) {
      return;
    }
    this.voiceOpen = false;
    this.soundClosedAt = Date.now();
    const call = this.call;
    this.log?.info('Doorbell camera: microphone off: asking the entrance panel to close the sound (experimental)');
    // The panel's sound just before, to compare with: the street's noise level through its microphone.
    const before = soundLevelOf(this.recentLevels, Date.now() - SOUND_OFF_BEFORE_MS, Date.now() + 1);
    this.levelLog = [];
    await this.voiceStatus(0);
    const sentAt = Date.now();
    const check = setTimeout(() => {
      const log = this.levelLog ?? [];
      this.levelLog = undefined;
      if (this.call !== call || call.ended || this.ended || this.voiceOpen) {
        return;
      }
      // Packets already on their way may still come in the first second: judge by what came after.
      const after = soundLevelOf(log, sentAt + SOUND_OFF_SETTLE_MS, sentAt + SOUND_OFF_CHECK_MS);
      const verdict = judgeSoundOff(before, after, (SOUND_OFF_CHECK_MS - SOUND_OFF_SETTLE_MS) / 1000);
      const detail = `before: ${describeLevel(before)}; after: ${describeLevel(after)}`;
      if (verdict === 'open') {
        // The panel ignored it: the sound is still open, so leave it on (no new call needed) and stop asking.
        this.handler.soundOffIgnored = true;
        this.voiceOpen = true;
        this.soundClosedAt = 0;
        this.log?.info(`Doorbell camera: the entrance panel kept the sound open (${detail}): the sound stays on until the view closes, and the plugin stops asking until it restarts`);
      } else if (verdict === 'closed') {
        this.log?.info(`Doorbell camera: the entrance panel closed the sound (${detail}); the next microphone sound calls it again with sound`);
      } else {
        // Too quiet at the door to tell: treat it as closed (at worst, the next microphone sound costs a new call).
        this.log?.info(`Doorbell camera: can't tell whether the entrance panel closed the sound: the street was too quiet (${detail}); treating it as closed`);
      }
    }, SOUND_OFF_CHECK_MS);
    this.once('end', () => {
      clearTimeout(check);
    });
  }

  /** While our own call is being placed again with the sound (see openSound). */
  private switching?: Promise<void>;

  /**
   * Sound in live view without a ring, 'when you talk': the view starts as a silent call. The
   * panel only opens the sound while a call is being set up (VOICESTATUS later in a call is
   * ignored, 2026-11-19), so when the Home app's microphone is turned on this hangs up the silent
   * call and places a new one, answered as a ring is (sound both ways), on the same channels.
   * The live view keeps this session throughout: the picture pauses for the ~5 s it takes (on an EX-7000HW: ~2 s of call setup, then ~3 s to the first keyframe).
   * Once per view; the sound then stays open until the view closes.
   */
  openSound(): Promise<void> {
    if (!this.call.outbound || this.handler.liveViewSound !== 'talk' || this.voiceOpen || this.ended) {
      return Promise.resolve();
    }
    if (!this.switching && this.handler.ringingCall()) {
      // Calling the panel while it rings the flat would be refused, or might cut the ring short.
      this.log?.info('Doorbell camera: microphone on, but someone is ringing: the view stays silent (close it and open it again to answer the ring)');
      return Promise.resolve();
    }
    this.switching ??= this.switchToSound().finally(() => {
      this.switching = undefined;
    });
    return this.switching;
  }

  private async switchToSound(): Promise<void> {
    const old = this.call;
    this.handler.soundSwitch = this;
    try {
      await this.placeAgainWithSound(old);
    } finally {
      if (this.handler.soundSwitch === this) {
        this.handler.soundSwitch = undefined;
      }
    }
  }

  private async placeAgainWithSound(old: Call): Promise<void> {
    this.log?.info('Doorbell camera: microphone on: calling the entrance panel again with sound (the picture pauses for a moment)');
    // The old call is no longer this view's: its hang-up must not end the view.
    old.media = undefined;
    this.txHandle = undefined; // talk-back waits for the new call
    if (!old.ended) {
      if (this.audioHandle !== undefined) {
        await this.handler.send(old, Flag.DATA, Buffer.concat([AUDIO_STOP, le16(this.audioHandle), Buffer.alloc(2)]), 'audio stop').catch(() => undefined);
      }
      await this.handler.hangUp(old);
    }
    let next: Call | undefined;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= SOUND_REDIAL_ATTEMPTS && !this.ended; attempt++) {
      await new Promise((r) => setTimeout(r, SOUND_REDIAL_PAUSE_MS));
      if (this.ended) {
        break;
      }
      try {
        next = await this.handler.placeOwnCall();
        break;
      } catch (e) {
        lastError = e as Error;
        this.log?.debug(`call: calling the panel again with sound, try ${attempt}: ${lastError.message}`);
      }
    }
    if (!next) {
      if (!this.ended) {
        this.log?.warn(`Doorbell camera: could not call the entrance panel again with sound (${lastError?.message ?? 'no answer'}); ending the live view`);
        await this.end('could not call the panel again with sound', false);
      }
      return;
    }
    if (this.ended) {
      await this.handler.hangUp(next); // the viewer left meanwhile
      return;
    }
    this.call = next;
    next.media = this;
    this.once('end', () => {
      if (next?.media === this) {
        next.media = undefined;
      }
    });
    // The new call gets the same "no media yet" time as a new view (not "media stopped").
    this.lastMedia = 0;
    this.watchStart = Date.now();
    this.depacketizer.reset();
    this.tx.first = true; // a new talk-back stream: marker bit on its first packet
    clearTimeout(this.keyframeRetry);
    this.keyframeRetry = undefined;
    this.awaitingKeyframe = true; // the new call's first keyframe: ask again if it's slow
    try {
      await this.startAnswered(this.audioHandle as number);
    } catch (e) {
      if (this.ended) {
        return; // the viewer closed during the setup (end() hung up the new call)
      }
      this.log?.warn(`Doorbell camera: the entrance panel's sound didn't start (${(e as Error).message}); ending the live view`);
      await this.end('the sound did not start'); // hangs up the new call unless the panel already did
    }
    if (this.lastMedia === 0) {
      this.watchStart = Date.now(); // the full "no media yet" time counts from the end of the setup
    }
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
    if (this.call.outbound && this.stats.video === 0 && (reason === 'no media from the intercom' || reason === 'the intercom ended the call')) {
      this.handler.noVideoFromOwnCall(reason);
    }
    if (this.stats.audio > 0) {
      const s = this.sound;
      this.log?.debug(
        `call: sound from the intercom: ${this.stats.audio} packets, ${s.lost} never arrived (${(s.lost * 0.02).toFixed(1)} s), ` +
          `longest pause ${(s.pauseMs / 1000).toFixed(1)} s at ${((s.pauseAt - this.startedAt) / 1000).toFixed(1)} s`,
      );
    }
    if (!this.call.ended) {
      if (!this.call.outbound || this.voiceOpen) {
        await this.voiceStatus(0).catch(() => undefined);
      }
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

/**
 * Experimental ring preview: asks the intercom for video during the ring, without answering,
 * so the notification can show who is at the door. Logs what the intercom does, as nobody
 * knows yet whether it sends video to the app before an answer (its own monitor gets it).
 * Stops after the first keyframe, after PREVIEW_MAX_MS, or when the call is answered or ends;
 * never hangs up.
 */
export class RingPreview {
  done = false;
  private udpHandle?: number;
  private videoHandle?: number;
  /** While recording: the channel for the intercom's sound during the ring (if it sends it). */
  private audioHandle?: number;
  private audioPackets = 0;
  private listening = false;
  private audioRequested = false;
  private readonly handles = new Set<number>();
  private readonly depacketizer = new H264Depacketizer();
  private startedAt = 0;
  private firstVideoAt = 0;
  private keyframeAt = 0;
  private keyframeBytes = 0;
  private runBytes = 0;
  private lastType = -1;
  private readonly emptyKeyframes: number[] = [];
  private size?: string;
  private packets = 0;
  private timer?: NodeJS.Timeout;
  /** While recording: when the preview stops at the latest. */
  private recordingUntil = 0;
  private stopping?: Promise<void>;
  private readonly drop = (): void => undefined;

  constructor(
    private readonly handler: CallHandler,
    private readonly client: IconaBridgeClient,
    private readonly call: Call,
    private readonly options: RingPreviewOptions,
    private readonly log?: Logging,
  ) {}

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => void this.stop(`no keyframe within ${PREVIEW_MAX_MS / 1000} s`), PREVIEW_MAX_MS);
    try {
      this.udpHandle = (await this.client.openChannel('UDPM', ChannelType.UAUT)).serverChannelId;
      if (this.done) {
        return void (await this.close());
      }
      // Recording: a channel for the intercom's sound too, opened before the video's, as for a
      // call (the intercom sends video on the handle after the video one).
      this.listening = this.options.keepRunning?.() === true;
      if (this.listening) {
        this.audioHandle = (await this.client.openChannel('RTPC-audio', ChannelType.UAUT, undefined, 0, 'RTPC')).serverChannelId;
        this.handles.add(this.audioHandle);
        this.client.setBinaryHandler(this.audioHandle, (body) => this.onMedia(body));
      }
      this.videoHandle = (await this.client.openChannel('RTPC-video', ChannelType.UAUT, undefined, 0, 'RTPC')).serverChannelId;
      if (this.done) {
        return void (await this.close());
      }
      // The intercom sends video on the handle after the one offered.
      for (const h of [this.videoHandle, (this.videoHandle + 1) & 0xffff]) {
        this.handles.add(h);
        this.client.setBinaryHandler(h, (body) => this.onMedia(body));
      }
      const settings = this.options.hd ? videoSettings(HD_RESOLUTION, 1000) : videoSettings(SD_RESOLUTION, 0);
      const reply = this.handler.wait(this.call, Opcode.MEDIA_REQUEST, 2000);
      await this.handler.send(this.call, Flag.DATA, Buffer.concat([VIDEO_OFFER, le16(this.videoHandle), settings]), 'ring preview video request');
      const r = await reply;
      this.log?.debug(`call: ring preview: reply to the video request ${r ? `op=0x${r.opcode.toString(16)} body=${hex(r.body)}` : 'none within 2 s'}`);
      if (this.audioHandle !== undefined && !this.done) {
        // Asks for the sound without answering (no voice status). Whether the intercom sends it
        // during the ring is what this finds out; the summary line says.
        const audioReply = this.handler.wait(this.call, Opcode.MEDIA_REQUEST, 2000);
        this.audioRequested = true;
        await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_OFFER, le16(this.audioHandle), Buffer.alloc(2)]), 'ring preview audio request');
        const a = await audioReply;
        this.log?.debug(`call: ring preview: reply to the audio request ${a ? `op=0x${a.opcode.toString(16)} body=${hex(a.body)}` : 'none within 2 s'}`);
      }
    } catch (e) {
      await this.stop(`setup failed: ${(e as Error).message}`);
    }
  }

  private onMedia(body: Buffer): void {
    const rtp = parseRtp(body);
    if (!rtp || this.done) {
      return;
    }
    if (rtp.payloadType === ALAW_PAYLOAD_TYPE) {
      if (this.audioPackets++ === 0) {
        this.log?.debug(`call: ring preview: the intercom sends sound before answering (${((Date.now() - this.startedAt) / 1000).toFixed(1)} s after the ring)`);
      }
      this.handler.callAudio(this.call, rtp.payload);
      return;
    }
    this.packets++;
    if (this.firstVideoAt === 0) {
      this.firstVideoAt = Date.now();
    }
    for (const unit of this.depacketizer.push(rtp)) {
      const type = nalType(unit);
      if (type === 7 && !this.size) {
        const sps = parseSps(unit);
        this.size = sps ? `${sps.width}x${sps.height}` : 'size unknown';
      }
      this.options.onVideo(this.call, unit);
      this.handler.callVideo(this.call, unit, 'ring preview');
      if (this.recordingUntil) {
        // Recording: stop once the intercom stops sending video, or at the time limit.
        clearTimeout(this.timer);
        const left = Math.min(PREVIEW_RECORDING_SILENCE_MS, this.recordingUntil - Date.now());
        this.timer = setTimeout(() => void this.stop(left < PREVIEW_RECORDING_SILENCE_MS ? 'recording time limit' : 'the video stopped'), Math.max(0, left));
      }
      if (type === 5) {
        // Slices of one keyframe come back to back; its size tells a real picture from an empty one.
        this.runBytes = this.lastType === 5 ? this.runBytes + unit.length : unit.length;
      } else if (this.lastType === 5 && this.keyframeAt === 0) {
        if (this.runBytes >= MIN_PICTURE_BYTES) {
          this.keyframeAt = Date.now();
          this.keyframeBytes = this.runBytes;
          clearTimeout(this.timer);
          if (this.options.keepRunning?.()) {
            // Recording: keep the video coming until the call is answered or ends, the video
            // stops, or the time limit.
            this.recordingUntil = Date.now() + RECORDING_MAX_MS;
            this.timer = setTimeout(() => void this.stop('the video stopped'), PREVIEW_RECORDING_SILENCE_MS);
          } else {
            // A little more, so the frames after the keyframe arrive too.
            this.timer = setTimeout(() => void this.stop('got a picture'), PREVIEW_AFTER_KEYFRAME_MS);
          }
        } else {
          // The camera wasn't ready: an empty (black) keyframe. Wait for the next one.
          this.emptyKeyframes.push(this.runBytes);
          this.options.onEmptyKeyframe?.(this.call);
        }
      }
      this.lastType = type;
    }
  }

  /** Stops the preview and closes its channels (never hangs up). Logs the result once. */
  stop(reason: string): Promise<void> {
    this.stopping ??= (async () => {
      this.done = true;
      clearTimeout(this.timer);
      const t = (at: number) => (at ? `${((at - this.startedAt) / 1000).toFixed(1)} s` : 'never');
      const result = this.keyframeAt
        ? 'video before answering works'
        : this.emptyKeyframes.length
          ? "video came, but the camera's picture was empty (black)"
          : this.packets
            ? 'video came, but no keyframe'
            : 'no video before answering';
      const empty = this.emptyKeyframes.length ? `, empty keyframes before it: ${this.emptyKeyframes.map((b) => `${b} bytes`).join(', ')}` : '';
      // Normal level only when the intercom gave no picture (not when the call was answered or ended first).
      const failed = !this.keyframeAt && /^(no keyframe|setup failed)/.test(reason);
      (failed ? this.log?.info : this.log?.debug)?.call(
        this.log,
        `Ring preview: ${result}; first video ${t(this.firstVideoAt)}, first picture ${t(this.keyframeAt)}` +
          `${this.keyframeBytes ? ` (${this.keyframeBytes} bytes)` : ''}${empty}, ` +
          `${this.size ?? 'size unknown'}, ${this.packets} packets` +
          `${this.listening ? `, sound before answering: ${this.audioPackets ? `${this.audioPackets} packets` : 'none'}` : ''}; stopped: ${reason}`,
      );
      this.options.onDone?.(this.call);
      await this.close();
    })();
    return this.stopping;
  }

  private async close(): Promise<void> {
    for (const h of this.handles) {
      this.client.setBinaryHandler(h, this.drop);
    }
    if (this.audioRequested && this.audioHandle !== undefined && !this.call.ended) {
      // As at the end of a call: stop the sound the preview asked for, so the call's own
      // sound request is the only one.
      await this.handler.send(this.call, Flag.DATA, Buffer.concat([AUDIO_STOP, le16(this.audioHandle), Buffer.alloc(2)]), 'ring preview audio stop').catch(() => undefined);
    }
    const open = [['RTPC-audio', this.audioHandle], ['RTPC-video', this.videoHandle], ['UDPM', this.udpHandle]] as const;
    this.audioHandle = this.videoHandle = this.udpHandle = undefined; // closed once, even if stop and start both close
    for (const [name, h] of open) {
      if (h !== undefined) {
        await this.client.closeHandle(name, h).catch(() => undefined);
      }
    }
    const handles = [...this.handles];
    const release = setTimeout(() => {
      for (const h of handles) {
        if (this.client.binaryHandlerFor(h) === this.drop) {
          this.client.setBinaryHandler(h);
        }
      }
    }, LATE_PACKETS_MS);
    release.unref?.();
  }
}
