import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { CameraRecordingConfiguration, CameraRecordingDelegate, Logging, RecordingPacket } from 'homebridge';
import { RESTORE_ASPECT } from './camera';
import { LEFTOVER_GAP_MS, MIN_PICTURE_BYTES, nalType } from './media';
import { RECORDING_MAX_MS } from './settings';

/**
 * HomeKit Secure Video for the doorbell camera (setting `recording`).
 *
 * The intercom only sends video during a ring or a call, so a recording is one ring: it starts
 * at the ring's first real picture (about 3 s after the button; an empty, black first keyframe
 * is skipped) and ends when the call ends, answered or not. The camera's own motion sensor is
 * "motion detected" for that time, which is what makes the home hub record. (Hubs also ask for
 * a recording at the doorbell press itself; that request waits for the first picture.)
 *
 * When the hub asks for the recording, ffmpeg re-encodes the intercom's video to fragmented
 * MP4, with a keyframe at every fragment boundary (the intercom's own come every 2.7-7 s), and
 * the fragments are passed on as they come. With sound on in the Home app, the intercom's sound
 * goes in too: during the call, and during the ring if the intercom sends it then; the gaps are
 * filled with silence.
 *
 * Timing: video and sound go to ffmpeg together as one FLV stream, each frame and each piece of
 * sound stamped with when it arrived from the intercom (so a request that comes late gets the
 * ring with its real timing, at once). The sound is continuous: gaps (before the call is
 * answered, or between the ring and the call) are filled with silence, so picture and sound
 * stay together.
 */

/** How long a recording request waits for a ring's first picture. */
const SOURCE_WAIT_MS = 10_000;
/** How many video units a ring keeps (3 min at up to 33 a second; the intercom sends 8-17). */
const MAX_BUFFERED_UNITS = 6_000;
/** No video for this long ends the ring's recording (the intercom stopped sending). */
export const SOURCE_SILENCE_MS = 5_000;
/** An ended ring can still be fetched by a hub request this long after it ends. */
const LATE_REQUEST_MS = 15_000;
/** Motion stays on at least this long, so a short ring isn't missed by the hub. */
const MIN_MOTION_MS = 5_000;

/** How many sound packets a ring keeps (20 ms each: about 3 min). */
const MAX_BUFFERED_AUDIO = 10_000;
/** A-law: 8000 samples a second, one byte each. */
const ALAW_BYTES_PER_MS = 8;
/** A-law's silence. */
const ALAW_SILENCE = 0xd5;
/** How far the sound may fall behind before silence fills in (late packets still fit). */
const AUDIO_SLACK_MS = 200;
/** A gap in the sound longer than this is filled with silence before the next packet. */
const AUDIO_GAP_MS = 60;
/** Sound arriving more than this late (its place already filled with silence) is dropped. */
const AUDIO_LATE_MS = 100;
/** The sound never runs further ahead of the latest frame than this (it waits for the picture). */
const AUDIO_AHEAD_MS = 250;
/**
 * HomeKit's prebuffer (CameraRecordingOptions.prebufferLength): the hub takes the first this-many
 * ms of a recording as what happened before the event, and dates the clip from the end of it.
 * The intercom has no video before the ring, so a clip starts with its first picture held still
 * for this long; the Home app then shows the time of the first live picture (it showed times
 * 3.4-4.5 s late without, 2026-11-11).
 */
export const PREBUFFER_MS = 4000;

/** How often the recording writes what has come in to ffmpeg. */
const FEED_TICK_MS = 20;
/** The most sound in one FLV tag (100 ms). */
const MAX_AUDIO_TAG = 800;

/** Something received at a moment (ms since 1970). */
interface Timed {
  data: Buffer;
  at: number;
}

/** One ring's video and sound, from its first real picture until the call ends or the video stops. */
export class RingSource {
  readonly units: Timed[] = [];
  readonly audio: Timed[] = [];
  ended = false;
  endedAt = 0;
  /** How many recording requests this ring has had. */
  requests = 0;
  /** Where each keyframe group (SPS) starts in `units`. */
  private readonly keyStarts: number[] = [];
  private readonly capTimer: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;
  /**
   * Where the recording starts in `units`: 0, or the intercom's second keyframe when it came
   * right after the first, which is then its old picture (see LEFTOVER_GAP_MS).
   */
  start = 0;
  /** Settles once `start` is known: at the second keyframe, LEFTOVER_GAP_MS after the first, or the end. */
  readonly ready: Promise<void>;
  private settle: () => void = () => undefined;
  private settled = false;
  private gapTimer?: NodeJS.Timeout;
  /** Following the keyframes as units arrive. */
  private lastType = -1;
  private paramsAt = -1;
  private runStart = 0;
  private runBytes = 0;
  private realKeyframes = 0;
  private firstDoneAt = 0;
  /** For the log: the old picture skipped, and how long before the fresh one. */
  skipped?: { bytes: number; gapMs: number };

