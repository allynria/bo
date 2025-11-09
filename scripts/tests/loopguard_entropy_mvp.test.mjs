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
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            text,
            json: (() => {
              try {
                return JSON.parse(text);
              } catch {
                return {};
              }
            })(),
          })
        );
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c.toString();
      });
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          json: (() => {
            try {
              return JSON.parse(text);
            } catch {
              return {};
            }
          })(),
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('Entropy MVP: similar messages trigger entropy reroll metric', async () => {
  const port = 35000 + Math.floor(Math.random() * 500);
  const base = `http://localhost:${port}`;
  const token = 'topsecret';
  const allowed = 'http://allowed.test';
  const { child } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    CONV_AUTH: token,
    CORS_ALLOWLIST: allowed,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    LOOP_GUARD_ENABLED: '0',
    LOOP_EMBED_ENABLED: '0',
    LOOP_ENTROPY_ENABLED: '1',
    LOOP_ENTROPY_MIN: '3.0',
    LOOP_ENTROPY_MIN_LEN: '1',
  });
  await waitForUp(base, { timeout: 5000 });

  const conv = 'entropy-loop-test';
  const nowA = Date.now();
  const a = await postJson(
    `${base}/conv/message`,
    { conv_id: conv, text: 'She smiles softly and nods.', ts: nowA },
    { origin: allowed, authorization: `Bearer ${token}` }
  );
  assert.equal(a.status, 200);
  const nowB = Date.now();
  const b = await postJson(
    `${base}/conv/message`,
    { conv_id: conv, text: 'She smiles softly again.', ts: nowB },
    { origin: allowed, authorization: `Bearer ${token}` }
  );
  assert.equal(b.status, 200);

  const m = await getJson(`${base}/metrics`);
  assert.equal(m.status, 200);
  const hit =
    Array.isArray(m.json?.counters) &&
    m.json.counters.some(
      (c) => c.name === 'loopguard_entropy_trigger_total' && c.labels?.path === 'message'
    );
  assert.equal(hit, true, 'expected loopguard_entropy_trigger_total metric');

  try {
    child.kill();
  } catch {}
});
