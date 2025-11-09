// Extended redaction corpus: emails, phone numbers, cookies, API keys, JWTs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Initialize production JSON logger before import
process.env.NODE_ENV = 'production';
process.env.LOG_JSON = '1';
process.env.LOG_LEVEL = 'INFO';

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
    getLastJson() {
      const arr = calls.map((a) => a.map((x) => String(x)));
      const line = arr.length ? arr[arr.length - 1][0] : '';
      let entry = {};
      try {
        entry = JSON.parse(line);
      } catch {
        /* ignore */
      }
      return entry;
    },
  };
}

test('redaction: email addresses are replaced', () => {
  const cap = captureConsole('info');
  try {
    logAt('info', 'contact john.doe+test@example.com today');
  } finally {
    cap.restore();
  }
  const entry = cap.getLastJson();
  assert.equal(entry.lvl, 'INFO');
  assert.ok(!/john\.doe\+test@example\.com/i.test(entry.msg));
  assert.ok(/\[EMAIL\]/.test(entry.msg));
});

test('redaction: US phone numbers are replaced', () => {
  const cap = captureConsole('warn');
  try {
    logAt('warn', 'call (415) 555-1234 or 415-555-5678');
  } finally {
    cap.restore();
  }
  const entry = cap.getLastJson();
  assert.equal(entry.lvl, 'WARN');
  assert.ok(!/415\) 555-1234|415-555-5678/.test(entry.msg));
  assert.ok(/\[PHONE\]/.test(entry.msg));
});

test('redaction: cookies and API keys are redacted', () => {
  const cap = captureConsole('warn');
  try {
    logAt('warn', 'Cookie: session=abc123; Path=/');
    logAt('warn', 'x-api-key: supersecret==');
  } finally {
    cap.restore();
  }
  const entry = cap.getLastJson();
  assert.equal(entry.lvl, 'WARN');
  assert.ok(/\[REDACTED\]/.test(entry.msg) || /\[REDACTED\]/.test(String(entry.error || '')));
});

test('redaction: JWT-like strings are replaced', () => {
  const cap = captureConsole('error');
  try {
    logAt('error', 'token: abc.def.ghi');
  } finally {
    cap.restore();
  }
  const entry = cap.getLastJson();
  assert.equal(entry.lvl, 'ERROR');
  assert.ok(!/abc\.def\.ghi/.test(entry.msg));
  assert.ok(/\[JWT\]/.test(entry.msg));
});
