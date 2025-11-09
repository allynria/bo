import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

test('Ultra toggle per conv works', async () => {
  const port = 3351 + Math.floor(Math.random() * 1000);
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: 'http://ok.test',
  };
  const child = spawn(process.execPath, [script], { env });
  const base = `http://127.0.0.1:${port}`;
  await waitForUp(base, { timeout: 2000 });
  try {
    const conv_id = 'ULTRA-TEST-1';
    let r = await fetch(`${base}/conv/ultra?conv_id=${encodeURIComponent(conv_id)}`, {
      headers: { origin: 'http://ok.test', authorization: 'Bearer test-token' },
    });
    assert.equal(r.status, 200);
    const s0 = await r.json();
    assert.ok(typeof s0.ultra === 'boolean');

    r = await fetch(`${base}/conv/ultra`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://ok.test',
        authorization: 'Bearer test-token',
      },
      body: JSON.stringify({ conv_id, on: true }),
    });
    assert.equal(r.status, 200);
    const s1 = await r.json();
    assert.equal(s1.ultra, true);
  } finally {
    try {
      child.kill('SIGINT');
    } catch {}
    await new Promise((r) => child.on('exit', r));
  }
});
