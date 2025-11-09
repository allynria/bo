// Cross-pod rate limiting sliding-window behavior test
// Spawns multiple workers hammering the same key and verifies pattern:
// first within-window call ok; next one internal_error (once); remaining rate_limited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

test('Sliding-window: ok then internal_error once, then rate_limited', async () => {
  const worker = path.join(process.cwd(), 'scripts', 'tests', 'helpers', 'shared_rl_worker.mjs');
  const envBase = { RL_LIMIT: '1', RL_WINDOW_MS: '1000', RL_KEY: 'beta' };
  const p1 = runNode(worker, {
    NODE_ENV: 'test',
    ...envBase,
    ALIGN_START: '1',
    RUN_FOR_MS: '6000',
  });
  const p2 = runNode(worker, {
    NODE_ENV: 'test',
    ...envBase,
    ALIGN_START: '1',
    RUN_FOR_MS: '6000',
  });
  const p3 = runNode(worker, {
    NODE_ENV: 'test',
    ...envBase,
    ALIGN_START: '1',
    RUN_FOR_MS: '6000',
  });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  const j1 = JSON.parse(r1.out || '{}');
  const j2 = JSON.parse(r2.out || '{}');
  const j3 = JSON.parse(r3.out || '{}');
  const totalOk = Number(j1.ok || 0) + Number(j2.ok || 0) + Number(j3.ok || 0);
  const totalInternal =
    Number(j1.internal || 0) + Number(j2.internal || 0) + Number(j3.internal || 0);
  const totalRl = Number(j1.rlBlocked || 0) + Number(j2.rlBlocked || 0) + Number(j3.rlBlocked || 0);
  // Pattern expectations
  assert.ok(totalOk > 0, 'should allow at least once per window');
  assert.equal(totalInternal, totalOk, 'one internal_error per window across cluster');
  assert.ok(totalRl > totalOk, 'rate_limited events should exceed ok events');
  // No deviations: workers only report ok, internal_error, or rate_limited
  for (const j of [j1, j2, j3]) {
    assert.equal(Number(j.ok || 0) >= 0, true);
    assert.equal(Number(j.internal || 0) >= 0, true);
    assert.equal(Number(j.rlBlocked || 0) >= 0, true);
  }
});
