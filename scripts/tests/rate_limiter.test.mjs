import { test } from 'node:test';
import assert from 'node:assert/strict';

const monolith = await import('../../monolith.js');
const { createGlobalRateLimiter } = monolith;

test('createGlobalRateLimiter caps within window and emits internal_error once', async () => {
  const limiter = createGlobalRateLimiter({ limit: 5, windowMs: 100 });
  const key = 'default';
  for (let i = 0; i < 5; i++) {
    const res = limiter.allow(key);
    assert.equal(res.ok, true);
  }
  const r6 = limiter.allow(key);
  assert.equal(r6.ok, false);
  assert.equal(!!r6.internal_error, true);
  const r7 = limiter.allow(key);
  assert.equal(r7.ok, false);
  assert.equal(!!r7.rate_limited, true);
  await new Promise((r) => setTimeout(r, 120));
  const r8 = limiter.allow(key);
  assert.equal(r8.ok, true);
});
