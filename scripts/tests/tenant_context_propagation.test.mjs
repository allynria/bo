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

test('Tenant propagates into engine_selected log via context', async () => {
  const port = 4600 + Math.floor(Math.random() * 100);
  const env = { PORT: String(port), LOG_JSON: '1', QUEUE_MAX: '0', LLM_TURN_BUDGET: '5', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga', MAX_HEADER_BYTES: String(100_000) };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  try {
    await waitForUp(base, { timeout: 3000 });

    const tenantVal = 'Tenant-ABC_01';
    const convId = 'conv-tenant-test';
    const resp = await postJson(`${base}/conv/message`, {
      ctx: { meta: { tenant: tenantVal } },
      conv_id: convId,
      turn: 0,
      engine: 'urga',
      text: 'hello'
    });

    const lines = getLogs().trim().split(/\r?\n/).filter(Boolean);
    const events = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const headerChecks = events.filter((e) => e && e.evt === 'header_size_check');
    if (resp.status !== 200) {
      const tail = lines.slice(Math.max(0, lines.length - 10)).join('\n');
      console.error('diagnostic_log_tail', tail);
    }
    if (headerChecks.length > 0) {
      const last = headerChecks[headerChecks.length - 1];
      assert.ok(last.headerBytes <= last.MAX_HEADER_BYTES, `headerBytes ${last.headerBytes} > cap ${last.MAX_HEADER_BYTES}`);
    }

    assert.equal(resp.status, 200);

    // Find engine_selected log and verify tenant is surfaced and sanitized
    const logEntry = events.find((e) => e && e.evt === 'engine_selected' && e.conv_id === convId);
    assert.ok(logEntry, 'engine_selected log found');
    const sanitizedTenant = tenantVal.replace(/[^a-zA-Z0-9_\.\-]/g, '');
    assert.equal(logEntry.tenant, sanitizedTenant, 'tenant should be surfaced and sanitized in engine_selected log');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((r) => child.on('exit', r));
  }
});
