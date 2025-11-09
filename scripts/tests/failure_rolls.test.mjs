import test from 'node:test';
import assert from 'node:assert/strict';
import { computeRiskScore, decideRoll, extractRiskHints } from '../memory/failure_rolls.mjs';

test('risk score reacts to trust/suspicion/tension', () => {
  const base = computeRiskScore({ userText: 'I sneak past', spine:{trust:0.9, suspicion:0.1}, world:{tension:0.2}, beliefsHit:false, riskHints:['sneak'] }, { FAILURE_BASE_PCT:35, FAILURE_NOISE_PCT:0 });
  const hot  = computeRiskScore({ userText: 'I sneak past', spine:{trust:0.1, suspicion:0.9}, world:{tension:0.9}, beliefsHit:true, riskHints:['sneak'] }, { FAILURE_BASE_PCT:35, FAILURE_NOISE_PCT:0 });
  assert.ok(hot > base, `hot=${hot} should be > base=${base}`);
});

test('decideRoll determinism with seed', () => {
  const r1 = decideRoll(50, 'convA');
  const r2 = decideRoll(50, 'convA');
  assert.equal(r1.roll, r2.roll);
});

test('extractRiskHints finds intents', () => {
  const hits = extractRiskHints('I try to pickpocket then climb the wall and attack');
  assert.ok(hits.length >= 2);
});

