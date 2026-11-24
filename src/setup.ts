/**
 * The setup assistant in the plugin's settings (homebridge-ui/): finding the intercom on the
 * network, testing a configuration step by step, and a diagnostics report with the secrets
 * removed. Read-only: it never changes anything on the intercom.
 */
import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import { authenticate } from './auth';
import { resolveFfmpeg } from './camera';
import { ChannelType, ViperMessageId } from './channels';
import { IconaBridgeClient } from './client';
import { type ComelitPlatformConfig, resolveSettings, settingsWarnings } from './config';
import type { JsonMessage } from './protocol';

/** The UDP port Comelit devices answer an `INFO` search on. */
export const DISCOVERY_PORT = 24199;

export interface FoundIntercom {
  /** IP address it answered from. */
  host: string;
  /** Its ViP address, e.g. SB100001. */
  address: string;
  /** Firmware version, e.g. 2.1.0, if the answer had one. */
  firmware: string;
  /** Model code, e.g. MSVU, if the answer had one. */
  model: string;
}

/**
 * Reads a device's answer to the `INFO` search: `info`, its 8-character ViP address, then binary
 * fields (MAC address, flags), its firmware version as text and its model code near the end.
 */
export function parseDiscoveryReply(msg: Buffer, host: string): FoundIntercom | null {
  if (msg.length < 12 || msg.subarray(0, 4).toString('latin1').toLowerCase() !== 'info') {
    return null;
  }
  const text = msg.toString('latin1');
  const address = msg.subarray(4, 12).toString('latin1').replace(/[^\x21-\x7e]/g, '');
  const firmware = /\b\d+\.\d+\.\d+\b/.exec(text.slice(12))?.[0] ?? '';
  // The model code is the first word after the `ViP_` marker (MSVU on the author's kit).
  const marker = text.indexOf('ViP_');
  const model = marker >= 0 ? (/[A-Z][A-Z0-9]{2,11}/.exec(text.slice(marker + 4))?.[0] ?? '') : '';
  return { host, address, firmware, model };
}

/** Searches the network for Comelit devices: broadcasts `INFO` and collects the answers. */
export function discoverIntercoms(
  timeoutMs = 3000,
  target = '255.255.255.255',
  port = DISCOVERY_PORT,
): Promise<FoundIntercom[]> {
  return new Promise((resolve) => {
    const found = new Map<string, FoundIntercom>();
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('message', (msg, rinfo) => {
      const device = parseDiscoveryReply(msg, rinfo.address);
      if (device && !found.has(device.host)) {
        found.set(device.host, device);
      }
    });
    socket.on('error', finish);
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        // not needed for a unicast target
      }
      socket.send(Buffer.from('INFO'), port, target, (e) => {
        if (e) {
          finish();
        }
      });
    });
  });
}

export interface TestStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TestResult {
  steps: TestStep[];
  /** The ViP user row (sub-address) the token belongs to, as the intercom reports it. */
  subaddress?: number;
  doors: { name: string; kind: 'door' | 'actuator' }[];
  cameras: string[];
  /** A report to paste into an issue: no token, passwords, serial or MAC addresses. */
  diagnostics: string;
}

// Secret fields: tokens, passwords, codes, keys, serial and MAC addresses, ids, and any URL (an
// RTSP address can hold a password, a webhook a key). Not `videoCodec` or `virtual-key-enabled`.
const SECRET = /token|pass|pwd|(^|[-_])code$|activation|pin$|key|secret|user(name)?$|serial|mac|url|uuid|imei|email/i;

/** Replaces secrets in the intercom's answers (tokens, passwords, serial and MAC addresses). */
export function redact(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) {
    // A list's items are as secret as the list (e.g. several MAC addresses).
    return v.map((x) => redact(x, key));
  }
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redact(x, k)]));
  }
  if (key !== 'response-code' && SECRET.test(key) && v !== '' && typeof v !== 'boolean') {
    return '<removed>';
  }
  return v;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

function ffmpegVersion(ffmpeg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, ['-hide_banner', '-version'], { timeout: 10_000 }, (e, stdout) => {
      if (e) {
        reject(e);
      } else {
        resolve(/ffmpeg version (\S+)/.exec(stdout)?.[1] ?? 'unknown version');
      }
    });
  });
}

const silent = { info() {}, warn() {}, error() {}, debug() {}, success() {}, log() {}, prefix: '' };

export interface TestOptions {
  pluginVersion?: string;
  /** Skips the ffmpeg check (tests). */
  skipFfmpeg?: boolean;
}

/**
 * Tests a configuration step by step: the settings, reaching the intercom, the token, the
 * intercom's information and configuration (doors, cameras, the token's user row) and ffmpeg.
 * Stops at the first step a later one depends on. Never throws.
 */
