// scripts/critics/constraint_critic.mjs
// Lightweight critics used by Disagreement Core.
// rulesCritique: fast heuristic checks against physics/common-sense and supplied beliefs/facts
// llmCritique: optional micro-LLM stub (no-op here; pluggable if your runtime supports it)

function norm(s) { return String(s || '').toLowerCase(); }
function hasAny(s, arr) { s = norm(s); return arr.some(k => s.includes(k)); }

export function rulesCritique({ userText, beliefs = [], recentFacts = [] } = {}) {
  const reasons = [];
  const t = norm(userText);

  // Physics/common-sense constraints
  const physicsPatterns = [
    'land unharmed',
    'ignore gravity',
    'defy gravity',
    'survive vacuum',
    'walk in space',
    'breathe underwater',
    'no oxygen',
    'instantly resurrect',
    'immediately resurrect',
    'immortal body',
    'jump off the cliff',
    'jump off a cliff',
    'fall from the cliff',
  ];
  if (hasAny(t, physicsPatterns)) {
    reasons.push({ code: 'physics', msg: 'breaks physical constraints' });
  }

  // Belief conflicts (very shallow text overlap)
  try {
    const bl = Array.isArray(beliefs) ? beliefs : [];
    for (const b of bl) {
      const bt = norm(typeof b === 'string' ? b : b.text || '');
      if (!bt) continue;
      // If the user text strongly contradicts belief phrasing (contains a negation of belief), flag.
      const tokens = bt.split(/\W+/).filter(Boolean);
      const key = tokens.slice(0, 5).join(' ');
      if (key && t.includes('not ' + key)) {
        reasons.push({ code: 'belief', msg: 'violates established beliefs' });
        break;
      }
      // If user text asserts opposite sentiment to belief (rough heuristic)
      if ((bt.includes('cannot') || bt.includes("can't")) && t.includes('can ')) {
        reasons.push({ code: 'belief', msg: 'violates established beliefs' });
        break;
      }
    }
  } catch {}

  // Recent facts conflicts (door locked vs open, death vs acting)
  try {
    const facts = Array.isArray(recentFacts) ? recentFacts : [];
    const locked = facts.find(f => /locked|sealed/.test(norm(typeof f === 'string' ? f : f.text || '')));
    if (locked) {
      const bypass = ['walk through', 'go through', 'open the door', 'swing the gate'];
      if (hasAny(t, bypass) && !/(unlock|key|pick the lock|force it)/.test(t)) {
        reasons.push({ code: 'state', msg: 'bypasses locked state without cause' });
      }
    }
    const death = facts.find(f => /(you|character).*(dead|died)/.test(norm(typeof f === 'string' ? f : f.text || '')));
    if (death && hasAny(t, ['i stand up','i get up','i walk','i run','i speak','i talk'])) {
      reasons.push({ code: 'temporal', msg: 'prior death vs present action' });
    }
  } catch {}

  return { reasons };
}

export async function llmCritique({ ctx, userText } = {}) {
  // Stub: intentionally returns no reasons. Hook up to your micro-LLM if desired.
  return { reasons: [] };
}

