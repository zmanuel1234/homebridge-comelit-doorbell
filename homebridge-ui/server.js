// The server side of the setup assistant in the plugin's settings. It runs only while the
// settings are open, in its own process, and only reads: it never changes the intercom.
const path = require('node:path');
const setup = require('../dist/setup.js');
const { version } = require('../package.json');

(async () => {
  // plugin-ui-utils is an ES module.
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      // body.host: the IP address already in the settings, if any (also asked directly).
      this.onRequest('/discover', async (body) => {
        try {
          const host = typeof body?.host === 'string' && /^[\d.]+$/.test(body.host.trim()) ? body.host.trim() : '';
          return await setup.discoverIntercoms(undefined, undefined, undefined, host ? [host] : []);
        } catch (e) {
          throw new RequestError(`Search failed: ${e.message}`, {});
        }
      });
      // The config block as the settings form has it now (maybe not saved yet).
      this.onRequest('/test', async (config) => {
        if (!config || typeof config !== 'object') {
          throw new RequestError('No settings to test', {});
        }
        return setup.testConnection(config, { pluginVersion: version });
      });
      this.ready();
    }
  }

  new UiServer();
})().catch((e) => {
  console.error(`[${path.basename(__dirname)}] ${e.message}`);
  process.exit(1);
});
