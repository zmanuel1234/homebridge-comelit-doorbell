/** Name the platform is configured under in config.json. Unchanged from homebridge-comelit-intercom. */
export const PLATFORM_NAME = 'ComelitIntercom';
export const PLUGIN_NAME = 'homebridge-comelit-doorbell';
/**
 * Accessory UUIDs keep the original plugin name as their seed, so HomeKit keeps the same
 * accessories (rooms, automations) when moving from homebridge-comelit-intercom.
 */
export const UUID_SEED = 'homebridge-comelit-intercom';

export const ICONA_BRIDGE_PORT = 64100;
export const CONNECT_TIMEOUT_MS = 10_000;
export const READ_TIMEOUT_MS = 30_000;
export const DEAD_CONNECTION_TIMEOUT_MS = 120_000;
export const KEEPALIVE_INTERVAL_MS = 90_000;
export const DEFAULT_RECONNECT_DELAY_S = 10;
/** A planned reconnect (registration refresh) waits at most this long, so rings aren't missed in the gap. */
export const PLANNED_RECONNECT_DELAY_MS = 2_000;
