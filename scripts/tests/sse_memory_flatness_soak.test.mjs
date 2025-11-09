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

function connectAbortQuick(base, conv_id) {
  return new Promise((resolve) => {
    const u = new URL(
      `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=quick`
    );
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET' },
      (res) => {
        let seenDelta = false;
        res.on('data', (d) => {
          const s = d.toString();
          const lines = s.split(/\r?\n/).filter(Boolean);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('event: delta')) {
              seenDelta = true;
              try {
                req.destroy();
              } catch {}
              resolve();
              break;
            }
          }
        });
        res.on('end', () => resolve());
      }
    );
    req.on('error', () => resolve());
    req.end();
  });
}

async function fetchMetrics(base) {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}/metrics`, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d.toString();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

test('SSE memory stays flat under repeated forced disconnects', async () => {
  const port = 4480 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    SSE_HEARTBEAT_MS: '1000',
    IDEMPOTENCY_TTL_MS: '1200',
    ACTIVE_STREAMS_MAX_ITEMS: '100',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });
  for (let i = 0; i < 20; i++) {
    const conv_id = `soak-${i}`;
    await connectAbortQuick(base, conv_id);
  }
  // Wait for background cleanup
  await new Promise((r) => setTimeout(r, 800));
  const metrics = await fetchMetrics(base);
  const activeGauge = metrics.counters.find((c) => c.name === 'active_streams_current');
  assert.ok(
    activeGauge && typeof activeGauge.value === 'number',
    'active_streams_current gauge present'
  );
  assert.ok(
    activeGauge.value >= 0 && activeGauge.value <= 10,
    'active_streams_current bounded after soaks'
  );
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
