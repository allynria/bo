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

function fetchSSE(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let startPayload = null;
    let endPayload = null;
    let sawHedgeSwitch = false;
    let buf = '';
    const u = new URL(url);
    const req = http.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + (u.search || ''),
        headers,
      },
      (res) => {
        res.on('data', (d) => {
          buf += d.toString();
          const chunks = buf.split(/\r?\n\r?\n/);
          buf = chunks.pop();
          for (const chunk of chunks) {
            const lines = chunk.split(/\r?\n/);
            const typeLine = lines.find((l) => l.startsWith('event:')) || '';
            const dataLine = lines.find((l) => l.startsWith('data:')) || '';
            const evt = typeLine.replace(/^event:\s*/, '').trim();
            const dataStr = dataLine.replace(/^data:\s*/, '').trim();
            if (evt === 'start') {
              try {
                startPayload = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'hedge.switch') {
              sawHedgeSwitch = true;
            } else if (evt === 'end') {
              try {
                endPayload = JSON.parse(dataStr);
              } catch {}
            }
          }
          if (endPayload) resolve({ start: startPayload, end: endPayload, hedge: sawHedgeSwitch });
        });
        res.on('end', () => {
          if (!endPayload) resolve({ start: startPayload, end: null, hedge: sawHedgeSwitch });
        });
      }
    );
    req.on('error', (err) => {
      // If the server closed the SSE early (e.g., test shutting down), treat as resolved if we saw any start.
      if (startPayload) return resolve({ start: startPayload, end: null, hedge: sawHedgeSwitch });
      reject(err);
    });
    req.end();
  });
}

test('Style hedge surfaces flags in /conv/stream start payload', async () => {
  const port = 4500 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    LOOP_STYLE_HEDGE_ENABLED: '1',
    LOOP_STYLE_HEDGE_MS: '50',
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 4000 });
  const conv_id = 'style-hedge-1';
  const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('hello world')}`;
  let sse;
  try {
    sse = await fetchSSE(u, {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
  } catch (err) {
    console.error('Service logs for debug:\n' + String(getLogs?.() || ''));
    throw err;
  }
  assert.ok(sse.start, 'start event present');
  assert.ok('style_hedge' in sse.start, 'start includes style_hedge flag');
  assert.ok(sse.start.style_hedge || sse.hedge, 'hedge path triggered');
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
