// Gate RSS memory growth under a short load burst.
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

async function fetchStatus(url) {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      })
      .on('error', () => resolve({ status: 0, headers: {} }));
  });
}

test('Memory budget gate: RSS growth ≤ 20MB under short load', async () => {
  const port = 3550 + Math.floor(Math.random() * 100);
  const env = { NODE_ENV: 'test', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  // Wait for readiness
  await waitForUp(base, { timeout: 3000 });

  const hz1 = await fetchJson(`${base}/healthz`);
  assert.equal(hz1.status, 200);
  const mem1 = Number(hz1.json?.memory_mb || 0);

  // Short load: 600 requests to /wait?ms=3 with concurrency 30
  const N = 600;
  const CONC = 30;
  const ms = 3;
  let idx = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (true) {
      const i = idx++;
      if (i >= N) break;
      await fetchStatus(`${base}/wait?ms=${ms}`);
    }
  });
  await Promise.all(workers);

  // Post-load RSS
  const hz2 = await fetchJson(`${base}/healthz`);
  assert.equal(hz2.status, 200);
  const mem2 = Number(hz2.json?.memory_mb || 0);
  const growth = Math.max(0, mem2 - mem1);
  assert.ok(growth <= 20, `RSS growth must be ≤ 20MB, got ${growth}MB (from ${mem1} → ${mem2})`);

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
