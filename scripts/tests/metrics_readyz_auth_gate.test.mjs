import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Use shared readiness polling helper

test('metrics and readyz require auth when configured', async () => {
  const port = 33010 + Math.floor(Math.random() * 1000);
  const token = 'topsecret';
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), METRICS_AUTH: token, READYZ_AUTH: token });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  const mNo = await fetchRaw(`${base}/metrics`);
  assert.equal(mNo.status, 403);
  const rNo = await fetchRaw(`${base}/readyz`);
  assert.equal(rNo.status, 403);
  const hPub = await fetchRaw(`${base}/healthz`);
  console.log(JSON.stringify({ mNo: mNo.status, rNo: rNo.status, hPub: hPub.status }));
  assert.equal(hPub.status, 200, '/healthz remains public');

  const hdr = { authorization: `Bearer ${token}`, 'x-admin-token': token };
  const mYes = await fetchRaw(`${base}/metrics?token=${token}`, hdr);
  try { console.log(getLogs()); } catch {}
  assert.equal(mYes.status, 200);
  const rYes = await fetchRaw(`${base}/readyz`, hdr);
  assert.ok([200,503].includes(rYes.status)); // depends on internal

  try { child.kill(); } catch {}
  await new Promise((r) => child.on('exit', r));
});
