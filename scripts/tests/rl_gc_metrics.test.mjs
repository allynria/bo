import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

test('GC emits runs and deleted metrics when removing stale RL files', async () => {
  const origEnv = {
    RL_GC_ENABLED: process.env.RL_GC_ENABLED,
    RL_GC_TTL_MS: process.env.RL_GC_TTL_MS,
    RL_GC_INTERVAL_MS: process.env.RL_GC_INTERVAL_MS,
    RL_GC_MAX_DELETES: process.env.RL_GC_MAX_DELETES,
    RL_GC_MAX_RUN_MS: process.env.RL_GC_MAX_RUN_MS,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };

  process.env.RL_GC_ENABLED = '1';
  process.env.RL_GC_TTL_MS = '60000';
  // Respect monolith minimums: interval >= 5000ms
  process.env.RL_GC_INTERVAL_MS = '5000';
  process.env.RL_GC_MAX_DELETES = '100';
  process.env.RL_GC_MAX_RUN_MS = '200';

  const tmpBase = path.join(
    os.tmpdir(),
    `trae_rl_gc_metrics_${process.pid}_${Math.random().toString(36).slice(2)}`
  );
  await fsp.mkdir(tmpBase, { recursive: true });
  process.env.TMPDIR = tmpBase;
  delete process.env.TEMP;
  delete process.env.TMP;

  const captured = [];
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  globalThis.UrgaCoreDeps.Metrics = {
    count: (_ctx, name, delta = 1, labels = {}) => {
      captured.push({ event: `${name}.count`, delta, labels });
    },
    gauge: () => {},
    histogramMs: () => {},
  };

  const monolith = await import('../../monolith.js');
  const { createSharedRateLimiter } = monolith;

  const limiter = createSharedRateLimiter({ limit: 1, windowMs: 100, internalErrorOnce: false });
  const key = 'gc-metrics-' + Math.random().toString(36).slice(2);
  await limiter.allow(key);

  const hex = Buffer.from(String(key)).toString('hex');
  const shard = hex.slice(0, 2) || '00';
  const filePath = path.join(tmpBase, 'urga_rl', shard, `${hex}.json`);

  // Make file stale by mtime older than TTL
  const old = new Date(Date.now() - 70000);
  await fsp.utimes(filePath, old, old);

  // Wait for at least one GC run (interval >= 5s)
  await new Promise((r) => setTimeout(r, 6000));

  const existsAfter = await fsp
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsAfter, false, 'stale RL file should be deleted by GC');

  // Metrics assertions
  const tmpResolved = captured.find((e) => e.event === 'rl_tmp_base_resolved_total.count');
  assert.ok(tmpResolved, 'tmp base resolved metric should be emitted');
  assert.equal(String(tmpResolved.labels?.source), 'TMPDIR');

  const runCount = captured.filter((e) => e.event === 'rl_gc_runs_total.count').length;
  assert.ok(runCount >= 1, 'GC runs metric should be emitted at least once');

  const deletedEntries = captured.filter((e) => e.event === 'rl_gc_deleted_total.count');
  assert.ok(deletedEntries.length >= 1, 'GC deleted metric should be emitted');
  const deletedTotal = deletedEntries.reduce((sum, e) => sum + Number(e.delta || 0), 0);
  assert.ok(deletedTotal >= 1, 'GC deleted total should be >= 1');

  // Cleanup
  try {
    await fsp.rm(tmpBase, { recursive: true, force: true });
  } catch {}

  // Restore env
  for (const [k, v] of Object.entries(origEnv)) {
    if (v != null) process.env[k] = v;
    else delete process.env[k];
  }
});
