import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

test('scene tagging + revisit injects scene memory', async () => {
  const port = 4800 + Math.floor(Math.random() * 100);
  const env = {
    PORT: String(port),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    TEST_MEMORY_API: '1',
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5',
  };
  const child = startService(env);
  const BASE = `http://127.0.0.1:${port}`;
  try {
    await waitForUp(BASE, { timeout: 3000 });

    const conv_id = 'c_scene';
    // clear and seed one fact
    await fetch(`${BASE}/__test/clear`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conv_id }),
    });
    const f = await (
      await fetch(`${BASE}/__test/fact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conv_id,
          text: 'They confessed their secret in the Old Harbor library',
          weight: 0.9,
          score: 0.8,
        }),
      })
    ).json();
    const fid = f.fact.id;

    // link scene explicitly
    const sceneResp = await (
      await fetch(`${BASE}/memory/scene`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conv_id,
          scene: 'Old Harbor Library',
          fact_ids: [fid],
          booster: '(You are back in the Old Harbor library.)',
        }),
      })
    ).json();
    assert.equal(sceneResp.ok, true);

    // visit scene in stream
    const res = await fetch(
      `${BASE}/conv/stream?engine=urga&conv_id=${conv_id}&turn=2&text=${encodeURIComponent('We walk into the Old Harbor Library once more')}`,
      { headers: { Accept: 'text/event-stream' } }
    );
    assert.equal(res.status, 200);

    // let it finish quickly
    await new Promise((r) => setTimeout(r, 300)); // stub streams are fast

    // metrics: scene_injected_total should exist (incremented in stream path)
    const m = await (await fetch(`${BASE}/metrics`)).json();
    const sceneInjected = (m.counters || []).find((c) => c.name === 'scene_injected_total');
    assert.ok(sceneInjected, 'scene_injected_total present');
  } finally {
    try {
      child.kill('SIGTERM');
    } catch {}
    await new Promise((r) => child.on('exit', r));
  }
});
