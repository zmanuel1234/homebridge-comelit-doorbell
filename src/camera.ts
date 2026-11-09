/**
 * Experimental: a HomeKit doorbell camera showing the intercom's video and audio.
 *
 * The intercom only sends media inside a call, so live video works while a ring is in
 * progress and the call is answered (`answerMode: answer-on-view`): opening the live view
 * answers the ring, like pressing Answer in the Comelit app. Without a call the camera
 * shows a still image.
 *
 * Video arrives as H.264, audio as G.711 A-law; ffmpeg re-encodes them for HomeKit (SRTP),
 * and with talk-back on, HomeKit's microphone audio is turned back into A-law for the
 * intercom's speaker. The ffmpeg arguments follow homebridge-camera-ffmpeg.
 */
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { createSocket, Socket } from 'dgram';
import { createWriteStream, existsSync, promises as fs, WriteStream } from 'fs';
import os from 'os';
import path from 'path';
import type {
  API,
  CameraControllerOptions,
  CameraStreamingDelegate,
  DoorbellController,
  Logging,
  PrepareStreamCallback,
  PrepareStreamRequest,
  SnapshotRequest,
  SnapshotRequestCallback,
  StreamingRequest,
  StreamRequestCallback,
} from 'homebridge';
import type { CallHandler, MediaSession } from './call';
import type { Settings } from './config';
import { ALAW_FRAME_BYTES, KeyframeCache, nalType } from './media';

/** A new viewer of an ongoing call starts from the latest keyframe if it is this recent. */
const FRESH_KEYFRAME_MS = 10_000;

interface PendingSession {
  address: string;
  ipv6: boolean;
  videoPort: number;
  videoReturnPort: number;
  videoSrtp: Buffer;
  videoSsrc: number;
  audioPort: number;
  audioReturnPort: number;
  audioSrtp: Buffer;
  audioSsrc: number;
}

interface ActiveSession {
  video?: ChildProcessWithoutNullStreams;
  audio?: ChildProcessWithoutNullStreams;
  talk?: ChildProcessWithoutNullStreams;
  socket?: Socket;
  inactivity?: NodeJS.Timeout;
  capture?: MediaCapture;
  media?: MediaSession | null;
  cleanup: Array<() => void>;
  /** For the summary line when the view ends. */
  stats: ViewStats;
}

/** What happened in one live view, logged as one line when it ends. */
interface ViewStats {
  startedAt: number;
  live: boolean;
  request: string;
  firstPictureAt: number;
  unitsToFfmpeg: number;
  /** From ffmpeg's progress: frames encoded and sent to the Home app. */
  framesOut: number;
  /** RTCP packets from the Home app (it sends them while it receives and shows the stream). */
  homekitReports: number;
  micFrames: number;
}

/** Counts RTCP receiver/sender reports in a (S)RTCP datagram. The headers are not encrypted. */
export function countRtcpReports(msg: Buffer): number {
  let n = 0;
  for (let off = 0; off + 4 <= msg.length; ) {
    const pt = msg[off + 1];
    if ((msg[off] & 0xc0) !== 0x80) {
      break;
    }
    if (pt === 200 || pt === 201) {
      n++;
    }
    const len = (msg.readUInt16BE(off + 2) + 1) * 4;
    off += len;
  }
  return n;
}

/** Saves a call's raw media for troubleshooting (mediaCaptureDir); keeps the last 10. */
export class MediaCapture {
  private readonly files: WriteStream[] = [];
  readonly video: WriteStream;
  readonly audio: WriteStream;
  readonly talk: WriteStream;
  readonly base: string;

