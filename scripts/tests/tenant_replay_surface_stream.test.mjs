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
        let startEvent = null;
        let endEvent = null;
        res.on('data', (d) => {
          buf += d.toString();
          const chunks = buf.split('\n\n');
          buf = chunks.pop();
          for (const chunk of chunks) {
            const lines = chunk.split('\n');
            const typeLine = lines.find((l) => l.startsWith('event: ')) || '';
            const dataLine = lines.find((l) => l.startsWith('data: ')) || '';
            const evt = typeLine.replace('event: ', '').trim();
            const dataStr = dataLine.replace('data: ', '').trim();
            if (evt === 'start') {
              try {
                startEvent = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'end') {
              try {
                endEvent = JSON.parse(dataStr);
              } catch {}
            }
          }
        });
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, startEvent, endEvent })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('Tenant surfaces in replayed /conv/stream start payload', async () => {
  const port = 4380 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    IDEMPOTENCY_TTL_MS: '300000',
  };
  const { child } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const conv_id = 'tenant-replay-stream-1';
  const turn = 0;
  const tenantVal = 'Tenant-XYZ_42';
  const idemKey = 'tenant-replay-key-1';
  const q = `conv_id=${encodeURIComponent(conv_id)}&turn=${turn}&engine=urga&tenant=${encodeURIComponent(tenantVal)}&text=${encodeURIComponent('hello world')}`;

  // First stream to persist idempotent entry
  const s1 = await fetchSSE(`${base}/conv/stream?${q}`, { 'Idempotency-Key': idemKey });
  assert.equal(s1.status, 200);
  assert.ok(s1.startEvent && s1.endEvent, 'initial stream carried start/end');

  // Replay via reconnect hint; should fast replay and surface tenant in start
  const s2 = await fetchSSE(`${base}/conv/stream?${q}&replay=true`, { 'Idempotency-Key': idemKey });
  assert.equal(s2.status, 200);
  assert.ok(s2.startEvent, 'replay start present');
  assert.equal(s2.startEvent.provider, 'stub-urga');
  assert.equal(s2.startEvent.resolved_model, 'urga');
  assert.equal(
    s2.startEvent.tenant,
    tenantVal.replace(/[^a-zA-Z0-9_\.\-]/g, ''),
    'tenant surfaced in replay start'
  );
  assert.ok(
    s2.endEvent && s2.endEvent.idempotent_replay === true,
    'replay end flagged as idempotent'
  );

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
