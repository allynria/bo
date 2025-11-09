// Ensure tests run with non-production settings to avoid strict logging guard
process.env.NODE_ENV = 'test';
process.env.URGA_JSON_LOGS = '0';

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
let AsyncFS;
// Defer module import until after env is set to avoid prod-only logging guard
async function getAsyncFS() {
  if (!AsyncFS) {
    const mod = await import('../../monolith.js');
    AsyncFS = mod.AsyncFS;
  }
  return AsyncFS;
}

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => resolve({ code, out, err }));
    child.on('error', reject);
  });
}

test('Distributed rate limiter coordinates across processes', async () => {
  const worker = path.join(process.cwd(), 'scripts', 'tests', 'helpers', 'shared_rl_worker.mjs');
  const envBase = { RL_LIMIT: '3', RL_WINDOW_MS: '1000', RL_KEY: 'alpha' };
  const p1 = runNode(worker, { NODE_ENV: 'test', ...envBase, N_CALLS: '5' });
  const p2 = runNode(worker, { NODE_ENV: 'test', ...envBase, N_CALLS: '5' });
  const [r1, r2] = await Promise.all([p1, p2]);
  const j1 = JSON.parse(r1.out || '{}');
  const j2 = JSON.parse(r2.out || '{}');
  const totalOk = Number(j1.ok || 0) + Number(j2.ok || 0);
  assert.ok(totalOk <= 3);
});

test('Disk-pressure drill triggers fatal FS handling and circuit open', async () => {
  const probe = path.join(process.cwd(), 'scripts', 'tests', 'helpers', 'fs_pressure_probe.mjs');
  const env = {
    URGA_TEST_FS_ERROR_OP: 'writeFile',
    URGA_TEST_FS_ERROR_CODE: 'ENOSPC',
    URGA_TEST_FS_ERROR_PATH_RX: 'enospc',
    EXIT_ON_FATAL_FS: '1',
    CIRCUIT_ERROR_THRESHOLD: '1'
  };
  const r = await runNode(probe, { NODE_ENV: 'test', ...env });
  const j = JSON.parse(r.out || '{}');
  assert.equal(j.firstErrorCode, 'ENOSPC');
  assert.equal(j.circuitOpen, true);
  assert.equal(j.ready, false);
});

test('Kill-during-write leaves tmp artifacts and preserves original file', async () => {
  const target = path.join(process.cwd(), 'tmp.kill.write.json');
  const FS = await getAsyncFS();
  try { await FS.writeFile(target, '"A"', 'utf8'); } catch {}
  const probe = path.join(process.cwd(), 'scripts', 'tests', 'helpers', 'kill_during_write_probe.mjs');
  const env = { TARGET: target, URGA_TEST_DELAY_BEFORE_RENAME_MS: '200', KILL_MS: '50' };
  const r = await runNode(probe, { NODE_ENV: 'test', ...env });
  const raw = await FS.readFile(target, 'utf8');
  assert.equal(String(raw).trim(), '"A"');
  const dir = path.dirname(target);
  const files = fs.readdirSync(dir).filter(f => f.includes(path.basename(target) + '.tmp-'));
  assert.ok(files.length > 0);
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