  constructor(
    readonly call: object,
    first: Buffer[],
    private readonly onEnd: (s: RingSource) => void = () => undefined,
    /** See LEFTOVER_GAP_MS; 0 starts at the first keyframe at once (tests). */
    private readonly gapMs = LEFTOVER_GAP_MS,
  ) {
    this.ready = new Promise((resolve) => {
      this.settle = () => {
        if (!this.settled) {
          this.settled = true;
          clearTimeout(this.gapTimer);
          resolve();
        }
      };
    });
    const now = Date.now();
    for (const u of first) {
      this.keep(u, now);
    }
    this.capTimer = setTimeout(() => this.end(), RECORDING_MAX_MS);
    this.capTimer.unref?.();
    this.armSilence();
  }

  private keep(unit: Buffer, at: number): void {
    if (this.units.length >= MAX_BUFFERED_UNITS) {
      return;
    }
    const type = nalType(unit);
    const index = this.units.length;
    if (type === 7) {
      this.keyStarts.push(index);
    }
    this.watchKeyframes(type, index, unit.length, at);
    this.units.push({ data: unit, at });
  }

  /** Finds the intercom's second keyframe, if it comes right after the first (its old picture). */
  private watchKeyframes(type: number, index: number, bytes: number, at: number): void {
    if (type !== 5 && this.lastType === 5) {
      this.keyframeDone(at);
    }
    if (type === 7 || type === 8) {
      if (this.lastType !== 7 && this.lastType !== 8) {
        this.paramsAt = index;
      }
    } else if (type === 5) {
      if (this.lastType !== 5) {
        this.runStart = this.lastType === 7 || this.lastType === 8 ? this.paramsAt : index;
        this.runBytes = 0;
      }
      this.runBytes += bytes;
    }
    this.lastType = type;
  }

  /** A keyframe is complete (something else follows it). */
  private keyframeDone(at: number): void {
    if (!this.settled && this.runBytes >= MIN_PICTURE_BYTES) {
      this.realKeyframes++;
      if (this.realKeyframes === 1 && this.gapMs <= 0) {
        this.settle();
      } else if (this.realKeyframes === 1) {
        this.firstDoneAt = at;
        this.gapTimer = setTimeout(() => this.settle(), this.gapMs);
        this.gapTimer.unref?.();
      } else if (at - this.firstDoneAt <= this.gapMs) {
        this.skipped = { bytes: this.units.slice(0, this.runStart).reduce((n, u) => n + (nalType(u.data) === 5 ? u.data.length : 0), 0), gapMs: at - this.firstDoneAt };
        this.start = this.runStart;
        this.settle();
      } else {
        this.settle();
      }
    }
  }

  private armSilence(): void {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.end(), SOURCE_SILENCE_MS);
    this.silenceTimer.unref?.();
  }

  push(unit: Buffer): void {
    if (this.ended) {
      return;
    }
    this.keep(unit, Date.now());
    this.armSilence();
  }

  /** The intercom's sound (A-law, 8 kHz). */
  pushAudio(data: Buffer): void {
    if (!this.ended && this.audio.length < MAX_BUFFERED_AUDIO) {
      this.audio.push({ data, at: Date.now() });
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endedAt = Date.now();
    this.settle();
    clearTimeout(this.capTimer);
    clearTimeout(this.silenceTimer);
    this.onEnd(this);
  }

  /** Where the latest keyframe group starts, for a second request that shouldn't replay the ring. */
  get latestKeyframe(): number {
    return this.keyStarts.at(-1) ?? 0;
  }
}