  constructor(dir: string) {
    // Local time, like the Homebridge log: call-20261108-181624
    const d = new Date();
    const n = (v: number) => String(v).padStart(2, '0');
    const stamp = `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
    this.base = path.join(dir, `call-${stamp}`);
    this.video = this.open('.h264');
    this.audio = this.open('.alaw');
    this.talk = this.open('-talkback.alaw');
  }

  private open(ext: string): WriteStream {
    const f = createWriteStream(this.base + ext);
    f.on('error', () => undefined);
    this.files.push(f);
    return f;
  }

  close(): void {
    for (const f of this.files) {
      f.end();
    }
  }

  static async prepare(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const old = (await fs.readdir(dir)).filter((f) => f.startsWith('call-')).sort();
    const keep = new Set(old.map((f) => f.slice(0, 20)).filter((v, i, a) => a.indexOf(v) === i).slice(-9));
    await Promise.all(old.filter((f) => !keep.has(f.slice(0, 20))).map((f) => fs.unlink(path.join(dir, f)).catch(() => undefined)));
  }
}

/** Finds a free UDP port. */
function freePort(ipv6: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createSocket(ipv6 ? 'udp6' : 'udp4');
    s.once('error', reject);
    s.bind(0, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** The picture shown when there is no call, shipped with the plugin. */
export const DEFAULT_STILL = path.join(__dirname, '..', 'assets', 'doorbell-idle.jpg');

/**
 * ffmpeg: the configured path; else ffmpeg-for-homebridge (installed on its own, or inside
 * homebridge-camera-ffmpeg); else /usr/local/bin/ffmpeg (the Homebridge Raspberry Pi image);
 * else `ffmpeg` from PATH.
 */
export function resolveFfmpeg(configured: string, nodeModules = path.join(__dirname, '..', '..')): string {
  if (configured) {
    return configured;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const bundled = require('ffmpeg-for-homebridge') as string | undefined;
    if (bundled && existsSync(bundled)) {
      return bundled;
    }
  } catch {
    // not installed next to the plugin
  }
  const candidates = [
    path.join(nodeModules, '@homebridge-plugins', 'homebridge-camera-ffmpeg', 'node_modules', 'ffmpeg-for-homebridge', 'ffmpeg'),
    path.join(nodeModules, 'homebridge-camera-ffmpeg', 'node_modules', 'ffmpeg-for-homebridge', 'ffmpeg'),
    '/usr/local/bin/ffmpeg',
  ];
  return candidates.find((c) => existsSync(c)) ?? 'ffmpeg';
}

/** Pictures wider than 2:1 (the 6741W's 640x240) are 4:3 at half height: restore the height. */
export const RESTORE_ASPECT = "scale=w=iw:h='if(gt(iw/ih,2),2*ih,ih)',setsar=1";

/**
 * The intercom's video, read from stdin. Measured on 6741W recordings (2026-11-08):
 * ffmpeg showed nothing until the second keyframe, 3-4 s later: `showall` starts at the first.
 */
export const LIVE_INPUT = ['-flags2', '+showall', '-f', 'h264', '-framerate', '16', '-i', 'pipe:0'];

/**
 * The 6741W's SPS declares 1,200,000 fps, so ffmpeg gave frames timestamps microseconds apart
 * and sent 2 frames per call (a frozen picture). Each frame gets its arrival time instead.
 * Done in the filter, because `-use_wallclock_as_timestamps` works with ffmpeg 8 but not with
 * the 7.0 on the Homebridge Raspberry Pi image.
 */
export const ARRIVAL_TIME = 'setpts=(RTCTIME-RTCSTART)/(TB*1000000)';

export function videoArgs(o: { width: number; height: number; fps: number; bitrate: number; pt: number; ssrc: number; srtp: Buffer; address: string; port: number; mtu: number; codec: string; live?: boolean }): string[] {
  const encode =
    o.codec === 'copy'
      ? ['-c:v', 'copy']
      : [
          '-c:v', o.codec,
          // A keyframe every 2 s: the Home app joins the stream a moment after it starts, and
          // without a keyframe it shows grey smears until one comes (x264's default is 250 frames).
          ...(o.codec === 'libx264' ? ['-preset', 'ultrafast', '-tune', 'zerolatency', '-g', String(o.fps * 2)] : []),
          '-pix_fmt', 'yuv420p',
          '-color_range', 'mpeg',
          '-r', String(o.fps),
          // The 6741W sends 640x240: a 4:3 picture squeezed to half height. Restore the height for
          // pictures wider than 2:1, then fit the Home app's size.
          '-vf',
          `${o.live === false ? '' : `${ARRIVAL_TIME},`}${RESTORE_ASPECT},` +
            `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2`,
          '-b:v', `${o.bitrate}k`,
        ];
  return [
    '-hide_banner', '-loglevel', 'error',
    // No `nobuffer`: it drops what ffmpeg reads while probing the input, which is the intercom's
    // first keyframe (33 KB), so the picture stayed grey until the next one, 3-7 s later.
    '-fflags', '+genpts', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
    ...LIVE_INPUT,
    '-an', '-sn', '-dn',
    ...encode,
    '-payload_type', String(o.pt),
    '-ssrc', String(o.ssrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', o.srtp.toString('base64'),
    `srtp://${o.address}:${o.port}?rtcpport=${o.port}&pkt_size=${o.mtu}`,
  ];
}

