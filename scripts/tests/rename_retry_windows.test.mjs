import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';

test('Rename retry succeeds on simulated EPERM and emits metrics', async () => {
  // Simulate transient rename failures
  process.env.URGA_TEST_FS_ERROR_OP = 'rename';
  process.env.URGA_TEST_RENAME_FAILS_N = '2';
  process.env.URGA_TEST_FS_ERROR_PATH_RX = 'rename-probe.txt';
  process.env.URGA_TEST_FS_ERROR_CODE = 'EPERM';

  const captured = [];
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  globalThis.UrgaCoreDeps.Metrics = {
    count: (_ctx, name, delta = 1, labels = {}) => {
      captured.push({ event: `${name}.count`, delta, labels });
    },
    gauge: () => {},
    histogramMs: (_ctx, name, ms, labels = {}) => {
      captured.push({ event: `${name}.hist`, ms, labels });
    },
  };

  const monolith = await import('../../monolith.js');
  const { stateIO } = monolith;

  const file = 'rename-probe.txt';
  try {
    await fsp.rm(file, { force: true });
  } catch {}
  await stateIO.writeTextAtomic(file, 'hello');

  const exists = await fsp
    .stat(file)
    .then(() => true)
    .catch(() => false);
  assert.equal(exists, true, 'final file should exist after retries');

  const retryMetric = captured.find((e) => e.event === 'fs_rename_retry_total.count');
  assert.ok(
    retryMetric && Number(retryMetric.delta || 0) >= 2,
    'rename retry metric should reflect attempts'
  );
});
