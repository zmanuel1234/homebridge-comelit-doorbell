const test = require('node:test');
const assert = require('node:assert');
const { KeyframeTrace, TRACE_KEYFRAMES } = require('../dist/keyframes');

const nal = (type, fill, len = 20) => Buffer.concat([Buffer.from([0, 0, 0, 1, 0x60 | type]), Buffer.alloc(len - 5, fill)]);
const SPS = nal(7, 1, 8);
const P = nal(1, 9, 10);

function feedKeyframe(trace, call, born, at, fill, slices = 2) {
  trace.video(call, born, SPS, at);
  for (let i = 0; i < slices; i++) trace.video(call, born, nal(5, fill + i), at);
  trace.video(call, born, P, at); // the keyframe is complete once something else follows
}

test('keyframe trace: logs the first keyframes of a call with time, gap, size and fingerprint (2.3.3-beta.1)', () => {
  const lines = [];
  const t = new KeyframeTrace((l) => lines.push(l));
  const call = {};
  feedKeyframe(t, call, 0, 3000, 1);
  feedKeyframe(t, call, 0, 3100, 2);
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^call: keyframe 1 3\.00 s after the ring, 40 bytes, fingerprint [0-9a-f]{10} \(new\)$/);
  assert.match(lines[1], /^call: keyframe 2 3\.10 s after the ring, 0\.10 s after the one before, 40 bytes, fingerprint [0-9a-f]{10} \(new\)$/);
  for (let i = 0; i < 10; i++) feedKeyframe(t, call, 0, 4000 + i * 100, 10 + i);
  assert.strictEqual(lines.length, TRACE_KEYFRAMES, 'only the first few');
});

test('keyframe trace: a call starting with a copy of the previous call\'s keyframe says so', () => {
  const lines = [];
  const t = new KeyframeTrace((l) => lines.push(l));
  const first = {};
  feedKeyframe(t, first, 0, 3000, 1);
  feedKeyframe(t, first, 0, 6500, 50); // its last keyframe
  t.ended(first, 9000);
  assert.match(lines.at(-1), /^call: keyframes: 2 in this call; the last one 6\.50 s after the ring, 40 bytes, fingerprint /);
  const second = {};
  feedKeyframe(t, second, 100_000, 103_000, 50); // the leftover
  feedKeyframe(t, second, 100_000, 103_200, 70); // fresh
  assert.match(lines.at(-2), /keyframe 1 3\.00 s after the ring, .*\(a copy of the previous call's keyframe from 6\.50 s after its ring\)$/);
  assert.match(lines.at(-1), /keyframe 2 3\.20 s after the ring, 0\.20 s after the one before, .*\(new\)$/);
});

test('keyframe trace: keyframes later than the window are not logged, and ending twice is harmless', () => {
  const lines = [];
  const t = new KeyframeTrace((l) => lines.push(l));
  const call = {};
  feedKeyframe(t, call, 0, 20_000, 1);
  assert.deepStrictEqual(lines, []);
  t.ended(call, 21_000);
  t.ended(call, 21_000);
  assert.strictEqual(lines.length, 1);
  t.ended({}, 0); // a call with no video
  assert.strictEqual(lines.length, 1);
});
