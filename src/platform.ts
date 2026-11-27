import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';
import { CameraAccessory } from './accessories/cameraAccessory';
import { DoctorModeSwitch } from './accessories/doctorModeSwitch';
import { NextVisitorSwitch } from './accessories/nextVisitorSwitch';
import { OfflineSensor } from './accessories/offlineSensor';
import { DoorbellAccessory } from './accessories/doorbellAccessory';
import { ActuatorSwitchAccessory } from './accessories/actuatorSwitch';
import { LockAccessory } from './accessories/lockAccessory';
import { authenticate } from './auth';
import { CallHandler } from './call';
import { DoorbellCamera } from './camera';
import { EventLog, eventsFileFor } from './events';
import { ChannelType, ViperMessageId } from './channels';
import { IconaBridgeClient } from './client';
import { callHandlerMode, type ComelitPlatformConfig, reconnectDelay, resolveSettings, type Settings, settingsWarnings, actuatorKey, type ActuatorType } from './config';
import { getDeviceConfig } from './configReader';
import { ctppInitSequence } from './ctpp';
import { openDoor } from './door';
import type { DeviceConfig, Door, IntercomEvent, OpenResult } from './models';
import { encodeCtppInit } from './protocol';
import { registerPush, sendPushKeepalive } from './push';
import { KEEPALIVE_INTERVAL_MS, PLATFORM_NAME, PLUGIN_NAME, UUID_SEED } from './settings';
import { VipEventListener } from './vipListener';
import { followName } from './names';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** How long the intercom must be unreachable before the lock shows No Response. */
export const UNREACHABLE_AFTER_MS = 30_000;
/** How long the intercom must be unreachable before the Offline sensor opens. */
export const OFFLINE_AFTER_MS = 2 * 60_000;

/** How often the routine work (renewals, planned reconnects) is summed up in the debug log. */
const ROUTINE_SUMMARY_MS = 60 * 60_000;

