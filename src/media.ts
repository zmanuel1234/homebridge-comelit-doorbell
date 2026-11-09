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
  /** When the latest keyframe arrived (ms since epoch). */
  private at = 0;
  /**
   * The call's first keyframe, kept as the last visitor's picture: at the start of a call the
   * visitor stands at the panel; at its end they have often gone in already.
   */
  private visitorFrame?: { frame: Buffer; at: number };
  private call?: unknown;
  private wantVisitor = false;

  /** A call's video starts (the same call can be viewed more than once). */
  newCall(call: unknown): void {
    if (call !== this.call) {
      this.call = call;
      this.wantVisitor = true;
    }
  }

  /** The last call's first keyframe, if younger than maxAgeMs. */
  visitor(maxAgeMs = Infinity): Buffer | undefined {
    const v = this.visitorFrame;
    return v && Date.now() - v.at <= maxAgeMs ? v.frame : undefined;
  }

  push(unit: Buffer): void {
    const type = nalType(unit);
    if (this.wantVisitor && this.lastType === 5 && type !== 5) {
      // The first keyframe of the call is complete (its slices came back to back).
      const frame = this.keyframe();
      if (frame) {
        this.visitorFrame = { frame, at: this.at };
        this.wantVisitor = false;
      }
    }
    if (type === 7) {
      this.sps = unit;
    } else if (type === 8) {
      this.pps = unit;
    } else if (type === 5) {
      // Slices of one keyframe arrive back to back; a new run starts a new keyframe.
      this.idr = this.lastType === 5 && this.idr ? [...this.idr, unit] : [unit];
      this.at = Date.now();
    }
    this.lastType = type;
  }

  /** SPS + PPS + the latest keyframe, or undefined if none has arrived (within `maxAgeMs`). */
  keyframe(maxAgeMs = Infinity): Buffer | undefined {
    if (!this.sps || !this.pps || !this.idr || this.idr.length === 0 || Date.now() - this.at > maxAgeMs) {
      return undefined;
    }
    return Buffer.concat([this.sps, this.pps, ...this.idr]);
  }
}

/** Picture size and profile from an H.264 SPS, for the log. */
export interface SpsInfo {
  width: number;
  height: number;
  profile: number;
  level: number;
}

/**
 * Reads the picture size from an Annex-B SPS unit. Returns undefined for anything it can't
 * read (including the rare SPS with scaling matrices), since this is only used for logging.
 */
export function parseSps(unit: Buffer): SpsInfo | undefined {
  if (nalType(unit) !== 7) {
    return undefined;
  }
  // Remove emulation-prevention bytes (00 00 03 -> 00 00).
  const raw: number[] = [];
  for (let i = 5; i < unit.length; i++) {
    if (i >= 7 && unit[i] === 3 && unit[i - 1] === 0 && unit[i - 2] === 0) {
      continue;
    }
    raw.push(unit[i]);
  }
  let bit = 0;
  const u = (n: number): number => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const byte = raw[bit >> 3];
      if (byte === undefined) {
        throw new Error('short SPS');
      }
      v = v * 2 + ((byte >> (7 - (bit & 7))) & 1);
      bit++;
    }
    return v;
  };
  const ue = (): number => {
    let zeros = 0;
    while (u(1) === 0) {
      if (++zeros > 31) {
        throw new Error('bad SPS');
      }
    }
    return 2 ** zeros - 1 + u(zeros);
  };
  const se = (): number => {
    const k = ue();
    return k % 2 ? (k + 1) / 2 : -k / 2;
  };
  try {
    const profile = u(8);
    u(8); // constraint flags
    const level = u(8);
    ue(); // sps id
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue();
      if (chroma === 3) {
        u(1);
      }
      ue();
      ue();
      u(1);
      if (u(1)) {
        return undefined; // scaling matrices: not worth parsing for a log line
      }
    }
    ue(); // log2_max_frame_num_minus4
    const pocType = ue();
    if (pocType === 0) {
      ue();
    } else if (pocType === 1) {
      u(1);
      se();
      se();
      const n = ue();
      for (let i = 0; i < n; i++) {
        se();
      }
    }
    ue(); // max_num_ref_frames
    u(1);
    const wMbs = ue() + 1;
    const hUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (!frameMbsOnly) {
      u(1);
    }
    u(1);
    let [l, r, t, b] = [0, 0, 0, 0];
    if (u(1)) {
      [l, r, t, b] = [ue(), ue(), ue(), ue()];
    }
    const cropX = chroma === 0 || chroma === 3 ? 1 : 2;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    return { width: wMbs * 16 - (l + r) * cropX, height: (2 - frameMbsOnly) * hUnits * 16 - (t + b) * cropY, profile, level };
  } catch {
    return undefined;
  }
}
