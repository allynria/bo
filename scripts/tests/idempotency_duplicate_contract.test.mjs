import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function connectSSEWaitStartKeepOpen(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method: 'GET', headers }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        const chunks = buf.split('\n\n');
        buf = chunks.pop();
        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          const typeLine = lines.find((l) => l.startsWith('event: ')) || '';
          const dataLine = lines.find((l) => l.startsWith('data: ')) || '';
          const evt = typeLine.replace('event: ', '').trim();
          if (evt === 'start') {
            // Resolve immediately on start, keep the stream open
            return resolve({ req, res });
          }
        }
      });
      res.on('error', (e) => reject(e));
    });
    req.on('error', reject);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('409 duplicate_stream: concurrent streams with same Idempotency-Key are rejected', async () => {
  const port = 4700 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-flaky',
    FLAKY_STALL_MS: '1200',
    SSE_HEARTBEAT_MS: '200',
    IDEMPOTENCY_TTL_MS: '30000'
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  const conv_id = 'dup-stream-1';
  const idem = 'idem-stream-dup-1';
  const u = `${base}/conv/stream?conv_id=${encodeURIComponent(conv_id)}&turn=0&engine=urga&text=${encodeURIComponent('slow stream')}`;
  // Open first SSE and wait for start; keep open to hold ACTIVE_STREAMS
  const sse1 = await connectSSEWaitStartKeepOpen(u, { 'Idempotency-Key': idem });
  assert.ok(sse1 && sse1.req && sse1.res, 'first SSE connected');
  // Second concurrent stream with same key should be rejected as duplicate_stream
  const second = await getJson(u, { 'Idempotency-Key': idem });
  assert.equal(second.status, 409, 'second concurrent stream gets 409');
  assert.equal(second.json?.error, 'duplicate_stream', 'error is duplicate_stream');

  // Cleanup: close the first stream
  try { sse1.req.destroy(); } catch {}
  // Use SIGINT for Windows compatibility
  try { child.kill('SIGINT'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

const runRedisLockTests = ['1','true','yes'].includes(String(process.env.RUN_IDEMPOTENCY_REDIS_LOCK_TESTS || process.env.RUN_REDIS_LOCK_TESTS || '').toLowerCase());

(runRedisLockTests ? test : test.skip)('409 duplicate_message: concurrent POST with same Idempotency-Key are rejected via lock', async () => {
  const port = 4720 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-flaky',
    FLAKY_STALL_MS: '1200',
    IDEMPOTENCY_TTL_MS: '30000',
    IDEMPOTENCY_LOCK_TTL_MS: '60000',
    HEDGE_CUTOVER_MAX_WAIT_MS: '300',
    // Prefer externally provided Redis in CI; fall back to local stub
    IDEMPOTENCY_REDIS_URL: String(process.env.IDEMPOTENCY_REDIS_URL || 'redis://local-stub')
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  const idem = 'idem-msg-dup-1';
  const body = { text: 'slow message', conv_id: 'dup-message-1', turn: 0, engine: 'urga' };
  // Fire two concurrent POSTs with same Idempotency-Key
  const p1 = postJson(`${base}/conv/message`, body, { 'Idempotency-Key': idem });
  const p2 = postJson(`${base}/conv/message`, body, { 'Idempotency-Key': idem });
  const r2 = await p2; // second should be duplicate due to NX lock held by first
  assert.equal(r2.status, 409, 'second concurrent message gets 409');
  assert.equal(r2.json?.error, 'duplicate_message', 'error is duplicate_message');

  // Let first complete then clean up
  await p1;
  // Use SIGINT for Windows compatibility
  try { child.kill('SIGINT'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
