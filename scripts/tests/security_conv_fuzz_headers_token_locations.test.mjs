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
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(data.length), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

test('randomized header casing and token locations yield consistent taxonomy', async () => {
  const port = 33700 + Math.floor(Math.random() * 500);
  const token = 'topsecret';
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const { child } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), CONV_AUTH: token, CORS_ALLOWLIST: allowed, REPLAY_WINDOW_MS: '10000', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' });
  await waitForUp(base, { timeout: 3000 });

  const N = 30;
  const cases = [];
  for (let i = 0; i < N; i++) {
    const route = pick(['message','stream']);
    const origin = pick([allowed, 'http://evil.test']);
    const ts = Date.now();
    const tokenLoc = pick(['none','bearer','x-api-key','query']);
    const casing = pick(['Authorization','AUTHORIZATION','authorization']);
    const xKeyCasing = pick(['x-api-key','X-API-KEY','X-Api-Key']);
    const includeTs = pick([true, false]);
    const headers = { origin };
    let url = route === 'message' ? `${base}/conv/message` : `${base}/conv/stream?text=hi&conv_id=${route}${i}&turn=0`;
    // token placement
    if (tokenLoc === 'bearer') headers[casing] = `Bearer ${token}`;
    if (tokenLoc === 'x-api-key') headers[xKeyCasing] = token;
    if (tokenLoc === 'query') url += (url.includes('?') ? '&' : '?') + `token=${token}`;

    // ts placement
    const body = route === 'message' ? { text: 'hi', conv_id: `${route}${i}` } : null;
    if (includeTs) {
      if (route === 'message') body.ts = ts; else url += (url.includes('?') ? '&' : '?') + `ts=${ts}`;
    }
    cases.push({ route, origin, tokenLoc, includeTs, url, headers, body });
  }

  const results = await Promise.all(cases.map((c) => c.route === 'message' ? postJson(c.url, c.body, c.headers) : getRaw(c.url, c.headers)));
  for (let i = 0; i < N; i++) {
    const c = cases[i];
    const r = results[i];
    const expected = (() => {
      if (c.origin !== allowed) return 403;
      if (!c.includeTs) return 401;
      if (c.tokenLoc === 'none') return 401;
      return 200;
    })();
    assert.equal(r.status, expected, `case ${i} expected ${expected}, got ${r.status}`);
    if (expected !== 200) assert.ok(r.text.includes('error'), `case ${i} must include error`);
  }

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});

