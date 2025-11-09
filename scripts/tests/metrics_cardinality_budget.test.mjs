import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c.toString();
        });
        res.on('end', () => {
          let j = {};
          try {
            j = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode, json: j });
        });
      })
      .on('error', reject);
  });
}

// Using shared readiness polling helper

test('metrics cardinality stays under CI budget', async () => {
  const port = 3900 + Math.floor(Math.random() * 500);
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port) });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });
  // Generate a few diverse response statuses to populate counters
  await fetchJson(`${base}/healthz`);
  await fetchJson(`${base}/wait?ms=1`);
  await fetchJson(`${base}/drain/start?ms=10`);
  await fetchJson(`${base}/readyz`);
  // Unauthorized metrics when admin token is not set should be open; count snapshot
  const m = await fetchJson(`${base}/metrics`);
  const counters = m.json.counters || [];
  const budget = Number(process.env.METRICS_CARDINALITY_BUDGET || 50);
  assert.ok(counters.length <= budget, `counters length ${counters.length} should be <= ${budget}`);
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
