import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
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

test('Service: 429 policy vs 503 backpressure taxonomy and metrics', async () => {
  // Case 1: Policy limiter produces 429 without backpressure interference
  const port1 = 3800 + Math.floor(Math.random() * 100);
  const env1 = {
    PORT: String(port1),
    QUEUE_MAX: '0', // disable backpressure
    POLICY_LIMIT: '2',
    POLICY_WINDOW_MS: '100',
    POLICY_INTERNAL_ERROR_ONCE: '0',
    LOG_JSON: '1',
  };
  const { child: child1 } = startService(env1);
  const base1 = `http://localhost:${port1}`;
  // Ensure service is ready before proceeding to avoid flake under parallel runs
  await waitForUp(base1, { timeout: 3000 });
  // First two under limit -> 404, next two -> 429
  const r1 = await fetchJson(`${base1}/other`);
  const r2 = await fetchJson(`${base1}/other`);
  const r3 = await fetchJson(`${base1}/other`);
  const r4 = await fetchJson(`${base1}/other`);
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
  assert.equal(r3.status, 429);
  assert.equal(r4.status, 429);
  assert.ok(r3.headers['retry-after']);
  assert.ok(r4.headers['retry-after']);
  const m1 = await fetchJson(`${base1}/metrics`);
  const counters1 = m1.json.counters || [];
  const policy429Count = counters1.find((c) => c.name === 'rate_limited_total' && c.labels?.reason === 'policy')?.value || 0;
  const resp429Count = counters1.find((c) => c.name === 'responses_total' && c.labels?.status === '429')?.value || 0;
  assert.equal(policy429Count, 2);
  assert.equal(resp429Count, 2);
  try { child1.kill(); } catch {}
  await new Promise((r) => child1.on('exit', r));

  // Case 2: Backpressure produces 503 under load with Retry-After
  const port2 = 3900 + Math.floor(Math.random() * 100);
  const env2 = {
    PORT: String(port2),
    QUEUE_MAX: '2', // low threshold to trigger quickly
    LOG_JSON: '1',
  };
  const { child: child2 } = startService(env2);
  const base2 = `http://localhost:${port2}`;
  // Ensure service is ready before proceeding
  await waitForUp(base2, { timeout: 3000 });
  // Fire multiple concurrent requests to exceed QUEUE_MAX
  const reqs = Array.from({ length: 6 }, () => fetchJson(`${base2}/other`));
  const results = await Promise.all(reqs);
  const any503 = results.some((r) => r.status === 503);
  assert.ok(any503, 'Expected at least one 503 due to backpressure');
  const withRetryAfter = results.filter((r) => r.status === 503 && !!r.headers['retry-after']);
  assert.ok(withRetryAfter.length >= 1, '503 responses should include Retry-After');
  const m2 = await fetchJson(`${base2}/metrics`);
  const counters2 = m2.json.counters || [];
  const backpressureCount = counters2.find((c) => c.name === 'rate_limited_total' && c.labels?.reason === 'backpressure')?.value || 0;
  const resp503Count = counters2.find((c) => c.name === 'responses_total' && c.labels?.status === '503')?.value || 0;
  assert.ok(backpressureCount >= 1);
  assert.ok(resp503Count >= 1);
  try { child2.kill(); } catch {}
  await new Promise((r) => child2.on('exit', r));
});
