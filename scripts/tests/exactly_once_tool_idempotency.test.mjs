import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
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

function postJsonWithHeaders(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function fetchSSE(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let buf = '';
      let startEvent = null;
      let endEvent = null;
      const flush = () => {
        const chunks = buf.split(/\r?\n\r?\n/);
        buf = chunks.pop();
        for (const chunk of chunks) {
          const lines = chunk.split(/\r?\n/);
          let evt = null;
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event:')) evt = line.slice(6).trim();
            else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
          }
          if (evt === 'start') {
            try { startEvent = JSON.parse(dataStr); } catch {}
          } else if (evt === 'end') {
            try { endEvent = JSON.parse(dataStr); } catch {}
          }
        }
      };
      res.on('data', (d) => { buf += d.toString(); flush(); });
      res.on('end', () => { flush(); resolve({ status: res.statusCode, headers: res.headers, startEvent, endEvent }); });
    });
    req.on('error', reject);
    req.end();
  });
}

function toolDonePath(tmpdir, id) {
  const encoded = encodeURIComponent(String(id));
  return path.join(tmpdir, 'urga_tool', `${encoded}.done`);
}

test('Exactly-once tool idempotency: /conv/message and /conv/stream mark once per key', async () => {
  const port = 4600 + Math.floor(Math.random() * 200);
  const tmpBase = path.join(process.cwd(), `.tmp_idem_${port}`);
  const env = {
    PORT: String(port),
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    MAX_HEADER_BYTES: '8192',
    IDEMPOTENCY_TTL_MS: '300000',
    TMPDIR: tmpBase
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  // /conv/message idempotency by header key
  const idemMsgKey = 'idem-msg-key-1';
  const body = { text: 'Trigger tool once', conv_id: 'conv-idem-1', turn: 0, engine: 'urga' };
  const r1 = await postJsonWithHeaders(`${base}/conv/message`, body, { 'Idempotency-Key': idemMsgKey });
  assert.equal(r1.status, 200);
  const pMsg = toolDonePath(tmpBase, idemMsgKey);
  const st1 = fs.statSync(pMsg);
  // Second call should replay and not touch tool marker
  const r2 = await postJsonWithHeaders(`${base}/conv/message`, body, { 'Idempotency-Key': idemMsgKey });
  assert.equal(r2.status, 200);
  assert.equal(r2.json?.idempotent_replay, true);
  const st2 = fs.statSync(pMsg);
  assert.equal(st2.mtimeMs, st1.mtimeMs, 'tool marker unchanged on replay');

  // /conv/stream idempotency by header key
  const idemStreamKey = 'idem-stream-key-1';
  const s1 = await fetchSSE(`${base}/conv/stream?text=Stream%20once&conv_id=conv-idem-s1&turn=0&engine=urga`, { 'Idempotency-Key': idemStreamKey });
  assert.equal(s1.status, 200);
  assert.ok(s1.startEvent && s1.endEvent, 'SSE included start/end');
  const pStream = toolDonePath(tmpBase, idemStreamKey);
  const stS1 = fs.statSync(pStream);
  const s2 = await fetchSSE(`${base}/conv/stream?text=Stream%20once&conv_id=conv-idem-s1&turn=0&engine=urga`, { 'Idempotency-Key': idemStreamKey });
  assert.equal(s2.status, 200);
  assert.ok(s2.endEvent && s2.endEvent.idempotent_replay === true, 'SSE end carries idempotent_replay');
  const stS2 = fs.statSync(pStream);
  assert.equal(stS2.mtimeMs, stS1.mtimeMs, 'stream tool marker unchanged on replay');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
