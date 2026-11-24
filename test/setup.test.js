// The setup assistant (homebridge-ui/): finding the intercom, testing the settings, diagnostics.
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const { parseDiscoveryReply, discoverIntercoms, testConnection, redact } = require('../dist/setup');
const { FakeIntercom } = require('./fake-intercom');

/**
 * An answer to the INFO search, laid out like the author's MSVU (firmware 2.1.0) sends it; the MAC
 * address is made up.
 */
function msvuReply() {
  const head = Buffer.from(
    '696e666f5342313030303031' + '0000' + '001122334455' + '44343836' + '506f7274' + 'f0000102' + '322e312e30' + '00'.repeat(43),
    'hex',
  );
  return Buffer.concat([head, Buffer.from('ViP_'), Buffer.alloc(40), Buffer.from('MSVU')]);
}

test('discovery: reads the address, firmware and model from a device answer', () => {
  assert.deepStrictEqual(parseDiscoveryReply(msvuReply(), '10.0.4.79'), {
    host: '10.0.4.79',
    address: 'SB100001',
    firmware: '2.1.0',
    model: 'MSVU',
  });
  assert.strictEqual(parseDiscoveryReply(Buffer.from('hello world, not comelit'), '10.0.0.1'), null);
  assert.strictEqual(parseDiscoveryReply(Buffer.from('info'), '10.0.0.1'), null, 'too short');
  // Text after the model doesn't become the model; no ViP_ marker: no model rather than a guess.
  assert.strictEqual(parseDiscoveryReply(Buffer.concat([msvuReply(), Buffer.alloc(8), Buffer.from('XYZW')]), 'h').model, 'MSVU');
  assert.strictEqual(parseDiscoveryReply(Buffer.from('infoSB100001\0\0ABCDEF 2.1.0'), 'h').model, '');
  // A shorter answer without firmware or model still names the device.
  assert.deepStrictEqual(parseDiscoveryReply(Buffer.from('infoSB000002\0\0'), '10.0.0.2'), { host: '10.0.0.2', address: 'SB000002', firmware: '', model: '' });
});

test('discovery: sends INFO and collects each device once', async () => {
  const device = dgram.createSocket('udp4');
  const asked = [];
  device.on('message', (msg, rinfo) => {
    asked.push(msg.toString());
    device.send(msvuReply(), rinfo.port, rinfo.address);
    device.send(msvuReply(), rinfo.port, rinfo.address); // answered twice: listed once
  });
  await new Promise((r) => device.bind(0, '127.0.0.1', r));
  try {
    const found = await discoverIntercoms(1800, '127.0.0.1', device.address().port);
    assert.deepStrictEqual(asked, ['INFO', 'INFO', 'INFO', 'INFO'], 'sent 4 times, so one lost message does not matter');
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].host, '127.0.0.1');
    assert.strictEqual(found[0].model, 'MSVU');
  } finally {
    device.close();
  }
});

test('discovery: found when only a later search gets through, and asks a known address directly', async () => {
  const device = dgram.createSocket('udp4');
  let seen = 0;
  device.on('message', (msg, rinfo) => {
    seen++;
    if (seen >= 3) device.send(msvuReply(), rinfo.port, rinfo.address); // the first two were "lost"
  });
  await new Promise((r) => device.bind(0, '127.0.0.1', r));
  try {
    // the broadcast target goes nowhere; only the address from the settings reaches the device
    const found = await discoverIntercoms(1800, '127.0.0.2', device.address().port, ['127.0.0.1']);
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].model, 'MSVU');
  } finally {
    device.close();
  }
});

test('discovery: the broadcast address of each network', () => {
  const { broadcastAddresses } = require('../dist/setup');
  for (const b of broadcastAddresses()) assert.match(b, /^\d+\.\d+\.\d+\.\d+$/);
});

