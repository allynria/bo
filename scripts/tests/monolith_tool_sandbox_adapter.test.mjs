import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';

const monolith = await import('../../monolith.js');
const { ToolRegistry } = monolith;

test('Monolith sandbox tool runs via isolated worker adapter', async () => {
  // Local server responds 200
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' ? addr.port || 0 : 0;
  const url = `http://127.0.0.1:${port}/ping`;
  try {
    const ctx = { vars: {}, flags: {}, io: { events: new EventEmitter() } };
    ToolRegistry.register({
      name: 'get_ping',
      description: 'GET ping from local server',
      sandbox: true,
      budget_ms: 3000,
      input_json_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      handler: (input, _ctx) => ({
        op: 'fetch_url',
        args: { url: input.url },
        netAllowlist: [`127.0.0.1:${port}`],
        netTimeoutMs: 2000,
        failClosed: true,
      }),
    });
    const out = await ToolRegistry.run(ctx, 'get_ping', { url });
    assert.equal(out.ok, true, 'tool run ok');
    assert.equal(out.statusCode, 200, 'status 200');
    assert.ok(Number(out.bytes || 0) > 0, 'received bytes');
  } finally {
    try {
      server.close();
    } catch {}
  }
});
