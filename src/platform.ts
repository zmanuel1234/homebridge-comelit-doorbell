import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';
import { CameraAccessory } from './accessories/cameraAccessory';
import { DoctorModeSwitch } from './accessories/doctorModeSwitch';
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

/** How long the intercom must be unreachable before the lock shows No Response. */
export const UNREACHABLE_AFTER_MS = 30_000;

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
  private doctorPending = false;
  private doctorSwitch?: DoctorModeSwitch;
  /** Doors and cameras the accessories were last built from, to skip rebuilding them on every reconnect. */
  private builtFrom?: string;
  private lastRingAt = 0;
  /** Since when the intercom is not connected (from startup until the first connection); undefined while connected. */
  private downSince: number | undefined = Date.now();
  /** The last disconnect was a planned refresh: its reconnect is routine (debug log). */
  private plannedReconnect = false;
  /** Door opens on their way, so a planned reconnect waits for them. */
  private opening = 0;
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
    this.displayName = String(config.name ?? '').trim() || 'Comelit Intercom';
    for (const w of settingsWarnings(this.settings)) {
      this.log.warn(w);
    }
    if (this.settings.doctorMode === 'always') {
      this.log.warn('Doctor mode is ON: every ring opens the door, for anyone at the door');
    }
    const s = this.settings;
    this.log.info(
      `Settings: ${s.host || '(no host)'}:${s.port}, user row ${s.subaddress ?? 'from the intercom'}, ${s.enableNotifications ? `refresh ${s.leaseMode} every ${s.leaseRefreshMs / 60_000} min` : `rings off, reconnect every ${s.leaseRecycleMs / 60_000} min`}, ` +
        `unlock ${s.ringWindowMs ? `within ${s.ringWindowMs / 1000} s of a ring` : 'at any time'}, answerMode ${s.answerMode}, camera ${s.camera ? 'on' : 'off'}` +
        `${s.doorbellTriggerUrl ? ', trigger URL set' : ''}${s.doctorMode !== 'off' ? `, doctor mode ${s.doctorMode}` : ''}`,
    );
    if (this.settings.camera && this.settings.answerMode !== 'answer-on-view') {
      this.log.info("Doorbell camera: live video needs answerMode 'answer-on-view'; until then it shows the picture.");
    }
    api.on('didFinishLaunching', () => {
      this.restoreCached();
      this.setupDevice().catch((e) => this.onSetupError('Initial setup', e));
    });
    api.on('shutdown', () => this.teardown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Gives the cached accessories their handlers at startup, from the doors and cameras saved with
   * them, so they answer HomeKit (a tap says the intercom isn't connected) before the first
   * connection. The first connection rebuilds them only if the intercom's doors changed.
   */
  private restoreCached(): void {
    const cached = [...this.accessories.values()];
    const doors = cached.map((a) => a.context.door as Door | undefined).filter((d): d is Door => !!d).sort((a, b) => a.index - b.index);
    if (doors.length === 0) {
      return;
    }
    const cameras = cached.map((a) => a.context.camera as DeviceConfig['cameras'][number] | undefined).filter((c) => !!c);
    try {
      this.discoverAccessories({ doors, cameras } as unknown as DeviceConfig);
    } catch (e) {
      this.builtFrom = undefined;
      this.log.warn(`Restoring the cached accessories failed: ${(e as Error).message}`);
    }
  }

  /**
   * The intercom has been unreachable for more than UNREACHABLE_AFTER_MS: the lock then shows
   * No Response in Home. The grace period hides normal reconnects (a second or two).
   */
  unreachable(): boolean {
    return this.downSince !== undefined && Date.now() - this.downSince > UNREACHABLE_AFTER_MS;
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
    this.log.debug(`Connecting to ${s.host}:${s.port} …`);
    // The registration lease keeps rings coming. Without listening for rings there is no
    // registration to renew: just reconnect every leaseRecycleMinutes, which also clears the
    // door channels that opens leave on the intercom.
    const client: IconaBridgeClient = new IconaBridgeClient(
      s.host,
      s.port,
      this.log,
      s.enableNotifications
        ? {
          intervalMs: s.leaseRefreshMs,
          mode: s.leaseMode,
          recycleMs: s.leaseRecycleMs,
          reregister: (): Promise<void> => this.reregister(client),
          isBusy: () => this.callHandler?.busy() ?? false,
        }
        : { intervalMs: s.leaseRecycleMs, mode: 'reconnect', recycleMs: s.leaseRecycleMs, isBusy: () => this.opening > 0 },
    );
    // Shutting down while connecting: close this connection and stop.
    const stopped = async (): Promise<boolean> => {
      if (!this.shuttingDown) {
        return false;
      }
      if (this.client === client) {
        this.client = undefined;
      }
      await client.disconnect().catch(() => undefined);
      return true;
    };
    try {
      await client.connect();
      if (await stopped()) {
        return;
      }
    } catch (e) {
      this.log.error(`Connection failed: ${(e as Error).message}`);
      this.scheduleReconnect(true);
      return;
    }
    try {
      await authenticate(client, s.token);
      if (await stopped()) {
        return;
      }
      this.log.debug('Authenticated');
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
      this.log.debug(`Device config: ${deviceConfig.doors.length} door(s), apt=${deviceConfig.aptAddress}${deviceConfig.aptSubaddress}`);
    } catch (e) {
      this.log.error(`Config fetch failed: ${(e as Error).message}`);
      await client.disconnect();
      this.scheduleReconnect(true);
      return;
    }
    if (await stopped()) {
      return;
    }
    try {
      await registerPush(client, deviceConfig, s.registerPush, (event) => this.onEvent(event));
    } catch (e) {
      this.log.warn(`Push registration failed (non-fatal): ${(e as Error).message}`);
    }
    if (await stopped()) {
      return;
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
        this.log.debug('CTPP channels open for VIP events');
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
      // Doctor mode answers calls itself, so it needs calls followed even with answering off.
      const mode = s.answerMode === 'off' && s.doctorMode !== 'off' ? 'handshake' : s.answerMode;
      const call = new CallHandler(mode, ourAddress, deviceConfig.aptAddress, (frame) => listener!.sendFrame(frame), this.log, {
        startTimeoutMs: s.mediaStartTimeoutMs,
        silenceMs: s.mediaSilenceMs,
        videoRefreshMs: s.videoRefreshMs,
      });
      listener = new VipEventListener(client, deviceConfig, (ev) => this.onEvent(ev), this.log, call);
      call.attach(client);
      call.enablePreview(
        s.ringPreview && s.camera
          ? { hd: s.videoQuality === 'hd', onVideo: (c, unit) => this.camera?.previewVideo(c, unit), onStart: () => this.camera?.previewStarted(), onDone: () => this.camera?.previewDone() }
          : undefined,
      );
      this.callHandler = call;
      this.vipListener = listener;
      await listener.start().catch((e) => this.log.warn(`VIP listener start failed: ${(e as Error).message}`));
    }
    if (await stopped()) {
      this.vipListener?.stop().catch(() => undefined);
      this.vipListener = undefined;
      this.callHandler = undefined;
      return;
    }
    if (this.client !== client || !client.connected) {
      return; // dropped during the setup: the reconnect is already scheduled
    }
    this.startKeepalive(deviceConfig);
    this.discoverAccessories(deviceConfig);
    this.failures = 0;
    const wasUnreachable = this.unreachable();
    this.downSince = undefined;
    if (wasUnreachable) {
      for (const lock of this.lockAccessories.values()) {
        lock.refresh();
      }
    }
    (this.plannedReconnect ? this.log.debug : this.log.info).call(this.log, 'Comelit Intercom ready');
    this.plannedReconnect = false;
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
    this.log.debug('Registration renewed in place');
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
    this.plannedReconnect = planned;
    if (planned) {
      this.log.debug('Reconnecting to refresh the registration');
    } else {
      this.log.warn('Device disconnected — scheduling reconnect');
    }
    this.downSince ??= Date.now();
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
    this.downSince ??= Date.now();
    const failed = why === true;
    if (failed) {
      this.plannedReconnect = false; // a failed attempt is worth seeing when it comes back
    }
    const delay = reconnectDelay(this.settings, why === 'planned' ? -1 : failed ? this.failures : 0);
    if (failed) {
      this.failures++;
    }
    // A planned refresh is routine; a reconnect after a drop or a failure is worth seeing.
    (why === 'planned' ? this.log.debug : this.log.info).call(this.log, `Reconnecting in ${delay / 1000} s …`);
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
    this.log.debug(`Event: ${event.eventType} from ${event.aptAddress}`);
    if (event.eventType === 'doorbell_ring') {
      this.lastRingAt = Date.now();
      this.doorbellAccessory?.triggerRing();
      this.camera?.ring();
      this.doctorOpen();
    }
  }

  /** Doctor mode is on: always, or while its HomeKit switch is on. */
  doctorModeActive(): boolean {
    return this.settings.doctorMode === 'always' || (this.settings.doctorMode === 'switch' && this.doctorSwitch?.on === true);
  }

  /** Doctor mode: answer the ring and open the door, after the configured delay. */
  private doctorOpen(): void {
    if (!this.doctorModeActive() || this.doctorPending) {
      return;
    }
    const door = this.deviceConfig?.doors[0];
    if (!door) {
      this.log.warn('Doctor mode: no door to open');
      return;
    }
    this.doctorPending = true;
    const delay = this.settings.doctorModeDelayMs;
    this.log.info(`Doctor mode: opening '${door.name}' in ${delay / 1000} s`);
    setTimeout(async () => {
      try {
        const call = this.callHandler;
        if (!call?.activeCall()) {
          this.log.info('Doctor mode: the call is over (answered elsewhere or hung up); not opening');
          return;
        }
        const result = await call.openInCall(door, true);
        if (result) {
          this.log.info(`Doctor mode: door '${door.name}' opened`);
          [...this.lockAccessories.values()][0]?.showOpened();
        } else {
          this.log.info('Doctor mode: no call to answer; not opening');
        }
      } catch (e) {
        this.log.warn(`Doctor mode: open failed: ${(e as Error).message}`);
      } finally {
        this.doctorPending = false;
      }
    }, delay);
  }

  async openDoor(door: Door): Promise<OpenResult> {
    if (!this.client || !this.deviceConfig) {
      throw new Error('Not connected');
    }
    this.opening++;
    try {
      return await openDoor(this.client, this.deviceConfig, door, { listener: this.vipListener, call: this.callHandler, log: this.log });
    } finally {
      this.opening--;
    }
  }

  // ─── Accessories ───────────────────────────────────────────────────────────

  /** Finds or creates the accessory for `seed`, registering it with Homebridge only once. */
  /**
   * `init` runs only for a new accessory; `context` is saved on new and cached ones alike, so the
   * cache holds the intercom's current doors and cameras (restoreCached builds from them).
   */
  private accessoryFor(seed: string, name: string, keep: Set<string>, init?: (a: PlatformAccessory) => void, context?: Record<string, unknown>): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`${UUID_SEED}-${seed}`);
    keep.add(uuid);
    const existing = this.accessories.get(uuid);
    if (existing) {
      Object.assign(existing.context, context);
      this.api.updatePlatformAccessories([existing]);
      return existing;
    }
    const accessory = new this.api.platformAccessory(name, uuid);
    Object.assign(accessory.context, context);
    init?.(accessory);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(uuid, accessory);
    this.log.info(`Registered ${name}`);
    return accessory;
  }

  discoverAccessories(config: DeviceConfig): void {
    // The accessories only change if the intercom's doors or cameras do; rebuilding them on
    // every reconnect would rewrite Homebridge's accessory cache each time.
    // Sorted, so the same doors and cameras in another order (as restored from the cache) match.
    const doors = [...config.doors].sort((a, b) => a.index - b.index);
    const cameras = [...config.cameras].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const from = JSON.stringify([doors, cameras, this.settings.camera, this.settings.doctorMode]);
    if (from === this.builtFrom) {
      return;
    }
    this.builtFrom = from;
    const keep = new Set<string>();
    for (const door of config.doors) {
      const accessory = this.accessoryFor(`lock-${door.index}`, door.name || `Door ${door.index + 1}`, keep, undefined, { door });
      this.lockAccessories.set(accessory.UUID, new LockAccessory(this, accessory, door));
    }
    const bell = this.accessoryFor('doorbell', this.displayName, keep);
    this.doorbellAccessory = new DoorbellAccessory(this, bell);
    if (this.settings.doctorMode === 'switch') {
      const sw = this.accessoryFor('doctor-mode', `${this.displayName} Doctor Mode`, keep);
      this.doctorSwitch = new DoctorModeSwitch(this, sw);
    } else {
      this.doctorSwitch = undefined;
    }
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
      const accessory = this.accessoryFor(`camera-${camera.id}`, camera.name || `Camera ${camera.id}`, keep, undefined, { camera });
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
