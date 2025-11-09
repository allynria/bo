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

test('Production: JSON-only logs and probe contract under drain', async () => {
  const port = 4000 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    QUEUE_MAX: '3',
  });
  // Wait for readiness to avoid early flake
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 2000 });
  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  // All logs must be JSON lines
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      assert.fail(`Non-JSON log line in production: ${line}`);
    }
  }
  // Validate healthz contract fields
  const hz1 = await fetchJson(`${base}/healthz`);
  assert.equal(hz1.status, 200);
  const j1 = hz1.json || {};
  for (const f of ['ok', 'circuitOpen', 'inflight', 'queueDepth', 'pid', 'uptime_s']) {
    assert.ok(f in j1, `healthz missing field: ${f}`);
  }
  // Enqueue pending work (attach catch to avoid unhandled rejections during drain)
  const N = 8;
  const waiters = [];
  for (let i = 0; i < N; i++)
    waiters.push(fetchJson(`${base}/wait?ms=400`).catch((e) => ({ status: 0, error: String(e) })));
  await new Promise((r) => setTimeout(r, 100));
  const hz2 = await fetchJson(`${base}/healthz`);
  const inflight = Number(hz2.json?.inflight || 0);
  const depth = Number(hz2.json?.queueDepth || 0);
  const diffPct = inflight > 0 ? Math.abs(depth - inflight) / inflight : 0;
  assert.ok(diffPct <= 0.05, `queueDepth ${depth} tracks inflight ${inflight} within ±5% in prod`);
  // Backpressure gate: when depth>=max, non-probe gets 503 and Retry-After
  const other = await fetchJson(`${base}/other`);
  assert.equal(other.status, 503);
  assert.ok(other.headers['retry-after'], 'Retry-After header present');
  // Verify readyz is true before initiating drain
  const rzBefore = await fetchJson(`${base}/readyz`).catch(() => ({ status: 0 }));
  assert.equal(rzBefore.status, 200);
  assert.equal(rzBefore.json?.ready, true);
  // Initiate drain, then drain waiters and stop service
  try {
    child.kill('SIGTERM');
  } catch {}
  try {
    await Promise.allSettled(waiters);
  } catch {}
  await new Promise((r) => child.on('exit', r));
  // Verify all collected logs remain JSON-only
  const finalLines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  for (const line of finalLines) {
    try {
      JSON.parse(line);
    } catch {
      assert.fail(`Non-JSON log line in production: ${line}`);
    }
  }
});
