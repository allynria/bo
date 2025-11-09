import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

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

test('worker fails closed when policy is required but missing', async () => {
  const env = {
    TOOL_POLICY_REQUIRED: '1',
    TOOL_OP: 'mark',
    TOOL_ID: 't1',
    TOOL_DIR: path.resolve('C:/tmp')
  };
  const res = await runWorker(env);
  assert.notEqual(res.code, 0);
  assert.ok(res.out.includes('policy_missing'));
});

test('worker runs when policy is provided', async () => {
  const env = {
    TOOL_POLICY_REQUIRED: '1',
    TOOL_POLICY_JSON: JSON.stringify({ version: 1, tool: 'echo', fs: { allow: [path.resolve('C:/tmp')] }, net: { allow: ['localhost'] }, limits: { timeout_ms: 5000 } }),
    TOOL_OP: 'mark',
    TOOL_ID: 't2',
    TOOL_DIR: path.resolve('C:/tmp'),
    TOOL_NAME: 'echo'
  };
  const res = await runWorker(env);
  assert.equal(res.code, 0);
});

