import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

function runWorkerEnv(env, opts = {}) {
  const script = path.join(process.cwd(), 'scripts', 'tool_isolation_worker.mjs');
  const memMb = Number(opts.memoryMb || 64);
  const child = spawn(process.execPath, [`--max-old-space-size=${memMb}`, script], { env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return new Promise((resolve) => {
    const to = setTimeout(() => { try { child.kill('SIGKILL'); } catch {}; resolve({ code: -1, stdout, stderr, timeout: true }); }, Math.max(500, Number(env.TOOL_TIMEOUT_MS || 2000)));
    child.on('exit', (code) => { clearTimeout(to); resolve({ code, stdout, stderr }); });
  });
}

test('Worker denies network: localhost not allowlisted', async () => {
  const env = {
    TOOL_OP: 'fetch_url',
    TOOL_FETCH_URL: 'http://localhost:65535/',
    TOOL_NET_ALLOWLIST: '',
    TOOL_FAIL_CLOSED: '1'
  };
  const r = await runWorkerEnv(env);
  assert.notEqual(r.code, 0, 'network denied for localhost');
});

test('Worker denies network: [::1] not allowlisted', async () => {
  const env = {
    TOOL_OP: 'fetch_url',
    TOOL_FETCH_URL: 'http://[::1]:65535/',
    TOOL_NET_ALLOWLIST: '',
    TOOL_FAIL_CLOSED: '1'
  };
  const r = await runWorkerEnv(env);
  assert.notEqual(r.code, 0, 'network denied for [::1]');
});

test('Worker denies network: raw IPv6 ::1 not allowlisted', async () => {
  // URL parser requires bracketed form, but guardNet builds a synthetic URL string
  // This still results in deny due to isHostAllowed failing to validate unallowed host.
  const env = {
    TOOL_OP: 'net_probe',
    TOOL_NET_PROBE: 'http://[::1]:65535/',
    TOOL_NET_ALLOWLIST: '',
    TOOL_FAIL_CLOSED: '1'
  };
  const r = await runWorkerEnv(env);
  assert.notEqual(r.code, 0, 'network denied for ::1');
});

