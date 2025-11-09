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

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('Service surfaces provider/model in /conv/message response and logs', async () => {
  const port = 4100 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 4000 });
  const conv_id = 'prov-msg-1';
  const body = { text: 'plain text', conv_id, turn: 0, engine: 'urga' };
  const res = await postJson(`${base}/conv/message`, body);
  assert.equal(res.status, 200);
  const j = res.json || {};
  assert.equal(j.provider, 'stub-urga', 'provider surfaced');
  assert.equal(j.resolved_model, 'urga', 'resolved_model surfaced');
  assert.equal(j.model, 'urga');
  // Check engine_selected log line contains provider/resolved_model
  const lines = getLogs().split(/\r?\n/).filter(Boolean);
  const logEntry = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((x) => x && x.evt === 'engine_selected' && x.conv_id === conv_id);
  assert.ok(logEntry, 'engine_selected log found');
  assert.equal(logEntry.provider, 'stub-urga');
  assert.equal(logEntry.resolved_model, 'urga');
  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

