import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { waitForUp } from './tests/helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

function connectSSEWaitStartKeepOpen(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method: 'GET', headers: { Accept: 'text/event-stream', ...headers } }, (res) => {
      let buf = '';
      res.on('data', (d) => {
        buf += d.toString();
        const chunks = buf.split('\n\n');
        buf = chunks.pop();
        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          const typeLine = lines.find((l) => l.startsWith('event: ')) || '';
          const evt = typeLine.replace('event: ', '').trim();
          if (evt === 'start') return resolve({ req, res });
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
      res.on('end', () => { resolve({ status: res.statusCode, body: out }); });
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
      res.on('end', () => { resolve({ status: res.statusCode, body: out }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  // Scenario 1: duplicate_stream
  const port1 = 4800 + Math.floor(Math.random() * 200);
  const env1 = { PORT: String(port1), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-flaky', FLAKY_STALL_MS: '1200', SSE_HEARTBEAT_MS: '200', IDEMPOTENCY_TTL_MS: '30000' };
  const child1 = startService(env1);
  const base1 = `http://localhost:${port1}`;
  await waitForUp(base1, { timeout: 5000 });
  const convId = 'dup-stream-probe';
  const idem = 'idem-stream-probe';
  const u1 = `${base1}/conv/stream?conv_id=${encodeURIComponent(convId)}&turn=0&engine=urga&text=${encodeURIComponent('slow stream')}`;
  const sse1 = await connectSSEWaitStartKeepOpen(u1, { 'Idempotency-Key': idem });
  const second = await getJson(u1, { 'Idempotency-Key': idem });
  console.log('[probe] duplicate_stream second status', second.status, 'body', second.body);
  try { sse1.req.destroy(); } catch {}
  try { child1.kill('SIGINT'); } catch {}
  await new Promise((r) => child1.on('exit', r));

  // Scenario 2: duplicate_message
  const port2 = port1 + 100;
  const env2 = { PORT: String(port2), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-flaky', FLAKY_STALL_MS: '1200', IDEMPOTENCY_TTL_MS: '30000', IDEMPOTENCY_LOCK_TTL_MS: '60000', HEDGE_CUTOVER_MAX_WAIT_MS: '10', IDEMPOTENCY_REDIS_URL: 'redis://local-stub' };
  const child2 = startService(env2);
  const base2 = `http://localhost:${port2}`;
  await waitForUp(base2, { timeout: 5000 });
  const idemMsg = 'idem-msg-probe';
  const body = { text: 'slow message', conv_id: 'dup-message-probe', turn: 0, engine: 'urga' };
  const p1 = postJson(`${base2}/conv/message`, body, { 'Idempotency-Key': idemMsg });
  const p2 = postJson(`${base2}/conv/message`, body, { 'Idempotency-Key': idemMsg });
  const r2 = await p2;
  console.log('[probe] duplicate_message second status', r2.status, 'body', r2.body);
  await p1;
  try { child2.kill('SIGINT'); } catch {}
  await new Promise((r) => child2.on('exit', r));
}

main().catch((e) => { console.error('[probe] error', e); process.exitCode = 1; });

