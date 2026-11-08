/**
 * Media carried inside a ViP call: RTP packets on RTPC channels, H.264 video (RFC 6184)
 * and G.711 A-law audio (payload type 8, 8 kHz mono, 20 ms packets).
 */

export const ALAW_PAYLOAD_TYPE = 8;
/** 20 ms of 8 kHz audio. */
export const ALAW_FRAME_BYTES = 160;

export interface RtpPacket {
  marker: boolean;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

/** Parses an RTP v2 packet, skipping CSRCs, header extension and padding. */
export function parseRtp(raw: Buffer): RtpPacket | null {
  if (raw.length < 12 || raw[0] >> 6 !== 2) {
    return null;
  }
  const csrcCount = raw[0] & 0x0f;
  let offset = 12 + csrcCount * 4;
  if (raw[0] & 0x10) {
    if (raw.length < offset + 4) {
      return null;
    }
    offset += 4 + raw.readUInt16BE(offset + 2) * 4;
  }
  let end = raw.length;
  if (raw[0] & 0x20) {
    end -= raw[raw.length - 1];
  }
  if (offset > end) {
    return null;
  }
  return {
    marker: Boolean(raw[1] & 0x80),
    payloadType: raw[1] & 0x7f,
    sequence: raw.readUInt16BE(2),
    timestamp: raw.readUInt32BE(4),
    ssrc: raw.readUInt32BE(8),
    payload: raw.subarray(offset, end),
  };
}

export function buildRtp(p: Omit<RtpPacket, 'payload'>, payload: Buffer): Buffer {
  const head = Buffer.alloc(12);
  head[0] = 0x80;
  head[1] = (p.marker ? 0x80 : 0) | (p.payloadType & 0x7f);
  head.writeUInt16BE(p.sequence & 0xffff, 2);
  head.writeUInt32BE(p.timestamp >>> 0, 4);
  head.writeUInt32BE(p.ssrc >>> 0, 8);
  return Buffer.concat([head, payload]);
}

const START_CODE = Buffer.from([0, 0, 0, 1]);

/** Turns H.264 RTP payloads (single NAL, STAP-A, FU-A) into Annex-B NAL units. */
export class H264Depacketizer {
  private fragment: Buffer[] | null = null;
  private expected: number | null = null;

  push(packet: RtpPacket): Buffer[] {
    const p = packet.payload;
    if (p.length === 0) {
      return [];
    }
    const type = p[0] & 0x1f;
    if (type >= 1 && type <= 23) {
      this.fragment = null;
      return [Buffer.concat([START_CODE, p])];
    }
    if (type === 24) {
      const units: Buffer[] = [];
      let i = 1;
      while (i + 2 <= p.length) {
        const size = p.readUInt16BE(i);
        i += 2;
        if (size === 0 || i + size > p.length) {
          break;
        }
        units.push(Buffer.concat([START_CODE, p.subarray(i, i + size)]));
        i += size;
      }
      return units;
    }
    if (type !== 28 || p.length < 2) {
      return [];
    }
    const start = (p[1] & 0x80) !== 0;
    const end = (p[1] & 0x40) !== 0;
    if (start) {
      this.fragment = [START_CODE, Buffer.from([(p[0] & 0xe0) | (p[1] & 0x1f)]), p.subarray(2)];
    } else if (this.fragment && this.expected === packet.sequence) {
      this.fragment.push(p.subarray(2));
    } else {
      // A lost fragment: drop the unit.
      this.fragment = null;
      this.expected = null;
      return [];
    }
    this.expected = (packet.sequence + 1) & 0xffff;
    if (end) {
      const unit = Buffer.concat(this.fragment);
      this.fragment = null;
      this.expected = null;
      return [unit];
    }
    return [];
  }
}

/** NAL unit type of an Annex-B unit (after the 4-byte start code). */
export function nalType(unit: Buffer): number {
  return unit.length > 4 ? unit[4] & 0x1f : -1;
}

/**
 * Keeps the latest SPS, PPS and keyframe, so a snapshot or a new viewer can start from a
 * decodable picture.
 */
export class KeyframeCache {
  private sps?: Buffer;
  private pps?: Buffer;
  private idr?: Buffer[];
  private lastType = -1;

  push(unit: Buffer): void {
    const type = nalType(unit);
    if (type === 7) {
      this.sps = unit;
    } else if (type === 8) {
      this.pps = unit;
    } else if (type === 5) {
      // Slices of one keyframe arrive back to back; a new run starts a new keyframe.
      this.idr = this.lastType === 5 && this.idr ? [...this.idr, unit] : [unit];
    }
    this.lastType = type;
  }

  /** SPS + PPS + the latest keyframe, or undefined if none has arrived yet. */
  keyframe(): Buffer | undefined {
    if (!this.sps || !this.pps || !this.idr || this.idr.length === 0) {
      return undefined;
    }
    return Buffer.concat([this.sps, this.pps, ...this.idr]);
  }
}
