"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallHandler = void 0;
const ctp_1 = require("./ctp");
/** The capabilities the Comelit app sends. */
const APP_CAPABILITIES = Buffer.from('0003490027000000', 'hex');
const CALL_MAX_AGE_MS = 120_000;
const hex = (b) => b.toString('hex');
class CallHandler {
    mode;
    ourAddress;
    defaultPeer;
    sendFrame;
    log;
    calls = new Map();
    waiters = [];
    constructor(mode, ourAddress, defaultPeer, sendFrame, log) {
        this.mode = mode;
        this.ourAddress = ourAddress;
        this.defaultPeer = defaultPeer;
        this.sendFrame = sendFrame;
        this.log = log;
    }
    get enabled() {
        return this.mode !== 'off';
    }
    /** The most recent call still in progress, if any. */
    activeCall() {
        const now = Date.now();
        for (const [key, call] of this.calls) {
            if (call.ended || now - call.born > CALL_MAX_AGE_MS) {
                this.calls.delete(key);
            }
        }
        return [...this.calls.values()].pop();
    }
    async onFrame(frame, addresses) {
        if (!this.enabled) {
            return;
        }
        const key = (frame.conn1 << 8) | frame.conn0;
        let call = this.calls.get(key);
        if (!call && frame.flags === 192 /* Flag.SYN */ && frame.opcode === 1 /* Opcode.INVITE */) {
            call = {
                conn0: frame.conn0,
                conn1: frame.conn1,
                seq: frame.ack,
                ack: (frame.seq + 1) & 0xff,
                peer: addresses[0] ?? this.defaultPeer,
                born: Date.now(),
                seen: new Set(),
                ended: false,
            };
            this.calls.set(key, call);
        }
        if (!call) {
            return;
        }
        this.log?.info(`call: rx flags=0x${frame.flags.toString(16)} seq=${frame.seq} ack=${frame.ack} op=0x${(frame.opcode & 0xffff).toString(16)} body=${hex(frame.body)}`);
        if (frame.body.length > 0) {
            call.ack = (frame.seq + 1) & 0xff;
        }
        for (const w of this.waiters.slice()) {
            if (w.call === call && (w.opcode === frame.opcode || frame.opcode === 14 /* Opcode.RELEASE */)) {
                this.waiters.splice(this.waiters.indexOf(w), 1);
                w.resolve({ opcode: frame.opcode, body: frame.body });
            }
        }
        if (frame.opcode === 14 /* Opcode.RELEASE */ || frame.flags & 32 /* Flag.FIN */) {
            call.ended = true;
            return;
        }
        const tag = `${frame.seq}:${frame.opcode}`;
        if (call.seen.has(tag)) {
            return; // retransmission
        }
        call.seen.add(tag);
        if (frame.opcode === 1 /* Opcode.INVITE */) {
            await this.send(call, 64 /* Flag.DATA */, Buffer.from(frame.body), 'invite echo');
        }
        else if (frame.opcode === 3 /* Opcode.CAPABILITIES */) {
            await this.send(call, 64 /* Flag.DATA */, APP_CAPABILITIES, 'capabilities');
        }
    }
    /**
     * In `answer-on-open` mode with a call ringing: answer it, open `door` inside the call,
     * then hang up. Returns null when there is nothing to answer, so the caller opens the
     * normal way.
     */
    async openInCall(door) {
        if (this.mode !== 'answer-on-open') {
            return null;
        }
        const call = this.activeCall();
        if (!call) {
            return null;
        }
        this.log?.info('call: answering the ring to open the door');
        await this.send(call, 64 /* Flag.DATA */, Buffer.from('000c000000000000', 'hex'), 'answer 000c');
        await this.wait(call, 12 /* Opcode.SETUP_ACK */, 1500);
        const output = Number(door.outputIndex) || 1;
        const openBody = Buffer.concat([Buffer.from([0x00, 0x2d]), (0, ctp_1.logicalAddress)(door.aptAddress), Buffer.from([output & 0xff])]);
        await this.send(call, 64 /* Flag.DATA */, openBody, 'open in call');
        const reply = await this.wait(call, 45 /* Opcode.OPEN_DOOR */, 4000);
        this.log?.info(`call: open reply ${reply ? `op=0x${reply.opcode.toString(16)} body=${hex(reply.body)}` : 'none within 4 s'}`);
        if (!call.ended) {
            await new Promise((r) => setTimeout(r, 1500));
            await this.send(call, 96 /* Flag.DATA_FIN */, Buffer.from([0x00, 0x0e, 0x00]), 'hang up 000e');
            call.ended = true;
        }
        const released = reply && reply.opcode === 14 /* Opcode.RELEASE */ && reply.body.length >= 3;
        if (released && reply.body[2] !== 0) {
            throw new Error(`intercom refused the open in the call (cause ${reply.body[2]})`);
        }
        return { confirmed: Boolean(released && reply.body[2] === 0) };
    }
    async send(call, flags, body, what) {
        const frame = (0, ctp_1.buildFrame)({
            flags,
            conn0: call.conn0 ^ 0x80,
            conn1: call.conn1,
            seq: call.seq,
            ack: call.ack,
            body,
            source: this.ourAddress,
            destination: call.peer,
        });
        if (flags & 64 /* Flag.DATA */) {
            call.seq = (call.seq + 1) & 0xff;
        }
        this.log?.info(`call: tx ${what}: ${hex(frame.subarray(0, 8 + body.length))}`);
        await this.sendFrame(frame);
    }
    wait(call, opcode, ms) {
        return new Promise((resolve) => {
            const waiter = { call, opcode, resolve };
            this.waiters.push(waiter);
            setTimeout(() => {
                const i = this.waiters.indexOf(waiter);
                if (i >= 0) {
                    this.waiters.splice(i, 1);
                    resolve(null);
                }
            }, ms);
        });
    }
}
exports.CallHandler = CallHandler;
//# sourceMappingURL=call.js.map