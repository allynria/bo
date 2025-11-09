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
  child.stdout.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (d) => {
          data += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(data || '{}'),
            });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

test('Synthetic alerts toggles are reflected in /metrics counters', async () => {
  const port = 3400 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
  });
  // Wait for server to be ready via /healthz
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });
  const names = [
    'alert_latency_p95_exceeded_total',
    'alert_latency_p99_exceeded_total',
    'alert_circuit_open_total',
    'alert_rate_limited_spike_total',
  ];
  for (const n of names) {
    const r = await fetchJson(`${base}/alert/test?name=${encodeURIComponent(n)}`);
    assert.equal(r.status, 200);
    assert.equal(r.json?.toggled, n);
  }
  for (const n of names) {
    let hit = null;
    for (let i = 0; i < 12 && !hit; i++) {
      const metrics = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
      assert.equal(metrics.status, 200);
      const cs = Array.isArray(metrics.json?.counters) ? metrics.json.counters : [];
      hit =
        cs.find((c) => c.name === n && c.labels?.synthetic === '1' && Number(c.value) >= 1) || null;
      if (!hit) await new Promise((r) => setTimeout(r, 35));
    }
    assert.ok(!!hit, `Counter ${n} must be present with synthetic label`);
  }
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
