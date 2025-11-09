import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Fetch only status/headers; body may not be JSON
function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

test('Token budget gate returns 429 and increments budget_prevented_total on both endpoints', async () => {
  const port = 4520 + Math.floor(Math.random() * 200);
  const env = {
    NODE_ENV: 'test',
    LOG_JSON: '1',
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    // Ensure token estimate exceeds small budget
    LLM_EXPECTED_TOKENS_OUT: '128',
    TENANT_TOKENS_BUDGET: '10',
    TENANT_TOKENS_WINDOW_MS: '60000'
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 4000 });

  // /conv/message should be denied by token gate
  const body = { text: 'hello world', conv_id: 'tok-gate-msg', turn: 0, engine: 'urga' };
  const r1 = await postJson(`${base}/conv/message`, body);
  assert.equal(r1.status, 429, 'message endpoint must return 429 when token budget insufficient');
  assert.equal(r1.json?.error, 'budget_limited');
  assert.equal(r1.json?.reason, 'tenant_tokens');

  // /conv/stream should be denied by token gate (pre-check)
  const r2 = await fetchStatus(`${base}/conv/stream?text=hello&conv_id=tok-gate-stream&turn=0&engine=urga`);
  assert.equal(r2.status, 429, 'stream endpoint must return 429 when token budget insufficient');

  // Poll /metrics for budget_prevented_total increments with tokens scope
  let count = 0;
  for (let i = 0; i < 12 && count < 2; i++) {
    const metrics = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
    assert.equal(metrics.status, 200, '/metrics must be accessible');
    const counters = Array.isArray(metrics.json?.counters) ? metrics.json.counters : [];
    count = counters.filter((c) => c.name === 'budget_prevented_total' && c.labels?.scope === 'tenant_tokens_http').reduce((sum, c) => sum + Number(c.value || 0), 0);
    if (count < 2) await new Promise((r) => setTimeout(r, 35));
  }
  assert.ok(count >= 2, 'budget_prevented_total for tenant_tokens_http should increment for both denials');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

