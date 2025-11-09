import { upsertBeliefs, loadBeliefs } from './state/beliefs_store.mjs';

const convId = process.env.CONV_ID || 'demo';
const beliefs = ['Magic cannot resurrect the dead', 'The Old Harbor Library closes at dusk'];
const constraints = ['Keys cannot pass through solid locks without mechanisms'];
const disallowed = ['Pickpocketing priests inside sanctuaries'];

await upsertBeliefs(convId, {
  beliefs,
  logic_constraints: constraints,
  disallowed_actions: disallowed,
});

const after = await loadBeliefs(convId);
console.log('Seeded state beliefs for', convId, JSON.stringify(after, null, 2));
