import type { PlatformConfig } from 'homebridge';
import type { AnswerMode } from './call';
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
export declare const DEFAULT_DOORBELL_TRIGGER_URL = "http://localhost:8089/doorbell?Doorbell";
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
export declare function resolveSettings(c: ComelitPlatformConfig): Settings;
