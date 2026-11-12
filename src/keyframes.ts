/**
 * Debug log of the keyframes the intercom sends at the start of each call (2.3.3-beta.1).
 *
 * The 6741W has been seen to start a call with an old picture (from its previous call) before a
 * fresh one. This logs, for the first keyframes of every call: when each arrives after the ring,
 * its size, a short fingerprint, and whether it is a copy of a keyframe of the previous call.
 * The ring preview and the live view are traced apart (each may start with the old picture).
 * It only observes; nothing is changed. "new" means the bytes differ: an old picture encoded
 * again would also be "new" (its time and size still tell).
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

/** Where a call's video comes from: the ring preview, then (if answered) the live view. */
export type VideoSource = 'ring preview' | 'live view';

interface SourceTrace {
  /** The keyframe being received (its slices come one unit after another). */
  slices: Buffer[];
  lastType: number;
  logged: number;
  lastLoggedAt?: number;
}

interface CallTrace {
  born: number;
  sources: Map<VideoSource, SourceTrace>;
  keyframes: Keyframe[];
}

export class KeyframeTrace {
  private readonly calls = new Map<object, CallTrace>();
  /** Calls already over: video still arriving for them (just after a hang-up) is ignored. */
  private readonly over = new WeakSet<object>();
  /** The previous call's keyframes, newest last. */
  private previous: Keyframe[] = [];

  constructor(private readonly log: (line: string) => void) {}

  /** A video unit of `call` (a call that rang at `born`). */
  video(call: object, born: number, unit: Buffer, source: VideoSource, now = Date.now()): void {
    if (this.over.has(call)) {
      return;
    }
    let t = this.calls.get(call);
    if (!t) {
      t = { born, sources: new Map(), keyframes: [] };
      this.calls.set(call, t);
    }
    let v = t.sources.get(source);
    if (!v) {
      v = { slices: [], lastType: -1, logged: 0 };
      t.sources.set(source, v);
    }
    const type = nalType(unit);
    if (type === 5) {
      if (v.lastType !== 5) {
        v.slices = [];
      }
      v.slices.push(unit);
    } else if (v.lastType === 5) {
      this.keyframeDone(t, v, source, now);
    }
    v.lastType = type;
  }

  /** The call is over: its keyframes become "the previous call's". */
  ended(call: object, now = Date.now()): void {
    this.over.add(call);
    const t = this.calls.get(call);
    if (!t) {
      return;
    }
    this.calls.delete(call);
    for (const [source, v] of t.sources) {
      if (v.lastType === 5) {
        this.keyframeDone(t, v, source, now);
      }
    }
    const last = t.keyframes.at(-1);
    if (last) {
      this.log(
        `call: keyframes: ${t.keyframes.length} in this call; the last one ${fmt(last.at)} after the ring, ${last.bytes} bytes, fingerprint ${last.fingerprint}`,
      );
      this.previous = t.keyframes;
    }
  }

  private keyframeDone(t: CallTrace, v: SourceTrace, source: VideoSource, now: number): void {
    const hash = createHash('sha1');
    let bytes = 0;
    for (const s of v.slices) {
      hash.update(s);
      bytes += s.length;
    }
    v.slices = [];
    const k: Keyframe = { fingerprint: hash.digest('hex').slice(0, 10), bytes, at: now - t.born };
    if (v.logged < TRACE_KEYFRAMES && k.at <= TRACE_WINDOW_MS) {
      v.logged++;
      const gap = v.lastLoggedAt === undefined ? '' : `, ${fmt(k.at - v.lastLoggedAt)} after the one before`;
      const old = this.previous.find((p) => p.fingerprint === k.fingerprint);
      const copy = old ? `a copy of the previous call's keyframe from ${fmt(old.at)} after its ring` : 'new';
      this.log(`call: ${source} keyframe ${v.logged} ${fmt(k.at)} after the ring${gap}, ${k.bytes} bytes, fingerprint ${k.fingerprint} (${copy})`);
      v.lastLoggedAt = k.at;
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
