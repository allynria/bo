import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
        resolve({ status: res.statusCode, json: j });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Using shared readiness polling helper

test('heap snapshot endpoint requires admin auth and returns file', async () => {
  const port = 3900 + Math.floor(Math.random() * 500);
  const token = 'admintoken';
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), ADMIN_TOKEN: token });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  const noAuth = await fetchJson(`${base}/heap/snapshot`);
  assert.equal(noAuth.status, 403);

  const yesAuth = await fetchJson(`${base}/heap/snapshot`, { Authorization: `Bearer ${token}` });
  assert.equal(yesAuth.status, 200);
  assert.equal(typeof yesAuth.json.file, 'string');
  assert.ok((yesAuth.json.file || '').length > 0);

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
