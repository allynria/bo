import assert from 'node:assert/strict';
import { indexTurn } from '../memory/transcript.mjs';
import {
  summarizeWindow,
  stageBooster,
  listBoosters,
  consumeOne,
  makeBoosterId,
} from '../memory/booster.mjs';

const cid = 'booster-recall';
for (let i = 1; i <= 50; i++) {
  indexTurn({
    convId: cid,
    role: i % 2 ? 'user' : 'bot',
    text: `msg ${i} — ${i % 5 === 0 ? 'confession: i care' : ''}`,
  });
}
const anchor = 30;
const recap = summarizeWindow({
  convId: cid,
  anchor,
  before: 20,
  after: 20,
  pov: 'she',
  maxChars: 400,
});
assert.ok(recap && recap.length <= 400, 'recap length capped');
stageBooster({
  convId: cid,
  id: makeBoosterId(anchor),
  anchor,
  range: [anchor - 20, anchor + 20],
  text: recap,
  ttlTurns: 2,
});
const list = listBoosters(cid);
assert.ok(list.length === 1 && list[0].anchor === anchor, 'booster staged');
const injected1 = consumeOne(cid);
assert.ok(injected1 && injected1.includes('recalled'), 'first consume ok');
const injected2 = consumeOne(cid);
assert.ok(injected2, 'second consume ok (ttl 2)');
const injected3 = consumeOne(cid);
assert.equal(injected3, null, 'ttl exhausted');