export function audioArgs(o: { sampleRate: number; bitrate: number; pt: number; ssrc: number; srtp: Buffer; address: string; port: number; gainDb?: number }): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    // Without these, ffmpeg buffers about 3 s of audio to probe it, and the sound lags by that much.
    '-probesize', '32', '-analyzeduration', '0',
    '-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0',
    '-vn', '-sn', '-dn',
    // The 6741W's microphone is quiet (speech about -33 dB, 2026-11-08): turn it up, with a
    // limiter so loud sounds (the door release) don't distort.
    ...(o.gainDb ? ['-af', `volume=${o.gainDb}dB,alimiter=limit=0.9`] : []),
    '-c:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-flags', '+global_header',
    '-ar', `${o.sampleRate}k`, '-b:a', `${o.bitrate}k`, '-ac', '1',
    '-payload_type', String(o.pt),
    '-ssrc', String(o.ssrc),
    '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80',
    '-srtp_out_params', o.srtp.toString('base64'),
    `srtp://${o.address}:${o.port}?rtcpport=${o.port}&pkt_size=188`,
  ];
}

/** SDP describing the AAC-ELD audio HomeKit sends back (the microphone), for ffmpeg to decode. */
export function talkSdp(address: string, ipv6: boolean, port: number, srtp: Buffer): string {
  const ip = ipv6 ? 'IP6' : 'IP4';
  return [
    'v=0',
    `o=- 0 0 IN ${ip} ${address}`,
    's=Talk',
    `c=IN ${ip} ${address}`,
    't=0 0',
    `m=audio ${port} RTP/AVP 110`,
    'b=AS:24',
    'a=rtpmap:110 MPEG4-GENERIC/16000/1',
    'a=rtcp-mux',
    'a=fmtp:110 profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3; config=F8F0212C00BC00',
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${srtp.toString('base64')}`,
    '',
  ].join('\r\n');
}

/** The last visitor's picture, saved in Homebridge's storage folder. */
const VISITOR_FILE = 'comelit-last-visitor.h264';
/**
 * JPEG quality for the visitor's picture. ffmpeg's default is low; near-best quality measured
 * +2.7 dB (PSNR) on a 6741W frame, about 60 KB instead of 33 KB at 640x480.
 */
const SNAPSHOT_QUALITY = ['-q:v', '2'];
/** How long after a ring a picture request waits for the ring preview's picture. */
const PREVIEW_PICTURE_WAIT_MS = 4_500;

export class DoorbellCamera implements CameraStreamingDelegate {
  readonly controller: DoorbellController;
  private readonly ffmpeg: string;
  private readonly pending = new Map<string, PendingSession>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly keyframes = new KeyframeCache();
  private placeholder?: Buffer;
  private placeholderFile?: string;
  private warnedMissingImage = false;
  /** Which live view's microphone a call's talk-back is coming from (one at a time). */
  private readonly talkers = new WeakMap<MediaSession, { who: ActiveSession; at: number }>();
  /** Calls already being recorded (mediaCaptureDir). */
  private readonly captured = new WeakSet<MediaSession>();
  /** Calls whose video already feeds the keyframe cache. */
  private readonly fed = new WeakSet<MediaSession>();

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly settings: Settings,
    private readonly getCall: () => CallHandler | undefined,
  ) {
    this.ffmpeg = resolveFfmpeg(settings.ffmpegPath);
    const hap = api.hap;
    const options: CameraControllerOptions = {
      cameraStreamCount: 2,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          // Nothing larger than the intercom's own picture (640x240, shown as 640x480): offered
          // 1280x720, the Home app took it at ~300 kbps, and the enlarged picture came out
          // smeared, worst at the start.
          resolutions: [
            [320, 240, 15],
            [480, 360, 15],
            [640, 360, 15],
            [640, 480, 15],
          ],
          codec: { profiles: [hap.H264Profile.BASELINE, hap.H264Profile.MAIN, hap.H264Profile.HIGH], levels: [hap.H264Level.LEVEL3_1, hap.H264Level.LEVEL3_2, hap.H264Level.LEVEL4_0] },
        },
        audio: {
          twoWayAudio: settings.talkBack,
          codecs: [{ type: hap.AudioStreamingCodecType.AAC_ELD, samplerate: hap.AudioStreamingSamplerate.KHZ_16 }],
        },
      },
    };
    this.controller = new hap.DoorbellController(options);
    this.log.info(`Doorbell camera: ffmpeg ${this.ffmpeg}${settings.talkBack ? ', talk-back on' : ''}`);
    // The last visitor's picture is kept on disk too, so it survives a restart.
    const storage = api.user?.storagePath?.();
    if (storage && settings.lastVisitorMs > 0) {
      this.visitorFile = path.join(storage, VISITOR_FILE);
      void this.loadVisitor();
    }
    this.keyframes.onVisitor = (frame) => {
      this.pictureWait?.resolve();
      void this.saveVisitor(frame);
    };
  }

  /** Where the last visitor's picture is saved (as H.264), if anywhere. */
  private visitorFile?: string;

  private async saveVisitor(frame: Buffer): Promise<void> {
    if (!this.visitorFile) {
      return;
    }
    const tmp = `${this.visitorFile}.tmp`;
    try {
      await fs.writeFile(tmp, frame);
      await fs.rename(tmp, this.visitorFile);
    } catch (e) {
      this.log.debug(`Doorbell camera: could not save the last visitor's picture: ${(e as Error).message}`);
    }
  }

  /** Loads the picture saved before a restart; its age is the file's. */
  private async loadVisitor(): Promise<void> {
    if (!this.visitorFile) {
      return;
    }
    try {
      const [frame, stat] = await Promise.all([fs.readFile(this.visitorFile), fs.stat(this.visitorFile)]);
      if (frame.length > 0 && Date.now() - stat.mtimeMs <= this.settings.lastVisitorMs) {
        this.keyframes.restoreVisitor(frame, stat.mtimeMs);
        this.log.debug(`Doorbell camera: showing the last visitor from ${stat.mtime.toLocaleString()}`);
      }
    } catch {
      // none saved yet
    }
  }

  ring(): void {
    this.ringAt = Date.now();
    if (this.settings.ringPreview) {
      // HomeKit asks for the notification's picture within a second or two of the ring; the
      // intercom's first picture comes about 3 s after it. Hold such requests until it is here.
      this.pictureWait?.resolve();
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      const timer = setTimeout(resolve, PREVIEW_PICTURE_WAIT_MS);
      timer.unref?.();
      this.pictureWait = { promise, resolve: () => { clearTimeout(timer); resolve(); } };
      void promise.then(() => (this.pictureWait = undefined));
    }
    this.controller.ringDoorbell();
  }

  /** When the doorbell last rang. */
  private ringAt = 0;
  /** Set from a ring until the ring preview's picture arrives, the preview stops, or PREVIEW_PICTURE_WAIT_MS. */
  private pictureWait?: { promise: Promise<void>; resolve: () => void };

  /** The ring preview stopped: stop waiting for its picture (it may have none). */
  previewDone(): void {
    this.pictureWait?.resolve();
  }

  /** Video from the ring preview: its first keyframe becomes the visitor's picture. */
  previewVideo(call: object, unit: Buffer): void {
    this.keyframes.newCall(call);
    this.keyframes.push(unit);
  }

  // ─── Snapshots ─────────────────────────────────────────────────────────────

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    this.snapshot(request)
      .then((jpeg) => callback(undefined, jpeg))
      .catch((e) => {
        this.log.warn(`Doorbell camera snapshot failed: ${(e as Error).message}`);
        callback(e as Error);
      });
  }

  private async snapshot(request: SnapshotRequest): Promise<Buffer> {
    const asked = Date.now();
    const waiting = this.pictureWait;
    if (waiting) {
      await waiting.promise;
    }
    const visitor = await this.lastVisitor(request.width);
    if (this.settings.ringPreview && this.ringAt && asked - this.ringAt < 60_000) {
      const which = !visitor ? 'no picture, gave the idle one' : this.keyframes.visitorAt() >= this.ringAt ? "gave this ring's picture" : 'gave an earlier visitor\'s picture';
      const waited = waiting ? ` after waiting ${((Date.now() - asked) / 1000).toFixed(1)} s` : '';
      this.log.info(`Ring preview: HomeKit asked for the picture ${((asked - this.ringAt) / 1000).toFixed(1)} s after the ring; ${which}${waited}`);
    }
    return visitor ?? this.placeholderImage();
  }

  /** The last visitor's picture from the last call, if it is recent enough (lastVisitorMinutes). */
  private async lastVisitor(width: number): Promise<Buffer | undefined> {
    const keyframe = this.settings.lastVisitorMs > 0 ? this.keyframes.visitor(this.settings.lastVisitorMs) : undefined;
    if (!keyframe) {
      return undefined;
    }
    try {
      return await this.runToBuffer(['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-vf', `${RESTORE_ASPECT},scale=${width}:-2`, ...SNAPSHOT_QUALITY, '-f', 'image2', '-'], keyframe);
    } catch (e) {
      this.log.warn(`Doorbell camera: could not make a picture from the video (${(e as Error).message}); showing the idle picture`);
      return undefined;
    }
  }

  private async placeholderImage(): Promise<Buffer> {
    if (!this.placeholder) {
      try {
        this.placeholder = await fs.readFile(await this.placeholderPath());
      } catch (e) {
        this.log.warn(`Doorbell camera: can't read the picture (${(e as Error).message}); using a plain one`);
        this.placeholder = await this.runToBuffer(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x202020:s=1280x720', '-frames:v', '1', '-f', 'image2', '-']);
      }
    }
    return this.placeholder;
  }

  /** The still image as a file, for ffmpeg to loop: the configured one, else the one shipped with the plugin. */
  private async placeholderPath(): Promise<string> {
    const configured = this.settings.snapshotImage;
    if (configured && existsSync(configured)) {
      return configured;
    }
    if (configured && !this.warnedMissingImage) {
      // A missing file would make every live view without a call fail: use the built-in picture.
      this.warnedMissingImage = true;
      this.log.warn(`Doorbell camera: snapshotImage ${configured} not found; using the built-in picture`);
    }
    if (existsSync(DEFAULT_STILL)) {
      return DEFAULT_STILL;
    }
    if (!this.placeholderFile) {
      const file = path.join(os.tmpdir(), 'comelit-doorbell-still.jpg');
      await fs.writeFile(file, await this.runToBuffer(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x202020:s=1280x720', '-frames:v', '1', '-f', 'image2', '-']));
      this.placeholderFile = file;
    }
    return this.placeholderFile;
  }

  private runToBuffer(args: string[], input?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, args);
      const out: Buffer[] = [];
      let err = '';
      p.stdout.on('data', (d: Buffer) => out.push(d));
      p.stderr.on('data', (d: Buffer) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 && out.length > 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(0, 200)}`))));
      p.stdin.on('error', () => undefined);
      p.stdin.end(input);
    });
  }

  // ─── Streaming ─────────────────────────────────────────────────────────────

  async prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): Promise<void> {
    const ipv6 = request.addressVersion === 'ipv6';
    try {
      const hap = this.api.hap;
      const session: PendingSession = {
        address: request.targetAddress,
        ipv6,
        videoPort: request.video.port,
        videoReturnPort: await freePort(ipv6),
        videoSrtp: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSsrc: hap.CameraController.generateSynchronisationSource(),
        audioPort: request.audio.port,
        audioReturnPort: await freePort(ipv6),
        audioSrtp: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        audioSsrc: hap.CameraController.generateSynchronisationSource(),
      };
      this.pending.set(request.sessionID, session);
      callback(undefined, {
        video: { port: session.videoReturnPort, ssrc: session.videoSsrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
        audio: { port: session.audioReturnPort, ssrc: session.audioSsrc, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt },
      });
    } catch (e) {
      callback(e as Error);
    }
  }

  async handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): Promise<void> {
    if (request.type === 'start') {
      try {
        await this.startStream(request.sessionID, request);
        callback();
      } catch (e) {
        this.log.error(`Doorbell camera: stream failed: ${(e as Error).message}`);
        await this.stopStream(request.sessionID, 'start failed');
        callback(e as Error);
      }
    } else if (request.type === 'stop') {
      await this.stopStream(request.sessionID, 'viewer closed');
      callback();
    } else {
      callback(); // reconfigure: ignored
    }
  }

  private async startStream(sessionID: string, request: Extract<StreamingRequest, { type: 'start' }>): Promise<void> {
    const p = this.pending.get(sessionID);
    if (!p) {
      throw new Error('unknown stream session');
    }
    this.pending.delete(sessionID);
    const v0 = request.video;
    const active: ActiveSession = {
      cleanup: [],
      stats: { startedAt: Date.now(), live: false, request: `${v0.width}x${v0.height} ${v0.fps} fps ${v0.max_bit_rate} kbps`, firstPictureAt: 0, unitsToFfmpeg: 0, framesOut: 0, homekitReports: 0, micFrames: 0 },
    };
    this.active.set(sessionID, active);

    // Answer the ring and start the intercom's media, if a call is ringing. HomeKit gives up
    // on a slow start, so after liveViewWaitSeconds show the picture instead.
    let media: MediaSession | null = null;
    const starting = this.getCall()?.startMedia(this.settings.videoQuality === 'hd');
    if (starting) {
      let timedOut = false;
      const cap = new Promise<null>((r) =>
        setTimeout(() => {
          timedOut = true;
          r(null);
        }, this.settings.liveViewWaitMs),
      );
      try {
        media = await Promise.race([starting, cap]);
      } catch (e) {
        this.log.warn(`Doorbell camera: could not start the intercom's media: ${(e as Error).message}`);
      }
      if (timedOut) {
        this.log.warn(`Doorbell camera: the intercom's media took over ${this.settings.liveViewWaitMs / 1000} s; showing the picture`);
        // If it does arrive later and nobody is watching it, end it.
        starting
          .then((late) => {
            if (late && ![...this.active.values()].some((s) => s.media === late)) {
              void late.end('no viewer');
            }
          })
          .catch(() => undefined);
      }
    }
    active.media = media;
    // The viewer can leave (stopStream) during any await below: check again after each, before
    // starting ffmpeg or the socket, which stopStream would no longer clean up.
    const left = (): boolean => this.active.get(sessionID) !== active;
    if (left()) {
      // The viewer left while the media was starting: end the media if nobody else watches it.
      if (media && ![...this.active.values()].some((s) => s.media === media)) {
        void media.end('viewer left');
      }
      return;
    }
    if (media?.isEnded) {
      // The call ended (or another viewer's leaving ended it) while it was starting: show the
      // picture instead of a live view that would never get anything.
      this.log.info('Doorbell camera: the call ended while the live view was starting; showing the picture');
      media = null;
      active.media = null;
    }
    const v = request.video;
    this.log.info(`Doorbell camera: streaming ${v.width}x${v.height} ${v.fps} fps ${v.max_bit_rate} kbps (${media ? 'live from the intercom' : 'still image, no call to show'})`);

    const vargs = videoArgs({
      width: v.width, height: v.height, fps: Math.min(v.fps, 16), bitrate: v.max_bit_rate, pt: v.pt, ssrc: p.videoSsrc, srtp: p.videoSrtp,
      address: p.address, port: p.videoPort, mtu: v.mtu, codec: media ? this.settings.videoCodec : 'libx264', live: Boolean(media),
    });
    // ffmpeg reports its progress on stdout: frames encoded and sent to the Home app.
    vargs.unshift('-progress', 'pipe:1');
    active.stats.live = Boolean(media);
    if (!media) {
      // No call: loop a still picture. The last visitor's, if recent, so that looking at the
      // camera after a call shows the same picture as its tile (not the idle one).
      const visitor = await this.lastVisitor(v.width);
      let still = await this.placeholderPath();
      if (left()) {
        return;
      }
      if (visitor) {
        // One file per view: ffmpeg re-reads it for every frame, so views mustn't share it.
        const file = path.join(os.tmpdir(), `comelit-last-visitor-${process.pid}-${sessionID.slice(0, 8)}.jpg`);
        const remove = () => void fs.unlink(file).catch(() => undefined);
        await fs.writeFile(file, visitor);
        if (left()) {
          remove();
          return;
        }
        still = file;
        active.cleanup.push(remove);
        active.stats.request += ', showing the last visitor';
      }
      const idx = vargs.indexOf(LIVE_INPUT[0]);
      vargs.splice(idx, LIVE_INPUT.length, '-re', '-loop', '1', '-framerate', '1', '-i', still);
      active.video = this.spawnProcess('video', vargs);
      this.watchProgress(active);
    } else {
      // One recording per call, even when several devices watch it.
      let capture: MediaCapture | undefined;
      if (this.settings.mediaCaptureDir && !this.captured.has(media)) {
        this.captured.add(media);
        capture = await this.startCapture();
        if (left()) {
          // stopStream has already ended the media if this was its last viewer.
          capture?.close();
          this.captured.delete(media);
          return;
        }
        if (media.isEnded) {
          // The call ended meanwhile: its 'end' came before anything below listens for it.
          capture?.close();
          this.controller.forceStopStreamingSession(sessionID);
          await this.stopStream(sessionID, 'the intercom ended the call');
          return;
        }
      }
      active.video = this.spawnProcess('video', vargs);
      this.watchProgress(active);
      if (capture) {
        const onRawVideo = (unit: Buffer) => capture.video.write(unit);
        const onRawAudio = (alaw: Buffer) => capture.audio.write(alaw);
        media.on('video', onRawVideo);
        media.on('audio', onRawAudio);
        active.cleanup.push(() => {
          media?.off('video', onRawVideo);
          media?.off('audio', onRawAudio);
          capture.close();
        });
        active.capture = capture;
      }
      this.keyframes.newCall(media);
      this.feedKeyframes(media);
      const first = this.keyframes.keyframe(FRESH_KEYFRAME_MS);
      if (first) {
        active.video.stdin.write(first);
      }
      // Until the stream's parameters (SPS) arrive, ffmpeg can't decode anything and logs
      // "non-existing PPS": start at the first SPS instead.
      let decodable = Boolean(first);
      const viewStart = active.stats.startedAt;
      if (first) {
        active.stats.firstPictureAt = viewStart;
      }
      const onVideo = (unit: Buffer) => {
        if (!decodable && nalType(unit) === 7) {
          decodable = true;
          active.stats.firstPictureAt = Date.now();
          this.log.info(`Doorbell camera: first picture to HomeKit ${((Date.now() - viewStart) / 1000).toFixed(1)} s after the live view started`);
        }
        if (decodable) {
          active.stats.unitsToFfmpeg++;
          active.video?.stdin.write(unit);
        }
      };
      media.on('video', onVideo);
      active.cleanup.push(() => media?.off('video', onVideo));

      const a = request.audio;
      active.audio = this.spawnProcess('audio', audioArgs({ sampleRate: a.sample_rate, bitrate: a.max_bit_rate, pt: a.pt, ssrc: p.audioSsrc, srtp: p.audioSrtp, address: p.address, port: p.audioPort, gainDb: this.settings.doorVolumeDb }));
      const onAudio = (alaw: Buffer) => active.audio?.stdin.write(alaw);
      media.on('audio', onAudio);
      active.cleanup.push(() => media?.off('audio', onAudio));

      const onEnd = (reason: string) => {
        this.log.info(`Doorbell camera: call ended (${reason})`);
        this.controller.forceStopStreamingSession(sessionID);
        void this.stopStream(sessionID, reason);
      };
      media.once('end', onEnd);
      active.cleanup.push(() => media?.off('end', onEnd));

      if (this.settings.talkBack) {
        this.startTalkBack(active, p, media);
      }
    }

    // HomeKit sends RTCP on the video return port; stop if it goes quiet (or never starts).
    const socket = createSocket(p.ipv6 ? 'udp6' : 'udp4');
    socket.on('error', (e) => this.log.warn(`Doorbell camera: socket error ${e.message}`));
    const armInactivity = () => {
      clearTimeout(active.inactivity);
      active.inactivity = setTimeout(() => {
        this.log.info('Doorbell camera: viewer inactive, stopping');
        this.controller.forceStopStreamingSession(sessionID);
        void this.stopStream(sessionID, 'viewer inactive');
      }, Math.max(v.rtcp_interval, 0.5) * 5 * 1000 + 5000);
    };
    // If the video ffmpeg dies, HomeKit would keep showing a frozen picture: end the view.
    active.video.once('exit', (code, signal) => {
      if (this.active.get(sessionID) === active) {
        this.log.warn(`Doorbell camera: video ffmpeg stopped (${signal ?? `exit ${code}`}); ending the live view`);
        this.controller.forceStopStreamingSession(sessionID);
        void this.stopStream(sessionID, 'ffmpeg stopped');
      }
    });
    socket.on('message', (msg: Buffer) => {
      active.stats.homekitReports += countRtcpReports(msg);
      armInactivity();
    });
    armInactivity();
    socket.bind(p.videoReturnPort);
    active.socket = socket;
  }

  /** Keeps the call's keyframes for the snapshot and later views: once per call, however many watch it. */
  private feedKeyframes(media: MediaSession): void {
    if (this.fed.has(media)) {
      return;
    }
    this.fed.add(media);
    media.on('video', (unit: Buffer) => this.keyframes.push(unit));
  }

  /** Reads ffmpeg's progress (key=value lines) for the number of frames sent to the Home app. */
  private watchProgress(active: ActiveSession): void {
    let rest = '';
    active.video?.stdout.on('data', (d: Buffer) => {
      const lines = (rest + d.toString()).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('frame=')) {
          active.stats.framesOut = Number(line.slice(6)) || active.stats.framesOut;
        }
      }
    });
  }

  private async startCapture(): Promise<MediaCapture | undefined> {
    try {
      await MediaCapture.prepare(this.settings.mediaCaptureDir);
      const c = new MediaCapture(this.settings.mediaCaptureDir);
      this.log.info(`Doorbell camera: saving this call's media to ${c.base}.*`);
      return c;
    } catch (e) {
      this.log.warn(`Doorbell camera: can't save media to ${this.settings.mediaCaptureDir}: ${(e as Error).message}`);
      return undefined;
    }
  }

  /** The one-line summary of a live view, for the log. */
  private summary(active: ActiveSession, reason: string): string {
    const s = active.stats;
    const secs = (at: number) => `${((at - s.startedAt) / 1000).toFixed(1)} s`;
    const parts = [
      `${secs(Date.now())}`,
      s.live ? 'live' : 'still picture',
      `asked ${s.request}`,
      s.live ? `first picture ${s.firstPictureAt ? secs(s.firstPictureAt) : 'never'}` : '',
      `frames sent to the Home app=${s.framesOut}`,
      s.live ? `video units to ffmpeg=${s.unitsToFfmpeg}` : '',
      `Home app reports=${s.homekitReports}`,
      this.settings.talkBack && s.live ? `microphone data=${s.micFrames}` : '',
      `ended: ${reason}`,
    ].filter(Boolean);
    const media = s.live && active.media ? `; ${active.media.describe()}` : '';
    return `Doorbell camera: live view summary: ${parts.join(', ')}${media}`;
  }

  private startTalkBack(active: ActiveSession, p: PendingSession, media: MediaSession): void {
    const talk = this.spawnProcess('talk-back', [
      '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
      '-f', 'sdp', '-c:a', 'libfdk_aac', '-i', 'pipe:0',
      '-vn', '-c:a', 'pcm_alaw', '-ar', '8000', '-ac', '1', '-f', 'alaw', 'pipe:1',
    ]);
    talk.stdin.end(talkSdp(p.address, p.ipv6, p.audioReturnPort, p.audioSrtp));
    let pending = Buffer.alloc(0);
    let frames = 0;
    talk.stdout.on('data', (d: Buffer) => {
      if (frames === 0) {
        this.log.info('Doorbell camera: talk-back: sound from the Home app microphone is arriving');
      }
      frames++;
      active.stats.micFrames++;
      active.capture?.talk.write(d);
      pending = Buffer.concat([pending, d]);
      // Two viewers talking at once would interleave their sound into a garble: whoever
      // talks first keeps the line until they have been quiet (no data) for a second.
      const now = Date.now();
      const talker = this.talkers.get(media);
      if (talker && talker.who !== active && now - talker.at < 1000) {
        pending = Buffer.alloc(0);
        return;
      }
      this.talkers.set(media, { who: active, at: now });
      while (pending.length >= ALAW_FRAME_BYTES) {
        const frame = pending.subarray(0, ALAW_FRAME_BYTES);
        pending = pending.subarray(ALAW_FRAME_BYTES);
        void media.sendAudio(frame).catch(() => undefined);
      }
    });
    active.talk = talk;
  }

  private spawnProcess(what: string, args: string[]): ChildProcessWithoutNullStreams {
    this.log.debug(`Doorbell camera: ${what}: ${this.ffmpeg} ${args.join(' ')}`);
    const p = spawn(this.ffmpeg, args, { env: process.env });
    p.stdin.on('error', () => undefined);
    p.stderr.on('data', (d: Buffer) => this.log.warn(`Doorbell camera ${what}: ${d.toString().trim().slice(0, 300)}`));
    p.on('error', (e) => this.log.error(`Doorbell camera ${what}: ${e.message}`));
    return p;
  }

  private async stopStream(sessionID: string, reason: string): Promise<void> {
    const active = this.active.get(sessionID);
    if (!active) {
      return;
    }
    this.active.delete(sessionID);
    clearTimeout(active.inactivity);
    this.log.info(this.summary(active, reason));
    for (const c of active.cleanup) {
      c();
    }
    for (const proc of [active.video, active.audio, active.talk]) {
      if (proc && proc.exitCode === null) {
        proc.stdin.destroy();
        proc.kill('SIGKILL');
      }
    }
    try {
      active.socket?.close();
    } catch {
      // already closed
    }
    // Last viewer gone: hang up, as closing the call in the app does.
    if (active.media && ![...this.active.values()].some((s) => s.media === active.media)) {
      await active.media.end(reason).catch(() => undefined);
    }
  }
}
