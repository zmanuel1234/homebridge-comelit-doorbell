import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';
import { CameraAccessory } from './accessories/cameraAccessory';
import { DoorbellAccessory } from './accessories/doorbellAccessory';
import { LockAccessory } from './accessories/lockAccessory';
import { authenticate } from './auth';
import { CallHandler } from './call';
import { DoorbellCamera } from './camera';
import { ChannelType } from './channels';
import { IconaBridgeClient } from './client';
import { ComelitPlatformConfig, resolveSettings, Settings } from './config';
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
    api.on('didFinishLaunching', () => {
      this.setupDevice().catch((e) => this.log.error(`Initial setup failed: ${(e as Error).message}`));
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
    });
    try {
      await client.connect();
    } catch (e) {
      this.log.error(`Connection failed: ${(e as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    try {
      await authenticate(client, s.token);
      this.log.info('Authenticated');
    } catch (e) {
      this.log.error(`Authentication failed: ${(e as Error).message}`);
      await client.disconnect();
      this.scheduleReconnect();
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
      this.scheduleReconnect();
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
    client.setDisconnectCallback(() => this.onClientDisconnect());
    if (s.enableNotifications) {
      try {
        await this.openCtppChannels(client, deviceConfig);
        this.log.info('CTPP channels open for VIP events');
      } catch (e) {
        this.log.warn(`CTPP setup failed (notifications disabled): ${(e as Error).message}`);
      }
    }
    if (!client.connected) {
      return; // closed during the CTPP setup; the reconnect is already scheduled
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
    this.stopKeepalive();
    clearTimeout(this.reconnectTimer);
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.callHandler = undefined;
    this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
  }

  private onClientDisconnect(): void {
    this.log.warn('Device disconnected — scheduling reconnect');
    this.stopKeepalive();
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.callHandler = undefined;
    this.client = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.log.info(`Reconnecting in ${this.settings.reconnectDelayMs / 1000} s …`);
    this.reconnectTimer = setTimeout(() => {
      this.setupDevice().catch((e) => this.log.error(`Reconnect failed: ${(e as Error).message}`));
    }, this.settings.reconnectDelayMs);
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