export class ComelitIntercomPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  readonly settings: Settings;

  private readonly accessories = new Map<string, PlatformAccessory>();
  private readonly lockAccessories = new Map<string, LockAccessory>();
  private doorbellAccessory?: DoorbellAccessory;
  private cameraAccessories: CameraAccessory[] = [];
  private offlineSensor?: OfflineSensor;
  /** Opens the Offline sensor once the intercom has stayed away for OFFLINE_AFTER_MS. */
  private offlineTimer?: NodeJS.Timeout;
  /** The intercom's firmware (from its server-info), for the accessories' Firmware row; '' if it has none HomeKit takes. */
  private firmware?: string;
  private firmwareTries = 0;
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
  private nextVisitor?: NextVisitorSwitch;
  /** Doors and cameras the accessories were last built from, to skip rebuilding them on every reconnect. */
  private builtFrom?: string;
  private lastRingAt = 0;
  /** Recent events, for the Recent events tab in the plugin's settings. */
  readonly events: EventLog;
  /** Since when the intercom is not connected (from startup until the first connection); undefined while connected. */
  private downSince: number | undefined = Date.now();
  /** The last disconnect was a planned refresh: its reconnect is routine (debug log). */
  private plannedReconnect = false;
  /**
   * Routine work that is no longer logged line by line (renewals every 2 min, planned
   * reconnects): counted, and summed up once an hour in the debug log.
   */
  private readonly routine = { renewals: 0, checks: 0, reconnects: 0, since: Date.now() };
  private routineTimer?: NodeJS.Timeout;
  /** Door opens on their way, so a planned reconnect waits for them. */
  private opening = 0;
  private camera?: DoorbellCamera;
  private cameraConfigured = false;
  private readonly displayName: string;
  private readonly storage?: string;

  constructor(
    readonly log: Logging,
    config: ComelitPlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.settings = resolveSettings(config);
    this.displayName = String(config.name ?? '').trim() || 'Comelit Intercom';
    const storage = api.user?.storagePath?.();
    this.storage = storage;
    this.events = new EventLog(storage ? path.join(storage, eventsFileFor(config.name)) : undefined, undefined, this.settings.eventHistoryDays);
    this.events.add('start', `Homebridge started the plugin (${pluginVersion()})`);
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
        `${s.camera && s.liveViewWithoutRing ? `, live view without a ring${s.liveViewSound === 'always' ? ' with sound' : s.liveViewSound === 'talk' ? ' with sound when you talk' : ''}` : ''}` +
        `${s.doorbellTriggerUrl ? ', trigger URL set' : ''}${s.doctorMode !== 'off' ? `, doctor mode ${s.doctorMode}` : ''}` +
        `${s.openRepeat > 1 ? `, ${s.openRepeat} buzzes per unlock ${s.openRepeatMs / 1000} s apart` : ''}`,
    );
    if (this.settings.camera && this.settings.answerMode !== 'answer-on-view') {
      this.log.info(
        this.settings.liveViewWithoutRing
          ? "Doorbell camera: live video during a ring needs answerMode 'answer-on-view'; until then a ring's live view shows the picture."
          : "Doorbell camera: live video needs answerMode 'answer-on-view'; until then it shows the picture.",
      );
    }
    api.on('didFinishLaunching', () => {
      this.adoptEvents();
      this.restoreCached();
      this.watchDown();
      this.setupDevice().catch((e) => this.onSetupError('Initial setup', e));
    });
    api.on('shutdown', () => this.teardown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * After the Name changed: Recent events are kept by name, so the ones kept under the previous
   * Name (noted on the doorbell accessory) are taken over.
   */
  private adoptEvents(): void {
    const bell = this.accessories.get(this.api.hap.uuid.generate(`${UUID_SEED}-doorbell`));
    const before = bell?.context.intercomName as string | undefined;
    if (!this.storage || before === undefined || before === this.displayName) {
      return;
    }
    const n = this.events.adopt(path.join(this.storage, eventsFileFor(before)));
    if (n > 0) {
      this.log.info(`Recent events: took over ${n} from before the Name changed ('${before}')`);
    }
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

  /** The intercom has been unreachable for more than OFFLINE_AFTER_MS: the Offline sensor is Open. */
  offline(): boolean {
    return this.downSince !== undefined && Date.now() - this.downSince > OFFLINE_AFTER_MS;
  }

  /**
   * The connection is down: note since when. Locks and sensors answer No Response from then on
   * when Home asks (HomeKit can't be told an error unasked); the Offline sensor is pushed.
   */
  private markDown(): void {
    if (this.downSince !== undefined) {
      return;
    }
    this.downSince = Date.now();
    this.watchDown();
  }

  private watchDown(): void {
    this.clearDownTimers();
    if (this.downSince === undefined || this.shuttingDown) {
      return;
    }
    // A little past the limit, so offline() is already true when it fires.
    this.offlineTimer = setTimeout(() => this.offlineSensor?.refresh(), Math.max(0, OFFLINE_AFTER_MS - (Date.now() - this.downSince)) + 100);
    this.offlineTimer.unref?.();
  }

  private clearDownTimers(): void {
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
  }

  /** The intercom is back: push each lock's and sensor's state again, clearing No Response. */
  private refreshReachability(): void {
    for (const lock of this.lockAccessories.values()) {
      lock.refresh();
    }
    this.doorbellAccessory?.refresh();
    for (const camera of this.cameraAccessories) {
      camera.refresh();
    }
  }

  /**
   * The lock opens within the window after a ring, and likewise while a live view without a ring
   * shows the entrance's live video and within the window after it: someone is looking at the
   * door then, as after a ring. Automations and Siri can't open a live view, so they are still
   * refused outside a ring. 0: at any time.
   */
  isUnlockAllowed(): boolean {
    const windowMs = this.settings.ringWindowMs;
    if (windowMs === 0 || Date.now() - this.lastRingAt <= windowMs) {
      return true;
    }
    const call = this.callHandler;
    return Boolean(call && (call.liveViewShowing?.() || (call.liveViewEndedAt > 0 && Date.now() - call.liveViewEndedAt <= windowMs)));
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
    this.routineDebug(`Connecting to ${s.host}:${s.port} …`);
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
      this.routineDebug('Authenticated');
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
      this.routineDebug(`Device config: ${deviceConfig.doors.length} door(s), apt=${deviceConfig.aptAddress}${deviceConfig.aptSubaddress}`);
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
        this.routineDebug('CTPP channels open for VIP events');
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
      const mode = callHandlerMode(s);
      const call = new CallHandler(mode, ourAddress, deviceConfig.aptAddress, (frame) => listener!.sendFrame(frame), this.log, {
        startTimeoutMs: s.mediaStartTimeoutMs,
        silenceMs: s.mediaSilenceMs,
        videoRefreshMs: s.videoRefreshMs,
      }, {
        // Live view without a ring: our own call to the entrance panel (the first in the address book).
        liveViewWithoutRing: s.camera && s.liveViewWithoutRing,
        liveViewSound: s.camera && s.liveViewWithoutRing ? s.liveViewSound : 'off',
        panelAddress: deviceConfig.callerAddress,
      });
      listener = new VipEventListener(client, deviceConfig, (ev) => this.onEvent(ev), this.log, call);
      call.attach(client);
      // The ring preview gives the notification its picture, and recording its video before an answer.
      // With the picture setting off, the preview runs for recording only.
      const picture = s.ringPreview;
      call.enablePreview(
        s.camera && (s.ringPreview || s.recording)
          ? {
            hd: s.videoQuality === 'hd',
            onVideo: (c, unit) => picture && this.camera?.previewVideo(c, unit),
            onStart: () => picture && this.camera?.previewStarted(),
            onEmptyKeyframe: () => picture && this.camera?.previewEmptyKeyframe(),
            onDone: () => picture && this.camera?.previewDone(),
            keepRunning: () => this.camera?.recorder?.recording === true,
          }
          : undefined,
      );
      // Recording (HomeKit Secure Video) hears every call's video and its end.
      call.setCallListener(this.recordingListener(s));
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
    const wasOffline = this.offline();
    this.downSince = undefined;
    this.clearDownTimers();
    if (wasUnreachable) {
      this.refreshReachability();
    }
    if (wasOffline) {
      this.offlineSensor?.refresh();
    }
    if (this.plannedReconnect) {
      this.routine.reconnects++;
    } else {
      this.log.info('Comelit Intercom ready');
      this.events.add('connected', 'Connected to the intercom');
    }
    if (this.firmware === undefined && this.firmwareTries < 2) {
      void this.readFirmware(client);
    }
    this.plannedReconnect = false;
    this.startRoutineSummary();
  }

  /**
   * What hears every call's video and end for recording. It looks the camera up at each call:
   * on the first connect the camera is only made after the call handler.
   */
  recordingListener(s: Settings): { video: (call: object, unit: Buffer) => void; audio: (call: object, data: Buffer) => void; ended: (call: object) => void } | undefined {
    if (!s.camera || !s.recording) {
      return undefined;
    }
    return {
      video: (c, unit) => this.camera?.recorder?.onCallVideo(c, unit),
      audio: (c, data) => this.camera?.recorder?.onCallAudio(c, data),
      ended: (c) => this.camera?.recorder?.onCallEnded(c),
    };
  }

  /**
   * Reads the intercom's firmware version once, for the accessories' Firmware row in Home and
   * Eve. Not needed for anything else: a failure is only noted in the debug log.
   */
  private async readFirmware(client: IconaBridgeClient): Promise<void> {
    // Tried on two connections at most: an intercom that doesn't answer isn't asked on every reconnect.
    this.firmwareTries++;
    // The INFO channel the keepalive already uses, if open (its sends take turns); otherwise
    // (registerPush on) one of our own, closed again after.
    const shared = client.getChannel('INFO');
    try {
      const channel = shared ?? await client.openChannel('INFO', ChannelType.INFO);
      const info = await client.sendJson(channel, {
        message: 'server-info',
        'message-type': 'request',
        'message-id': ViperMessageId.SERVER_INFO,
      });
      const version = typeof info.version === 'string' ? info.version.trim() : '';
      // HomeKit takes only numbers here (x, x.y or x.y.z).
      if (!/^\d+(\.\d+){0,2}$/.test(version)) {
        this.log.debug(`Intercom firmware ${version ? `'${version}'` : 'not given'}; the Firmware row is left as is`);
        this.firmware = '';
        return;
      }
      this.firmware = version;
      this.log.debug(`Intercom firmware ${version}`);
      this.applyFirmware();
    } catch (e) {
      this.log.debug(`Reading the intercom's firmware failed: ${(e as Error).message}`);
    } finally {
      if (!shared) {
        await client.closeChannel('INFO').catch(() => undefined);
      }
    }
  }

  /**
   * Renames an accessory's tile (and a mode switch's contact sensor, "<name> Sensor") when its
   * name in the settings changed, unless it was renamed in the Home app. The camera's tile is its
   * doorbell service; a sensor-only accessory's, its sensor.
   */
  private followNames(accessory: PlatformAccessory, name: string): void {
    const S = this.Service;
    const main = [S.Doorbell, S.LockMechanism, S.Switch, S.Lightbulb, S.ContactSensor, S.MotionSensor]
      .map((type) => accessory.getService(type))
      .find((svc): svc is Service => !!svc);
    if (!main) {
      return;
    }
    const before = JSON.stringify(accessory.context.givenNames ?? null);
    const renamed = followName(this.api, this.log, accessory, main, name);
    const sensor = main === accessory.getService(S.Switch) ? accessory.getService(S.ContactSensor) : undefined;
    if (sensor) {
      followName(this.api, this.log, accessory, sensor, `${name} Sensor`);
    }
    // Homebridge's own name for it (logs, the camera's tile) only when its tile took the new name.
    if (renamed && accessory.displayName !== name) {
      accessory.updateDisplayName(name);
    }
    if (JSON.stringify(accessory.context.givenNames ?? null) !== before) {
      this.api.updatePlatformAccessories([accessory]); // saves the names noted with it
    }
  }

  /** Puts the intercom's firmware on every accessory's Firmware row. */
  private applyFirmware(): void {
    if (!this.firmware) {
      return;
    }
    for (const accessory of this.accessories.values()) {
      accessory.getService(this.Service.AccessoryInformation)?.updateCharacteristic(this.Characteristic.FirmwareRevision, this.firmware);
    }
  }

  private async openCtppChannels(client: IconaBridgeClient, config: DeviceConfig): Promise<void> {
    const ourAddr = `${config.aptAddress}${config.aptSubaddress}`;
    // The VIP CTPP channel is opened with the UAUT channel type.
    await client.openChannel('CTPP', ChannelType.UAUT, ourAddr);
    await client.openChannel('CSPB', ChannelType.UAUT);
    const ctpp = client.getChannel('CTPP')!;
    // Its steps are logged (debug) only when the connection isn't a routine, planned one.
    const quiet = {
      info: (m: string) => this.log.info(m),
      warn: (m: string) => this.log.warn(m),
      error: (m: string) => this.log.error(m),
      debug: () => undefined,
    } as unknown as Logging;
    await ctppInitSequence(client, ctpp, config.aptAddress, config.aptSubaddress, ourAddr, (Date.now() / 1000) | 0, 2_000, this.plannedReconnect ? quiet : this.log);
  }

  /** Re-sends the registration on the open connection (lease mode `inplace`). */
  private async reregister(client: IconaBridgeClient): Promise<void> {
    const ch = client.getChannel('CTPP');
    const cfg = this.deviceConfig;
    if (!ch || !cfg) {
      throw new Error('CTPP channel not open');
    }
    await client.sendBinary(ch, encodeCtppInit(cfg.aptAddress, cfg.aptSubaddress, (Date.now() / 1000) | 0));
    this.routine.renewals++;
  }

  /** A debug line for the connection's steps, left out when the connection is a routine, planned one. */
  private routineDebug(message: string): void {
    if (!this.plannedReconnect) {
      this.log.debug(message);
    }
  }

  /** Once an hour, one debug line for the routine work of that hour. */
  private startRoutineSummary(): void {
    if (this.routineTimer) {
      return;
    }
    this.routineTimer = setInterval(() => this.logRoutineSummary(), ROUTINE_SUMMARY_MS);
    this.routineTimer.unref?.();
  }

  /** The hourly debug line: how many renewals and planned reconnects since the last one. */
  logRoutineSummary(): void {
    const r = this.routine;
    const checks = r.checks + (this.vipListener?.takeRenewalChecks() ?? 0);
    const minutes = Math.round((Date.now() - r.since) / 60_000);
    const line =
      `Connection, last ${minutes} min: registration renewed ${r.renewals} time(s), ${checks} renewal check(s) from the intercom answered, ` +
      `${r.reconnects} planned reconnect(s)`;
    if (r.renewals > 0 && checks === 0) {
      // The intercom normally checks back after each renewal: none at all means it may have
      // stopped routing rings to the plugin.
      this.log.warn(`${line}: the intercom answered none of the renewals; if rings stop reaching HomeKit, restart the plugin`);
    } else {
      this.log.debug(line);
    }
    r.renewals = 0;
    r.checks = 0;
    r.reconnects = 0;
    r.since = Date.now();
  }


  private teardown(): void {
    this.shuttingDown = true;
    // Saved at once (Homebridge may not wait), and again after the camera has ended its live
    // views, which note them.
    this.events.flushSync();
    void (this.camera?.shutdown() ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.events.flush());
    this.stopKeepalive();
    this.clearDownTimers();
    clearInterval(this.routineTimer);
    this.routineTimer = undefined;
    clearTimeout(this.reconnectTimer);
    this.vipListener?.stop().catch(() => undefined);
    this.vipListener = undefined;
    this.callHandler = undefined;
    this.client?.disconnect().catch(() => undefined);
    this.client = undefined;
  }

  private onClientDisconnect(planned: boolean): void {
    this.plannedReconnect = planned;
    if (!planned) {
      this.log.warn('Device disconnected — scheduling reconnect');
      this.events.add('disconnected', 'Connection to the intercom lost; reconnecting');
    }
    this.markDown();
    this.camera?.recorder?.reset();
    this.stopKeepalive();
    // Keep the listener's count of renewal checks for the hourly summary.
    this.routine.checks += this.vipListener?.takeRenewalChecks() ?? 0;
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
    this.markDown();
    const failed = why === true;
    if (failed) {
      this.plannedReconnect = false; // a failed attempt is worth seeing when it comes back
    }
    const delay = reconnectDelay(this.settings, why === 'planned' ? -1 : failed ? this.failures : 0);
    if (failed) {
      this.failures++;
    }
    // A planned refresh is routine (counted for the hourly summary); a reconnect after a drop or
    // a failure is worth seeing.
    if (why !== 'planned') {
      this.log.info(`Reconnecting in ${delay / 1000} s …`);
    }
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
    this.keepaliveTimer = setInterval(() => {
      if (!this.client) {
        return;
      }
      sendPushKeepalive(this.client, config, this.settings.registerPush)
        .catch((e) => this.log.warn(`Keepalive failed: ${(e as Error).message}`));
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
      this.events.add('ring', 'Ring');
      this.doorbellAccessory?.triggerRing();
      this.camera?.ring();
      this.doctorOpen();
    }
  }

  /** Doctor mode is on: always, or while its HomeKit switch is on. */
  doctorModeActive(): boolean {
    return this.settings.doctorMode === 'always' || (this.settings.doctorMode === 'switch' && this.doctorSwitch?.on === true);
  }

  /** The Next Visitor switch is on: the next ring opens the door. */
  nextVisitorActive(): boolean {
    return this.nextVisitor?.on === true;
  }

  /**
   * Doctor mode or the Next Visitor switch: answer the ring and open the door, after the
   * configured delay. One open per ring, even with both on; the Next Visitor switch turns off
   * only once the door was opened for the visitor.
   */
  private doctorOpen(): void {
    const doctor = this.doctorModeActive();
    // Whether the Next Visitor switch was on at the ring: only then can this ring use it up.
    const next = this.nextVisitorActive();
    if ((!doctor && !next) || this.doctorPending) {
      return;
    }
    const label = doctor && next ? 'Doctor mode and Next visitor' : doctor ? 'Doctor mode' : 'Next visitor';
    // The first door: an entrance door, else an actuator shown as a lock (never a light).
    const door = this.deviceConfig?.doors.find((d) => this.actuatorType(d) === 'lock');
    if (!door) {
      this.log.warn(`${label}: no door to open`);
      return;
    }
    this.doctorPending = true;
    const delay = this.settings.doctorModeDelayMs;
    this.log.info(`${label}: opening '${door.name}' in ${delay / 1000} s`);
    setTimeout(() => void this.openArmed(door, label, doctor, next), delay);
  }

  /** The delayed open of doctorOpen(). Catches its own errors. */
  private async openArmed(door: Door, label: string, doctor: boolean, next: boolean): Promise<void> {
    // The switch that armed this open is still on (it can be turned off up to the open itself).
    const armed = () => (doctor && this.doctorModeActive()) || (next && this.nextVisitorActive());
    try {
      if (!armed()) {
        this.log.info(`${label}: the switch was turned off before the door opened; not opening`);
        return;
      }
      const call = this.callHandler;
      if (!call?.ringingCall()) {
        // No ring to open in (it ended, or only our own live view call is up): not opening.
        this.log.info(`${label}: the call is over (answered elsewhere or hung up); not opening`);
        return;
      }
      const started = Date.now();
      // An actuator (only on a setup with no entrance door) gets its own command, never the
      // entrance's open inside the call (#59).
      const result = door.isActuator ? await this.openOnce(door) : await call.openInCall(door, true, armed);
      if (!result && !armed()) {
        // Turned off while the call was being answered: not opened.
        this.log.info(`${label}: the switch was turned off before the door opened; not opening`);
        return;
      }
      if (result) {
        this.log.info(`${label}: door '${door.name}' opened`);
        this.events.add('open', `Door '${door.name}' opened by ${label === 'Doctor mode' ? 'Doctor Mode' : 'Next Visitor'}`);
        [...this.lockAccessories.values()][0]?.showOpened();
        void this.extraBuzzes(door, label, started);
        if (next && this.nextVisitorActive()) {
          this.nextVisitor?.used();
        }
      } else {
        this.log.info(`${label}: no call to answer; not opening`);
      }
    } catch (e) {
      this.log.warn(`${label}: open failed: ${(e as Error).message}`);
      this.events.add('open-failed', `${label === 'Doctor mode' ? 'Doctor Mode' : 'Next Visitor'}: open failed (${(e as Error).message})`);
    } finally {
      this.doctorPending = false;
    }
  }

  /**
   * The HomeKit lock. During a live view without a ring the panel is in a call with us and takes
   * no open (cause 8, busy; and it ignores one sent inside that call: door tests 2026-11-20), so
   * the view's call is hung up for the open and all its buzzes, then placed again
   * (CallHandler.openWithLiveViewPaused). Only the lock does this: doctor mode and Next Visitor
   * open inside the ring, and their extra buzzes never pause a live view.
   */
  async openDoor(door: Door): Promise<OpenResult> {
    const started = Date.now();
    const all = async (retryBusy: boolean): Promise<OpenResult> => {
      const result = await this.openOnce(door, retryBusy);
      await this.extraBuzzes(door, `Door '${door.name}'`, started, retryBusy);
      return result;
    };
    const call = this.callHandler;
    const paused = call && !call.ringingCall() ? await call.openWithLiveViewPaused?.(() => all(true)) : null;
    return paused ?? all(false);
  }

  /** How a door shows in HomeKit: entrance doors are always locks; actuators by the `actuators` setting. */
  actuatorType(door: Door): ActuatorType {
    return door.isActuator ? (this.settings.actuatorTypes[actuatorKey(door.name)] ?? 'lock') : 'lock';
  }

  /** An actuator shown as a switch or light: its own command, at any time (no ring needed). */
  async pressActuator(door: Door): Promise<OpenResult> {
    if (!door.isActuator || this.actuatorType(door) === 'lock') {
      throw new Error('not an actuator shown as a switch or light');
    }
    // The accessory may hold the relay as saved before a restart: send only to the same relay
    // in the intercom's current configuration (it may have been moved or renamed since).
    const current = this.deviceConfig?.doors.find((d) => d.isActuator && d.index === door.index);
    if (
      this.deviceConfig &&
      (!current || current.aptAddress !== door.aptAddress || current.outputIndex !== door.outputIndex || actuatorKey(current.name) !== actuatorKey(door.name))
    ) {
      throw new Error('the intercom no longer has this actuator as saved; it is rebuilt on the next connect');
    }
    return this.openOnce(current ?? door);
  }

  private async openOnce(door: Door, retryBusy = false): Promise<OpenResult> {
    if (!this.client || !this.deviceConfig) {
      throw new Error('Not connected');
    }
    this.opening++;
    try {
      return await openDoor(this.client, this.deviceConfig, door, { listener: this.vipListener, call: this.callHandler, log: this.log, retryBusy });
    } finally {
      this.opening--;
    }
  }

  /**
   * Buzzes per unlock (openRepeat): after the first open, sends the door release again,
   * openRepeatSeconds apart (start to start: the time an open takes to be confirmed counts),
   * for an entrance behind two doors. A later buzz that fails is logged and the rest still
   * follow; the first open's result is what counts. `firstAt`: when the first open was sent.
   */
  async extraBuzzes(door: Door, label: string, firstAt = Date.now(), retryBusy = false): Promise<void> {
    const total = this.settings.openRepeat;
    let last = firstAt;
    for (let n = 2; n <= total; n++) {
      await new Promise((r) => setTimeout(r, Math.max(0, last + this.settings.openRepeatMs - Date.now())));
      last = Date.now();
      try {
        await this.openOnce(door, retryBusy);
        this.log.info(`${label}: buzz ${n} of ${total}`);
      } catch (e) {
        this.log.warn(`${label}: buzz ${n} of ${total} failed: ${(e as Error).message}`);
      }
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
    const from = JSON.stringify([doors, cameras, this.settings.camera, this.settings.doctorMode, this.settings.nextVisitorSwitch,
      this.settings.doctorModeSensor, this.settings.nextVisitorSensor, this.settings.offlineSensor, doors.map((d) => this.actuatorType(d))]);
    if (from === this.builtFrom) {
      return;
    }
    this.builtFrom = from;
    const keep = new Set<string>();
    // Each accessory with the name it should have now (tiles follow a changed Name or door name).
    const names: Array<[PlatformAccessory, string]> = [];
    for (const door of config.doors) {
      const type = this.actuatorType(door);
      if (type !== 'lock') {
        // A separate accessory from the lock's, so HomeKit forgets the lock (and its automations).
        const accessory = this.accessoryFor(`actuator-${door.index}`, door.name || `Actuator ${door.index + 1}`, keep, undefined, { door });
        new ActuatorSwitchAccessory(this, accessory, door, type);
        names.push([accessory, door.name || `Actuator ${door.index + 1}`]);
        continue;
      }
      const accessory = this.accessoryFor(`lock-${door.index}`, door.name || `Door ${door.index + 1}`, keep, undefined, { door });
      this.lockAccessories.set(accessory.UUID, new LockAccessory(this, accessory, door));
      names.push([accessory, door.name || `Door ${door.index + 1}`]);
    }
    // Names in the actuators setting that match no actuator on the intercom (a typo?).
    const actuatorNames = new Set(config.doors.filter((d) => d.isActuator).map((d) => actuatorKey(d.name)));
    const unknown = Object.keys(this.settings.actuatorTypes).filter((n) => !actuatorNames.has(n));
    const shared = Object.keys(this.settings.actuatorTypes).filter((n) => config.doors.filter((d) => d.isActuator && actuatorKey(d.name) === n).length > 1);
    if (shared.length > 0) {
      this.log.warn(`actuators: more than one actuator is named ${shared.map((n) => `'${n}'`).join(', ')}; all of them are shown that way`);
    }
    if (unknown.length > 0 && config.doors.length > 0) {
      const have = config.doors.filter((d) => d.isActuator).map((d) => `'${d.name}'`).join(', ') || 'none';
      this.log.warn(`actuators: no actuator named ${unknown.map((n) => `'${n}'`).join(', ')} on the intercom (its actuators: ${have})`);
    }
    const bell = this.accessoryFor('doorbell', this.displayName, keep);
    this.doorbellAccessory = new DoorbellAccessory(this, bell);
    names.push([bell, this.displayName]);
    bell.context.intercomName = this.displayName; // for adoptEvents after a Name change
    // A rebuild replaces the switch objects: the old ones' time limits must not run on.
    this.doctorSwitch?.dispose();
    this.nextVisitor?.dispose();
    if (this.settings.doctorMode === 'switch') {
      const sw = this.accessoryFor('doctor-mode', `${this.displayName} Doctor Mode`, keep);
      names.push([sw, `${this.displayName} Doctor Mode`]);
      this.doctorSwitch = new DoctorModeSwitch(this, sw, this.settings.doctorModeMs, this.settings.doctorModeSensor);
    } else {
      this.doctorSwitch = undefined;
    }
    if (this.settings.nextVisitorSwitch) {
      const sw = this.accessoryFor('next-visitor', `${this.displayName} Next Visitor`, keep);
      names.push([sw, `${this.displayName} Next Visitor`]);
      this.nextVisitor = new NextVisitorSwitch(this, sw, this.settings.nextVisitorMs, this.settings.nextVisitorSensor);
    } else {
      this.nextVisitor = undefined;
    }
    if (this.settings.camera) {
      // Experimental doorbell camera, as an accessory of its own so turning it off removes it cleanly.
      if (!this.camera) {
        this.camera = new DoorbellCamera(this.api, this.log, this.settings, () => this.callHandler, (kind, text, t) => this.events.add(kind, text, t));
      }
      const camera = this.camera;
      // A new accessory gets the controller before it is registered; a cached one, once.
      const cam = this.accessoryFor('doorbell-camera', `${this.displayName} Camera`, keep, (a) => {
        camera.attach(a);
        this.cameraConfigured = true;
      });
      if (!this.cameraConfigured) {
        camera.attach(cam);
        this.cameraConfigured = true;
      }
      names.push([cam, `${this.displayName} Camera`]);
    }
    this.cameraAccessories = config.cameras.map((camera) => {
      const accessory = this.accessoryFor(`camera-${camera.id}`, camera.name || `Camera ${camera.id}`, keep, undefined, { camera });
      names.push([accessory, camera.name || `Camera ${camera.id}`]);
      return new CameraAccessory(this, accessory, camera);
    });
    if (this.settings.offlineSensor) {
      const sensor = this.accessoryFor('offline', `${this.displayName} Offline`, keep);
      names.push([sensor, `${this.displayName} Offline`]);
      this.offlineSensor = new OfflineSensor(this, sensor);
    } else {
      this.offlineSensor = undefined;
    }
    for (const [accessory, name] of names) {
      this.followNames(accessory, name);
    }
    // Locks of doors the intercom no longer has: drop them from the list too (they are removed below).
    for (const uuid of [...this.lockAccessories.keys()]) {
      if (!keep.has(uuid)) {
        this.lockAccessories.delete(uuid);
      }
    }
    const stale = [...this.accessories.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) {
        this.accessories.delete(a.UUID);
      }
      this.log.info(`Removed ${stale.length} stale accessory/accessories`);
    }
    this.applyFirmware();
  }
}

/** The plugin's version, for the Recent events tab ('?' if it can't be read). */
function pluginVersion(): string {
  try {
    return `plugin ${(JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '?'}`;
  } catch {
    return 'plugin ?';
  }
}
