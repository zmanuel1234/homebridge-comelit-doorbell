/**
 * Reading the users from an intercom backup (the Setup assistant's "Read a backup"): the
 * backup is a .tar.gz archive whose etc/comelit/users.cfg is itself gzipped. Each user is a
 * line like `mspUsersMap.0.<row> = 4:2:1 5:2:2 6:4:"iPhone" ... 9:4:"<token>" ...`:
 * field 6 is the description, 9 the token, 5 the status (2: activated). The archive also holds
 * activation codes and email addresses: they are never returned.
 */
import { gunzipSync } from 'node:zlib';

/** The largest backup accepted (the author's is 24 KB unpacked). */
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;

export interface BackupUser {
  /** The user row (sub-address) the token belongs to. */
  row: number;
  description: string;
  activated: boolean;
  token: string;
}

const isGzip = (b: Buffer) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

function gunzip(b: Buffer): Buffer {
  return gunzipSync(b, { maxOutputLength: MAX_BACKUP_BYTES });
}

/** The files in a tar archive (name → contents); none if it isn't one. */
export function untar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) {
      break; // end of the archive
    }
    const field = (from: number, len: number) => header.subarray(from, from + len).toString('latin1').replace(/\0.*$/s, '');
    if (field(257, 5) !== 'ustar' && !/^[0-7 ]+$/.test(field(124, 12).trim() || 'x')) {
      return new Map(); // not a tar header
    }
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) {
      return new Map();
    }
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : '') + field(0, 100);
    const type = field(156, 1);
    if (type === '0' || type === '') {
      files.set(name.replace(/^\.\//, ''), tar.subarray(at + 512, at + 512 + size));
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** The users with a token in a users.cfg text. */
export function parseUsersCfg(text: string): BackupUser[] {
  const users: BackupUser[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^mspUsersMap\.\d+\.(\d+)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const f of m[2].matchAll(/(\d+):\d+:("(?:[^"\\]|\\.)*"|\S+)/g)) {
      fields.set(f[1], f[2].startsWith('"') ? f[2].slice(1, -1) : f[2]);
    }
    const token = fields.get('9') ?? '';
    if (!/^[0-9a-f]{32}$/i.test(token)) {
      continue; // an empty row, or a device without a token (an internal unit)
    }
    const row = Number(m[1]);
    if (users.some((u) => u.row === row)) {
      continue; // listed once
    }
    const description = (fields.get('6') ?? '').replace(/\\(["\\])/g, '$1');
    users.push({ row, description, activated: fields.get('5') === '2', token });
  }
  return users;
}

/**
 * The users in a backup file: the intercom's .tar.gz (or .tar), or users.cfg itself (gzipped or
 * not). Throws with a message for the user when it isn't one.
 */
export function readBackup(file: Buffer): BackupUser[] {
  if (file.length === 0) {
    throw new Error('The file is empty.');
  }
  if (file.length > MAX_BACKUP_BYTES) {
    throw new Error('The file is too big for an intercom backup.');
  }
  let data = file;
  try {
    if (isGzip(data)) {
      data = gunzip(data);
    }
  } catch {
    throw new Error("The file looks compressed but can't be unpacked: is it the whole backup?");
  }
  let cfg: Buffer | undefined;
  const files = untar(data);
  if (files.size > 0) {
    cfg = [...files].find(([name]) => /(^|\/)users\.cfg$/.test(name))?.[1];
    if (!cfg) {
      throw new Error("This archive has no users.cfg: it doesn't look like a backup of the intercom's settings.");
    }
  } else {
    cfg = data; // users.cfg itself
  }
  try {
    if (isGzip(cfg)) {
      cfg = gunzip(cfg); // users.cfg is compressed inside the archive too
    }
  } catch {
    throw new Error("users.cfg can't be unpacked.");
  }
  // UTF-8 (descriptions with accents), or Latin-1 if it isn't valid UTF-8.
  const utf8 = cfg.toString('utf8');
  const text = utf8.includes('\uFFFD') ? cfg.toString('latin1') : utf8;
  if (!/^mspUsersMap\./m.test(text)) {
    throw new Error("This isn't an intercom backup (no users found). Download it from the intercom's web page, Backup/Restore.");
  }
  return parseUsersCfg(text);
}
