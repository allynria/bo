// Pinned facts per conversation, with bounded size, dedupe and consolidation.
// Facts are tiny strings (~1 sentence). We store weight & lastSeen for consolidation.
// Fact shape (+new fields):
// { id, text, weight, score?, salience?, tags?:[], lastSeen, agent_id?, arc_tags?:string[] }
//
// ENV:
//   FACTS_MAX           (default 64)
//   FACTS_PRUNE_TO      (default 56)
//   FACTS_MERGE_SIM     (default 0.82)   // trigram Jaccard threshold
//   FACTS_MIN_LEN       (default 12)     // ignore super short noise
//
// METRICS (service wires counters):
//   facts_dropped_total{reason}
//   facts_merged_total

import { getEffectiveConfig } from '../../monolith.js';

const STO = new Map(); // convId -> [{id,text,weight,lastSeen}]

function readCfg(name, def) {
  try {
    const C = getEffectiveConfig() || {};
    const factsCfg = C.facts || {};
    // Prefer explicit env override
    const envVal = process?.env?.[name];
    if (envVal != null && envVal !== '') {
      const n = Number(envVal);
      return Number.isFinite(n) ? n : def;
    }
    // Map monolith CONFIG fields to local knobs if present
    const map = {
      FACTS_MAX: factsCfg.max,
      FACTS_PRUNE_TO: factsCfg.pruneTo,
      FACTS_MERGE_SIM: factsCfg.mergeSim,
      FACTS_MIN_LEN: factsCfg.minLen
    };
    const v = map[name];
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  } catch {
    const n = Number(process?.env?.[name]);
    return Number.isFinite(n) ? n : def;
  }
}

export function listFacts(convId) {
  return (STO.get(convId) || []).slice();
}
export function addFact(convId, text, { weight = 1 } = {}) {
  // Legacy: return only the id for compatibility
  const { id } = addFactWithStats(convId, text, { weight });
  return id;
}
export function addFactWithStats(convId, text, { weight = 1, agent_id, arc_tags } = {}) {
  text = normalize(text);
  const arr = ensure(convId);
  if (!text) return { id: null, merged: false, dropped: 0, total: arr.length };
  // normalize optional fields
  const agentId = agent_id != null ? String(agent_id) : undefined;
  const arcTagsArr = arc_tags != null
    ? (Array.isArray(arc_tags) ? arc_tags.map(x => String(x)) : [String(arc_tags)])
    : undefined;
  // Try merge into an existing similar fact
  let best = -1, bestSim = 0;
  for (let i=0;i<arr.length;i++) {
    const s = sim(arr[i].text, text);
    if (s > bestSim) { best = i; bestSim = s; }
  }
  const MERGE_SIM = readCfg('FACTS_MERGE_SIM', 0.82);
  if (best >= 0 && bestSim >= MERGE_SIM) {
    arr[best].text = consolidate(arr[best].text, text);
    arr[best].weight = Math.min(arr[best].weight + weight, 99);
    arr[best].lastSeen = Date.now();
    return { id: arr[best].id, merged: true, dropped: 0, total: arr.length };
  }
  const rng = () => (globalThis.__RNG__ ? globalThis.__RNG__() : Math.random());
  const id = `f${Date.now().toString(36)}${rng().toString(36).slice(2,6)}`;
  const base = { id, text, weight, lastSeen: Date.now() };
  if (agentId !== undefined) base.agent_id = agentId;
  if (arcTagsArr !== undefined) base.arc_tags = arcTagsArr;
  arr.push(base);
  const dropped = enforceBound(convId, arr) || 0;
  return { id, merged: false, dropped, total: arr.length };
}
export function deleteFact(convId, id) {
  const arr = ensure(convId);
  const i = arr.findIndex(x => x.id === String(id));
  if (i >= 0) { arr.splice(i,1); return true; }
  return false;
}
export function updateFact(convId, id, text, { weight, agent_id, arc_tags } = {}) {
  const arr = ensure(convId);
  const i = arr.findIndex(x => x.id === String(id));
  if (i < 0) return false;
  text = normalize(text);
  if (!text) return false;
  arr[i].text = text;
  if (typeof weight === 'number' && Number.isFinite(weight)) {
    arr[i].weight = Math.max(0, Math.min(99, Number(weight)));
  }
  if (agent_id != null) arr[i].agent_id = String(agent_id);
  if (arc_tags != null) {
    arr[i].arc_tags = Array.isArray(arc_tags) ? arc_tags.map(x => String(x)) : [String(arc_tags)];
  }
  arr[i].lastSeen = Date.now();
  return true;
}
export function consolidateAll(convId) {
  const { total } = consolidateAllWithStats(convId) || { total: listFacts(convId).length };
  return total;
}
export function consolidateAllWithStats(convId) {
  const arr = ensure(convId);
  let mergedCount = 0;
  // n^2 small; bounded store
  for (let i=0;i<arr.length;i++) for (let j=i+1;j<arr.length;j++) {
    const s = sim(arr[i].text, arr[j].text);
    const MERGE_SIM = readCfg('FACTS_MERGE_SIM', 0.82);
    if (s >= MERGE_SIM) {
      arr[i].text = consolidate(arr[i].text, arr[j].text);
      arr[i].weight = Math.min(arr[i].weight + arr[j].weight, 99);
      arr[i].lastSeen = Math.max(arr[i].lastSeen, arr[j].lastSeen);
      arr.splice(j,1); j--; // merged
      mergedCount++;
    }
  }
  const dropped = enforceBound(convId, arr) || 0;
  return { total: arr.length, merged: mergedCount, dropped };
}

