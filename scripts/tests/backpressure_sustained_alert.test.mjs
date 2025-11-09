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

// Fetch only status/headers
function fetchStatus(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); }).on('error', reject);
  });
}

test('Sustained backpressure emits backpressure_sustained_total and bucket', async () => {
  const port = 3600 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '1', BP_SUSTAIN_MS: '1000' });
  const base = `http://localhost:${port}`;
  // Ensure service is ready
  await waitForUp(base, { timeout: 3000 });

  // Saturate depth with a single long wait
  const waiter = fetchJson(`${base}/wait?ms=1500`).catch(() => ({ status: 0 }));

  // Trigger gating and keep it active during the wait
  const startTs = Date.now();
  while (Date.now() - startTs < 1200) {
    const other = await fetchStatus(`${base}/other`).catch(() => ({ status: 0 }));
    assert.ok([503, 0].includes(other.status), 'backpressure should gate /other during saturation');
    await new Promise((r) => setTimeout(r, 40));
  }

  // After wait finishes, poke /other once to finalize sustained window accounting
  await waiter;
  await fetchStatus(`${base}/other`);

  // Poll /metrics for sustained counters
  let sawSustained = false; let sawBucket = false;
  for (let i = 0; i < 15 && (!sawSustained || !sawBucket); i++) {
    const metrics = await fetchJson(`${base}/metrics`).catch(() => ({ status: 0, json: {} }));
    assert.equal(metrics.status, 200);
    const cs = Array.isArray(metrics.json?.counters) ? metrics.json.counters : [];
    sawSustained = !!cs.find((c) => c.name === 'backpressure_sustained_total' && Number(c.value) >= 1);
    sawBucket = !!cs.find((c) => c.name === 'backpressure_sustained_ms_bucket' && typeof c.labels?.le === 'string');
    if (!sawSustained || !sawBucket) await new Promise((r) => setTimeout(r, 35));
  }
  assert.equal(sawSustained, true, 'backpressure_sustained_total should be emitted');
  assert.equal(sawBucket, true, 'backpressure_sustained_ms_bucket should be emitted');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
