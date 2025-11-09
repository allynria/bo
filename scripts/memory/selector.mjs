import { rng, sampled } from '../../monolith.js';

// Simple tokenization for similarity
function toks(s) { return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []); }
function setSim(a, b) {
  const A = new Set(toks(a)), B = new Set(toks(b));
  if (!A.size && !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

export function softmaxPick(scores, k, temperature = 0.8) {
  const T = Math.max(0.05, Number(temperature) || 0.8);
  const out = [];
  const idx = scores.map((s,i)=>({i,s}));
  let pool = idx.slice();
  for (let step=0; step<k && pool.length; step++) {
    const exps = pool.map(({s}) => Math.exp(s / T));
    const Z = exps.reduce((a,b)=>a+b,0) || 1;
    // Use shared PRNG for determinism when available
    let r = rng() * Z, pick = 0;
    for (let i=0;i<pool.length;i++) { r -= exps[i]; if (r <= 0) { pick = i; break; } }
    const chosenIdx = pool[pick].i;
    out.push(chosenIdx);
    sampled('debug', 0.02, `[selector] pick step=${step} idx=${chosenIdx} T=${T}`);
    pool.splice(pick,1);
  }
  return out;
}

// MMR-ish: score' = alpha*relevance - (1-alpha)*maxSimilarityToChosen
export function selectWithDiversity(items, {
  k = 6,
  importance = (it)=>Number(it.imp||1),
  recency = (it)=>Number(it.rec||0),
  baseScore = (imp, rec)=> imp + rec,
  temperature = 0.8,
  alpha = 0.75,          // relevance vs diversity trade-off
  simFn = (a,b)=>setSim(a.txt, b.txt),
  // Suppress near-duplicates: if similarity exceeds threshold vs any chosen,
  // avoid selecting the candidate to ensure basic diversity even at low temperature.
  suppressSim = 0.30,
} = {}) {
  const N = items.length;
  if (!N) return [];
  const rel = items.map(it => baseScore(importance(it), recency(it)));
  const chosen = [];
  const picked = new Set();
  while (chosen.length < Math.min(k, N)) {
    const adj = [];
    for (let i=0;i<N;i++) {
      if (picked.has(i)) { adj.push(-1e9); continue; }
      let div = 0;
      for (const j of chosen) div = Math.max(div, simFn(items[i], items[j]));
      // Hard suppression for near-duplicates to ensure separation when temperature is low
      if (div >= suppressSim) {
        adj.push(-1e9);
      } else {
        adj.push(alpha * rel[i] - (1 - alpha) * div);
      }
    }
    const order = softmaxPick(adj.map(x => isFinite(x) ? x : -1e9), 1, temperature);
    const idx = order[0];
    picked.add(idx); chosen.push(idx);
  }
  return chosen.map(i => items[i]);
}
