import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function runWorker(env = {}, args = []) {
  const worker = path.resolve('scripts/tool_isolation_worker.mjs');
  return new Promise((resolve) => {
    const ps = spawn(process.execPath, [worker, ...args], { env: { ...process.env, ...env } });
    let out = '';
    ps.stdout.on('data', (d) => { out += String(d); });
    ps.stderr.on('data', (d) => { out += String(d); });
    ps.on('close', (code) => resolve({ code, out }));
  });
}

test('CI check: worker enforces --no-network when policy net.allow is empty', async () => {
  const tmp = path.join(os.tmpdir(), `tool-worker-${Date.now()}`);
  try { fs.mkdirSync(tmp, { recursive: true }); } catch {}
  const policy = { version: 1, tool: 'echo', fs: { allow: [tmp] }, net: { allow: [] }, limits: { timeout_ms: 3000 } };
  const baseEnv = {
    TOOL_POLICY_REQUIRED: '1',
    TOOL_POLICY_JSON: JSON.stringify(policy),
    TOOL_OP: 'mark',
    TOOL_ID: 'ci-no-net',
    TOOL_DIR: tmp,
    TOOL_NAME: 'echo'
  };
  // Without --no-network should fail closed
  const res1 = await runWorker(baseEnv, []);
  assert.notEqual(res1.code, 0);
  assert.ok(res1.out.includes('no_network_flag_required'));

  // With --no-network should pass
  const res2 = await runWorker(baseEnv, ['--no-network']);
  assert.equal(res2.code, 0);
});

