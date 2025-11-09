import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import Ajv from 'ajv';

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });
  return { child, getLogs: () => logs };
}

function waitForUp(base, { timeout = 5000 } = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get(`${base}/readyz`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('timeout'));
        setTimeout(tick, 100);
      }).on('error', () => {
        if (Date.now() - start > timeout) return reject(new Error('timeout'));
        setTimeout(tick, 100);
      });
    };
    tick();
  });
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

async function main() {
  const port = 5000 + Math.floor(Math.random() * 500);
  const env = { PORT: String(port), QUEUE_MAX: '0', LLM_TEST_STUBS: '1', URGA_PROVIDER: 'stub-urga' };
  const { child, getLogs } = startService(env);
  const base = `http://localhost:${port}`;
  try { await waitForUp(base, { timeout: 5000 }); } catch (e) { console.error('Service failed to start:', e?.message); console.error(getLogs()); try { child.kill('SIGTERM'); } catch {}; return; }

  const specRes = await fetchJson(`${base}/openapi.json`);
  console.log('spec status:', specRes.status);
  const spec = specRes.json;
  const ajv = new Ajv({ strict: true, allErrors: true, removeAdditional: false });
  const s = spec.components?.schemas || {};
  const ReplyMessage = s.ReplyMessage;
  const Message = s.Message;
  if (ReplyMessage) ajv.addSchema(ReplyMessage, '#/components/schemas/ReplyMessage');
  if (Message) ajv.addSchema(Message, '#/components/schemas/Message');
  const validateMessageResponse = ajv.compile(s.MessageResponse);
  const validateCompileResponse = ajv.compile(s.CompileResponse);

  const msgOk = await postJson(`${base}/v1/conv/message`, { text: 'hello', engine: 'echo', conv_id: 'oapi-msg', turn: 0 });
  console.log('message status:', msgOk.status);
  console.log('message json:', JSON.stringify(msgOk.json));
  const msgValid = validateMessageResponse(msgOk.json);
  console.log('message valid:', msgValid);
  if (!msgValid) console.log('message errors:', JSON.stringify(validateMessageResponse.errors));

  const compOk = await postJson(`${base}/v1/conv/compile`, { messages: [{ role: 'user', text: 'hello' }] });
  console.log('compile status:', compOk.status);
  console.log('compile json:', JSON.stringify(compOk.json));
  const compValid = validateCompileResponse(compOk.json);
  console.log('compile valid:', compValid);
  if (!compValid) console.log('compile errors:', JSON.stringify(validateCompileResponse.errors));

  try { child.kill('SIGTERM'); } catch {}
}

main().catch((e) => { console.error('probe error:', e?.message || e); });

