import { test } from 'node:test';
// Ensure non-production mode so service doesn't enforce auth/HMAC in this test
process.env.NODE_ENV = 'test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(out || '{}'),
            });
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
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
                startEvent = JSON.parse(dataStr);
              } catch {}
            } else if (evt === 'end') {
              try {
                endEvent = JSON.parse(dataStr);
              } catch {}
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode, startEvent, endEvent }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('AB variant stickiness persists across restart for message and stream', async () => {
  const port = 4700 + Math.floor(Math.random() * 100);
  const tmpRoot = path.join(process.cwd(), '.tmp_ab_restart');
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
  } catch {}
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    TMPDIR: tmpRoot,
    TEMP: tmpRoot,
    CONV_RATE_MAX: '1000',
    CONV_RATE_WINDOW: '2000',
    CONV_SOFT_MAX: '5000',
    CONV_SOFT_WINDOW_MS: '2000',
  };

  // First boot
  const { child: child1 } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 });

  const convs = Array.from({ length: 100 }, (_, i) => `persist-${i}`);
  const firstVariant = new Map();
  const makeBody = (i, cid) =>
    i % 3 === 0
      ? { text: 'plain text', conv_id: cid, turn: i % 4, engine: 'urga' }
      : i % 3 === 1
        ? { text: 'gods and pantheon echo', conv_id: cid, turn: i % 4 }
        : { text: 'ctx dreams', conv_id: cid, turn: i % 4, ctx: { vars: { engine: 'dreams' } } };
  // Drive requests in controlled batches to avoid rate-limits
  const TOTAL = 2000;
  const BATCH = 50;
  for (let start = 0; start < TOTAL; start += BATCH) {
    const tasks = [];
    for (let j = start; j < Math.min(TOTAL, start + BATCH); j++) {
      const cid = convs[j % convs.length];
      tasks.push(
        postJson(`${base}/conv/message`, makeBody(j, cid)).then((r) => {
          assert.equal(r.status, 200);
          const v = String(r.json.variant_v || '');
          assert.ok(v === 'A' || v === 'B', `invalid variant '${v}' for ${cid}`);
          const existing = firstVariant.get(cid);
          if (!existing) firstVariant.set(cid, v);
          else assert.equal(v, existing);
        })
      );
    }
    await Promise.all(tasks);
  }

  // Also persist via stream
  for (let i = 0; i < convs.length; i++) {
    const conv_id = convs[i];
    const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('hello')}`;
    const s = await fetchSSE(u);
    assert.equal(s.status, 200);
    assert.ok(s.startEvent && s.startEvent.variant_v, 'start event carries variant');
  }

  try {
    child1.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child1.on('exit', r));

  // Second boot with same TMPDIR
  const { child: child2 } = startService(env);
  await waitForUp(base, { timeout: 5000 });

  const tasks2 = [];
  for (let i = 0; i < 2000; i++) {
    const cid = convs[i % convs.length];
    const body =
      i % 2 === 0
        ? {
            text: 'after restart dreams',
            conv_id: cid,
            turn: i % 4,
            ctx: { vars: { engine: 'dreams' } },
          }
        : { text: 'after restart echo pantheon', conv_id: cid, turn: i % 4 };
    tasks2.push(
      postJson(`${base}/conv/message`, body).then((r) => {
        assert.equal(r.status, 200);
        const v = String(r.json.variant_v || '');
        const expected = firstVariant.get(cid);
        assert.equal(v, expected, `Variant changed for ${cid}`);
      })
    );
  }
  await Promise.all(tasks2);

  // Stream should carry same variant after restart
  for (let i = 0; i < convs.length; i++) {
    const conv_id = convs[i];
    const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=1&text=${encodeURIComponent('after restart')}`;
    const s = await fetchSSE(u);
    assert.equal(s.status, 200);
    assert.ok(s.startEvent && s.startEvent.variant_v, 'start event carries variant after restart');
    const expected = firstVariant.get(conv_id);
    assert.ok(expected === 'A' || expected === 'B', `missing expected variant for ${conv_id}`);
    assert.equal(
      String(s.startEvent.variant_v || ''),
      expected,
      `Stream variant changed for ${conv_id}`
    );
  }

  try {
    child2.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child2.on('exit', r));
});
