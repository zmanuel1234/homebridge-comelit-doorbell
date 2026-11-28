// Token from a backup: reading the intercom's backup (.tar.gz with a gzipped users.cfg inside).
// Every token, email and activation code here is made up.

import test from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readBackup, parseUsersCfg, untar, MAX_BACKUP_BYTES } from '../dist/backup.js';
import mod_child_process from 'node:child_process';
import mod_fs from 'node:fs';

const TOKEN_A = '0123456789abcdef0123456789abcdef';
const TOKEN_B = 'fedcba9876543210fedcba9876543210';

/** A row as the intercom writes it (same fields and layout as a real users.cfg). */
const row = (n, { type = 2, status = 0, desc = '', token = '', email = '', code = '' } = {}) =>
  `mspUsersMap.0.${n} = 4:2:${type} 5:2:${status} 6:4:"${desc}" 7:2:2 8:2:0 9:4:"${token}" 10:4:"" 11:4:"${email}" 12:4:"" 13:2:0 14:4:"" 15:2:0 16:2:0 17:4:"" 18:4:"${code}" 19:2:2 20:4:"" 21:2:0 22:4:"" `;

const USERS_CFG = [
  row(0),
  row(1, { type: 1, status: 2, desc: 'iPhone', token: TOKEN_A, email: 'someone@example.com', code: 'abcde12345' }),
  row(2, { type: 2, status: 1, desc: 'Homebridge' }), // an internal unit: no token
  row(3, { type: 1, status: 2, desc: 'Homebridge', token: TOKEN_B, email: 'other@example.com', code: 'zyxwv98765' }),
  row(4, { type: 1, status: 1, desc: 'iPad', token: TOKEN_A.toUpperCase() }),
  row(5),
].join('\n');

/** A minimal ustar archive, like the intercom's. */
function tar(files) {
  const blocks = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 'latin1');
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const backupFile = (cfg = gzipSync(Buffer.from(USERS_CFG))) =>
  gzipSync(tar([['.fw.info', Buffer.from('fw')], ['etc/comelit/addressbook.cfg', Buffer.from('x')], ['etc/comelit/users.cfg', cfg]]));

const expected = [
  { row: 1, description: 'iPhone', activated: true, token: TOKEN_A },
  { row: 3, description: 'Homebridge', activated: true, token: TOKEN_B },
  { row: 4, description: 'iPad', activated: false, token: TOKEN_A.toUpperCase() },
];

test('backup: the users with a token, as the intercom writes them (gzipped users.cfg in a .tar.gz)', () => {
  assert.deepStrictEqual(readBackup(backupFile()), expected);
});

test('backup: never returns activation codes or email addresses', () => {
  const json = JSON.stringify(readBackup(backupFile()));
  for (const secret of ['abcde12345', 'zyxwv98765', 'someone@example.com', 'other@example.com']) {
    assert.ok(!json.includes(secret), secret);
  }
  assert.deepStrictEqual(Object.keys(readBackup(backupFile())[0]).sort(), ['activated', 'description', 'row', 'token']);
});

test('backup: also a plain .tar, users.cfg not compressed, or users.cfg on its own', () => {
  assert.deepStrictEqual(readBackup(tar([['etc/comelit/users.cfg', Buffer.from(USERS_CFG)]])), expected, 'plain tar');
  assert.deepStrictEqual(readBackup(backupFile(Buffer.from(USERS_CFG))), expected, 'users.cfg not compressed');
  assert.deepStrictEqual(readBackup(gzipSync(Buffer.from(USERS_CFG))), expected, 'users.cfg alone, gzipped');
  assert.deepStrictEqual(readBackup(Buffer.from(USERS_CFG)), expected, 'users.cfg alone');
  assert.deepStrictEqual(readBackup(tar([['./etc/comelit/users.cfg', Buffer.from(USERS_CFG)]])), expected, './ names');
});

