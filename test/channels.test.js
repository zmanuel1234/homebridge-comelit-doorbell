
import test from 'node:test';
import assert from 'node:assert';
import { AsyncQueue } from '../dist/channels.js';

test('an item enqueued after a dequeue timed out is not lost', async () => {
  const q = new AsyncQueue();
  assert.strictEqual(await q.dequeue(10), null);
  q.enqueue('ring');
  assert.strictEqual(await q.dequeue(10), 'ring');
});
