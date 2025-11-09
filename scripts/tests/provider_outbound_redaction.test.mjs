import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelAdapter } from '../../monolith.js';

test('provider-bound prompt is scrubbed for PII', async () => {
  let lastPrompt = null;
  const capturingProvider = {
    async generate({ prompt }) {
      lastPrompt = String(prompt || '');
      return 'ok';
    }
  };
  const ctx = {
    providers: { llm: capturingProvider },
    vars: {},
    io: {}
  };
  const adapter = new ModelAdapter(ctx);
  const input = 'Please email me at test@example.com or call 415-555-1234.';
  await adapter.generate({ prompt: input, options: {} });
  assert.ok(lastPrompt, 'provider should receive a prompt');
  assert.ok(!lastPrompt.includes('test@example.com'), 'email must be redacted');
  assert.ok(!lastPrompt.includes('415-555-1234'), 'phone must be redacted');
  assert.ok(lastPrompt.includes('[EMAIL]'), 'redaction marker for email should appear');
  assert.ok(lastPrompt.includes('[PHONE]'), 'redaction marker for phone should appear');
});

