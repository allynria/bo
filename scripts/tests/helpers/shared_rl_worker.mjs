const limit = Number(process.env.RL_LIMIT || 3);
const windowMs = Number(process.env.RL_WINDOW_MS || 1000);
const key = String(process.env.RL_KEY || 'shared');
const calls = Number(process.env.N_CALLS || 5);
const runForMs = Number(process.env.RUN_FOR_MS || 0);
const skewMs = Number(process.env.CLOCK_SKEW_MS || 0);
const alignStart = String(process.env.ALIGN_START || '0');

async function main() {
  // Optional local clock skew for fairness testing
  if (Number.isFinite(skewMs) && Math.abs(skewMs) > 0) {
    const origNow = Date.now;
    Date.now = () => origNow() + skewMs;
  }
  // Optionally align start to the next anchored window boundary
  if (alignStart === '1' || alignStart.toLowerCase() === 'true') {
    const slackMs = 20;
    const target = windowMs;
    while (Date.now() % target > slackMs) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  // Silence non-essential logs to keep stdout JSON-only
  const orig = { info: console.info, warn: console.warn };
  console.info = () => {};
  console.warn = () => {};
  const monolith = await import('../../../monolith.js');
  const { createSharedRateLimiter } = monolith;
  const backendName = String(process.env.RL_BACKEND || 'file').toLowerCase();
  let backend = undefined;
  if (backendName === 'redis' && typeof monolith.createRedisRateLimitBackend === 'function') {
    try {
      backend = monolith.createRedisRateLimitBackend({});
    } catch {}
  }
  const rl = createSharedRateLimiter({ limit, windowMs, backend });
  let ok = 0,
    internal = 0,
    rlBlocked = 0;
  if (runForMs > 0) {
    const end = Date.now() + runForMs;
    while (Date.now() < end) {
      try {
        const r = await rl.allow(key);
        if (r.ok) ok++;
        else if (r.internal_error) internal++;
        else if (r.rate_limited) rlBlocked++;
        else rlBlocked++;
      } catch {
        rlBlocked++;
      }
    }
  } else {
    for (let i = 0; i < calls; i++) {
      try {
        const r = await rl.allow(key);
        if (r.ok) ok++;
        else if (r.internal_error) internal++;
        else if (r.rate_limited) rlBlocked++;
        else rlBlocked++;
      } catch {
        rlBlocked++;
      }
    }
  }
  console.log(JSON.stringify({ ok, internal, rlBlocked }));
  // Restore console (optional)
  console.info = orig.info;
  console.warn = orig.warn;
}

main().catch((e) => {
  console.error('worker_error', (e && e.stack) || e);
  process.exitCode = 1;
});
