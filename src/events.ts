/**
 * Recent events: a short history of what the plugin saw and did (rings, door opens and what
 * opened them, refused unlocks, live views, the connection), kept in a small file in
 * Homebridge's storage folder so it survives restarts and log trimming (30 days by default,
 * setting eventHistoryDays; at most 2,000 events). Shown in the plugin's
 * settings (Recent events tab). Holds no tokens or personal data: only times, door names and
 * what happened.
 */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';

/** The file, in Homebridge's storage folder. */
export const EVENTS_FILE = 'comelit-doorbell-events.json';
/** How long events are kept by default (setting eventHistoryDays). */
export const DEFAULT_EVENT_DAYS = 30;
/** At most this many events are kept, whatever the days (the oldest go first): a safety cap. */
export const MAX_EVENTS = 2000;
/** How long after a ring a view or an open counts as its outcome. */
const RING_OUTCOME_MS = 120_000;
/** Writes are grouped: at most one per this long. */
const SAVE_DELAY_MS = 2_000;
/** A ring reported again within this long (push and the ViP channel can both report one) is the same ring. */
const SAME_RING_MS = 5_000;

/** Error texts can name the intercom's address (host:port): kept out of the history. */
function plain(text: string): string {
  return text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, 'the intercom');
}

export type EventKind =
  | 'start' // Homebridge started the plugin
  | 'connected'
  | 'disconnected'
  | 'ring'
  | 'open' // a door opened by the plugin (HomeKit, doctor mode, Next Visitor, an actuator)
  | 'open-failed'
  | 'refused' // an unlock HomeKit asked for and the plugin refused
  | 'view' // a live view
  | 'mode'; // doctor mode or Next Visitor turned on or off

export interface RecentEvent {
  /** Date.now() */
  t: number;
  kind: EventKind;
  text: string;
  /** Added when shown: what happened after a ring (viewed, opened, nothing). */
  note?: string;
}

const KINDS: readonly EventKind[] = ['start', 'connected', 'disconnected', 'ring', 'open', 'open-failed', 'refused', 'view', 'mode'];

function valid(e: unknown): e is RecentEvent {
  const x = e as RecentEvent;
  return Boolean(x) && typeof x.t === 'number' && Number.isFinite(x.t) && KINDS.includes(x.kind) && typeof x.text === 'string';
}

/** The events in a file, oldest first; none if it is missing or unreadable. */
export function readEvents(file: string): RecentEvent[] {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(data) ? data.filter(valid).map(({ t, kind, text }) => ({ t, kind, text })) : [];
  } catch {
    return [];
  }
}

/**
 * Adds to each ring what followed it within two minutes, before the next ring: viewed (how
 * long), opened (by what), or neither. Newest first, for showing.
 */
export function describeEvents(events: RecentEvent[]): RecentEvent[] {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const out = sorted.map((e) => ({ ...e }));
  out.forEach((e, i) => {
    if (e.kind !== 'ring') {
      return;
    }
    const after: RecentEvent[] = [];
    for (const n of out.slice(i + 1)) {
      if (n.kind === 'ring' || n.t - e.t > RING_OUTCOME_MS) {
        break;
      }
      after.push(n);
    }
    const viewed = after.filter((n) => n.kind === 'view');
    const opened = after.find((n) => n.kind === 'open');
    const parts: string[] = [];
    if (viewed.length) {
      parts.push(`viewed${viewed.length > 1 ? ` ${viewed.length} times` : ''}`);
    }
    parts.push(opened ? `opened ${Math.round((opened.t - e.t) / 1000)} s later` : 'not opened by Homebridge');
    e.note = parts.join(', ');
  });
  return out.reverse();
}

/** The plugin's side: adds events and saves them (grouped, written whole, never throws). */
export class EventLog {
  private events: RecentEvent[];
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  /**
   * `file` undefined: kept in memory only (no storage folder, tests). Events older than `days`
   * go, and at most `max` are kept.
   */
  constructor(
    private readonly file?: string,
    private readonly max = MAX_EVENTS,
    private readonly days = DEFAULT_EVENT_DAYS,
  ) {
    this.events = file ? readEvents(file).sort((a, b) => a.t - b.t) : [];
    this.prune();
  }

  /** Drops events older than the days kept, and the oldest beyond the cap. */
  private prune(): void {
    const from = Date.now() - this.days * 86_400_000;
    const old = this.events.findIndex((e) => e.t >= from);
    this.events.splice(0, old === -1 ? this.events.length : old);
    if (this.events.length > this.max) {
      this.events.splice(0, this.events.length - this.max);
    }
  }

  /** `t`: when it happened, if not now (a live view is noted when it ends, timed from its start). */
  add(kind: EventKind, text: string, t = Date.now()): void {
    if (kind === 'ring') {
      const last = [...this.events].reverse().find((e) => e.kind === 'ring');
      if (last && t - last.t < SAME_RING_MS) {
        return;
      }
    }
    this.events.push({ t, kind, text: plain(text) });
    this.events.sort((a, b) => a.t - b.t);
    this.prune();
    if (this.file && !this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = undefined;
        void this.save();
      }, SAVE_DELAY_MS);
      this.saveTimer.unref?.();
    }
  }

  list(): RecentEvent[] {
    return [...this.events];
  }

  /** Writes now (at shutdown, and in tests). */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private save(): Promise<void> {
    const file = this.file;
    if (!file) {
      return Promise.resolve();
    }
    // One write at a time; each writes a temporary file and renames it, so a reader never sees half.
    this.saving = this.saving.then(async () => {
      const tmp = `${file}.tmp`;
      try {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(this.events));
        await fs.rename(tmp, file);
      } catch {
        // A history that can't be saved must not disturb the doorbell.
      }
    });
    return this.saving;
  }
}
