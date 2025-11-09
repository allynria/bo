import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function runWorker(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'tests', 'helpers', 'shared_rl_worker.mjs');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  return new Promise((resolve) => {
    child.on('exit', () => {
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop() || '{}'));
      } catch {
        resolve({ ok: 0, internal: 0, rlBlocked: 0 });
      }
    });
  });
}

test('Process restart mid-window: internal_error is emitted once only', async () => {
  const limit = 5;
  const windowMs = 1000;
  const key = 'restart_once_only';
  const baseEnv = {
    NODE_ENV: 'test',
    RL_LIMIT: String(limit),
    RL_WINDOW_MS: String(windowMs),
    RL_KEY: key,
    ALIGN_START: '1',
    LOG_JSON: '1',
  };

  // First worker runs enough calls to trigger internal_error once
  const w1 = await runWorker({ ...baseEnv, N_CALLS: String(limit + 1) });
  assert.ok((w1.internal || 0) >= 1, 'first worker should emit internal_error');

  // Second worker starts within the same window and SHOULD NOT re-emit internal_error
  const w2 = await runWorker({ ...baseEnv, N_CALLS: '3' });
  assert.equal(
    Number(w2.internal || 0),
    0,
    'second worker must NOT re-emit internal_error within same window'
  );
});
