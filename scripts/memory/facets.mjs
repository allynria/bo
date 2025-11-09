import { AsyncFS } from '../../monolith.js';
import path from 'node:path';

const BASE = path.join(process.cwd(), 'tmp', 'facets');
await AsyncFS.mkdir(BASE, { recursive: true }).catch(()=>{});

// Facet shape:
// { key: 'fear', val: 'open water', strength: 0.75, lastTurn: 42, pinned: false }
// Grouped per character id.

function halfLifeDecay(strength, turns, halfLife) {
  if (halfLife <= 0) return strength;
  const lambda = Math.log(2) / halfLife; // per-turn
  const dec = Math.exp(-lambda * Math.max(0, turns));
  return Math.max(0, Math.min(1, strength * dec));
}

function fileFor(convId) {
  return path.join(BASE, encodeURIComponent(convId) + '.json');
}

export async function loadFacets(convId) {
  try {
    const buf = await AsyncFS.readFile(fileFor(convId), 'utf8');
    const j = JSON.parse(String(buf));
    return j && j.characters ? j : { characters: {} };
  } catch {
    return { characters: {} };
  }
}

export async function saveFacets(convId, data) {
  const fp = fileFor(convId);
  await AsyncFS.writeFileAtomic(fp, JSON.stringify(data), 'utf8');
}

export async function upsertFacet({ convId, turn=0, charId='bot', key, val, delta=0.25, pin=false }) {
  const half = Number(process.env.FACETS_DECAY_HALF_LIFE_TURNS || 64);
  const cap = Math.max(0.05, Math.min(1, Number(process.env.FACETS_MAX_STRENGTH || 1)));
  const data = await loadFacets(convId);
  const list = (data.characters[charId] ||= []);
  const now = Date.now();
  // try find similar facet (same key + same val, case-insensitive)
  const idx = list.findIndex(f => (f.key||'') === key && String(f.val||'').toLowerCase() === String(val||'').toLowerCase());
  if (idx >= 0) {
    const f = list[idx];
    // decay old, then add delta
    const decTurns = Math.max(0, (turn||0) - (f.lastTurn||0));
    const s = halfLifeDecay(Number(f.strength||0), decTurns, half);
    const s2 = Math.max(0, Math.min(cap, s + Number(delta||0)));
    list[idx] = { ...f, strength: s2, lastTurn: turn, pinned: pin ? true : f.pinned, updatedTs: now };
  } else {
    list.push({ key, val, strength: Math.min(cap, Number(delta||0)), lastTurn: turn, pinned: !!pin, createdTs: now, updatedTs: now });
  }
  // keep bounded
  const MAX = Math.max(8, Math.min(64, Number(process.env.FACETS_MAX_PER_CHAR || 24)));
  if (list.length > MAX) {
    // drop weakest unpinned
    list.sort((a,b)=> (b.pinned - a.pinned) || (b.strength - a.strength));
    data.characters[charId] = list.slice(0, MAX);
  }
  await saveFacets(convId, data);
  return data.characters[charId];
}

export function scoreFacetForTurn(f, nowTurn, { halfLife }) {
  const s = halfLifeDecay(Number(f.strength||0), Math.max(0, nowTurn - Number(f.lastTurn||0)), halfLife);
  // pin gives a soft boost but still decays
  return s + (f.pinned ? 0.15 : 0);
}

// Select up to k facets with diversity on (key,val) text
export function pickFacets({ list=[], nowTurn=0, k=2, temperature=0.7, alpha=0.75, halfLife=64 }) {
  if (!list.length) return [];
  // compute scores
  const scored = list.map(f => ({ f, rel: scoreFacetForTurn(f, nowTurn, { halfLife }) }));
  // diversity by Jaccard on tokens of "key: val"
  const toks = (s)=> (String(s||'').toLowerCase().match(/[a-z0-9]+/g)||[]);
  const sim = (a,b) => {
    const A = new Set(toks(`${a.key}: ${a.val}`)), B = new Set(toks(`${b.key}: ${b.val}`));
    if (!A.size && !B.size) return 0;
    let inter=0; for(const x of A) if (B.has(x)) inter++;
    return inter / (A.size + B.size - inter || 1);
  };
  const chosen = [];
  const used = new Set();
  k = Math.max(0, Math.min(k, list.length));
  for (let step=0; step<k; step++) {
    // compute MMR-ish adj score
    const adj = scored.map(({f, rel}, i) => {
      if (used.has(i)) return -1e9;
      let div=0; for (const j of chosen) div = Math.max(div, sim(scored[i].f, j.f));
      return alpha*rel - (1-alpha)*div;
    });
    // softmax pick at temperature
    const T = Math.max(0.05, Number(temperature)||0.7);
    const exps = adj.map(x => Math.exp(x / T));
    const Z = exps.reduce((a,b)=>a+b,0) || 1;
    const rng = () => (globalThis.__RNG__ ? globalThis.__RNG__() : Math.random());
    let r = rng()*Z, pick=0;
    for (let i=0;i<adj.length;i++){ r -= exps[i]; if (r<=0){ pick=i; break; } }
    used.add(pick); chosen.push(scored[pick]);
  }
  return chosen.map(x => x.f);
}

export function facetToNarrative(f, who='they') {
  const k = (f.key||'trait').toLowerCase();
  const v = String(f.val||'').trim();
  if (!v) return '';
  switch (k) {
    case 'fear': return `(${who} still dreaded ${v}.)`;
    case 'bond': return `(${who} felt the bond: ${v}.)`;
    case 'goal': return `(${who} held to a goal: ${v}.)`;
    case 'scar': return `(${who} touched the old scar — ${v}.)`;
    case 'secret': return `(${who} kept a secret: ${v}.)`;
    default: return `(${who} remembered ${k}: ${v}.)`;
  }
}
