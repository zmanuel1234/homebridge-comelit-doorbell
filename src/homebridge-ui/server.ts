// The server side of the setup assistant in the plugin's settings. It runs only while the
// settings are open, in its own process, and only reads: it never changes the intercom.
import path from 'node:path';
import { createRequire } from 'node:module';
import * as setup from '../setup.js';
import * as events from '../events.js';
import * as backup from '../backup.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function start(): Promise<void> {
  // Loaded here, so that a failure (such as a missing package) is reported in one line below.
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      // body.host: the IP address already in the settings, if any (also asked directly).
      this.onRequest('/discover', async (body?: { host?: unknown }) => {
        try {
          const host = typeof body?.host === 'string' && /^[\d.]+$/.test(body.host.trim()) ? body.host.trim() : '';
          return await setup.discoverIntercoms(undefined, undefined, undefined, host ? [host] : []);
        } catch (e) {
          throw new RequestError(`Search failed: ${message(e)}`, {});
        }
      });
      // The config block as the settings form has it now (maybe not saved yet).
      this.onRequest('/test', async (config: unknown) => {
        if (!config || typeof config !== 'object') {
          throw new RequestError('No settings to test', {});
        }
        return setup.testConnection(config as Parameters<typeof setup.testConnection>[0], { pluginVersion: version });
      });
      // A backup file from the intercom (base64): its users with a token. Read here, not kept.
      this.onRequest('/backup', async (body?: { data?: unknown }) => {
        const data = typeof body?.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.alloc(0);
        try {
          return backup.readBackup(data);
        } catch (e) {
          throw new RequestError(message(e), {});
        }
      });
      // Recent events, as the plugin keeps them in Homebridge's storage folder (newest first).
      // body.name: the intercom's name in the settings (each intercom has its own file).
      this.onRequest('/events', async (body?: { name?: unknown }) => {
        const dir = this.homebridgeStoragePath;
        if (!dir) {
          return { events: [], note: "Homebridge didn't give its storage folder." };
        }
        return { events: events.describeEvents(events.readEvents(path.join(dir, events.eventsFileFor(body?.name)))) };
      });
      this.ready();
    }
  }

  new UiServer();
}

start().catch((e: unknown) => {
  process.stderr.write(`[${path.basename(import.meta.dirname)}] ${message(e)}\n`);
  process.exit(1);
});
