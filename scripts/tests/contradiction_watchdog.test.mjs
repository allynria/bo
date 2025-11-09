import test from 'node:test';
import assert from 'node:assert/strict';
import { runWatchdog } from '../memory/contradiction_watchdog.mjs';
import { setState, clearAll } from '../memory/world_state_store.mjs';

test('locked door: "open the door" flags contradiction with noun overlap', async () => {
  process.env.WATCHDOG_ENABLED = '1';
  process.env.WATCHDOG_COOLDOWN_MS = '0';
  process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';
  const conv = 't1';
  clearAll(conv);
  setState(conv, 'door', 'locked');
  const { hints, flags } = runWatchdog({ convId: conv, userText: 'I open the door quietly.' });
  assert.ok(Array.isArray(flags));
  assert.ok(flags.length >= 1);
  assert.equal(flags[0].severity, 'hard');
});

test('locked door: unlocking cancels contradiction', async () => {
  process.env.WATCHDOG_ENABLED = '1';
  process.env.WATCHDOG_COOLDOWN_MS = '0';
  process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';
  const conv = 't2';
  clearAll(conv);
  setState(conv, 'door', 'locked');
  const { hints, flags } = runWatchdog({
    convId: conv,
    userText: 'I unlock the door and open it.',
  });
  assert.equal(flags.length, 0);
  assert.equal(hints.length, 0);
});

test('locked door: "walk through the door" flags contradiction', async () => {
  process.env.WATCHDOG_ENABLED = '1';
  process.env.WATCHDOG_COOLDOWN_MS = '0';
  process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';
  const conv = 't3';
  clearAll(conv);
  setState(conv, 'door', 'locked');
  const { flags } = runWatchdog({
    convId: conv,
    userText: 'I walk through the door into the hall.',
  });
  assert.ok(flags.length >= 1);
});

test('locked door: noun mismatch avoids false positive', async () => {
  process.env.WATCHDOG_ENABLED = '1';
  process.env.WATCHDOG_COOLDOWN_MS = '0';
  process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';
  const conv = 't4';
  clearAll(conv);
  setState(conv, 'door', 'locked');
  const { flags } = runWatchdog({ convId: conv, userText: 'I open the window to get fresh air.' });
  assert.equal(flags.length, 0);
});

test('locked gate: synonyms covered', async () => {
  process.env.WATCHDOG_ENABLED = '1';
  process.env.WATCHDOG_COOLDOWN_MS = '0';
  process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';
  const conv = 't5';
  clearAll(conv);
  setState(conv, 'gate', 'locked');
  const { flags } = runWatchdog({
    convId: conv,
    userText: 'We step through the gate into the courtyard.',
  });
  assert.ok(flags.length >= 1);
});

test('locked hatch: push open detected', async () => {
  process.env.WATCHDOG_ENABLED = '1';
  process.env.WATCHDOG_COOLDOWN_MS = '0';
  process.env.WATCHDOG_HARD_RULES = 'locked,dead,broken,missing,destroyed';
  const conv = 't6';
  clearAll(conv);
  setState(conv, 'hatch', 'locked');
  const { flags } = runWatchdog({
    convId: conv,
    userText: 'I push the hatch open and climb down.',
  });
  assert.ok(flags.length >= 1);
});
