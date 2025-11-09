import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });
  let json = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('admin forced scene conclusion applies on next turn without duplicate staged SSE', async () => {
  const port = 3700 + Math.floor(Math.random() * 200);
  const token = 'admintoken';
  const convToken = 'convtoken';
  const child = startService({
    NODE_ENV: 'production',
    LOG_JSON: '1',
    PORT: String(port),
    ADMIN_TOKEN: token,
    CONV_AUTH: convToken,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    TEST_MEMORY_API: '1',
    CONCLUDE_ENABLED: '0'
  });
  const BASE = `http://127.0.0.1:${port}`;
  await waitForUp(BASE, { timeout: 3000 });

  const conv_id = 'c_admin_conclusion';
  await postJson(`${BASE}/__test/clear`, { conv_id });

  // Force stage a conclusion via admin endpoint
  const forced = await postJson(`${BASE}/admin/scene/conclusion`, { conv_id, style: 'cut' }, { Authorization: `Bearer ${token}` });
  assert.equal(forced.status, 200);
  assert.equal(forced.json.ok, true);
  assert.equal(String(forced.json.conv_id), conv_id);
  assert.equal(forced.json.staged?.staged, true);
  assert.equal(forced.json.staged?.reason, 'force');
  assert.equal(forced.json.staged?.style, 'cut');

  // Metrics should reflect admin staged once
  const m1 = await (await fetch(`${BASE}/metrics`)).json();
  const stagedAdmin = (m1.counters || []).find(c => c.name === 'scene_conclusion_staged_total' && String(c.labels?.path || '') === 'admin');
  assert.ok(stagedAdmin, 'scene_conclusion_staged_total (admin) present');
  assert.equal(Number(stagedAdmin.value || 0), 1);

  // Next stream turn should apply the forced conclusion (no duplicate staged)
  const res = await fetch(`${BASE}/conv/stream?engine=urga&conv_id=${encodeURIComponent(conv_id)}&turn=1&text=${encodeURIComponent('Hello')}`, { headers: { Accept: 'text/event-stream', Authorization: `Bearer ${convToken}` } });
  assert.equal(res.status, 200);
  // Stubbed streams finish quickly
  await new Promise(r => setTimeout(r, 300));

  const m2 = await (await fetch(`${BASE}/metrics`)).json();
  const appliedStream = (m2.counters || []).find(c => c.name === 'scene_conclusion_applied_total' && String(c.labels?.path || '') === 'stream');
  assert.ok(appliedStream, 'scene_conclusion_applied_total (stream) present');
  assert.equal(Number(appliedStream.value || 0), 1);

  const stagedStream = (m2.counters || []).find(c => c.name === 'scene_conclusion_staged_total' && String(c.labels?.path || '') === 'stream');
  assert.equal(stagedStream, undefined, 'no duplicate staged on stream path');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});
