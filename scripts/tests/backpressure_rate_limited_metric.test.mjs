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

// Fetch only status/headers; body may not be JSON (e.g., 404 text)
function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', reject);
  });
}

test('Backpressure emits rate_limited_total{reason="backpressure"}', async () => {
  const port = 3700 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({
    NODE_ENV: 'test',
    LOG_JSON: '1',
    PORT: String(port),
    QUEUE_MAX: '1',
  });
  const base = `http://localhost:${port}`;
  // Ensure service is ready before proceeding to avoid flake under parallel runs
  await waitForUp(base, { timeout: 3000 });
  // Saturate queue: 8 waiters for ~500ms
  const N = 8;
  const waiters = [];
  for (let i = 0; i < N; i++)
    waiters.push(fetchJson(`${base}/wait?ms=500`).catch(() => ({ status: 0 })));
  // Wait until queueDepth reaches QUEUE_MAX (1) to ensure gating
  let saturated = false;
  for (let i = 0; i < 20 && !saturated; i++) {
    try {
      const hz = await fetchJson(`${base}/healthz`);
      const depth = Number(hz.json?.queueDepth || 0);
      console.info('[rl-metric:debug] healthz depth', depth);
      if (depth >= 1) saturated = true;
    } catch {}
    if (!saturated) await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(saturated, true, 'queueDepth should reach QUEUE_MAX before gating check');
  // Trigger gated requests with retries until we observe a 503
  let saw503 = false;
  for (let i = 0; i < 15 && !saw503; i++) {
    const other = await fetchStatus(`${base}/other`);
    console.info('[rl-metric:debug] attempt', i, 'status', other.status);
    if (other.status === 503) {
      assert.ok(other.headers['retry-after'], 'Retry-After header present');
      saw503 = true;
    } else {
      await new Promise((r) => setTimeout(r, 35));
    }
  }
  assert.equal(saw503, true, 'backpressure should return 503 under load');
  // Assert via /metrics since it is treated as a probe and ungated; poll briefly for counter
  let match = null;
  for (let i = 0; i < 12 && !match; i++) {
    const metrics = await fetchJson(`${base}/metrics`);
    console.info('[rl-metric:debug] metrics status', metrics.status);
    assert.equal(metrics.status, 200);
    const counters = Array.isArray(metrics.json?.counters) ? metrics.json.counters : [];
    console.info('[rl-metric:debug] counters', counters);
    match =
      counters.find(
        (c) =>
          c.name === 'rate_limited_total' &&
          c.labels?.reason === 'backpressure' &&
          Number(c.value) >= 1
      ) || null;
    if (!match) await new Promise((r) => setTimeout(r, 35));
  }
  assert.ok(!!match, 'rate_limited_total backpressure increment observed in metrics');
  // Cleanup
  try {
    await Promise.allSettled(waiters);
  } catch {}
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