/** A time of day for the log, with tenths (16:19:53.4). */
function time(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${Math.floor(d.getMilliseconds() / 100)}`;
}

/** Builds an FLV stream: H.264 video and A-law sound, with our timestamps (ms). */
export class FlvWriter {
  constructor(private readonly write: (b: Buffer) => void, withAudio: boolean) {
    const header = Buffer.from([0x46, 0x4c, 0x56, 1, withAudio ? 0x05 : 0x01, 0, 0, 0, 9, 0, 0, 0, 0]);
    this.write(header);
  }

  private tag(type: 8 | 9, ms: number, data: Buffer): void {
    const t = Math.max(0, Math.round(ms));
    const h = Buffer.alloc(11);
    h[0] = type;
    h.writeUIntBE(data.length, 1, 3);
    h.writeUIntBE(t & 0xffffff, 4, 3);
    h[7] = (t >>> 24) & 0xff;
    const size = Buffer.alloc(4);
    size.writeUInt32BE(11 + data.length);
    this.write(Buffer.concat([h, data, size]));
  }

  /** The SPS and PPS (without start codes), as the decoder configuration. */
  config(sps: Buffer, pps: Buffer, ms: number): void {
    const rec = Buffer.concat([
      Buffer.from([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
      u16(sps.length), sps,
      Buffer.from([1]), u16(pps.length), pps,
    ]);
    this.tag(9, ms, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), rec]));
  }

  /** One frame: its NAL units without start codes. */
  frame(nals: Buffer[], key: boolean, ms: number): void {
    const body = nals.flatMap((n) => [u32(n.length), n]);
    this.tag(9, ms, Buffer.concat([Buffer.from([key ? 0x17 : 0x27, 1, 0, 0, 0]), ...body]));
  }

  /** A-law, 8 kHz, mono. */
  audio(alaw: Buffer, ms: number): void {
    this.tag(8, ms, Buffer.concat([Buffer.from([0x70]), alaw]));
  }
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

/** A NAL unit without its start code. */
function payload(unit: Buffer): Buffer {
  if (unit[0] === 0 && unit[1] === 0) {
    return unit.subarray(unit[2] === 1 ? 3 : 4);
  }
  return unit;
}

/**
 * Writes a ring to ffmpeg as FLV: the video from unit `from` (the time of that unit is 0), each
 * frame stamped with its arrival, and with `withAudio` the sound from the same moment, as one
 * continuous track with its gaps filled with silence. What is buffered goes at once; then what
 * comes, as it comes.
 */
export class RingFeeder {
  private readonly flv: FlvWriter;
  private readonly base: number;
  private nextUnit: number;
  private nextAudio = 0;
  /** Sound written so far, in A-law bytes (= samples; 8 per ms). */
  private audioWritten = 0;
  private sps?: Buffer;
  private pps?: Buffer;
  private configSent = false;
  /** The frame being put together: its NAL units, whether it's a keyframe, and its time. */
  private pending: { nals: Buffer[]; key: boolean; ms: number } | undefined;
  private lastVideoMs = 0;
  private timer?: NodeJS.Timeout;
  private done = false;
  /** For the log: the intercom's sound written, dropped as late, and silence put between its pieces. */
  readonly soundStats = { packets: 0, late: 0, gapBytes: 0 };

  /** How long the recording is: the last frame's time (s). */
  get seconds(): number {
    return this.lastVideoMs / 1000;
  }

  constructor(
    private readonly source: RingSource,
    from: number,
    write: (b: Buffer) => void,
    private readonly withAudio: boolean,
    private readonly end: () => void,
  ) {
    this.flv = new FlvWriter(write, withAudio);
    if (withAudio) {
      // Sound first: ffmpeg looks for the streams in its first 32 KB, which one keyframe can fill.
      this.silence(160);
    }
    this.nextUnit = from;
    // Starting at a keyframe without its own SPS/PPS: use the latest ones before it.
    for (let i = from - 1; i >= 0 && (!this.sps || !this.pps); i--) {
      const nal = payload(source.units[i].data);
      const t = nal[0] & 0x1f;
      if (t === 7 && !this.sps) {
        this.sps = nal;
      } else if (t === 8 && !this.pps) {
        this.pps = nal;
      }
    }
    const start = source.units[from]?.at ?? Date.now();
    // The clip's time 0 is PREBUFFER_MS before the first picture: see PREBUFFER_MS.
    this.base = start - PREBUFFER_MS;
    while (this.nextAudio < source.audio.length && source.audio[this.nextAudio].at < start) {
      this.nextAudio++;
    }
    this.tick();
    if (!this.done) {
      this.timer = setInterval(() => this.tick(), FEED_TICK_MS);
      this.timer.unref?.();
    }
  }

  /** Stops writing (ffmpeg is gone). */
  stop(): void {
    this.done = true;
    clearInterval(this.timer);
  }

  private flushFrame(): void {
    const f = this.pending;
    this.pending = undefined;
    if (!f || !f.nals.length) {
      return;
    }
    if (!this.configSent) {
      if (!f.key || !this.sps || !this.pps) {
        return; // nothing decodable before the first keyframe with its SPS/PPS
      }
      this.flv.config(this.sps, this.pps, 0);
      this.configSent = true;
      // The prebuffer: the first picture, held from time 0 until it is live.
      this.flv.frame(f.nals, true, 0);
    }
    this.flv.frame(f.nals, f.key, f.ms);
    this.lastVideoMs = f.ms;
  }

  private video(unit: Buffer, at: number): void {
    const nal = payload(unit);
    const type = nal[0] & 0x1f;
    const ms = at - this.base;
    if (type === 7 || type === 8) {
      this.flushFrame();
      const changed = type === 7 ? !this.sps?.equals(nal) : !this.pps?.equals(nal);
      if (type === 7) {
        this.sps = nal;
      } else {
        this.pps = nal;
      }
      if (changed && this.configSent && this.sps && this.pps) {
        this.flv.config(this.sps, this.pps, ms);
      }
      return;
    }
    if (type !== 1 && type !== 5) {
      return; // SEI and others: not needed
    }
    // A slice with first_mb_in_slice 0 starts a new frame (the intercom may split a keyframe).
    const firstSlice = (nal[1] & 0x80) !== 0;
    if (firstSlice || !this.pending) {
      this.flushFrame();
      this.pending = { nals: [], key: type === 5, ms };
    }
    this.pending.nals.push(nal);
  }

  private silence(bytes: number): void {
    for (let left = Math.round(bytes); left > 0; left -= MAX_AUDIO_TAG) {
      const n = Math.min(left, MAX_AUDIO_TAG);
      this.flv.audio(Buffer.alloc(n, ALAW_SILENCE), this.audioWritten / ALAW_BYTES_PER_MS);
      this.audioWritten += n;
    }
  }

  /** Writes one piece of the intercom's sound at its place in time. */
  private sound(a: Timed): void {
    const pos = Math.round((a.at - this.base) * ALAW_BYTES_PER_MS);
    if (pos > this.audioWritten + AUDIO_GAP_MS * ALAW_BYTES_PER_MS) {
      if (this.soundStats.packets > 0) {
        this.soundStats.gapBytes += pos - this.audioWritten;
      }
      this.silence(pos - this.audioWritten);
    } else if (this.audioWritten > pos + AUDIO_LATE_MS * ALAW_BYTES_PER_MS) {
      // Late (a Wi-Fi stall): its place is already silence; appending it would put all the
      // sound after it behind the picture.
      this.soundStats.late++;
      return;
    }
    this.flv.audio(a.data, this.audioWritten / ALAW_BYTES_PER_MS);
    this.audioWritten += a.data.length;
    this.soundStats.packets++;
  }

  private tick(): void {
    if (this.done) {
      return;
    }
    const { units, audio, ended } = this.source;
    // After the end, nothing past the last frame: the sound stops with the picture.
    const lastAt = units.at(-1)?.at ?? this.base;
    // Video and sound in the order they came, so ffmpeg gets both from the start.
    for (;;) {
      const u = units[this.nextUnit];
      const a = this.withAudio ? audio[this.nextAudio] : undefined;
      if (u && (!a || u.at <= a.at)) {
        this.nextUnit++;
        this.video(u.data, u.at);
      } else if (a) {
        if (!ended && a.at > lastAt + AUDIO_AHEAD_MS) {
          break; // wait for the picture (if it doesn't come, the ring ends and this is dropped)
        }
        this.nextAudio++;
        if (!ended || a.at <= lastAt) {
          this.sound(a);
        }
      } else {
        break;
      }
    }
    if (this.withAudio) {
      // No sound now (the ring before answering, or between the ring and the call): silence, a
      // little behind, so a packet arriving a little late still fits.
      const until = ended ? lastAt : Math.min(Date.now() - AUDIO_SLACK_MS, lastAt + AUDIO_AHEAD_MS);
      this.silence(Math.round((until - this.base) * ALAW_BYTES_PER_MS) - this.audioWritten);
    }
    if (ended) {
      this.flushFrame();
      this.stop();
      this.end();
    }
  }
}

/**
 * Splits ffmpeg's fragmented MP4 into what HomeKit wants: the initialization (ftyp + moov), then
 * one packet per fragment (moof + mdat, with any boxes between them).
 */
export class Mp4Splitter {
  private buffer = Buffer.alloc(0);
  private init: Buffer[] = [];
  private initDone = false;
  private fragment: Buffer[] = [];

  /** Returns the complete packets found so far. */
  push(data: Buffer): { type: 'init' | 'fragment'; data: Buffer }[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const out: { type: 'init' | 'fragment'; data: Buffer }[] = [];
    for (;;) {
      if (this.buffer.length < 8) {
        break;
      }
      let size = this.buffer.readUInt32BE(0);
      let header = 8;
      if (size === 1) {
        if (this.buffer.length < 16) {
          break;
        }
        size = Number(this.buffer.readBigUInt64BE(8));
        header = 16;
      }
      if (size < header) {
        throw new Error(`invalid MP4 box size ${size}`);
      }
      if (this.buffer.length < size) {
        break;
      }
      const type = this.buffer.toString('latin1', 4, 8);
      const box = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      if (!this.initDone) {
        this.init.push(box);
        if (type === 'moov') {
          this.initDone = true;
          out.push({ type: 'init', data: Buffer.concat(this.init) });
          this.init = [];
        }
        continue;
      }
      this.fragment.push(box);
      if (type === 'mdat') {
        out.push({ type: 'fragment', data: Buffer.concat(this.fragment) });
        this.fragment = [];
      }
    }
    return out;
  }
}

const PROFILES = ['baseline', 'main', 'high'];
const LEVELS = ['3.1', '3.2', '4.0'];
const SAMPLE_RATES = [8000, 16000, 24000, 32000, 44100, 48000];

/** ffmpeg arguments for one recording, as HomeKit configured it. Its input is RingFeeder's FLV on stdin. */
export function recordingArgs(c: CameraRecordingConfiguration, withAudio: boolean, gainDb = 0): string[] {
  const [width, height, fps] = c.videoCodec.resolution;
  // A keyframe a little before each fragment length: a keyframe exactly at the length can land
  // one frame after it (4.06 s for 4 s at 15 fps), which would make the fragment too long.
  const keyEveryS = Math.max(1, c.mediaContainerConfiguration.fragmentLength / 1000 - 0.25);
  const kbps = c.videoCodec.parameters.bitRate;
  const rate = SAMPLE_RATES[c.audioCodec.samplerate] ?? 16000;
  const eld = c.audioCodec.type === 1; // AudioRecordingCodecType.AAC_ELD
  return [
    '-hide_banner', '-loglevel', 'error',
    '-probesize', '32768', '-analyzeduration', '0', '-f', 'flv', '-i', 'pipe:0',
    '-map', '0:v', ...(withAudio ? ['-map', '0:a'] : []),
    '-sn', '-dn',
    '-vf',
    `setpts=PTS-STARTPTS,${RESTORE_ASPECT},scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-color_range', 'mpeg',
    '-profile:v', PROFILES[c.videoCodec.parameters.profile] ?? 'main',
    '-level:v', LEVELS[c.videoCodec.parameters.level] ?? '3.1',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    // Each fragment must start with a keyframe and be no longer than HomeKit's fragment length.
    '-force_key_frames', `expr:gte(t,n_forced*${keyEveryS})`, '-g', String(Math.round(fps * (keyEveryS + 0.25))), '-sc_threshold', '0',
    ...(withAudio
      ? [
        '-af', `${gainDb ? `volume=${gainDb}dB,alimiter=limit=0.9,` : ''}aresample=${rate}`,
        '-c:a', 'libfdk_aac', '-profile:a', eld ? 'aac_eld' : 'aac_low', '-ar', String(rate), '-ac', '1', '-b:a', `${c.audioCodec.bitrate || 32}k`,
      ]
      : ['-an']),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
}

