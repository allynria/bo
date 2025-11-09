import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return { child };
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(data.length),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => {
          text += c.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c.toString();
      });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

test('fuzz auth alias, header duplication, and param casing taxonomy', async () => {
  const port = 33900 + Math.floor(Math.random() * 500);
  const token = 'topsecret';
  const allowed = 'http://allowed.test';
  const base = `http://localhost:${port}`;
  const { child } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    CONV_AUTH: token,
    CORS_ALLOWLIST: allowed,
    REPLAY_WINDOW_MS: '10000',
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
  });
  await waitForUp(base, { timeout: 3000 });

  const cases = [];
  const N = 50;
  for (let i = 0; i < N; i++) {
    const route = pick(['message', 'stream']);
    const origin = pick([allowed, 'http://evil.test']);
    const tsIncluded = pick([true, false]);
    const authHeaderMode = pick([
      'none',
      'auth_correct',
      'auth_wrong',
      'auth_bearer_correct',
      'auth_bearer_wrong',
    ]);
    const apiKeyMode = pick(['none', 'key_correct', 'key_wrong']);
    const dupHeader = pick(['none', 'both']);
    const queryModes = pick([
      'none',
      'token_correct',
      'token_wrong',
      'auth_correct',
      'auth_wrong',
      'Token_correct',
      'AUTH_correct',
      'both_correct',
      'both_conflict',
    ]);

    let url =
      route === 'message'
        ? `${base}/conv/message`
        : `${base}/conv/stream?text=hi&conv_id=${route}${i}&turn=0`;
    const headers = { origin };

    // headers duplication logic
    const makeAuthValue = (mode) => {
      if (mode === 'auth_correct') return token;
      if (mode === 'auth_wrong') return 'wrong';
      if (mode === 'auth_bearer_correct') return `Bearer ${token}`;
      if (mode === 'auth_bearer_wrong') return 'Bearer wrong';
      return '';
    };
    const authVal = makeAuthValue(authHeaderMode);
    const keyVal = apiKeyMode === 'key_correct' ? token : apiKeyMode === 'key_wrong' ? 'wrong' : '';
    if (dupHeader === 'both') {
      if (authVal) headers['Authorization'] = authVal;
      if (keyVal) headers['x-api-key'] = keyVal;
    } else {
      // either auth or key
      const preferAuth = pick([true, false]);
      if (preferAuth && authVal) headers['Authorization'] = authVal;
      else if (keyVal) headers['x-api-key'] = keyVal;
    }

    // query modes
    const applyQuery = (k, v) => {
      url += (url.includes('?') ? '&' : '?') + `${k}=${v}`;
    };
    if (queryModes === 'token_correct') applyQuery('token', token);
    else if (queryModes === 'token_wrong') applyQuery('token', 'wrong');
    else if (queryModes === 'auth_correct') applyQuery('auth', token);
    else if (queryModes === 'auth_wrong') applyQuery('auth', 'wrong');
    else if (queryModes === 'Token_correct') applyQuery('Token', token);
    else if (queryModes === 'AUTH_correct') applyQuery('AUTH', token);
    else if (queryModes === 'both_correct') {
      applyQuery('token', token);
      applyQuery('auth', token);
    } else if (queryModes === 'both_conflict') {
      applyQuery('token', 'wrong');
      applyQuery('auth', token);
    }

    const body = route === 'message' ? { text: 'hi', conv_id: `${route}${i}` } : null;
    if (tsIncluded) {
      const nowTs = Date.now();
      if (route === 'message') body.ts = nowTs;
      else url += (url.includes('?') ? '&' : '?') + `ts=${nowTs}`;
    }
    cases.push({ route, origin, url, headers, body });
  }

  const results = await Promise.all(
    cases.map((c) =>
      c.route === 'message' ? postJson(c.url, c.body, c.headers) : getRaw(c.url, c.headers)
    )
  );

  for (let i = 0; i < N; i++) {
    const c = cases[i];
    const r = results[i];
    const expected = (() => {
      if (c.origin !== allowed) return 403;
      const u = new URL(c.url);
      const hasTs =
        c.route === 'message'
          ? Number.isFinite(Number(c.body?.ts || 0)) && Number(c.body?.ts || 0) > 0
          : Number.isFinite(Number(u.searchParams.get('ts') || 0)) &&
            Number(u.searchParams.get('ts') || 0) > 0;
      if (!hasTs) return 401;
      // replicate service token algorithm
      const hdr = String(c.headers['Authorization'] || c.headers['x-api-key'] || '').trim();
      const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
        ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
        : hdr;
      const tokenFromQuery = String(
        u.searchParams.get('token') || u.searchParams.get('auth') || ''
      ).trim();
      const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
      return hasToken ? 200 : 401;
    })();
    assert.equal(r.status, expected, `case ${i} expected ${expected}, got ${r.status}`);
    if (expected !== 200) assert.ok(r.text.includes('error'), `case ${i} must include error`);
  }

  // Cleanup service
  try {
    child.kill();
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
