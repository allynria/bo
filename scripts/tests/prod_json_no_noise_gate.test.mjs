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

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

test('Prod JSON-only gate: zero coerced non-JSON log lines', async () => {
  const port = 4300 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(port), QUEUE_MAX: '0' });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  // Collect logs and assert no line has evt === 'non_json_log'
  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const j = (() => { try { return JSON.parse(line); } catch { return null; } })();
    assert.ok(j && typeof j === 'object', `Non-JSON log line in production: ${line}`);
    assert.notEqual(j.evt, 'non_json_log', `Coerced non-JSON log detected: ${line}`);
  }

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
