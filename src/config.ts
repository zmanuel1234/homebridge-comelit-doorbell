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
    answerMode: c.answerMode === 'handshake' || c.answerMode === 'answer-on-open' ? c.answerMode : 'off',
  };
}
