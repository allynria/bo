import assert from 'node:assert/strict';
import { selectWithDiversity } from '../memory/selector.mjs';

const items = [
  { txt: 'apple orchard at dusk', imp: 1.0 },
  { txt: 'apple orchard near river', imp: 0.9 },
  { txt: 'iron bridge under moon', imp: 0.95 },
  { txt: 'seaside cliff and storm', imp: 0.8 },
  { txt: 'old promise at the bridge', imp: 0.7 },
];

const pickedCold = selectWithDiversity(items, { k: 3, alpha: 0.6, temperature: 0.3 });
const pickedHot  = selectWithDiversity(items, { k: 3, alpha: 0.6, temperature: 1.2 });

assert.ok(pickedCold.length === 3 && pickedHot.length === 3);
// Cheap check: diversity should avoid picking both apple orchard items together frequently.
const hasTwoApples = (arr) => arr.filter(x => (x.txt||'').includes('apple')).length >= 2;
// With diversity, the probability of both apple* being present is low; assert at least one run avoids it.
assert.ok(!hasTwoApples(pickedCold), 'diversity failed to separate similar items');
