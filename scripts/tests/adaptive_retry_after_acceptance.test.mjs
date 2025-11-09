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

function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      // Drain to free socket
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    }).on('error', reject);
  });
}

// Acceptance: Under step-load, clients honoring Retry-After should see ≥95% successes by T+10s
test('Adaptive Retry-After: ≥95% succeed by T+10s under step-load', async () => {
  const port = 3450 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '1' });
  const base = `http://localhost:${port}`;
  // Wait until /healthz is reachable
  await waitForUp(base, { timeout: 3000 });

  // Step-load: fire N concurrent clients to /other honoring Retry-After
  const N = 40;
  const deadline = Date.now() + 10_000; // T+10s
  const clients = [];
  for (let i = 0; i < N; i++) {
    clients.push((async () => {
      while (Date.now() < deadline) {
        const r = await fetchStatus(`${base}/other`).catch(() => ({ status: 0, headers: {}, json: {} }));
        if (r.status !== 503) return true; // success when not gated
        const ra = Number(r.headers?.['retry-after'] || r.headers?.['Retry-After'] || r.json?.retry_after_s || 1);
        const waitMs = Math.max(100, Math.min(3000, Math.ceil(ra * 1000)));
        await new Promise((res) => setTimeout(res, waitMs));
      }
      return false; // deadline exceeded
    })());
  }
  const results = await Promise.all(clients);
  const successes = results.filter(Boolean).length;
  const ratio = successes / N;
  assert.ok(ratio >= 0.95, `Expected ≥95% success; got ${(ratio*100).toFixed(1)}%`);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
