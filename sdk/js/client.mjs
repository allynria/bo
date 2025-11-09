// Generated from scripts/docs/openapi.json. Do not edit by hand.

import http from 'node:http';
import crypto from 'node:crypto';
import Ajv from 'ajv';
import { EventEmitter } from 'node:events';

const ajv = new Ajv({ strict: true, allErrors: true, removeAdditional: false });

const MessageRequest = {"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"content":{"type":"array","items":{"type":"string"}},"conv_id":{"type":"string"},"turn":{"type":"integer"},"engine":{"type":"string","enum":["echo","urga","dreams"]},"persona_v":{"type":"string"},"prompt_v":{"type":"string"},"id":{"type":"string"},"ts":{"type":"number"},"ctx":{"type":"object","properties":{"vars":{"type":"object"}}}}};
const MessageResponse = {"type":"object","properties":{"ok":{"type":"boolean"},"reply":{"$ref":"#/components/schemas/ReplyMessage"},"model":{"type":"string"},"provider":{"type":"string"},"resolved_model":{"type":"string"},"variant_v":{"type":"string"},"engine_source":{"type":"string","enum":["explicit","ctx","heuristic","default","replay"]},"hash":{"type":"string"},"bytes_b64":{"type":"string"},"idempotent_replay":{"type":"boolean"},"request_id":{"type":"string"}},"required":["ok","reply","model","provider","resolved_model","hash","bytes_b64"]};
const CompileRequest = {"type":"object","additionalProperties":false,"properties":{"messages":{"type":"array","items":{"$ref":"#/components/schemas/Message"}},"persona_v":{"type":"string"},"prompt_v":{"type":"string"}},"required":["messages"]};
const CompileResponse = {"type":"object","properties":{"ok":{"type":"boolean"},"hash":{"type":"string"},"bytes_b64":{"type":"string"}},"required":["ok","hash","bytes_b64"]};

// Add referenced component schemas when present
const ReplyMessage = {"type":"object","properties":{"role":{"type":"string"},"conv_id":{"type":"string"},"turn":{"type":"integer"},"content":{"type":"array","items":{"type":"string"}}}};
ajv.addSchema(ReplyMessage, '#/components/schemas/ReplyMessage');
const Message = {"type":"object","properties":{"role":{"type":"string","enum":["system","memory","context","user","tool_result","policy","assistant"]},"text":{"type":"string"},"content":{"type":"array","items":{"type":"string"}},"conv_id":{"type":"string"},"turn":{"type":"integer"},"id":{"type":"string"},"ts":{"type":"number"}}};
ajv.addSchema(Message, '#/components/schemas/Message');


const validateMessageRequest = ajv.compile(MessageRequest);
const validateMessageResponse = ajv.compile(MessageResponse);
const validateCompileRequest = ajv.compile(CompileRequest);
const validateCompileResponse = ajv.compile(CompileResponse);

function postJson(baseUrl, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(baseUrl);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: pathName, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
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

export async function postV1ConvMessage(baseUrl, body) {
  const okBody = validateMessageRequest(body);
  if (!okBody) {
    const errs = (validateMessageRequest.errors || []).map((e) => ({ path: e.instancePath || e.schemaPath, message: e.message }));
    const err = new Error('MessageRequest schema invalid');
    err.details = errs;
    throw err;
  }
  const res = await postJson(baseUrl, '/v1/conv/message', body);
  if (res.status === 200) {
    const okRes = validateMessageResponse(res.json);
    if (!okRes) {
      const errs = (validateMessageResponse.errors || []).map((e) => ({ path: e.instancePath || e.schemaPath, message: e.message }));
      const err = new Error('MessageResponse schema invalid');
      err.details = errs; err.status = res.status; err.json = res.json;
      throw err;
    }
  }
  return res;
}

export async function postV1ConvCompile(baseUrl, body) {
  const okBody = validateCompileRequest(body);
  if (!okBody) {
    const errs = (validateCompileRequest.errors || []).map((e) => ({ path: e.instancePath || e.schemaPath, message: e.message }));
    const err = new Error('CompileRequest schema invalid');
    err.details = errs;
    throw err;
  }
  const res = await postJson(baseUrl, '/v1/conv/compile', body);
  if (res.status === 200) {
    const okRes = validateCompileResponse(res.json);
    if (!okRes) {
      const errs = (validateCompileResponse.errors || []).map((e) => ({ path: e.instancePath || e.schemaPath, message: e.message }));
      const err = new Error('CompileResponse schema invalid');
      err.details = errs; err.status = res.status; err.json = res.json;
      throw err;
    }
  }
  return res;
}
// Simple SSE client for /v1/conv/stream that emits 'start', 'delta', and 'end'.
// Returns an EventEmitter with .close() to abort the stream.
export function subscribeV1ConvStream(baseUrl, opts) {
  const emitter = new EventEmitter();
  if (!opts || !opts.conv_id || typeof opts.turn !== 'number' || !opts.engine) {
    queueMicrotask(() => emitter.emit('error', new Error('conv_id, turn (number), and engine are required')));
    return emitter;
  }
  let u;
  try { u = new URL(baseUrl); } catch (e) { queueMicrotask(() => emitter.emit('error', e)); return emitter; }
  const qs = new URLSearchParams();
  qs.set('conv_id', opts.conv_id);
  qs.set('turn', String(opts.turn));
  qs.set('engine', opts.engine);
  if (opts.text) qs.set('text', opts.text);
  if (opts.persona_v) qs.set('persona_v', opts.persona_v);
  if (opts.prompt_v) qs.set('prompt_v', opts.prompt_v);
  if (typeof opts.ts === 'number' && Number.isFinite(opts.ts)) qs.set('ts', String(opts.ts));
  if (opts.reconnect) qs.set('reconnect', '1');
  const pathName = `/v1/conv/stream?${qs.toString()}`;
  const baseHeaders = { Accept: 'text/event-stream', 'User-Agent': 'sdk-js-client/1.0' };
  const headers = { ...baseHeaders, ...(opts.headers || {}) };
  const req = http.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: pathName, headers }, (res) => {
    if (res.statusCode !== 200) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { emitter.emit('error', { status: res.statusCode, body }); });
      return;
    }
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('

')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split(/?
/);
        let evt = 'message';
        let data = '';
        for (const line of lines) {
          if (line.startsWith('event:')) evt = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        let payload = data;
        try { payload = JSON.parse(data); } catch {}
        emitter.emit(evt, payload);
      }
    });
    res.on('end', () => { emitter.emit('close'); });
  });
  req.on('error', (err) => emitter.emit('error', err));
  emitter.close = () => { try { req.abort(); } catch {} try { emitter.emit('close'); } catch {} };
  return emitter;
}

