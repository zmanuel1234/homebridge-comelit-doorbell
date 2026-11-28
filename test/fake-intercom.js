// A fake Comelit intercom (Extender / ICONA bridge) on a local TCP port, speaking the same framing
// as the real one: an 8-byte header (00 06, body length, channel id), channel opens as
// COMMAND messages on channel 0, JSON requests and answers on a channel's id, and binary CTPP
// frames on the CTPP channel. It answers the plugin's start-up the way the author's kit does.

import net from 'node:net';
import { encodeChannelOpenResponse, encodeJsonMessage, encodeHeader } from '../dist/protocol.js';

const COMMAND = 0xabcd;
const END = 0x01ef;

/** A configuration as the Extender sends it: one apartment, one door, the entrance panel. */
const intercomConfig = {
  'response-code': 200,
  vip: {
    'apt-address': 'SB000002',
    'apt-subaddress': 3,
    'user-parameters': {
      'entrance-address-book': [{ 'apt-address': 'SB100001', name: 'Entrance' }],
      'opendoor-address-book': [{ id: 1, name: 'Entrance lock', 'apt-address': 'SB100001', 'output-index': 1, 'secure-mode': false }],
    },
  },
};

class FakeIntercom {
  /**
   * `answers(msg, channel)`: the JSON answer to a request (default: 200, and the configuration
   * for get-configuration); return null for no answer, or a Buffer to send raw.
   * `ctppAnswers`: answer the CTPP registration (default true).
   */
  constructor({ answers, ctppAnswers = true } = {}) {
    this.answers = answers ?? (() => undefined);
    this.ctppAnswers = ctppAnswers;
    this.connections = 0;
    this.opened = []; // channel names, in order, across connections
    this.requests = []; // { channel, msg }
    this.binary = []; // { channel, body }
    this.sockets = new Set();
    this.server = net.createServer((socket) => this.onConnection(socket));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Drops every connection, as an intercom that restarts. */
  dropAll() {
    for (const s of this.sockets) s.destroy();
  }

  onConnection(socket) {
    this.connections++;
    this.sockets.add(socket);
    const conn = { socket, ids: new Map(), names: new Map(), nextId: 0x100, rx: Buffer.alloc(0), ctppInit: false };
    this.last = conn;
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      conn.rx = Buffer.concat([conn.rx, chunk]);
      while (conn.rx.length >= 8) {
        const len = conn.rx.readUInt16LE(2);
        if (conn.rx.length < 8 + len) break;
        const id = conn.rx.readUInt16LE(4);
        const body = conn.rx.subarray(8, 8 + len);
        conn.rx = conn.rx.subarray(8 + len);
        this.onFrame(conn, id, Buffer.from(body));
      }
    });
  }

  onFrame(conn, id, body) {
    if (id === 0) {
      const type = body.readUInt16LE(0);
      if (type === COMMAND && body.readUInt16LE(2) === 1 && body.length >= 12) {
        // The plugin opens a channel: [cd ab][seq 1][type LE32][name, 4 chars]…
        const name = body.subarray(8, 12).toString('latin1');
        const serverId = conn.nextId++;
        conn.ids.set(name, serverId);
        conn.names.set(serverId, name);
        this.opened.push(name);
        conn.socket.write(encodeChannelOpenResponse(serverId));
      }
      // END (close) messages need no answer here.
      return;
    }
    const channel = conn.names.get(id) ?? `#${id}`;
    if (body[0] === 0x7b) {
      const msg = JSON.parse(body.toString('utf8'));
      this.requests.push({ channel, msg });
      let reply = this.answers(msg, channel);
      if (reply === undefined) {
        reply = msg.message === 'get-configuration' ? intercomConfig : { 'response-code': 200, message: msg.message, 'message-type': 'response' };
      }
      if (reply === null) return;
      conn.socket.write(Buffer.isBuffer(reply) ? Buffer.concat([encodeHeader(reply.length, id), reply]) : encodeJsonMessage(reply, id));
      return;
    }
    this.binary.push({ channel, body });
    if (channel === 'CTPP' && !conn.ctppInit) {
      conn.ctppInit = true;
      if (this.ctppAnswers) {
        // The registration's two answers: an acknowledgement, then a first renewal (0x1860).
        this.sendOn(conn, 'CTPP', Buffer.from('0018' + '00'.repeat(10), 'hex'));
        this.sendOn(conn, 'CTPP', Buffer.from('6018' + '01020304' + '00'.repeat(8), 'hex'));
      }
    }
  }

  /** Sends `body` on the channel `name` of the latest connection. */
  sendOn(conn, name, body) {
    const id = conn.ids.get(name);
    conn.socket.write(Buffer.concat([encodeHeader(body.length, id), body]));
  }

  /** The intercom closes channel `name` (as it sometimes does with CTPP). */
  closeChannel(name) {
    const conn = this.last;
    const body = Buffer.alloc(10);
    body.writeUInt16LE(END, 0);
    body.writeUInt16LE(3, 2);
    body.writeUInt32LE(2, 4);
    body.writeUInt16LE(conn.ids.get(name), 8);
    conn.socket.write(Buffer.concat([encodeHeader(body.length, 0), body]));
  }

  /** An unsolicited JSON message (a push) on a channel id nobody waits on. */
  push(msg) {
    this.last.socket.write(encodeJsonMessage(msg, 0x7777));
  }
}

export { FakeIntercom, intercomConfig };
