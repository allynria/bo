import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

import { createSharedRateLimiter } from '../../monolith.js';

function backendPathForKey(key) {
  const base = String(
    process?.env?.TMPDIR || process?.env?.TEMP || process?.env?.TMP || os.tmpdir()
  );
  const hex = Buffer.from(String(key)).toString('hex');
  const shard = hex.slice(0, 2) || '00';
  return path.join(base, 'urga_rl', shard, `${hex}.json`);
}

test('Window anchor updates only after 2×window + 2×skew guard; no drift', async () => {
  const windowMs = 60_000; // 1 minute windows
  const limit = 3;
  // Isolate TMPDIR to avoid interference from other tests
  const tmpBase = path.join(
    os.tmpdir(),
    `trae_rl_drift_${process.pid}_${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(tmpBase, { recursive: true });
  process.env.TMPDIR = tmpBase;
  process.env.TEMP = '';
  process.env.TMP = '';
  const rl = createSharedRateLimiter({ windowMs, limit });
  const key = 'drift-check-key';
  const p = backendPathForKey(key);

  const skew = Number(process.env.RL_MAX_SKEW_MS || 250);
  const resetThreshold = windowMs + (windowMs + 2 * skew); // 2×window + 2×skew

  // Seed initial state
  const t0 = Date.now() + 100;
  const realNow = Date.now;
  Date.now = () => t0;
  try {
    await rl.allow(key);
  } finally {
    Date.now = realNow;
  }
  let raw = await fsp.readFile(p, 'utf8').catch(() => null);
  assert.ok(raw, 'backend file must exist');
  let data = JSON.parse(String(raw || '{}'));
  let prevWinStart = Number(data.windowStart || 0);
  assert.equal(prevWinStart, Math.floor(t0 / windowMs) * windowMs);

  // Simulate long run stepping by 1×window each iteration; reset only after threshold
  const iterations = 10;
  for (let i = 1; i <= iterations; i++) {
    const fakeNow = t0 + i * windowMs + 100; // inside window
    const realNow2 = Date.now;
    Date.now = () => fakeNow;
    try {
      await rl.allow(key);
    } finally {
      Date.now = realNow2;
    }
    raw = await fsp.readFile(p, 'utf8').catch(() => null);
    assert.ok(raw, 'backend file must exist');
    data = JSON.parse(String(raw || '{}'));
    const winStart = Number(data.windowStart || 0);
    const elapsed = fakeNow - prevWinStart;
    if (elapsed >= resetThreshold) {
      const expectedAnchor = Math.floor(fakeNow / windowMs) * windowMs;
      assert.equal(
        winStart,
        expectedAnchor,
        'windowStart should advance to next anchor after threshold'
      );
      prevWinStart = winStart;
    } else {
      assert.equal(winStart, prevWinStart, 'windowStart should remain anchored until threshold');
    }
  }
});
