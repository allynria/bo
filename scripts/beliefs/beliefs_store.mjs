// Simple belief store with lightweight persistence hooks if you want to extend later.
// Shape:
//   beliefs[convId] = [
//     { by: 'elira', text: 'magic cannot resurrect the dead', weight: 1, ts: 1730..., tags: ['world'] }
//   ]

const beliefs = new Map(); // convId -> Array

export function listBeliefs(convId) {
  return (beliefs.get(convId) || []).slice();
}

export function addBelief(convId, { by = 'world', text, weight = 1, tags = [] }) {
  if (!text || !String(text).trim()) return false;
  const arr = beliefs.get(convId) || [];
  // Deduplicate: case-insensitive exact text match
  const key = norm(text);
  if (arr.some(b => norm(b.text) === key)) return false;
  arr.push({ by, text: String(text), weight: Number(weight) || 1, ts: Date.now(), tags });
  beliefs.set(convId, arr);
  return true;
}

export function removeBelief(convId, idx) {
  const arr = beliefs.get(convId);
  if (!arr || idx < 0 || idx >= arr.length) return false;
  arr.splice(idx, 1);
  return true;
}

export function clearBeliefs(convId) {
  beliefs.delete(convId);
}

// ---- Contradiction pass (fast heuristic) ----
// Returns a list of beliefs that "conflict" with userText.
// Heuristic: if userText contains verbs like "do/perform/use" tied to a noun/concept that a belief denies, or
// if userText asserts the negation of a belief (naively via substring/keyword).
export function selectContradictedBeliefs(convId, userText) {
  const utter = norm(userText || '');
  if (!utter) return [];
  const arr = beliefs.get(convId) || [];
  const conflicts = [];
  for (const b of arr) {
    const n = norm(b.text);
    // Soft signals:
    const denies = hasNegationConflict(utter, n);
    const keywordOverlap = overlap(utter, n) >= 0.42; // mild overlap threshold
    if (denies || keywordOverlap) {
      conflicts.push(b);
    }
  }
  // Sort: higher weight first, then recency
  conflicts.sort((a, b) => (b.weight - a.weight) || (b.ts - a.ts));
  return conflicts;
}

function overlap(a, b) {
  const A = new Set(a.split(/\W+/).filter(Boolean));
  const B = new Set(b.split(/\W+/).filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

function hasNegationConflict(utter, belief) {
  // naive patterns: "resurrect the dead", "undo death", "teleport", "time travel"
  // If belief contains "cannot/can't/is impossible", and utter contains an attempt verb, call it a conflict.
  const impossible = /(cannot|can't|impossible|never possible|forbidden|not allowed)/.test(belief);
  const attempt = /(try|attempt|use|cast|perform|do|force|cause|make)\b/.test(utter);
  // also if utter explicitly negates the belief: "actually we can resurrect the dead"
  const flips = /(actually|now|suddenly)\s+(can|could|will|able to)/.test(utter);
  return (impossible && attempt) || flips;
}

function norm(s) { return String(s).toLowerCase().trim(); }

