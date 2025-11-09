// Verify logger JSON schema, truncation marker, and Bearer redaction in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Configure env BEFORE importing monolith so logger initializes for production JSON-only
process.env.NODE_ENV = 'production';
process.env.LOG_JSON = '1';
process.env.LOG_LEVEL = 'INFO';
process.env.LOG_MAX_BYTES = '64'; // make truncation deterministic and easy to assert

const monolith = await import('../../monolith.js');
const { logAt } = monolith;

function captureConsole(method = 'info') {
  const orig = console[method];
  const calls = [];
  console[method] = (...args) => {
    calls.push(args);
  };
  return {
    restore() {
      console[method] = orig;
    },
    getCalls() {
      return calls.map((a) => a.map((x) => String(x)));
    },
  };
}

test('logger: JSON output contains expected fields and truncates long msg', () => {
  const cap = captureConsole('info');
  try {
    const long = 'x'.repeat(2048);
    logAt('info', 'prefix', long);
  } finally {
    cap.restore();
  }
  const calls = cap.getCalls();
  assert.equal(calls.length >= 1, true, 'expected at least one console.info call');
  // JSON-only path emits a single JSON string line
  const line = calls[calls.length - 1][0];
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (e) {
    assert.fail('log line is not valid JSON: ' + String(line));
  }
  assert.equal(typeof entry.ts, 'string');
  assert.equal(entry.lvl, 'INFO');
  assert.equal(typeof entry.msg, 'string');
  // Ensure truncation marker present and msg byte length within configured cap
  assert.ok(entry.msg.includes('[TRUNCATED]'), 'message should include truncation marker');
  const msgBytes = Buffer.byteLength(entry.msg, 'utf8');
  assert.ok(msgBytes <= 64, `message bytes should be <= 64, got ${msgBytes}`);
});

test('logger: Bearer token is redacted in JSON message', () => {
  const cap = captureConsole('warn');
  try {
    logAt('warn', 'Authorization: bearer super.secret.token==');
  } finally {
    cap.restore();
  }
  const calls = cap.getCalls();
  assert.equal(calls.length >= 1, true, 'expected at least one console.warn call');
  const line = calls[calls.length - 1][0];
  let entry;
  try {
    entry = JSON.parse(line);
  } catch (e) {
    assert.fail('log line is not valid JSON: ' + String(line));
  }
  assert.equal(entry.lvl, 'WARN');
  assert.ok(!/bearer\s+super\.secret\.token/i.test(entry.msg), 'raw bearer token must not appear');
  assert.ok(/Bearer \[REDACTED\]/.test(entry.msg), 'redacted placeholder should appear');
});
