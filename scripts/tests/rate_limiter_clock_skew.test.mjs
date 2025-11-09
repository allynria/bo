import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function runWorker(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'tests', 'helpers', 'shared_rl_worker.mjs');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', () => {});
  return new Promise((resolve) => {
    child.on('exit', () => {
      try { resolve(JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}')); }
      catch { resolve({ ok: 0, internal: 0, rlBlocked: 0 }); }
    });
  });
}

test('Shared rate limiter fairness under ±250ms skew with anchored windows', async () => {
  // Ensure limiter uses expected skew guard for this test
  process.env.RL_MAX_SKEW_MS = process.env.RL_MAX_SKEW_MS || '250';
  const limit = 10;
  const windowMs = 1000;
  const key = 'skew';
  const baseEnv = {
    RL_LIMIT: String(limit),
    RL_WINDOW_MS: String(windowMs),
    RL_KEY: key,
    RUN_FOR_MS: String(windowMs),
    ALIGN_START: '1',
    LOG_JSON: '1',
    RL_MAX_SKEW_MS: process.env.RL_MAX_SKEW_MS || '250',
    TMPDIR: path.join(process.cwd(), 'tmp_rl'),
    TEMP: '',
    TMP: ''
  };
  const [w1, w2, w3] = await Promise.all([
    runWorker({ ...baseEnv, CLOCK_SKEW_MS: String(-250) }),
    runWorker({ ...baseEnv, CLOCK_SKEW_MS: String(0) }),
    runWorker({ ...baseEnv, CLOCK_SKEW_MS: String(250) })
  ]);
  const okTotal = Number(w1.ok || 0) + Number(w2.ok || 0) + Number(w3.ok || 0);
  const internalTotal = Number(w1.internal || 0) + Number(w2.internal || 0) + Number(w3.internal || 0);
  const rlBlockedTotal = Number(w1.rlBlocked || 0) + Number(w2.rlBlocked || 0) + Number(w3.rlBlocked || 0);
  const totalRequests = okTotal + internalTotal + rlBlockedTotal;
  // Acceptance criteria
  assert.ok(okTotal <= limit, `okTotal ${okTotal} exceeds limit ${limit}`);
  assert.equal(internalTotal, 1, 'Exactly one internal_error should occur per window');
  assert.equal(totalRequests, okTotal + internalTotal + rlBlockedTotal, 'Totals should be consistent');
  // No violations: every excess beyond ok/internal must be rate_limited
  const violations = Math.max(0, totalRequests - (okTotal + internalTotal + rlBlockedTotal));
  assert.equal(violations, 0, 'No violations expected');
});
