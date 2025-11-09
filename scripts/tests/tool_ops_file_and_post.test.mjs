import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import http from 'node:http';
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

function tmpBase() {
  return path.join(os.tmpdir(), `trae_tool_ops_${process.pid}_${Math.floor(Math.random()*10000)}`);
}

test('write_file then read_file within allowlist', async () => {
  const base = tmpBase();
  const dir = path.join(base, 'allowed');
  const p = path.join(dir, 'data.bin');
  const content = 'hello world';
  // write_file
  let env = {
    TOOL_OP: 'write_file',
    TOOL_WRITE_PATH: p,
    TOOL_WRITE_CONTENT_B64: Buffer.from(content, 'utf8').toString('base64'),
    TOOL_FS_ALLOWLIST: JSON.stringify([dir]),
    TOOL_FAIL_CLOSED: '1'
  };
  let r = await runWorkerEnv(env);
  assert.equal(r.code, 0, 'write_file succeeded');
  // read_file
  env = {
    TOOL_OP: 'read_file',
    TOOL_READ_PATH: p,
    TOOL_FS_ALLOWLIST: JSON.stringify([dir]),
    TOOL_FAIL_CLOSED: '1'
  };
  r = await runWorkerEnv(env);
  assert.equal(r.code, 0, 'read_file succeeded');
  const payload = JSON.parse(r.stdout || '{}');
  const got = Buffer.from(String(payload.content_b64 || ''), 'base64').toString('utf8');
  assert.equal(got, content, 'content roundtrip matches');
});

test('read_json parses JSON within allowlist', async () => {
  const base = tmpBase();
  const dir = path.join(base, 'allowed');
  const p = path.join(dir, 'data.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ a: 1, b: 'x' }), 'utf8');
  const env = {
    TOOL_OP: 'read_json',
    TOOL_READ_JSON_PATH: p,
    TOOL_FS_ALLOWLIST: JSON.stringify([dir]),
    TOOL_FAIL_CLOSED: '1'
  };
  const r = await runWorkerEnv(env);
  assert.equal(r.code, 0, 'read_json succeeded');
  const payload = JSON.parse(r.stdout || '{}');
  assert.equal(payload.data?.a, 1, 'json field a');
  assert.equal(payload.data?.b, 'x', 'json field b');
});

test('post_json sends body and returns 200', async () => {
  // Local server verifies JSON body
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    for await (const chunk of req) body += chunk;
    try { const j = JSON.parse(body); if (j && j.ping === 'pong') { res.statusCode = 200; } else { res.statusCode = 400; } } catch { res.statusCode = 400; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' ? (addr.port || 0) : 0;
  const url = `http://127.0.0.1:${port}/api`;
  try {
    const env = {
      TOOL_OP: 'post_json',
      TOOL_POST_URL: url,
      TOOL_POST_BODY_JSON: JSON.stringify({ ping: 'pong' }),
      TOOL_NET_ALLOWLIST: JSON.stringify([`127.0.0.1:${port}`]),
      TOOL_FAIL_CLOSED: '1'
    };
    const r = await runWorkerEnv(env);
    assert.equal(r.code, 0, `worker exited OK: ${r.stderr}`);
    const payload = JSON.parse(r.stdout || '{}');
    assert.equal(payload.ok, true, 'post_json returned ok');
    assert.equal(payload.statusCode, 200, 'status code 200');
    assert.ok(Number(payload.bytes || 0) > 0, 'received some bytes');
  } finally {
    try { server.close(); } catch {}
  }
});

