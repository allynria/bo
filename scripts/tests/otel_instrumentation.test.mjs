import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';

function installTracerStub() {
  const spans = [];
  const tracer = {
    startSpan(name, { attributes = {} } = {}) {
      const attr = { ...attributes };
      const span = {
        name,
        attributes: attr,
        setAttribute(k, v) { attr[k] = v; },
        end() { spans.push({ name, attributes: { ...attr } }); }
      };
      return span;
    }
  };
  globalThis.__OTEL_TRACER__ = tracer;
  globalThis.__SPAN_LOG__ = spans;
  return spans;
}

function setRid(rid = 'rid-test') {
  globalThis.__RID_STORE__ = {
    getStore() { return { rid }; }
  };
}

function tmpdir(name) {
  return path.join(os.tmpdir(), `${name}_${process.pid}_${Math.random().toString(36).slice(2)}`);
}

// Head-sample FS readFile
test('OTEL FS head sampling: readFile emits span with request_id', async () => {
  process.env.OTEL_FS_SAMPLE_HEAD_RATE = '1';
  process.env.OTEL_FS_TAIL_SLOW_MS = '100000';
  setRid('rid-fs-head');
  const spans = installTracerStub();
  const monolith = await import('../../monolith.js');
  const { AsyncFS } = monolith;

  const dir = tmpdir('otel_fs_head');
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'a.txt');
  await fsp.writeFile(p, 'hello', 'utf8');

  await AsyncFS.readFile(p, 'utf8');
  const s = spans.filter((x) => x.name === 'fs.readFile').pop();
  assert.ok(s, 'fs.readFile span should be emitted');
  assert.equal(s.attributes.request_id, 'rid-fs-head');
  assert.equal(String(s.attributes['fs.path']), String(p));
  assert.ok(Number.isFinite(Number(s.attributes['fs.dur_ms'])), 'fs.dur_ms should be set');
});

// Tail-slow FS readFile
test('OTEL FS tail-slow: readFile emits tail span when head off', async () => {
  process.env.OTEL_FS_SAMPLE_HEAD_RATE = '0';
  process.env.OTEL_FS_TAIL_SLOW_MS = '1';
  setRid('rid-fs-tail');
  const spans = installTracerStub();
  const monolith = await import('../../monolith.js');
  const { AsyncFS } = monolith;

  const dir = tmpdir('otel_fs_tail');
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'b.txt');
  await fsp.writeFile(p, 'world', 'utf8');

  const origNow = Date.now;
  let calls = 0;
  Date.now = () => { const v = origNow(); calls++; return calls === 1 ? v : v + 5; };
  try {
    await AsyncFS.readFile(p, 'utf8');
  } finally { Date.now = origNow; }
  const s = spans.filter((x) => x.name === 'fs.readFile.tail').pop();
  assert.ok(s, 'fs.readFile.tail span should be emitted');
  assert.equal(s.attributes.request_id, 'rid-fs-tail');
  assert.equal(String(s.attributes['fs.path']), String(p));
  assert.ok(Number.isFinite(Number(s.attributes['fs.dur_ms'])), 'fs.dur_ms should be set');
});

// Head-sample acquireLock
test('OTEL FS head sampling: acquireLock emits span', async () => {
  process.env.OTEL_FS_SAMPLE_HEAD_RATE = '1';
  process.env.OTEL_FS_TAIL_SLOW_MS = '100000';
  setRid('rid-lock');
  const spans = installTracerStub();
  const monolith = await import('../../monolith.js');
  const { __acquireLock__ } = monolith;

  const dir = tmpdir('otel_lock');
  await fsp.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, 'file.lock');
  const release = await __acquireLock__(lockPath, { timeoutMs: 500 });
  await release();
  const s = spans.filter((x) => x.name === 'fs.acquireLock').pop();
  assert.ok(s, 'fs.acquireLock span should be emitted');
  assert.equal(s.attributes.request_id, 'rid-lock');
});

// Head-sample handler
test('OTEL Handler head sampling: wrapChatHandler emits span with request_id', async () => {
  process.env.OTEL_HANDLER_SAMPLE_HEAD_RATE = '1';
  process.env.OTEL_HANDLER_TAIL_SLOW_MS = '100000';
  setRid('rid-handler-head');
  const spans = installTracerStub();
  const monolith = await import('../../monolith.js');
  const { wrapChatHandler } = monolith;

  const handler = wrapChatHandler(async (input) => `echo:${input}`);
  const ctx = { send: async () => {} };
  const out = await handler('hi', ctx);
  assert.equal(out, 'echo:hi');
  const s = spans.filter((x) => x.name === 'wrapChatHandler').pop();
  assert.ok(s, 'wrapChatHandler span should be emitted');
  assert.equal(s.attributes.request_id, 'rid-handler-head');
  assert.ok(Number.isFinite(Number(s.attributes['handler.dur_ms'])), 'handler.dur_ms should be set');
});

// Tail-slow handler
test('OTEL Handler tail-slow: wrapChatHandler emits tail span when head off', async () => {
  process.env.OTEL_HANDLER_SAMPLE_HEAD_RATE = '0';
  process.env.OTEL_HANDLER_TAIL_SLOW_MS = '1';
  setRid('rid-handler-tail');
  const spans = installTracerStub();
  const monolith = await import('../../monolith.js');
  const { wrapChatHandler } = monolith;

  const handler = wrapChatHandler(async (input) => `echo:${input}`);
  const origNow = Date.now;
  let calls = 0;
  Date.now = () => { const v = origNow(); calls++; return calls === 1 ? v : v + 5; };
  let out;
  try {
    out = await handler('hi');
  } finally { Date.now = origNow; }
  assert.equal(out, 'echo:hi');
  const s = spans.filter((x) => x.name === 'wrapChatHandler.tail').pop();
  assert.ok(s, 'wrapChatHandler.tail span should be emitted');
  assert.equal(s.attributes.request_id, 'rid-handler-tail');
  assert.ok(Number.isFinite(Number(s.attributes['handler.dur_ms'])), 'handler.dur_ms should be set');
});
