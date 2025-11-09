import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as http from 'node:http';
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

test('Tool isolation worker: allows network when host:port is allowlisted', async () => {
  // Spin up a local HTTP server on 127.0.0.1
  const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('allow');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' ? (addr.port || 0) : 0;
  const url = `http://127.0.0.1:${port}/`;

  try {
    const env = {
      TOOL_OP: 'fetch_url',
      TOOL_FETCH_URL: url,
      TOOL_NET_ALLOWLIST: JSON.stringify([`127.0.0.1:${port}`]),
      TOOL_FAIL_CLOSED: '1'
    };
    const r = await runWorkerEnv(env);
    assert.equal(r.code, 0, `worker exited OK: ${r.stderr}`);
    const payload = JSON.parse(r.stdout || '{}');
    assert.equal(payload.ok, true, 'fetch_url returned ok');
    assert.equal(payload.statusCode, 200, 'status code 200');
    assert.ok(Number(payload.bytes || 0) > 0, 'received some bytes');
  } finally {
    try { server.close(); } catch {}
  }
});