// Async iterator wrapper for /v1/conv/stream
// Yields { event, payload } items suitable for `for await` consumption.
// Events: 'start' | 'delta' | 'hedge.switch' | 'end'
export function iterateV1ConvStream(baseUrl, opts) {
  const sse = subscribeV1ConvStream(baseUrl, opts);
  let done = false;
  const q = [];
  let resolveNext = null;
  const push = (item) => {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: item, done: false }); }
    else { q.push(item); }
  };
  sse.on('start', (payload) => push({ event: 'start', payload }));
  sse.on('delta', (payload) => push({ event: 'delta', payload }));
  sse.on('hedge.switch', (payload) => push({ event: 'hedge.switch', payload }));
  sse.on('end', (payload) => { push({ event: 'end', payload }); done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); } });
  sse.on('error', (err) => push({ event: 'error', payload: err }));
  const iterator = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (q.length) { const v = q.shift(); return Promise.resolve({ value: v, done: false }); }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { resolveNext = resolve; });
        },
        return() { try { sse.close(); } catch {} done = true; return Promise.resolve({ value: undefined, done: true }); }
      };
    },
    close() { try { sse.close(); } catch {} done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); } }
  };
  return iterator;
}

// Helpers for HMAC + timestamp used by /v1/conv/message and /v1/conv/stream
export function computeClientTs() { return Date.now(); }
export function computeClientMac(secret, method, pathTag, ts) {
  return crypto.createHmac('sha256', secret).update(`${String(method).toUpperCase()}:${String(pathTag)}:${String(ts)}`).digest('hex');
}

// Auto-retry wrapper for /v1/conv/stream to recover from 409 replay_unavailable
// Attempts up to maxAttempts with toggled reconnect flag.
export function iterateV1ConvStreamAutoReplay(baseUrl, opts, { macSecret, macId = '', origin, maxAttempts = 2 } = {}) {
  const ts = typeof opts.ts === 'number' ? opts.ts : computeClientTs();
  const mac = macSecret ? computeClientMac(macSecret, 'GET', 'stream', ts) : '';
  const headers = { ...(origin ? { origin } : {}), ...(mac ? { 'x-client-mac': mac } : {}), ...(macId ? { 'x-mac-id': macId } : {}) };
  const baseOpts = { ...opts, ts, headers };
  let attempt = 0;
  let reconnect = Boolean(opts.reconnect);
  let sse = subscribeV1ConvStream(baseUrl, { ...baseOpts, reconnect });
  let done = false;
  const q = [];
  let resolveNext = null;
  const push = (item) => { if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: item, done: false }); } else { q.push(item); } };
  const restart = () => {
    if (sse) { try { sse.close(); } catch {} }
    attempt += 1;
    if (attempt >= maxAttempts) { done = true; push({ event: 'error', payload: new Error('replay_unavailable; maxAttempts reached') }); return; }
    // Toggle reconnect: first retry turns it on; subsequent retry turns it off (fresh stream)
    reconnect = !reconnect;
    sse = subscribeV1ConvStream(baseUrl, { ...baseOpts, reconnect });
    wire();
  };
  const wire = () => {
    sse.on('start', (payload) => push({ event: 'start', payload }));
    sse.on('delta', (payload) => push({ event: 'delta', payload }));
    sse.on('hedge.switch', (payload) => push({ event: 'hedge.switch', payload }));
    sse.on('end', (payload) => { push({ event: 'end', payload }); done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); } });
    sse.on('error', (err) => {
      // Detect 409 replay_unavailable and retry
      const status = Number(err?.status || 0);
      let j = null;
      try { j = JSON.parse(String(err?.body || '')); } catch {}
      if (status === 409 && j && j.error === 'replay_unavailable') { restart(); return; }
      push({ event: 'error', payload: err });
    });
  };
  wire();
  const iterator = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (q.length) { const v = q.shift(); return Promise.resolve({ value: v, done: false }); }
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { resolveNext = resolve; });
        },
        return() { try { sse.close(); } catch {} done = true; return Promise.resolve({ value: undefined, done: true }); }
      };
    },
    close() { try { sse.close(); } catch {} done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); } }
  };
  return iterator;
}
