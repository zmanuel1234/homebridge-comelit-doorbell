/**
 * ICONA bridge framing (TCP 64100) and the binary messages sent on it.
 *
 * Every packet starts with an 8-byte header:
 *   [0x00 0x06] [body length LE16] [request/channel id LE16] [0x00 0x00]
 */

export const HEADER_SIZE = 8;

const enum MessageType {
  COMMAND = 0xabcd,
  END = 0x01ef,
}

// ─── Header ──────────────────────────────────────────────────────────────────

export function encodeHeader(bodyLength: number, requestId = 0): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE);
  buf[0] = 0x00;
  buf[1] = 0x06;
  buf.writeUInt16LE(bodyLength, 2);
  buf.writeUInt16LE(requestId, 4);
  return buf;
}

export function decodeHeader(data: Buffer): { bodyLength: number; requestId: number } {
  if (data.length < HEADER_SIZE) {
    throw new Error(`Header too short: ${data.length}`);
  }
  return { bodyLength: data.readUInt16LE(2), requestId: data.readUInt16LE(4) };
}

// ─── JSON messages ───────────────────────────────────────────────────────────

export type JsonMessage = Record<string, unknown>;

export function encodeJsonMessage(msg: JsonMessage, requestId: number): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  return Buffer.concat([encodeHeader(body.length, requestId), body]);
}

export function decodeJsonBody(body: Buffer): JsonMessage {
  return JSON.parse(body.toString('utf8')) as JsonMessage;
}

export function isJsonBody(body: Buffer): boolean {
  return body.length > 0 && body[0] === 0x7b; // '{'
}

// ─── Channel open / close ────────────────────────────────────────────────────

export function encodeChannelOpen(
  channelName: string,
  channelTypeId: number,
  sequence: number,
  requestId: number,
  extraData?: string,
  trailingByte = 0,
): Buffer {
  const seq = Buffer.alloc(4);
  seq.writeUInt16LE(MessageType.COMMAND, 0);
  seq.writeUInt16LE(sequence, 2);
  const typeBuf = Buffer.alloc(4);
  typeBuf.writeUInt32LE(channelTypeId, 0);
  const reqBuf = Buffer.alloc(3);
  reqBuf.writeUInt16LE(requestId, 0);
  reqBuf[2] = trailingByte;
  const parts = [seq, typeBuf, Buffer.from(channelName, 'ascii'), reqBuf];
  if (extraData) {
    const extraBytes = Buffer.from(extraData, 'ascii');
    const lenBuf = Buffer.alloc(5);
    lenBuf[0] = 0x00;
    lenBuf.writeUInt32LE(extraBytes.length + 1, 1);
    parts.push(lenBuf, extraBytes, Buffer.from([0x00]));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([encodeHeader(body.length, 0), body]);
}

export function encodeChannelOpenResponse(requestId: number): Buffer {
  const body = Buffer.alloc(12);
  body.writeUInt16LE(MessageType.COMMAND, 0);
  body.writeUInt16LE(2, 2);
  body.writeUInt32LE(4, 4);
  body.writeUInt16LE(requestId, 8);
  return Buffer.concat([encodeHeader(body.length, 0), body]);
}

export function encodeChannelClose(sequence: number, serverChannelId = 0): Buffer {
  const body = Buffer.alloc(4);
  body.writeUInt16LE(MessageType.END, 0);
  body.writeUInt16LE(sequence, 2);
  return Buffer.concat([encodeHeader(body.length, serverChannelId), body]);
}

/** Acknowledges a channel the device closed (END, sub-type 2), with sub-type 4. */
export function encodeChannelCloseAck(serverChannelId: number): Buffer {
  const body = Buffer.alloc(10);
  body.writeUInt16LE(MessageType.END, 0);
  body.writeUInt16LE(4, 2);
  body.writeUInt32LE(4, 4);
  body.writeUInt16LE(serverChannelId, 8);
  return Buffer.concat([encodeHeader(body.length, 0), body]);
}

/** Closes a channel by its handle (as comelit-vip does): END/3 on the management channel. */
export function encodeCloseChannel(handle: number): Buffer {
  const body = Buffer.alloc(10);
  body.writeUInt16LE(MessageType.END, 0);
  body.writeUInt16LE(3, 2);
  body.writeUInt32LE(2, 4);
  body.writeUInt16LE(handle, 8);
  return Buffer.concat([encodeHeader(body.length, 0), body]);
}

export function parseCommandResponse(body: Buffer): { msgType: number; seq: number; serverChannelId: number } {
  return {
    msgType: body.readUInt16LE(0),
    seq: body.readUInt16LE(2),
    serverChannelId: body.length >= 10 ? body.readUInt16LE(8) : 0,
  };
}

export function isCommand(msgType: number): boolean {
  return msgType === MessageType.COMMAND;
}

export function isEnd(msgType: number): boolean {
  return msgType === MessageType.END;
}

// ─── Binary helpers ──────────────────────────────────────────────────────────

function nullTerminated(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0x00])]);
}

function le16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v, 0);
  return b;
}

function le32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0, 0);
  return b;
}

// ─── CTPP messages that predate the CTP builder in ctp.ts ────────────────────

/** Registration (REGISTER, opcode 0x0040) for `aptAddress` + `aptSubaddress`. */
export function encodeCtppInit(aptAddress: string, aptSubaddress: number, timestamp: number): Buffer {
  const addrWithSub = `${aptAddress}${aptSubaddress}`;
  return Buffer.concat([
    le16(0x18c0),
    le32(timestamp),
    Buffer.from([0x00, 0x11]),
    Buffer.from([0x00, 0x40]),
    le16(timestamp & 0xffff),
    nullTerminated(addrWithSub),
    Buffer.from([0x10, 0x0e]),
    Buffer.alloc(4),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(addrWithSub),
    nullTerminated(aptAddress),
    Buffer.from([0x00]),
  ]);
}

/** Empty CTP frame (ACK 0x1800, or FIN 0x1820) using a precomputed connection/seq/ack word. */
export function encodeCallResponseAck(caller: string, callee: string, timestamp: number, prefix = 0x1800): Buffer {
  return Buffer.concat([
    le16(prefix),
    le32(timestamp),
    Buffer.from([0x00, 0x00]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(caller),
    Buffer.from(callee, 'ascii'),
    Buffer.from([0x00, 0x00]),
  ]);
}

export function encodeActuatorInit(aptAddress: string, outputIndex: number, actuatorAptAddress: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xc0, 0x18, 0x45, 0xbe]),
    Buffer.from([0x8f, 0x5c, 0x00, 0x04]),
    Buffer.from([0x00, 0x20, 0xff, 0x01]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(`${aptAddress}${outputIndex}`),
    nullTerminated(actuatorAptAddress),
    Buffer.from([0x00]),
  ]);
}

export function encodeActuatorOpen(aptAddress: string, outputIndex: number, actuatorAptAddress: string, confirm = false): Buffer {
  return Buffer.concat([
    Buffer.from([confirm ? 0x20 : 0x00, 0x18, 0x45, 0xbe]),
    Buffer.from([0x8f, 0x5c, 0x00, 0x04]),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    nullTerminated(`${aptAddress}${outputIndex}`),
    nullTerminated(actuatorAptAddress),
    Buffer.from([0x00]),
  ]);
}
