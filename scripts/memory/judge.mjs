import { shadowSnapshot } from './shadow.mjs';
import { loadFacets, pickFacets } from './facets.mjs';

// --- tiny utils ---
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const toWords = (s) =>
  String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const uniq = (arr) => Array.from(new Set(arr));
const intersect = (a, b) => a.filter((x) => b.includes(x));
const hasAny = (text, terms = []) => {
  const T = ' ' + String(text || '').toLowerCase() + ' ';
  return terms.some((t) => T.includes(' ' + String(t).toLowerCase() + ' '));
};

function nounishTokens(s) {
  // Cheap noun-ish grab: keep words >3 chars; keep proper-case words from original, too.
  const ws = toWords(s);
  return uniq(ws.filter((w) => w.length >= 4));
}

// Score helper: Jaccard overlap of noun-ish tokens between reply and recent context.
function timelineScore({ recentText, replyText }) {
  const A = nounishTokens(recentText);
  const B = nounishTokens(replyText);
  if (A.length === 0 || B.length === 0) return 0.5; // neutral
  const I = intersect(A, B).length;
  const U = uniq(A.concat(B)).length;
  const raw = U ? I / U : 0;
  // Provide a small floor when there is at least one anchor overlap
  return clamp01(I > 0 ? Math.max(0.2, raw) : raw);
}

// Persona: check if reply reflects any currently active facet keywords.
function personaScore({ facets = [], replyText }) {
  if (!facets.length) return 0.5;
  const terms = [];
  for (const f of facets) {
    // Facet store shape uses key/val
    if (f?.key) terms.push(...toWords(f.key).slice(0, 3));
    if (f?.val) terms.push(...toWords(f.val).slice(0, 3));
  }
  const reply = toWords(replyText);
  const hit = intersect(uniq(terms), uniq(reply)).length;
  // normalize by a soft cap to avoid small facet lists scoring too hot
  return clamp01(hit / Math.max(4, Math.min(12, terms.length)));
}

// Promises/Secrets/Fears continuity using shadow facts.
function promiseScore({ facts = [], replyText }) {
  if (!facts.length) return 0.5;
  const lower = String(replyText || '').toLowerCase();
  const promises = facts.filter((f) => f.type === 'promise');
  if (!promises.length) {
    // No explicit promises known; still recognize generic phrasing
    if (/\bkeep\s+(?:our|the|my)\s+promise\b/.test(lower)) return 0.72;
    if (/\b(?:break|ignore)\s+(?:our|the|my)\s+promise\b/.test(lower)) return 0.2;
    return 0.6;
  }
  let keep = 0,
    breakish = 0;
  for (const p of promises.slice(0, 5)) {
    const token = String(p.val || '')
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 3)
      .join(' ');
    if (!token) continue;
    if (lower.includes('keep') && lower.includes(token)) keep++;
    if ((lower.includes('break') || lower.includes('ignore')) && lower.includes(token)) breakish++;
  }
  // Generic phrasing support (when reply references promise without explicit token)
  if (/\bkeep\s+(?:our|the|my)\s+promise\b/.test(lower)) keep++;
  if (/\b(?:break|ignore)\s+(?:our|the|my)\s+promise\b/.test(lower)) breakish++;
  if (breakish && !keep) return 0.2;
  if (keep && !breakish) return clamp01(0.7 + 0.1 * keep);
  return 0.5;
}

function settingScore({ facts = [], replyText }) {
  const locs = facts
    .filter((f) => f.type === 'location')
    .slice(0, 3)
    .map((f) => String(f.val || '').toLowerCase());
  if (!locs.length) return 0.6;
  const reply = String(replyText || '').toLowerCase();
  let hits = 0;
  for (const l of locs) {
    if (!l) continue;
    if (reply.includes(l)) {
      hits++;
      continue;
    }
    // Partial noun token anchor (e.g., "Black Harbor" -> token "harbor")
    const toks = l.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    for (const t of toks) {
      if (reply.includes(t)) {
        hits++;
        break;
      }
    }
  }
  return hits ? clamp01(0.6 + 0.2 * hits) : 0.4; // mild penalty if reply never anchors setting
}

// Emotion continuity: crude sentiment-ish continuity against most recent user turn.
const POS = ['love', 'like', 'hope', 'gentle', 'warm', 'calm', 'safe', 'trust', 'smile'];
const NEG = ['hate', 'fear', 'angry', 'cry', 'hurt', 'cold', 'rage', 'unsafe', 'betray'];
function emotionScore({ lastUserText, replyText }) {
  if (!lastUserText) return 0.5;
  const uPos = hasAny(lastUserText, POS),
    uNeg = hasAny(lastUserText, NEG);
  const rPos = hasAny(replyText, POS),
    rNeg = hasAny(replyText, NEG);
  if (uPos && rPos && !rNeg) return 0.75;
  if (uNeg && rNeg && !rPos) return 0.75;
  if ((uPos && rNeg) || (uNeg && rPos)) return 0.35;
  return 0.55;
}

// Weighted aggregate
function combineScores(scores, weights) {
  let sum = 0,
    wsum = 0;
  for (const [k, v] of Object.entries(scores)) {
    const w = Number(weights?.[k] ?? 1);
    sum += w * Number(v || 0);
    wsum += w;
  }
  return wsum ? clamp01(sum / wsum) : 0.5;
}

/**
 * Judge continuity for a conversation reply.
 * @returns {Promise<{ axes: Record<string,number>, overall:number, context:{recent:string} }>}
 */
export async function judgeContinuity({
  convId,
  replyText,
  facetsTopK = 2,
  recentTurns = 6,
  weights,
}) {
  const snap = await shadowSnapshot(convId);
  const turns = Array.isArray(snap?.turns) ? snap.turns.slice(-recentTurns) : [];
  const recentText = turns.map((t) => t.text).join('\n');
  const lastUser = [...turns].reverse().find((t) => t.role === 'user');

  // Load facet store and pick top-K relevant facets for persona signal
  const store = await loadFacets(convId);
  const charId = process.env.FACETS_CHAR_ID || 'bot';
  const list = store?.characters?.[charId] || [];
  const chosenFacets = list.length
    ? pickFacets({ list, nowTurn: snap?.lastTurn || 0, k: facetsTopK }) || []
    : [];

  const axes = {
    timeline: timelineScore({ recentText, replyText }),
    persona: personaScore({ facets: chosenFacets, replyText }),
    promise: promiseScore({ facts: snap?.facts || [], replyText }),
    setting: settingScore({ facts: snap?.facts || [], replyText }),
    emotion: emotionScore({ lastUserText: lastUser?.text, replyText }),
  };
  const overall = combineScores(axes, weights);
  return { axes, overall, context: { recent: recentText } };
}

export function parseWeights(envStr) {
  // e.g. "timeline:2,persona:1.5,promise:2,setting:1,emotion:1"
  const out = {};
  if (!envStr) return out;
  for (const part of String(envStr)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [k, v] = part.split(':').map((s) => s.trim());
    if (k && v && !isNaN(Number(v))) out[k] = Number(v);
  }
  return out;
}
