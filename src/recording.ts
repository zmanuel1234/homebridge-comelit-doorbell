import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { CameraRecordingConfiguration, CameraRecordingDelegate, Logging, RecordingPacket } from 'homebridge';
import { LIVE_INPUT, RESTORE_ASPECT } from './camera';
import { MIN_PICTURE_BYTES, nalType } from './media';
import { RECORDING_MAX_MS } from './settings';

/**
 * HomeKit Secure Video for the doorbell camera (setting `recording`).
 *
 * The intercom only sends video during a ring or a call, so a recording is one ring: it starts
 * at the ring's first real picture (about 3 s after the button; an empty, black first keyframe
 * is skipped) and ends when the call ends, answered or not. The camera's own motion sensor is
 * "motion detected" for that time, which is what makes the home hub record (the doorbell press
 * is offered as a trigger too, but motion is the one the Home app's recording options use).
 *
 * When the hub asks for the recording, ffmpeg re-encodes the intercom's video to fragmented
 * MP4, with a keyframe at every fragment boundary (the intercom's own come every 2.7-7 s), and
 * the fragments are passed on as they come. Sound: a silent track when HomeKit records audio
 * (the intercom's sound follows in a later version).
 */

/** How long a recording request waits for a ring's first picture. */
const SOURCE_WAIT_MS = 10_000;
/** How many video units a ring keeps for a recording that starts late (about 2 min). */
const MAX_BUFFERED_UNITS = 4_000;
/** No video for this long ends the ring's recording (the intercom stopped sending). */
export const SOURCE_SILENCE_MS = 5_000;
/** An ended ring can still be fetched by a hub request this long after it ends. */
const LATE_REQUEST_MS = 15_000;
/** Motion stays on at least this long, so a short ring isn't missed by the hub. */
const MIN_MOTION_MS = 5_000;

/** One ring's video, from its first real picture until the call ends or the video stops. */
export class RingSource {
  readonly units: Buffer[] = [];
  ended = false;
  endedAt = 0;
  /** How many recording requests this ring has had. */
  requests = 0;
  /** Where each keyframe group (SPS) starts in `units`. */
  private readonly keyStarts: number[] = [];
  private readonly listeners = new Set<{ unit: (u: Buffer) => void; end: () => void }>();
  private readonly capTimer: NodeJS.Timeout;
  private silenceTimer?: NodeJS.Timeout;

  constructor(readonly call: object, first: Buffer[], private readonly onEnd: (s: RingSource) => void = () => undefined) {
    for (const u of first) {
      this.keep(u);
    }
    this.capTimer = setTimeout(() => this.end(), RECORDING_MAX_MS);
    this.capTimer.unref?.();
    this.armSilence();
  }

