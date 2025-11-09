import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';

test('Tmp-file janitor deletes stale .tmp- and .bak files and emits metrics', async () => {
  process.env.TMP_JANITOR_SKEW_GUARD_MS = '0';
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
  const { startTmpJanitor } = monolith;

  // Create stale tmp and bak files in CWD
  const tmp1 = path.join(
    '.',
    `janitor_target_${process.pid}.tmp-` + Math.random().toString(16).slice(2)
  );
  const bak1 = path.join('.', `janitor_backup_${process.pid}.bak`);
  await fsp.writeFile(tmp1, 'x', 'utf8');
  await fsp.writeFile(bak1, 'y', 'utf8');
  const oldDate = new Date(Date.now() - 1000);
  await fsp.utimes(tmp1, oldDate, oldDate);
  await fsp.utimes(bak1, oldDate, oldDate);

  // Run janitor with short TTL/interval for the test
  // Give the janitor a slightly larger per-run budget and window
  // to traverse the repo root reliably on Windows.
  const timer = startTmpJanitor({
    ttlMs: 50,
    intervalMs: 50,
    maxDeletesPerRun: 100,
    maxRunMs: 600,
  });
  await new Promise((r) => setTimeout(r, 700));

  const existsTmp1 = await fsp
    .stat(tmp1)
    .then(() => true)
    .catch(() => false);
  const existsBak1 = await fsp
    .stat(bak1)
    .then(() => true)
    .catch(() => false);
  assert.equal(existsTmp1, false, 'stale .tmp- file should be deleted');
  assert.equal(existsBak1, false, 'stale .bak file should be deleted');

  const runCount = captured.filter((e) => e.event === 'tmp_janitor_runs_total.count').length;
  assert.ok(runCount >= 1, 'janitor runs metric should be emitted');
  const deletedEntries = captured.filter((e) => e.event === 'tmp_janitor_deleted_total.count');
  assert.ok(deletedEntries.length >= 1, 'janitor deleted metric should be emitted');
  const deletedTotal = deletedEntries.reduce((sum, e) => sum + Number(e.delta || 0), 0);
  assert.ok(deletedTotal >= 2, 'at least two files should be reported deleted');

  try {
    timer && clearInterval(timer);
  } catch {}
});