// Upsert a fact object with normalization of new fields
export function putFact(convId, fact) {
  const f = { ...fact };
  if (f.agent_id != null) f.agent_id = String(f.agent_id);
  if (f.arc_tags != null) {
    f.arc_tags = Array.isArray(f.arc_tags) ? f.arc_tags.map(x => String(x)) : [String(f.arc_tags)];
  }
  const arr = ensure(convId);
  const now = Date.now();
  if (f.id) {
    const idx = arr.findIndex(x => x.id === String(f.id));
    if (idx >= 0) {
      const textNorm = f.text != null ? normalize(f.text) : arr[idx].text;
      arr[idx] = { ...arr[idx], ...f, text: textNorm, lastSeen: now };
      return { id: arr[idx].id, merged: false, dropped: 0, total: arr.length };
    }
  }
  const res = addFactWithStats(convId, f.text, { weight: f.weight ?? 1, agent_id: f.agent_id, arc_tags: f.arc_tags });
  const idx = arr.findIndex(x => x.id === res.id);
  if (idx >= 0) {
    // preserve normalized text and timestamps
    arr[idx] = { ...arr[idx], ...f, id: res.id, text: arr[idx].text, lastSeen: arr[idx].lastSeen };
  }
  return res;
}

// --- internals ---
function ensure(convId) {
  let v = STO.get(convId);
  if (!v) { v = []; STO.set(convId, v); }
  return v;
}
function enforceBound(convId, arr) {
  const MAX = readCfg('FACTS_MAX', 64);
  const KEEP = readCfg('FACTS_PRUNE_TO', 56);
  if (arr.length <= MAX) return;
  // Drop lowest (weight, then oldest)
  arr.sort((a,b) => a.weight - b.weight || a.lastSeen - b.lastSeen);
  const drop = arr.length - KEEP;
  arr.splice(0, drop);
  // service.js will emit metrics via exported counters; here we just return
  return drop;
}
function normalize(s) {
  s = String(s||'').replace(/\s+/g,' ').trim();
  const MIN = readCfg('FACTS_MIN_LEN', 12);
  if (s.length < MIN) return '';
  return s;
}
function consolidate(a,b) {
  // Prefer longer; if different, join with " / " (keeps compact)
  if (a.toLowerCase() === b.toLowerCase()) return a;
  return a.length >= b.length ? a : b;
}
function trigrams(s) {
  s = ' ' + s.toLowerCase() + ' ';
  const t = new Set();
  for (let i=0;i<s.length-2;i++) t.add(s.slice(i, i+3));
  return t;
}
function sim(a,b) {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter || 1);
}
