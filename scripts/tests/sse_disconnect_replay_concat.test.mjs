import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function connectSSEAbortAfter(url, headers = {}, abortAfterDeltaCount = 2) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let deltas = [];
      let buf = '';
      const flush = () => {
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop();
        for (const part of parts) {
          const lines = part.split(/\r?\n/);
          let evt = null;
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (evt === 'delta') {
            try {
              const p = JSON.parse(dataStr);
              if (typeof p?.text === 'string') deltas.push(p.text);
            } catch {}
            if (deltas.length >= abortAfterDeltaCount) {
              try { req.destroy(); } catch {}
              resolve({ deltas });
            }
          }
        }
      };
      res.on('data', (d) => { buf += d.toString(); flush(); });
      res.on('end', () => { flush(); resolve({ deltas }); });
    });
    req.on('error', (err) => resolve({ deltas: [], error: err }));
    req.end();
  });
}

function fetchSSE(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
      let startPayload = null;
      let finalPayload = null;
      let buf = '';
      const flush = () => {
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop();
        for (const part of parts) {
          const lines = part.split(/\r?\n/);
          let evt = null;
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (evt === 'start') {
            try { startPayload = JSON.parse(dataStr); } catch {}
          } else if (evt === 'end') {
            try { finalPayload = JSON.parse(dataStr); } catch {}
          }
        }
      };
      res.on('data', (d) => { buf += d.toString(); flush(); });
      res.on('end', () => { flush(); resolve({ start: startPayload, end: finalPayload }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchMetrics(base) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/metrics`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

test('Forced disconnect then replay: deltas prefix matches final and active_streams drops', async () => {
  const port = 4450 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', SSE_HEARTBEAT_MS: '1000', IDEMPOTENCY_TTL_MS: '1500' };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });
  const conv_id = 'disconnect-replay-1';
  const idem = 'idem-key-1';
  const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('plain text')}`;
  const { deltas } = await connectSSEAbortAfter(u, { 'Idempotency-Key': idem }, 3);
  assert.ok(Array.isArray(deltas) && deltas.length > 0, 'received some deltas before abort');
  const agg = deltas.join('');
  const replayUrl = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&replay=1`;
  const replay = await fetchSSE(replayUrl, { 'Idempotency-Key': idem });
  assert.ok(replay.start, 'replay start present');
  assert.ok(replay.end && typeof replay.end.final === 'string', 'replay end final present');
  assert.ok(replay.end.idempotent_replay === true, 'idempotent_replay flag true');
  assert.ok(replay.end.final.startsWith(agg), 'final starts with concatenated deltas from partial stream');
  // Allow some time for cleanup and TTL
  await new Promise((r) => setTimeout(r, 500));
  const metrics = await fetchMetrics(base);
  const activeGauge = metrics.counters.find((c) => c.name === 'active_streams_current');
  assert.ok(activeGauge && typeof activeGauge.value === 'number', 'active_streams_current gauge present');
  assert.ok(activeGauge.value >= 0 && activeGauge.value <= 5, 'active_streams_current remains bounded');
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
