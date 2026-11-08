"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_DOORBELL_TRIGGER_URL = void 0;
exports.resolveSettings = resolveSettings;
const settings_1 = require("./settings");
exports.DEFAULT_DOORBELL_TRIGGER_URL = 'http://localhost:8089/doorbell?Doorbell';
const positive = (v, fallback) => (Number(v) > 0 ? Number(v) : fallback);
function resolveSettings(c) {
    const ringWindow = c.ringWindowSeconds === undefined || c.ringWindowSeconds === null || c.ringWindowSeconds === '' ? 90 : Number(c.ringWindowSeconds);
    return {
        host: c.host ?? '',
        port: c.port ?? settings_1.ICONA_BRIDGE_PORT,
        token: c.token ?? '',
        subaddress: Number.isInteger(c.subaddress) ? c.subaddress : undefined,
        enableNotifications: c.enableNotifications ?? true,
        reconnectDelayMs: (c.reconnectDelay ?? settings_1.DEFAULT_RECONNECT_DELAY_S) * 1000,
        leaseMode: c.leaseRefreshMode === 'inplace' ? 'inplace' : 'reconnect',
        leaseRefreshMs: positive(c.leaseRefreshMinutes, 2) * 60_000,
        leaseRecycleMs: positive(c.leaseRecycleMinutes, 50) * 60_000,
        ringWindowMs: Number.isFinite(ringWindow) && ringWindow > 0 ? ringWindow * 1000 : 0,
        doorbellTriggerUrl: (c.doorbellTriggerUrl === undefined ? exports.DEFAULT_DOORBELL_TRIGGER_URL : String(c.doorbellTriggerUrl)).trim(),
        registerPush: c.registerPush === true,
        answerMode: c.answerMode === 'handshake' || c.answerMode === 'answer-on-open' ? c.answerMode : 'off',
    };
}
//# sourceMappingURL=config.js.map