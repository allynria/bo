import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

test('Tmp janitor skips locked files and honors skew guard for fresh files', async () => {
  // Capture metrics to ensure janitor ran
  const captured = [];
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  globalThis.UrgaCoreDeps.Metrics = {
    count: (_ctx, name, delta = 1, labels = {}) => { captured.push({ event: `${name}.count`, delta, labels }); },
    gauge: () => {},
    histogramMs: () => {},
  };

  const monolith = await import('../../monolith.js');
  const { startTmpJanitor } = monolith;

  const dir = '.';
  const base = path.join(dir, `janitor_guard_${process.pid}`);
  const lockedTmp = `${base}.tmp-` + Math.random().toString(16).slice(2);
  const lockPath = `${base}.lock`;
  const freshBak = `${base}.bak`;

  // Create a locked tmp file that is stale by TTL
  await fsp.writeFile(lockedTmp, 'x', 'utf8');
  await fsp.writeFile(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }) + '\n', 'utf8');
  const oldDate = new Date(Date.now() - 500);
  await fsp.utimes(lockedTmp, oldDate, oldDate);

  // Create a fresh .bak file that should be saved by skew guard
  await fsp.writeFile(freshBak, 'y', 'utf8');
  const freshDate = new Date(Date.now());
  await fsp.utimes(freshBak, freshDate, freshDate);

  // Run janitor with tight TTL but non-zero skew guard so freshBak is preserved
  process.env.TMP_JANITOR_SKEW_GUARD_MS = '2000';
  const timer = startTmpJanitor({ ttlMs: 100, intervalMs: 50, maxDeletesPerRun: 100, maxRunMs: 200 });
  await new Promise((r) => setTimeout(r, 250));

  const existsLockedTmp = await fsp.stat(lockedTmp).then(() => true).catch(() => false);
  const existsFreshBak = await fsp.stat(freshBak).then(() => true).catch(() => false);

  assert.equal(existsLockedTmp, true, 'locked tmp file should not be deleted');
  assert.equal(existsFreshBak, true, 'fresh .bak should be preserved by skew guard');

  const ran = captured.some((e) => e.event === 'tmp_janitor_runs_total.count');
  assert.equal(ran, true, 'janitor should have run');

  // Cleanup artifacts
  try { timer && clearInterval(timer); } catch {}
  try { await fsp.rm(lockedTmp, { force: true }); } catch {}
  try { await fsp.rm(lockPath, { force: true }); } catch {}
  try { await fsp.rm(freshBak, { force: true }); } catch {}
});

