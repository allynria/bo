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

function postRaw(url, raw, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(raw || '');
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Length': data.length, ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch (e) { resolve({ status: res.statusCode, headers: res.headers, text: out }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function postJson(url, body, headers = {}) {
  return postRaw(url, JSON.stringify(body || {}), { 'Content-Type': 'application/json', ...headers });
}

test('Error shape contract: 415, 400, 429, 503 carry structured JSON', async () => {
  const port = 4700 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', MAX_HEADER_BYTES: '8192', CONV_SOFT_MAX: '2', CONV_SOFT_WINDOW_MS: '5000', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  // 415 unsupported media type
  const r415 = await postRaw(`${base}/conv/message`, 'not json', { 'Content-Type': 'text/plain' });
  assert.equal(r415.status, 415);
  assert.equal(r415.json?.error, 'unsupported_media_type');
  assert.equal(r415.json?.expected, 'application/json');

  // 400 schema invalid due to unknown field
  const r400 = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c-err', turn: 0, engine: 'urga', unknown_field: 'nope' });
  assert.equal(r400.status, 400);
  assert.equal(r400.json?.error, 'schema_invalid');
  assert.ok(Array.isArray(r400.json?.errors), 'schema_invalid should include errors array');

  // 429 conversation rate limit
  const bodyRL = { text: 'hit rl', conv_id: 'c-rl', turn: 0, engine: 'urga' };
  const a1 = await postJson(`${base}/conv/message`, bodyRL);
  assert.equal(a1.status, 200);
  const a2 = await postJson(`${base}/conv/message`, bodyRL);
  assert.equal(a2.status, 200);
  const a3 = await postJson(`${base}/conv/message`, bodyRL);
  assert.equal(a3.status, 429);
  assert.equal(a3.json?.error, 'rate_limited');
  assert.equal(a3.json?.scope, 'conversation');
  assert.equal(a3.json?.conv_id, 'c-rl');
  assert.ok(typeof a3.json?.wait_s === 'number', '429 payload should include wait_s');
  assert.ok(a3.headers['retry-after'], '429 response should include Retry-After');

  // 503 draining
  const d1 = await postJson(`${base}/drain/start?ms=200`, {});
  assert.equal(d1.status, 200);
  const r503 = await postJson(`${base}/conv/message`, { text: 'during drain', conv_id: 'c-dr', turn: 0, engine: 'urga' });
  assert.equal(r503.status, 503);
  assert.equal(r503.json?.error, 'draining');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

