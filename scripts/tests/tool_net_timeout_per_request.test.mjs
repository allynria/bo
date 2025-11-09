import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

function runWorkerEnv(env, opts = {}) {
  const script = path.join(process.cwd(), 'scripts', 'tool_isolation_worker.mjs');
  const memMb = Number(opts.memoryMb || 64);
  const child = spawn(process.execPath, [`--max-old-space-size=${memMb}`, script], {
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  return new Promise((resolve) => {
    const to = setTimeout(
      () => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve({ code: -1, stdout, stderr, timeout: true });
      },
      Math.max(500, Number(env.TOOL_TIMEOUT_MS || 3000))
    );
    child.on('exit', (code) => {
      clearTimeout(to);
      resolve({ code, stdout, stderr });
    });
  });
}

test('Worker enforces per-request network timeout', async () => {
  // Server accepts connections but never responds
  const server = http.createServer((_req, _res) => {
    /* hang intentionally */
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' ? addr.port || 0 : 0;
  const url = `http://127.0.0.1:${port}/`;
  try {
    const env = {
      TOOL_OP: 'fetch_url',
      TOOL_FETCH_URL: url,
      TOOL_NET_ALLOWLIST: JSON.stringify([`127.0.0.1:${port}`]),
      TOOL_NET_TIMEOUT_MS: '1000',
      TOOL_TIMEOUT_MS: '3000',
      TOOL_FAIL_CLOSED: '1',
    };
    const r = await runWorkerEnv(env);
    assert.notEqual(r.code, 0, 'worker should exit with error on timeout');
    const payload = JSON.parse(r.stdout || '{}');
    assert.equal(payload.ok, false, 'fetch_url returned error');
    assert.match(String(payload.error || ''), /timeout/i, 'error indicates timeout');
  } finally {
    try {
      server.close();
    } catch {}
  }
});
