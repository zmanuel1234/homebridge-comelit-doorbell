// Start-up: login, reading the intercom's configuration, and the keepalive / push registration.

import test from 'node:test';
import assert from 'node:assert';
import { authenticate, AuthenticationError } from '../dist/auth.js';
import { getDeviceConfig, parseConfig } from '../dist/configReader.js';
import { ProtocolError } from '../dist/client.js';
import { registerPush, sendPushKeepalive } from '../dist/push.js';
import { ChannelType, CHANNEL_TYPE_PUSH } from '../dist/channels.js';

/** A client that records the channels opened and the JSON sent, and answers with `reply`. */
function jsonClient(reply = { 'response-code': 200 }) {
  const opened = [];
  const sent = [];
  const channels = new Map();
  const client = {
    opened,
    sent,
    removed: [],
    pushCallback: undefined,
    async openChannel(name, type) {
      opened.push({ name, type });
      const ch = { name, type, isOpen: true };
      channels.set(name, ch);
      return ch;
    },
    getChannel: (name) => channels.get(name),
    removeChannel(name) { client.removed.push(name); channels.delete(name); },
    async sendJson(channel, msg) {
      sent.push({ channel: channel.name, msg });
      return typeof reply === 'function' ? reply(msg) : reply;
    },
    setPushCallback(cb) { client.pushCallback = cb; },
  };
  return client;
}

// ─── Login ─────────────────────────────────────────────────────────────────

test('login: sends the token on the UAUT channel and accepts response code 200', async () => {
  const client = jsonClient();
  await authenticate(client, 'secret-token');
  assert.deepStrictEqual(client.opened, [{ name: 'UAUT', type: ChannelType.UAUT }]);
  assert.deepStrictEqual(client.sent[0], {
    channel: 'UAUT',
    msg: { message: 'access', 'user-token': 'secret-token', 'message-type': 'request', 'message-id': 2 },
  });
});

test('login: any other response code is an AuthenticationError with the code and the reason', async () => {
  const client = jsonClient({ 'response-code': 403, 'response-string': 'Access denied' });
  await assert.rejects(authenticate(client, 'wrong'), (e) => e instanceof AuthenticationError && e.message === 'Authentication failed: 403 Access denied');
});

test('login: a refusal without a reason says "Unknown error"; no response code at all is refused too', async () => {
  await assert.rejects(authenticate(jsonClient({ 'response-code': 500 }), 't'), /Authentication failed: 500 Unknown error/);
  await assert.rejects(authenticate(jsonClient({}), 't'), (e) => e instanceof AuthenticationError && /undefined Unknown error/.test(e.message));
});

test('login: a failure to open the channel is passed on, not mistaken for a wrong token', async () => {
  const client = jsonClient();
  client.openChannel = async () => { throw new Error('connection closed'); };
  await assert.rejects(authenticate(client, 't'), (e) => !(e instanceof AuthenticationError) && e.message === 'connection closed');
});

// ─── The intercom's configuration ──────────────────────────────────────────

/** A configuration as the Extender sends it (names and addresses as on the author's kit). */
const extenderConfig = {
  'response-code': 200,
  vip: {
    'apt-address': 'SB000002',
    'apt-subaddress': 3,
    'user-parameters': {
      'entrance-address-book': [{ 'apt-address': 'SB100001', name: 'Entrance' }],
      'opendoor-address-book': [
        { id: 1, name: 'Entrance lock', 'apt-address': 'SB100001', 'output-index': 1, 'secure-mode': false },
        { id: 2, name: 'Side door', 'apt-address': 'SB100001', 'output-index': 2, 'secure-mode': true },
      ],
      'actuator-address-book': [{ id: 7, name: 'Gate', 'apt-address': 'SB200001', 'output-index': 3, 'module-index': 4 }],
      'rtsp-camera-address-book': [{ id: 5, name: 'Courtyard', 'rtsp-url': 'rtsp://10.0.0.9/1', 'rtsp-user': 'u', 'rtsp-password': 'p' }],
    },
  },
};

test('configuration: asks for every address book on the UCFG channel', async () => {
  const client = jsonClient(extenderConfig);
  await getDeviceConfig(client);
  assert.deepStrictEqual(client.opened, [{ name: 'UCFG', type: ChannelType.UCFG }]);
  assert.deepStrictEqual(client.sent[0].msg, { message: 'get-configuration', addressbooks: 'all', 'message-type': 'request', 'message-id': 3 });
});

test('configuration: apartment, caller, doors (then actuators, numbered on), and cameras', async () => {
  const c = await getDeviceConfig(jsonClient(extenderConfig));
  assert.strictEqual(c.aptAddress, 'SB000002');
  assert.strictEqual(c.aptSubaddress, 3);
  assert.strictEqual(c.callerAddress, 'SB100001');
  assert.deepStrictEqual(c.doors, [
    { id: 1, index: 0, name: 'Entrance lock', aptAddress: 'SB100001', outputIndex: 1, secureMode: false, isActuator: false, moduleIndex: 0 },
    { id: 2, index: 1, name: 'Side door', aptAddress: 'SB100001', outputIndex: 2, secureMode: true, isActuator: false, moduleIndex: 0 },
    { id: 7, index: 2, name: 'Gate', aptAddress: 'SB200001', outputIndex: 3, secureMode: false, isActuator: true, moduleIndex: 4 },
  ]);
  assert.deepStrictEqual(c.cameras, [{ id: 5, name: 'Courtyard', rtspUrl: 'rtsp://10.0.0.9/1', rtspUser: 'u', rtspPassword: 'p' }]);
  assert.strictEqual(c.raw, extenderConfig);
});