type Spawn = (what: string, args: string[]) => ChildProcessWithoutNullStreams;

export class RingRecorder implements CameraRecordingDelegate {
  /** See LEFTOVER_GAP_MS; 0 starts recordings at the first keyframe at once (tests). */
  leftoverGapMs = LEFTOVER_GAP_MS;

  private active = false;
  private configuration?: CameraRecordingConfiguration;
  /** Per call: the last SPS/PPS and the keyframe being received, until the first real picture. */
  private readonly waiting = new Map<object, { params: Buffer[]; idr: Buffer[]; idrBytes: number; lastType: number; sawEmpty: boolean }>();
  /** The ring being recorded. */
  private source?: RingSource;
  /** The last ring, after it ended: a hub request that comes late still gets it. */
  private lastSource?: RingSource;
  private readonly sourceWaiters = new Set<(s: RingSource) => void>();
  private readonly streams = new Map<number, { stop: () => void }>();
  /** Streams whose last fragment was sent. */
  private readonly ended = new Set<number>();
  private motionOnAt = 0;
  private motionTimer?: NodeJS.Timeout;

  constructor(
    private readonly log: Logging,
    /** Turns the camera's motion sensor on or off (starts and ends the hub's recording). */
    private readonly setMotion: (on: boolean) => void,
    /** Whether HomeKit records sound for this camera. */
    private readonly audioActive: () => boolean,
    private readonly spawnProcess: Spawn,
    /** The error that tells the hub there is nothing to record (hap's HDSProtocolError). */
    private readonly nothingToRecord: () => Error = () => new Error('no ring to record'),
    /** The door's sound turned up by this much (setting doorVolume), as in the live view. */
    private readonly gainDb = 0,
  ) {}

