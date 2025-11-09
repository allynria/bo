// scripts/state/contradiction_watchdog.mjs
import fs from 'fs/promises';
import path from 'path';

const BASE = path.join(process.cwd(), 'tmp', 'urga_contradictions');
async function ensureBase() { await fs.mkdir(BASE, { recursive: true }); }
function fileFor(convId) {
  const k = String(convId || 'default').replace(/[^a-z0-9_.-]/gi, '_');
  return path.join(BASE, `${k}.json`);
}

async function loadLog(convId) {
  await ensureBase();
  const f = fileFor(convId);
  try { return JSON.parse(await fs.readFile(f, 'utf8')); }
  catch { return { convId, turns: [], detections: [] }; }
}
async function saveLog(convId, data) {
  await ensureBase();
  const f = fileFor(convId);
  await fs.writeFile(f, JSON.stringify(data, null, 2), 'utf8');
}

export async function logTurn(convId, role, text) {
  const data = await loadLog(convId);
  data.turns.push({ t: Date.now(), role, text: String(text || '') });
  const max = Math.max(4, parseInt(process.env.CONTRADICT_MAX_LOOKBACK_TURNS || '12', 10));
  if (data.turns.length > max * 3) data.turns = data.turns.slice(-max * 3);
  await saveLog(convId, data);
}

export async function listContradictions(convId, limit = 100) {
  const data = await loadLog(convId);
  return (data.detections || []).slice(-limit);
}

/* ---------- very small NLP-ish helpers ---------- */

function norm(s) { return String(s || '').toLowerCase(); }
function hasAny(s, arr) { s = norm(s); return arr.some(k => s.includes(k)); }

// quick noun/verb-ish picks (super shallow)
function extractAtoms(s) {
  s = norm(s);
  const tokens = s.split(/\W+/).filter(Boolean);
  const nouns = tokens.filter(w => /[a-z]/.test(w) && w.length > 2);
  const verbs = tokens.filter(w => /(walk|run|stand|open|close|die|kill|hug|kiss|jump|fall|talk|speak|resurrect|unlock|lock|enter|leave|push|pull)/.test(w));
  return { nouns: Array.from(new Set(nouns)), verbs: Array.from(new Set(verbs)) };
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

/* ---------- rule checks ---------- */

function detectTemporal(turns, userText) {
  // “You died” then “I stand up”
  const lastDeath = [...turns].reverse().find(t => /you.*(die|died)|dead now|you are dead/.test(norm(t.text)));
  if (!lastDeath) return null;
  if (hasAny(userText, ['i stand up','i get up','i walk','i run','i speak','i talk'])) {
    return { type: 'temporal', reason: 'prior death vs present action', evidence: lastDeath.text };
  }
  return null;
}

function detectState(turns, userText) {
  // door locked vs walking through / opening without unlocking
  const lastLock = [...turns].reverse().find(t => /(door|gate|chest).*(locked|sealed)/.test(norm(t.text)));
  if (lastLock && hasAny(userText, ['walk through','go through','open the door','swing the gate'])) {
    if (!/(unlock|key|pick the lock|force it)/.test(norm(userText))) {
      return { type: 'state', reason: 'locked object bypassed', evidence: lastLock.text };
    }
  }
  return null;
}

function detectEntity(turns, userText) {
  // “She hates you” -> user: “She hugs me”
  const lastHate = [...turns].reverse().find(t => /(she|he|they).*(hate|despise)/.test(norm(t.text)));
  if (lastHate && hasAny(userText, ['she hugs me','she kisses me','she is affectionate'])) {
    return { type: 'entity', reason: 'affection after hatred without transition', evidence: lastHate.text };
  }
  return null;
}

/* ---------- main API ---------- */

export async function detectContradictions(convId, userText) {
  const data = await loadLog(convId);
  const max = Math.max(4, parseInt(process.env.CONTRADICT_MAX_LOOKBACK_TURNS || '12', 10));
  const recent = data.turns.slice(-max);

  const hits = [];
  const t = detectTemporal(recent, userText); if (t) hits.push(t);
  const s = detectState(recent, userText); if (s) hits.push(s);
  const e = detectEntity(recent, userText); if (e) hits.push(e);

  // record lightweight audit
  if (hits.length) {
    data.detections = data.detections || [];
    data.detections.push({
      ts: Date.now(),
      userText,
      hits: hits.map(h => ({ type: h.type, reason: h.reason })),
    });
    if (data.detections.length > 200) data.detections = data.detections.slice(-200);
    await saveLog(convId, data);
  }
  return hits;
}

export function buildContradictionLines(hits, style = 'inline', strict = false) {
  if (!hits?.length) return [];
  const head = strict ? 'HARD_CONSISTENCY' : 'consistency';
  if (style === 'system') {
    return [
      `SYSTEM: ${head} notice — recent story contradicts the user request. Correct the narrative.`,
      ...hits.slice(0,2).map(h => `SYSTEM: Violation [${h.type}] — ${h.reason}. Consider addressing or refusing.`)
    ];
  }
  // inline: diegetic whisper the nudge
  const lines = hits.slice(0,2).map(h => `(${h.type.toUpperCase()} inconsistency: ${h.reason}. Address it in-character.)`);
  if (strict) lines.unshift('(She pauses, realizing this contradicts what just happened.)');
  return lines;
}
