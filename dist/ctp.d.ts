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
export declare const enum Flag {
    ACK = 0,
    FIN = 32,
    DATA = 64,
    DATA_FIN = 96,
    SYN = 192
}
export declare const enum Opcode {
    INVITE = 1,
    CAPABILITIES = 3,
    SETUP_ACK = 12,
    RELEASE = 14,
    MEDIA_REQUEST = 17,
    OPEN_DOOR = 45,
    REGISTER = 64,
    REGISTER_RESPONSE = 65
}
/** Release cause the intercom sends when a call is ringing and the sender didn't answer it. */
export declare const CAUSE_BUSY = 8;
export interface CtpFrame {
    flags: number;
    conn0: number;
    conn1: number;
    seq: number;
    ack: number;
    body: Buffer;
    /** First 16 bits of the body, or -1 for an empty frame. */
    opcode: number;
}
export declare function parseFrame(raw: Buffer): CtpFrame | null;
/** A ViP address padded with zeros to 10 bytes, as used in the frame trailer. */
export declare function logicalAddress(address: string): Buffer;
export interface FrameOptions {
    flags: number;
    conn0: number;
    conn1: number;
    seq: number;
    ack: number;
    body: Buffer;
    source: string;
    destination: string;
}
export declare function buildFrame(o: FrameOptions): Buffer;
/**
 * The 32-bit word to put in an ACK for a frame whose first bytes after the flags are `t`
 * (little-endian conn0, conn1, seq, ack): flip the connection id, echo their ack as our
 * sequence, and acknowledge their sequence + 1.
 */
export declare function ackWord(t: number): number;
/** Same as ackWord, but for answering a FIN with a FIN: their sequence is not advanced. */
export declare function finWord(t: number): number;
/** Key identifying a connection as seen from our side: the peer's id with the top bit flipped. */
export declare function peerKey(conn0: number, conn1: number): string;
