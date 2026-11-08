"use strict";
/**
 * CTP frames carried on the CTPP channel.
 *
 *   [flags] [0x18] [conn0 conn1] [seq] [ack] [body length BE16] [body] [pad to 4]
 *   [0xFFFFFFFF] [source address, 10 bytes] [destination address, 10 bytes]
 *
 * flags: 0xC0 = new connection (SYN + data), 0x40 = data, 0x00 = ack, 0x20 = FIN, 0x60 = data + FIN.
 * The peer of a connection uses the same id with the top bit of the first byte flipped.
 * The body starts with a 16-bit opcode.
 *
 * Older code reads the first 6 bytes as a little-endian "prefix" (0x18 << 8 | flags) and
 * "timestamp" (conn0, conn1, seq, ack); the helpers below work on either view.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CAUSE_BUSY = void 0;
exports.parseFrame = parseFrame;
exports.logicalAddress = logicalAddress;
exports.buildFrame = buildFrame;
exports.ackWord = ackWord;
exports.finWord = finWord;
exports.peerKey = peerKey;
/** Release cause the intercom sends when a call is ringing and the sender didn't answer it. */
exports.CAUSE_BUSY = 8;
function parseFrame(raw) {
    if (raw.length < 8 || raw[1] !== 0x18) {
        return null;
    }
    const len = raw.readUInt16BE(6);
    const body = raw.subarray(8, Math.min(raw.length, 8 + len));
    return {
        flags: raw[0],
        conn0: raw[2],
        conn1: raw[3],
        seq: raw[4],
        ack: raw[5],
        body,
        opcode: body.length >= 2 ? body.readUInt16BE(0) : -1,
    };
}
/** A ViP address padded with zeros to 10 bytes, as used in the frame trailer. */
function logicalAddress(address) {
    const b = Buffer.alloc(10);
    Buffer.from(String(address), 'latin1').copy(b, 0, 0, 10);
    return b;
}
function buildFrame(o) {
    const head = Buffer.from([o.flags, 0x18, o.conn0, o.conn1, o.seq & 0xff, o.ack & 0xff, 0, 0]);
    head.writeUInt16BE(o.body.length, 6);
    const pad = Buffer.alloc((4 - ((8 + o.body.length) % 4)) % 4);
    return Buffer.concat([head, o.body, pad, Buffer.from([0xff, 0xff, 0xff, 0xff]), logicalAddress(o.source), logicalAddress(o.destination)]);
}
/**
 * The 32-bit word to put in an ACK for a frame whose first bytes after the flags are `t`
 * (little-endian conn0, conn1, seq, ack): flip the connection id, echo their ack as our
 * sequence, and acknowledge their sequence + 1.
 */
function ackWord(t) {
    const c0 = (t & 0xff) ^ 0x80;
    const c1 = (t >>> 8) & 0xff;
    const s = (t >>> 16) & 0xff;
    const a = (t >>> 24) & 0xff;
    return (c0 | (c1 << 8) | (a << 16) | (((s + 1) & 0xff) << 24)) >>> 0;
}
/** Same as ackWord, but for answering a FIN with a FIN: their sequence is not advanced. */
function finWord(t) {
    const c0 = (t & 0xff) ^ 0x80;
    const c1 = (t >>> 8) & 0xff;
    const s = (t >>> 16) & 0xff;
    const a = (t >>> 24) & 0xff;
    return (c0 | (c1 << 8) | (a << 16) | (s << 24)) >>> 0;
}
/** Key identifying a connection as seen from our side: the peer's id with the top bit flipped. */
function peerKey(conn0, conn1) {
    return `${conn0 ^ 0x80}:${conn1}`;
}
//# sourceMappingURL=ctp.js.map