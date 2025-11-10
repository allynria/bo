import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { waitForUp } from './helpers/wait_for_up.mjs';

function startMockOllama(port) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/chat') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {}
        const stream = !!payload?.stream;
        if (!stream) {
          const body = {
            model: String(payload?.model || ''),
            message: { role: 'assistant', content: 'mock-response' },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
        } else {
          // NDJSON stream as Ollama does
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ message: { role: 'assistant', content: 'part1' } }) + '\n');
          setTimeout(() => {
            res.write(JSON.stringify({ message: { role: 'assistant', content: ' part2' } }) + '\n');
            setTimeout(() => {
              res.write(JSON.stringify({ done: true }) + '\n');
              try { res.end(); } catch {}
            }, 30);
          }, 30);
        }
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve(server);
    });
  });
}

function startService(env = {}) {
  const script = path.join(process.cwd(), 'scripts', 'service.js');
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  return child;
}

function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const u = new URL(url);
    const req = http.request(
      { method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text || '{}'), text });
          } catch {
            resolve({ status: res.statusCode, text });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('chat proxy: returns non-streamed output from mock ollama', async () => {
  const svcPort = 3800 + Math.floor(Math.random() * 500);
  const mockPort = 3900 + Math.floor(Math.random() * 500);
  const mockHost = `http://127.0.0.1:${mockPort}`;
  const mock = await startMockOllama(mockPort);
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(svcPort), OLLAMA_HOST: mockHost, OLLAMA_MODEL: 'mock-13b' });
  const base = `http://127.0.0.1:${svcPort}`;
  await waitForUp(base, { timeout: 3000 });

  const body = { system: 'test', messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 };
  const res = await postJson(`${base}/api/chat`, body);
  assert.equal(res.status, 200);
  assert.equal(res.json.provider, 'ollama');
  assert.equal(res.json.model, 'mock-13b');
  assert.equal(res.json.output, 'mock-response');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
  await new Promise((r) => mock.close(r));
});

test('chat proxy: streams SSE deltas from mock ollama', async () => {
  const svcPort = 3800 + Math.floor(Math.random() * 500);
  const mockPort = 3900 + Math.floor(Math.random() * 500);
  const mockHost = `http://127.0.0.1:${mockPort}`;
  const mock = await startMockOllama(mockPort);
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(svcPort), OLLAMA_HOST: mockHost, OLLAMA_MODEL: 'mock-13b' });
  const base = `http://127.0.0.1:${svcPort}`;
  await waitForUp(base, { timeout: 3000 });

  const u = new URL(`${base}/api/chat/stream`);
  const req = http.request({ method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname, headers: { 'content-type': 'application/json' } });
  const body = Buffer.from(JSON.stringify({ system: 'test', messages: [{ role: 'user', content: 'stream me' }], temperature: 0.7 }));

  const got = await new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let combined = '';
      res.on('data', (d) => { combined += d.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, text: combined }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  assert.equal(got.status, 200);
  const deltaLines = (got.text || '').split('\n').filter((ln) => ln.startsWith('event: delta'));
  const dataLines = (got.text || '').split('\n').filter((ln) => ln.startsWith('data:'));
  assert.ok(deltaLines.length >= 2, 'should see multiple delta events');
  const doneLine = (got.text || '').split('\n').find((ln) => ln.startsWith('event: done'));
  assert.ok(!!doneLine, 'should end with done event');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
  await new Promise((r) => mock.close(r));
});

test('chat proxy: returns 400 when model missing', async () => {
  const svcPort = 3800 + Math.floor(Math.random() * 500);
  const child = startService({ NODE_ENV: 'production', LOG_JSON: '1', PORT: String(svcPort) });
  const base = `http://127.0.0.1:${svcPort}`;
  await waitForUp(base, { timeout: 3000 });

  const res = await postJson(`${base}/api/chat`, { messages: [{ role: 'user', content: 'no model set' }] });
  assert.equal(res.status, 400);
  assert.equal(res.json?.error, 'model_missing');

  try { child.kill('SIGTERM'); } catch {}
  await new Promise((r) => child.on('exit', r));
});

