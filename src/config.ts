import type { PlatformConfig } from 'homebridge';
import type { AnswerMode } from './call';

export type DoctorMode = 'off' | 'switch' | 'always';
import { DEFAULT_RECONNECT_DELAY_S, ICONA_BRIDGE_PORT, PLANNED_RECONNECT_DELAY_MS } from './settings';

/** The plugin's block in config.json (see config.schema.json). */
export interface ComelitPlatformConfig extends PlatformConfig {
  host?: string;
  port?: number | string;
  token?: string;
  subaddress?: number | string;
  enableNotifications?: boolean;
  reconnectDelay?: number | string;
  leaseRefreshMode?: string;
  leaseRefreshMinutes?: number;
  leaseRecycleMinutes?: number;
  ringWindowSeconds?: number | string | null;
  doorbellTriggerUrl?: string;
  registerPush?: boolean;
  answerMode?: string;
  doctorMode?: string;
  doctorModeDelaySeconds?: number | string;
  camera?: boolean;
  talkBack?: boolean;
  videoQuality?: string;
  videoCodec?: string;
  ffmpegPath?: string;
  snapshotImage?: string;
  mediaCaptureDir?: string;
  mediaStartTimeoutSeconds?: number;
  mediaSilenceSeconds?: number;
  videoRefreshSeconds?: number;
  liveViewWaitSeconds?: number;
  maxReconnectDelay?: number;
  lastVisitorMinutes?: number;
}

/** Settings with defaults applied. */
export interface Settings {
  host: string;
  port: number;
  token: string;
  subaddress?: number;
  enableNotifications: boolean;
  reconnectDelayMs: number;
  /** Longest wait between reconnect attempts while the intercom can't be reached. */
  maxReconnectDelayMs: number;
  leaseMode: 'reconnect' | 'inplace';
  leaseRefreshMs: number;
  leaseRecycleMs: number;
  /** 0 = unlocking allowed at any time. */
  ringWindowMs: number;
  /** Empty = no trigger. */
  doorbellTriggerUrl: string;
  registerPush: boolean;
  answerMode: AnswerMode;
  /** Open the door by itself on every ring: never, always, or while a HomeKit switch is on. */
  doctorMode: DoctorMode;
  doctorModeDelayMs: number;
  /** Experimental: a doorbell camera with the intercom's video. */
  camera: boolean;
  talkBack: boolean;
  videoQuality: 'sd' | 'hd';
  /** ffmpeg video encoder for the camera (`copy` passes the intercom's H.264 through). */
  videoCodec: string;
  /** Empty: ffmpeg-for-homebridge if installed, else `ffmpeg` from PATH. */
  ffmpegPath: string;
  /** Image shown when there is no call; empty: a plain dark picture. */
  snapshotImage: string;
  /** If set, each call's raw video and audio are saved here, for troubleshooting. */
  mediaCaptureDir: string;
  /** Hang up if no video or audio arrives this long after answering. */
  mediaStartTimeoutMs: number;
  /** Treat the call as over when media stops for this long. */
  mediaSilenceMs: number;
  /** Repeat the video request this often (the intercom stops sending after ~35 s otherwise). */
  videoRefreshMs: number;
  /** Longest wait for the intercom's media when a live view opens, before showing the picture. */
  liveViewWaitMs: number;
  /** After a call, show the last visitor this long, then the idle picture (0 = never). */
  lastVisitorMs: number;
  /** Values that were not valid and were replaced by their default, for the startup log. */
  invalid: string[];
}

const positive = (v: unknown, fallback: number): number => (Number(v) > 0 ? Number(v) : fallback);

const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

