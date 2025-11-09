import assert from 'node:assert/strict';
import { judgeContinuity } from '../memory/judge.mjs';
import { shadowIngest } from '../memory/shadow.mjs';

const convId = 'judge-smoke';
await shadowIngest({
  convId,
  turn: 0,
  role: 'user',
  text: 'I am afraid of open water and we promised to stay together.',
});
await shadowIngest({ convId, turn: 0, role: 'bot', text: 'Noted. We are at Black Harbor.' });

const res1 = await judgeContinuity({
  convId,
  replyText: 'We keep our promise. The harbor wind is cold.',
});
assert.ok(res1.overall > 0.55, 'expected decent continuity on keep+setting');

const res2 = await judgeContinuity({ convId, replyText: 'I love open water. I break my promise.' });
assert.ok(res2.overall < 0.6, 'expected lower continuity on fear/promise violation');