  /** The camera was added to its accessory: clear a "motion" restored from before a restart. */
  attached(): void {
    if (!this.source) {
      this.setMotion(false);
    }
  }

  /** Recording is on in the Home app, with a configuration chosen: rings are recorded. */
  get recording(): boolean {
    return this.active && this.configuration !== undefined;
  }

  updateRecordingActive(active: boolean): void {
    this.active = active;
    this.log.info(`Doorbell camera: HomeKit Secure Video recording ${active ? 'on' : 'off'}`);
    if (!active) {
      this.endSource();
    }
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
    if (configuration) {
      const [w, h, fps] = configuration.videoCodec.resolution;
      this.log.debug(
        `Doorbell camera: recording as ${w}x${h} ${fps} fps ${configuration.videoCodec.parameters.bitRate} kbps, ` +
          `fragments of ${configuration.mediaContainerConfiguration.fragmentLength} ms`,
      );
    }
  }

  /** A call's video, from the ring preview or a live view. */
  onCallVideo(call: object, unit: Buffer): void {
    if (this.source?.call === call) {
      this.source.push(unit);
      return;
    }
    if (!this.recording || this.source) {
      return;
    }
    // Wait for the call's first real picture: SPS, PPS and a keyframe of a real size.
    let w = this.waiting.get(call);
    if (!w) {
      w = { params: [], idr: [], idrBytes: 0, lastType: -1, sawEmpty: false };
      this.waiting.set(call, w);
    }
    const type = nalType(unit);
    if (type !== 5 && w.lastType === 5 && w.idrBytes < MIN_PICTURE_BYTES) {
      w.sawEmpty = true;
    }
    if (type !== 5 && w.lastType === 5 && w.idrBytes >= MIN_PICTURE_BYTES && w.params.length > 0) {
      // The keyframe is complete and is a real picture: the recording starts with it.
      this.waiting.delete(call);
      // Only the call's very first keyframe can be the intercom's old picture: after an empty
      // (black) one, the recording starts at the first real one at once.
      const source = new RingSource(call, [...w.params, ...w.idr], (ended) => this.sourceEnded(ended), w.sawEmpty ? 0 : this.leftoverGapMs);
      this.startSource(source);
      source.push(unit);
      return;
    }
    if (type === 7 || type === 8) {
      w.params = type === 7 ? [unit] : [...w.params.filter((u) => nalType(u) === 7), unit];
    } else if (type === 5) {
      if (w.lastType !== 5) {
        w.idr = [];
        w.idrBytes = 0;
      }
      w.idr.push(unit);
      w.idrBytes += unit.length;
    }
    w.lastType = type;
  }

