/**
 * Debug log of the keyframes the intercom sends at the start of each call (2.3.3-beta.1).
 *
 * The 6741W has been seen to start a call with an old picture (from its previous call) before a
 * fresh one. This logs, for the first keyframes of every call: when each arrives after the ring,
 * its size, a short fingerprint, and whether it is a copy of a keyframe of the previous call.
 * It only observes; nothing is changed.
 */
import { createHash } from 'crypto';
import { nalType } from './media';

/** Keyframes logged at the start of each call. */
export const TRACE_KEYFRAMES = 4;
/** Only keyframes this soon after the ring are logged. */
export const TRACE_WINDOW_MS = 15_000;
/** Keyframes of a call kept to recognise a copy at the start of the next one. */
const KEEP_KEYFRAMES = 100;

interface Keyframe {
  fingerprint: string;
  bytes: number;
  /** Ms after the ring. */
  at: number;
}

interface CallTrace {
  born: number;
  /** The keyframe being received (its slices come one unit after another). */
  slices: Buffer[];
  lastType: number;
  logged: number;
  lastLoggedAt?: number;
  keyframes: Keyframe[];
}

export class KeyframeTrace {
  private readonly calls = new Map<object, CallTrace>();
  /** The previous call's keyframes, newest last. */
  private previous: Keyframe[] = [];

  constructor(private readonly log: (line: string) => void) {}

  /** A video unit of `call` (a call that rang at `born`). */
  video(call: object, born: number, unit: Buffer, now = Date.now()): void {
    let t = this.calls.get(call);
    if (!t) {
      t = { born, slices: [], lastType: -1, logged: 0, keyframes: [] };
      this.calls.set(call, t);
    }
    const type = nalType(unit);
    if (type === 5) {
      if (t.lastType !== 5) {
        t.slices = [];
      }
      t.slices.push(unit);
    } else if (t.lastType === 5) {
      this.keyframeDone(t, now);
    }
    t.lastType = type;
  }

  /** The call is over: its keyframes become "the previous call's". */
  ended(call: object, now = Date.now()): void {
    const t = this.calls.get(call);
    if (!t) {
      return;
    }
    this.calls.delete(call);
    if (t.lastType === 5) {
      this.keyframeDone(t, now);
    }
    const last = t.keyframes.at(-1);
    if (last) {
      this.log(
        `call: keyframes: ${t.keyframes.length} in this call; the last one ${fmt(last.at)} after the ring, ${last.bytes} bytes, fingerprint ${last.fingerprint}`,
      );
      this.previous = t.keyframes;
    }
  }

  private keyframeDone(t: CallTrace, now: number): void {
    const hash = createHash('sha1');
    let bytes = 0;
    for (const s of t.slices) {
      hash.update(s);
      bytes += s.length;
    }
    t.slices = [];
    const k: Keyframe = { fingerprint: hash.digest('hex').slice(0, 10), bytes, at: now - t.born };
    if (t.logged < TRACE_KEYFRAMES && k.at <= TRACE_WINDOW_MS) {
      t.logged++;
      const gap = t.lastLoggedAt === undefined ? '' : `, ${fmt(k.at - t.lastLoggedAt)} after the one before`;
      const old = this.previous.find((p) => p.fingerprint === k.fingerprint);
      const copy = old ? `a copy of the previous call's keyframe from ${fmt(old.at)} after its ring` : 'new';
      this.log(`call: keyframe ${t.logged} ${fmt(k.at)} after the ring${gap}, ${k.bytes} bytes, fingerprint ${k.fingerprint} (${copy})`);
      t.lastLoggedAt = k.at;
    }
    t.keyframes.push(k);
    if (t.keyframes.length > KEEP_KEYFRAMES) {
      t.keyframes.shift();
    }
  }
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}
