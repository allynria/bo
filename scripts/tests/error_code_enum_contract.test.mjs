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
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers: { 'Content-Length': data.length, ...headers } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, text: out }); }
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

function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        const ct = String(res.headers['content-type'] || '');
        if (/application\/json/i.test(ct)) {
          try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
          catch { resolve({ status: res.statusCode, headers: res.headers, text: out }); }
        } else {
          resolve({ status: res.statusCode, headers: res.headers, text: out });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function openSSE(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method: 'GET', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, req, res });
    });
    req.on('error', reject);
    req.end();
  });
}

test('Error code enum contract: known codes for 401/403/409/429/503', async () => {
  const port = 4700 + Math.floor(Math.random() * 200);
  const env = {
    PORT: String(port),
    NODE_ENV: 'production',
    LOG_JSON: '1',
    QUEUE_MAX: '0',
    CORS_ALLOWLIST: 'http://ok.test',
    REPLAY_WINDOW_MS: '2000',
    CONV_SOFT_MAX: '2',
    CONV_SOFT_WINDOW_MS: '5000',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
  };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  const KNOWN = new Set([
    'unsupported_media_type', 'header_too_large', 'payload_too_large',
    'schema_invalid', 'bad_request', 'invalid_alert_name',
    'auth_required', 'replay_window_exceeded', 'idem_mac_missing', 'idem_mac_invalid', 'ts_required',
    'forbidden', 'cors_forbidden',
    'duplicate_message', 'duplicate_stream', 'replay_unavailable',
    'rate_limited', 'budget_limited', 'soft_drop', 'draining',
    'tenant_wipe_failed', 'idem_purge_failed', 'heap_snapshot_failed', 'export_failed', 'not_found',
  ]);

  // 401 ts_required
  const r401_ts = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c401a', turn: 0, engine: 'urga' }, { origin: 'http://ok.test' });
  assert.equal(r401_ts.status, 401);
  assert.ok(KNOWN.has(String(r401_ts.json?.error)), `unknown 401 code: ${r401_ts.json?.error}`);

  // 401 auth_required (stream with valid ts but missing token/HMAC)
  const nowTs = Date.now();
  const r401_auth = await getRaw(`${base}/conv/stream?text=hi&conv_id=s401&turn=0&ts=${nowTs}`, { origin: 'http://ok.test' });
  assert.equal(r401_auth.status, 401);
  assert.ok(KNOWN.has(String(r401_auth.json?.error)), `unknown 401 code: ${r401_auth.json?.error}`);

  // 403 cors_forbidden (message path, disallowed origin)
  const r403 = await postJson(`${base}/conv/message`, { text: 'hi', conv_id: 'c403', turn: 0, engine: 'urga' }, { origin: 'http://evil.test', authorization: 'Bearer test-token' });
  assert.equal(r403.status, 403);
  assert.ok(KNOWN.has(String(r403.json?.error)), `unknown 403 code: ${r403.json?.error}`);

  // 429 conversation limiter
  const bodyRL = { text: 'hit rl', conv_id: 'c429', turn: 0, engine: 'urga', ts: Date.now() };
  const a1 = await postJson(`${base}/conv/message`, bodyRL, { origin: 'http://ok.test', authorization: 'Bearer test-token' });
  assert.equal(a1.status, 200);
  const a2 = await postJson(`${base}/conv/message`, { ...bodyRL, ts: Date.now() }, { origin: 'http://ok.test', authorization: 'Bearer test-token' });
  assert.equal(a2.status, 200);
  const a3 = await postJson(`${base}/conv/message`, { ...bodyRL, ts: Date.now() }, { origin: 'http://ok.test', authorization: 'Bearer test-token' });
  assert.equal(a3.status, 429);
  assert.ok(KNOWN.has(String(a3.json?.error)), `unknown 429 code: ${a3.json?.error}`);


  // 409 replay_unavailable (explicit replay when nothing cached)
  const s3 = await getRaw(`${base}/conv/stream?conv_id=c409x&turn=0&engine=urga&replay=true&ts=${Date.now()}`, { origin: 'http://ok.test', authorization: 'Bearer test-token' });
  assert.equal(s3.status, 409);
  assert.ok(KNOWN.has(String(s3.json?.error)), `unknown 409 code: ${s3.json?.error}`);

  // 503 draining
  const d1 = await postJson(`${base}/drain/start?ms=200`, {}, { authorization: 'Bearer test-token' });
  assert.equal(d1.status, 200);
  const r503 = await postJson(`${base}/conv/message`, { text: 'during drain', conv_id: 'c503', turn: 0, engine: 'urga', ts: Date.now() }, { origin: 'http://ok.test', authorization: 'Bearer test-token' });
  assert.equal(r503.status, 503);
  assert.ok(KNOWN.has(String(r503.json?.error)), `unknown 503 code: ${r503.json?.error}`);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
