import { listBeliefs, topBeliefs } from './beliefs_store.mjs';

const cooldownMs = Number(process.env.BELIEFS_HASH_PHRASE_COOLDOWN_MS || 15*60*1000);
const MAX_INJECT = Number(process.env.BELIEFS_INJECT_MAX || 3);

// conversationId -> Map(beliefId -> lastInjectedAt)
const LAST = new Map();

function shouldInjectOnce(convId, beliefId) {
  if (!cooldownMs) return true;
  if (!LAST.has(convId)) LAST.set(convId, new Map());
  const m = LAST.get(convId);
  const last = m.get(beliefId) || 0;
  const ok = Date.now() - last >= cooldownMs;
  if (ok) m.set(beliefId, Date.now());
  return ok;
}

// very shallow contradiction check: exact/negated keyword hit against belief text
export function detectContradictions(userText, beliefs) {
  const t = (userText || '').toLowerCase();
  if (!t) return [];
  const hits = [];
  for (const b of beliefs) {
    const key = b.text.toLowerCase();
    // stupid-simple heuristics; you can swap this with an embed/LLM check later
    const contradicts =
      (t.includes('undo ') && key.includes('cannot')) ||
      (t.includes('resurrect') && key.includes('cannot resurrect')) ||
      (t.includes('ignore') && key.includes('never')) ||
      (t.includes('break') && key.includes('unbreakable')) ||
      (t.includes('kill the innocent') && key.includes('kill innocents')) ||
      (t.includes('fly off cliff') && key.includes('gravity')) ||
      t.includes(key); // loose match — tweak as needed

    if (contradicts) hits.push(b);
  }
  return hits;
}

export function craftBeliefBoosters({ convId, charId='default', userText }) {
  if (!process.env.BELIEFS_ENABLED) return { boosters: [], conflicts: [] };
  const all = listBeliefs(charId);
  if (!all.length) return { boosters: [], conflicts: [] };

  const conflicts = detectContradictions(userText, all);
  const prioritized = (conflicts.length ? conflicts : topBeliefs(charId, MAX_INJECT))
    .filter(Boolean)
    .slice(0, MAX_INJECT)
    .filter(b => shouldInjectOnce(convId, b.id));

  const boosters = prioritized.map(b => ({
    type: 'belief',
    belief_id: b.id,
    text: `(She holds this as bedrock truth: ${b.text}.)`
  }));

  return { boosters, conflicts };
}

