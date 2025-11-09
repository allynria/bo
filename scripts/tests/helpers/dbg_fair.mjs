import { createSharedRateLimiter, createInMemoryRateLimitBackend } from '../../../monolith.js';

const windowMs = 200;
const limit = 7;
const rl = createSharedRateLimiter({
  windowMs,
  limit,
  backend: createInMemoryRateLimitBackend({}),
});

function alignAnchor(now) {
  return Math.floor(now / windowMs) * windowMs;
}

async function run() {
  const baseNow = Date.now();
  const anchor = alignAnchor(baseNow);
  const skewMax = Number(process.env.RL_MAX_SKEW_MS || 250);
  const calls = limit + 10;
  const key = 'dbg-fair-key';
  const realNow = Date.now;
  for (let c = 0; c < calls; c++) {
    const skew = Math.floor((Math.random() * 2 - 1) * skewMax);
    const offset = 10 + Math.floor(Math.random() * (windowMs - 20));
    const fakeNow = anchor + skew + offset;
    Date.now = () => fakeNow;
    const r = await rl.allow(key);
    // Peek internal state by calling incr via backend again with same now
    Date.now = () => fakeNow;
    const be = rl; // not directly accessible; re-import backend via new limiter
    // Instead, dump observed outcome only
    console.log(
      JSON.stringify({
        c,
        fakeNow,
        skew,
        offset,
        ok: !!r.ok,
        internal_error: !!r.internal_error,
        rate_limited: !!r.rate_limited,
      })
    );
    Date.now = realNow;
  }
}

run().catch((e) => {
  console.error('dbg_error', (e && e.stack) || e);
  process.exitCode = 1;
});
