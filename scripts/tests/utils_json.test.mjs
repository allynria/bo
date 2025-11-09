import assert from 'node:assert';
import { test } from 'node:test';
import { safeJsonParse } from '../utils/json.mjs';

test('safeJsonParse parses valid JSON', () => {
  const res = safeJsonParse('{"a":1}');
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { a: 1 });
});

test('safeJsonParse returns fallback on invalid JSON', () => {
  const res = safeJsonParse('{', { x: 1 });
  assert.equal(res.ok, false);
  assert.deepEqual(res.value, { x: 1 });
});

test('safeJsonParse handles Buffer', () => {
  const res = safeJsonParse(Buffer.from('{"b":2}'));
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, { b: 2 });
});
