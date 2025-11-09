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
  child.stdout.on('data', (d) => {
    logs += d.toString();
  });
  child.stderr.on('data', (d) => {
    logs += d.toString();
  });
  return { child, getLogs: () => logs };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = '';
        res.on('data', (d) => {
          data += d.toString();
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(data || '{}'),
            });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

function validateLogSchema(obj) {
  // Minimal schema: require either evt or lvl, with optional ts, and enforce msg caps
  assert.equal(typeof obj, 'object');
  const hasEvt = typeof obj.evt === 'string' && obj.evt.length > 0;
  const hasLvl = typeof obj.lvl === 'string' && obj.lvl.length > 0;
  assert.ok(hasEvt || hasLvl, 'log must include evt or lvl');
  if (obj.ts !== undefined) {
    assert.ok(
      typeof obj.ts === 'number' || typeof obj.ts === 'string',
      'ts must be number or string'
    );
  }
  if (obj.msg !== undefined) {
    assert.equal(typeof obj.msg, 'string', 'msg must be string');
    const msgBytes = Buffer.byteLength(obj.msg, 'utf8');
    assert.ok(msgBytes <= 8192, `msg exceeds cap: ${msgBytes} > 8192`);
  }
  // Optional fields constraints
  if (obj.error !== undefined) {
    assert.equal(typeof obj.error, 'string');
    assert.ok(obj.error.length <= 8192);
  }
}

test('Prod logs conform to schema and size caps', async () => {
  const port = 4400 + Math.floor(Math.random() * 100);
  const { child, getLogs } = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    QUEUE_MAX: '0',
  });
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 3000 });

  const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const j = (() => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })();
    assert.ok(j, `Non-JSON line found: ${line}`);
    validateLogSchema(j);
  }

  try {
    child.kill('SIGTERM');
  } catch {}
  await new Promise((r) => child.on('exit', r));
});
