import test from 'node:test';
import assert from 'node:assert/strict';
import { lintToolPolicy } from '../tool_policy.mjs';

test('lintToolPolicy validates minimal valid policy', () => {
  const policy = {
    version: 1,
    tool: 'echo',
    fs: { allow: ['C:/tmp', '/var/tmp'] },
    net: { allow: ['localhost', 'example.com:443'] },
    limits: { memory_mb: 64, timeout_ms: 2000 }
  };
  const res = lintToolPolicy(policy);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('lintToolPolicy reports missing fields', () => {
  const policy = { tool: '', fs: {}, net: {} };
  const res = lintToolPolicy(policy);
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.errors));
  assert.ok(res.errors.includes('version_invalid_or_missing'));
  assert.ok(res.errors.includes('tool_missing'));
  assert.ok(res.errors.includes('fs.allow_missing_or_not_array'));
  assert.ok(res.errors.includes('net.allow_missing_or_not_array'));
});

