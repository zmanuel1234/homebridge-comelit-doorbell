// Shared fakes and frames captured from a real 6741W (model MSVU, firmware 2.1.0).
const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');

const frames = {
  // 14:01:57 incoming call (INVITE) from SB100001 to SB000002, addressed to our SB0000023
  invite: hex('c018 3696 b4d7 0028 0001 5342 3130 3030 3031 0000 5342 3030 3030 3032 0000 0100 c035 a838 5342 3130 3030 3031 0000 5050 ffff ffff 5342 3030 3030 3032 0000 5342 3030 3030 3032 3300'),
  // 14:01:57 the caller's capabilities on the same call
  capabilities: hex('4018 3696 b5d7 0008 0003 5003 3b00 0000 ffff ffff 5342 3030 3030 3032 0000 5342 3030 3030 3032 3300'),
  // 14:02:19 RELEASE cause 8 (busy) answering our open request on connection 07d4
  busyRelease: hex('6018 87d4 90f2 0003 000e 0800 ffff ffff 5342 3130 3030 3031 0000 5342 3030 3030 3032 3300'),
  // 14:02:12 our open request (connection 07d4, seq f1, ack 90)
  openRequest: hex('c018 07d4 f190 000d 002d 5342 3130 3030 3031 0000 0100 0000 ffff ffff 5342 3030 3030 3032 3300 5342 3130 3030 3031 0000'),
  // 14:02:44 our in-place registration
  register: hex('c018 d475 ef6a 0011 0040 d475 5342 3030 3030 3032 3300 100e 0000 0000 ffff ffff 5342 3030 3030 3032 3300 5342 3030 3030 3032 0000'),
};

function fakeClient() {
  const sent = [];
  const channel = { name: 'CTPP', isOpen: true, serverChannelId: 1, responseQueue: { clear() {}, dequeue: () => new Promise(() => {}) } };
  return {
    sent,
    channel,
    getChannel: () => channel,
    removeChannel() {},
    sendBinary: async (_ch, b) => { sent.push(Buffer.from(b)); },
  };
}

function quietLog() {
  const lines = [];
  const add = (level) => (m) => lines.push(`${level} ${m}`);
  return { lines, info: add('I'), warn: add('W'), error: add('E'), debug: add('D') };
}

module.exports = { hex, frames, fakeClient, quietLog };