export async function testConnection(config: ComelitPlatformConfig, opts: TestOptions = {}): Promise<TestResult> {
  const steps: TestStep[] = [];
  const result: TestResult = { steps, doors: [], cameras: [], diagnostics: '' };
  const report: Record<string, unknown> = {
    plugin: opts.pluginVersion ?? '',
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    settings: { ...(redact(config) as object), token: config.token ? '<set>' : '<empty>' },
  };
  const finish = (): TestResult => {
    report.steps = steps;
    result.diagnostics = JSON.stringify(report, null, 1);
    return result;
  };

  const s = resolveSettings(config);
  const warnings = [...s.invalid, ...settingsWarnings(s)];
  if (!s.host || !s.token) {
    steps.push({ name: 'Settings', ok: false, detail: !s.host ? 'Enter the intercom IP address (or use Find my intercom).' : 'Enter the user token.' });
    return finish();
  }
  steps.push({ name: 'Settings', ok: warnings.length === 0, detail: warnings.length ? warnings.join(' ') : 'No problems found.' });

  const client = new IconaBridgeClient(s.host, s.port, silent as never);
  try {
    try {
      await client.connect();
      steps.push({ name: 'Reach the intercom', ok: true, detail: `Connected to ${s.host}:${s.port}.` });
    } catch (e) {
      steps.push({
        name: 'Reach the intercom',
        ok: false,
        detail: `Can't connect to ${s.host}:${s.port} (${(e as Error).message}). Check the IP address, and that Homebridge is on the same network.`,
      });
      return finish();
    }
    try {
      await authenticate(client, s.token);
      steps.push({ name: 'Token', ok: true, detail: 'The intercom accepted the token.' });
    } catch (e) {
      steps.push({
        name: 'Token',
        ok: false,
        detail: `The intercom refused the token (${(e as Error).message}). Check it was copied whole, and that its user was activated once and not deleted.`,
      });
      return finish();
    }
    try {
      const info = await client.sendJson(await client.openChannel('INFO', ChannelType.INFO), {
        message: 'server-info',
        'message-type': 'request',
        'message-id': ViperMessageId.SERVER_INFO,
      });
      report.serverInfo = redact(info);
      const model = typeof info.model === 'string' ? info.model : '?';
      const version = typeof info.version === 'string' ? info.version : '?';
      steps.push({ name: 'Intercom', ok: true, detail: `Model ${model}, firmware ${version}.` });
    } catch (e) {
      // Not needed for the plugin: note it and go on.
      steps.push({ name: 'Intercom', ok: true, detail: `No information (${(e as Error).message}); not needed.` });
    }
    let conf: JsonMessage;
    try {
      conf = await client.sendJson(await client.openChannel('UCFG', ChannelType.UCFG), {
        message: 'get-configuration',
        addressbooks: 'all',
        'message-type': 'request',
        'message-id': ViperMessageId.UCFG,
      });
      if (conf['response-code'] !== 200) {
        throw new Error(`code ${String(conf['response-code'])}`);
      }
    } catch (e) {
      steps.push({ name: 'Configuration', ok: false, detail: `The intercom didn't send its configuration (${(e as Error).message}).` });
      return finish();
    }
    report.configuration = redact(conf);
    const vip = (conf.vip ?? {}) as Record<string, unknown>;
    const up = (vip['user-parameters'] ?? {}) as Record<string, unknown>;
    result.doors = [
      ...list(up['opendoor-address-book']).map((d) => ({ name: String(d.name ?? ''), kind: 'door' as const })),
      ...list(up['actuator-address-book']).map((d) => ({ name: String(d.name ?? ''), kind: 'actuator' as const })),
    ];
    result.cameras = list(up['rtsp-camera-address-book']).map((c) => String(c.name ?? ''));
    const entrances = list(up['entrance-address-book']).length;
    const row = typeof vip['apt-subaddress'] === 'number' ? vip['apt-subaddress'] : undefined;
    result.subaddress = row;
    const parts = [
      `${result.doors.length} door${result.doors.length === 1 ? '' : 's'}${result.doors.length ? ` (${result.doors.map((d) => (d.kind === 'actuator' ? `${d.name} [actuator]` : d.name)).join(', ')})` : ''}`,
      `${entrances} entrance panel${entrances === 1 ? '' : 's'}`,
    ];
    if (result.cameras.length) {
      parts.push(`${result.cameras.length} extra camera${result.cameras.length === 1 ? '' : 's'}`);
    }
    steps.push({ name: 'Configuration', ok: result.doors.length > 0, detail: `${parts.join(', ')}.${result.doors.length ? '' : ' No doors to open.'}` });
    if (row !== undefined) {
      // Optional in the settings: left empty, the plugin takes it from the intercom.
      const blank = config.subaddress === undefined || config.subaddress === null || String(config.subaddress).trim() === '';
      const same = !blank && Number(config.subaddress) === row;
      steps.push({
        name: 'User row (sub-address)',
        ok: blank || same,
        detail: blank
          ? `${row}, from the intercom (the setting is empty, which is fine).`
          : same
            ? `${row}, as in the settings.`
            : `The token belongs to user row ${row}, but the settings say ${String(config.subaddress)}. Use ${row}.`,
      });
    }
    if (entrances === 0) {
      steps.push({ name: 'Entrance panel', ok: false, detail: 'The intercom lists no entrance panel: rings and the camera need one.' });
    }
  } finally {
    await client.disconnect().catch(() => undefined);
  }

  if (s.camera && !opts.skipFfmpeg) {
    const ffmpeg = resolveFfmpeg(s.ffmpegPath);
    try {
      steps.push({ name: 'ffmpeg (camera)', ok: true, detail: `${ffmpeg}: ${await ffmpegVersion(ffmpeg)}.` });
    } catch (e) {
      steps.push({
        name: 'ffmpeg (camera)',
        ok: false,
        detail: `Can't run ${ffmpeg} (${(e as Error).message}). The camera needs ffmpeg: install ffmpeg-for-homebridge or set the ffmpeg path.`,
      });
    }
  }
  return finish();
}