test('backup: files that are not a backup get a message, not a crash', () => {
  assert.throws(() => readBackup(Buffer.alloc(0)), /empty/);
  assert.throws(() => readBackup(Buffer.from('hello, this is not a backup')), /isn't an intercom backup/);
  assert.throws(() => readBackup(gzipSync(tar([['etc/comelit/other.cfg', Buffer.from('x')]]))), /has no users\.cfg/);
  assert.throws(() => readBackup(Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3])), /can't be unpacked/);
  assert.throws(() => readBackup(Buffer.alloc(MAX_BACKUP_BYTES + 1, 1)), /too big/);
  // a "zip bomb": too much once unpacked
  assert.throws(() => readBackup(gzipSync(Buffer.alloc(MAX_BACKUP_BYTES + 1024))), /can't be unpacked/);
});

test('backup: no user with a token is an empty list (the caller explains)', () => {
  assert.deepStrictEqual(readBackup(backupFile(gzipSync(Buffer.from([row(0), row(2, { status: 1, desc: 'Homebridge' })].join('\n'))))), []);
});

test('backup: users.cfg lines with odd spacing or quotes inside a description', () => {
  assert.deepStrictEqual(parseUsersCfg(`  mspUsersMap.0.7   =   5:2:2 6:4:"Anna's \\"phone\\"" 9:4:"${TOKEN_B}"  \r\n`), [
    { row: 7, description: 'Anna\'s "phone"', activated: true, token: TOKEN_B },
  ]);
  assert.strictEqual(parseUsersCfg(`mspUsersMap.0.1 = 9:4:"${TOKEN_A}"\nmspUsersMap.1.1 = 9:4:"${TOKEN_B}"`).length, 1, 'a row is listed once');
  assert.strictEqual(readBackup(Buffer.from(`mspUsersMap.0.2 = 6:4:"Café" 9:4:"${TOKEN_A}"`, 'utf8'))[0].description, 'Café', 'UTF-8');
  assert.strictEqual(readBackup(Buffer.from(`mspUsersMap.0.2 = 6:4:"Café" 9:4:"${TOKEN_A}"`, 'latin1'))[0].description, 'Café', 'Latin-1');
  assert.deepStrictEqual(parseUsersCfg('mspUsersMap.0.1 = 9:4:"short"'), [], 'not a token');
  assert.deepStrictEqual(untar(Buffer.from('not a tar archive'.repeat(40))).size, 0);
});

test('settings page server: /backup reads an uploaded backup, and explains a wrong file', async () => {
  const { fork } = mod_child_process;
  const child = fork(path.join(import.meta.dirname, '..', 'dist', 'homebridge-ui', 'server.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const replies = new Map();
  child.on('message', (m) => m.action === 'response' && replies.get(m.payload.requestId)?.(m.payload));
  const ask = (requestId, body) =>
    new Promise((resolve) => {
      replies.set(requestId, resolve);
      child.send({ action: 'request', requestId, path: '/backup', body });
    });
  try {
    await new Promise((r) => child.on('message', (m) => m.action === 'ready' && r()));
    const ok = await ask(1, { data: backupFile().toString('base64') });
    assert.strictEqual(ok.success, true);
    assert.deepStrictEqual(ok.data, expected);
    const bad = await ask(2, { data: Buffer.from('nope').toString('base64') });
    assert.strictEqual(bad.success, false);
    assert.match(JSON.stringify(bad.data), /isn't an intercom backup/);
  } finally {
    child.kill();
  }
});

test('settings page: a Token from a backup button that fills in the token and user row', () => {
  const html = mod_fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'homebridge-ui', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="readBackup"/);
  assert.match(html, /request\('\/backup'/);
  assert.match(html, /change\(\{ token: u\.token, subaddress: u\.row \}/);
  assert.ok(!/u\.token\}|\$\{u\.token/.test(html), 'the token is never shown on the page');
});