test('discovery: nobody answers → an empty list, after the wait', async () => {
  const t = Date.now();
  const found = await discoverIntercoms(150, '127.0.0.1', 9); // the discard port: no answer
  assert.deepStrictEqual(found, []);
  assert.ok(Date.now() - t >= 140);
});

async function withFake(opts, fn) {
  const fake = await new FakeIntercom(opts).start();
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

const base = (port, extra = {}) => ({ platform: 'ComelitIntercom', host: '127.0.0.1', port, token: 'a'.repeat(32), subaddress: 3, ...extra });

test('test connection: every step passes on a working setup, and lists the doors', () =>
  withFake({}, async (fake) => {
    const r = await testConnection(base(fake.port), { pluginVersion: '9.9.9' });
    assert.deepStrictEqual(
      r.steps.map((s) => [s.name, s.ok]),
      [['Settings', true], ['Reach the intercom', true], ['Token', true], ['Intercom', true], ['Configuration', true], ['User row (sub-address)', true]],
    );
    assert.match(r.steps[4].detail, /1 door \(Entrance lock\), 1 entrance panel/);
    assert.deepStrictEqual(r.doors, [{ name: 'Entrance lock', kind: 'door' }]);
    assert.strictEqual(r.subaddress, 3);
    // read-only: only login, server-info and get-configuration were asked
    assert.deepStrictEqual(fake.requests.map((q) => q.msg.message), ['access', 'server-info', 'get-configuration']);
  }));

test('test connection: the wrong user row is pointed out, with the right one', () =>
  withFake({}, async (fake) => {
    const r = await testConnection(base(fake.port, { subaddress: 5 }), { skipFfmpeg: true });
    const row = r.steps.find((s) => s.name === 'User row (sub-address)');
    assert.strictEqual(row.ok, false);
    assert.match(row.detail, /belongs to user row 3, but the settings say 5/);
    assert.strictEqual(r.subaddress, 3);
  }));

test('test connection: a bad setting is reported once, and an empty actuator row not at all', () =>
  withFake({}, async (fake) => {
    const blank = await testConnection(base(fake.port, { actuators: [{ type: 'switch' }] }));
    assert.deepStrictEqual(blank.steps[0], { name: 'Settings', ok: true, detail: 'No problems found.' });
    const bad = await testConnection(base(fake.port, { actuators: [{ name: 'Gate', type: 'dimmer' }] }));
    assert.strictEqual(bad.steps[0].ok, false);
    assert.strictEqual(bad.steps[0].detail.match(/is not valid/g).length, 1, bad.steps[0].detail);
  }));

test('test connection: an empty user row is fine (the plugin takes it from the intercom)', () =>
  withFake({}, async (fake) => {
    for (const subaddress of [undefined, '']) {
      const r = await testConnection(base(fake.port, { subaddress }));
      const row = r.steps.find((s) => s.name === 'User row (sub-address)');
      assert.strictEqual(row.ok, true);
      assert.match(row.detail, /3, from the intercom/);
    }
  }));

test('test connection: a refused token stops there', () =>
  withFake({ answers: (msg) => (msg.message === 'access' ? { 'response-code': 401, 'response-string': 'Unauthorized' } : undefined) }, async (fake) => {
    const r = await testConnection(base(fake.port));
    const last = r.steps[r.steps.length - 1];
    assert.strictEqual(last.name, 'Token');
    assert.strictEqual(last.ok, false);
    assert.match(last.detail, /refused the token .*401/);
    assert.ok(!fake.requests.some((q) => q.msg.message === 'get-configuration'));
  }));

test('test connection: an unreachable intercom and missing settings are explained', async () => {
  const closed = await withFake({}, async (fake) => fake.port); // a port nobody listens on any more
  const r = await testConnection(base(closed));
  assert.deepStrictEqual(r.steps.map((s) => [s.name, s.ok]), [['Settings', true], ['Reach the intercom', false]]);
  assert.match(r.steps[1].detail, /Can't connect to 127\.0\.0\.1/);

  const none = await testConnection({ platform: 'ComelitIntercom' });
  assert.deepStrictEqual(none.steps.map((s) => [s.name, s.ok]), [['Settings', false]]);
  assert.match(none.steps[0].detail, /IP address/);
  const noToken = await testConnection({ platform: 'ComelitIntercom', host: '10.0.0.1' });
  assert.match(noToken.steps[0].detail, /token/);
});

test('test connection: a configuration without doors or entrance panel is flagged', () =>
  withFake(
    { answers: (msg) => (msg.message === 'get-configuration' ? { 'response-code': 200, vip: { 'apt-address': 'SB000002', 'apt-subaddress': 3, 'user-parameters': {} } } : undefined) },
    async (fake) => {
      const r = await testConnection(base(fake.port));
      assert.strictEqual(r.steps.find((s) => s.name === 'Configuration').ok, false);
      assert.strictEqual(r.steps.find((s) => s.name === 'Entrance panel').ok, false);
    },
  ));

test('test connection: ffmpeg is checked only with the camera on', () =>
  withFake({}, async (fake) => {
    const off = await testConnection(base(fake.port));
    assert.ok(!off.steps.some((s) => s.name.startsWith('ffmpeg')));
    const missing = await testConnection(base(fake.port, { camera: true, ffmpegPath: '/nonexistent/ffmpeg' }));
    const step = missing.steps.find((s) => s.name.startsWith('ffmpeg'));
    assert.strictEqual(step.ok, false);
    assert.match(step.detail, /Can't run \/nonexistent\/ffmpeg/);
  }));

test('diagnostics: no token, passwords, serial or MAC addresses', () =>
  withFake(
    {
      answers: (msg) =>
        msg.message === 'server-info'
          ? { 'response-code': 200, model: 'MSVU', version: '2.1.0', 'serial-code': 'SERIAL123', mac: '00:11:22:33:44:55' }
          : msg.message === 'get-configuration'
            ? {
              'response-code': 200,
              vip: {
                'apt-address': 'SB000002',
                'apt-subaddress': 3,
                'user-parameters': {
                  'entrance-address-book': [{ 'apt-address': 'SB100001', name: 'Entrance' }],
                  'opendoor-address-book': [{ name: 'Entrance lock', 'apt-address': 'SB100001', 'output-index': 1 }],
                  'rtsp-camera-address-book': [{ id: 1, name: 'Garden', 'rtsp-url': 'rtsp://admin:pw@10.0.0.9/1', 'rtsp-user': 'admin', 'rtsp-password': 'pw' }],
                },
              },
              'viper-p2p': { http: { duuid: 'DEVICE-UUID' } },
            }
            : undefined,
    },
    async (fake) => {
      const token = '0123456789abcdef0123456789abcdef';
      const r = await testConnection(base(fake.port, { token }), { pluginVersion: '9.9.9' });
      for (const secret of [token, 'SERIAL123', '00:11:22:33:44:55', 'rtsp://admin', 'DEVICE-UUID', '"pw"']) {
        assert.ok(!r.diagnostics.includes(secret), `${secret} is not in the diagnostics`);
      }
      const d = JSON.parse(r.diagnostics);
      assert.strictEqual(d.plugin, '9.9.9');
      assert.strictEqual(d.settings.token, '<set>');
      assert.strictEqual(d.serverInfo.model, 'MSVU');
      assert.strictEqual(d.configuration['response-code'], 200, 'response codes stay');
      assert.deepStrictEqual(r.cameras, ['Garden']);
      assert.ok(Array.isArray(d.steps));
    },
  ));

test('redact: URLs (webhooks, RTSP) and lists of secrets go; codecs and switches stay', () => {
  assert.deepStrictEqual(
    redact({ doorbellTriggerUrl: 'http://x/hook?key=abc', mac: ['aa:bb'], videoCodec: 'libx264', 'virtual-key-enabled': false, 'activation-code': '1234', 'serial-code': 'S' }),
    { doorbellTriggerUrl: '<removed>', mac: ['<removed>'], videoCodec: 'libx264', 'virtual-key-enabled': false, 'activation-code': '<removed>', 'serial-code': '<removed>' },
  );
});

test('redact: MAC addresses and token-like strings inside any text go too', () => {
  assert.deepStrictEqual(
    redact({ base: 'MSVU/0025291845E9/vip/SB000002/sdp', note: 'mac 00:25:29:18:45:e9 and 00-25-29-18-45-E9', blob: 'x a62784fe60e26b3e445687e99f469aa8 y', host: '10.0.4.79', addr: 'SB100001', fw: '2.1.0', server: 'tls://hub-vc-generic.cloud.comelitgroup.com:443' }),
    { base: 'MSVU/<removed>/vip/SB000002/sdp', note: 'mac <removed> and <removed>', blob: 'x <removed> y', host: '10.0.4.79', addr: 'SB100001', fw: '2.1.0', server: 'tls://hub-vc-generic.cloud.comelitgroup.com:443' },
  );
});

test('redact: keeps the structure, removes only secret fields', () => {
  assert.deepStrictEqual(redact({ a: 1, list: [{ 'user-token': 'x', name: 'n' }], 'secure-mode': false, pin: '' }), {
    a: 1,
    list: [{ 'user-token': '<removed>', name: 'n' }],
    'secure-mode': false,
    pin: '',
  });
});

test('setup assistant: the UI files are published, and the settings use them', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('homebridge-ui'));
  assert.ok(pkg.dependencies['@homebridge/plugin-ui-utils']);
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'config.schema.json'), 'utf8'));
  assert.strictEqual(schema.customUi, true);
  // Homebridge shows the normal settings under a custom page only for a single settings block.
  assert.strictEqual(schema.singular, true);
  for (const f of ['server.js', 'public/index.html']) {
    assert.ok(fs.existsSync(path.join(root, 'homebridge-ui', f)), f);
  }
  const html = fs.readFileSync(path.join(root, 'homebridge-ui/public/index.html'), 'utf8');
  assert.match(html, /homebridge\.showSchemaForm\(\)/, 'the normal settings stay below the assistant');
  assert.match(html, /addEventListener\('ready', \(\) => homebridge\.showSchemaForm\(\)\)/, 'asked again once the page is ready');
  assert.ok(!html.includes('text-muted'), 'readable in the dark theme');
  for (const route of ['/discover', '/test']) {
    assert.ok(html.includes(`'${route}'`) && fs.readFileSync(path.join(root, 'homebridge-ui/server.js'), 'utf8').includes(`'${route}'`), route);
  }
});

test('setup assistant server: answers the settings page over IPC, as Homebridge runs it', () =>
  withFake({}, async (fake) => {
    const { fork } = require('node:child_process');
    const child = fork(path.join(__dirname, '..', 'homebridge-ui', 'server.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const replies = new Map();
    let ready;
    const isReady = new Promise((r) => (ready = r));
    child.on('message', (m) => (m.action === 'ready' ? ready() : m.action === 'response' && replies.get(m.payload.requestId)?.(m.payload)));
    const ask = (requestId, p, body) =>
      new Promise((resolve) => {
        replies.set(requestId, resolve);
        child.send({ action: 'request', requestId, path: p, body });
      });
    try {
      await isReady;
      const test = await ask(1, '/test', base(fake.port));
      assert.strictEqual(test.success, true);
      assert.ok(test.data.steps.every((s) => s.ok));
      const empty = await ask(2, '/test', null);
      assert.strictEqual(empty.success, true);
      assert.deepStrictEqual(empty.data.steps.map((st) => [st.name, st.ok]), [['Settings', false]]);
      const unknown = await ask(3, '/nope', {});
      assert.strictEqual(unknown.success, false);
    } finally {
      child.kill();
    }
  }));
