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

function fetchSSEWithDeltas(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search },
      (res) => {
        let startPayload = null;
        let finalPayload = null;
        const deltas = [];
        res.on('data', (d) => {
          const s = d.toString();
          const lines = s.split(/\r?\n/).filter(Boolean);
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('event: ')) {
              const evt = line.slice(7).trim();
              const dataLine =
                lines[i + 1] && lines[i + 1].startsWith('data: ') ? lines[i + 1].slice(6) : '';
              if (evt === 'start') {
                try {
                  startPayload = JSON.parse(dataLine);
                } catch {}
              } else if (evt === 'delta') {
                try {
                  const p = JSON.parse(dataLine);
                  if (typeof p?.text === 'string') deltas.push(p.text);
                } catch {}
              } else if (evt === 'end') {
                try {
                  finalPayload = JSON.parse(dataLine);
                } catch {}
              }
            }
          }
          if (finalPayload) {
            resolve({ start: startPayload, deltas, end: finalPayload });
          }
        });
        res.on('end', () => {
          if (!finalPayload) resolve({ start: startPayload, deltas, end: null });
        });
      }
    );
    req.on('error', reject);
  });
}

test('SSE sanitizer replaces invalid UTF-8 in deltas and final', async () => {
  const port = 4400 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-invalid',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });
  const conv_id = 'utf8-sanitize-1';
  const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('trigger dreams')}`;
  const sse = await fetchSSEWithDeltas(u);
  assert.ok(sse.start, 'start event present');
  assert.ok(Array.isArray(sse.deltas) && sse.deltas.length > 0, 'received deltas');
  const agg = sse.deltas.join('');
  // Ensure the replacement character is used (U+FFFD)
  assert.ok(
    agg.includes('\uFFFD') || agg.includes('�'),
    'delta aggregator contains replacement character'
  );
  assert.ok(sse.end && typeof sse.end.final === 'string', 'end has final');
  assert.ok(
    sse.end.final.includes('\uFFFD') || sse.end.final.includes('�'),
    'final contains replacement character'
  );
  assert.equal(sse.end.final, agg, 'final equals concatenated sanitized deltas');
  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
