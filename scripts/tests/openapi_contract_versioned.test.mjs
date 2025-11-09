import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import Ajv from 'ajv';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(data || '{}') }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
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

test('OpenAPI: /openapi.json includes /v1 paths and schemas validate /v1 responses', async () => {
  const port = 4800 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  const specRes = await fetchJson(`${base}/openapi.json`);
  assert.equal(specRes.status, 200, 'openapi.json served');
  const spec = specRes.json;
  assert.ok(spec.paths?.['/v1/conv/message'], 'v1 message path present');
  assert.ok(spec.paths?.['/v1/conv/compile'], 'v1 compile path present');

  const ajv = new Ajv({ strict: true, allErrors: true, removeAdditional: false });
  const s = spec.components?.schemas || {};
  const MessageRequest = s.MessageRequest;
  const MessageResponse = s.MessageResponse;
  const CompileRequest = s.CompileRequest;
  const CompileResponse = s.CompileResponse;
  const ReplyMessage = s.ReplyMessage;
  const Message = s.Message;
  assert.ok(MessageRequest && MessageResponse && CompileRequest && CompileResponse, 'core schemas present');
  if (ReplyMessage) ajv.addSchema(ReplyMessage, '#/components/schemas/ReplyMessage');
  if (Message) ajv.addSchema(Message, '#/components/schemas/Message');

  const validateMessageResponse = ajv.compile(MessageResponse);
  const validateCompileResponse = ajv.compile(CompileResponse);

  const msgOk = await postJson(`${base}/v1/conv/message`, { text: 'hello', engine: 'echo', conv_id: 'oapi-msg', turn: 0 });
  assert.equal(msgOk.status, 200);
  assert.ok(validateMessageResponse(msgOk.json), 'MessageResponse must conform to OpenAPI');

  const compOk = await postJson(`${base}/v1/conv/compile`, { messages: [{ role: 'user', text: 'hello' }] });
  assert.equal(compOk.status, 200);
  assert.ok(validateCompileResponse(compOk.json), 'CompileResponse must conform to OpenAPI');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

test('OpenAPI contract: unknown fields fail for /v1 routes with schema_invalid', async () => {
  const port = 4820 + Math.floor(Math.random() * 200);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  await waitForUp(base, { timeout: 5000 }).catch(async () => { try { child.kill('SIGTERM'); } catch {}; throw new Error('service did not become ready: ' + getLogs()); });

  const r1 = await postJson(`${base}/v1/conv/message`, { text: 'hi', conv_id: 'c-oapi-1', turn: 0, engine: 'urga', extra_field: 'nope' });
  assert.equal(r1.status, 400);
  assert.equal(r1.json?.error, 'schema_invalid');
  assert.ok(Array.isArray(r1.json?.errors), 'errors array present');

  const r2 = await postJson(`${base}/v1/conv/compile`, { messages: [{ role: 'user', text: 'hi' }], extra_field: 'nope' });
  assert.equal(r2.status, 400);
  assert.equal(r2.json?.error, 'schema_invalid');
  assert.ok(Array.isArray(r2.json?.errors), 'errors array present for compile');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

