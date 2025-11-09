import assert from 'node:assert/strict';
import { detectMismatches, extractFacts } from '../memory/shadow.mjs';

// Unit-ish: fear vs like contradiction (facts contain both fear and like on same thing)
const facts = extractFacts("I'm afraid of open water. I love open water.", {
  role: 'bot',
  turn: 1,
});
const mism = detectMismatches(facts, 'I love open water.');
assert.ok(
  mism.find((m) => m.type === 'fear_like_conflict'),
  'expected fear_like_conflict'
);

// Name conflict
const f2 = facts.concat([
  { type: 'name', who: 'bot', key: 'name', val: 'Auren', polarity: +1, turn: 2, ts: Date.now() },
]);
const mism2 = detectMismatches(f2, 'call me Lyris.');
assert.ok(
  mism2.find((m) => m.type === 'name_conflict'),
  'expected name_conflict'
);
