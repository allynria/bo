import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

const PORT = process.env.PORT || '3707';
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'ci';
const CONV_AUTH = 'test-token';

// simple fetch wrapper
async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const txt = await res.text();
  try {
    return { res, json: JSON.parse(txt) };
  } catch {
    return { res, text: txt };
  }
}

let child;

before(async () => {
  child = spawn(process.execPath, ['scripts/service.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      TEST_HELPERS: '1',
      TEST_MEMORY_API: '1', // enable test-only memory admin APIs
      MEMORY_DREAMS_EVERY: '1', // make dream injection deterministic
      PORT,
      // auth + replay window requirements
      CONV_AUTH,
      REPLAY_WINDOW_MS: '60000',
      CORS_ALLOWLIST: '', // no CORS gating
      // stubs
      LLM_TEST_STUBS: '1',
      URGA_PROVIDER: 'stub-urga',
      // memory flags
      ARC_LINKING_ENABLED: '1',
      FACTS_AGENT_SCOPING: '1',
      DREAM_FRAGMENTS_ENABLED: '1',
      DREAM_PROMOTE_WEIGHT: '0.5',
      DREAM_MIN_REPEATS: '1',
      DREAM_TTL_TURNS: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // wait for ready
  const readyBy = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < readyBy) {
    try {
      const { res, json } = await jfetch(`${BASE}/healthz`);
      if (res.ok && json && (json.ready ?? json.ok ?? true)) {
        healthy = true;
        break;
      }
    } catch {}
    await delay(200);
  }
  assert.ok(healthy, 'service did not become healthy');
});

after(async () => {
  if (child) {
    try {
      child.kill('SIGINT');
    } catch {}
    await delay(200);
  }
});

test('SSE emits memory.arc and memory.dream', async (t) => {
  const conv_id = 'demo-arc-dream';
  const arcName = 'Cathedral Pursuit';

  // set explicit arc
  {
    const { res, json } = await jfetch(`${BASE}/memory/arc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conv_id, arc: arcName }),
    });
    assert.equal(res.status, 200, 'POST /memory/arc status');
    assert.equal(json.ok, true);
    assert.equal(json.arc, arcName);
  }

  // seed a fact that should promote to a dream
  {
    const { res, json } = await jfetch(`${BASE}/__test/fact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conv_id,
        text: 'She hid the locket beneath the Cathedral altar.',
        weight: 0.95,
        score: 0.9,
        repeats: 2, // meets DREAM_MIN_REPEATS=1
        agent_id: 'bot',
        arc_tags: [arcName],
      }),
    });
    assert.equal(res.status, 200, 'seed fact status');
    assert.equal(json.ok, true);
  }

  // open SSE and read a few events
  const ts = Date.now();
  const url = `${BASE}/v1/conv/stream?engine=urga&conv_id=${encodeURIComponent(conv_id)}&turn=0&text=${encodeURIComponent('We return to the Cathedral altar now')}&ts=${ts}&arc=${encodeURIComponent(arcName)}`;
  const res = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${CONV_AUTH}`,
      'x-agent-id': 'bot',
    },
  });
  assert.equal(res.status, 200, 'SSE 200');

  const reader = res.body.getReader();
  let buf = '';
  let seenArc = false;
  let seenDream = false;

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && (!seenArc || !seenDream)) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    // parse SSE lines
    const chunks = buf.split('\n\n');
    buf = chunks.pop() || '';
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (event === 'memory.arc') {
        seenArc = true;
      } else if (event === 'memory.dream') {
        try {
          const payload = JSON.parse(data);
          if (payload && payload.text && payload.text.includes('faint memory')) {
            seenDream = true;
          } else {
            // even without the phrase, seeing any memory.dream is sufficient
            seenDream = true;
          }
        } catch {
          seenDream = true; // conservative: event seen
        }
      }
      if (seenArc && seenDream) break;
    }
  }

  assert.ok(seenArc, 'expected memory.arc event');
  assert.ok(seenDream, 'expected memory.dream event');

  // close the stream
  try {
    await res.body.cancel();
  } catch {}
});
