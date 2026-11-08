"use strict";
/**
 * VIP event listener — monitors a persistent CTPP channel for doorbell and call events.
 *
 * Binary CTPP message format:
 *   [prefix LE16] [timestamp LE32] [action BE16] [flags/param BE16]
 *   [extra bytes] [0xFFFFFFFF] [caller\0] [callee\0\0]
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VipEventListener = void 0;
const protocol_1 = require("./protocol");
const PREFIX_ACK = 0x1800;
const PREFIX_CONFIRM = 0x1820;
const PREFIX_VIDEO_EVENT = 0x1840;
const PREFIX_VIP_EVENT = 0x1860;
const PREFIX_CALL_INIT = 0x18c0;
const ACTION_IN_ALERTING = 0x0001;
const ACTION_DOOR_OPENED = 0x0003;
const ACTION_REGISTRATION_RENEWAL = 0x0010;
// Event ACK: only ONE counter increments (matches Python vip_listener.py)
const ACK_TS_INCREMENT = 0x01000000;
function zmanAckTs(t) { const c0 = (t & 0xff) ^ 0x80, c1 = (t >>> 8) & 0xff, s = (t >>> 16) & 0xff, a = (t >>> 24) & 0xff; return (c0 | (c1 << 8) | (a << 16) | (((s + 1) & 0xff) << 24)) >>> 0; } // zman: proper CTP ack
function zmanFinTs(t) { const c0 = (t & 0xff) ^ 0x80, c1 = (t >>> 8) & 0xff, s = (t >>> 16) & 0xff, a = (t >>> 24) & 0xff; return (c0 | (c1 << 8) | (a << 16) | (s << 24)) >>> 0; } // zman: close back
// zman: answer - experimental incoming-call handshake / answer
function zmanAddr(a) { const b = Buffer.alloc(10); b.write(String(a).slice(0, 10), 'ascii'); return b; }
function zmanFrame(c, flags, body) {
    const head = Buffer.from([flags, 0x18, c.c0 ^ 0x80, c.c1, c.seq & 0xff, c.ack & 0xff]);
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length);
    const pad = Buffer.alloc((4 - ((8 + body.length) % 4)) % 4);
    return Buffer.concat([head, len, body, pad, Buffer.from([0xff, 0xff, 0xff, 0xff]), zmanAddr(c.us), zmanAddr(c.peer)]);
}
const zmanCall = {
    calls: new Map(), waiters: [],
    hex(b) { return Buffer.from(b).toString('hex'); },
    active() { const now = Date.now(); for (const [k, c] of this.calls) if (c.ended || now - c.born > 120000) this.calls.delete(k); return [...this.calls.values()].pop(); },
    async send(vip, c, flags, body, what) {
        const buf = zmanFrame(c, flags, body);
        if (flags & 0x40) c.seq = (c.seq + 1) & 0xff;
        vip.log?.info(`zman-call tx ${what}: ${this.hex(buf.subarray(0, 8 + body.length))}`);
        await vip.client.sendBinary(vip.channel, buf);
    },
    async onMsg(vip, msg) {
        const d = msg.raw; if (!d || d.length < 8) return;
        const flags = d[0], c0 = d[2], c1 = d[3], s = d[4], a = d[5], key = (c1 << 8) | c0;
        const len = d.readUInt16BE(6), body = d.subarray(8, 8 + len), op = len >= 2 ? body.readUInt16BE(0) : -1;
        let c = this.calls.get(key);
        if (!c && flags === 0xc0 && op === 0x0001) {
            c = { c0, c1, seq: a, ack: (s + 1) & 0xff, us: `${vip.config.aptAddress}${vip.config.aptSubaddress}`,
                  peer: msg.addresses[0] ?? vip.config.aptAddress, born: Date.now(), seen: new Set(), ended: false };
            this.calls.set(key, c);
        }
        if (!c) return;
        vip.log?.info(`zman-call rx flags=0x${flags.toString(16)} seq=${s} ack=${a} op=0x${(op & 0xffff).toString(16)} body=${this.hex(body)}`);
        if (len > 0) c.ack = (s + 1) & 0xff;
        for (const w of this.waiters.slice()) if (w.c === c && (w.op === op || op === 0x000e)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res({ op, body }); }
        if (op === 0x000e || (flags & 0x20)) { c.ended = true; return; }
        const tag = `${s}:${op}`; if (c.seen.has(tag)) return; c.seen.add(tag);
        if (op === 0x0001) await this.send(vip, c, 0x40, Buffer.from(body), 'invite echo');
        else if (op === 0x0003) await this.send(vip, c, 0x40, Buffer.from('0003490027000000', 'hex'), 'capabilities');
    },
    wait(c, op, ms) { return new Promise((res) => { const w = { c, op, res }; this.waiters.push(w);
        setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); res(null); } }, ms); }); },
};
global.__zmanCallOpen = async (door) => {
    if (global.__zmanAnswerMode !== 'answer-on-open') return false;
    const vip = global.__zmanVip, c = zmanCall.active();
    if (!vip || !c) return false;
    vip.log?.info('zman-call: answering the ring to open the door');
    await zmanCall.send(vip, c, 0x40, Buffer.from('000c000000000000', 'hex'), 'answer 000c');
    await zmanCall.wait(c, 0x000c, 1500);
    const out = Number(door && (door.outputIndex ?? door.output ?? door.relay)) || 1;
    await zmanCall.send(vip, c, 0x40, Buffer.concat([Buffer.from([0x00, 0x2d]), zmanAddr(door.aptAddress), Buffer.from([out & 0xff])]), 'open in call');
    const r = await zmanCall.wait(c, 0x002d, 4000);
    vip.log?.info(`zman-call: open reply ${r ? `op=0x${r.op.toString(16)} body=${zmanCall.hex(r.body)}` : 'none within 4 s'}`);
    if (!c.ended) { await new Promise((z) => setTimeout(z, 1500)); await zmanCall.send(vip, c, 0x60, Buffer.from([0x00, 0x0e, 0x00]), 'hang up 000e'); c.ended = true; }
    return true;
};
const MIN_MSG_SIZE = 8;
const DEDUP_WINDOW_MS = 10_000;
function parseCtppMessage(data) {
    if (data.length < MIN_MSG_SIZE)
        return null;
    const prefix = data.readUInt16LE(0);
    const timestamp = data.readUInt32LE(2);
    const action = data.readUInt16BE(6);
    const msg = { prefix, timestamp, action, addresses: [], raw: data };
    if (data.length >= 10)
        msg.flags = data.readUInt16BE(8);
    // Extract addresses: null-terminated ASCII strings that follow the 0xFFFFFFFF marker.
    // This approach works for both "SB"-prefixed addresses and all-numeric addresses.
    const addresses = [];
    let markerIdx = -1;
    for (let i = 0; i <= data.length - 4; i++) {
        if (data[i] === 0xff && data[i + 1] === 0xff && data[i + 2] === 0xff && data[i + 3] === 0xff) {
            markerIdx = i;
            break;
        }
    }
    if (markerIdx >= 0) {
        let i = markerIdx + 4;
        while (i < data.length) {
            const nullIdx = data.indexOf(0, i);
            if (nullIdx < 0 || nullIdx === i)
                break;
            addresses.push(data.subarray(i, nullIdx).toString('ascii'));
            i = nullIdx + 1;
        }
    }
    msg.addresses = addresses;
    return msg;
}
class VipEventListener {
    client;
    config;
    callback;
    log;
    channel;
    running = false;
    loopPromise;
    lastFired = new Map();
    lastSeenTs = new Map(); // key → [ts, wallTime]
    constructor(client, config, callback, log) {
        this.client = client;
        this.config = config;
        this.callback = callback;
        this.log = log;
    }
    async start() {
        const ctpp = this.client.getChannel('CTPP');
        if (!ctpp)
            throw new Error('CTPP channel not open');
        this.channel = ctpp;
        this.running = true;
        global.__zmanVip = this; // zman: answer
        this.loopPromise = this._listenLoop().catch((e) => this.log?.warn(`VIP listener loop exited: ${e.message}`));
    }
    async stop() {
        this.running = false;
        this.channel?.responseQueue.clear();
        if (this.loopPromise) {
            await this.loopPromise.catch(() => undefined);
            this.loopPromise = undefined;
        }
    }
    async _listenLoop() {
        const channel = this.channel;
        while (this.running) {
            const data = await channel.responseQueue.dequeue(60_000);
            if (!this.running)
                break;
            if (data !== null) {
                await this._processMessage(data).catch((e) => this.log?.warn(`VIP: error processing message: ${e.message}`));
            }
        }
    }
    async _processMessage(data) {
        const msg = parseCtppMessage(data);
        if (!msg)
            return;
        const { prefix, action } = msg;
        const now = Date.now();
        const key = `${prefix}:${action}`;
        const last = this.lastSeenTs.get(key);
        const isRetransmit = last !== undefined && last[0] === msg.timestamp && now - last[1] < 10_000;
        this.lastSeenTs.set(key, [msg.timestamp, now]);
        this.log?.debug(`VIP msg: prefix=0x${prefix.toString(16).padStart(4, '0')} action=0x${action.toString(16).padStart(4, '0')} ts=0x${msg.timestamp.toString(16)} addrs=${msg.addresses.join(',')}`);
        // Periodic registration renewal — ACK with 0x1800+0x1820 pair
        if (prefix === PREFIX_VIP_EVENT && action === ACTION_REGISTRATION_RENEWAL) {
            await this._sendRenewalAck(msg);
            return;
        }
        // ACK call-init (0x18C0) messages
        if (prefix === PREFIX_CALL_INIT) {
            await this._sendEventAck(msg);
        }
        // ACK all 0x1840 and 0x1860 events (matches Python vip_listener.py)
        if (prefix === PREFIX_VIDEO_EVENT || prefix === PREFIX_VIP_EVENT) {
            await this._sendEventAck(msg);
        }
        // zman: close back when the panel closes (empty 0x1860), like comelit-vip
        if (prefix === PREFIX_VIP_EVENT && action === 0) {
            await this._sendEventAck(msg, true);
        }
        if (global.__zmanAnswerMode && global.__zmanAnswerMode !== 'off') await zmanCall.onMsg(this, msg).catch((e) => this.log?.warn(`zman-call: ${e.message}`)); // zman: answer
        if (isRetransmit && prefix === PREFIX_VIDEO_EVENT)
            return;
        if (prefix === PREFIX_CALL_INIT) {
            this._fireEvent('doorbell_ring', msg.addresses);
            return;
        }
        if (prefix === PREFIX_VIP_EVENT && action !== 0) {
            if (action === ACTION_IN_ALERTING) {
                this._fireEvent('doorbell_ring', msg.addresses);
            }
            else if (action === ACTION_DOOR_OPENED) {
                this._fireEvent('door_opened', msg.addresses);
            }
        }
    }
    async _sendEventAck(msg, zFin) {
        if (!this.running)
            return;
        const channel = this.channel;
        if (!channel)
            return;
        const vipAddress = `${this.config.aptAddress}${this.config.aptSubaddress}`;
        const entranceAddr = msg.addresses[0] ?? this.config.aptAddress;
        const ackTs = zmanAckTs(msg.timestamp);
        try {
            await this.client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(vipAddress, entranceAddr, zFin ? zmanFinTs(msg.timestamp) : ackTs, zFin ? 0x1820 : 0x1800));
        }
        catch (e) {
            this.log?.warn(`VIP: failed to send event ACK: ${e.message}`);
        }
    }
    async _sendRenewalAck(msg) {
        if (!this.running)
            return;
        const channel = this.channel;
        if (!channel)
            return;
        const vipAddress = `${this.config.aptAddress}${this.config.aptSubaddress}`;
        const aptAddr = this.config.aptAddress;
        const ackTs = zmanAckTs(msg.timestamp);
        this.log?.debug(`VIP: renewal ACK ts=0x${ackTs.toString(16)} caller=${vipAddress} callee=${aptAddr} msg-addrs=${msg.addresses.join(',')}`);
        try {
            await this.client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(vipAddress, aptAddr, ackTs));
            await this.client.sendBinary(channel, (0, protocol_1.encodeCallResponseAck)(vipAddress, aptAddr, ackTs, 0x1820));
            this.log?.info('VIP: sent renewal ACK pair');
        }
        catch (e) {
            this.log?.warn(`VIP: failed to send renewal ACK: ${e.message}`);
        }
    }
    _fireEvent(eventType, addresses) {
        const now = Date.now();
        const last = this.lastFired.get(eventType) ?? 0;
        if (now - last < DEDUP_WINDOW_MS)
            return;
        this.lastFired.set(eventType, now);
        this.log?.info(`VIP: firing ${eventType} (addrs=${addresses.join(',')})`);
        const caller = addresses[0] ?? '';
        try {
            this.callback({
                eventType,
                aptAddress: caller,
                timestamp: now / 1000,
                raw: { source: 'ctpp_vip', addresses },
            });
        }
        catch {
            // callback errors must not crash the listener
        }
    }
}
exports.VipEventListener = VipEventListener;
