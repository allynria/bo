import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const specPath = path.join(process.cwd(), 'scripts', 'docs', 'openapi.json');
  const outDir = path.join(process.cwd(), 'sdk', 'js');
  const outFile = path.join(outDir, 'client.mjs');
  const raw = await fsp.readFile(specPath, 'utf8');
  const spec = JSON.parse(raw);
  const s = spec?.components?.schemas || {};
  const msgReq = s.MessageRequest; const msgRes = s.MessageResponse;
  const compReq = s.CompileRequest; const compRes = s.CompileResponse;
  const replyMsg = s.ReplyMessage; const message = s.Message;
  if (!msgReq || !msgRes || !compReq || !compRes) {
    throw new Error('OpenAPI components missing required schemas (MessageRequest/Response, CompileRequest/Response).');
  }
  await fsp.mkdir(outDir, { recursive: true });
  const header = `// Generated from scripts/docs/openapi.json. Do not edit by hand.\n`;
  const code = `${header}
import http from 'node:http';
import Ajv from 'ajv';
import { EventEmitter } from 'node:events';

const ajv = new Ajv({ strict: true, allErrors: true, removeAdditional: false });

const MessageRequest = ${JSON.stringify(msgReq)};
const MessageResponse = ${JSON.stringify(msgRes)};
const CompileRequest = ${JSON.stringify(compReq)};
const CompileResponse = ${JSON.stringify(compRes)};

// Add referenced component schemas when present
${replyMsg ? `const ReplyMessage = ${JSON.stringify(replyMsg)};
ajv.addSchema(ReplyMessage, '#/components/schemas/ReplyMessage');
` : ''}${message ? `const Message = ${JSON.stringify(message)};
ajv.addSchema(Message, '#/components/schemas/Message');
` : ''}

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
  const pathName = \`/v1/conv/stream?\${qs.toString()}\`;
  const req = http.get({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: pathName, headers: { Accept: 'text/event-stream', 'User-Agent': 'sdk-js-client/1.0' } }, (res) => {
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
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split(/\r?\n/);
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
// Yields { event, payload } items suitable for \`for await\` consumption.
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
`;
  await fsp.writeFile(outFile, code, 'utf8');
  // Touch a marker file to allow CI diff checks
  await fsp.writeFile(path.join(outDir, '.generated'), String(Date.now()), 'utf8');
}

main().catch((e) => { console.error(e); process.exit(1); });