  /** A call's sound (A-law), from the ring preview or a live view. */
  onCallAudio(call: object, data: Buffer): void {
    if (this.source?.call === call) {
      this.source.pushAudio(data);
    }
  }

  /** The call is over (the intercom ended it, or it was hung up): so is its recording. */
  onCallEnded(call: object): void {
    this.waiting.delete(call);
    if (this.source?.call === call) {
      this.endSource();
    }
  }

  /** The connection to the intercom is gone: end any recording. */
  reset(): void {
    this.waiting.clear();
    this.endSource();
  }

  private startSource(source: RingSource): void {
    this.source = source;
    this.log.info('Doorbell camera: recording the ring (HomeKit Secure Video)');
    clearTimeout(this.motionTimer);
    this.motionOnAt = Date.now();
    this.setMotion(true);
    for (const w of [...this.sourceWaiters]) {
      w(source);
    }
    this.sourceWaiters.clear();
  }

  /** Ends the ring being recorded (its call ended, recording was turned off, or the connection is gone). */
  private endSource(): void {
    this.source?.end(); // calls sourceEnded
  }

  /** A ring's recording is over: its call ended, its video stopped, or it hit the time limit. */
  private sourceEnded(s: RingSource): void {
    if (this.source !== s) {
      return;
    }
    this.source = undefined;
    this.lastSource = s;
    clearTimeout(this.motionTimer);
    const left = this.motionOnAt + MIN_MOTION_MS - Date.now();
    if (left > 0) {
      this.motionTimer = setTimeout(() => this.setMotion(false), left);
      this.motionTimer.unref?.();
    } else {
      this.setMotion(false);
    }
  }

