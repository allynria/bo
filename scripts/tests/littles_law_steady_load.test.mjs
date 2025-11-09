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

test('Little’s Law: avg queueDepth ≈ λ × W within 10% under steady load', async () => {
  const port = 3475 + Math.floor(Math.random() * 100);
  const { child } = startService({
    NODE_ENV: 'test',
    LOG_JSON: '1',
    PORT: String(port),
    QUEUE_MAX: '0',
  });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  // Drive steady load: maintain ~CONC concurrent /wait requests for WINDOW_MS
  const CONC = 25;
  const W_ms = 100;
  const WINDOW_MS = 1000;
  const endAt = Date.now() + WINDOW_MS;
  const inflight = new Set();
  async function runWorker() {
    while (Date.now() < endAt) {
      const p = fetchJson(`${base}/wait?ms=${W_ms}`).finally(() => inflight.delete(p));
      inflight.add(p);
      // yield to keep steady pacing
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const workers = Array.from({ length: CONC }, () => runWorker());

  // Sample queueDepth multiple times to compute average during load
  // Also measure λ (completions/sec) over the SAME sampling window
  const metricsStart = await fetchJson(`${base}/metrics`);
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const hz = await fetchJson(`${base}/healthz`);
    samples.push(Number(hz.json?.queueDepth || 0));
    await new Promise((r) => setTimeout(r, 50));
  }
  // Compute λ via /metrics counters over the sampling window (~1.0s)
  const metricsEnd = await fetchJson(`${base}/metrics`);
  const counters1 = Array.isArray(metricsStart.json?.counters) ? metricsStart.json.counters : [];
  const counters2 = Array.isArray(metricsEnd.json?.counters) ? metricsEnd.json.counters : [];
  const c1 = counters1.find((c) => c.name === 'completions_total') || { value: 0 };
  const c2 = counters2.find((c) => c.name === 'completions_total') || { value: 0 };
  const delta = Number(c2.value || 0) - Number(c1.value || 0);
  const lambda = delta / 1.0; // per second, sampling window ~1s

  const avgDepth = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  const W_sec = W_ms / 1000.0;
  const expected = lambda * W_sec;
  const MAX_DEV = process.platform === 'win32' ? 0.2 : 0.1;
  const err = expected > 0 ? Math.abs(avgDepth - expected) / expected : 0;
  assert.ok(
    err <= MAX_DEV,
    `Little’s Law deviation ${(err * 100).toFixed(1)}% exceeds ${(MAX_DEV * 100).toFixed(0)}% (avgDepth=${avgDepth.toFixed(2)}, λ=${lambda.toFixed(2)}, W=${W_sec.toFixed(3)})`
  );

  await Promise.allSettled(workers);
  await Promise.allSettled([...inflight]);
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
