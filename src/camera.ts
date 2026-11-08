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
import { existsSync, promises as fs } from 'fs';
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
  media?: MediaSession | null;
  cleanup: Array<() => void>;
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

export function videoArgs(o: { width: number; height: number; fps: number; bitrate: number; pt: number; ssrc: number; srtp: Buffer; address: string; port: number; mtu: number; codec: string }): string[] {
  const encode =
    o.codec === 'copy'
      ? ['-c:v', 'copy']
      : [
          '-c:v', o.codec,
          ...(o.codec === 'libx264' ? ['-preset', 'ultrafast', '-tune', 'zerolatency'] : []),
          '-pix_fmt', 'yuv420p',
          '-color_range', 'mpeg',
          '-r', String(o.fps),
          '-vf', `scale=${o.width}:${o.height}:force_original_aspect_ratio=decrease,pad=${o.width}:${o.height}:(ow-iw)/2:(oh-ih)/2`,
          '-b:v', `${o.bitrate}k`,
        ];
  return [
    '-hide_banner', '-loglevel', 'error',
    '-fflags', '+genpts+nobuffer', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
    '-f', 'h264', '-framerate', '16', '-i', 'pipe:0',
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

export function audioArgs(o: { sampleRate: number; bitrate: number; pt: number; ssrc: number; srtp: Buffer; address: string; port: number }): string[] {
  return [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'alaw', '-ar', '8000', '-ac', '1', '-i', 'pipe:0',
    '-vn', '-sn', '-dn',
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

export class DoorbellCamera implements CameraStreamingDelegate {
  readonly controller: DoorbellController;
  private readonly ffmpeg: string;
  private readonly pending = new Map<string, PendingSession>();
  private readonly active = new Map<string, ActiveSession>();
  private readonly keyframes = new KeyframeCache();
  private placeholder?: Buffer;
  private placeholderFile?: string;
  private warnedMissingImage = false;

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
          resolutions: [
            [320, 240, 15],
            [480, 360, 15],
            [640, 360, 15],
            [640, 480, 15],
            [1280, 720, 15],
            [1920, 1080, 15],
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
  }

  ring(): void {
    this.controller.ringDoorbell();
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
    const keyframe = this.settings.lastVisitorMs > 0 ? this.keyframes.keyframe(this.settings.lastVisitorMs) : undefined;
    if (keyframe) {
      try {
        return await this.runToBuffer(['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=${request.width}:-2`, '-f', 'image2', '-'], keyframe);
      } catch (e) {
        this.log.warn(`Doorbell camera: could not make a picture from the video (${(e as Error).message}); showing the idle picture`);
      }
    }
    return this.placeholderImage();
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
    const active: ActiveSession = { cleanup: [] };
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
    if (this.active.get(sessionID) !== active) {
      // The viewer left while the media was starting: end the media if nobody else watches it.
      if (media && ![...this.active.values()].some((s) => s.media === media)) {
        void media.end('viewer left');
      }
      return;
    }
    const v = request.video;
    this.log.info(`Doorbell camera: streaming ${v.width}x${v.height} ${v.fps} fps ${v.max_bit_rate} kbps (${media ? 'live from the intercom' : 'still image, no call to show'})`);

    const vargs = videoArgs({
      width: v.width, height: v.height, fps: Math.min(v.fps, 16), bitrate: v.max_bit_rate, pt: v.pt, ssrc: p.videoSsrc, srtp: p.videoSrtp,
      address: p.address, port: p.videoPort, mtu: v.mtu, codec: media ? this.settings.videoCodec : 'libx264',
    });
    if (!media) {
      // No call: loop the still image instead of the intercom's video.
      const still = await this.placeholderPath();
      const idx = vargs.indexOf('-f');
      vargs.splice(idx, 6, '-re', '-loop', '1', '-framerate', '1', '-i', still);
      active.video = this.spawnProcess('video', vargs);
    } else {
      active.video = this.spawnProcess('video', vargs);
      const first = this.keyframes.keyframe(FRESH_KEYFRAME_MS);
      if (first) {
        active.video.stdin.write(first);
      }
      // Until the stream's parameters (SPS) arrive, ffmpeg can't decode anything and logs
      // "non-existing PPS": start at the first SPS instead.
      let decodable = Boolean(first);
      const viewStart = Date.now();
      const onVideo = (unit: Buffer) => {
        this.keyframes.push(unit);
        if (!decodable && nalType(unit) === 7) {
          decodable = true;
          this.log.info(`Doorbell camera: first picture to HomeKit ${((Date.now() - viewStart) / 1000).toFixed(1)} s after the live view started`);
        }
        if (decodable) {
          active.video?.stdin.write(unit);
        }
      };
      media.on('video', onVideo);
      active.cleanup.push(() => media?.off('video', onVideo));

      const a = request.audio;
      active.audio = this.spawnProcess('audio', audioArgs({ sampleRate: a.sample_rate, bitrate: a.max_bit_rate, pt: a.pt, ssrc: p.audioSsrc, srtp: p.audioSrtp, address: p.address, port: p.audioPort }));
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
    socket.on('message', armInactivity);
    armInactivity();
    socket.bind(p.videoReturnPort);
    active.socket = socket;
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
      pending = Buffer.concat([pending, d]);
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
