const test = require('node:test');
const assert = require('node:assert');
const { AsyncQueue } = require('../dist/channels');

test('an item enqueued after a dequeue timed out is not lost', async () => {
  const q = new AsyncQueue();
  assert.strictEqual(await q.dequeue(10), null);
  q.enqueue('ring');
  assert.strictEqual(await q.dequeue(10), 'ring');
});
