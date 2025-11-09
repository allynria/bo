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

test('Queue depth tracks inflight within ±5% and backpressure gates', async () => {
  const port = 4100 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({
    NODE_ENV: 'test',
    PORT: String(port),
    LOG_JSON: '1',
    QUEUE_MAX: '5',
  });
  console.info('[service:logs:init]', getLogs().split(/\r?\n/).slice(0, 10).join('\n'));
  // Logs are expected to be JSON in production; for this test we focus on metrics
  const base = `http://localhost:${port}`;
  // Ensure /healthz responds before proceeding to avoid early flake
  await waitForUp(base, { timeout: 3000 });
  // Enqueue pending work: 20 waiters for ~1000ms to keep saturation during assertions
  const N = 20;
  const waiters = [];
  for (let i = 0; i < N; i++) waiters.push(fetchJson(`${base}/wait?ms=1000`));
  // Give them a moment to all be inflight, sample multiple times for stability
  await new Promise((r) => setTimeout(r, 250));
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const hz = await fetchJson(`${base}/healthz`);
    samples.push({
      inflight: Number(hz.json?.inflight ?? 0),
      depth: Number(hz.json?.queueDepth ?? 0),
    });
    await new Promise((r) => setTimeout(r, 40));
  }
  const sortNum = (a, b) => a - b;
  const median = (arr) => {
    const s = [...arr].sort(sortNum);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const inflightMed = median(samples.map((s) => s.inflight));
  const depthMed = median(samples.map((s) => s.depth));
  const diffs = samples
    .filter((s) => s.inflight > 0)
    .map((s) => Math.abs(s.depth - s.inflight) / s.inflight);
  const diffMed = diffs.length ? median(diffs) : 0;
  console.info('[queue-depth:debug] samples', samples);
  console.info('[queue-depth:debug]', { inflightMed, depthMed, diffMed });
  assert.ok(diffMed <= 0.05, `median diffPct ${diffMed} exceeds 5%`);
  // When depth>=max, new non-probe requests get 503 with Retry-After.
  // Retry a few times to avoid timing flake when the queue hasn’t saturated yet.
  let saw503 = false;
  let retryHeader = '';
  for (let i = 0; i < 15 && !saw503; i++) {
    const other = await fetchJson(`${base}/other`);
    console.info('[backpressure:debug] attempt', i, 'status', other.status);
    if (other.status === 503) {
      saw503 = true;
      retryHeader = other.headers['retry-after'] || '';
    } else {
      await new Promise((r) => setTimeout(r, 35));
    }
  }
  assert.equal(saw503, true, 'backpressure should return 503 under load');
  assert.ok(retryHeader, 'Retry-After header present');
  // Drain
  await Promise.all(waiters);
  // Stop service
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
