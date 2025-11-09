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
  child.stdout.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function fetchSSEFirstToken(url) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const u = new URL(url);
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search },
      (res) => {
        let firstDeltaMs = null;
        res.on('data', (d) => {
          const s = d.toString();
          const lines = s.split(/\r?\n/).filter(Boolean);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('event: ')) {
              const evt = line.slice(7).trim();
              if (evt === 'delta' && firstDeltaMs == null) {
                firstDeltaMs = Math.max(0, Date.now() - t0);
                resolve(firstDeltaMs);
              }
            }
          }
        });
        res.on('end', () => {
          if (firstDeltaMs == null) resolve(Math.max(0, Date.now() - t0));
        });
      }
    );
    req.on('error', reject);
  });
}

test('Cold-start p99 time-to-first-token below target with prewarm', async () => {
  const port = 4600 + Math.floor(Math.random() * 300);
  // Use a slightly more conservative default threshold to reduce flake under CI load.
  const targetMs = Math.max(1, Number(process.env.FIRST_TOKEN_P99_TARGET_MS || 300));
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    PREWARM_MODELS: 'gpt-4o-mini,echo-small',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  // Dispatch several cold-start requests and measure first-token latency
  const N = 40;
  const waits = [];
  for (let i = 0; i < N; i++) {
    const text = `hello-${i}-${Math.random().toString(36).slice(2, 8)}`;
    const u = `${base}/conv/stream?conv_id=cold-${i}&turn=0&engine=urga&text=${encodeURIComponent(text)}`;
    waits.push(fetchSSEFirstToken(u).catch(() => 999999));
  }
  const latencies = await Promise.all(waits);
  const sorted = latencies.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1));
  const p99 = sorted[idx] || 0;
  assert.ok(p99 <= targetMs, `p99 ${p99}ms should be <= target ${targetMs}ms`);

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
