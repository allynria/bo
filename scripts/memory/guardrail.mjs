// Lightweight in-memory guard-hint store keyed by convId.
// Hints are short in-character recaps injected on the NEXT turn.
// TTL is tracked in "turns" by a simple decrement-on-use strategy.

import { shadowSnapshot } from './shadow.mjs';
import { loadFacets } from './facets.mjs';

const HINTS = new Map(); // convId -> { text, turnsLeft, ts }

export function setGuardHint(convId, text, { ttlTurns = 2 } = {}) {
  if (!convId || !text) return;
  HINTS.set(convId, { text: String(text), turnsLeft: Math.max(1, Number(ttlTurns)||1), ts: Date.now() });
}

export function getGuardHint(convId) {
  const v = HINTS.get(convId);
  if (!v) return null;
  return v;
}

export function consumeGuardHint(convId) {
  const v = HINTS.get(convId);
  if (!v) return null;
  v.turnsLeft -= 1;
  if (v.turnsLeft <= 0) HINTS.delete(convId);
  else HINTS.set(convId, v);
  return v.text;
}

export function clearGuardHint(convId) {
  HINTS.delete(convId);
}

// --- One-liner generator (no OOC). ---
// Produces a gentle narrative/inner-thought recap that references a recent fact/feeling/setting.
export async function generateGuardOneLiner({ convId, pov = 'she', maxChars = 180 }) {
  const snap = await shadowSnapshot(convId);
  const { facets=[] } = await loadFacets({ convId, topK: 2 });
  const turns = Array.isArray(snap?.turns) ? snap.turns.slice(-6) : [];

  // Pick a small number of salient cues
  const facts = Array.isArray(snap?.facts) ? snap.facts : [];
  const location = facts.find(f => f.type==='location')?.val;
  const promise  = facts.find(f => f.type==='promise')?.val;
  const trigger  = facts.find(f => f.type==='trigger')?.val;
  const lastUser = [...turns].reverse().find(t=>t.role==='user')?.text || '';

  // Small synthesizer with graceful priorities
  let parts = [];
  if (promise) parts.push(`the promise`);
  if (trigger) parts.push(trigger.toLowerCase());
  if (location) parts.push(location.toLowerCase());
  const cue = parts.slice(0,2).join(' and ');

  // Pull a facet for color
  const facet = facets[0]?.trait || facets[0]?.memory || facets[0]?.desc || '';

  // Narrative templates (kept tiny; zero OOC)
  const candidates = [
    `${capitalize(pov)} still carried ${cue || 'the weight of last night'}.`,
    `${capitalize(pov)} remembered ${cue || 'the way everything changed'}.`,
    `A small echo lingered — ${cue || 'unspoken vows and old fears'}.`,
    `${capitalize(pov)}’s thoughts snagged on ${cue || 'what wasn’t said'}.`
  ];

  // Pick shortest that fits + add facet flavor if available
  let line = candidates.sort((a,b)=>a.length-b.length)[0];
  if (facet && line.length + facet.length + 2 < maxChars) {
    line = `${line} ${facetToClause(facet)}`;
  }
  // If nothing resolved, fall back to last user hint
  if (!line && lastUser) line = `${capitalize(pov)} replayed those words in silence.`;
  return trimTo(line || `A faint memory surfaced.`, maxChars);
}

function facetToClause(f) {
  const s = String(f).trim();
  if (!s) return '';
  return s.endsWith('.') ? s : `${s}.`;
}

function trimTo(s, n) {
  s = String(s||'');
  return s.length <= n ? s : s.slice(0, Math.max(0, n-1)).trimEnd() + '…';
}

function capitalize(s) {
  s = String(s||'');
  return s ? s[0].toUpperCase()+s.slice(1) : s;
}

