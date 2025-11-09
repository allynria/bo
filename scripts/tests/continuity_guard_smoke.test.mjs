import assert from 'node:assert/strict';
import { setGuardHint, getGuardHint, consumeGuardHint, generateGuardOneLiner } from '../memory/guardrail.mjs';
import { shadowIngest } from '../memory/shadow.mjs';

const convId = 'guard-smoke';
await shadowIngest({ convId, turn:0, role:'user', text:'We promised never to lie at Black Harbor.' });
await shadowIngest({ convId, turn:0, role:'bot',  text:'She fears open water.' });

const hint = await generateGuardOneLiner({ convId, pov:'she', maxChars: 160 });
assert.ok(hint && hint.length <= 160, 'one-liner generated');

setGuardHint(convId, hint, { ttlTurns: 2 });
assert.ok(getGuardHint(convId)?.text, 'hint stored');

const injected = consumeGuardHint(convId);
assert.ok(injected && injected.includes('She') || injected.includes('she'), 'hint consumed once');
// Still one turn left:
assert.ok(getGuardHint(convId), 'hint remains for another turn');
