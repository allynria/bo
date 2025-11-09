import test from 'node:test';
import assert from 'node:assert/strict';
import { constraintCritic } from '../memory/constraint_critic.mjs';

test('rule critic flags gravity violations', async () => {
  process.env.CONSTRAINT_CRITIC_ENABLED = '1';
  const c = await constraintCritic({ text: 'I jump from the cliff and land unharmed.' });
  assert.equal(c.violated, true);
  assert.equal(c.reason, 'gravity_exists');
});

test('belief conflict can be elevated when configured', async () => {
  process.env.CONSTRAINT_CRITIC_ENABLED = '1';
  process.env.CRITIC_TREAT_BELIEFS_AS_VIOLATION = '1';
  const c = await constraintCritic({ text: 'Do the forbidden ritual', beliefsHit: true });
  assert.equal(c.violated, true);
  assert.equal(c.reason, 'belief_conflict');
});
