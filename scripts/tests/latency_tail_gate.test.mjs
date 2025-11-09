// Gate tail latency via respond_ms_bucket distribution under short steady load.
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

const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent }, (res) => {
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

async function fetchStatus(url) {
  return new Promise((resolve) => {
    http
      .get(url, { agent }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', () => resolve({ status: 0, headers: {} }));
  });
}

test('Latency tail gate: p99 ≤ 10ms under /wait steady load', async () => {
  const port = 4300 + Math.floor(Math.random() * 100);
  const env = { NODE_ENV: 'test', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  // Wait for readiness
  await waitForUp(base, { timeout: 3000 });

  // Fire N requests to /wait with fixed service time
  const N = 400;
  const CONC = 25;
  const ms = 5; // target service time
  let idx = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (true) {
      const i = idx++;
      if (i >= N) break;
      // Use fetchStatus to avoid parse overhead; metrics are the focus
      await fetchStatus(`${base}/wait?ms=${ms}`);
    }
  });
  await Promise.all(workers);

  // Pull metrics and compute p99 from bucket counts
  const m = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
  assert.equal(m.status, 200, 'metrics endpoint must be available');
  const counters = Array.isArray(m.json?.counters) ? m.json.counters : [];
  const bucket = counters.filter((c) => c.name === 'respond_ms_bucket');
  assert.ok(bucket.length >= 1, 'respond_ms_bucket counters must exist');
  const total = bucket.reduce((s, c) => s + Number(c.value || 0), 0);
  assert.ok(total >= N * 0.9, `expected ~${N} completions, saw ${total}`);
  const byLe = bucket.reduce((acc, c) => {
    const le = String(c.labels?.le || 'gt1000');
    acc[le] = (acc[le] || 0) + Number(c.value || 0);
    return acc;
  }, {});
  const order = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000, 'gt1000'];
  let cum = 0;
  let p99Le = 'gt1000';
  for (const k of order) {
    const v = Number(byLe[k] || 0);
    cum += v;
    if (cum / total >= 0.99) {
      p99Le = k;
      break;
    }
  }
  // Gate: p99 should be at or below 10ms
  assert.ok(p99Le !== 'gt1000', 'p99 bucket must not exceed 1000ms');
  const P99_MAX_MS = process.platform === 'win32' ? 20 : 10;
  assert.ok(
    (typeof p99Le === 'number' ? p99Le : Number(p99Le)) <= P99_MAX_MS,
    `p99 must be ≤ ${P99_MAX_MS}ms, got bucket ${String(p99Le)}`
  );

  // Ensure keep-alive sockets are closed so the test runner doesn’t hang on open handles.
  try {
    agent.destroy();
  } catch {}
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