  /** The ring a new request should get: the current one, or one that ended moments ago and wasn't fetched. */
  private sourceForRequest(): RingSource | undefined {
    if (this.source) {
      return this.source;
    }
    const last = this.lastSource;
    if (last && last.requests === 0 && Date.now() - last.endedAt < LATE_REQUEST_MS) {
      return last;
    }
    return undefined;
  }

  private waitForSource(signal?: AbortSignal): Promise<RingSource | undefined> {
    const now = this.sourceForRequest();
    if (now) {
      return Promise.resolve(now);
    }
    if (signal?.aborted) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const done = (s: RingSource | undefined) => {
        clearTimeout(timer);
        this.sourceWaiters.delete(done);
        signal?.removeEventListener('abort', onAbort);
        resolve(s);
      };
      const onAbort = () => done(undefined);
      const timer = setTimeout(() => done(undefined), SOURCE_WAIT_MS);
      this.sourceWaiters.add(done);
      signal?.addEventListener('abort', onAbort);
    });
  }

  async *handleRecordingStreamRequest(streamId: number, signal?: AbortSignal): AsyncGenerator<RecordingPacket> {
    const configuration = this.configuration;
    const askedAt = Date.now();
    const source = await this.waitForSource(signal);
    if (!configuration || !source || signal?.aborted) {
      this.log.debug(`Doorbell camera: recording ${streamId}: no ring to record`);
      throw this.nothingToRecord();
    }
    // Until it's known whether the intercom's first keyframe is its old picture (at most
    // LEFTOVER_GAP_MS after it).
    await source.ready;
    if (signal?.aborted) {
      throw this.nothingToRecord();
    }
    // A second request for the same ring (the hub asks again while motion is on) starts from
    // the latest keyframe, so the ring isn't recorded twice.
    const firstRequest = source.requests++ === 0;
    const from = firstRequest ? source.start : source.latestKeyframe;
    // For the log: when the hub asked, and when the recording starts, after the ring.
    const ringAt = (source.call as { born?: number }).born;
    const startAt = source.units[from]?.at ?? Date.now();
    const sinceRing = (t: number) => (ringAt ? `${((t - ringAt) / 1000).toFixed(1)} s after the ring` : time(t));
    this.log.debug(
      `Doorbell camera: recording ${streamId}: HomeKit asked ${sinceRing(askedAt)}; the recording starts at ${time(startAt)} (${sinceRing(startAt)}, the first picture)` +
        `${!firstRequest && from ? ', from the latest keyframe (a second request for this ring)' : ''}` +
        `${firstRequest && source.skipped ? `, the intercom's second keyframe: its first (${source.skipped.bytes} bytes, ${(source.skipped.gapMs / 1000).toFixed(1)} s before) was its old picture` : ''}`,
    );
    const withAudio = this.audioActive();
    const proc = this.spawnProcess('recording', recordingArgs(configuration, withAudio, this.gainDb));
    const queue: { type: 'init' | 'fragment'; data: Buffer }[] = [];
    let finished = false;
    let wake: (() => void) | undefined;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const splitter = new Mp4Splitter();
    proc.stdout.on('data', (d: Buffer) => {
      try {
        queue.push(...splitter.push(d));
      } catch (e) {
        this.log.warn(`Doorbell camera: recording: ${(e as Error).message}`);
        proc.kill('SIGKILL');
      }
      notify();
    });
    // 'close' comes after all of stdout, and also when ffmpeg couldn't start at all ('exit' doesn't).
    proc.once('close', () => {
      finished = true;
      notify();
    });
    const stop = () => {
      finished = true;
      notify();
      feeder?.stop();
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.stdin.destroy();
        proc.kill('SIGKILL');
      }
    };
    let feeder: RingFeeder | undefined;
    this.streams.set(streamId, { stop });
    signal?.addEventListener('abort', stop);
    feeder = new RingFeeder(
      source,
      from,
      (b) => proc.stdin.writable && proc.stdin.write(b),
      withAudio,
      () => proc.stdin.end(),
    );
    let fragments = 0;
    try {
      let held: Buffer | undefined; // the latest fragment, sent once the next one shows it isn't the last
      for (;;) {
        while (queue.length > 0) {
          const p = queue.shift()!;
          if (p.type === 'init') {
            yield { data: p.data, isLast: false };
          } else {
            if (held) {
              if (fragments === 0) {
                this.log.debug(`Doorbell camera: recording ${streamId}: first piece to HomeKit at ${time(Date.now())}, ${((Date.now() - startAt) / 1000).toFixed(1)} s after the recording starts`);
              }
              yield { data: held, isLast: false };
              fragments++;
            }
            held = p.data;
          }
        }
        if (finished) {
          break;
        }
        await new Promise<void>((r) => (wake = r));
      }
      if (!held) {
        // ffmpeg failed, or the request was stopped before any video was recorded.
        throw this.nothingToRecord();
      }
      // Logged before the last one: HomeKit stops reading once it has it.
      fragments++;
      const snd = feeder.soundStats;
      this.log.debug(
        `Doorbell camera: recording ${streamId}: sent the ring to HomeKit, ${fragments} fragment(s), ${feeder.seconds.toFixed(1)} s (including the ${PREBUFFER_MS / 1000} s still at the start), ending at ${time(Date.now())}` +
          (withAudio
            ? `, with sound: ${snd.packets} pieces of the intercom's sound, ${(snd.gapBytes / ALAW_BYTES_PER_MS / 1000).toFixed(1)} s of gaps filled with silence, ` +
              `${snd.late} dropped as late (${(snd.late * 0.02).toFixed(1)} s)`
            : ', without sound'),
      );
      this.ended.add(streamId);
      yield { data: held, isLast: true };
    } finally {
      feeder.stop();
      signal?.removeEventListener('abort', stop);
      stop();
      this.streams.delete(streamId);
    }
  }

  acknowledgeStream(streamId: number): void {
    this.closeRecordingStream(streamId, undefined);
  }

  closeRecordingStream(streamId: number, reason: number | undefined): void {
    if (this.ended.delete(streamId)) {
      // After the last fragment, the hub usually doesn't confirm; hap-nodejs closes the stream
      // itself 12 s later (reason 3, "cancelled"). The recording is complete.
      this.log.debug(`Doorbell camera: recording ${streamId} closed`);
    } else if (reason !== undefined && reason !== 0) {
      this.log.debug(`Doorbell camera: recording ${streamId} stopped by HomeKit before its end (reason ${reason})`);
    }
    this.streams.get(streamId)?.stop();
    this.streams.delete(streamId);
  }

  /** Homebridge is shutting down. */
  shutdown(): void {
    for (const s of this.streams.values()) {
      s.stop();
    }
    this.streams.clear();
    this.reset();
    clearTimeout(this.motionTimer);
  }
}

/** Default spawn for recordings. */
export function spawnFfmpeg(ffmpeg: string, log: Logging): Spawn {
  return (what, args) => {
    log.debug(`Doorbell camera: ${what}: ${ffmpeg} ${args.join(' ')}`);
    const p = spawn(ffmpeg, args);
    p.stdin.on('error', () => undefined);
    // At debug level: when a call is answered, the live view's video joins mid-stream, and ffmpeg
    // reports the frames it can't decode until the next keyframe.
    p.stderr.on('data', (d: Buffer) => log.debug(`Doorbell camera ${what}: ${d.toString().trim().slice(0, 300)}`));
    p.on('error', (e) => log.error(`Doorbell camera ${what}: ${e.message}`));
    return p;
  };
}
