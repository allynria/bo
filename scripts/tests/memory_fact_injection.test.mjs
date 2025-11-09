// Node built-in test runner
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { waitForUp } from './helpers/wait_for_up.mjs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function sse(url){
  return new Promise((resolve, reject)=>{
    const req = http.get(url, { headers: { Accept: 'text/event-stream' } }, res=>{
      resolve(res);
    });
    req.on('error', reject);
  });
}
async function readSSE(res, { untilEvent='end', timeoutMs=3000 } = {}){
  res.setEncoding('utf8');
  let buf = '';
  const events = [];
  const done = new Promise((resolve, reject)=>{
    const to = setTimeout(()=>reject(new Error('SSE timeout')), timeoutMs);
    res.on('data', chunk=>{
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const frame of parts) {
        const lines = frame.split('\n');
        let ev='message', data='';
        for (const line of lines) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        try { events.push({ event: ev, data: data ? JSON.parse(data) : null }); } catch { events.push({ event: ev, data }); }
        if (ev === untilEvent) { clearTimeout(to); resolve(events); }
      }
    });
    res.on('end', ()=>resolve(events));
    res.on('error', reject);
  });
  return done;
}

test('fact re-injection emits memory.fact and injects boosters', async (t)=>{
  const port = 4600 + Math.floor(Math.random() * 100);
  const env = {
    PORT: String(port),
    LLM_TEST_STUBS: '1',
    URGA_PROVIDER: 'stub-urga',
    FACT_INJECT_ENABLED: '1',
    TEST_MEMORY_API: '1',
    QUEUE_MAX: '0',
    LLM_TURN_BUDGET: '5'
  };
  const child = startService(env);
  const BASE = `http://127.0.0.1:${port}`;
  try {
    await waitForUp(BASE, { timeout: 3000 });

    const conv_id = 'c_fact_inject';
    // clear
    await fetch(`${BASE}/__test/clear`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ conv_id }) });
    // seed a couple facts
    const f1 = await (await fetch(`${BASE}/__test/fact`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ conv_id, text:'She fears deep water since the cliff incident', weight:0.8, score:0.7 })})).json();
    const f2 = await (await fetch(`${BASE}/__test/fact`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ conv_id, text:'He keeps a silver locket with her photo', weight:0.6, score:0.6 })})).json();
    assert.equal(f1.ok, true); assert.equal(f2.ok, true);

    // open SSE stream with text that should pull f1
    const url = `${BASE}/conv/stream?engine=urga&conv_id=${conv_id}&turn=1&text=${encodeURIComponent('We return to the Old Harbor; the tide is high and the water is dark.')}`;
    const res = await sse(url);
    assert.equal(res.statusCode, 200);

    const events = await readSSE(res, { untilEvent:'end', timeoutMs:5000 });
    const memEvents = events.filter(e=>e.event==='memory.fact');
    assert.ok(memEvents.length >= 1, 'should emit memory.fact at least once');

    const injected = memEvents.at(0).data?.facts?.map(f=>f.text)||[];
    const hit = injected.some(s => /deep water|cliff incident/i.test(s));
    assert.ok(hit, 'relevant fact should be included');

    // quick metrics sanity
    const m = await (await fetch(`${BASE}/metrics`)).json();
    const factsInjected = (m.counters||[]).find(c=>c.name==='facts_injected_total');
    assert.ok(factsInjected, 'facts_injected_total counter present');
  } finally {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((r) => child.on('exit', r));
  }
});
