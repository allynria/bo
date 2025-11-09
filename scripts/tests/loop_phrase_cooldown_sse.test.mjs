import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || '3342';
const BASE = `http://127.0.0.1:${PORT}`;

async function start() {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT,
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    CONV_AUTH: 'test-token',
    CORS_ALLOWLIST: ' `http://ok.test` ',
    ULTRA_DEFAULT_ON: '1',
    LOOP_PHRASE_DECAY_ENABLED: '1',
    LOOP_PHRASE_MAX_COUNT: '2',
    LOOP_PHRASE_PATTERNS: 'she smiles softly|you notice',
  };
  const child = spawn(process.execPath, ['scripts/service.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => setTimeout(r, 600));
  return child;
}

function sse(text) {
  const url = `${BASE}/v1/conv/stream?conv_id=PDEC1&turn=0&engine=urga&text=${encodeURIComponent(text)}&ts=${Date.now()}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: 'GET',
        headers: {
          origin: ' `http://ok.test` ',
          authorization: 'Bearer test-token',
          accept: 'text/event-stream',
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => {
          buf += d.toString('utf8');
          if (buf.includes('event: loop.phrase.cooldown')) resolve(buf);
        });
        setTimeout(() => resolve(buf), 3000);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('emits loop.phrase.cooldown when phrases are hot', async () => {
  const svc = await start();
  try {
    // Prime the phrase store by calling message endpoint twice to simulate repeats
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${BASE}/v1/conv/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: ' `http://ok.test` ',
          authorization: 'Bearer test-token',
        },
        body: JSON.stringify({
          conv_id: 'PDEC1',
          text: 'She smiles softly and you notice the hush.',
          engine: 'urga',
          ts: Date.now(),
        }),
      });
      assert.equal(r.status, 200);
    }
    // Now stream: should emit cooldown event
    const buf = await sse('Continue the same gentle scene.');
    assert.ok(buf.includes('event: loop.phrase.cooldown'), 'should announce phrase cooldown');
  } finally {
    svc.kill('SIGINT');
  }
});
