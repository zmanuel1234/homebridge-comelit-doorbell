"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComelitIntercomPlatform = void 0;
const settings_1 = require("./settings");
const client_1 = require("./client");
const auth_1 = require("./auth");
const configReader_1 = require("./configReader");
const push_1 = require("./push");
const ctpp_1 = require("./ctpp");
const channels_1 = require("./channels");
const door_1 = require("./door");
const vipListener_1 = require("./vipListener");
const lockAccessory_1 = require("./accessories/lockAccessory");
const doorbellAccessory_1 = require("./accessories/doorbellAccessory");
const cameraAccessory_1 = require("./accessories/cameraAccessory");
class ComelitIntercomPlatform {
    log;
    platformConfig;
    api;
    Service;
    Characteristic;
    cachedAccessories = [];
    lockAccessories = new Map();
    doorbellAccessory;
    cameraAccessories = new Map();
    client;
    config_;
    vipListener;
    keepaliveTimer;
    reconnectTimer;
    pushCallbacks = [];
    constructor(log, platformConfig, api) {
        this.log = log;
        this.platformConfig = platformConfig;
        this.api = api;
        this.Service = this.api.hap.Service;
        this.Characteristic = this.api.hap.Characteristic;
        this.api.on('didFinishLaunching', () => {
            this.setupDevice().catch((e) => this.log.error(`Initial setup failed: ${e.message}`));
        });
        this.api.on('shutdown', () => {
            this.teardown();
        });
    }
    configureAccessory(accessory) {
        this.cachedAccessories.push(accessory);
    }
    // ─── Device lifecycle ─────────────────────────────────────────────────────
    async setupDevice() {
        const { host, port, token, enableNotifications = true } = this.platformConfig;
        global.__zmanLeaseMs = (Number(this.platformConfig.leaseRefreshMinutes) > 0 ? Number(this.platformConfig.leaseRefreshMinutes) : 2) * 60000; // zman: lease refresh setting
        global.__zmanLeaseMode = this.platformConfig.leaseRefreshMode === 'inplace' ? 'inplace' : 'reconnect'; // zman: inplace
        { const zc = this.platformConfig; // zman: settings
          global.__zmanRecycleMs = (Number(zc.leaseRecycleMinutes) > 0 ? Number(zc.leaseRecycleMinutes) : 50) * 60000;
          global.__zmanRingWindowMs = (zc.ringWindowSeconds === undefined || zc.ringWindowSeconds === null || zc.ringWindowSeconds === '' ? 90 : Number(zc.ringWindowSeconds)) * 1000;
          global.__zmanDoorbellUrl = (zc.doorbellTriggerUrl === undefined ? 'http://localhost:8089/doorbell?Doorbell' : String(zc.doorbellTriggerUrl)).trim();
          global.__zmanRegisterPush = zc.registerPush === true; }
        global.__zmanAnswerMode = ['handshake', 'answer-on-open'].includes(this.platformConfig.answerMode) ? this.platformConfig.answerMode : 'off'; // zman: answer
        global.__zmanReregister = async () => {
            const ch = this.client && this.client.getChannel('CTPP');
            const cfg = this.config_;
            if (!ch || !cfg) throw new Error('CTPP channel not open');
            await this.client.sendBinary(ch, require('./protocol').encodeCttpInit(cfg.aptAddress, cfg.aptSubaddress, Date.now() / 1000 | 0));
            this.log.info('Registration renewed in place');
        };
        if (!host || !token) {
            this.log.error('Missing required config: host and token are required');
            return;
        }
        this.log.info(`Connecting to ${host}:${port ?? 64100} …`);
        const client = new client_1.IconaBridgeClient(host, port, this.log);
        try {
            await client.connect();
        }
        catch (e) {
            this.log.error(`Connection failed: ${e.message}`);
            this.scheduleReconnect();
            return;
        }
        try {
            await (0, auth_1.authenticate)(client, token);
            this.log.info('Authenticated');
        }
        catch (e) {
            this.log.error(`Authentication failed: ${e.message}`);
            await client.disconnect();
            this.scheduleReconnect();
            return;
        }
        let deviceConfig;
        try {
            deviceConfig = await (0, configReader_1.getDeviceConfig)(client);
            // zman: register with our own sub-address so we don't clash with the phone app
            if (Number.isInteger(this.platformConfig.subaddress)) {
                deviceConfig.aptSubaddress = this.platformConfig.subaddress;
            }
            this.log.info(`Device config: ${deviceConfig.doors.length} door(s), apt=${deviceConfig.aptAddress}${deviceConfig.aptSubaddress}`);
        }
        catch (e) {
            this.log.error(`Config fetch failed: ${e.message}`);
            await client.disconnect();
            this.scheduleReconnect();
            return;
        }
        try {
            await (0, push_1.registerPush)(client, deviceConfig, (event) => this.onPushEvent(event));
        }
        catch (e) {
            this.log.warn(`Push registration failed (non-fatal): ${e.message}`);
        }
        // Set up client and disconnect callback before CTPP init so that if the
        // device closes during the handshake, onClientDisconnect fires and the
        // reconnect loop is properly triggered.
        this.client = client;
        this.config_ = deviceConfig;
        client.setDisconnectCallback(() => this.onClientDisconnect());
        if (enableNotifications) {
            try {
                await this.openCtppChannels(client, deviceConfig);
                this.log.info('CTPP channels open for VIP events');
            }
            catch (e) {
                this.log.warn(`CTPP setup failed (notifications disabled): ${e.message}`);
            }
        }
        if (!client.connected) {
            // Device closed the connection during CTPP setup; onClientDisconnect already
            // scheduled the reconnect — just bail so we don't report "ready" on a dead link.
            return;
        }
        if (enableNotifications && client.getChannel('CTPP')) {
            const listener = new vipListener_1.VipEventListener(client, deviceConfig, (ev) => this.onPushEvent(ev), this.log);
            this.vipListener = listener;
            await listener.start().catch((e) => this.log.warn(`VIP listener start failed: ${e.message}`));
        }
        this.startKeepalive(deviceConfig);
        this.discoverAccessories(deviceConfig);
        this.log.info('Comelit Intercom ready');
    }
    async openCtppChannels(client, config) {
        const ourAddr = `${config.aptAddress}${config.aptSubaddress}`;
        // VIP CTPP uses ChannelType.UAUT (7) — faithful to coordinator.py
        await client.openChannel('CTPP', channels_1.ChannelType.UAUT, ourAddr);
        await client.openChannel('CSPB', channels_1.ChannelType.UAUT);
        const ts = (Date.now() / 1000) | 0;
        const ctpp = client.getChannel('CTPP');
        // sendAck=false: do NOT send 0x1800+0x1820 after init.
        // On this device those packets are interpreted as a call hang-up on an
        // idle channel, causing the device to immediately close the connection.
        // The VIP listener will ACK renewals and events using the correct
        // per-message timestamp when they actually arrive.
        await (0, ctpp_1.ctppInitSequence)(client, ctpp, config.aptAddress, config.aptSubaddress, ourAddr, ts, 2_000, false, this.log);
    }
    teardown() {
        this.stopKeepalive();
        clearTimeout(this.reconnectTimer);
        this.vipListener?.stop().catch(() => undefined);
        this.vipListener = undefined;
        this.client?.disconnect().catch(() => undefined);
        this.client = undefined;
    }
    onClientDisconnect() {
        this.log.warn('Device disconnected — scheduling reconnect');
        this.stopKeepalive();
        this.vipListener?.stop().catch(() => undefined);
        this.vipListener = undefined;
        this.client = undefined;
        // Mark all doors as unreachable
        for (const lock of this.lockAccessories.values()) {
            lock.onDisconnect();
        }
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        clearTimeout(this.reconnectTimer);
        const delayMs = (this.platformConfig.reconnectDelay ?? 10) * 1000;
        this.log.info(`Reconnecting in ${delayMs / 1000} s …`);
        this.reconnectTimer = setTimeout(() => {
            this.setupDevice().catch((e) => this.log.error(`Reconnect failed: ${e.message}`));
        }, delayMs);
    }
    // ─── Keepalive ────────────────────────────────────────────────────────────
    startKeepalive(config) {
        this.stopKeepalive();
        this.keepaliveTimer = setInterval(async () => {
            if (!this.client)
                return;
            try {
                await (0, push_1.sendPushKeepalive)(this.client, config);
            }
            catch (e) {
                this.log.warn(`Keepalive failed: ${e.message}`);
            }
        }, settings_1.KEEPALIVE_INTERVAL_MS);
    }
    stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = undefined;
        }
    }
    // ─── Push events ──────────────────────────────────────────────────────────
    onPushEvent(event) {
        this.log.info(`Event: ${event.eventType} from ${event.aptAddress}`);
        if (event.eventType === 'doorbell_ring') {
            this.doorbellAccessory?.triggerRing();
        }
        for (const cb of this.pushCallbacks) {
            try {
                cb(event);
            }
            catch { /* ignore */ }
        }
    }
    addPushCallback(cb) {
        this.pushCallbacks.push(cb);
    }
    // ─── Door open ────────────────────────────────────────────────────────────
    async openDoor(door) {
        if (!this.client || !this.config_) {
            throw new Error('Not connected');
        }
        await (0, door_1.openDoor)(this.client, this.config_, door);
    }
    // ─── Accessory discovery ──────────────────────────────────────────────────
    discoverAccessories(config) {
        const staleUuids = new Set(this.cachedAccessories.map((a) => a.UUID));
        // Door locks
        for (const door of config.doors) {
            const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_SEED}-lock-${door.index}`);
            staleUuids.delete(uuid);
            let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
            const isNew = !accessory;
            if (!accessory) {
                accessory = new this.api.platformAccessory(door.name || `Door ${door.index + 1}`, uuid);
                accessory.context.door = door;
            }
            const lockAcc = new lockAccessory_1.LockAccessory(this, accessory, door);
            this.lockAccessories.set(uuid, lockAcc);
            if (isNew) {
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.log.info(`Registered door: ${door.name}`);
            }
            else {
                this.api.updatePlatformAccessories([accessory]);
            }
        }
        // Doorbell (one per platform instance)
        {
            const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_SEED}-doorbell`);
            staleUuids.delete(uuid);
            let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
            const isNew = !accessory;
            if (!accessory) {
                accessory = new this.api.platformAccessory(this.platformConfig.name || 'Comelit Doorbell', uuid);
            }
            this.doorbellAccessory = new doorbellAccessory_1.DoorbellAccessory(this, accessory);
            if (isNew) {
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.log.info('Registered doorbell');
            }
            else {
                this.api.updatePlatformAccessories([accessory]);
            }
        }
        // RTSP cameras from device config (if any)
        for (const camera of config.cameras) {
            const uuid = this.api.hap.uuid.generate(`${settings_1.UUID_SEED}-camera-${camera.id}`);
            staleUuids.delete(uuid);
            let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
            const isNew = !accessory;
            if (!accessory) {
                accessory = new this.api.platformAccessory(camera.name || `Camera ${camera.id}`, uuid);
                accessory.context.camera = camera;
            }
            const camAcc = new cameraAccessory_1.CameraAccessory(this, accessory, camera);
            this.cameraAccessories.set(uuid, camAcc);
            if (isNew) {
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.log.info(`Registered camera: ${camera.name}`);
            }
            else {
                this.api.updatePlatformAccessories([accessory]);
            }
        }
        // Remove accessories that no longer exist
        const toRemove = this.cachedAccessories.filter((a) => staleUuids.has(a.UUID));
        if (toRemove.length > 0) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, toRemove);
            this.log.info(`Removed ${toRemove.length} stale accessory/accessories`);
        }
    }
}
exports.ComelitIntercomPlatform = ComelitIntercomPlatform;