  private keep(unit: Buffer): void {
    if (this.units.length < MAX_BUFFERED_UNITS) {
      if (nalType(unit) === 7) {
        this.keyStarts.push(this.units.length);
      }
      this.units.push(unit);
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
    this.keep(unit);
    this.armSilence();
    for (const l of this.listeners) {
      l.unit(unit);
    }
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.endedAt = Date.now();
    clearTimeout(this.capTimer);
    clearTimeout(this.silenceTimer);
    for (const l of [...this.listeners]) {
      l.end();
    }
    this.listeners.clear();
    this.onEnd(this);
  }

  /**
   * What is kept from `from` (a unit index), then each new unit as it comes; `end` once the
   * ring is over.
   */
  follow(unit: (u: Buffer) => void, end: () => void, from = 0): () => void {
    for (const u of this.units.slice(from)) {
      unit(u);
    }
    if (this.ended) {
      end();
      return () => undefined;
    }
    const l = { unit, end };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Where the latest keyframe group starts, for a second request that shouldn't replay the ring. */
  get latestKeyframe(): number {
    return this.keyStarts.at(-1) ?? 0;
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

/**
 * Timestamps for a recording: by frame count, at the intercom's 16 frames per second (15-16
 * measured). Not the arrival time used for the live view: a recording may start a moment
 * after the ring, and the ring's first frames are then written to ffmpeg all at once.
 */
export const FRAME_COUNT_TIME = 'setpts=N/(16*TB)';

const PROFILES = ['baseline', 'main', 'high'];
const LEVELS = ['3.1', '3.2', '4.0'];
const SAMPLE_RATES = [8000, 16000, 24000, 32000, 44100, 48000];

/** ffmpeg arguments for one recording, as HomeKit configured it. */
export function recordingArgs(c: CameraRecordingConfiguration, withAudio: boolean): string[] {
  const [width, height, fps] = c.videoCodec.resolution;
  // A keyframe a little before each fragment length: a keyframe exactly at the length can land
  // one frame after it (4.06 s for 4 s at 15 fps), which would make the fragment too long.
  const keyEveryS = Math.max(1, c.mediaContainerConfiguration.fragmentLength / 1000 - 0.25);
  const kbps = c.videoCodec.parameters.bitRate;
  const audio = withAudio
    ? (() => {
      const rate = SAMPLE_RATES[c.audioCodec.samplerate] ?? 16000;
      const eld = c.audioCodec.type === 1; // AudioRecordingCodecType.AAC_ELD
      return {
        input: ['-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${rate}`],
        map: ['-map', '1:a'],
        encode: ['-c:a', 'libfdk_aac', '-profile:a', eld ? 'aac_eld' : 'aac_low', '-ar', String(rate), '-ac', '1', '-b:a', `${c.audioCodec.bitrate || 32}k`, '-shortest'],
      };
    })()
    : undefined;
  return [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', '+genpts', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
    ...LIVE_INPUT,
    ...(audio?.input ?? []),
    '-map', '0:v',
    ...(audio?.map ?? []),
    '-sn', '-dn',
    '-vf',
    `${FRAME_COUNT_TIME},${RESTORE_ASPECT},scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-color_range', 'mpeg',
    '-profile:v', PROFILES[c.videoCodec.parameters.profile] ?? 'main',
    '-level:v', LEVELS[c.videoCodec.parameters.level] ?? '3.1',
    '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
    // Each fragment must start with a keyframe and be no longer than HomeKit's fragment length.
    '-force_key_frames', `expr:gte(t,n_forced*${keyEveryS})`, '-g', String(Math.round(fps * (keyEveryS + 0.25))), '-sc_threshold', '0',
    ...(audio?.encode ?? ['-an']),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
}

type Spawn = (what: string, args: string[]) => ChildProcessWithoutNullStreams;

export class RingRecorder implements CameraRecordingDelegate {
  private active = false;
  private configuration?: CameraRecordingConfiguration;
  /** Per call: the last SPS/PPS and the keyframe being received, until the first real picture. */
  private readonly waiting = new Map<object, { params: Buffer[]; idr: Buffer[]; idrBytes: number; lastType: number }>();
  /** The ring being recorded. */
  private source?: RingSource;
  /** The last ring, after it ended: a hub request that comes late still gets it. */
  private lastSource?: RingSource;
  private readonly sourceWaiters = new Set<(s: RingSource) => void>();
  private readonly streams = new Map<number, { stop: () => void }>();
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
      w = { params: [], idr: [], idrBytes: 0, lastType: -1 };
      this.waiting.set(call, w);
    }
    const type = nalType(unit);
    if (type !== 5 && w.lastType === 5 && w.idrBytes >= MIN_PICTURE_BYTES && w.params.length > 0) {
      // The keyframe is complete and is a real picture: the recording starts with it.
      this.waiting.delete(call);
      const source = new RingSource(call, [...w.params, ...w.idr], (ended) => this.sourceEnded(ended));
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
    const source = await this.waitForSource(signal);
    if (!configuration || !source || signal?.aborted) {
      this.log.debug(`Doorbell camera: recording ${streamId}: no ring to record`);
      throw this.nothingToRecord();
    }
    // A second request for the same ring (the hub asks again while motion is on) starts from
    // the latest keyframe, so the ring isn't recorded twice.
    const from = source.requests++ === 0 ? 0 : source.latestKeyframe;
    const withAudio = this.audioActive();
    const proc = this.spawnProcess('recording', recordingArgs(configuration, withAudio));
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
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.stdin.destroy();
        proc.kill('SIGKILL');
      }
    };
    this.streams.set(streamId, { stop });
    signal?.addEventListener('abort', stop);
    const unfollow = source.follow(
      (unit) => proc.stdin.writable && proc.stdin.write(unit),
      () => proc.stdin.end(),
      from,
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
      yield { data: held, isLast: true };
      fragments++;
      this.log.debug(`Doorbell camera: recording ${streamId} sent ${fragments} fragment(s)`);
    } finally {
      unfollow();
      signal?.removeEventListener('abort', stop);
      stop();
      this.streams.delete(streamId);
    }
  }

  acknowledgeStream(streamId: number): void {
    this.closeRecordingStream(streamId, undefined);
  }

  closeRecordingStream(streamId: number, reason: number | undefined): void {
    if (reason !== undefined && reason !== 0) {
      this.log.debug(`Doorbell camera: recording ${streamId} closed by HomeKit (reason ${reason})`);
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
    const p = spawn(ffmpeg, args, { env: process.env });
    p.stdin.on('error', () => undefined);
    // At debug level: when a call is answered, the live view's video joins mid-stream, and ffmpeg
    // reports the frames it can't decode until the next keyframe.
    p.stderr.on('data', (d: Buffer) => log.debug(`Doorbell camera ${what}: ${d.toString().trim().slice(0, 300)}`));
    p.on('error', (e) => log.error(`Doorbell camera ${what}: ${e.message}`));
    return p;
  };
}
