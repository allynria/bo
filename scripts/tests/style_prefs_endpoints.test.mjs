import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3310';
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request(
      `${BASE}${path}`,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, text, json: safeJson(text) });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function startService() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await onceReady();
  return child;
}

function onceReady() {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      http
        .get({ host: '127.0.0.1', port: Number(PORT), path: '/healthz' }, (r) => {
          if (r.statusCode === 200) {
            clearInterval(t);
            resolve();
          }
        })
        .on('error', () => {});
    }, 100);
  });
}

test('style presets list + set/get per conv', async () => {
  const svc = await startService();
  try {
    const p = await req('GET', '/admin/style/presets');
    assert.equal(p.status, 200);
    assert.ok(p.json?.presets?.length >= 3, 'presets should exist');

    const conv_id = 'S-DEMO';
    const set = await req('POST', '/admin/style', { conv_id, preset: 'noir' });
    assert.equal(set.status, 200);
    assert.equal(set.json?.pref?.preset, 'noir');
    assert.ok(Array.isArray(set.json?.tokens), 'tokens array');

    const got = await req('GET', `/admin/style?conv_id=${conv_id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json?.pref?.preset, 'noir');
  } finally {
    svc.kill('SIGINT');
  }
});
