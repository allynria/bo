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

test('Prod JSON-only gate: non_json_log_total must equal 0', async () => {
  const port = 3350 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    QUEUE_MAX: '0',
  });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  // Poll /metrics for counter; guard against brief startup noise
  let count = null;
  for (let i = 0; i < 10 && count == null; i++) {
    const metrics = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
    assert.equal(metrics.status, 200);
    const cs = Array.isArray(metrics.json?.counters) ? metrics.json.counters : [];
    const item = cs.find((c) => c.name === 'non_json_log_total');
    count = item ? Number(item.value) : 0;
    if (count == null) await new Promise((r) => setTimeout(r, 35));
  }
  assert.equal(Number(count || 0), 0, 'non_json_log_total must be zero in production');

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
