/**
 * PhraseDecay: per-conv map of normalized phrase -> decayed score.
 * Each hit increases score; scores decay exponentially with half-life.
 */
const STORE = new Map(); // convId -> { phrase -> {score, last} }

function now(){ return Date.now(); }
function norm(s){ return String(s||'').toLowerCase().replace(/\s+/g,' ').trim(); }

export function getPhraseCfg(){
  return {
    enabled: process.env.PHRASE_DECAY_ENABLED === '1',
    halfLife: Number(process.env.PHRASE_DECAY_HALF_LIFE_MS || 15*60*1000),
    maxScore: Number(process.env.PHRASE_MAX_SCORE || 3.0),
    seeds: String(process.env.PHRASE_LIST||'').split(';').map(norm).filter(Boolean)
  };
}

function getConv(convId){
  const k = String(convId||''); if (!STORE.has(k)) STORE.set(k, new Map());
  return STORE.get(k);
}
function decay(v, tNow, halfLife){
  if (!v) return 0;
  const dt = Math.max(0, tNow - (v.last||tNow));
  const lambda = Math.LN2 / Math.max(1, halfLife);
  return v.score * Math.exp(-lambda * dt);
}

export function observeReply(convId, text, cfg=getPhraseCfg()){
  if (!cfg.enabled) return { hits:[] };
  const m = getConv(convId), t = now();
  const hits = [];
  const content = norm(text);
  // Initialize seed phrases
  for (const s of cfg.seeds){ if (!m.has(s)) m.set(s, {score:0,last:t}); }
  for (const [p, v] of m.entries()){
    const newScore = decay(v, t, cfg.halfLife) + (content.includes(p) ? 1 : 0);
    v.score = newScore; v.last = t; m.set(p, v);
    if (content.includes(p)) hits.push({ phrase:p, score:v.score });
  }
  return { hits };
}

export function getPenalties(convId, cfg=getPhraseCfg()){
  if (!cfg.enabled) return { penaltyHints:[] };
  const m = getConv(convId), t = now();
  const penaltyHints = [];
  for (const [p, v] of m.entries()){
    const val = decay(v, t, cfg.halfLife);
    if (val >= cfg.maxScore) {
      penaltyHints.push(`(AVOID) Refrain from overused phrase "${p}". Use a fresh, specific alternative.`);
    }
  }
  return { penaltyHints };
}

