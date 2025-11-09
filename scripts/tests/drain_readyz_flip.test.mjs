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

test('Probe CI gate: /readyz flips false during drain and logs JSON-only', async () => {
  const port = 4200 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '3' });
  const base = `http://localhost:${port}`;
  // Wait for readiness to avoid early flake
  await waitForUp(base, { timeout: 3000 });
  // Hold multiple connections to ensure drain takes time
  const N = 6;
  const waiters = [];
  for (let i = 0; i < N; i++) waiters.push(fetchJson(`${base}/wait?ms=500`).catch(() => ({ status: 0 })));
  await new Promise((r) => setTimeout(r, 200));
  // Sanity: ready before drain
  const rz1 = await fetchJson(`${base}/readyz`);
  assert.equal(rz1.status, 200);
  assert.equal(rz1.json?.ready, true);
  // Initiate drain via HTTP, then check /readyz during drain
  await fetchJson(`${base}/drain/start?ms=300`);
  await new Promise((r) => setTimeout(r, 20));
  let rz2 = await fetchJson(`${base}/readyz`).catch(() => ({ status: 0, json: {} }));
  if (rz2.status === 0) {
    await new Promise((r) => setTimeout(r, 30));
    rz2 = await fetchJson(`${base}/readyz`).catch(() => ({ status: 0, json: {} }));
  }
  assert.equal(rz2.status, 503);
  assert.equal(rz2.json?.ready, false);
  // Accelerate shutdown and avoid hangs: send SIGTERM to trigger graceful handler
  try { child.kill('SIGTERM'); } catch {}
  // Finish draining
  try { await Promise.allSettled(waiters); } catch {}
  await new Promise((r) => child.on('exit', r));
  // Verify JSON-only logs
  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try { JSON.parse(line); } catch { assert.fail(`Non-JSON log line in production: ${line}`); }
  }
});