test('configuration: a refusal is a ProtocolError with the code', async () => {
  await assert.rejects(getDeviceConfig(jsonClient({ 'response-code': 401 })), (e) => e instanceof ProtocolError && e.message === 'Config request returned code 401');
});

test('configuration: missing or malformed parts give empty values instead of throwing', () => {
  const empty = parseConfig({ 'response-code': 200 });
  assert.deepStrictEqual(
    { apt: empty.aptAddress, sub: empty.aptSubaddress, caller: empty.callerAddress, doors: empty.doors, cameras: empty.cameras },
    { apt: '', sub: 0, caller: '', doors: [], cameras: [] },
  );
  // An address book that isn't a list (seen as an object on some firmware) is ignored.
  const odd = parseConfig({ vip: { 'user-parameters': { 'opendoor-address-book': { name: 'x' }, 'entrance-address-book': [] } } });
  assert.deepStrictEqual(odd.doors, []);
  // A door without id or fields gets its position as id and neutral defaults.
  const bare = parseConfig({ vip: { 'user-parameters': { 'opendoor-address-book': [{}] } } });
  assert.deepStrictEqual(bare.doors, [{ id: 0, index: 0, name: '', aptAddress: '', outputIndex: 0, secureMode: false, isActuator: false, moduleIndex: 0 }]);
});

// ─── Keepalive and push registration ───────────────────────────────────────

const deviceConfig = { aptAddress: 'SB000002', aptSubaddress: 3, doors: [], cameras: [] };

test('keepalive by default: a server-info request on the INFO channel, nothing that diverts calls', async () => {
  const client = jsonClient();
  await registerPush(client, deviceConfig, false, () => undefined);
  assert.deepStrictEqual(client.opened, [{ name: 'INFO', type: ChannelType.INFO }]);
  assert.deepStrictEqual(client.sent[0].msg, { message: 'server-info', 'message-type': 'request', 'message-id': 20 });
});

test('registerPush: the push-info registration on the PUSH channel, with our apartment address', async () => {
  const client = jsonClient();
  await registerPush(client, deviceConfig, true, () => undefined);
  assert.deepStrictEqual(client.opened, [{ name: 'PUSH', type: CHANNEL_TYPE_PUSH }]);
  const m = client.sent[0].msg;
  assert.strictEqual(m.message, 'push-info');
  assert.strictEqual(m['apt-address'], 'SB000002');
  assert.strictEqual(m['apt-subaddress'], 3);
  assert.strictEqual(m['message-id'], 2);
  assert.strictEqual(m['os-type'], 'ios');
});

test('push messages: rings and missed calls become events; anything else is ignored', async () => {
  const client = jsonClient();
  const events = [];
  await registerPush(client, deviceConfig, false, (e) => events.push(e));
  for (const message of ['incoming-call', 'push-incoming-call', 'missed-call', 'push-missed-call', 'server-info', undefined]) {
    client.pushCallback({ message, 'apt-address': 'SB000002' });
  }
  assert.deepStrictEqual(events.map((e) => e.eventType), ['doorbell_ring', 'doorbell_ring', 'missed_call', 'missed_call']);
  assert.ok(events.every((e) => e.aptAddress === 'SB000002' && typeof e.timestamp === 'number' && e.raw.message));
  client.pushCallback({ message: 'incoming-call' });
  assert.strictEqual(events.at(-1).aptAddress, '', 'no address: empty, not undefined');
});

test('keepalive: reuses the open channel; opens it again if it was closed', async () => {
  const client = jsonClient();
  await registerPush(client, deviceConfig, false, () => undefined);
  await sendPushKeepalive(client, deviceConfig, false);
  assert.strictEqual(client.opened.length, 1, 'reused');
  assert.strictEqual(client.sent.length, 2);
  client.removeChannel('INFO'); // the intercom closed it
  client.removed.length = 0;
  await sendPushKeepalive(client, deviceConfig, false);
  assert.deepStrictEqual(client.opened.map((o) => o.name), ['INFO', 'INFO'], 'opened again');
  assert.deepStrictEqual(client.removed, ['INFO'], 'the stale entry is cleared first');
  assert.strictEqual(client.sent.at(-1).msg.message, 'server-info');
});

test('keepalive: a failed send is passed on to the caller (the platform logs it)', async () => {
  const client = jsonClient();
  client.sendJson = async () => { throw new Error('timeout'); };
  await assert.rejects(sendPushKeepalive(client, deviceConfig, true), /timeout/);
});
