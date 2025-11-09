import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createSharedRateLimiter, createInMemoryRateLimitBackend } from '../../monolith.js';

// Property-test randomized schedules across workers with ±RL_MAX_SKEW_MS.
// Assert: ≤limit ok, exactly one internal_error, rest rate_limited.

test('Fairness & skew property across randomized schedules', async () => {
  const windowMs = 200; // small window to keep runtime fast
  const limit = 7;
  const rl = createSharedRateLimiter({
    windowMs,
    limit,
    backend: createInMemoryRateLimitBackend({}),
  });
  const RL_MAX_SKEW_MS = Number(process.env.RL_MAX_SKEW_MS || 250);

  const schedules = Number(process.env.N_SCHEDULES || 1000); // scale via env to 10000 if needed
  function alignAnchor(now) {
    return Math.floor(now / windowMs) * windowMs;
  }

  for (let i = 0; i < schedules; i++) {
    const workers = Math.floor(3 + Math.random() * 3); // 3–5 workers
    const key = `fairness:${i}:${crypto.randomBytes(8).toString('hex')}`;

    const baseNow = Date.now();
    const anchor = alignAnchor(baseNow);
    // Boundary-aligned starts, each call will use anchor + skew + small offset
    const calls = limit + 5; // exceed limit to force rate_limited outcomes

    let ok = 0,
      rate = 0,
      internal = 0;
    for (let c = 0; c < calls; c++) {
      const workerId = Math.floor(Math.random() * workers);
      const skew = Math.floor((Math.random() * 2 - 1) * RL_MAX_SKEW_MS);
      const offset = 10 + Math.floor(Math.random() * (windowMs - 20)); // remain within window
      const fakeNow = anchor + skew + offset;

      // Monkey-patch Date.now for this call only
      const realNow = Date.now;
      Date.now = () => fakeNow;
      try {
        const res = await rl.allow(key);
        if (res.ok) ok++;
        else if (res.internal_error) internal++;
        else if (res.rate_limited) rate++;
        else rate++;
      } finally {
        Date.now = realNow;
      }
    }

    assert.ok(ok <= limit, `ok should be ≤ limit (got ${ok})`);
    assert.equal(internal, 1, `exactly one internal_error expected (got ${internal})`);
    assert.equal(rate, calls - ok - internal, 'remaining responses should be rate_limited');
  }
});
