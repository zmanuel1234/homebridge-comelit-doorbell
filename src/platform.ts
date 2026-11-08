import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';
import { CameraAccessory } from './accessories/cameraAccessory';
import { DoorbellAccessory } from './accessories/doorbellAccessory';
import { LockAccessory } from './accessories/lockAccessory';
import { authenticate } from './auth';
import { CallHandler } from './call';
import { DoorbellCamera } from './camera';
import { ChannelType } from './channels';
import { IconaBridgeClient } from './client';
import { ComelitPlatformConfig, reconnectDelay, resolveSettings, Settings, settingsWarnings } from './config';
import { getDeviceConfig } from './configReader';
import { ctppInitSequence } from './ctpp';
import { openDoor } from './door';
import type { DeviceConfig, Door, IntercomEvent, OpenResult } from './models';
import { encodeCtppInit } from './protocol';
import { registerPush, sendPushKeepalive } from './push';
import { KEEPALIVE_INTERVAL_MS, PLATFORM_NAME, PLUGIN_NAME, UUID_SEED } from './settings';
import { VipEventListener } from './vipListener';

export class ComelitIntercomPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly settings: Settings;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly lockAccessories = new Map<string, LockAccessory>();
  private doorbellAccessory?: DoorbellAccessory;
  private client?: IconaBridgeClient;
  private deviceConfig?: DeviceConfig;
  private vipListener?: VipEventListener;
  private callHandler?: CallHandler;
  private keepaliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  /** Failed connection attempts in a row, for the back-off. */
  private failures = 0;
  private shuttingDown = false;
  /** Doors and cameras the accessories were last built from, to skip rebuilding them on every reconnect. */
  private builtFrom?: string;
  private lastRingAt = 0;
  private camera?: DoorbellCamera;
  private cameraConfigured = false;
  private readonly displayName: string;

  constructor(
    readonly log: Logging,
    config: ComelitPlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.settings = resolveSettings(config);
    this.displayName = config.name || 'Comelit Doorbell';
    for (const w of settingsWarnings(this.settings)) {
      this.log.warn(w);
    }
    const s = this.settings;
    this.log.info(
      `Settings: ${s.host || '(no host)'}:${s.port}, user row ${s.subaddress ?? 'from the intercom'}, refresh ${s.leaseMode} every ${s.leaseRefreshMs / 60_000} min, ` +
        `unlock ${s.ringWindowMs ? `within ${s.ringWindowMs / 1000} s of a ring` : 'at any time'}, answerMode ${s.answerMode}, camera ${s.camera ? 'on' : 'off'}` +
        `${s.doorbellTriggerUrl ? ', trigger URL set' : ''}`,
    );
    if (this.settings.camera && this.settings.answerMode !== 'answer-on-view') {
      this.log.info("Doorbell camera: live video needs answerMode 'answer-on-view'; until then it shows the picture.");
    }
    api.on('didFinishLaunching', () => {
      this.setupDevice().catch((e) => this.onSetupError('Initial setup', e));
    });
    api.on('shutdown', () => this.teardown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  /** Whether HomeKit may unlock now: within the ring window, or always if the window is 0. */
  isUnlockAllowed(): boolean {
    const windowMs = this.settings.ringWindowMs;
    return windowMs === 0 || Date.now() - this.lastRingAt <= windowMs;
  }

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  private async setupDevice(): Promise<void> {
    const s = this.settings;
    if (this.shuttingDown) {
      return;
    }
    if (!s.host || !s.token) {
      this.log.error('Missing required config: host and token are required');
      return;
    }
    this.log.info(`Connecting to ${s.host}:${s.port} …`);
    const client: IconaBridgeClient = new IconaBridgeClient(s.host, s.port, this.log, {
      intervalMs: s.leaseRefreshMs,
      mode: s.leaseMode,
      recycleMs: s.leaseRecycleMs,
      reregister: (): Promise<void> => this.reregister(client),
      isBusy: () => this.callHandler?.busy() ?? false,
    });
    try {
      await client.connect();
    } catch (e) {
      this.log.error(`Connection failed: ${(e as Error).message}`);
      this.scheduleReconnect(true);
      return;
    }
    try {
      await authenticate(client, s.token);
      this.log.info('Authenticated');
    } catch (e) {
      this.log.error(`Authentication failed: ${(e as Error).message}`);
      await client.disconnect();
      this.scheduleReconnect(true);
      return;
    }
    let deviceConfig: DeviceConfig;
    try {
      deviceConfig = await getDeviceConfig(client);
      if (s.subaddress !== undefined) {
        // Register as our own Comelit user, so calls aren't shared with a phone.
        deviceConfig.aptSubaddress = s.subaddress;
      }
      this.log.info(`Device config: ${deviceConfig.doors.length} door(s), apt=${deviceConfig.aptAddress}${deviceConfig.aptSubaddress}`);
    } catch (e) {
      this.log.error(`Config fetch failed: ${(e as Error).message}`);
      await client.disconnect();
      this.scheduleReconnect(true);
      return;
    }
    try {
      await registerPush(client, deviceConfig, s.registerPush, (event) => this.onEvent(event));
    } catch (e) {
      this.log.warn(`Push registration failed (non-fatal): ${(e as Error).message}`);
    }
    // Set the client and disconnect callback before the CTPP setup, so a drop during it
    // still triggers the reconnect.
    this.client = client;
    this.deviceConfig = deviceConfig;
    client.setDisconnectCallback((planned) => this.onClientDisconnect(planned));
    // Rings arrive on CTPP: if the intercom closes it, nothing would ring until the next
    // reconnect (up to leaseRecycleMinutes in inplace mode), so reconnect now.
    client.on('channelClosed', (name: string) => {
      if (name === 'CTPP' && this.client === client) {
        client.drop('the intercom closed the ring channel (CTPP)');
      }
    });
    if (s.enableNotifications) {
      try {
        await this.openCtppChannels(client, deviceConfig);
        this.log.info('CTPP channels open for VIP events');
      } catch (e) {
        this.log.warn(`CTPP setup failed (notifications disabled): ${(e as Error).message}`);
      }
    }
    if (!client.connected) {
      // Closed during the setup. If it closed before the disconnect callback was set, nothing
      // has scheduled a reconnect yet; scheduling again only restarts the timer.
      this.client = undefined;
      this.scheduleReconnect(true);
      return;
    }
    if (s.enableNotifications && client.getChannel('CTPP')) {
      const ourAddress = `${deviceConfig.aptAddress}${deviceConfig.aptSubaddress}`;
      let listener: VipEventListener | undefined = undefined;
      const call = new CallHandler(s.answerMode, ourAddress, deviceConfig.aptAddress, (frame) => listener!.sendFrame(frame), this.log, {
        startTimeoutMs: s.mediaStartTimeoutMs,
        silenceMs: s.mediaSilenceMs,
        videoRefreshMs: s.videoRefreshMs,
      });
      listener = new VipEventListener(client, deviceConfig, (ev) => this.onEvent(ev), this.log, call);
      call.attach(client);
      this.callHandler = call;
      this.vipListener = listener;
      await listener.start().catch((e) => this.log.warn(`VIP listener start failed: ${(e as Error).message}`));
    }
    this.startKeepalive(deviceConfig);
    this.discoverAccessories(deviceConfig);
    this.failures = 0;
    this.log.info('Comelit Intercom ready');
  }

  private async openCtppChannels(client: IconaBridgeClient, config: DeviceConfig): Promise<void> {
    const ourAddr = `${config.aptAddress}${config.aptSubaddress}`;
    // The VIP CTPP channel is opened with the UAUT channel type.
    await client.openChannel('CTPP', ChannelType.UAUT, ourAddr);
    await client.openChannel('CSPB', ChannelType.UAUT);
    const ctpp = client.getChannel('CTPP')!;
    await ctppInitSequence(client, ctpp, config.aptAddress, config.aptSubaddress, ourAddr, (Date.now() / 1000) | 0, 2_000, this.log);
  }

  /** Re-sends the registration on the open connection (lease mode `inplace`). */
  private async reregister(client: IconaBridgeClient): Promise<void> {
    const ch = client.getChannel('CTPP');
    const cfg = this.deviceConfig;
    if (!ch || !cfg) {
      throw new Error('CTPP channel not open');
    }
    await client.sendBinary(ch, encodeCtppInit(cfg.aptAddress, cfg.aptSubaddress, (Date.now() / 1000) | 0));
    this.log.info('Registration renewed in place');
  }

  private teardown(): void {
    this.shuttingDown = true;
    this.stopKeepalive();
    clearTimeout(this.reconnectTimer);
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.callHandler = undefined;
    this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
  }

  private onClientDisconnect(planned: boolean): void {
    if (planned) {
      this.log.debug('Reconnecting to refresh the registration');
    } else {
      this.log.warn('Device disconnected — scheduling reconnect');
    }
    this.stopKeepalive();
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.callHandler = undefined;
    this.client = undefined;
    this.scheduleReconnect(planned ? 'planned' : 'dropped');
  }

  /**
   * `planned`: a registration refresh, reconnect within 2 s. `dropped`: after reconnectDelay.
   * After a failed attempt the wait doubles each time, up to maxReconnectDelay.
   */
  private scheduleReconnect(why: 'planned' | 'dropped' | true): void {
    clearTimeout(this.reconnectTimer);
    if (this.shuttingDown) {
      return;
    }
    const failed = why === true;
    const delay = reconnectDelay(this.settings, why === 'planned' ? -1 : failed ? this.failures : 0);
    if (failed) {
      this.failures++;
    }
    this.log.info(`Reconnecting in ${delay / 1000} s …`);
    this.reconnectTimer = setTimeout(() => {
      this.setupDevice().catch((e) => this.onSetupError('Reconnect', e));
    }, delay);
  }

  /** An unexpected error while setting up: retry, unless the connection is up anyway. */
  private onSetupError(what: string, e: unknown): void {
    this.log.error(`${what} failed: ${(e as Error).message}`);
    if (!this.client?.connected) {
      this.scheduleReconnect(true);
    }
  }

  private startKeepalive(config: DeviceConfig): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(async () => {
      if (!this.client) {
        return;
      }
      try {
        await sendPushKeepalive(this.client, config, this.settings.registerPush);
      } catch (e) {
        this.log.warn(`Keepalive failed: ${(e as Error).message}`);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }

  // ─── Events and door ───────────────────────────────────────────────────────

  private onEvent(event: IntercomEvent): void {
    this.log.info(`Event: ${event.eventType} from ${event.aptAddress}`);
    if (event.eventType === 'doorbell_ring') {
      this.lastRingAt = Date.now();
      this.doorbellAccessory?.triggerRing();
      this.camera?.ring();
    }
  }

  async openDoor(door: Door): Promise<OpenResult> {
    if (!this.client || !this.deviceConfig) {
      throw new Error('Not connected');
    }
    return openDoor(this.client, this.deviceConfig, door, { listener: this.vipListener, call: this.callHandler, log: this.log });
  }

  // ─── Accessories ───────────────────────────────────────────────────────────

  /** Finds or creates the accessory for `seed`, registering it with Homebridge only once. */
  private accessoryFor(seed: string, name: string, keep: Set<string>, init?: (a: PlatformAccessory) => void): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`${UUID_SEED}-${seed}`);
    keep.add(uuid);
    const existing = this.accessories.get(uuid);
    if (existing) {
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory(name, uuid);
    init?.(accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(uuid, accessory);
    this.log.info(`Registered ${name}`);
    return accessory;
  }

  discoverAccessories(config: DeviceConfig): void {
    // The accessories only change if the intercom's doors or cameras do; rebuilding them on
    // every reconnect would rewrite Homebridge's accessory cache each time.
    const from = JSON.stringify([config.doors, config.cameras, this.settings.camera]);
    if (from === this.builtFrom) {
      return;
    }
    this.builtFrom = from;
    const keep = new Set<string>();
    for (const door of config.doors) {
      const accessory = this.accessoryFor(`lock-${door.index}`, door.name || `Door ${door.index + 1}`, keep, (a) => {
        a.context.door = door;
      });
      this.lockAccessories.set(accessory.UUID, new LockAccessory(this, accessory, door));
    }
    const bell = this.accessoryFor('doorbell', this.displayName, keep);
    this.doorbellAccessory = new DoorbellAccessory(this, bell);
    if (this.settings.camera) {
      // Experimental doorbell camera, as an accessory of its own so turning it off removes it cleanly.
      if (!this.camera) {
        this.camera = new DoorbellCamera(this.api, this.log, this.settings, () => this.callHandler);
      }
      const controller = this.camera.controller;
      // A new accessory gets the controller before it is registered; a cached one, once.
      const cam = this.accessoryFor('doorbell-camera', `${this.displayName} Camera`, keep, (a) => {
        a.configureController(controller);
        this.cameraConfigured = true;
      });
      if (!this.cameraConfigured) {
        cam.configureController(controller);
        this.cameraConfigured = true;
      }
    }
    for (const camera of config.cameras) {
      const accessory = this.accessoryFor(`camera-${camera.id}`, camera.name || `Camera ${camera.id}`, keep, (a) => {
        a.context.camera = camera;
      });
      new CameraAccessory(this, accessory, camera);
    }
    const stale = [...this.accessories.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.accessories.delete(a.UUID);
      }
      this.log.info(`Removed ${stale.length} stale accessory/accessories`);
    }
  }
}
