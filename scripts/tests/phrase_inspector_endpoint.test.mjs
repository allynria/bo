import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

test('Admin phrase inspector returns snapshot', async () => {
  const port = 3352 + Math.floor(Math.random() * 1000);
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    ADMIN_TOKEN: 'admintest',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: 'http://ok.test'
  };
  const child = spawn(process.execPath, [script], { env });
  const base = `http://127.0.0.1:${port}`;
  await waitForUp(base, { timeout: 2000 });
  try {
    const convId = 'PHRASE-INSPECT-1';
    // Prime the store via conv message (requires conv auth in production)
    await fetch(`${base}/v1/conv/message`, {
      method:'POST',
      headers: { 'content-type':'application/json', origin:'http://ok.test', authorization:'Bearer test-token' },
      body: JSON.stringify({ conv_id: convId, engine:'urga', text:'She smiles softly. You notice her gaze.' })
    });
    const r = await fetch(`${base}/admin/conv/${encodeURIComponent(convId)}/phrases?token=admintest`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.conv_id, convId);
    assert.ok(typeof j.snapshot === 'object');
  } finally {
    try { child.kill('SIGINT'); } catch {}
    await new Promise((r) => child.on('exit', r));
  }
});