export function resolveSettings(c: ComelitPlatformConfig): Settings {
  const invalid: string[] = [];
  /** A number from the config (numbers typed as text are accepted), or the fallback if it isn't valid. */
  const num = (key: keyof ComelitPlatformConfig, fallback: number, ok: (n: number) => boolean): number => {
    const v = c[key];
    if (!isSet(v)) {
      return fallback;
    }
    const n = Number(v);
    if (Number.isFinite(n) && ok(n)) {
      return n;
    }
    invalid.push(`${String(key)}: ${JSON.stringify(v)} is not valid, using ${fallback}`);
    return fallback;
  };
  // Fails closed: only an explicit 0 allows unlocking at any time; anything invalid keeps the 90 s window.
  const ringWindow = num('ringWindowSeconds', 90, (n) => n >= 0);
  const subaddress = isSet(c.subaddress) ? num('subaddress', NaN, (n) => Number.isInteger(n) && n >= 0) : NaN;
  return {
    host: String(c.host ?? '').trim(),
    port: num('port', ICONA_BRIDGE_PORT, (n) => Number.isInteger(n) && n > 0 && n < 65536),
    token: String(c.token ?? '').trim(),
    subaddress: Number.isNaN(subaddress) ? undefined : subaddress,
    enableNotifications: c.enableNotifications ?? true,
    reconnectDelayMs: num('reconnectDelay', DEFAULT_RECONNECT_DELAY_S, (n) => n >= 1) * 1000,
    maxReconnectDelayMs: positive(c.maxReconnectDelay, 300) * 1000,
    leaseMode: c.leaseRefreshMode === 'inplace' ? 'inplace' : 'reconnect',
    leaseRefreshMs: positive(c.leaseRefreshMinutes, 2) * 60_000,
    leaseRecycleMs: positive(c.leaseRecycleMinutes, 50) * 60_000,
    ringWindowMs: ringWindow * 1000,
    doorbellTriggerUrl: String(c.doorbellTriggerUrl ?? '').trim(),
    registerPush: c.registerPush === true,
    answerMode: (['handshake', 'answer-on-open', 'answer-on-view'] as const).find((m) => m === c.answerMode) ?? 'off',
    doctorMode: (['switch', 'always'] as const).find((m) => m === c.doctorMode) ?? 'off',
    doctorModeDelayMs: num('doctorModeDelaySeconds', 2, (n) => n >= 0 && n <= 30) * 1000,
    camera: c.camera === true,
    talkBack: c.talkBack === true,
    videoQuality: c.videoQuality === 'hd' ? 'hd' : 'sd',
    videoCodec: (c.videoCodec ?? '').trim() || 'libx264',
    ffmpegPath: (c.ffmpegPath ?? '').trim(),
    snapshotImage: (c.snapshotImage ?? '').trim(),
    mediaCaptureDir: String(c.mediaCaptureDir ?? '').trim(),
    mediaStartTimeoutMs: positive(c.mediaStartTimeoutSeconds, 10) * 1000,
    mediaSilenceMs: positive(c.mediaSilenceSeconds, 5) * 1000,
    videoRefreshMs: positive(c.videoRefreshSeconds, 15) * 1000,
    liveViewWaitMs: positive(c.liveViewWaitSeconds, 8) * 1000,
    lastVisitorMs: (c.lastVisitorMinutes === undefined || c.lastVisitorMinutes === null ? 5 : Math.max(0, Number(c.lastVisitorMinutes) || 0)) * 60_000,
    invalid,
  };
}

/**
 * Wait before reconnect attempt number `failures` (0 = first): the reconnect delay, doubled after
 * each failed attempt, up to the maximum. -1 is a planned reconnect (registration refresh).
 */
export function reconnectDelay(s: Pick<Settings, 'reconnectDelayMs' | 'maxReconnectDelayMs'>, failures: number): number {
  if (failures < 0) {
    // A planned reconnect: keep the gap without a registration short.
    return Math.min(s.reconnectDelayMs, PLANNED_RECONNECT_DELAY_MS);
  }
  return Math.min(s.reconnectDelayMs * 2 ** Math.min(failures, 20), Math.max(s.maxReconnectDelayMs, s.reconnectDelayMs));
}

/** Settings that don't work together, as log warnings. */
export function settingsWarnings(s: Settings): string[] {
  const w: string[] = [...s.invalid];
  if (s.doctorMode !== 'off' && !s.enableNotifications) {
    w.push("doctorMode needs 'Listen for rings' (enableNotifications); without rings it never opens.");
  }
  if (s.answerMode === 'answer-on-view' && !s.camera) {
    w.push("answerMode 'answer-on-view' needs the doorbell camera (camera: true); without it nothing answers the ring.");
  }
  if (s.talkBack && !s.camera) {
    w.push('talkBack only works with the doorbell camera (camera: true).');
  }
  if (s.camera && s.doorbellTriggerUrl) {
    w.push('The doorbell camera rings in HomeKit by itself; with doorbellTriggerUrl set as well, each ring gives two notifications. Clear the trigger URL once the camera works.');
  }
  return w;
}
