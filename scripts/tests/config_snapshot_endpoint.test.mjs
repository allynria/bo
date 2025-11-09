import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(body); } catch {}
        resolve({ status: res.statusCode, json: j, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

test('config snapshot endpoint requires admin auth and includes hash header', async () => {
  const port = 3800 + Math.floor(Math.random() * 300);
  const token = 'admintoken';
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), ADMIN_TOKEN: token });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  const noAuth = await fetchJson(`${base}/config/snapshot`).catch(() => ({ status: 0, json: {} }));
  assert.equal(noAuth.status, 403);

  const yesAuth = await fetchJson(`${base}/config/snapshot`, { Authorization: `Bearer ${token}` });
  assert.equal(yesAuth.status, 200);
  assert.equal(yesAuth.json.ok, true);
  assert.equal(typeof yesAuth.json.build_hash, 'string');
  assert.equal(typeof yesAuth.json.config_hash, 'string');
  assert.equal(typeof yesAuth.json.frozen, 'boolean');
  assert.equal(typeof yesAuth.json.config, 'object');

  const hdrHash = String(yesAuth.headers['x-config-hash'] || '');
  assert.ok(hdrHash.length > 0);
  assert.equal(hdrHash, yesAuth.json.config_hash);

  // Deterministic hash of sanitized config
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify(yesAuth.json.config));
  const localHash = h.digest('hex');
  assert.equal(localHash, yesAuth.json.config_hash);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

