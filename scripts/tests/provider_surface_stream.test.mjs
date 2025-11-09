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
        let buf = '';
        let startPayload = null;
        let finalPayload = null;
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
            } else if (evt === 'end') {
              try {
                finalPayload = JSON.parse(dataStr);
              } catch {}
            }
          }
          if (finalPayload) resolve({ start: startPayload, end: finalPayload });
        });
        res.on('end', () => {
          if (!finalPayload) resolve({ start: startPayload, end: null });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('Service surfaces provider/model in /conv/stream start payload', async () => {
  const port = 4300 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 4000 });
  const conv_id = 'prov-stream-1';
  const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('plain text')}`;
  const sse = await fetchSSE(u);
  assert.ok(sse.start, 'start event present');
  assert.equal(sse.start.provider, 'stub-urga', 'provider surfaced in start');
  assert.equal(sse.start.resolved_model, 'urga', 'resolved_model surfaced in start');
  assert.ok(sse.end, 'end event present');
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
