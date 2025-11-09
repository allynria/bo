// Tiny LLM micro-summarizer for booster lines (opt-in).
// ENV (defaults in parens):
//   BOOSTER_USE_LLM=1 (0)
//   BOOSTER_DEV_ONLY=1 (1)    // block in production unless you set 0
//   BOOSTER_LLM_MODEL (echo route: ECHO_* ; fallback 'stub-echo' if stubs)
//   BOOSTER_LLM_TIMEOUT_MS=800
//   BOOSTER_LLM_MAX_TOKENS=120
//   BOOSTER_MAX_CHARS=220
//   BOOSTER_LLM_TEMP=0.6
//   BOOSTER_LLM_TOP_P=0.95
//   BOOSTER_LLM_STOP="\n"
//   BOOSTER_TONE / BOOSTER_TONE_CUSTOM / BOOSTER_TONE_WEIGHT  (see voice_tuner)
//
// Caching: per (convId + persona + windowHash + tone) with small LRU.

import crypto from 'node:crypto';
import { LLMService, configureProvidersFromEnv, SafeText, sampled } from '../../monolith.js';
import { getVoiceHints } from './voice_tuner.mjs';

const LRU_MAX = 512;
const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map(); // key -> { ts, value }

function lruGet(k) {
  const v = _cache.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > CACHE_TTL_MS) {
    _cache.delete(k);
    return null;
  }
  // refresh LRU
  _cache.delete(k);
  _cache.set(k, v);
  return v.value;
}
function lruSet(k, value) {
  _cache.set(k, { ts: Date.now(), value });
  while (_cache.size > LRU_MAX) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
}

function hashWindow(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function emitMetric(name, n = 1, labels = {}) {
  try {
    if (globalThis.METRICS?.inc) globalThis.METRICS.inc(name, n, labels);
    else if (globalThis?.UrgaCoreDeps?.Metrics?.inc)
      globalThis.UrgaCoreDeps.Metrics.inc(name, n, labels);
  } catch {}
}

function sanitizeOneLiner(s) {
  let t = String(s || '')
    .replace(/\s+/g, ' ')
    .trim();
  // Remove obvious OOC or meta chatter
  t = t.replace(/\b(?:OOC|Out of Character)\b.*$/i, '').trim();
  t = t.replace(/\bAs an AI\b.*$/i, '').trim();
  t = t.replace(/^\((?:system|note|aside):.*?\)\s*/i, '').trim();
  // Drop enclosing quotes
  t = t.replace(/^["“”]+|["“”]+$/g, '').trim();
  // Single sentence-ish: cut at first hard stop after ~220 chars fallback
  const maxChars = Number(process.env.BOOSTER_MAX_CHARS || 220);
  t = SafeText.stripDangerous(t);
  t = SafeText.clamp(t, maxChars);
  return t;
}

export async function tryLLMBooster(ctx, convId, windowText, persona = '') {
  if (String(process.env.BOOSTER_USE_LLM || '0') !== '1') return null;
  if (String(process.env.BOOSTER_DEV_ONLY ?? '1') === '1' && process.env.NODE_ENV === 'production')
    return null;

  // Select model (favor echo/openai config; fallback to stub in tests)
  const model =
    process.env.BOOSTER_LLM_MODEL ||
    process.env.ECHO_OPENAI_MODEL ||
    process.env.OPENAI_ECHO_MODEL ||
    (process.env.LLM_TEST_STUBS ? 'stub-echo' : 'gpt-4o-mini');

  const timeoutMs = Number(process.env.BOOSTER_LLM_TIMEOUT_MS || 800);
  const maxTokens = Number(process.env.BOOSTER_LLM_MAX_TOKENS || 120);
  const temperature = Number(process.env.BOOSTER_LLM_TEMP || 0.6);
  const top_p = Number(process.env.BOOSTER_LLM_TOP_P || 0.95);
  const stop = (process.env.BOOSTER_LLM_STOP || '\n').replace(/\\n/g, '\n');

  const voiceHint = getVoiceHints(ctx);
  const toneKey = crypto.createHash('md5').update(voiceHint).digest('hex').slice(0, 6);
  const windowHash = hashWindow(windowText);
  const key = `${convId}:${toneKey}:${persona}:${windowHash}:${model}`;
  const cached = lruGet(key);
  if (cached) {
    emitMetric('booster_llm_cache_total', 1, { hit: '1' });
    return cached;
  }
  emitMetric('booster_llm_cache_total', 1, { hit: '0' });

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), timeoutMs);

  const sysLines = [
    'You produce one (1) in-character recap line that can be prepended to the scene without breaking immersion.',
    'Never mention being an AI, never break fourth wall, no OOC.',
    'Prefer first-person recollection or close third-person; compact, vivid, concrete.',
    voiceHint || '',
  ].filter(Boolean);
  const sys = sysLines.join(' ');

  // Keep prompt tiny; the windowText has already been pre-trimmed by caller.
  const prompt = [
    '<recent>',
    windowText.slice(0, 1500),
    '</recent>',
    persona ? `<persona>${persona}</persona>` : '',
    'Write ONE short recap line (no quotes):',
  ].join('\n');

  try {
    emitMetric('booster_llm_attempt_total', 1, { model });
    // Ensure providers are configured consistently before calling LLMService
    try {
      configureProvidersFromEnv(ctx);
    } catch {}
    const raw = await LLMService.call(ctx, `${sys}\n\n${prompt}`, {
      model,
      max_tokens: maxTokens,
      temperature,
      top_p,
      stop,
      signal: controller.signal,
    });
    const line = sanitizeOneLiner(raw);
    if (!line || line.length < 20) {
      emitMetric('booster_llm_yield_total', 1, { ok: '0' });
      return null;
    }
    lruSet(key, line);
    emitMetric('booster_llm_yield_total', 1, { ok: '1' });
    return line;
  } catch (err) {
    emitMetric('booster_llm_error_total', 1, { kind: (err?.name || 'error').toLowerCase() });
    sampled('warn', 0.05, `[booster_llm] error: ${String(err?.message || err)}`);
    return null;
  } finally {
    clearTimeout(to);
  }
}
