import type { PlatformConfig } from 'homebridge';
import type { AnswerMode } from './call';
import { DEFAULT_RECONNECT_DELAY_S, ICONA_BRIDGE_PORT } from './settings';

/** The plugin's block in config.json (see config.schema.json). */
export interface ComelitPlatformConfig extends PlatformConfig {
  host?: string;
  port?: number;
  token?: string;
  subaddress?: number;
  enableNotifications?: boolean;
  reconnectDelay?: number;
  leaseRefreshMode?: string;
  leaseRefreshMinutes?: number;
  leaseRecycleMinutes?: number;
  ringWindowSeconds?: number | string | null;
  doorbellTriggerUrl?: string;
  registerPush?: boolean;
  answerMode?: string;
  camera?: boolean;
  talkBack?: boolean;
  videoQuality?: string;
  videoCodec?: string;
  ffmpegPath?: string;
  snapshotImage?: string;
  mediaStartTimeoutSeconds?: number;
  mediaSilenceSeconds?: number;
  videoRefreshSeconds?: number;
  liveViewWaitSeconds?: number;
  lastVisitorMinutes?: number;
}

export const DEFAULT_DOORBELL_TRIGGER_URL = 'http://localhost:8089/doorbell?Doorbell';

/** Settings with defaults applied. */
export interface Settings {
  host: string;
  port: number;
  token: string;
  subaddress?: number;
  enableNotifications: boolean;
  reconnectDelayMs: number;
  leaseMode: 'reconnect' | 'inplace';
  leaseRefreshMs: number;
  leaseRecycleMs: number;
  /** 0 = unlocking allowed at any time. */
  ringWindowMs: number;
  /** Empty = no trigger. */
  doorbellTriggerUrl: string;
  registerPush: boolean;
  answerMode: AnswerMode;
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
}

const positive = (v: unknown, fallback: number): number => (Number(v) > 0 ? Number(v) : fallback);

export function resolveSettings(c: ComelitPlatformConfig): Settings {
  const ringWindow = c.ringWindowSeconds === undefined || c.ringWindowSeconds === null || c.ringWindowSeconds === '' ? 90 : Number(c.ringWindowSeconds);
  return {
    host: c.host ?? '',
    port: c.port ?? ICONA_BRIDGE_PORT,
    token: c.token ?? '',
    subaddress: Number.isInteger(c.subaddress) ? c.subaddress : undefined,
    enableNotifications: c.enableNotifications ?? true,
    reconnectDelayMs: (c.reconnectDelay ?? DEFAULT_RECONNECT_DELAY_S) * 1000,
    leaseMode: c.leaseRefreshMode === 'inplace' ? 'inplace' : 'reconnect',
    leaseRefreshMs: positive(c.leaseRefreshMinutes, 2) * 60_000,
    leaseRecycleMs: positive(c.leaseRecycleMinutes, 50) * 60_000,
    ringWindowMs: Number.isFinite(ringWindow) && ringWindow > 0 ? ringWindow * 1000 : 0,
    doorbellTriggerUrl: (c.doorbellTriggerUrl === undefined ? DEFAULT_DOORBELL_TRIGGER_URL : String(c.doorbellTriggerUrl)).trim(),
    registerPush: c.registerPush === true,
    answerMode: (['handshake', 'answer-on-open', 'answer-on-view'] as const).find((m) => m === c.answerMode) ?? 'off',
    camera: c.camera === true,
    talkBack: c.talkBack === true,
    videoQuality: c.videoQuality === 'hd' ? 'hd' : 'sd',
    videoCodec: (c.videoCodec ?? '').trim() || 'libx264',
    ffmpegPath: (c.ffmpegPath ?? '').trim(),
    snapshotImage: (c.snapshotImage ?? '').trim(),
    mediaStartTimeoutMs: positive(c.mediaStartTimeoutSeconds, 10) * 1000,
    mediaSilenceMs: positive(c.mediaSilenceSeconds, 5) * 1000,
    videoRefreshMs: positive(c.videoRefreshSeconds, 15) * 1000,
    liveViewWaitMs: positive(c.liveViewWaitSeconds, 8) * 1000,
    lastVisitorMs: (c.lastVisitorMinutes === undefined || c.lastVisitorMinutes === null ? 5 : Math.max(0, Number(c.lastVisitorMinutes) || 0)) * 60_000,
  };
}

/** Settings that don't work together, as log warnings. */
export function settingsWarnings(s: Settings): string[] {
  const w: string[] = [];
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
