/**
 * LoopGuard MVP: surface-shape delta scorer + style reroll hints.
 * Fast, dependency-free. Next steps will add embeddings + entropy.
 */

const PUNCT_RE = /[^\p{L}\p{N}\s]/gu;
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function ngrams(tokens, n = 3) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++) out.push(tokens.slice(i, i + n).join(' '));
  return out;
}
function jaccard(aArr, bArr) {
  if (!aArr.length || !bArr.length) return 0;
  const a = new Set(aArr),
    b = new Set(bArr);
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function deltaSimScore(reply, prevReplies, opts = {}) {
  const n = opts.ngramN ?? 3;
  const tReply = normalize(reply).split(' ').filter(Boolean);
  const replyGrams = ngrams(tReply, n);
  let maxSim = 0;
  for (const prev of prevReplies) {
    const tPrev = normalize(prev).split(' ').filter(Boolean);
    const prevGrams = ngrams(tPrev, n);
    const sim = jaccard(replyGrams, prevGrams);
    if (sim > maxSim) maxSim = sim;
  }
  return maxSim; // 0..1
}

const HISTORY = new Map(); // convId -> { replies: string[], cursor: number }
function getHistory(convId, size) {
  const key = String(convId || '');
  if (!HISTORY.has(key)) HISTORY.set(key, { replies: [], cursor: 0 });
  const h = HISTORY.get(key);
  if (size && h.replies.length > size) h.replies = h.replies.slice(-size);
  return h;
}
function recordReply(convId, text, size) {
  const h = getHistory(convId, size);
  h.replies.push(String(text || ''));
  if (size && h.replies.length > size) h.replies.shift();
}

function styleCycle(state, tokens) {
  const arr = String(tokens || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (arr.length === 0) return 'descriptive';
  const i = (state.idx || 0) % arr.length;
  state.idx = i + 1;
  return arr[i];
}

function buildStyleBooster(style) {
  // Kept subtle; we’ll get fancier later.
  return `(STYLE:${style}) Rephrase with a fresh angle. Avoid repeating recent sentence shapes. Prefer new sensory detail.`;
}

import { ultraDefaultOn } from './ultra.mjs';

export function getConfigFromEnv() {
  // When Ultra is enabled by default, widen the palette unless explicitly overridden.
  const ultraOn = ultraDefaultOn();
  const defaultTokens = ultraOn
    ? 'descriptive,poetic,terse,inner-thought,cinematic,staccato,noir,lyrical'
    : 'descriptive,poetic,terse,inner-thought,cinematic';
  return {
    enabled: process.env.LOOP_GUARD_ENABLED === '1',
    historyN: Number(process.env.LOOP_HISTORY_N || 5),
    simThresh: Number(process.env.LOOP_DELTA_SIM_THRESHOLD || 0.68),
    retryLimit: Number(process.env.LOOP_RETRY_LIMIT || 1),
    styleTokens: process.env.LOOP_GUARD_STYLE_TOKENS || defaultTokens,
  };
}

const STYLE_STATE = {};
export async function loopGuardDecide({ convId, candidate, prevBotReplies, cfg }) {
  if (!cfg.enabled)
    return { shouldReroll: false, reason: 'disabled', sim: 0, style: null, booster: null };
  const sim = deltaSimScore(candidate, prevBotReplies, { ngramN: 3 });
  if (sim >= cfg.simThresh) {
    const style = styleCycle(STYLE_STATE, cfg.styleTokens);
    return {
      shouldReroll: true,
      reason: 'delta_sim',
      sim,
      style,
      booster: buildStyleBooster(style),
    };
  }
  return { shouldReroll: false, reason: 'ok', sim, style: null, booster: null };
}

export function loopGuardHistoryAPI() {
  return {
    getPrevReplies(convId, n) {
      const h = getHistory(convId, n);
      return h.replies.slice(-n);
    },
    record(convId, text, n) {
      recordReply(convId, text, n);
    },
  };
}
