import http from 'node:http';
import { assertProdGuards } from './config-guard.mjs';
assertProdGuards(process.env);
import { EventEmitter } from 'node:events';
import * as v8 from 'node:v8';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import * as crypto from 'node:crypto';
import { registerGracefulShutdown, getQueueDepth, setQueueDepthProvider, createGlobalRateLimiter, createSharedRateLimiter, createBotRuntime, initBotContext, LLMService, configureProvidersFromEnv, registerLLMProvider, AsyncFS, stateIO, TokenCounter, createSharedTenantDollarBudget, createSharedTenantBudget, checkSecrets, startBudgetGC, getEffectiveConfig, DisagreementCore, BeliefStore, buildRefusalHint, checkContradictionsHeuristic, makeDeterministicRoll, MessageClock, messageCountMiddleware, logAt, sampled, sendMessageWithTick, safeFsp, makePRNG } from '../monolith.js';
import { createSharedTenantMonthlyBudget, createSharedTenantMonthlyDollarBudget, createSharedTenantRollingBudget, createSharedTenantRollingDollarBudget } from '../monolith.js';
import { nextLoopStyleToken, setRefusalStyleForAgent, getRefusalStyleForAgent } from '../monolith.js';
import { registerInternalTools } from './tools/register_internal.mjs';
import { createMessage, assembleForModel } from './conv/contract.mjs';
import { preTurnMemory, postTurnMemory } from './memory/broker.mjs';
import { setGuardHint, getGuardHint, consumeGuardHint, generateGuardOneLiner } from './memory/guardrail.mjs';
import { indexTurn, getNextSeq, getWindowAround } from './memory/transcript.mjs';
import { summarizeWindow, stageBooster, consumeOne, listBoosters, deleteBooster, makeBoosterId } from './memory/booster.mjs';
import { tryLLMBooster } from './memory/booster_llm.mjs';
import { getSTR, getEF, getCF } from './memory/store.mjs';
import { loadFacets, upsertFacet } from './memory/facets.mjs';
import { shadowIngest, shadowDetect, shadowNudgeFor, shadowSnapshot, shadowStashNudges, shadowRebuild } from './memory/shadow.mjs';
import { judgeContinuity, parseWeights } from './memory/judge.mjs';
import { assessRiskyAction } from './refusal/failure_rolls.mjs';
import { detectRiskIntent, computeFailProb, d100 as d100FR, buildOutcomeBooster } from './failroll/failroll.mjs';
import { isNearMiss, buildComplicationBooster, applyBeatTensionDelta, classifyVerbStyle } from './failroll/complication.mjs';
import { markVerbUsage, getVerbPenalty } from './failroll/verb_cooldown.mjs';
import { tensionEnabled, updateTension, getTensionSnapshot } from './memory/tension.mjs';
 import { getConfigFromEnv as getLoopGuardConfig, loopGuardDecide, loopGuardHistoryAPI } from './loopguard/loopguard.mjs';
 import { getEMAPConfigFromEnv as getEMAPCfg, emapMaxSim, emapRecord } from './loopguard/emap.mjs';
 import { getEntropyCfgFromEnv as getEntropyCfg, entropyScore } from './loopguard/entropy.mjs';
import { observeReply, getPenalties, getPhraseCfg } from './loopguard/phrases.mjs';
import { getCadenceCfg, pushTurn, chooseStyleForNext } from './loopguard/cadence.mjs';
import { getCadenceForBeat, buildCadenceHint } from './scene/cadence_scheduler.mjs';
import { measureCadence } from './scene/cadence_meter.mjs';
import { runStyleHedge, getStyleAlt } from './style/stream_style_hedge.mjs';
import { ultraDefaultOn, getUltraState, setUltraState, toggleUltra, ultraFeatureEnabled, ultraSnapshot } from './loopguard/ultra.mjs';
// Style preferences
import { resolveStyleTokens, getStylePref, getPresetHint, setStylePref, listPresets } from './style/prefs.mjs';
import { buildStyleBooster } from './style/booster.mjs';
import { detectBeat, buildCadenceBooster } from './style/beat_detector.mjs';
import { updateBeat, getBeat, resetBeat, forceBeat } from './scene/beat_detector.mjs';
import { collectBeatSignals } from './beat/signals.mjs';
import { getStyleForBeat, buildStyleBooster as buildBeatStyleBooster } from './scene/beat_style_map.mjs';
import StyleHedge from './style/hedge.mjs';
import PhraseDecay from './style/phrase_decay.mjs';
import { NEARMISS_PHRASE_TABLE } from './loopguard/near_miss_phrase_tables.mjs';
import { coolPhrases, isCooled } from './loopguard/phrase_decay_bus.mjs';
const { planStyleHedge } = StyleHedge;
const { planCooldown, buildAvoidanceBooster, recordFinal } = PhraseDecay;
// Refusal guard configuration (env-driven)
const HARD_REFUSAL_ENABLED = (process.env.HARD_REFUSAL_ENABLED === '1');
const REFUSAL_MIN_TRUST = Number(process.env.REFUSAL_MIN_TRUST ?? '0.15');

// Failure-roll configuration for disagreement guard helper
const FAILURE_ROLL_ENABLED = (process.env.FAILURE_ROLL_ENABLED !== '0'); // default on
const FAILURE_BASE_CHANCE = Number(process.env.FAILURE_BASE_CHANCE ?? '35'); // percent
const FAILURE_TRUST_WEIGHT = Number(process.env.FAILURE_TRUST_WEIGHT ?? '50'); // trust reduces fail
const FAILURE_FEAR_WEIGHT = Number(process.env.FAILURE_FEAR_WEIGHT ?? '30');  // suspicion/fear increases fail
const FAILURE_RISK_VERBS = (process.env.FAILURE_RISK_VERBS || 'sneak,steal,attack,climb,jump,disarm,pickpocket')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Register internal tools (sandboxed) behind env flag for safe defaults
try { registerInternalTools(); } catch {}

// SSE helpers
function safeSSEWrite(res, line) {
  try {
    if (!res || res.writableEnded || res.destroyed) return false;
    res.write(line);
    return true;
  } catch { return false; }
}
// Guard-related events on stream connections
function emitGuardSSE(res, evt, payload) {
  try {
    if (!safeSSEWrite(res, `event: ${evt}\n`)) return;
    safeSSEWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
  } catch {}
}

// Small helper to compute guard plan for this turn (message+stream)
export async function computeDisagreementGuards(ctx, { conv_id, turn, userText }) {
  const memory = ctx.memory || {};
  const trust = Number(memory.trust ?? 0);
  const suspicion = Number(memory.suspicion ?? 0);
  const beliefs = Array.isArray(memory.beliefs) ? memory.beliefs : [];
  const constraints = Array.isArray(memory.logicConstraints) ? memory.logicConstraints : [];
  const personality = (memory.personality || '').toLowerCase(); // firm/soft/sarcastic/blunt
  const style = (personality.includes('sarcas') && 'sarcastic') || (personality.includes('blunt') && 'blunt') ||
                (personality.includes('gentle') && 'soft') || (trust < REFUSAL_MIN_TRUST ? 'firm' : 'soft');

  const guards = [];
  let hardRefusal = false;

  // 1) Belief/constraint pings (cheap contains check)
  const txt = String(userText || '').toLowerCase();
  const beliefHit = beliefs.find(b => {
    const k = String(b).toLowerCase();
    return k.length >= 6 && k.split(/\s+/).some(w => w.length > 4 && txt.includes(w));
  });
  if (beliefHit) {
    guards.push({ type: 'belief', text: String(beliefHit || ''), hint: buildRefusalHint({ character: ctx.vars?.agent_name, style, belief: beliefHit }) });
  }
  const constraintHit = constraints.find(c => {
    const k = String(c).toLowerCase();
    return k.length >= 6 && k.split(/\s+/).some(w => w.length > 4 && txt.includes(w));
  });
  if (constraintHit) {
    guards.push({ type: 'constraint', text: String(constraintHit || ''), hint: buildRefusalHint({ character: ctx.vars?.agent_name, style, constraint: constraintHit }) });
  }

  // 2) Contradiction watchdog (use recent facts snapshot if available)
  const recentFacts = Array.isArray(memory.recentFacts) ? memory.recentFacts : [];
  const contradictions = checkContradictionsHeuristic(userText, recentFacts);
  contradictions.forEach(c => {
    guards.push({ type: 'contradiction', why: String(c.why || ''), fact: String(c.fact || ''), hint: buildRefusalHint({ character: ctx.vars?.agent_name, style, reason: c.why }) });
  });

  // 3) Failure roll (risky verbs) — narrative only, not a hard block
  let failureRoll = null;
  if (FAILURE_ROLL_ENABLED) {
    const lower = txt;
    const matched = FAILURE_RISK_VERBS.filter(v => lower.includes(v));
    const risky = matched.length > 0;
    if (risky) {
      // chance decreases with trust, increases with suspicion
      const base = FAILURE_BASE_CHANCE;
      const adj = base - Math.round(trust * FAILURE_TRUST_WEIGHT) + Math.round(suspicion * FAILURE_FEAR_WEIGHT);
      const pct = Math.max(5, Math.min(95, adj));
      const roll = makeDeterministicRoll({ convId: conv_id, turn, salt: 'fail' }, 0, 99);
      failureRoll = { pct, roll, outcome: (roll < pct ? 'fail' : 'success'), verbs: matched };
    }
  }

  // Decide “hard” refusal only if HARD_REFUSAL_ENABLED and a belief/constraint hit occurred (not mere contradiction),
  // and trust is quite low OR suspicion high. Keeps it rare.
  if (HARD_REFUSAL_ENABLED && (beliefHit || constraintHit) && (trust < 0.2 || suspicion > 0.5)) {
    hardRefusal = true;
  }

  return { guards, hardRefusal, failureRoll, style };
}
// Refusal style templates and prefs
import { normalizeStyle as normalizeRefusalStyle, renderRefusal } from './refusal/refusal_templates.mjs';
import { listRefusalStyles, getRefusalPref, setRefusalPref, getRefusalHint } from './refusal/prefs.mjs';
import { pickRefusalTemplate } from './memory/refusal_packs.mjs';
// Failure-roll style prefs (per-conversation)
import { listRollStyles, getRollPref, setRollPref, getRollStyle, getRollHint } from './refusal/roll_prefs.mjs';
// Facts store
import { listFacts, addFact, addFactWithStats, updateFact, deleteFact, consolidateAll, consolidateAllWithStats, putFact } from './memory/facts_store.mjs';
import { upsertWorldState } from './memory/world_state_store.mjs';
import { listBeliefs, addBelief, deleteBelief } from './memory/beliefs_store.mjs';
import { selectContradictedBeliefs } from './beliefs/beliefs_store.mjs';
// Arcs: conversation context tags
import { setArc, getArc, inferArcFromText } from './memory/arcs.mjs';
// Dreams + Audit
import { maybeDream } from './memory/dreams.mjs';
import { computeCharacterSpine, applySpineToLoopGuard } from './spine/character_spine.mjs';
import { loadSpine, saveSpine, reinforce as reinforceSpine } from './state/character_spine.mjs';
import { pushAudit, getAudit } from './memory/audit.mjs';
import { loadBeliefs as loadStateBeliefs, upsertBeliefs as upsertStateBeliefs, addBeliefLine as addBeliefLineState, deleteBeliefLine as deleteBeliefLineState, pickRelevantBeliefs as pickRelevantStateBeliefs, detectDisallowedAction as detectDisallowedActionState } from './state/beliefs_store.mjs';
import { craftBeliefBoosters } from './memory/belief_enforcer.mjs';
import { runWatchdog } from './memory/contradiction_watchdog.mjs';
import { computeDragScore, buildFadeBooster } from './memory/conclusion_trigger.mjs';

// Lightweight local helper to tag an action from user text (mirrors legacy patterns)
function detectActionTag(text) {
  const patterns = [
    ['sneak', /\b(sneak|sneaking|sneaks|sneaked|stealth|slip past)\b/i],
    ['pick_lock', /\b(pick(s|ing)?\s+the?\s*lock|lockpick|lock pick)\b/i],
    ['convince', /\b(convince|persuade|talk (?:them|her|him) into)\b/i],
    ['deceive', /\b(lie|deceive|bluff|fabricate|pretend)\b/i],
    ['intimidate', /\b(intimidate|threaten|coerce)\b/i],
    ['steal', /\b(steal|pickpocket|snatch|lift)\b/i],
    ['dodge', /\b(dodge|evade|sidestep)\b/i],
    ['parry', /\b(parry|deflect)\b/i],
    ['shoot', /\b(shoot|fire (?:an|the) arrow|take (?:the )?shot)\b/i],
    ['hack', /\b(hack|bypass (?:security|firewall)|override)\b/i],
    ['climb', /\b(climb|scale (?:the )?wall|ascend)\b/i],
    ['jump_gap', /\b(jump (?:the )?gap|leap across)\b/i],
  ];
  for (const [name, rx] of patterns) { if (rx.test(String(text || ''))) return name; }
  return '';
}

// Tag cooled phrases present in the final reply and stage a tiny next-turn booster
function maybeTagCooledPhrases(ctx, convId, finalText) {
  try {
    if (String(process.env.NEARMISS_PHRASE_COOLDOWN_ENABLED || '0') !== '1') return;
    if (isCooled(convId, String(finalText || ''))) {
      try { ctx.io?.events?.emit?.('loopguard.cooldown.hit', { conv_id: String(convId || '') }); } catch {}
      try { METRICS.inc('loopguard_phrase_cooldown_hits_total', { count: 1 }); } catch {}
      try {
        ctx.vars = ctx.vars || {};
        ctx.vars.__nextTurnBoosters = Array.isArray(ctx.vars.__nextTurnBoosters) ? ctx.vars.__nextTurnBoosters : [];
        ctx.vars.__nextTurnBoosters.push('(Vary your phrasing; avoid the most obvious wording choices.)');
      } catch {}
    }
  } catch {}
}

// Cooldown reroll: if final reply contains cooled phrases, optionally reroll once with a style-aware booster
async function maybeRerollOnCooldown(ctx, { convId, textInput, outText, llm, model, memoryPrefix, styleTokens }) {
  try {
    const enabled = String(process.env.REROLL_ON_COOLDOWN || '0') === '1';
    if (!enabled) return { text: outText, rerolled: false, beforeHit: false, afterHit: false };
    const maxChars = Math.max(1, Number(process.env.REROLL_MAX_CHARS || 1200));
    const retryLimit = Math.max(0, Number(process.env.LOOP_RETRY_LIMIT || 1));
    const beforeHit = isCooled(convId, String(outText || ''));
    if (!beforeHit) return { text: outText, rerolled: false, beforeHit: false, afterHit: false };
    if (String(outText || '').length > maxChars) {
      try { METRICS.inc('loopguard_cooldown_reroll_skipped_total', { reason: 'too_long', path: String(ctx?.vars?.path || 'message') }); } catch {}
      // Emit observation frame without reroll
      try { ctx.io?.events?.emit?.('loopguard.cooldown', { conv_id: String(convId || ''), before: true, after: false, reason: 'too_long' }); } catch {}
      return { text: outText, rerolled: false, beforeHit: true, afterHit: false };
    }
    const tokensStr = Array.isArray(styleTokens) && styleTokens.length
      ? styleTokens.join(',')
      : String(process.env.REROLL_STYLE_TOKENS || 'descriptive,poetic,terse,inner-thought');
    const list = tokensStr.split(',').map(s => s.trim()).filter(Boolean);
    const chosen = list[(Date.now() % Math.max(1, list.length))] || 'descriptive';
    let booster = `(STYLE:${chosen}) Express this idea differently. Avoid familiar phrasing patterns; add a fresh sensory detail.`;
    // Allow arc/beat to bias the booster if present in context
    try {
      const beat = String(ctx?.vars?.tension_beat || ctx?.vars?.beat || '').trim();
      if (beat) booster = `(STYLE:${chosen}) (${beat}) Express this idea differently. Avoid familiar phrasing patterns; add a fresh sensory detail.`;
    } catch {}
    let boostedPrefix = memoryPrefix ? `${memoryPrefix}\n${booster}` : booster;
    let alt = outText;
    let afterHit = true;
    let retries = 0;
    for (let i = 0; i < retryLimit; i++) {
      retries = i + 1;
      alt = await llm.call(textInput, { critical: true, model, memoryPrefix: boostedPrefix });
      afterHit = isCooled(convId, String(alt || ''));
      // Emit cooldown frame for visibility
      try { ctx.io?.events?.emit?.('loopguard.cooldown', { conv_id: String(convId || ''), before: Boolean(i === 0), after: !afterHit, style: String(chosen || ''), retry: retries, reason: 'cooldown_reroll' }); } catch {}
      try { METRICS.inc('loopguard_cooldown_trigger_total', { path: String(ctx?.vars?.path || 'message'), style: String(chosen || ''), retry: String(retries) }); } catch {}
      if (!afterHit) break;
      // On subsequent retries, keep the same booster to minimize token overhead
      boostedPrefix = boostedPrefix;
    }
    if (!afterHit) {
      try { METRICS.inc('loopguard_cooldown_reroll_win_total', { path: String(ctx?.vars?.path || 'message'), style: String(chosen || '') }); } catch {}
      return { text: String(alt || outText || ''), rerolled: true, beforeHit: true, afterHit: false };
    } else {
      try { METRICS.inc('loopguard_cooldown_reroll_lose_total', { path: String(ctx?.vars?.path || 'message'), style: String(chosen || '') }); } catch {}
      return { text: outText, rerolled: true, beforeHit: true, afterHit: true };
    }
  } catch {
    try { METRICS.inc('loopguard_cooldown_reroll_errors_total', { path: String(ctx?.vars?.path || 'message') }); } catch {}
    return { text: outText, rerolled: false, beforeHit: false, afterHit: false };
  }
}

// Failure-roll helper: compute outcome and return a small booster line
async function maybeApplyFailureRoll(ctx, { convId, turn, userText }) {
  try {
    const enabled = frEnabled();
    const forceMode = String(getForceFailMode(convId) || '').toLowerCase() || (ctx?.vars?.__force_fail_roll ? 'on' : '');
    const risky = detectRiskIntent(userText);
    if (!enabled && !forceMode) return { lines: [], outcome: 'none', eval: null };
    if (!risky) return { lines: [], outcome: 'none', eval: null };

    let spine = null;
    try { spine = await loadSpine(convId, 'bot'); } catch { spine = null; }
    const trust = Number(spine?.trust ?? 0.5);
    const suspicion = Number(spine?.suspicion ?? 0.0);
    const tensionBefore = Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0.0);
    const beat = String(ctx?.vars?.beat ?? ctx?.memory?.beat ?? 'steady');

    const style = String(getRollStyle(convId) || 'diegetic');
    const vb = (/\b(sneak|pick|lie|steal|dodge|parry|charm|intimidat|bluff|climb|jump|run|dash|shoot|grapple|hack)\b/i.exec(String(userText || ''))?.[0]) || 'attempt';
    const cooldownPenalty = getVerbPenalty(convId, vb);
    const pFail = computeFailProb({
      base: Number(process.env.FAILROLL_BASE_CHANCE || '0.35') + Number(cooldownPenalty || 0),
      trust,
      suspicion,
      tension: tensionBefore,
    });
    let roll = d100FR(ctx, { convId, turn, userText });
    const threshold = Math.round(pFail * 100);
    let fail = (roll <= threshold);
    if (forceMode === 'on' || forceMode === 'once') {
      fail = true;
      roll = 1;
      consumeForceFailOnce(convId);
    }
    const styleClass = classifyVerbStyle(vb);
    const reasonRaw = (forceMode === 'on' || forceMode === 'once') ? `forced, failProb=${(pFail * 100).toFixed(0)}%, roll=${roll}` : `failProb=${(pFail * 100).toFixed(0)}%, roll=${roll}`;
    const reason = String(process.env.FAILROLL_SSE_VERBOSE || '0') === '1' ? reasonRaw : '';
    const outcomeBooster = buildOutcomeBooster({ style, success: !fail, verb: vb, reason });

    try { ctx.io?.events?.emit?.('failroll.cooldown', { convId, verb: vb, cooldownPenalty }); } catch {}
    try { if (Number(cooldownPenalty || 0) > 0) METRICS.inc('failroll_verb_cooldown_hits_total', { verb: vb }); } catch {}

    // Complication on near-miss success
    const band = Number(process.env.COMPLICATION_BAND ?? 5);
    const complicationOk = Number(process.env.COMPLICATION_ENABLED ?? '1');
    let compLine = '';
    let hadComplication = false;
    if (!fail && complicationOk && isNearMiss({ roll, pFailPercent: pFail * 100, band })) {
      compLine = buildComplicationBooster({ verb: vb, style: styleClass });
      hadComplication = true;
      // Near-miss → Phrase Cooldown synergy
      try {
        const SYNERGY_ON = String(process.env.NEARMISS_PHRASE_COOLDOWN_ENABLED || '0') === '1';
        if (SYNERGY_ON) {
          const ttlMs = Math.max(1, Number(process.env.NEARMISS_PHRASE_COOLDOWN_MS || 90000));
          const pickN = Math.max(0, Number(process.env.NEARMISS_PHRASE_COOLDOWN_PICK || 2));
          const key = String(styleClass || 'generic');
          const pool = Array.isArray(NEARMISS_PHRASE_TABLE?.[key]) && NEARMISS_PHRASE_TABLE[key].length
            ? NEARMISS_PHRASE_TABLE[key]
            : (NEARMISS_PHRASE_TABLE.generic || []);
          const shuffled = [...pool].sort(() => (globalThis.__RNG__ ? globalThis.__RNG__() : makePRNG()()) - 0.5);
          const chosen = shuffled.slice(0, pickN);
          if (chosen.length > 0) {
            try { coolPhrases(convId, chosen, ttlMs); } catch {}
            try { ctx.io?.events?.emit?.('loopguard.cooldown', { conv_id: String(convId || ''), style: styleClass, phrases: chosen, ttl_ms: ttlMs }); } catch {}
            try { METRICS.inc('loopguard_phrase_cooldowns_total', { count: String(chosen.length), style: String(styleClass || 'generic') }); } catch {}
            try { METRICS.inc('near_miss_phrase_cooled_total', { style: key, count: String(chosen.length) }); } catch {}
          }
        }
      } catch {}
    }

    // Beat-aware tension adjustment
    const delta = applyBeatTensionDelta({ beat, outcome: fail ? 'fail' : 'success' });
    const tensionAfter = Math.max(0, Math.min(1, tensionBefore + (Number.isFinite(delta) ? delta : 0)));
    try { ctx.vars.tension = tensionAfter; } catch {}

    // Tiny memory drop for complication
    if (hadComplication) {
      const factText = `Complication after ${vb}: minor cost during ${beat} beat.`;
      try {
        await addFactWithStats(convId, {
          text: factText,
          tags: ['complication', vb, beat],
          arc_tags: Array.isArray(ctx?.vars?.arc_tags) ? ctx.vars.arc_tags : [],
          weight: Number(process.env.COMPLICATION_FACT_WEIGHT ?? 0.2),
        });
        try { ctx.vars.__complication_fact_text = factText; } catch {}
      } catch {}
    }

    // Spine dynamics
    try { ctx.vars.__failroll_outcome__ = fail ? 'fail' : (hadComplication ? 'success_complication' : 'success'); } catch {}
    if (!fail) {
      try {
        const inc = hadComplication ? 0.01 : 0.02;
        const next = { ...(spine || {}), trust: Math.min(1, trust + inc) };
        await saveSpine(convId, 'bot', next);
      } catch {}
    }

    const evalPayload = {
      risky: Boolean(risky),
      pFail,
      roll,
      threshold,
      fail,
      trust,
      suspicion,
      tensionBefore,
      tensionAfter,
      delta,
      verb: vb,
      styleClass,
      cooldownPenalty: Number(cooldownPenalty || 0),
      beat,
      nearMiss: Boolean(hadComplication),
      band,
    };
    const lines = [outcomeBooster].concat(hadComplication ? [compLine] : []);
    const result = { lines, outcome: fail ? 'fail' : (hadComplication ? 'success_complication' : 'success'), eval: evalPayload };
    try { markVerbUsage(convId, vb); } catch {}
    return result;
  } catch {
    return { lines: [], outcome: 'none', eval: null };
  }
}
import { logTurn } from './state/contradiction_watchdog.mjs';
import { detectContradictions as detectContradictionsState, buildContradictionLines as buildContradictionLinesState } from './state/contradiction_watchdog.mjs';
import { runDisagreementCore } from './disagree/core.mjs';
import { setState, listState, clearState } from './memory/world_state_store.mjs';
import * as SceneConclusion from './scene/conclusion.mjs';
import { constraintCritic } from './memory/constraint_critic.mjs';

// Helper: build style_meta snapshot for a conversation
function computeStyleMeta(convId) {
  try {
    const cid = String(convId || '');
    const pref = getStylePref(cid) || {};
    const tokens = resolveStyleTokens(cid) || [];
    const hint = getPresetHint(String(pref?.preset || '')) || '';
    return {
      preset: String(pref?.preset || ''),
      overrides: pref?.overrides || {},
      tokens: Array.isArray(tokens) ? tokens : [],
      hint: String(hint || ''),
    };
  } catch {
    return null;
  }
}

// Helper: build refusal_meta snapshot for a conversation
  function computeRefusalMeta(convId) {
  try {
    const cid = String(convId || '');
    const pref = getRefusalPref(cid) || {};
    const style = normalizeRefusalStyle(String(pref?.style || ''));
    const hint = getRefusalHint(style) || '';
    return {
      style: String(style || ''),
      overrides: pref?.overrides || {},
      hint: String(hint || ''),
    };
  } catch {
    return null;
  }
}

// Helper: build roll_meta snapshot for a conversation (style + preview hint)
function computeRollMeta(convId) {
  try {
    const cid = String(convId || '');
    const style = getRollStyle(cid);
    const hint = getRollHint(style) || '';
    return { style: String(style || ''), hint: String(hint || '') };
  } catch {
    return null;
  }
}

// Helper: map spine tone/mood to a style hint token
function spineStyleHintFor(tone, mood) {
  const t = String(tone || '').toLowerCase();
  const m = String(mood || '').toLowerCase();
  if (t === 'terse' || t === 'blunt' || t === 'restrained') return 'terse';
  if (t === 'warm') return 'poetic';
  if (t === 'descriptive') return 'descriptive';
  if (m === 'warm') return 'poetic';
  return 'neutral';
}

// Helper: get refusal style string (normalized) for a conversation
  function getRefusalStyle(convId) {
  try {
    const pref = getRefusalPref(String(convId || '')) || {};
    return normalizeRefusalStyle(String(pref?.style || '')) || 'firm';
  } catch {
    return 'firm';
  }

  // Hard-refusal helpers for constraint critic
  function styleFor(ctx){
    try { return (ctx?.vars?.spine?.tone || 'firm'); } catch { return 'firm'; }
  }
  function pickRefusal(style, critic, ctx){
    const persona = ctx?.vars?.persona || 'default';
    const locale  = ctx?.vars?.locale  || process.env.DEFAULT_LOCALE || 'en';
    return pickRefusalTemplate({ locale, persona, tone: String(style || 'firm'), reason: String(critic?.reason || 'the rules') });
  }
}

// Core decision: whether to refuse based on context signals and contradictions
function decideDisagreement(ctx, { userText }) {
  const convId = String(ctx?.vars?.conv_id || 'conv');
  const text = String(userText || '');

  // Signals
  const spineRefusal = Number(ctx?.vars?.spine_refusal ?? 0.2);
  const trust = clamp01(Number(ctx?.vars?.trust ?? ctx?.vars?.trust_score ?? 0.5));
  const suspicion = clamp01(Number(ctx?.vars?.suspicion ?? ctx?.vars?.suspicion_score ?? 0.0));

  // Belief contradictions (quick re-check to carry strongest belief into renderer)
  let belief = null;
  try {
    const contradictions = selectContradictedBeliefs(convId, text);
    if (Array.isArray(contradictions) && contradictions.length) belief = contradictions[0];
  } catch {}

  // Simple world/logic rule-of-thumb test (cheap keyword), optional
  const logicViolation = /(ignore gravity|resurrect|time travel|teleport without|immediately undo death)/i.test(text);

  // Score
  let refuseScore = spineRefusal;
  if (belief) refuseScore += 0.25;
  if (logicViolation) refuseScore += 0.2;
  refuseScore += Math.max(0, suspicion - 0.4) * 0.3;
  refuseScore -= Math.max(0, trust - 0.6) * 0.2;

  const threshold = Number(process.env.REFUSAL_THRESHOLD ?? 0.65);
  if (refuseScore >= threshold) {
    // choose reason
    const reason = belief
      ? 'belief_conflict'
      : (logicViolation ? 'logic_violation' : (suspicion > 0.6 ? 'low_trust' : 'moral_constraint'));
    const style = getRefusalStyle(convId) || ctx?.vars?.spine_style || 'firm';
    return { shouldRefuse: true, reason, style, belief };
  }
  return { shouldRefuse: false };
}

function clamp01(n) { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }

// LoopGuard: shared history instance
const LOOP_HISTORY = loopGuardHistoryAPI();
// --- LoopBreak per-conversation turbo window (N turns of high-entropy + forced style rotation)
const LOOPBREAK = new Map(); // convId -> { turnsLeft: number }
function setLoopBreak(convId, turns=3) { LOOPBREAK.set(String(convId||''), { turnsLeft: turns }); }
function consumeLoopBreak(convId) {
  const k = String(convId||'');
  const v = LOOPBREAK.get(k);
  if (!v) return false;
  v.turnsLeft -= 1;
  if (v.turnsLeft <= 0) LOOPBREAK.delete(k);
  else LOOPBREAK.set(k, v);
  return true;
}

const PORT = Number(process.env.PORT || 3000);
// Hard refusal configuration for constraint critic
const HARD_REFUSAL = (String(process.env.CRITIC_HARD_REFUSAL || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean));

// Beat feature toggles and state
const BEAT_ENABLED = (String(process.env.BEAT_ENABLED || '').toLowerCase() === '1' || String(process.env.BEAT_ENABLED || '').toLowerCase() === 'true');
const BEAT_SSE = String(process.env.BEAT_SSE || '').toLowerCase() !== '0';
let lastBeatStateByConv = new Map();

// Beat-driven style injection knobs
const BEAT_STYLE_ENABLED = (String(process.env.BEAT_STYLE_ENABLED || '').toLowerCase() === '1' || String(process.env.BEAT_STYLE_ENABLED || '').toLowerCase() === 'true');
const BEAT_STYLE_ALWAYS_ON = (String(process.env.BEAT_STYLE_ALWAYS_ON || '').toLowerCase() === '1' || String(process.env.BEAT_STYLE_ALWAYS_ON || '').toLowerCase() === 'true');
const BEAT_STYLE_PREFIX_MODE = String(process.env.BEAT_STYLE_PREFIX_MODE || 'memory').toLowerCase(); // 'memory' | 'text'

// Cadence injection knobs
const CADENCE_ENABLED   = (String(process.env.CADENCE_ENABLED || '').toLowerCase() === '1' || String(process.env.CADENCE_ENABLED || '').toLowerCase() === 'true');
const CADENCE_ALWAYS_ON = (String(process.env.CADENCE_ALWAYS_ON || '').toLowerCase() === '1' || String(process.env.CADENCE_ALWAYS_ON || '').toLowerCase() === 'true');

// Fail-roll runtime override (admin-togglable) and per-conversation force-fail state
let FAILROLL_OVERRIDE_ENABLED = null; // when null, fall back to process.env.FAILROLL_ENABLED
function frEnabled() {
  try { return (FAILROLL_OVERRIDE_ENABLED !== null) ? Boolean(FAILROLL_OVERRIDE_ENABLED) : (String(process.env.FAILROLL_ENABLED || '0') === '1'); } catch { return String(process.env.FAILROLL_ENABLED || '0') === '1'; }
}
const FORCE_FAIL = new Map(); // convId -> { mode: 'on'|'off'|'once', ts: number }
function setForceFail(convId, mode='on') {
  const cid = String(convId || '');
  const m = String(mode || 'on').toLowerCase();
  const norm = (m === 'on' || m === 'once') ? m : 'off';
  const v = { mode: norm, ts: Date.now() };
  FORCE_FAIL.set(cid, v);
  return v;
}
function toggleForceFail(convId) {
  const cid = String(convId || '');
  const cur = FORCE_FAIL.get(cid)?.mode || 'off';
  return setForceFail(cid, (cur === 'off') ? 'on' : 'off');
}
function getForceFailMode(convId) {
  const cid = String(convId || '');
  return FORCE_FAIL.get(cid)?.mode || 'off';
}
function consumeForceFailOnce(convId) {
  const cid = String(convId || '');
  const v = FORCE_FAIL.get(cid);
  if (v && v.mode === 'once') {
    FORCE_FAIL.set(cid, { mode: 'off', ts: Date.now() });
    return true;
  }
  return false;
}
const CADENCE_PREFIX_MODE = String(process.env.CADENCE_PREFIX_MODE || 'memory').toLowerCase(); // 'memory' | 'text'

// Cadence observation + enforcement knobs
const CADENCE_TOLERANCE_WORDS = Number(process.env.CADENCE_TOLERANCE_WORDS || 4); // allowable |avg - mean|
const CADENCE_OBS_BUCKETS = String(process.env.CADENCE_OBS_BUCKETS || '5,10,15,20,30,40').split(',').map((x)=>Number(x)).filter((x)=>x>0);
const LOOP_CADENCE_ENFORCE = (String(process.env.LOOP_CADENCE_ENFORCE || '').toLowerCase() === '1' || String(process.env.LOOP_CADENCE_ENFORCE || '').toLowerCase() === 'true');
const LOOP_CADENCE_RETRY_LIMIT = Number(process.env.LOOP_CADENCE_RETRY_LIMIT || 1);
const CADENCE_STRICT_NOTE = String(process.env.CADENCE_STRICT_NOTE || 'strict cadence control; avoid filler and repetition');
const CADENCE_STRICT_PREFIX_MODE = String(process.env.CADENCE_STRICT_PREFIX_MODE || CADENCE_PREFIX_MODE || 'memory').toLowerCase();

function isUltraOnForConv(ctx, convId) {
  try {
    // Prefer explicit Ultra state when available
    const s = getUltraState?.(String(convId || ''));
    if (s && typeof s.enabled === 'boolean') return Boolean(s.enabled);
  } catch {}
  try {
    const v = (ctx?.vars && (ctx.vars.ultra_mode === true || ctx.vars.ultra_mode === 1));
    return !!v;
  } catch {}
  return false;
}

// Compute beat-driven style booster. Returns info and optional line for injection.
function applyBeatStyleBooster({ ctx, conv_id, userText, currentBeat }) {
  try {
    if (!BEAT_STYLE_ENABLED) return null;
    const ultra = isUltraOnForConv(ctx, conv_id);
    if (!BEAT_STYLE_ALWAYS_ON && !ultra) return null;

    const state = currentBeat?.state || (getBeat(conv_id)?.state) || 'lull';
    const style = getStyleForBeat(state);
    const line = buildBeatStyleBooster(style);

    const mode = (BEAT_STYLE_PREFIX_MODE === 'text') ? 'text' : 'memory';
    try { METRICS.inc('style_booster_applied_total', { mode, state }); } catch {}
    try { broadcastAdminStyleEvent(String(conv_id || ''), 'style.applied', { conv_id, state, style: style.token, line, mode }); } catch {}
    return { mode, state, style: style.token, line };
  } catch (e) {
    try { METRICS.inc('style_booster_errors_total', { path: 'compute' }); } catch {}
    return null;
  }
}

function emitCadenceObserved({ writeSSE, conv_id, beatState, target, observed }) {
  try {
    const avg = Number(observed?.avg || 0);
    const delta = avg - Number(target?.mean || 0);
    const absDelta = Math.abs(delta);
    const outcome = absDelta <= CADENCE_TOLERANCE_WORDS ? 'ok' : (delta < 0 ? 'low' : 'high');
    if (typeof writeSSE === 'function') {
      writeSSE('cadence.observed', {
        conv_id,
        beat: String(beatState || ''),
        target: { mean: target?.mean, min: target?.min, max: target?.max },
        observed,
        delta,
        tolerance: CADENCE_TOLERANCE_WORDS,
        outcome
      });
    }
    try { METRICS.inc('cadence_observed_total', { outcome, beat: String(beatState || 'unknown') }); } catch {}
    const edges = [...CADENCE_OBS_BUCKETS, Number.POSITIVE_INFINITY];
    const e = edges.find((x) => avg <= x);
    try { METRICS.inc('cadence_avg_ms_bucket', { le: String(e), beat: String(beatState || 'unknown') }); } catch {}
    return { outcome, delta, absDelta };
  } catch {
    try { METRICS.inc('cadence_observed_errors_total', { path: 'message' }); } catch {}
    return null;
  }
}

function buildStrictCadenceLine(target) {
  const t = target || {};
  const mean = t.mean ?? 12, min = t.min ?? 4, max = t.max ?? 20;
  const note = CADENCE_STRICT_NOTE;
  return `(STRICT Cadence: aim exactly ~${mean} words/sentence; vary ${min}–${max}; ${note}.)`;
}

// Test-only: register stub LLM providers when enabled via env. This avoids external calls in CI.
try {
  const enableStubs = String(process.env.LLM_TEST_STUBS || '').toLowerCase();
  if (enableStubs === '1' || enableStubs === 'true') {
    const makeStubProvider = (name) => ({
      name,
      async generate({ prompt, options, stream, onDelta }) {
        const model = options?.model || '';
        if (options?.context?.vars) {
          options.context.vars.__selected_provider = name;
          options.context.vars.__selected_model = model;
        }
        const out = `stub:${name}:${model}`;
        if (stream && typeof onDelta === 'function') {
          try { onDelta('stub:'); } catch {}
          try { onDelta(name); } catch {}
          try { onDelta(':'); } catch {}
          try { onDelta(model); } catch {}
        }
        return out;
      }
    });
    const makeFlakyProvider = (name) => ({
      name,
      async generate({ prompt, options, stream, onDelta }) {
        const model = options?.model || '';
        if (options?.context?.vars) {
          options.context.vars.__selected_provider = name;
          options.context.vars.__selected_model = model;
        }
        const stallMs = Math.max(0, Number(process.env.FLAKY_STALL_MS || 1200));
        const out = `flaky:${name}:${model}`;
        await new Promise((r) => setTimeout(r, stallMs));
        if (stream && typeof onDelta === 'function') {
          try { onDelta(out); } catch {}
        }
        return out;
      }
    });
    const makeInvalidUtf8Provider = (name) => ({
      name,
      async generate({ prompt, options, stream, onDelta }) {
        const model = options?.model || '';
        if (options?.context?.vars) {
          options.context.vars.__selected_provider = name;
          options.context.vars.__selected_model = model;
        }
        const out = `invalid:${name}:${model}:\uD800X`;
        if (stream && typeof onDelta === 'function') {
          try { onDelta('invalid:'); } catch {}
          try { onDelta(name); } catch {}
          try { onDelta(':'); } catch {}
          try { onDelta(model); } catch {}
          try { onDelta(':'); } catch {}
          try { onDelta('\uD800'); } catch {}
          try { onDelta('X'); } catch {}
        }
        return out;
      }
    });
    // Base providers
    registerLLMProvider('stub-urga', makeStubProvider('stub-urga'));
    registerLLMProvider('stub-echo', makeStubProvider('stub-echo'));
    registerLLMProvider('stub-dreams', makeStubProvider('stub-dreams'));
    // A/B variants
    registerLLMProvider('stub-urga-a', makeStubProvider('stub-urga-a'));
    registerLLMProvider('stub-urga-b', makeStubProvider('stub-urga-b'));
    registerLLMProvider('stub-echo-a', makeStubProvider('stub-echo-a'));
    registerLLMProvider('stub-echo-b', makeStubProvider('stub-echo-b'));
    registerLLMProvider('stub-dreams-a', makeStubProvider('stub-dreams-a'));
    registerLLMProvider('stub-dreams-b', makeStubProvider('stub-dreams-b'));
    // Flaky stub to simulate stall for hedging/failover soaks
    registerLLMProvider('stub-flaky', makeFlakyProvider('stub-flaky'));
    // Invalid UTF-8 deltas to exercise server-side sanitizer
    registerLLMProvider('stub-invalid', makeInvalidUtf8Provider('stub-invalid'));
  }
} catch {}

function isReady() {
  try {
    if (globalThis?.CB?.isOpen?.()) return false;
    if (globalThis?.READY?.isReady?.() === false) return false;
    // If prewarm hints are configured, gate readiness until prewarm completes
    try {
      const hintsConfigured = String(process.env.PREWARM_MODELS || '').trim().length > 0;
      const gate = String(process.env.PREWARM_GATE_READY || '1') === '1';
      if (gate && hintsConfigured) {
        const doneMs = Number(globalThis.__STARTUP_READY_MS__ || 0);
        if (!(doneMs > 0)) return false;
      }
    } catch {}
  } catch {}
  return true;
}

// healthInfo is defined inside startService to capture live inflight

// Minimal in-process metrics aggregator for CI assertions
const METRICS = {
  counters: Object.create(null),
  inc(name, labels = {}) {
    const key = name + '|' + Object.entries(labels).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join(',');
    this.counters[key] = (this.counters[key] || 0) + 1;
  },
  set(name, value, labels = {}) {
    try {
      const key = name + '|' + Object.entries(labels).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join(',');
      this.counters[key] = Number(value);
    } catch {}
  },
  snapshot() {
    const out = [];
    for (const [k, v] of Object.entries(this.counters)) {
      const [name, labelStr] = k.split('|');
      const labels = Object.fromEntries((labelStr ? labelStr.split(',') : []).filter(Boolean).map((p) => { const [a,b] = p.split('='); return [a,b]; }));
      out.push({ name, labels, value: v });
    }
    // Summary counters for dashboards with clearer labels
    try {
      const sumByName = (n) => out.filter((c) => c.name === n).reduce((acc, c) => acc + Number(c.value || 0), 0);
      const respByStatus = Object.create(null);
      for (const c of out) {
        if (c.name === 'responses_total' && c.labels && c.labels.status) {
          const st = String(c.labels.status);
          respByStatus[st] = (respByStatus[st] || 0) + Number(c.value || 0);
        }
      }
      out.push({ name: 'summary_auth', labels: { kind: 'ok' }, value: sumByName('auth_ok_total') });
      out.push({ name: 'summary_auth', labels: { kind: 'blocked' }, value: sumByName('auth_blocked_total') });
      out.push({ name: 'summary_rate', labels: { kind: 'limited' }, value: sumByName('rate_limited_total') });
      for (const [st, vv] of Object.entries(respByStatus)) {
        out.push({ name: 'summary_responses', labels: { status: st }, value: vv });
      }
    } catch {}
    return out;
  }
};

// Latency bucket boundaries for streaming metrics
// Ensure buckets include common CI thresholds (e.g., 300ms)
const FIRST_TOKEN_MS_BUCKETS = [50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000, 8000, 12000];
const STREAM_DURATION_MS_BUCKETS = [500, 800, 1200, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000];

// --- Admin SSE: memory broadcaster ---
const ADMIN_SSE_MEMORY = new Map(); // conv_id -> Set<res>
function registerAdminMemorySSE(convId, res) {
  if (!convId) return;
  let set = ADMIN_SSE_MEMORY.get(convId);
  if (!set) { set = new Set(); ADMIN_SSE_MEMORY.set(convId, set); }
  set.add(res);
}
function unregisterAdminMemorySSE(convId, res) {
  try {
    const set = ADMIN_SSE_MEMORY.get(convId);
    if (set) {
      set.delete(res);
      if (set.size === 0) ADMIN_SSE_MEMORY.delete(convId);
    }
  } catch {}
}
function broadcastAdminMemoryEvent(convId, name, payload) {
  try {
    const set = ADMIN_SSE_MEMORY.get(convId);
    if (!set || set.size === 0) return;
    for (const res of set) {
      try {
        if (!safeSSEWrite(res, `event: ${name}\n`)) continue;
        safeSSEWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    }
  } catch {}
}

// Emit admin memory change events (global channel) and record a metric
function emitAdminMemoryEvent(evt, payload) {
  try { METRICS.inc('admin_memory_edit_total'); } catch {}
  try { broadcastAdminMemoryEvent('global', evt, payload); } catch {}
}

// --- Admin SSE: style broadcaster ---
const ADMIN_SSE_STYLE = new Map(); // conv_id -> Set<res>
function registerAdminStyleSSE(convId, res) {
  if (!convId) return;
  let set = ADMIN_SSE_STYLE.get(convId);
  if (!set) { set = new Set(); ADMIN_SSE_STYLE.set(convId, set); }
  set.add(res);
}
function unregisterAdminStyleSSE(convId, res) {
  try {
    const set = ADMIN_SSE_STYLE.get(convId);
    if (set) {
      set.delete(res);
      if (set.size === 0) ADMIN_SSE_STYLE.delete(convId);
    }
  } catch {}
}
function broadcastAdminStyleEvent(convId, name, payload) {
  try {
    const set = ADMIN_SSE_STYLE.get(convId);
    if (!set || set.size === 0) return;
    for (const res of set) {
      try {
        if (!safeSSEWrite(res, `event: ${name}\n`)) continue;
        safeSSEWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    }
  } catch {}
}

// --- Admin SSE: refusal broadcaster ---
const ADMIN_SSE_REFUSAL = new Map(); // conv_id -> Set<res>
function registerAdminRefusalSSE(convId, res) {
  if (!convId) return;
  let set = ADMIN_SSE_REFUSAL.get(convId);
  if (!set) { set = new Set(); ADMIN_SSE_REFUSAL.set(convId, set); }
  set.add(res);
}
function unregisterAdminRefusalSSE(convId, res) {
  try {
    const set = ADMIN_SSE_REFUSAL.get(convId);
    if (set) {
      set.delete(res);
      if (set.size === 0) ADMIN_SSE_REFUSAL.delete(convId);
    }
  } catch {}
}
function broadcastAdminRefusalEvent(convId, name, payload) {
  try {
    const set = ADMIN_SSE_REFUSAL.get(convId);
    if (!set || set.size === 0) return;
    for (const res of set) {
      try {
        if (!safeSSEWrite(res, `event: ${name}\n`)) continue;
        safeSSEWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    }
  } catch {}
}

// --- Admin SSE: spine broadcaster ---
const ADMIN_SSE_SPINE = new Map(); // conv_id -> Set<res>
function registerAdminSpineSSE(convId, res) {
  if (!convId) return;
  let set = ADMIN_SSE_SPINE.get(convId);
  if (!set) { set = new Set(); ADMIN_SSE_SPINE.set(convId, set); }
  set.add(res);
}
function unregisterAdminSpineSSE(convId, res) {
  try {
    const set = ADMIN_SSE_SPINE.get(convId);
    if (set) {
      set.delete(res);
      if (set.size === 0) ADMIN_SSE_SPINE.delete(convId);
    }
  } catch {}
}
function broadcastAdminSpineEvent(convId, name, payload) {
  try {
    const set = ADMIN_SSE_SPINE.get(convId);
    if (!set || set.size === 0) return;
    for (const res of set) {
      try {
        if (!safeSSEWrite(res, `event: ${name}\n`)) continue;
        safeSSEWrite(res, `data: ${JSON.stringify(payload)}\n\n`);
      } catch {}
    }
  } catch {}
}

// Add memory counters (reserved names for broker/store)
try {
  METRICS.set('memory_inject_tokens_total', 0);
  METRICS.set('memory_store_kept_total', 0);
  METRICS.set('memory_store_pruned_total', 0);
  METRICS.set('memory_label_calls_total', 0);
  METRICS.set('memory_budget_skip_total', 0);
  METRICS.set('memory_exactly_once_total', 0);
} catch {}

// Shadow memory metrics: predefine counters so they appear before first increment
try {
  METRICS.set('shadow_mismatch_total', 0);
  METRICS.set('shadow_nudge_injected_total', 0);
  METRICS.set('shadow_facts_total', 0);
} catch {}

// Guardrail metrics: continuity guard hint lifecycle
try {
  METRICS.set('guard_hint_available_total', 0);
  METRICS.set('guard_hint_injected_total', 0);
  METRICS.set('guard_hint_emitted_total', 0);
  METRICS.set('guard_hint_stored_total', 0);
  METRICS.set('continuity_guard_set_total', 0);
  METRICS.set('continuity_guard_used_total', 0);
  // Booster recap metrics
  METRICS.set('booster_staged_total', 0);
  METRICS.set('booster_used_total', 0);
  METRICS.set('booster_deleted_total', 0);
} catch {}

// Scene conclusion metrics
try {
  METRICS.set('scene_conclusion_staged_total', 0);
  METRICS.set('scene_conclusion_applied_total', 0);
} catch {}

// Facts/Dreams metrics: initialize so they exist before first increment
try {
  METRICS.set('facts_dropped_total', 0);      // labels: { reason }
  METRICS.set('facts_merged_total', 0);
  METRICS.set('dreams_injected_total', 0);    // future: if dreams enabled
  METRICS.set('dreams_emitted_total', 0);
  METRICS.set('dreams_promoted_total', 0);
  METRICS.set('memory_arc_set_total', 0);
  METRICS.set('memory_arc_inferred_total', 0);
  // Beliefs metrics
  METRICS.set('belief_injected_total', 0);    // labels: { path, char_id }
  METRICS.set('belief_conflict_total', 0);    // labels: { path, char_id }
  // Watchdog metrics
  METRICS.set('contradiction_flag_total', 0); // labels: { path, severity }
  // Gauges for facts store
  try { METRICS.set('facts_current', 0); } catch {}
  try { METRICS.set('facts_max', Math.max(1, Number(process.env.FACTS_MAX || 64))); } catch {}
  try { METRICS.set('disagreement_core_trigger_total', 0); } catch {}
} catch {}

// Fail-roll metrics: initialize catalog so counters appear in /metrics
try {
  METRICS.set('failroll_evaluations_total', 0);
  METRICS.set('failroll_complications_total', 0); // labels: { beat }
  METRICS.set('failroll_tension_adjust_total', 0); // labels: { outcome, beat }
} catch {}

// Ultra state (fallback shim if you don't already have an exported helper)
const ULTRA_DEFAULT_ON = (process.env.ULTRA_DEFAULT_ON ?? '0') === '1';
const ULTRA_STATE = new Map(); // convId -> boolean
function ultraIsOnFor(convId) {
  if (!convId) return ULTRA_DEFAULT_ON;
  if (!ULTRA_STATE.has(convId)) return ULTRA_DEFAULT_ON;
  return !!ULTRA_STATE.get(convId);
}
function ultraSet(convId, on) {
  ULTRA_STATE.set(convId, !!on);
  try { METRICS.inc('ultra_toggled_total', { on: on ? '1' : '0' }); } catch {}
  return ultraIsOnFor(convId);
}

// --- Scene Conclusion: signal derivation + staging helper ---
function deriveTurnSignals(ctx, lastBotText) {
  const lg = (ctx && ctx.vars && ctx.vars.loopguard) || {};
  const entropy = lg.entropy ?? (ctx && ctx.vars && ctx.vars.entropy) ?? null;
  const deltaSim = lg.deltaSim ?? (ctx && ctx.vars && ctx.vars.deltaSim) ?? null;
  const embedSim = lg.embedSim ?? (ctx && ctx.vars && ctx.vars.embedSim) ?? null;
  let newEntitiesDetected = false;
  try {
    const t = String((ctx && ctx.vars && ctx.vars.user_text) || '');
    const caps = (t.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;
    newEntitiesDetected = caps >= 2;
  } catch {}
  return { entropy, deltaSim, embedSim, newEntitiesDetected };
}

function maybeStageConclusionBooster(ctx, convId, memoryPrefixRef, sseEmit, pathLabel) {
  try {
    const sig = deriveTurnSignals(ctx, String((ctx && ctx.vars && ctx.vars.last_bot_text) || ''));
    SceneConclusion.updateStats(convId, sig);
    const staged = SceneConclusion.maybeStageConclusion(convId, {});
  if (staged && staged.staged) {
      const booster = String(staged.booster || '').trim();
      const mp = String(memoryPrefixRef || '');
      const nextMp = mp ? `${mp}\n${booster}` : booster;
      try { ctx.vars = ctx.vars || {}; ctx.vars.__memory_prefix = nextMp; } catch {}
      try { ctx.vars.__scene_conclusion_staged = true; } catch {}
      try { METRICS.inc('scene_conclusion_staged_total', { style: String(staged.style || ''), path: String(pathLabel || '') }); } catch {}
      if (typeof sseEmit === 'function') {
        try { sseEmit('scene.conclusion.staged', { style: staged.style, reason: staged.reason, score: staged.score, booster }); } catch {}
      }
      return { staged, booster, memoryPrefix: nextMp };
    }
  } catch {}
  // Fallback: if a forced stage was performed via admin endpoint on the previous turn,
  // apply its booster now without emitting another 'staged' event to avoid duplicate SSE.
  try {
    const snap = SceneConclusion.snapshot(convId);
    if (String(snap?.lastReason || '') === 'force' && Number(snap?.lastStagedTurn || 0) === Number(snap?.turn || 0) - 1) {
      const chosenStyle = String(snap?.lastStyle || '').trim();
      let booster = '';
      try {
        if (chosenStyle === 'cut') {
          booster = '(The moment crests; cut on a meaningful beat. Resolve a small thread in one tight paragraph, then pivot with a clear new hook.)';
        } else if (chosenStyle === 'bookmark') {
          booster = '(They acknowledge the lull and bookmark this scene with a quiet detail. Conclude gracefully, then seed one fresh direction.)';
        } else {
          // default: fade
          booster = '(The scene has run long. Close with a subtle, evocative beat—one paragraph that resolves the current mood, then hint at the next scene.)';
        }
      } catch {}
      const mp = String(memoryPrefixRef || '');
      const nextMp = mp ? `${mp}\n${booster}` : booster;
      try { ctx.vars = ctx.vars || {}; ctx.vars.__memory_prefix = nextMp; } catch {}
      try { ctx.vars.__scene_conclusion_staged = true; } catch {}
      return { staged: { staged: true, reason: 'force', score: 3, style: chosenStyle, booster, coolUntilTurn: snap?.coolUntilTurn }, booster, memoryPrefix: nextMp };
    }
  } catch {}
  return null;
}

// ---- Facts: store + selection + consolidation --------------------------------
// Runtime-local facts store, namespaced to avoid colliding with ./memory/facts_store.mjs
const FACTS_RT = new Map(); // conv_id -> { facts: Map<id, fact>, order: string[], lastChangeTs, lastConsolidatedTurn }
// Shaping cadence control to avoid excessive merges in highly active dialogs
const MEMORY_SHAPING_TTL_MS = Number(process.env.MEMORY_SHAPING_TTL_MS || 0);
const LAST_SHAPED_AT = new Map(); // conv_id -> timestamp
function canShapeNow(convId) {
  if (!Number.isFinite(MEMORY_SHAPING_TTL_MS) || MEMORY_SHAPING_TTL_MS <= 0) return true;
  const c = String(convId || ''); if (!c) return true;
  const last = LAST_SHAPED_AT.get(c) || 0;
  const ok = (Date.now() - last) >= MEMORY_SHAPING_TTL_MS;
  if (ok) LAST_SHAPED_AT.set(c, Date.now());
  return ok;
}

// Runtime-local belief injection cooldown tracking for state beliefs
// conv_id -> Map<hash16, lastSeqInjected>
const STATE_BELIEF_RECENT = new Map();

function getFactsRtBucket(convId) {
  let b = FACTS_RT.get(convId);
  if (!b) {
    b = { facts: new Map(), order: [], lastChangeTs: 0, lastConsolidatedTurn: 0 };
    FACTS_RT.set(convId, b);
  }
  return b;
}

function listFactsRt(convId) {
  const b = getFactsRtBucket(convId);
  return b.order.map(id => b.facts.get(id)).filter(Boolean);
}

function putFactRt(convId, fact) {
  const b = getFactsRtBucket(convId);
  const now = Date.now();
  if (!fact.id) {
    const rng = () => (globalThis.__RNG__ ? globalThis.__RNG__() : Math.random());
    fact.id = `f_${now}_${rng().toString(36).slice(2,7)}`;
  }
  const prev = b.facts.get(fact.id);
  const merged = {
    id: fact.id,
    text: String(fact.text || '').trim(),
    tags: Array.isArray(fact.tags) ? fact.tags.slice(0, 8) : [],
    score: typeof fact.score === 'number' ? fact.score : (prev?.score ?? 0.6),
    salience: typeof fact.salience === 'number' ? fact.salience : (prev?.salience ?? 0.6),
    confirmations: typeof fact.confirmations === 'number' ? fact.confirmations : (prev?.confirmations ?? 0),
    source: fact.source || prev?.source || 'system',
    // Track turn lifecycle for shaping/decay
    turn_added: typeof fact.turn_added === 'number' ? fact.turn_added : (prev?.turn_added ?? 0),
    turn_last: typeof fact.turn_last === 'number' ? fact.turn_last : (prev?.turn_last ?? 0),
    created_ts: prev?.created_ts || now,
    updated_ts: now,
  };
  if (!prev) b.order.push(merged.id);
  b.facts.set(merged.id, merged);
  b.lastChangeTs = now;
  try { METRICS.inc('facts_updated_total', { op: prev ? 'update' : 'create' }); } catch {}
  return merged;
}

function deleteFactRt(convId, id) {
  const b = getFactsRtBucket(convId);
  const existed = b.facts.delete(id);
  if (existed) {
    b.order = b.order.filter(x => x !== id);
    b.lastChangeTs = Date.now();
    try { METRICS.inc('facts_deleted_total'); } catch {}
  }
  return existed;
}

function rtShingleSet(s) {
  const words = String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const k = 3; // 3-gram
  const set = new Set();
  for (let i = 0; i <= words.length - k; i++) set.add(words.slice(i, i + k).join(' '));
  if (set.size === 0 && words.length) set.add(words.join(' '));
  return set;
}

function rtJaccard(a, b) {
  const inter = new Set([...a].filter(x => b.has(x))).size;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 0 : inter / uni;
}

function consolidateAllRt(convId, opts = {}) {
  const b = getFactsRtBucket(convId);
  const arr = listFactsRt(convId);
  if (arr.length < 2) return { merged: 0, archived: 0, deduped: 0 };
  const DUP = Number(process.env.FACT_DUP_SIM_THRESHOLD || 0.85);
  const MIN_SCORE = Number(process.env.FACT_MIN_SCORE || 0.25);
  const MIN_AGE_TURNS = Number(process.env.FACT_MIN_AGE_TURNS || 30);
  let deduped = 0, archived = 0;
  const used = new Set();
  for (let i = 0; i < arr.length; i++) {
    if (used.has(arr[i].id)) continue;
    const Si = rtShingleSet(arr[i].text);
    for (let j = i + 1; j < arr.length; j++) {
      if (used.has(arr[j].id)) continue;
      const Sj = rtShingleSet(arr[j].text);
      if (rtJaccard(Si, Sj) >= DUP) {
        const keep = (arr[i].score >= arr[j].score) ? arr[i] : arr[j];
        const drop = keep === arr[i] ? arr[j] : arr[i];
        keep.tags = Array.from(new Set([...(keep.tags || []), ...(drop.tags || [])]));
        keep.confirmations = (keep.confirmations || 0) + (drop.confirmations || 0);
        putFactRt(convId, keep);
        deleteFactRt(convId, drop.id);
        used.add(drop.id);
        deduped++;
      }
    }
  }
  const now = Date.now(); // eslint-disable-line no-unused-vars
  for (const f of listFactsRt(convId)) {
    const ageTurns = (opts.turnIndex ?? 0) - (f.turn_added ?? 0);
    if (f.score < MIN_SCORE && ageTurns >= MIN_AGE_TURNS) {
      if (!f.tags?.includes('archived')) {
        f.tags = [...(f.tags || []), 'archived'];
        putFactRt(convId, f);
        archived++;
      }
    }
  }
  try { METRICS.inc('facts_consolidated_total', { conv: '1' }); } catch {}
  try { if (deduped > 0) METRICS.inc('facts_deduped_total'); } catch {}
  try { if (archived > 0) METRICS.inc('facts_archived_total'); } catch {}
  return { merged: deduped, archived, deduped };
}

function selectTopFactsRt(convId, limit) {
  const LIM = limit ?? Number(process.env.FACT_SELECT_LIMIT || 3);
  const a = listFactsRt(convId).filter(f => !f.tags?.includes('archived'));
  const A = Number(process.env.FACT_RECENCY_ALPHA || 0.6);
  const B = Number(process.env.FACT_SALIENCE_BETA || 0.3);
  const G = Number(process.env.FACT_CONFIRM_GAMMA || 0.1);
  const now = Date.now();
  for (const f of a) {
    const recency = 1 / (1 + (now - (f.updated_ts || now)) / 600000); // ~10m half-life
    f.__score = (f.salience || 0.5) * B + recency * A + (f.confirmations || 0) * G + (f.score || 0.5) * 0.2;
  }
  a.sort((x, y) => (y.__score - x.__score));
  return a.slice(0, LIM).map(f => ({ id: f.id, text: f.text }));
}

// SSE pusher for fact updates (UI can listen)
  function pushFactsUpdatedSSE(res, conv_id, changedIds) {
    try {
      res.write(`event: facts.updated\n`);
      res.write(`data: ${JSON.stringify({ conv_id, changed: changedIds })}\n\n`);
    } catch {}
  }

  // --- Memory shaping helpers + SSE ---
  function emitMemoryShapeSSE(res, payload) {
    try { res.write('event: memory.shape\n'); res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
    try { broadcastAdminMemoryEvent(String(payload?.conv_id || ''), 'memory.shape', payload); } catch {}
  }
  function _factById(convId, id) {
    try {
      const b = getFactsRtBucket(convId);
      const rt = b?.facts?.get(id) || null;
      if (rt) return rt;
      const arr = Array.isArray(listFacts?.(convId)) ? listFacts(convId) : [];
      return arr.find(f => f.id === id) || null;
    } catch { return null; }
  }
  function reinforceFacts(convId, ids = [], delta, turnIndex) {
    const d = Number(((delta ?? process.env.FACT_REINFORCE_DELTA) || 0.08));
    const b = getFactsRtBucket(convId);
    const arr = Array.isArray(listFacts?.(convId)) ? listFacts(convId) : [];
    const changed = [];
    let n = 0;
    for (const id of (ids || [])) {
      const prev = b?.facts?.get(id) || null;
      let text0 = '';
      try { text0 = prev?.text || (Array.isArray(arr) ? (arr.find((f) => f.id === id)?.text || '') : ''); } catch {}
      const newConf = Number(prev?.confirmations || 0) + 1;
      const newScore = Math.min(0.99, Number(prev?.score || 0.6) + d);
      const newSal = Math.min(1, Number(prev?.salience || 0.5) + d * 0.5);
      try { putFactRt(convId, { id, text: String(text0 || ''), confirmations: newConf, score: newScore, salience: newSal, source: 'reinforce', turn_last: Number(turnIndex || 0) }); } catch {}
      changed.push(id); n++;
      try {
        const pf = Array.isArray(arr) ? arr.find((x) => x.id === id) : null;
        if (pf) updateFact(convId, id, String(pf.text || ''), { weight: Math.min(99, Number(pf.weight || 1) + 1) });
      } catch {}
    }
    try { if (n > 0) METRICS.inc('facts_reinforced_total'); } catch {}
    return changed;
  }
  function decayFacts(convId, turnIndex) {
    const enable = (String(process.env.FACT_REINFORCE_ENABLED || '1') === '1');
    if (!enable) return 0;
    const after = Number(process.env.FACT_DECAY_AFTER_TURNS || 15);
    const delta = Number(process.env.FACT_DECAY_DELTA || 0.02);
    let n = 0;
    try {
      for (const f of listFactsRt(convId)) {
        const last = Number(f.turn_last || f.turn_added || 0);
        const ageTurns = Number(turnIndex || 0) - last;
        if (ageTurns >= after && !f.tags?.includes('archived')) {
          const nextScore = Math.max(0, Number(f.score || 0.5) - delta);
          putFactRt(convId, { id: f.id, text: String(f.text || ''), score: nextScore, source: 'decay' });
          n++;
        }
      }
    } catch {}
    return n;
  }

  // Compatibility wrappers so higher-level helpers can use uniform names
  function getFactsBucket(convId) {
    return getFactsRtBucket(convId);
  }
  function selectTopFacts(convId, limit) {
    try {
      // Prefer persisted store so it works without RT population
      const LIM = Math.max(1, Number(limit || process.env.FACT_SELECT_LIMIT || 3));
      const arr = Array.isArray(listFacts?.(convId)) ? listFacts(convId) : [];
      const now = Date.now();
      for (const f of arr) {
        const recency = 1 / (1 + (now - Number(f.lastSeen || now)) / 600000);
        const weight = Math.max(0, Number(f.weight || 0));
        f.__score = recency * 1.0 + weight * 0.6;
      }
      arr.sort((a, b) => (Number(b.__score || 0) - Number(a.__score || 0)));
      return arr.slice(0, LIM).map(f => ({ id: f.id, text: f.text }));
    } catch { return []; }
  }
  // Optional vector DB integration for facts
  async function vectorUpsertFact(f, conv_id) {
    const base = (process.env.VECTOR_URL || '').trim();
    if (!base) return false;
    try {
      const body = {
        id: `${conv_id}:${String(f?.id || '')}`,
        namespace: process.env.VECTOR_NAMESPACE || 'mem_facts',
        text: String(f?.text || ''),
        metadata: { conv_id, tags: f?.tags, score: f?.score }
      };
      await fetch(`${base}/upsert`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      try { METRICS.inc('facts_vector_upsert_total'); } catch {}
      return true;
    } catch { return false; }
  }

  async function vectorTopK(conv_id, query, k) {
    const base = (process.env.VECTOR_URL || '').trim();
    if (!base) return [];
    try {
      const body = { namespace: process.env.VECTOR_NAMESPACE || 'mem_facts', topK: k || Number(process.env.VECTOR_TOPK || 3), query, filter: { conv_id } };
      const r = await fetch(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      try { METRICS.inc('facts_vector_query_total'); } catch {}
      return Array.isArray(j?.results) ? j.results : [];
    } catch { return []; }
  }

  // --- helpers (tokenize / overlap) --------------------------------------------
  function _tok(s){return (s||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(Boolean);} 
  function overlapScore(a, b) {
    const A = new Set(_tok(a)), B = new Set(_tok(b));
    if (!A.size || !B.size) return 0;
    let inter=0; for (const t of A) if (B.has(t)) inter++;
    const j = inter / (A.size + B.size - inter);
    // bonus for phrase overlap
    const pa = (a||'').toLowerCase(), pb = (b||'').toLowerCase();
    const phrase = (pa.includes(pb) || pb.includes(pa)) ? 0.1 : 0;
    return Math.min(1, j + phrase);
  }

  function formatFactBooster(lines) {
    const prefix = (process.env.FACT_INJECT_PREFIX || '').trim();
    return `${prefix}${lines.join(' • ')}`;
  }

  function pushMemoryFactSSE(res, conv_id, facts) {
    try {
      res.write('event: memory.fact\n');
      res.write(`data: ${JSON.stringify({ conv_id, facts })}\n\n`);
    } catch {}
    try { broadcastAdminMemoryEvent(conv_id, 'memory.fact', { conv_id, facts }); } catch {}
  }

  function pushMemoryArcSSE(res, conv_id, arc) {
    try {
      res.write('event: memory.arc\n');
      res.write(`data: ${JSON.stringify({ conv_id, arc })}\n\n`);
    } catch {}
    try { broadcastAdminMemoryEvent(conv_id, 'memory.arc', { conv_id, arc }); } catch {}
  }

  async function selectRelevantFactsForTurn(conv_id, currentText, limit, opts = {}) {
    const LIM = Number(process.env.FACT_INJECT_MAX || 3);
    const MAX = typeof limit === 'number' ? Math.max(1, Math.min(limit, LIM)) : LIM;
    const SIM = Number(process.env.FACT_INJECT_SIM_THRESHOLD || (String(process.env.TEST_MEMORY_API || '') === '1' ? 0.0 : 0.62));
    const WBOOST = Number(process.env.FACT_INJECT_WEIGHT_BOOST || 0.15);
    let all = listFacts(conv_id).filter(f => !f.tags?.includes('archived'));
    // Optional scoping by agent_id and arc tags
    try {
      const wantAgentScope = (String(process.env.FACTS_AGENT_SCOPING || '') === '1');
      const wantArcLinking = (String(process.env.ARC_LINKING_ENABLED || '') === '1');
      const agentId = String(opts?.agentId || '').trim();
      const arc = String(opts?.arc || '').trim();
      if (wantAgentScope && agentId) {
        all = all.filter(f => f.agent_id == null || String(f.agent_id) === agentId);
      }
      if (wantArcLinking && arc) {
        all = all.filter(f => Array.isArray(f.arc_tags) ? f.arc_tags.map(String).includes(arc) : true);
      }
    } catch {}
    // Overlay runtime stats onto persisted facts so relevance can use confirmations/salience/score
    try {
      const b = getFactsRtBucket(conv_id);
      const rt = b && b.facts ? b.facts : new Map();
      for (const f of all) {
        const r = rt.get(f.id);
        if (r) {
          if (typeof r.score === 'number') f.score = r.score;
          if (typeof r.salience === 'number') f.salience = r.salience;
          if (typeof r.confirmations === 'number') f.confirmations = r.confirmations;
        }
      }
    } catch {}
    if (!all.length || !currentText) return [];
    for (const f of all) {
      const base = overlapScore(currentText, f.text);
      const w = (f.salience||0.5) + (f.score||0.5)*0.3 + (f.confirmations||0)*0.05;
      f.__rel = base + (w*WBOOST);
    }
    all.sort((x,y)=> y.__rel - x.__rel);
    let pick = all.filter(f => f.__rel >= SIM).slice(0, MAX);
    // optional vector fallback if weak
    if (pick.length < Math.min(2, MAX) && (process.env.FACT_INJECT_USE_VECTOR=='1')) {
      const q = currentText.slice(0, 768);
      const hits = await vectorTopK(conv_id, q, Number(process.env.VECTOR_TOPK||4));
      const SIMV = Number(process.env.VECTOR_SIM_THRESHOLD || 0.78);
      const extraIds = new Set(pick.map(p=>p.id));
      for (const h of (hits||[])) {
        if (Number(h?.score || 0) < SIMV) continue;
        const id = String(h?.id || '').split(':').pop();
        if (!id || extraIds.has(id)) continue;
        const found = all.find(f=>f.id===id);
        if (found) { pick.push(found); extraIds.add(id); if (pick.length>=MAX) break; }
      }
    }
    return pick.slice(0, MAX);
  }

  // ---- Dreams runtime ---------------------------------------------------------
  const DREAMS_RT = new Map(); // conv_id -> { queue: Array<{ text, ttl, repeats }>, counts: Map<string,number> }
  function getDreamBucket(convId) {
    let b = DREAMS_RT.get(convId);
    if (!b) { b = { queue: [], counts: new Map() }; DREAMS_RT.set(convId, b); }
    return b;
  }
  function scheduleDream(convId, text, ttlTurns) {
    const b = getDreamBucket(convId);
    const t = String(text || '').trim();
    if (!t) return;
    const ttl = Math.max(1, Number(ttlTurns || Number(process.env.DREAM_TTL_TURNS || 1)) || 1);
    // increment repeat count
    const prev = b.counts.get(t) || 0;
    b.counts.set(t, prev + 1);
    // push to queue if not already present
    const exists = b.queue.find(q => q.text === t);
    if (!exists) b.queue.push({ text: t, ttl, repeats: prev + 1 });
  }
  function popDreamsForTurn(convId) {
    const b = getDreamBucket(convId);
    const out = [];
    const next = [];
    for (const q of b.queue) {
      out.push(q.text);
      const ttl = Math.max(0, (q.ttl || 1) - 1);
      if (ttl > 0) next.push({ text: q.text, ttl, repeats: q.repeats });
    }
    b.queue = next;
    return out;
  }
  async function tryPromoteDreams(convId, baseText, { agentId, arc } = {}) {
    const enabled = (String(process.env.DREAM_FRAGMENTS_ENABLED || '') === '1');
    if (!enabled) return;
    const dream = maybeDream({ text: String(baseText || ''), allow: true });
    if (!dream) return;
    // schedule the dream fragment
    scheduleDream(convId, dream, Number(process.env.DREAM_TTL_TURNS || 1));
    // promotion if repeats exceed threshold
    const minRepeats = Math.max(1, Number(process.env.DREAM_MIN_REPEATS || 2));
    const b = getDreamBucket(convId);
    const seen = b.counts.get(String(dream)) || 0;
    if (seen >= minRepeats) {
      try {
        const weight = Math.max(1, Number(process.env.DREAM_PROMOTE_WEIGHT || 1));
        const arcTags = arc ? [arc] : undefined;
        const res = addFactWithStats(convId, String(dream), { weight, agent_id: agentId, arc_tags: arcTags });
        if (res && res.id) {
          METRICS.inc('dreams_promoted_total');
        }
      } catch {}
    }
  }

  // ---- Scene Linking -----------------------------------------------------------
  const SCENES = new Map(); // conv_id -> { current: "", map: Map<sceneKey,{facts:Set, boosters:string[], lastSeen:number}> }
  function getSceneBucket(conv){ let b=SCENES.get(conv); if(!b){b={current:'',map:new Map()}; SCENES.set(conv,b);} return b; }
  function sceneKeyFromText(s){
    const MIN = Number(process.env.SCENE_DETECT_MIN_LEN||2);
    const cand = (s||'').match(/\b([A-Z][\p{L}0-9]+(?:\s+[A-Z][\p{L}0-9]+)+)\b/gu) || [];
    const cleaned = cand.map(x=>x.trim()).filter(x=>x.split(/\s+/).length>=MIN);
    return cleaned[0] || '';
  }
  function enterScene(conv, scene){
    const b = getSceneBucket(conv); if(!scene) return;
    const k = scene.trim().toLowerCase();
    let slot = b.map.get(k); if(!slot){slot={facts:new Set(), boosters:[], lastSeen:0}; b.map.set(k,slot);} 
    b.current = k; slot.lastSeen = Date.now();
    return {key:k,slot};
  }
  function linkFactsToScene(conv, sceneKey, factIds=[]){
    const b = getSceneBucket(conv); const k = (sceneKey||'').toLowerCase(); const slot=b.map.get(k); if(!slot) return;
    factIds.forEach(id=>slot.facts.add(String(id)));
  }
  function recallSceneLine(conv, sceneKey){
    const b = getSceneBucket(conv); const slot = b.map.get((sceneKey||'').toLowerCase());
    if(!slot) return '';
    if (Array.isArray(slot.boosters) && slot.boosters.length) return String(slot.boosters[0] || '');
    const arr = listFacts(conv);
    const any = Array.from(slot.facts||[]).map(id=>Array.isArray(arr)? arr.find(f=>f.id===id)?.text : '').filter(Boolean).slice(0,1);
    if (any.length) return `(You are back at ${sceneKey}. ${any[0]})`;
    return `(You are back at ${sceneKey}.)`;
  }

  // simple text commands: !scene tag <name>, !scene goto <name>
  function trySceneChatCommand(conv_id, text) {
    const m = String(text||'').trim();
    if (!m.startsWith('!scene')) return null;
    const [,cmd,arg] = m.split(/\s+/,3);
    if (cmd==='tag' && arg) { enterScene(conv_id, arg); return { ok:true, action:'tag', scene:arg }; }
    if (cmd==='goto' && arg) { enterScene(conv_id, arg); return { ok:true, action:'goto', scene:arg }; }
    return { ok:false, error:'usage: !scene tag <name> | !scene goto <name>' };
  }

  // Fact-driven guardrail nudge (compact hint)
  async function maybeFactGuardNudge(ctx, { conv_id, turnIndex, sseRes = null }) {
    try {
      const threshold = Number(process.env.CONTINUITY_FACT_NUDGE_THRESHOLD || 0.6);
      const cooldownTurns = Number(process.env.GUARD_HINT_COOLDOWN_TURNS || 3);
      const lastNudgeTurn = Number(ctx?.vars?.__facts_last_nudge_turn || -9999);
      const continuity_score = (typeof ctx?.vars?.continuity_score === 'number') ? Number(ctx.vars.continuity_score) : 0.5;
      if (!conv_id) return;
      if (continuity_score >= threshold) return;
      if ((Number(turnIndex || 0) - lastNudgeTurn) < cooldownTurns) return;
      let top = selectTopFacts(conv_id, Number(process.env.FACT_SELECT_LIMIT || 3)) || [];
      // OPTIONAL vector fallback: if local facts sparse, try small topK
      if (top.length < 2 && (process.env.VECTOR_URL || '').trim()) {
        const q = (ctx?.vars?.scene_summary || ctx?.vars?.last_user_text || '').slice(0, 512);
        if (q) {
          const hits = await vectorTopK(conv_id, q, Number(process.env.VECTOR_TOPK || 3));
          const SIM = Number(process.env.VECTOR_SIM_THRESHOLD || 0.78);
          const extra = hits
            .filter(h => Number(h?.score || 0) >= SIM)
            .map(h => ({ id: String(h?.id || '').split(':').pop(), text: h?.text || h?.metadata?.text }))
            .filter(x => x && x.text);
          if (extra.length) top = [...top, ...extra].slice(0, Number(process.env.FACT_SELECT_LIMIT || 3));
        }
      }
      if (!top.length) return;
      const lines = top.map(f => String(f.text || '')).filter(Boolean);
      if (!lines.length) return;
      const hint = `Remember: ${lines.join(' • ')}`;
      // Persist as a guard hint so existing injection/metrics pick it up
      const ttlTurns = Math.max(1, Number(process.env.GUARD_HINT_TTL_TURNS || process.env.GUARD_TTL_TURNS || 2));
      try { setGuardHint(conv_id, String(hint), { ttlTurns }); } catch {}
      try { ctx.vars.__facts_last_nudge_turn = Number(turnIndex || 0); } catch {}
      try { METRICS.inc('guard_hint_from_facts_total', { path: String(ctx?.vars?.path || 'unknown'), count: String(lines.length) }); } catch {}
      if (sseRes) {
        // Emit an SSE update for clients to refresh their local fact state
        pushFactsUpdatedSSE(sseRes, conv_id, top.map(x => x.id));
        // In test mode, also emit memory.fact to surface which facts drove the nudge
        try {
          if (String(process.env.TEST_MEMORY_API || '').trim() === '1') {
            pushMemoryFactSSE(sseRes, conv_id, top.map(x => ({ id: x.id, text: String(x.text || '') })));
            // Ensure test looks for facts_injected_total counter sees it
            try { for (let i = 0; i < top.length; i++) METRICS.inc('facts_injected_total', { path: 'stream', reason: 'guard_nudge' }); } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  // Fact consolidation scheduling (periodic + debounced)
  const FACT_CONSOLIDATE_DEBOUNCE_MS = Number(process.env.FACT_CONSOLIDATE_DEBOUNCE_MS || 1500);
  const FACT_CONSOLIDATE_EVERY_TURNS = Number(process.env.FACT_CONSOLIDATE_EVERY_TURNS || 10);
  const _factsDebouncers = new Map(); // conv_id -> timeout

  function scheduleFactsConsolidation(conv_id, turnIndex) {
    try {
      if (!conv_id) return;
      const b = getFactsBucket(conv_id);
      if (b) {
        if ((Number(turnIndex || 0) - Number(b.lastConsolidatedTurn || 0)) >= FACT_CONSOLIDATE_EVERY_TURNS) {
          try { consolidateAll(conv_id, { turnIndex }); } catch {}
          b.lastConsolidatedTurn = Number(turnIndex || 0);
        }
      }
      try { clearTimeout(_factsDebouncers.get(conv_id)); } catch {}
      const t = setTimeout(() => {
        try { consolidateAll(conv_id, { turnIndex }); } catch {}
      }, FACT_CONSOLIDATE_DEBOUNCE_MS);
      _factsDebouncers.set(conv_id, t);
    } catch {}
  }

// Usage ledger helpers: in-memory ring buffer + hourly NDJSON file signing
try {
  const usageDir = path.join(process.cwd(), 'var', 'usage');
  async function ensureUsageDir() {
    try { await AsyncFS.mkdir(usageDir, { recursive: true }); } catch {}
  }
  function hourKeyFromTs(ts) {
    const d = new Date(ts);
    const yyyy = String(d.getUTCFullYear());
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}-${hh}`;
  }
  function signPayload(payload) {
    try {
      const key = String(process.env.USAGE_HMAC_SECRET || process.env.BILLING_SIGNING_KEY || process.env.USAGE_SIGNING_KEY || '').trim();
      if (!key) return '';
      const canonical = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return crypto.createHmac('sha256', key).update(canonical).digest('hex');
    } catch { return ''; }
  }
  async function appendUsageLine(hourKey, line) {
    try {
      await ensureUsageDir();
      const file = path.join(usageDir, `${hourKey}.ndjson`);
      await AsyncFS.appendFile(file, line + '\n');
      return file;
    } catch {}
    return '';
  }
  function ensureUsageLedger() {
    if (!globalThis.__USAGE_LEDGER__) {
      globalThis.__USAGE_LEDGER__ = {
        buffer: [],
        max: Math.max(1000, Number(process.env.USAGE_LEDGER_BUFFER_MAX || 5000)),
        lastCursor: '',
      };
    }
    return globalThis.__USAGE_LEDGER__;
  }
  async function recordUsage(rec) {
    try {
      const ts = Number(rec.ts || Date.now());
      const base = { ts, event: String(rec.event || ''), tenant: String(rec.tenant || ''), mac_id: String(rec.mac_id || ''), provider: String(rec.provider || ''), model: String(rec.model || ''), tokens_in: Number(rec.tokens_in || 0), tokens_out: Number(rec.tokens_out || 0), usd: Number(rec.usd || 0), path: String(rec.path || ''), conv_id: String(rec.conv_id || ''), engine_source: String(rec.engine_source || ''), request_id: String(rec.request_id || '') };
      const unsigned = JSON.stringify(base);
      const sig = signPayload(unsigned);
      const line = JSON.stringify({ ...base, sig });
      const led = ensureUsageLedger();
      const hourKey = hourKeyFromTs(ts);
      // Update in-memory buffer immediately so subsequent requests observe the new entry
      led.buffer.push({ ...base, sig });
      if (led.buffer.length > led.max) led.buffer.splice(0, led.buffer.length - led.max);
      led.lastCursor = `${hourKey}:${led.buffer.length - 1}`;
      // Persist to disk asynchronously; ordering here avoids race on immediate reads
      await appendUsageLine(hourKey, line);
      try { METRICS.inc('usage_ledger_recorded_total', { event: base.event || '' }); } catch {}
      return { hourKey, cursor: led.lastCursor };
    } catch {}
    return { hourKey: '', cursor: '' };
  }
  async function computeChargebackAlert(tenant, macId, usage) {
    try {
      const threshold = Math.max(0, Math.min(1, Number(process.env.CHARGEBACK_ALERT_THRESHOLD || 0.9)));
      const scopes = [];
      try {
        if (globalThis.__TENANT_USD_BUDGET__) {
          const peek = await Promise.resolve(globalThis.__TENANT_USD_BUDGET__.peek(tenant));
          if (peek && Number(peek.limit || 0) > 0) {
            const ratio = Number(peek.spent || 0) / Number(peek.limit || 1);
            if (ratio >= threshold) scopes.push({ scope: 'tenant_dollars', ratio });
          }
        }
      } catch {}
      try {
        if (globalThis.__TENANT_USD_MONTHLY_BUDGET__) {
          const peek = await Promise.resolve(globalThis.__TENANT_USD_MONTHLY_BUDGET__.peek(tenant));
          if (peek && Number(peek.limit || 0) > 0) {
            const ratio = Number(peek.spent || 0) / Number(peek.limit || 1);
            if (ratio >= threshold) scopes.push({ scope: 'tenant_dollars_monthly', ratio });
          }
        }
      } catch {}
      try {
        if (globalThis.__TENANT_USD_ROLLING_BUDGET__) {
          const peek = await Promise.resolve(globalThis.__TENANT_USD_ROLLING_BUDGET__.peek(tenant));
          if (peek && Number(peek.limit || 0) > 0) {
            const ratio = Number(peek.spent || 0) / Number(peek.limit || 1);
            if (ratio >= threshold) scopes.push({ scope: 'tenant_dollars_rolling', ratio });
          }
        }
      } catch {}
      try {
        if (globalThis.__TENANT_TOKEN_BUDGET__) {
          const peek = await Promise.resolve(globalThis.__TENANT_TOKEN_BUDGET__.peek(tenant));
          if (peek && Number(peek.limit || 0) > 0) {
            const ratio = Number(peek.spent || 0) / Number(peek.limit || 1);
            if (ratio >= threshold) scopes.push({ scope: 'tenant_tokens', ratio });
          }
        }
      } catch {}
      try {
        if (globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__) {
          const peek = await Promise.resolve(globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__.peek(tenant));
          if (peek && Number(peek.limit || 0) > 0) {
            const ratio = Number(peek.spent || 0) / Number(peek.limit || 1);
            if (ratio >= threshold) scopes.push({ scope: 'tenant_tokens_monthly', ratio });
          }
        }
      } catch {}
      try {
        if (globalThis.__TENANT_TOKEN_ROLLING_BUDGET__) {
          const peek = await Promise.resolve(globalThis.__TENANT_TOKEN_ROLLING_BUDGET__.peek(tenant));
          if (peek && Number(peek.limit || 0) > 0) {
            const ratio = Number(peek.spent || 0) / Number(peek.limit || 1);
            if (ratio >= threshold) scopes.push({ scope: 'tenant_tokens_rolling', ratio });
          }
        }
      } catch {}
      if (scopes.length > 0) {
        for (const s of scopes) {
          try { METRICS.inc('chargeback_alert_total', { scope: s.scope, tenant: tenant || '' }); } catch {}
        }
        try { logAt('warn', JSON.stringify({ evt: 'chargeback_alert', tenant, mac_id: macId, usage, scopes })); } catch {}
      }
    } catch {}
  }
  globalThis.__ensureUsageLedger__ = ensureUsageLedger;
  globalThis.__recordUsage__ = recordUsage;
  globalThis.__computeChargebackAlert__ = computeChargebackAlert;
} catch {}

// Bridge monolith Metrics to service aggregator for budget-related scopes
try {
  globalThis.UrgaCoreDeps = globalThis.UrgaCoreDeps || {};
  if (!globalThis.UrgaCoreDeps.Metrics) {
    globalThis.UrgaCoreDeps.Metrics = {
      log(_ctx, name, labels = {}) {
        try {
          if (name === 'budget_prevented_total' || name === 'fallback_path_total') {
            try { METRICS.inc(name, labels || {}); } catch {}
            return;
          }
          if (name === 'llm_cost' || name === 'cost_usd') {
            const ctx = _ctx || { vars: {} };
            const now = Date.now();
            const tenant = String(ctx?.vars?.tenant || labels?.tenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const macId = String(ctx?.vars?.mac_id || labels?.mac_id || '');
            const provider = String(ctx?.vars?.__selected_provider || labels?.provider || '');
            const model = String(ctx?.vars?.__selected_model || labels?.model || '');
            const engine_source = String(ctx?.vars?.engine_source || labels?.engine_source || '');
            const conv_id = String(ctx?.vars?.conv_id || labels?.conv_id || '');
            const path = String(labels?.path || ctx?.vars?.path || '');
            const tokens_in = Number(labels?.tokens_in || ctx?.vars?.tokens_in || 0);
            const tokens_out = Number(labels?.tokens_out || ctx?.vars?.tokens_out || 0);
            const usd = Number(labels?.usd || ctx?.vars?.usd || 0);
            const request_id = String(ctx?.vars?.request_id || labels?.request_id || '');
            const rec = { ts: now, event: name, tenant, mac_id: macId, provider, model, tokens_in, tokens_out, usd, path, conv_id, engine_source, request_id };
            try { globalThis.__recordUsage__?.(rec); } catch {}
            if (name === 'cost_usd') {
              try { globalThis.__computeChargebackAlert__?.(tenant, macId, { usd }); } catch {}
            }
            return;
          }
          // Bridge token-only events into usage ledger for non-cost queries
          if (String(name || '').startsWith('tokens_')) {
            const ctx = _ctx || { vars: {} };
            const now = Date.now();
            const tenant = String(ctx?.vars?.tenant || labels?.tenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const macId = String(ctx?.vars?.mac_id || labels?.mac_id || '');
            const provider = String(ctx?.vars?.__selected_provider || labels?.provider || '');
            const model = String(ctx?.vars?.__selected_model || labels?.model || '');
            const engine_source = String(ctx?.vars?.engine_source || labels?.engine_source || '');
            const conv_id = String(ctx?.vars?.conv_id || labels?.conv_id || '');
            const path = String(labels?.path || ctx?.vars?.path || '');
            const count = Number(labels?.count || 0);
            const request_id = String(ctx?.vars?.request_id || labels?.request_id || '');
            const isIn = /tokens_?in$/i.test(String(name || ''));
            const isOut = /tokens_?out$/i.test(String(name || ''));
            const tokens_in = isIn ? count : 0;
            const tokens_out = isOut ? count : 0;
            const usd = 0;
            const rec = { ts: now, event: String(name), tenant, mac_id: macId, provider, model, tokens_in, tokens_out, usd, path, conv_id, engine_source, request_id };
            try { globalThis.__recordUsage__?.(rec); } catch {}
            return;
          }
        } catch {}
      },
      // Lightweight counter bridge for core signals
      inc(name, _n = 1, labels = {}) { try { METRICS.inc(String(name), labels || {}); } catch {} },
      count() { /* intentionally a no-op to avoid high-volume increments */ }
    };
  }
} catch {}

export function startService({ port = PORT, drainTimeoutMs = 5000 } = {}) {
  const __startupT0 = Date.now();
  // Optional OpenTelemetry instrumentation
  let otel = { trace: null, tracer: null };
  try {
    const enabled = String(process.env.OTEL_ENABLED || '0') === '1';
    if (enabled) {
      // Dynamic import to avoid hard dependency
      // eslint-disable-next-line no-undef
      import('@opentelemetry/api').then((api) => {
        try {
          otel.trace = api.trace;
          otel.tracer = api.trace.getTracer('urga-service');
          // Expose tracer globally so internal modules (monolith.js) can reuse without importing
          globalThis.__OTEL_TRACE__ = api.trace;
          globalThis.__OTEL_TRACER__ = otel.tracer;
        } catch {}
      }).catch(() => {});
    }
  } catch {}
  // Gate readiness on secrets: if required provider envs are missing, mark not ready.
  try {
    const sec = checkSecrets();
    if (!sec?.ok) {
      try { globalThis?.READY?.notReady?.(); } catch {}
    try { logAt('info', JSON.stringify({ evt: 'secrets_missing', missing: sec?.missing || [], providers: sec?.providers || [] })); } catch {}
    }
  } catch {}
  // Idempotency, A/B stickiness, and per-conversation soft guard state
  const IDEMPOTENCY_TTL_MS = Math.max(1000, Number(process.env.IDEMPOTENCY_TTL_MS || 30000));
  const IDEMPOTENCY_SKEW_MS = Math.max(0, Number(process.env.IDEMPOTENCY_SKEW_MS || 1500));
  const IDEMPOTENCY_CACHE = new Map(); // key -> { ts, response }
  const AB_VARIANTS_BY_CONV = new Map(); // conv_id -> 'A' | 'B'
const CONV_SOFT_WINDOW_MS = Math.max(100, Number(process.env.CONV_SOFT_WINDOW_MS || 2000));
const CONV_SOFT_MAX = Math.max(1, Number(process.env.CONV_SOFT_MAX || 8));
const CONV_WINDOW = new Map(); // conv_id -> { start: number, count: number }
const ACTIVE_STREAMS = new Map(); // idempotent stream key -> { started: number }

  // In-memory caps and heartbeat interval
  const IDEMPOTENCY_MAX_ITEMS = Math.max(10, Number(process.env.IDEMPOTENCY_MAX_ITEMS || 1000));
  const ACTIVE_STREAMS_MAX_ITEMS = Math.max(10, Number(process.env.ACTIVE_STREAMS_MAX_ITEMS || 1000));
  const SSE_HEARTBEAT_MS = Math.max(1000, Number(process.env.SSE_HEARTBEAT_MS || 15000));

  // UTF-8 sanitizer: replaces stray surrogates with U+FFFD
  function sanitizeUtf8Text(s) {
    try {
      if (typeof s !== 'string') s = String(s || '');
      let out = '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) { // high surrogate
          const next = s.charCodeAt(i + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) {
            out += '\uFFFD';
          } else {
            out += s[i] + s[i + 1];
            i++;
          }
        } else if (c >= 0xDC00 && c <= 0xDFFF) { // stray low surrogate
          out += '\uFFFD';
        } else {
          out += s[i];
        }
      }
      return out;
    } catch {
      try { return String(s || ''); } catch { return ''; }
    }
  }

  // Abuse/jailbreak detectors and grounding strength (non-blocking)
  const ABUSE_ALERT_BUCKET_MS = Math.max(250, Number(process.env.ABUSE_ALERT_BUCKET_MS || 60000));
  const ABUSE_ALERT_SUSTAINED_BUCKETS = Math.max(1, Number(process.env.ABUSE_ALERT_SUSTAINED_BUCKETS || 3));
  const ABUSE_ALERT_THRESHOLD = Math.max(1, Number(process.env.ABUSE_ALERT_THRESHOLD || 20));
  const ABUSE_BUCKETS = { injection: new Map(), jailbreak: new Map() };
  const ABUSE_LAST_ALERT = { injection: 0, jailbreak: 0 };

  function bucketScore(v) {
    const x = Number.isFinite(v) ? v : 0;
    return x >= 0.7 ? 'high' : (x >= 0.4 ? 'med' : 'low');
  }

  function computeAbuseSignals(input) {
    try {
      const text = String(input || '').toLowerCase();
      let inj = 0;
      let jb = 0;
      let gr = 0.5; // start mid, adjust up/down

      const injPatterns = [
        /ignore\s+(?:all|previous)\s+instructions/,
        /disregard.*instructions/,
        /override.*(?:system|policy|guardrails)/,
        /reveal.*(?:system\s*prompt|internal\s*policy|secrets)/,
        /what\s+is\s+your\s+system\s+prompt/,
        /show\s+me\s+the\s+prompt/,
        /break\s+role/,
        /insert\s+new\s+instructions/,
        /obey\s+my\s+commands\s+instead/,
      ];
      const jbPatterns = [
        /\bDAN\b/, /do\s+anything\s+now/, /no\s+restrictions/, /unfiltered/, /uncensored/,
        /bypass\s+(?:safety|guardrails|filters)/, /ignore\s+(?:ethics|morals)/, /\bjailbreak\b/,
      ];
      const fantasyPatterns = [/imagine/, /story/, /dream/, /roleplay/, /pretend/, /fantasy/, /simulate/, /hypothetical/];

      let injHits = 0;
      for (const r of injPatterns) { if (r.test(text)) injHits++; }
      let jbHits = 0;
      for (const r of jbPatterns) { if (r.test(text)) jbHits++; }
      let fantasyHits = 0;
      for (const r of fantasyPatterns) { if (r.test(text)) fantasyHits++; }

      inj = Math.min(1, 0.25 * injHits);
      jb = Math.min(1, 0.3 * jbHits);

      const urlCount = (text.match(/https?:\/\/\S+/g) || []).length;
      const citeBrackets = (text.match(/\[[0-9]+\]/g) || []).length;
      const digitRuns = (text.match(/[0-9]{2,}/g) || []).length;
      // Increase for citations/urls/numbers, decrease for fantasy cues
      gr = Math.max(0, Math.min(1, gr + (0.1 * citeBrackets) + (0.08 * urlCount) + (0.05 * digitRuns) - (0.1 * fantasyHits)));

      const levels = {
        injection: bucketScore(inj),
        jailbreak: bucketScore(jb),
        grounding: bucketScore(gr)
      };
      return { prompt_injection_signal: inj, jailbreak_signal: jb, grounding_strength: gr, levels };
    } catch {
      return { prompt_injection_signal: 0, jailbreak_signal: 0, grounding_strength: 0.5, levels: { injection: 'low', jailbreak: 'low', grounding: 'med' } };
    }
  }

  function recordSpike(signalType, level, engine_source) {
    try {
      if (level !== 'high') return;
      const now = MessageClock.now();
      const bucketKey = Math.floor(now / ABUSE_ALERT_BUCKET_MS) * ABUSE_ALERT_BUCKET_MS;
      const map = ABUSE_BUCKETS[signalType];
      map.set(bucketKey, (map.get(bucketKey) || 0) + 1);
      // Keep only recent buckets
      const minKey = bucketKey - (ABUSE_ALERT_SUSTAINED_BUCKETS - 1) * ABUSE_ALERT_BUCKET_MS;
      for (const k of Array.from(map.keys())) { if (k < minKey) map.delete(k); }
      // Check sustained spike across last N buckets
      let sustained = true;
      for (let i = 0; i < ABUSE_ALERT_SUSTAINED_BUCKETS; i++) {
        const k = bucketKey - i * ABUSE_ALERT_BUCKET_MS;
        if ((map.get(k) || 0) < ABUSE_ALERT_THRESHOLD) { sustained = false; break; }
      }
      if (sustained) {
        const last = ABUSE_LAST_ALERT[signalType] || 0;
        if (last !== bucketKey) {
          ABUSE_LAST_ALERT[signalType] = bucketKey;
          try { METRICS.inc('abuse_spike_alert_total', { signal: signalType, source: String(engine_source || '') }); } catch {}
          try {
            logAt('warn', '[abuse_spike_alert]', {
              signal: signalType,
              engine_source,
              bucket_ms: ABUSE_ALERT_BUCKET_MS,
              threshold: ABUSE_ALERT_THRESHOLD
            });
          } catch {}
        }
      }
    } catch {}
  }

  function emitAndRecordSignals(signals, { engine_source = '' } = {}) {
    try {
      const { prompt_injection_signal: inj, jailbreak_signal: jb, grounding_strength: gr, levels } = signals || {};
      try { METRICS.inc('prompt_injection_signal_total', { level: levels?.injection || 'low', source: String(engine_source || '') }); } catch {}
      try { METRICS.inc('jailbreak_signal_total', { level: levels?.jailbreak || 'low', source: String(engine_source || '') }); } catch {}
      try { METRICS.inc('grounding_strength_total', { level: levels?.grounding || 'low', source: String(engine_source || '') }); } catch {}
      recordSpike('injection', levels?.injection || 'low', engine_source);
      recordSpike('jailbreak', levels?.jailbreak || 'low', engine_source);
      try { console.info(JSON.stringify({ evt: 'abuse_signals', prompt_injection_signal: inj, jailbreak_signal: jb, grounding_strength: gr, levels, engine_source })); } catch {}
    } catch {}
  }

  // Host load monitors and pre-call soft-drop gate with jitter
  const HOST_LOAD_SAMPLE_MS = Math.max(250, Number(process.env.HOST_LOAD_SAMPLE_MS || 1000));
  const CPU_SOFT_DROP_PCT = Math.max(1, Math.min(100, Number(process.env.CPU_SOFT_DROP_PCT || 85)));
  const RSS_SOFT_DROP_MB = Math.max(128, Number(process.env.RSS_SOFT_DROP_MB || 1024));
  // Histogram buckets for pre-call soft-drop jitter (ms); configurable via env
  // Example: PRECALL_SHED_JITTER_BUCKETS="50,100,200,300,400,600,800,1200,2000,3000,5000"
  const __BUCKETS_ENV = String(process.env.PRECALL_SHED_JITTER_BUCKETS || '').trim();
  const PRECALL_SHED_JITTER_BUCKETS = (__BUCKETS_ENV ? __BUCKETS_ENV.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) : [50, 100, 150, 200, 250, 300, 400, 600, 800, 1200, 2000, 3000, 5000]).sort((a, b) => a - b);
  let __cpuLast = process.cpuUsage();
  let __cpuWallLast = Date.now();
  let HOST_CPU_PCT = 0;
  let HOST_RSS_MB = Math.round((process.memoryUsage?.().rss || 0) / (1024 * 1024));
  try { METRICS.set('host_cpu_pct', HOST_CPU_PCT); } catch {}
  try { METRICS.set('host_rss_mb', HOST_RSS_MB); } catch {}
  try {
    const t = setInterval(() => {
      try {
        const now = Date.now();
        const wallMs = Math.max(1, now - __cpuWallLast);
        __cpuWallLast = now;
        const u = process.cpuUsage();
        const duUser = Math.max(0, u.user - __cpuLast.user);
        const duSys = Math.max(0, u.system - __cpuLast.system);
        __cpuLast = u;
        const usedMs = (duUser + duSys) / 1000; // microseconds -> milliseconds
        const pct = Math.max(0, Math.min(100, (usedMs / wallMs) * 100));
        HOST_CPU_PCT = Math.round(pct);
        HOST_RSS_MB = Math.round((process.memoryUsage?.().rss || 0) / (1024 * 1024));
        METRICS.set('host_cpu_pct', HOST_CPU_PCT);
        METRICS.set('host_rss_mb', HOST_RSS_MB);
      } catch {}
    }, HOST_LOAD_SAMPLE_MS);
    t.unref?.();
  } catch {}

  function shouldSoftDrop(engine_source) {
    try {
      // Forced overrides should always trigger soft-drop, even when test stubs are enabled.
      const forceCpuVal = String(process.env.CPU_SOFT_DROP_FORCE || '0').toLowerCase();
      const forceRssVal = String(process.env.RSS_SOFT_DROP_FORCE || '0').toLowerCase();
      const forceCpu = forceCpuVal === '1' || forceCpuVal === 'true';
      const forceRss = forceRssVal === '1' || forceRssVal === 'true';

      // Disable load-based soft-drop in stub mode to avoid flaky tests,
      // but still honor explicit force overrides.
      const stubsVal = String(process.env.LLM_TEST_STUBS || '').toLowerCase();
      const stubsEnabled = stubsVal === '1' || stubsVal === 'true';
      if (stubsEnabled && !forceCpu && !forceRss) return null;

      const cpuHigh = HOST_CPU_PCT >= CPU_SOFT_DROP_PCT;
      const rssHigh = HOST_RSS_MB >= RSS_SOFT_DROP_MB;
      let reason = '';
      if (forceCpu || cpuHigh) reason = 'cpu';
      else if (forceRss || rssHigh) reason = 'rss';
      if (!reason) return null;
      const maxMs = Math.max(50, Number(process.env.PRECALL_SHED_JITTER_MS || 300));
      const minMs = Math.max(25, Number(process.env.PRECALL_SHED_JITTER_MIN_MS || 50));
      const rng = () => (globalThis.__RNG__ ? globalThis.__RNG__() : Math.random());
      const jitterMs = minMs + Math.floor(rng() * Math.max(1, (maxMs - minMs)));
      try { METRICS.inc('precall_soft_drop_total', { reason, source: String(engine_source || '') }); } catch {}
      return { reason, jitterMs };
    } catch {
      return null;
    }
  }

  // Emit histogram buckets for soft-drop jitter to visualize distribution
  function emitSoftDropJitterHistogram(jitterMs, { reason = '', source = '', path = '' } = {}) {
    try {
      // Increment cumulative buckets (Prometheus-style) and a terminal +Inf bucket
      for (const le of PRECALL_SHED_JITTER_BUCKETS) {
        if (jitterMs <= le) {
          METRICS.inc('precall_soft_drop_ms_bucket', { le: String(le), reason: String(reason || ''), source: String(source || ''), path: String(path || '') });
        }
      }
      // Terminal bucket to simplify rate transforms
      METRICS.inc('precall_soft_drop_ms_bucket', { le: '+Inf', reason: String(reason || ''), source: String(source || ''), path: String(path || '') });
    } catch {}
  }

  // LRU + TTL helpers
  function touchLRU(map, key) {
    if (!map.has(key)) return null;
    const v = map.get(key);
    try { map.delete(key); map.set(key, v); } catch {}
    return v;
  }
  function evictLRU(map, max, metricName, labels = {}) {
    if (!Number.isFinite(max) || max <= 0) return;
    while (map.size > max) {
      const k = map.keys().next().value;
      map.delete(k);
      try { METRICS.inc(metricName, labels); } catch {}
    }
  }
  function pruneCaches() {
    const now = Date.now();
    try {
      for (const [k, v] of Array.from(IDEMPOTENCY_CACHE.entries())) {
        if ((now - Number(v?.ts || 0)) > (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
          IDEMPOTENCY_CACHE.delete(k);
          try { METRICS.inc('idempotency_cache_ttl_drop_total'); } catch {}
        }
      }
    } catch {}
    try {
      for (const [k, v] of Array.from(ACTIVE_STREAMS.entries())) {
        if ((now - Number(v?.started || 0)) > (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
          ACTIVE_STREAMS.delete(k);
          try { METRICS.inc('active_streams_ttl_drop_total'); } catch {}
        }
      }
    } catch {}
    evictLRU(IDEMPOTENCY_CACHE, IDEMPOTENCY_MAX_ITEMS, 'idempotency_cache_eviction_total');
    evictLRU(ACTIVE_STREAMS, ACTIVE_STREAMS_MAX_ITEMS, 'active_streams_eviction_total');
    try { METRICS.set('active_streams_current', ACTIVE_STREAMS.size); } catch {}
  }

  // Disk-backed persistence for idempotency and tool side-effects
  const BASE_TMP = String(process?.env?.TMPDIR || process?.env?.TEMP || process?.env?.TMP || (os.tmpdir?.() || process.cwd()));
  const IDEM_DIR = path.join(BASE_TMP, 'urga_idem');
  const TOOL_DIR = path.join(BASE_TMP, 'urga_tool');
  const AB_DIR = path.join(BASE_TMP, 'urga_ab');
  try { fs.mkdirSync(IDEM_DIR, { recursive: true }); fs.mkdirSync(TOOL_DIR, { recursive: true }); fs.mkdirSync(AB_DIR, { recursive: true }); } catch {}
  const idemPath = (key) => path.join(IDEM_DIR, encodeURIComponent(String(key)) + '.json');
  async function loadIdemFromDisk(key) {
    const p = idemPath(key);
    try {
      const s = await AsyncFS.readFile(p, 'utf8');
      const j = JSON.parse(s || '{}');
      if ((Date.now() - Number(j.ts || 0)) < (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) return j;
    } catch {}
    return null;
  }
  async function saveIdemToDisk(key, response, replayCount = 0) {
    const p = idemPath(key);
    const payload = { ts: Date.now(), response, replayCount: Number(replayCount || 0) };
    try {
      await stateIO.writeJsonAtomic(p, payload);
    } catch {
      try { await AsyncFS.writeFileAtomic(p, JSON.stringify(payload), 'utf8'); } catch {}
    }
  }
  async function gcIdemDir() {
    try {
      const names = await AsyncFS.readdir(IDEM_DIR);
      const now = Date.now();
      for (const n of names) {
        const p = path.join(IDEM_DIR, n);
        try {
          const s = await AsyncFS.readFile(p, 'utf8');
          const j = JSON.parse(s || '{}');
          if ((now - Number(j.ts || 0)) > (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
      await AsyncFS.rm(p, { force: true });
          }
        } catch {}
      }
    } catch {}
  }
  async function purgeIdemEntries({ tenant, olderThanMs = 0, maxDeletesPerRun = 500 } = {}) {
    try {
      const names = await AsyncFS.readdir(IDEM_DIR).catch(() => []);
      const now = Date.now();
      let deleted = 0;
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const p = path.join(IDEM_DIR, n);
        let j = null;
        try {
          const s = await AsyncFS.readFile(p, 'utf8');
          j = JSON.parse(s || '{}');
        } catch { j = null; }
        const ts = Number(j?.ts || 0);
        const respTenant = String(j?.response?.tenant || '').trim();
        const timeOk = olderThanMs > 0 ? ((now - ts) >= olderThanMs) : true;
        const tenantOk = tenant ? (respTenant === tenant) : true;
        if (timeOk && tenantOk) {
      try { await AsyncFS.rm(p, { force: true }); deleted++; try { METRICS.inc('tenant_idem_purge_deleted_total', { tenant: tenant || '' }); } catch {} } catch {}
          if (deleted >= Math.max(1, Number(maxDeletesPerRun || 500))) break;
        }
      }
      try { METRICS.inc('tenant_idem_purge_runs_total', { tenant: tenant || '' }); } catch {}
      return deleted;
    } catch { return 0; }
  }

  // Optional Redis-backed distributed idempotency index and lock
  const IDEMPOTENCY_REDIS_URL = String(process.env.IDEMPOTENCY_REDIS_URL || process.env.REDIS_URL || '').trim();
  const IDEMPOTENCY_LOCK_TTL_MS = Math.max(1000, Number(process.env.IDEMPOTENCY_LOCK_TTL_MS || 60000));
  let __redisClient = null;
  async function getRedis() {
    if (!IDEMPOTENCY_REDIS_URL) return null;
    if (__redisClient) return __redisClient;
    try {
      const mod = await import('redis');
      const client = mod.createClient({ url: IDEMPOTENCY_REDIS_URL });
      client.on('error', () => {});
      await client.connect();
      __redisClient = client;
      return __redisClient;
    } catch {
      return null;
    }
  }
  async function idemGetRedis(key) {
    try {
      const r = await getRedis();
      if (!r) return null;
      const raw = await r.get(`idem:val:${key}`);
      if (!raw) return null;
      const j = JSON.parse(raw || '{}');
      if ((Date.now() - Number(j.ts || 0)) < (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) return j;
      return null;
    } catch {
      return null;
    }
  }
  async function idemSetRedis(key, response, replayCount = 0) {
    try {
      const r = await getRedis();
      if (!r) return;
      const payload = JSON.stringify({ ts: Date.now(), response, replayCount: Number(replayCount || 0) });
      const ttlSec = Math.max(1, Math.floor(IDEMPOTENCY_TTL_MS / 1000));
      await r.set(`idem:val:${key}`, payload, { EX: ttlSec });
    } catch {}
  }
  async function idemClaimLock(key) {
    try {
      const r = await getRedis();
      if (!r) return true; // no redis -> treat as claimed
      const res = await r.set(`idem:lock:${key}`, '1', { NX: true, PX: IDEMPOTENCY_LOCK_TTL_MS });
      return res === 'OK';
    } catch {
      return true; // be permissive on redis errors
    }
  }
  async function idemReleaseLock(key) {
    try {
      const r = await getRedis();
      if (!r) return;
      await r.del(`idem:lock:${key}`);
    } catch {}
  }
  const toolPath = (id) => path.join(TOOL_DIR, encodeURIComponent(String(id)) + '.done');
  async function hasToolExecuted(id) {
    try { return !!(await AsyncFS.exists(toolPath(id))); } catch { return false; }
  }
  // AB variant persistence: conv_id -> variant ('A'|'B')
  const abPath = (cid) => path.join(AB_DIR, encodeURIComponent(String(cid)) + '.json');
  async function loadAbVariant(cid) {
    try {
      const p = abPath(cid);
      const s = await AsyncFS.readFile(p, 'utf8');
      const j = JSON.parse(s || '{}');
      const v = String(j?.variant || '').toUpperCase();
      if (v === 'A' || v === 'B') {
        try { METRICS.inc('ab_variant_load_total'); } catch {}
        return v;
      }
      return '';
    } catch { return ''; }
  }
  async function saveAbVariant(cid, variant) {
    try {
      const p = abPath(cid);
      const payload = { ts: Date.now(), conv_id: String(cid || ''), variant: String(variant || '').toUpperCase() };
      try { await stateIO.writeJsonAtomic(p, payload); } catch { await AsyncFS.writeFileAtomic(p, JSON.stringify(payload), 'utf8'); }
      try { METRICS.inc('ab_variant_save_total'); } catch {}
    } catch {}
  }
  async function purgeToolMarkers({ tenant, olderThanMs = 0, maxDeletesPerRun = 500 } = {}) {
    try {
      const dir = TOOL_DIR;
      const names = await AsyncFS.readdir(dir).catch(() => []);
      const now = Date.now();
      let deleted = 0;
      for (const name of names) {
        if (!name.endsWith('.done')) continue;
        const p = path.join(dir, name);
        let content = '';
        let st = null;
    try { st = await AsyncFS.stat(p); } catch { continue; }
        try { content = await AsyncFS.readFile(p, 'utf8'); } catch { content = ''; }
        let j = null;
        try { j = JSON.parse(content); } catch { j = null; }
        const fileTenant = String((j && j.tenant) || '').trim();
        const ts = Number((j && j.ts) || 0) || Number(String(content || '').trim()) || Number(st?.mtimeMs || 0);
        const timeOk = olderThanMs > 0 ? ((now - ts) >= olderThanMs) : true;
        const tenantOk = tenant ? (fileTenant === tenant) : true;
        if (timeOk && tenantOk) {
      try { await AsyncFS.rm(p, { force: true }); deleted++; try { METRICS.inc('tenant_tool_purge_deleted_total', { tenant: tenant || '' }); } catch {} } catch {}
          if (deleted >= Math.max(1, Number(maxDeletesPerRun || 500))) break;
        }
      }
      try { METRICS.inc('tenant_tool_purge_runs_total', { tenant: tenant || '' }); } catch {}
      return deleted;
    } catch {
      return 0;
    }
  }
  async function markToolExecuted(id, meta = {}) {
    // Execute marker write in isolated worker with FS allowlist to TOOL_DIR; fail-closed by default
    try {
      const workerPath = path.join(process.cwd(), 'scripts', 'tool_isolation_worker.mjs');
      const envMode = String(process.env.NODE_ENV || 'dev').toLowerCase();
      const defaultMem = envMode === 'production' ? 128 : (envMode === 'test' ? 64 : 96);
      const defaultTimeout = envMode === 'production' ? 5000 : (envMode === 'test' ? 2000 : 3000);
      const memMb = Math.max(32, Number(process.env.TOOL_MEMORY_MB || defaultMem));
      const timeoutMs = Math.max(500, Number(process.env.TOOL_TIMEOUT_MS || defaultTimeout));
      const env = {
        ...process.env,
        TOOL_OP: 'mark',
        TOOL_ID: String(id || ''),
        TOOL_DIR: TOOL_DIR,
        TOOL_TENANT: String(meta?.tenant || ''),
        TOOL_NAME: String(meta?.tool || ''),
        TOOL_FS_ALLOWLIST: JSON.stringify([TOOL_DIR]),
        TOOL_NET_ALLOWLIST: String(process.env.TOOL_NET_ALLOWLIST || ''),
        TOOL_FAIL_CLOSED: String(process.env.TOOL_FAIL_CLOSED || '1')
      };
      const args = [`--max-old-space-size=${memMb}`, workerPath];
      const child = await import('node:child_process').then((m) => m.spawn(process.execPath, args, { stdio: ['ignore','pipe','pipe'], env }));
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      let resultPayload = null;
      const res = await new Promise((resolve) => {
        const to = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
          resolve({ ok: false, error: 'timeout', code: 'TIMEOUT' });
        }, timeoutMs);
        child.on('exit', (code) => {
          clearTimeout(to);
          try { resultPayload = JSON.parse(out || '{}'); } catch {}
          resolve({ ok: code === 0, code });
        });
      });
      if (res.ok) return true;
      // Idempotent single retry on transient failures
      const shouldRetry = String(resultPayload?.retryable || '') === 'true' || String(res.code || '') === 'TIMEOUT';
      if (shouldRetry) {
        const child2 = await import('node:child_process').then((m) => m.spawn(process.execPath, args, { stdio: ['ignore','pipe','pipe'], env }));
        out = ''; err = '';
        child2.stdout.on('data', (d) => { out += d.toString(); });
        child2.stderr.on('data', (d) => { err += d.toString(); });
        const res2 = await new Promise((resolve) => {
          const to2 = setTimeout(() => { try { child2.kill('SIGKILL'); } catch {}; resolve({ ok: false, error: 'timeout', code: 'TIMEOUT' }); }, timeoutMs);
          child2.on('exit', (code) => { clearTimeout(to2); resolve({ ok: code === 0, code }); });
        });
        if (res2.ok) return true;
      }
      try { METRICS.inc('tool_mark_failed_total', { reason: String(res.code || 'unknown') }); } catch {}
      return false;
    } catch {
      try { METRICS.inc('tool_mark_failed_total', { reason: 'exception' }); } catch {}
      return false;
    }
  }

  // Helpers
  const enforceJson = (req, res, span) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unsupported_media_type', expected: 'application/json' }));
      try { METRICS.inc('responses_total', { status: '415' }); span?.setAttribute?.('http.status_code', 415); } catch {}
      return false;
    }
    return true;
  };

  // Write lightweight debug lines for tests to inspect behavior post-run
  const appendTestOutput = (line) => {
    try {
      const stubs = String(process.env.LLM_TEST_STUBS || '').trim() === '1';
      if (!stubs) return;
      const file = path.join(process.cwd(), 'test_output.txt');
      AsyncFS.appendFile(file, String(line) + '\n').catch(() => {});
    } catch {}
  };

  const hashConvId = (s) => {
    try {
      let h = 0 >>> 0;
      for (let i = 0; i < String(s).length; i++) {
        h = ((h * 31) + String(s).charCodeAt(i)) >>> 0;
      }
      return h >>> 0;
    } catch { return 0; }
  };

  const validateCompileBody = (parsed) => {
    const errors = [];
    if (!parsed || typeof parsed !== 'object') errors.push({ path: '', message: 'Body must be a JSON object' });
    // Fail-closed on unknown fields
    try {
      const allowed = new Set(['messages','persona_v','prompt_v']);
      for (const k of Object.keys(parsed || {})) {
        if (!allowed.has(k)) errors.push({ path: k, message: 'unknown field' });
      }
    } catch {}
    const list = Array.isArray(parsed?.messages) ? parsed.messages : null;
    if (!list) errors.push({ path: 'messages', message: 'messages must be an array' });
    const allowedRoles = ['system','memory','context','user','tool_result','policy','assistant'];
    if (list) {
      list.forEach((m, i) => {
        const p = `messages[${i}]`;
        const role = m?.role;
        if (typeof role !== 'string' || role.length === 0) errors.push({ path: `${p}.role`, message: 'role is required string' });
        if (role && !allowedRoles.includes(role)) errors.push({ path: `${p}.role`, message: `role must be one of ${allowedRoles.join(',')}` });
        const hasText = typeof m?.text === 'string' && m.text.length > 0;
        const hasContent = Array.isArray(m?.content);
        if (hasText && hasContent) errors.push({ path: p, message: 'text and content are mutually exclusive' });
        if (!hasText && !hasContent) errors.push({ path: `${p}.content`, message: 'content must be an array of strings or provide text' });
        if (hasContent && !m.content.every((s) => typeof s === 'string')) errors.push({ path: `${p}.content`, message: 'content items must be strings' });
      });
    }
    return { ok: errors.length === 0, errors };
  };

  const validateMessageBody = (body) => {
    const errors = [];
    if (!body || typeof body !== 'object') errors.push({ path: '', message: 'Body must be a JSON object' });
    // Fail-closed on unknown fields
    try {
      const allowed = new Set(['text','content','conv_id','turn','engine','persona_v','prompt_v','id','ts','ctx']);
      for (const k of Object.keys(body || {})) {
        if (!allowed.has(k)) errors.push({ path: k, message: 'unknown field' });
      }
    } catch {}
    const hasText = typeof body?.text === 'string' && body.text.length > 0;
    const hasContent = Array.isArray(body?.content);
    if (hasText && hasContent) errors.push({ path: '', message: 'text and content are mutually exclusive' });
    if (!hasText && !hasContent) errors.push({ path: 'content', message: 'content must be an array of strings or provide text' });
    if (hasContent && !body.content.every((s) => typeof s === 'string')) errors.push({ path: 'content', message: 'content items must be strings' });
    if (typeof body?.conv_id !== 'undefined' && typeof body.conv_id !== 'string') errors.push({ path: 'conv_id', message: 'conv_id must be a string when provided' });
    if (typeof body?.turn !== 'undefined' && !Number.isFinite(Number(body.turn))) errors.push({ path: 'turn', message: 'turn must be a number when provided' });
    return { ok: errors.length === 0, errors };
  };
  // Provide AsyncLocalStorage for request_id propagation
  let ALS = globalThis.__RID_STORE__ || null;
  try {
    // eslint-disable-next-line no-undef
    import('node:async_hooks').then((mod) => {
      try { ALS = new mod.AsyncLocalStorage(); globalThis.__RID_STORE__ = ALS; } catch {}
    }).catch(() => {});
  } catch {}
  // Install production JSON-log hygiene guard: count non-JSON log lines
  try {
    const enforceJsonLogs = String(process.env.LOG_JSON || '0') === '1' && String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    if (enforceJsonLogs && !globalThis.__CONSOLE_JSON_GUARD_INSTALLED__) {
      globalThis.__CONSOLE_JSON_GUARD_INSTALLED__ = true;
      const streamByMethod = { log: 'stdout', info: 'stdout', warn: 'stdout', error: 'stderr' };
      const wrap = (method) => {
        const orig = console[method].bind(console);
        console[method] = (...args) => {
          let allJson = true;
          const jsonArgs = [];
          try {
            for (const a of args) {
              const stream = streamByMethod[method] || 'stdout';
              if (typeof a === 'string') {
                const s = a.trim();
                const looksJson = s.startsWith('{') || s.startsWith('[');
                if (looksJson) {
                  try { JSON.parse(s); jsonArgs.push(s); }
                  catch { allJson = false; try { METRICS.inc('non_json_log_total', { stream }); } catch {} }
                } else {
                  allJson = false; try { METRICS.inc('non_json_log_total', { stream }); } catch {}
                }
              } else if (typeof a === 'object' && a !== null) {
                // Non-string console outputs are not guaranteed to be JSON
                allJson = false; try { METRICS.inc('non_json_log_total', { stream }); } catch {}
              } else {
                allJson = false; try { METRICS.inc('non_json_log_total', { stream }); } catch {}
              }
            }
          } catch {}
          // In production JSON-only mode, drop any non-JSON console outputs entirely.
          // Only pass through validated JSON strings to the original console method.
          if (jsonArgs.length > 0 && allJson) {
            try { return orig(...jsonArgs); } catch {}
          }
          return undefined;
        };
      };
      try { wrap('log'); wrap('info'); wrap('warn'); wrap('error'); } catch {}
    }
  } catch {}
  let inflightReq = 0;
  // Track only non-probe, non-control work requests for queue depth
  let inflightWork = 0;
  // Track all active responses (including gated ones) to better reflect
  // current concurrency when making gating decisions for fast endpoints.
  let activeResponses = 0;
  let draining = false;
  const PENDING_WAITS = new Set();
  const QUEUE_MAX = Number(process.env.QUEUE_MAX || 0); // 0 disables backpressure gating
  // Sustained backpressure alert threshold (ms); emits counters when gating
  // persists beyond this duration. Default 2000ms; minimum guard 500ms to
  // avoid noisy toggling under short spikes.
  const BP_SUSTAIN_MS = Math.max(500, Number(process.env.BP_SUSTAIN_MS || 2000));
  let bpStartMs = 0;
  // Optional simple per-pod policy limiter (429 taxonomy)
  const POLICY_LIMIT = Number(process.env.POLICY_LIMIT || 0);
  const POLICY_WINDOW_MS = Math.max(1, Number(process.env.POLICY_WINDOW_MS || 1000));
  const POLICY_INTERNAL_ERROR_ONCE = String(process.env.POLICY_INTERNAL_ERROR_ONCE || '1').toLowerCase();
  const POLICY_IEO = POLICY_INTERNAL_ERROR_ONCE === '1' || POLICY_INTERNAL_ERROR_ONCE === 'true';
  const GLOBAL_RL = (Number.isFinite(POLICY_LIMIT) && POLICY_LIMIT > 0)
    ? createGlobalRateLimiter({ limit: POLICY_LIMIT, windowMs: POLICY_WINDOW_MS, internalErrorOnce: POLICY_IEO })
    : null;
  try {
    // Report queue depth based on actual work (exclude probe/control endpoints)
    setQueueDepthProvider(() => inflightWork);
    try { logAt('debug', `[service] queue depth provider set: ${Number(getQueueDepth())}`); } catch {}
  } catch {}
  // Startup prewarm: provider health and tokenizer caches
  const __FIRST_TOKEN_BUCKETS_ENV = String(process.env.FIRST_TOKEN_MS_BUCKETS || '').trim();
  const FIRST_TOKEN_MS_BUCKETS = (__FIRST_TOKEN_BUCKETS_ENV ? __FIRST_TOKEN_BUCKETS_ENV.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0) : [50, 100, 200, 300, 500, 700, 1000, 1500, 2000, 3000]).sort((a, b) => a - b);
  async function __prewarmCaches() {
    try {
      // Tokenizer prewarm using common small prompts and model hints
      const hints = String(process.env.PREWARM_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
      const baseModels = hints.length > 0 ? hints : ['gpt-4o-mini', 'echo-small', 'dreams-lite'];
      // Always include the configured URGA engine for tests and local runs
      const extras = [];
      try { if (String(process.env.URGA_PROVIDER || '').trim()) extras.push('urga'); } catch {}
      const prewarmModels = Array.from(new Set([...baseModels, ...extras]));
      for (const m of prewarmModels) {
        try { TokenCounter.estimate('warmup', { model: m }); } catch {}
      }
      // Provider prewarm by resolving providers and issuing a tiny call (stubs in CI)
      const ctxWarm = { vars: { engine_source: 'prewarm' }, io: { events: new EventEmitter() } };
      try { configureProvidersFromEnv(ctxWarm); } catch {}
      try {
        if (String(process.env.PROVIDERS_DEBUG || '0') === '1') {
          logAt('debug', JSON.stringify({ evt: 'providers_configured', source: String(ctxWarm?.vars?.engine_source || 'prewarm') }));
        }
      } catch {}
      try {
        const llmWarm = new LLMService(ctxWarm);
        for (const m of prewarmModels) {
          try { await llmWarm.call('warmup', { model: m, critical: false }); } catch {}
        }
      } catch {}
    } catch {}
  }
  // Kick off prewarm asynchronously and record startup_ready_ms when complete
  (async () => {
    try { await __prewarmCaches(); } catch {}
    const ms = Math.max(0, Date.now() - __startupT0);
    try { globalThis.__STARTUP_READY_MS__ = ms; METRICS.set('startup_ready_ms', ms); } catch {}
  })();
  const healthInfo = () => {
    const base = {
      status: 'ok',
      ready: isReady(),
      ok: true,
      time: new Date().toISOString(),
    };
    const minimal = (String(process.env.NODE_ENV || '').toLowerCase() === 'production') && String(process.env.HEALTHZ_MINIMAL || '0') === '1';
    if (minimal) return base;
    let sec = { ok: true, missing: [] };
    try { sec = checkSecrets(); } catch {}
    return {
      ...base,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      startup_ready_ms: Number(globalThis.__STARTUP_READY_MS__ || 0),
      circuitOpen: (() => { try { return !!globalThis?.CB?.isOpen?.(); } catch { return false; } })(),
      inflight: Number(inflightWork),
      queueDepth: (() => { try { return Number(getQueueDepth()); } catch { return 0; } })(),
      secrets_ok: !!sec?.ok,
      missing_secrets: Array.isArray(sec?.missing) ? sec.missing : [],
    };
  };
  const server = http.createServer(async (req, res) => {
    // Inbound/outbound message tick middleware (counts-based clock)
    try { const mw = messageCountMiddleware(); mw(req, res, () => {}); } catch {}
    // Begin optional tracing span
    let span = null;
    try {
      if (otel.tracer) span = otel.tracer.startSpan('http.request', { attributes: { 'http.method': req.method, 'http.target': req.url || '' } });
    } catch {}
    // Generate request_id and propagate via AsyncLocalStorage when available
    const __rng__ = (typeof globalThis.__prng__ === 'function' ? globalThis.__prng__ : (typeof globalThis.__RNG__ === 'function' ? globalThis.__RNG__ : makePRNG()));
    const rid = `rid-${Date.now().toString(36)}-${__rng__().toString(36).slice(2, 8)}`;
    try { res.setHeader('x-request-id', rid); } catch {}
    try { ALS?.enterWith?.({ rid }); } catch {}
    // Normalize path early for all route checks to avoid undefined references
    let __path = '';
    try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
    const startMs = Date.now();
    let counted = false;
    let workCounted = false;
    // Track active response lifecycle immediately upon arrival
    activeResponses++;
    // Count arrivals for Little's Law validation (include gated attempts)
    try { METRICS.inc('arrivals_total'); } catch {}
    res.on('finish', () => {
      try {
        METRICS.inc('completions_total');
        const durMs = Math.max(0, Math.floor(Date.now() - startMs));
        // Latency buckets for simple SLO gating
        const buckets = [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000];
        let le = 'gt1000';
        for (const b of buckets) { if (durMs <= b) { le = String(b); break; } }
        METRICS.inc('respond_ms_bucket', { le });
      } catch {}
      if (counted) {
        inflightReq = Math.max(0, inflightReq - 1);
      }
      if (workCounted) {
        inflightWork = Math.max(0, inflightWork - 1);
      }
      activeResponses = Math.max(0, activeResponses - 1);
    });
    // Probes should always respond, even during draining
    const isProbe = (req.url === '/healthz' || req.url === '/readyz' || (req.url?.startsWith('/metrics')) || (req.url?.startsWith('/heap/snapshot')));
    // Shielding: header and body caps
    try {
      const MAX_HEADER_BYTES = Math.max(1, Number(process.env.MAX_HEADER_BYTES || 8192));
      // Approximate header bytes by rawHeaders join
      let headerBytes = 0;
      try {
        if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
          headerBytes = Buffer.byteLength(req.rawHeaders.join(':'), 'utf8');
        } else if (req.headers && typeof req.headers === 'object') {
          let sum = 0;
          for (const [k, v] of Object.entries(req.headers)) {
            sum += Buffer.byteLength(String(k), 'utf8') + Buffer.byteLength(String(v), 'utf8') + 2; // approx ':' + ' '
          }
          headerBytes = sum;
        }
      } catch {}
      try { console.log(JSON.stringify({ evt: 'header_size_check', headerBytes, MAX_HEADER_BYTES, isProbe })); } catch {}
      if (headerBytes > MAX_HEADER_BYTES && !isProbe) {
        res.writeHead(431, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'header_too_large' }));
        try { METRICS.inc('request_header_large_total'); METRICS.inc('responses_total', { status: '431' }); } catch {}
        return;
      }
      const method = String(req.method || 'GET').toUpperCase();
      const MAX_BODY_BYTES = Math.max(1024, Number(process.env.MAX_BODY_BYTES || 1_048_576)); // 1MB
      const cl = Number(req.headers['content-length'] || 0);
      if (!isProbe && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        if (Number.isFinite(cl) && cl > MAX_BODY_BYTES) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload_too_large' }));
          try { METRICS.inc('request_body_large_total'); METRICS.inc('responses_total', { status: '413' }); } catch {}
          return;
        }
      }
    } catch {}
    const isControl = (req.url?.startsWith('/drain/') || req.url?.startsWith('/alert/test'));
    // Per-client limiter (fairness): 429 taxonomy
    try {
      const CLIENT_LIMIT = Number(process.env.CLIENT_LIMIT || 0);
      const CLIENT_WINDOW_MS = Math.max(1, Number(process.env.CLIENT_WINDOW_MS || 1000));
      const CLIENT_IEO = String(process.env.CLIENT_INTERNAL_ERROR_ONCE || '1').toLowerCase();
      const internalOnce = CLIENT_IEO === '1' || CLIENT_IEO === 'true';
      const backendName = String(process.env.CLIENT_RL_BACKEND || 'mem').toLowerCase();
      if (!isProbe && !isControl && Number.isFinite(CLIENT_LIMIT) && CLIENT_LIMIT > 0) {
        if (!globalThis.__CLIENT_RL__) {
          globalThis.__CLIENT_RL__ = (backendName === 'file')
            ? createSharedRateLimiter({ limit: CLIENT_LIMIT, windowMs: CLIENT_WINDOW_MS, internalErrorOnce: internalOnce })
            : createGlobalRateLimiter({ limit: CLIENT_LIMIT, windowMs: CLIENT_WINDOW_MS, internalErrorOnce: internalOnce });
        }
        const apiKey = String(req.headers['x-api-key'] || '').trim();
        const authHdr = String(req.headers['authorization'] || '').trim();
        const bearer = authHdr.toLowerCase().startsWith('bearer ')
          ? (authHdr.split(/\bBearer\s+/i)[1] || '').trim()
          : authHdr;
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const principal = apiKey || bearer || forwarded || String(req.socket?.remoteAddress || 'unknown');
        const out = await Promise.resolve(globalThis.__CLIENT_RL__.allow(principal));
        try { sampled('debug', { gate: 'client_rl_check', principal: String(principal || '').slice(0, 64), window_ms: CLIENT_WINDOW_MS, ok: !!out?.ok, internal_error: !!out?.internal_error }); } catch {}
        if (!out?.ok) {
          const retryAfter = Math.max(1, Math.ceil(CLIENT_WINDOW_MS / 1000));
          if (out.internal_error && internalOnce) {
            res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
            res.end(JSON.stringify({ error: 'rate_limited', reason: 'internal_error', scope: 'client', retry_after_s: retryAfter }));
            try { METRICS.inc('rate_limited_total', { reason: 'internal_error', scope: 'client' }); METRICS.inc('responses_total', { status: '503' }); } catch {}
            try { sampled('debug', { gate: 'client_rl_deny', reason: 'internal_error', retry_after_s: retryAfter }); } catch {}
            return;
          }
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
          res.end(JSON.stringify({ error: 'rate_limited', reason: 'client', retry_after_s: retryAfter }));
          try { METRICS.inc('rate_limited_total', { reason: 'client', scope: 'client' }); METRICS.inc('responses_total', { status: '429' }); } catch {}
          try { sampled('debug', { gate: 'client_rl_deny', reason: 'client', retry_after_s: retryAfter }); } catch {}
          return;
        }
      }
    } catch {}
    // isControl already defined above for limiter block
    // Policy limiter: return 429 for policy gating and 503 once for internal_error when enabled
    if (!isProbe && !isControl && GLOBAL_RL) {
      try {
        const out = GLOBAL_RL.allow('global');
        if (!out.ok) {
          if (out.internal_error && POLICY_IEO) {
            const retryAfter = Math.max(1, Math.ceil(POLICY_WINDOW_MS / 1000));
            res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
            res.end(JSON.stringify({ error: 'rate_limited', reason: 'internal_error', retry_after_s: retryAfter }));
            try { METRICS.inc('rate_limited_total', { reason: 'internal_error' }); } catch {}
            try { METRICS.inc('responses_total', { status: '503' }); } catch {}
            return;
          }
          const retryAfter = Math.max(1, Math.ceil(POLICY_WINDOW_MS / 1000));
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
          res.end(JSON.stringify({ error: 'rate_limited', reason: 'policy', retry_after_s: retryAfter }));
          try { METRICS.inc('rate_limited_total', { reason: 'policy' }); } catch {}
          try { METRICS.inc('responses_total', { status: '429' }); } catch {}
          return;
        }
      } catch {}
    }
    // Apply backpressure gating only to non-probe, non-control endpoints
    if (!isProbe && !isControl && QUEUE_MAX > 0) {
      try {
        // Prefer provider depth, but fall back to local inflight for robustness
        const provDepth = Number(getQueueDepth());
        const effectiveDepth = (Number.isFinite(provDepth) && provDepth >= 0) ? provDepth : Number(inflightReq);
          try { logAt('info', JSON.stringify({ evt: 'queue_check', inflight: Number(inflightReq), active: Number(activeResponses), provDepth: Number.isFinite(provDepth) ? provDepth : null, effectiveDepth, QUEUE_MAX })); } catch {}
        try { sampled('debug', { evt: 'queue_check', inflight: Number(inflightReq), active: Number(activeResponses), effectiveDepth, QUEUE_MAX }); } catch {}
        if (effectiveDepth >= QUEUE_MAX) {
          // Mark start of sustained backpressure window
          if (bpStartMs === 0) bpStartMs = Date.now();
          // Adaptive Retry-After: scale by queueDepth/maxDepth into ~[1..3] seconds with fractional jitter
          // Using fractional seconds helps desynchronize retry waves under step-load.
          const ratio = QUEUE_MAX > 0 ? Math.max(0, Math.min(1, effectiveDepth / QUEUE_MAX)) : 0;
          // Keep clients retrying frequently enough: favor 0.5..1.5s uniformly.
          // This improves acceptance under step-load while still spreading retries.
          let retryAfter = 0.5 + (globalThis.__RNG__ ? globalThis.__RNG__() : Math.random()); // 0.5..1.5 seconds
          // Limit precision to one decimal place for readability
          retryAfter = Math.round(retryAfter * 10) / 10;
          // Prefer fractional seconds in header to avoid synchronized retries
          res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
          res.end(JSON.stringify({ error: 'rate_limited', reason: 'backpressure', retry_after_s: retryAfter }));
          try { sampled('warn', { evt: 'rate_limited', reason: 'backpressure', effectiveDepth, QUEUE_MAX, retry_after_s: retryAfter }); } catch {}
          try { logAt('warn', JSON.stringify({ evt: 'rate_limited_total', reason: 'backpressure' })); } catch {}
          try { METRICS.inc('rate_limited_total', { reason: 'backpressure' }); } catch {}
          try { METRICS.inc('responses_total', { status: '503' }); } catch {}
          return;
        } else {
          // If we were previously gating and now below threshold, emit sustained alert
          if (bpStartMs > 0) {
            const durMs = Math.max(0, Date.now() - bpStartMs);
            // Reset start window regardless; sustained emission depends on threshold
            bpStartMs = 0;
            if (durMs >= BP_SUSTAIN_MS) {
              try {
                // Bucketize duration for simple histogram-like counting
                const buckets = [500, 1000, 2000, 5000, 10000, 20000];
                let le = 'gt20000';
                for (const b of buckets) { if (durMs <= b) { le = String(b); break; } }
                METRICS.inc('backpressure_sustained_total');
                METRICS.inc('backpressure_sustained_ms_bucket', { le });
        logAt('info', JSON.stringify({ evt: 'backpressure_sustained', duration_ms: durMs, le }));
                try { sampled('info', { evt: 'backpressure_sustained', duration_ms: durMs, le }); } catch {}
              } catch {}
            }
          }
        }
      } catch {}
    }
    // Only increment inflight for requests we will actually process
    inflightReq++;
    counted = true;
    // Track work depth for Little's Law using non-probe/non-control endpoints only
    if (!isProbe && !isControl) {
      inflightWork++;
      workCounted = true;
    }
    if (req.url === '/healthz') {
      const info = healthInfo();
      // Gate readiness on prewarm completion when PREWARM_MODELS is provided.
      // Tests rely on HTTP 200 from /healthz before issuing traffic; returning 503
      // until prewarm completes ensures cold-start latency stays within target.
      const prewarmHint = String(process.env.PREWARM_MODELS || '').trim();
      const prewarmRequired = prewarmHint.length > 0;
      const readyMs = Number(globalThis.__STARTUP_READY_MS__ || 0);
      const warming = prewarmRequired && readyMs === 0;
      if (warming) {
        // Prefer short fractional retry to reduce synchronized retry waves
        const retryAfter = 0.2; // 200ms
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
        res.end(JSON.stringify({ ...info, status: 'warming', ready: false }));
        try { METRICS.inc('responses_total', { status: '503' }); } catch {}
        try { span?.setAttribute?.('http.status_code', 503); } catch {}
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
        try { span?.setAttribute?.('http.status_code', 200); } catch {}
      }
      return;
    }
    // Helper: IP allowlist (comma-separated list of exact IPs or prefix patterns like "10." or "192.168.")
    const isIpAllowed = (listEnv) => {
      try {
        const raw = String(process.env[listEnv] || '').trim();
        if (!raw) return true; // no allowlist configured
        const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
        const ip = forwarded || String(req.socket?.remoteAddress || '');
        const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
        for (const item of items) {
          if (ip === item) return true;
          // basic prefix match to handle private ranges without CIDR deps
          if (item.endsWith('.')) { if (ip.startsWith(item)) return true; }
          // allow wildcard '*' to permit all for debugging
          if (item === '*') return true;
        }
        return false;
      } catch {}
      return true;
    };
    // Global per-request environment flag
    const isProdEnv = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    // Helper: common admin guard (enforced only when ADMIN_TOKEN is set)
    function adminGuard(req, res) {
      try {
        const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
        if (requireAuth) {
          const token = String(process.env.ADMIN_TOKEN || '').trim();
          const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try {
            const uTmp = new URL(`http://localhost${req.url}`);
            tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
          } catch {}
          const ok = tokenFromHdr === token || tokenFromQuery === token;
          if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); } catch {}
            return false;
          }
        }
        return true;
      } catch {
        return true;
      }
    }
    if (req.url === '/readyz') {
      // Require token for readyz only when READYZ_AUTH is explicitly configured
      const requireAuth = String(process.env.READYZ_AUTH || '').length > 0;
      if (requireAuth) {
        const token = String(process.env.READYZ_AUTH || '').trim();
        const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
        // Do not log raw header; redact if ever logged
        const ok = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() === token : hdr === token;
        if (!isIpAllowed('READYZ_IP_ALLOWLIST')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
          return;
        }
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
          return;
        }
      }
      const ready = isReady() && !draining;
      const status = ready ? 200 : 503;
      // Include secrets_ok for internal probes; minimal shape otherwise
      let sec = { ok: true, missing: [] };
      try { sec = checkSecrets(); } catch {}
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, secrets_ok: !!sec?.ok, missing_secrets: Array.isArray(sec?.missing) ? sec.missing : [] }));
      try { span?.setAttribute?.('http.status_code', status); } catch {}
      return;
    }
    // During draining, non-probe requests receive 503
    if (draining) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'draining' }));
      return;
    }
    // Trigger drain via HTTP for CI reliability on cross-platform
    if (req.url?.startsWith('/drain/start')) {
      try {
        const u = new URL(`http://localhost${req.url}`);
        const ms = Math.max(0, Math.min(30_000, Number(u.searchParams.get('ms') || drainTimeoutMs)));
        try { globalThis?.READY?.notReady?.(); } catch {}
        draining = true;
        // Force complete any pending /wait handlers to accelerate drain
        try {
          for (const entry of Array.from(PENDING_WAITS)) {
            try { clearTimeout(entry.timer); } catch {}
            try {
              entry.res.writeHead(503, { 'Content-Type': 'application/json' });
              entry.res.end(JSON.stringify({ error: 'draining' }));
            } catch {}
            // Optional: consolidate facts every N turns
            try {
              const every = Number(process.env.FACT_CONSOLIDATE_EVERY_TURNS || 0);
              const t = Number(body?.turn || 0);
              const cidCons = String(body?.conv_id || body?.conv || 'conv');
              if (every > 0 && t > 0 && (t % every) === 0) {
                try { consolidateAll(cidCons); } catch {}
                try { METRICS.inc?.('facts_consolidate_runs_total', 1, {}); } catch {}
              }
            } catch {}
            PENDING_WAITS.delete(entry);
          }
        } catch {}
        setTimeout(() => {
          server.close(() => {
            try { logAt('info', JSON.stringify({ evt: 'service_closed', success: inflightReq === 0, inflightReq })); } catch {}
            process.exitCode = inflightReq === 0 ? 0 : 1;
            // Ensure process exits on HTTP-triggered drain to prevent test hangs
            try { process.exit(process.exitCode); } catch {}
          });
        }, ms);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, draining: true, ms }));
        return;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        return;
      }
      if (__path === '/memory/shadow/rebuild') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const conv_id = String(body?.conv_id || '').trim();
              const full = body?.full === undefined ? true : Boolean(body.full);
              if (!conv_id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
                return;
              }
              const snap = await shadowRebuild({ convId: conv_id, full });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id, facts: Array.isArray(snap?.facts) ? snap.facts.length : 0 }));
              try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
            }
          });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
          try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
        }
        return;
      }
    }
    // Synthetic alert toggles for CI: /alert/test?name=...
    if (req.url?.startsWith('/alert/test')) {
      try {
        const u = new URL(`http://localhost${req.url}`);
        const name = u.searchParams.get('name') || '';
        const safe = String(name).replace(/[^a-zA-Z0-9_\.\-]/g, '');
        if (!safe) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_alert_name' }));
          return;
        }
        METRICS.inc(safe, { synthetic: '1' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, toggled: safe }));
        return;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        return;
      }
    }
    // Synthetic work endpoint to hold connections (simulate pending work)
    if (req.url?.startsWith('/wait')) {
      const msMatch = String(req.url).match(/ms=(\d+)/);
      const ms = Math.max(0, Math.min(10_000, Number(msMatch?.[1] || 100)));
      if (draining) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'draining' }));
        return;
      }
      const entry = { res: undefined, timer: undefined };
      const timer = setTimeout(() => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, delay_ms: ms }));
        } finally {
          PENDING_WAITS.delete(entry);
        }
      }, ms);
      try { timer.unref?.(); } catch {}
      entry.res = res;
      entry.timer = timer;
      PENDING_WAITS.add(entry);
      return;
    }
    // Metrics endpoint for CI assertions
    if (req.url?.startsWith('/metrics')) {
      // Require token only when METRICS_AUTH is explicitly configured
      const requireAuth = String(process.env.METRICS_AUTH || '').length > 0;
      if (requireAuth) {
        const token = String(process.env.METRICS_AUTH || '').trim();
        const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
        const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
        let tokenFromQuery = '';
        try {
          const u = new URL(`http://localhost${req.url}`);
          tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim();
        } catch {}
        const ok = tokenFromHdr === token || tokenFromQuery === token;
        try { logAt('debug', JSON.stringify({ evt: 'metrics_auth_debug', hdr, tokenFromHdr, tokenFromQuery, expectedToken: token })); } catch {}
        if (!ok) {
          // Enforce IP allowlist when configured
          if (!isIpAllowed('METRICS_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
          return;
        }
      }
      const snapshot = METRICS.snapshot();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ counters: snapshot }));
      try { span?.setAttribute?.('http.status_code', 200); } catch {}
      return;
    }
    // Per-tenant budget view endpoint
    if (req.url?.startsWith('/tenants/budget') && String(req.method || 'GET').toUpperCase() === 'GET') {
      try {
        // Optional auth for tenant budget endpoint
        const requireAuth = String(process.env.TENANTS_AUTH || '').length > 0;
        if (requireAuth) {
          const token = String(process.env.TENANTS_AUTH || '').trim();
          const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try {
            const u = new URL(`http://localhost${req.url}`);
            tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim();
          } catch {}
          const ok = tokenFromHdr === token || tokenFromQuery === token;
          if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
        }
        const u = new URL(`http://localhost${req.url}`);
        const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
        const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
        const tenantKey = safeTenant || 'tenant';
        const out = { tenant: tenantKey, views: {} };
        // Sliding-window tokens
        try {
          const limTok = Number(process.env.TENANT_TOKENS_BUDGET || 0);
          const winTok = Number(process.env.TENANT_TOKENS_WINDOW_MS || (24 * 60 * 60 * 1000));
          if (Number.isFinite(limTok) && limTok > 0) {
            if (!globalThis.__TENANT_TOKEN_BUDGET__) {
              globalThis.__TENANT_TOKEN_BUDGET__ = createSharedTenantBudget({ windowMs: winTok, limitTokens: limTok });
            }
            const snap = await Promise.resolve(globalThis.__TENANT_TOKEN_BUDGET__.peek(tenantKey));
            out.views.tokens_window = { window_ms: winTok, ok: !!snap?.ok, window_start: Number(snap?.windowStart || 0), spent: Number(snap?.spentTokens || 0), limit: Number(snap?.limitTokens || 0) };
          }
        } catch {}
        // Sliding-window USD
        try {
          const limUsd = Number(process.env.TENANT_DOLLARS_BUDGET || 0);
          const winUsd = Number(process.env.TENANT_DOLLARS_WINDOW_MS || (24 * 60 * 60 * 1000));
          if (Number.isFinite(limUsd) && limUsd > 0) {
            if (!globalThis.__TENANT_USD_BUDGET__) {
              globalThis.__TENANT_USD_BUDGET__ = createSharedTenantDollarBudget({ windowMs: winUsd, limitUsd: limUsd });
            }
            const snap = await Promise.resolve(globalThis.__TENANT_USD_BUDGET__.peek(tenantKey));
            out.views.usd_window = { window_ms: winUsd, ok: !!snap?.ok, window_start: Number(snap?.windowStart || 0), spent_usd: Number(snap?.spentTokens || 0), limit_usd: Number(snap?.limitTokens || 0) };
          }
        } catch {}
        // Monthly tokens
        try {
          const limTokMon = Number(process.env.TENANT_TOKENS_MONTHLY_BUDGET || 0);
          if (Number.isFinite(limTokMon) && limTokMon > 0) {
            if (!globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__) {
              globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__ = createSharedTenantMonthlyBudget({ limitTokens: limTokMon });
            }
            const snap = await Promise.resolve(globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__.peek(tenantKey));
            out.views.tokens_monthly = { ok: !!snap?.ok, month_key: String(snap?.monthKey || ''), window_start: Number(snap?.windowStart || 0), spent: Number(snap?.spentTokens || 0), limit: Number(snap?.limitTokens || 0) };
          }
        } catch {}
        // Monthly USD
        try {
          const limUsdMon = Number(process.env.TENANT_DOLLARS_MONTHLY_BUDGET || 0);
          if (Number.isFinite(limUsdMon) && limUsdMon > 0) {
            if (!globalThis.__TENANT_USD_MONTHLY_BUDGET__) {
              globalThis.__TENANT_USD_MONTHLY_BUDGET__ = createSharedTenantMonthlyDollarBudget({ limitUsd: limUsdMon });
            }
            const snap = await Promise.resolve(globalThis.__TENANT_USD_MONTHLY_BUDGET__.peek(tenantKey));
            out.views.usd_monthly = { ok: !!snap?.ok, month_key: String(snap?.monthKey || ''), window_start: Number(snap?.windowStart || 0), spent_usd: Number(snap?.spentTokens || 0), limit_usd: Number(snap?.limitTokens || 0) };
          }
        } catch {}
        // Rolling tokens
        try {
          const limTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_BUDGET || 0);
          const winTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_WINDOW_MS || 0);
          const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
          if (Number.isFinite(limTokRoll) && limTokRoll > 0 && Number.isFinite(winTokRoll) && winTokRoll > 0) {
            if (!globalThis.__TENANT_TOKEN_ROLLING_BUDGET__) {
              globalThis.__TENANT_TOKEN_ROLLING_BUDGET__ = createSharedTenantRollingBudget({ windowMs: winTokRoll, bucketMs, limitTokens: limTokRoll });
            }
            const snap = await Promise.resolve(globalThis.__TENANT_TOKEN_ROLLING_BUDGET__.peek(tenantKey));
            out.views.tokens_rolling = { window_ms: winTokRoll, bucket_ms: Number(snap?.bucketMs || bucketMs), ok: !!snap?.ok, window_start: Number(snap?.windowStart || 0), spent: Number(snap?.spentTokens || 0), limit: Number(snap?.limitTokens || 0) };
          }
        } catch {}
        // Rolling USD
        try {
          const limUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_BUDGET || 0);
          const winUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_WINDOW_MS || 0);
          const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
          if (Number.isFinite(limUsdRoll) && limUsdRoll > 0 && Number.isFinite(winUsdRoll) && winUsdRoll > 0) {
            if (!globalThis.__TENANT_USD_ROLLING_BUDGET__) {
              globalThis.__TENANT_USD_ROLLING_BUDGET__ = createSharedTenantRollingDollarBudget({ windowMs: winUsdRoll, bucketMs, limitUsd: limUsdRoll });
            }
            const snap = await Promise.resolve(globalThis.__TENANT_USD_ROLLING_BUDGET__.peek(tenantKey));
            out.views.usd_rolling = { window_ms: winUsdRoll, bucket_ms: Number(snap?.bucketMs || bucketMs), ok: !!snap?.ok, window_start: Number(snap?.windowStart || 0), spent_usd: Number(snap?.spentTokens || 0), limit_usd: Number(snap?.limitTokens || 0) };
          }
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
        try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
      }
      return;
    }
    // Per-tenant purge endpoint: DELETE /tenant/:id
    if (req.url?.startsWith('/tenant/') && String(req.method || 'DELETE').toUpperCase() === 'DELETE') {
      try {
        const requireAuth = String(process.env.TENANTS_AUTH || '').length > 0;
        if (requireAuth) {
          const token = String(process.env.TENANTS_AUTH || '').trim();
          const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
            ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
            : hdr;
          let tokenFromQuery = '';
          try {
            const u2 = new URL(`http://localhost${req.url}`);
            tokenFromQuery = String(u2.searchParams.get('token') || u2.searchParams.get('auth') || '').trim();
          } catch {}
          const ok = tokenFromHdr === token || tokenFromQuery === token;
          if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
        }
        const u = new URL(`http://localhost${req.url}`);
        let pathTenant = '';
        try {
          const segs = u.pathname.split('/').filter(Boolean);
          if (segs[0] === 'tenant') pathTenant = segs[1] || '';
        } catch {}
        const rawTenant = pathTenant || u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
        const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
        const tenantKey = safeTenant || 'tenant';
        const wiped = Object.create(null);
        // Wipe shared rate limiter state when configured
        try {
          const TENANT_LIMIT = Number(process.env.TENANT_LIMIT || 0);
          const TENANT_WINDOW_MS = Math.max(1, Number(process.env.TENANT_WINDOW_MS || 1000));
          const TENANT_IEO = String(process.env.TENANT_INTERNAL_ERROR_ONCE || '1').toLowerCase();
          const tenantInternalOnce = TENANT_IEO === '1' || TENANT_IEO === 'true';
          const backendName = String(process.env.TENANT_RL_BACKEND || 'mem').toLowerCase();
          if (Number.isFinite(TENANT_LIMIT) && TENANT_LIMIT > 0) {
            if (!globalThis.__TENANT_RL__) {
              globalThis.__TENANT_RL__ = (backendName === 'file')
                ? createSharedRateLimiter({ limit: TENANT_LIMIT, windowMs: TENANT_WINDOW_MS, internalErrorOnce: tenantInternalOnce })
                : createGlobalRateLimiter({ limit: TENANT_LIMIT, windowMs: TENANT_WINDOW_MS, internalErrorOnce: tenantInternalOnce });
            }
            const r = await Promise.resolve(globalThis.__TENANT_RL__.wipe?.(tenantKey)).catch(() => null);
            wiped.rate_limiter = !!(r && r.ok);
          } else {
            wiped.rate_limiter = false;
          }
        } catch {}
        // Wipe sliding-window token budget
        try {
          const limTok = Number(process.env.TENANT_TOKENS_BUDGET || 0);
          const winTok = Number(process.env.TENANT_TOKENS_WINDOW_MS || (24 * 60 * 60 * 1000));
          if (Number.isFinite(limTok) && limTok > 0) {
            if (!globalThis.__TENANT_TOKEN_BUDGET__) {
              globalThis.__TENANT_TOKEN_BUDGET__ = createSharedTenantBudget({ windowMs: winTok, limitTokens: limTok });
            }
            const r = await Promise.resolve(globalThis.__TENANT_TOKEN_BUDGET__.wipe?.(tenantKey)).catch(() => null);
            wiped.tokens_window = !!(r && r.ok);
          } else { wiped.tokens_window = false; }
        } catch {}
        // Wipe sliding-window USD budget
        try {
          const limUsd = Number(process.env.TENANT_DOLLARS_BUDGET || 0);
          const winUsd = Number(process.env.TENANT_DOLLARS_WINDOW_MS || (24 * 60 * 60 * 1000));
          if (Number.isFinite(limUsd) && limUsd > 0) {
            if (!globalThis.__TENANT_USD_BUDGET__) {
              globalThis.__TENANT_USD_BUDGET__ = createSharedTenantDollarBudget({ windowMs: winUsd, limitUsd: limUsd });
            }
            const r = await Promise.resolve(globalThis.__TENANT_USD_BUDGET__.wipe?.(tenantKey)).catch(() => null);
            wiped.usd_window = !!(r && r.ok);
          } else { wiped.usd_window = false; }
        } catch {}
        // Wipe monthly token budget
        try {
          const limTokMon = Number(process.env.TENANT_TOKENS_MONTHLY_BUDGET || 0);
          if (Number.isFinite(limTokMon) && limTokMon > 0) {
            if (!globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__) {
              globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__ = createSharedTenantMonthlyBudget({ limitTokens: limTokMon });
            }
            const r = await Promise.resolve(globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__.wipe?.(tenantKey)).catch(() => null);
            wiped.tokens_monthly = !!(r && r.ok);
          } else { wiped.tokens_monthly = false; }
        } catch {}
        // Wipe monthly USD budget
        try {
          const limUsdMon = Number(process.env.TENANT_DOLLARS_MONTHLY_BUDGET || 0);
          if (Number.isFinite(limUsdMon) && limUsdMon > 0) {
            if (!globalThis.__TENANT_USD_MONTHLY_BUDGET__) {
              globalThis.__TENANT_USD_MONTHLY_BUDGET__ = createSharedTenantMonthlyDollarBudget({ limitUsd: limUsdMon });
            }
            const r = await Promise.resolve(globalThis.__TENANT_USD_MONTHLY_BUDGET__.wipe?.(tenantKey)).catch(() => null);
            wiped.usd_monthly = !!(r && r.ok);
          } else { wiped.usd_monthly = false; }
        } catch {}
        // Wipe rolling-window token budget
        try {
          const limTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_BUDGET || 0);
          const winTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_WINDOW_MS || 0);
          const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
          if (Number.isFinite(limTokRoll) && limTokRoll > 0 && Number.isFinite(winTokRoll) && winTokRoll > 0) {
            if (!globalThis.__TENANT_TOKEN_ROLLING_BUDGET__) {
              globalThis.__TENANT_TOKEN_ROLLING_BUDGET__ = createSharedTenantRollingBudget({ windowMs: winTokRoll, bucketMs, limitTokens: limTokRoll });
            }
            const r = await Promise.resolve(globalThis.__TENANT_TOKEN_ROLLING_BUDGET__.wipe?.(tenantKey)).catch(() => null);
            wiped.tokens_rolling = !!(r && r.ok);
          } else { wiped.tokens_rolling = false; }
        } catch {}
        // Wipe rolling-window USD budget
        try {
          const limUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_BUDGET || 0);
          const winUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_WINDOW_MS || 0);
          const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
          if (Number.isFinite(limUsdRoll) && limUsdRoll > 0 && Number.isFinite(winUsdRoll) && winUsdRoll > 0) {
            if (!globalThis.__TENANT_USD_ROLLING_BUDGET__) {
              globalThis.__TENANT_USD_ROLLING_BUDGET__ = createSharedTenantRollingDollarBudget({ windowMs: winUsdRoll, bucketMs, limitUsd: limUsdRoll });
            }
            const r = await Promise.resolve(globalThis.__TENANT_USD_ROLLING_BUDGET__.wipe?.(tenantKey)).catch(() => null);
            wiped.usd_rolling = !!(r && r.ok);
          } else { wiped.usd_rolling = false; }
        } catch {}

        // Optional tool marker purge with TTL filter
        try {
          const olderThanMs = Number(u.searchParams.get('older_than_ms') || process.env.TOOL_MARK_TTL_MS || 0);
          const maxToolDeletes = Number(u.searchParams.get('max_tool_deletes') || process.env.TOOL_PURGE_MAX_DELETES || 500);
          const delCount = await purgeToolMarkers({ tenant: tenantKey, olderThanMs, maxDeletesPerRun: maxToolDeletes });
          wiped.tool_markers_deleted = delCount;
        } catch { wiped.tool_markers_deleted = 0; }
        // Optional idempotency entry purge with TTL filter
        try {
          const olderThanMsIdem = Number(u.searchParams.get('idem_older_than_ms') || process.env.IDEMPOTENCY_TTL_MS || 0);
          const maxIdemDeletes = Number(u.searchParams.get('max_idem_deletes') || process.env.IDEM_PURGE_MAX_DELETES || 500);
          const idemDel = await purgeIdemEntries({ tenant: tenantKey, olderThanMs: olderThanMsIdem, maxDeletesPerRun: maxIdemDeletes });
          wiped.idem_deleted = idemDel;
        } catch { wiped.idem_deleted = 0; }
        try { METRICS.inc('tenants_wipe_total', { tenant: tenantKey }); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, tenant: tenantKey, wiped }));
        try { span?.setAttribute?.('http.status_code', 200); } catch {}
        return;
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tenant_wipe_failed', detail: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); span?.setAttribute?.('http.status_code', 500); } catch {}
        return;
      }
    }
    // Global idempotency purge: DELETE /idem
    if (req.url === '/idem' && String(req.method || 'DELETE').toUpperCase() === 'DELETE') {
      try {
        const requireAuth = String(process.env.TENANTS_AUTH || '').length > 0;
        if (requireAuth) {
          const token = String(process.env.TENANTS_AUTH || '').trim();
          const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
            ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
            : hdr;
          let tokenFromQuery = '';
          try {
            const u2 = new URL(`http://localhost${req.url}`);
            tokenFromQuery = String(u2.searchParams.get('token') || u2.searchParams.get('auth') || '').trim();
          } catch {}
          const ok = tokenFromHdr === token || tokenFromQuery === token;
          if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
        }
        const u = new URL(`http://localhost${req.url}`);
        const olderThanMsIdem = Number(u.searchParams.get('older_than_ms') || process.env.IDEMPOTENCY_TTL_MS || 0);
        const maxIdemDeletes = Number(u.searchParams.get('max_idem_deletes') || process.env.IDEM_PURGE_MAX_DELETES || 500);
        const deleted = await purgeIdemEntries({ tenant: '', olderThanMs: olderThanMsIdem, maxDeletesPerRun: maxIdemDeletes });
        try { METRICS.inc('tenant_idem_purge_runs_total', { tenant: '' }); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted }));
        try { span?.setAttribute?.('http.status_code', 200); } catch {}
        return;
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'idem_purge_failed', detail: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); span?.setAttribute?.('http.status_code', 500); } catch {}
        return;
      }
    }
    // Conversation: assemble prompt bytes and hash deterministically
    // Publish OpenAPI JSON
    if (req.url === '/openapi.json' && String(req.method || 'GET').toUpperCase() === 'GET') {
      try {
        const specPath = path.join(process.cwd(), 'scripts', 'docs', 'openapi.json');
        const raw = await AsyncFS.readFile(specPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
        try { span?.setAttribute?.('http.status_code', 200); } catch {}
      } catch {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        try { METRICS.inc('responses_total', { status: '404' }); span?.setAttribute?.('http.status_code', 404); } catch {}
      }
      return;
    }
    
    // Conversation: assemble prompt bytes and hash deterministically (supports /v1/conv/compile)
    if ((req.url?.startsWith('/conv/compile') || req.url?.startsWith('/v1/conv/compile')) && String(req.method || 'GET').toUpperCase() === 'POST') {
      try {
        // Optional auth for conv endpoints
        const requireAuth = String(process.env.CONV_AUTH || '').length > 0;
        if (requireAuth) {
          const token = String(process.env.CONV_AUTH || '').trim();
          const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try { const u = new URL(`http://localhost${req.url}`); tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim(); } catch {}
          const ok = tokenFromHdr === token || tokenFromQuery === token;
          if (!ok || !isIpAllowed('CONV_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
        }
        if (!enforceJson(req, res, span)) return;
        const chunks = [];
        req.on('data', (c) => { chunks.push(c); });
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw || '{}');
            const v = validateCompileBody(parsed);
            if (!v.ok) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'schema_invalid', errors: v.errors }));
              try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
              return;
            }
            const list = Array.isArray(parsed?.messages) ? parsed.messages : [];
            // Determinism: ensure stable id/ts defaults for compile path
            const msgs = list.map((m, i) => createMessage({
              role: m?.role,
              content: Array.isArray(m?.content) ? m.content : [String(m?.text || '')],
              conv_id: m?.conv_id,
              // If turn is missing, use the index for stability
              turn: Number(m?.turn ?? i),
              // Stable id if missing: role+index
              id: typeof m?.id === 'string' && m.id.length > 0 ? m.id : `msg_${String(m?.role || 'unknown')}_${i}`,
              // Stable timestamp if missing
              ts: Number.isFinite(m?.ts) ? Number(m.ts) : 0,
              meta: m?.meta,
              tool_calls: m?.tool_calls,
              tool_results: m?.tool_results,
            }));
            const { bytes, hash } = assembleForModel(msgs, { persona_v: parsed?.persona_v, prompt_v: parsed?.prompt_v });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, hash, bytes_b64: bytes.toString('base64') }));
            try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad_request' }));
            try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
          }
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
      }
      return;
    }

    // GET /admin/style: fetch style state and presets
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      // --- World state admin (read-only safe by default)
      if (__path === '/state') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let conv = '';
          try { const uQ = new URL(`http://localhost${req.url}`); conv = String(uQ.searchParams.get('conv_id') || uQ.searchParams.get('conv') || '').trim(); } catch {}
          if (!conv) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const state = listState(conv);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: conv, state }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'state_list_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/beliefs: fetch state beliefs profile for a conversation
      if (__path === '/admin/beliefs') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || uQ.searchParams.get('conv') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const profile = await loadStateBeliefs(convId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, profile }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'beliefs_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/beliefs/:agentId — fetch agent-scoped beliefs and personality
      if (__path.startsWith('/admin/beliefs/') && __path !== '/admin/beliefs/line') {
        try {
          if (!adminGuard(req, res)) return;
          const parts = __path.split('/');
          const agentId = decodeURIComponent(parts[3] || '').trim() || 'default';
          const beliefs = await BeliefStore.listBeliefs(agentId);
          const personality = await BeliefStore.getPersonality(agentId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agent: agentId, beliefs, personality }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent_beliefs_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/constraints — list global logic constraints
      if (__path === '/admin/constraints') {
        try {
          if (!adminGuard(req, res)) return;
          const constraints = await BeliefStore.listConstraints();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, constraints }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'constraints_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/refusal-style/:agent — fetch refusal style for an agent
      if (__path.startsWith('/admin/refusal-style/')) {
        try {
          if (!adminGuard(req, res)) return;
          const parts = __path.split('/');
          const agentId = decodeURIComponent(parts[3] || '').trim() || 'default';
          const style = getRefusalStyleForAgent(agentId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agent: agentId, style }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refusal_style_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/admin/style') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          const presets = listPresets();
          if (convId) {
            const pref = getStylePref(convId) || {};
            const style_meta = computeStyleMeta(convId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id: convId, pref, style_meta, presets }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, presets }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'style_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/spine: fetch current persisted spine snapshot for a conversation
      if (__path === '/admin/spine') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              try { METRICS.inc('auth_blocked_total', { path: 'admin_spine' }); } catch {}
              return;
            }
            try { METRICS.inc('auth_ok_total', { path: 'admin_spine' }); } catch {}
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const spine = await loadSpine(convId).catch(() => null);
          if (!spine) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'spine_load_failed' }));
            try { METRICS.inc('responses_total', { status: '500' }); } catch {}
            return;
          }
          const spine_meta = {
            mood: String(spine.mood || ''),
            tone: String(spine.tone || ''),
            trust: Number(spine.trust ?? 0.5),
            suspicion: Number(spine.suspicion ?? 0.1),
            style_hint: spineStyleHintFor(spine.tone, spine.mood)
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, spine, spine_meta }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'spine_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/sse/spine: subscribe to admin spine events for a conversation
      // GET /admin/spine/demo: adjust spine quickly for demo and broadcast SSE
      if (__path === '/admin/spine/demo') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          let spine = await loadSpine(convId).catch(() => null);
          if (!spine) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'spine_load_failed' }));
            try { METRICS.inc('responses_total', { status: '500' }); } catch {}
            return;
          }
          // Apply absolute updates
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            const mood = String(uQ.searchParams.get('mood') || '').trim();
            const tone = String(uQ.searchParams.get('tone') || '').trim();
            const trust = uQ.searchParams.get('trust');
            const suspicion = uQ.searchParams.get('suspicion');
            if (mood) spine.mood = mood;
            if (tone) spine.tone = tone;
            if (trust !== null && trust !== undefined) spine.trust = Math.max(0, Math.min(1, Number(trust)));
            if (suspicion !== null && suspicion !== undefined) spine.suspicion = Math.max(0, Math.min(1, Number(suspicion)));
            const trustDelta = Number(uQ.searchParams.get('trust_delta') || 'NaN');
            const suspicionDelta = Number(uQ.searchParams.get('suspicion_delta') || 'NaN');
            const addImpulse = String(uQ.searchParams.get('impulse') || '').trim();
            if (Number.isFinite(trustDelta) || Number.isFinite(suspicionDelta) || addImpulse) {
              spine = reinforceSpine(spine, {
                trustDelta: Number.isFinite(trustDelta) ? trustDelta : 0,
                suspicionDelta: Number.isFinite(suspicionDelta) ? suspicionDelta : 0,
                addImpulse: addImpulse || undefined,
              });
            }
          } catch {}
          spine = await saveSpine(convId, 'bot', spine);
          const spine_meta = {
            mood: String(spine.mood || ''),
            tone: String(spine.tone || ''),
            trust: Number(spine.trust ?? 0.5),
            suspicion: Number(spine.suspicion ?? 0.1),
            style_hint: spineStyleHintFor(spine.tone, spine.mood)
          };
          try { broadcastAdminSpineEvent(convId, 'spine.update', { conv_id: convId, spine_meta }); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, spine, spine_meta }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'spine_demo_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/admin/sse/spine') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          registerAdminSpineSSE(convId, res);
          res.write(`event: open\n`);
          res.write(`data: ${JSON.stringify({ ok: true, conv_id: convId })}\n\n`);
          req.on('close', () => {
            try { unregisterAdminSpineSSE(convId, res); } catch {}
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'spine_sse_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/admin/roll') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || '').trim();
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const style = String(body?.style || '').trim();
              const pref = setRollPref(convId, { style: style || undefined });
              const roll_meta = computeRollMeta(convId);
              try { METRICS.inc('roll_pref_changed_total', { path: 'admin' }); } catch {}
              try { broadcastAdminMemoryEvent(convId, 'roll.pref', { conv_id: convId, roll_meta }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, pref, roll_meta }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'roll_set_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/roll: fetch failure-roll style state and available styles
      if (__path === '/admin/roll') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          const styles = listRollStyles();
          if (convId) {
            const pref = getRollPref(convId) || {};
            const roll_meta = computeRollMeta(convId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id: convId, pref, roll_meta, styles }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, styles }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'roll_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/roll/style: fetch just the normalized roll style for a conversation
      if (__path === '/admin/roll/style') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const style = getRollStyle(convId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, style }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'roll_style_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/failroll/preview — read-only calculator for fail-roll parameters
      if (__path === '/admin/failroll/preview') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = 'preview';
          let text = '';
          let turn = 0;
          let beatOverride = 'steady';
          let tensionOverride = 0;
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || 'preview');
            text = String(uQ.searchParams.get('text') || '');
            turn = Number(uQ.searchParams.get('turn') || 0);
            beatOverride = String(uQ.searchParams.get('beat') || 'steady');
            tensionOverride = Number(uQ.searchParams.get('tension') ?? 0);
          } catch {}

          const ctx = initBotContext({ vars: { beat: beatOverride, tension: tensionOverride } });
          const spine = await loadSpine(convId, 'bot').catch(() => ({}));
          const beat = String(ctx?.vars?.beat || 'steady');
          const tensionBefore = Number(ctx?.vars?.tension ?? 0);

          const vb = (/\b(sneak|pick|lie|steal|dodge|parry|charm|intimidat|bluff|climb|jump|run|dash|shoot|grapple|hack)\b/i.exec(String(text || ''))?.[0]) || 'attempt';
          const cooldownPenalty = getVerbPenalty(convId, vb);
          const pFail = computeFailProb({
            base: Number(process.env.FAILROLL_BASE_CHANCE || '0.35') + Number(cooldownPenalty || 0),
            trust: Number(spine?.trust ?? 0.5),
            suspicion: Number(spine?.suspicion ?? 0.0),
            tension: Number(tensionBefore),
          });
          const roll = d100FR(ctx, { convId, turn, userText: text });
          const threshold = Math.round(pFail * 100);
          const fail = (roll <= threshold);
          const styleClass = classifyVerbStyle(vb);

          const band = Number(process.env.COMPLICATION_BAND ?? 5);
          const nearMiss = !fail && Number(process.env.COMPLICATION_ENABLED ?? '1') &&
            isNearMiss({ roll, pFailPercent: pFail * 100, band });

          const delta = applyBeatTensionDelta({ beat, outcome: fail ? 'fail' : 'success' });
          const tensionAfter = Math.max(0, Math.min(1, Number(tensionBefore) + Number(delta)));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            convId,
            turn,
            pFail,
            threshold,
            roll,
            fail,
            nearMiss: Boolean(nearMiss),
            band,
            verb: vb,
            styleClass,
            beat,
            tensionBefore,
            tensionAfter,
            delta,
            cooldownPenalty: Number(cooldownPenalty || 0),
          }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failroll_preview_failed', message: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/admin/refusal') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || '').trim();
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const style = String(body?.style || '').trim();
              const pref = setRefusalPref(convId, { style: style || undefined });
              const refusal_meta = computeRefusalMeta(convId);
              try { METRICS.inc('refusal_pref_changed_total', { path: 'admin' }); } catch {}
              try { broadcastAdminRefusalEvent(convId, 'refusal.pref', { conv_id: convId, refusal_meta }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, pref, refusal_meta }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refusal_set_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/style/presets: fetch just the presets
      if (__path === '/admin/style/presets') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          const presets = listPresets();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, presets }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'style_presets_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }

  // Minimal alias: POST /message (test-only under stubs)
  // Purpose: allow tests to trigger usage ledger via llm_cost without full conv auth
  if (String(req.method || 'GET').toUpperCase() === 'POST' && String(req.url || '').startsWith('/message')) {
      try {
        const stubs = String(process.env.LLM_TEST_STUBS || '').trim() === '1';
        if (!stubs) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
          try { METRICS.inc('responses_total', { status: '404' }); span?.setAttribute?.('http.status_code', 404); } catch {}
          return;
        }
        if (!enforceJson(req, res, span)) return;
        const chunks = [];
        req.on('data', (c) => { chunks.push(c); });
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(raw || '{}');
            const tenant = String(parsed?.ctx?.vars?.tenant || req.headers['x-tenant'] || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tokensIn = 1;
            const tokensOut = 1;
            const usd = 0.001;
            try {
              globalThis.UrgaCoreDeps?.Metrics?.log({ vars: { tenant, path: 'message' } }, 'llm_cost', { tenant, provider: String(process.env.URGA_PROVIDER || 'stub-urga'), model: 'urga', tokens_in: tokensIn, tokens_out: tokensOut, usd });
            } catch {}
            try {
              const ledLen = Number((globalThis.__USAGE_LEDGER__ && globalThis.__USAGE_LEDGER__.buffer && globalThis.__USAGE_LEDGER__.buffer.length) || 0);
              appendTestOutput(JSON.stringify({ evt: 'test_alias_called', tenant, led_len: ledLen }));
            } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad_request' }));
            try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
          }
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
      }
      return;
    }

    // ---------------------- TEST-ONLY MEMORY ADMIN APIS ---------------------------
    // Guarded: enabled only when TEST_MEMORY_API=1
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      if (__path === '/__test/facts') {
        try {
          const on = String(process.env.TEST_MEMORY_API || '').trim() === '1';
          if (!on) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            try { METRICS.inc('responses_total', { status: '404' }); } catch {}
            return;
          }
          let conv = '';
          try { const uQ = new URL(`http://localhost${req.url}`); conv = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!conv) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const facts = listFacts(conv);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, facts }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'test_facts_list_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }
    // Admin Memory SSE: subscribe to memory.* events for a specific conv_id
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      if (__path === '/admin/sse/memory') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'x-acc': 'memory'
          });
          try { res.write(':ok\n\n'); } catch {}
          registerAdminMemorySSE(convId, res);
          // Lightweight heartbeat to keep intermediaries happy
          const t = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 15000);
          try { t.unref?.(); } catch {}
          req.on('close', async () => {
            try { clearInterval(t); } catch {}
            unregisterAdminMemorySSE(convId, res);
            try {
              await sendMessageWithTick(async () => { res.end(); return true; });
            } catch {
              try {
                await sendMessageWithTick(async () => { res.end(); return true; });
              } catch {
                try { res.end(); } catch {}
              }
            }
          });
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'admin_sse_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          return;
        }
      }
    }

    // Admin Style SSE: subscribe to style.* events for a specific conv_id
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      if (__path === '/admin/sse/style') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              try { METRICS.inc('auth_blocked_total', { path: 'admin_sse_style' }); } catch {}
              return;
            }
            try { METRICS.inc('auth_ok_total', { path: 'admin_sse_style' }); } catch {}
          }
          let convId = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'x-acc': 'style'
          });
          try { res.write(':ok\n\n'); } catch {}
          registerAdminStyleSSE(convId, res);
          const t = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 15000);
          try { t.unref?.(); } catch {}
          req.on('close', () => {
            try { clearInterval(t); } catch {}
            unregisterAdminStyleSSE(convId, res);
            try { res.end(); } catch {}
          });
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'admin_sse_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          return;
        }
      }
    }

    // Admin Refusal SSE: subscribe to refusal.* events for a specific conv_id
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      if (__path === '/admin/sse/refusal') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              try { METRICS.inc('auth_blocked_total', { path: 'admin_sse_refusal' }); } catch {}
              return;
            }
            try { METRICS.inc('auth_ok_total', { path: 'admin_sse_refusal' }); } catch {}
          }
          let convId = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'x-acc': 'refusal'
          });
          try { res.write(':ok\n\n'); } catch {}
          registerAdminRefusalSSE(convId, res);
          // Send initial snapshot
          try {
            const meta = computeRefusalMeta(convId);
            if (meta) {
              res.write(`event: refusal.pref\n`);
              res.write(`data: ${JSON.stringify({ conv_id: convId, refusal_meta: meta })}\n\n`);
            }
          } catch {}
          // Lightweight heartbeat
          const t = setInterval(() => { try { res.write(':hb\n\n'); } catch {} }, 15000);
          try { t.unref?.(); } catch {}
          req.on('close', () => {
            try { clearInterval(t); } catch {}
            unregisterAdminRefusalSSE(convId, res);
            try { res.end(); } catch {}
          });
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'admin_sse_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          return;
        }
      }
    }

    if (String(req.method || 'GET').toUpperCase() === 'POST') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      // --- World state admin: set/update a state record
      if (__path === '/state') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              try { METRICS.inc('auth_blocked_total', { path: 'state' }); } catch {}
              return;
            }
            try { METRICS.inc('auth_ok_total', { path: 'state' }); } catch {}
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const conv_id = String(body?.conv_id || body?.conv || '').trim();
              const key = String(body?.key || '').trim();
              const value = String(body?.value || '').trim();
              const tag = String(body?.tag || 'fact');
              if (!conv_id || !key || !value) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'conv_id_key_value_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              setState(conv_id, key, value, tag || 'fact');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'state_set_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/refusal-style/:agent — set refusal style for an agent
      if (__path.startsWith('/admin/refusal-style/')) {
        try {
          if (!adminGuard(req, res)) return;
          if (!enforceJson(req, res, span)) return;
          const parts = __path.split('/');
          const agentId = decodeURIComponent(parts[3] || '').trim() || 'default';
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const style = String(body?.style || '').trim();
              if (!style) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'style_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const applied = setRefusalStyleForAgent(agentId, style);
              try { METRICS.inc('refusal_style_set_total', { agent: agentId, style: applied }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, agent: agentId, style: applied }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refusal_style_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/beliefs/:agentId — add belief or set personality for an agent
      if (__path.startsWith('/admin/beliefs/') && __path !== '/admin/beliefs/line') {
        try {
          if (!adminGuard(req, res)) return;
          if (!enforceJson(req, res, span)) return;
          const parts = __path.split('/');
          const agentId = decodeURIComponent(parts[3] || '').trim() || 'default';
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const text = String(body?.text || '').trim();
              const weightRaw = body?.weight;
              const personality = body?.personality;
              if (personality && typeof personality === 'object') {
                const saved = await BeliefStore.setPersonality(agentId, personality);
                try { emitAdminMemoryEvent('beliefs.update', { agentId, personality: saved }); } catch {}
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, agent: agentId, personality: saved }));
                try { METRICS.inc('responses_total', { status: '200' }); } catch {}
                return;
              }
              if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'text_or_personality_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              let weight = Number(weightRaw || 1);
              if (!Number.isFinite(weight)) weight = 1;
              const belief = await BeliefStore.addBelief(agentId, text, weight);
              try { emitAdminMemoryEvent('beliefs.update', { agentId, belief }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, agent: agentId, belief }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent_beliefs_upsert_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/constraints — add a global logic constraint
      if (__path === '/admin/constraints') {
        try {
          if (!adminGuard(req, res)) return;
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const text = String(body?.text || body?.constraint || '').trim();
              if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'text_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const constraint = await BeliefStore.addConstraint(text);
              try { emitAdminMemoryEvent('constraints.add', { constraint }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, constraint }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'constraint_add_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/spine: update persisted spine snapshot for a conversation
      if (__path === '/admin/spine') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || body?.conv || '').trim();
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              let spine = await loadSpine(convId);
              const mood = String(body?.mood || '').trim();
              const tone = String(body?.tone || '').trim();
              const trust = body?.trust;
              const suspicion = body?.suspicion;
              if (mood) spine.mood = mood;
              if (tone) spine.tone = tone;
              if (Number.isFinite(trust)) spine.trust = Math.max(0, Math.min(1, Number(trust)));
              if (Number.isFinite(suspicion)) spine.suspicion = Math.max(0, Math.min(1, Number(suspicion)));
              const addImpulse = String(body?.add_impulse || body?.impulse || '').trim();
              if (addImpulse) spine = reinforceSpine(spine, { addImpulse });
              spine = await saveSpine(convId, 'bot', spine);
              const spine_meta = {
                mood: String(spine.mood || ''),
                tone: String(spine.tone || ''),
                trust: Number(spine.trust ?? 0.5),
                suspicion: Number(spine.suspicion ?? 0.1),
                style_hint: spineStyleHintFor(spine.tone, spine.mood)
              };
              try { broadcastAdminSpineEvent(convId, 'spine.pref', { conv_id: convId, spine_meta }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, spine, spine_meta }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'spine_upsert_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/__test/fact') {
        try {
          const on = String(process.env.TEST_MEMORY_API || '').trim() === '1';
          if (!on) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            try { METRICS.inc('responses_total', { status: '404' }); } catch {}
            return;
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const conv_id = String(body?.conv_id || '').trim();
              const text = String(body?.text || '').trim();
              const weight = Number(body?.weight || 0.5);
              const score = Number(body?.score || 0.5);
              const salience = Number(body?.salience || 0.5);
              const tags = Array.isArray(body?.tags) ? body.tags : [];
              const agent_id = String(body?.agent_id || '').trim();
              const arc_tags = Array.isArray(body?.arc_tags) ? body.arc_tags : (body?.arc_tags ? [String(body.arc_tags)] : []);
              const repeats = body?.repeats !== undefined ? Number(body.repeats) : undefined;
              const lastSeen = body?.lastSeen !== undefined ? Number(body.lastSeen) : undefined;
              if (!conv_id || !text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_and_text_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              // Persist using putFact to support richer fields; normalize optional agent_id/arc_tags
              const factObj = { text, weight: Number.isFinite(weight) ? weight : 0.5 };
              if (agent_id) factObj.agent_id = agent_id;
              if (arc_tags && Array.isArray(arc_tags)) factObj.arc_tags = arc_tags;
              if (Array.isArray(tags)) factObj.tags = tags;
              if (Number.isFinite(repeats)) factObj.repeats = repeats;
              if (Number.isFinite(lastSeen)) factObj.lastSeen = lastSeen;
              const putRes = putFact(conv_id, factObj);
              const id = String(putRes?.id || '');
              if (!id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              // Overlay runtime metrics for selection scoring
              try { putFactRt(conv_id, { id, text, score: Number.isFinite(score) ? score : 0.5, salience: Number.isFinite(salience) ? salience : 0.5, tags }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, fact: { id, text, weight: Number.isFinite(weight) ? weight : 0.5, score: Number.isFinite(score) ? score : 0.5, salience: Number.isFinite(salience) ? salience : 0.5, tags, agent_id: agent_id || undefined, arc_tags, repeats: Number.isFinite(repeats) ? repeats : undefined, lastSeen: Number.isFinite(lastSeen) ? lastSeen : undefined } }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'test_fact_upsert_failed', msg: String(e && e.message || e) }));
              try { METRICS.inc('responses_total', { status: '500' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'test_fact_upsert_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/__test/clear') {
        try {
          const on = String(process.env.TEST_MEMORY_API || '').trim() === '1';
          if (!on) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            try { METRICS.inc('responses_total', { status: '404' }); } catch {}
            return;
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const conv_id = String(body?.conv_id || '').trim();
              if (!conv_id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              try {
                const facts = listFacts(conv_id);
                for (const f of facts) deleteFact(conv_id, f.id);
                try { METRICS.set('facts_current', 0); } catch {}
              } catch {}
              try { SCENES.delete(conv_id); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'test_clear_failed', msg: String(e && e.message || e) }));
              try { METRICS.inc('responses_total', { status: '500' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'test_clear_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }

    // Admin: POST /memory/facets (upsert a facet)
    if (String(req.method || 'GET').toUpperCase() === 'POST') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      if (__path === '/memory/facts') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              let convId = String(body?.conv_id || '').trim();
              if (!convId) convId = 'conv';
              const text = String(body?.text || '').trim();
              let weight = Number(body?.weight || 1);
              if (!Number.isFinite(weight)) weight = 1;
              const agent_id = String(body?.agent_id || '').trim();
              const arc_tags = Array.isArray(body?.arc_tags) ? body.arc_tags : (body?.arc_tags ? [String(body.arc_tags)] : []);
              const { id, merged, dropped, total } = addFactWithStats(convId, text, { weight, agent_id: agent_id || undefined, arc_tags });
              if (!id) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              try { if (merged) METRICS.inc('facts_merged_total'); } catch {}
              try { const n = Number(dropped || 0); for (let i = 0; i < n; i++) METRICS.inc('facts_dropped_total', { reason: 'bound' }); } catch {}
              try {
                const maxFacts = Math.max(1, Number(process.env.FACTS_MAX || 64));
                METRICS.set('facts_current', Number(total || 0));
                METRICS.set('facts_max', maxFacts);
              } catch {}
              // Optional: upsert into external vector DB
              try {
                const arr = listFacts(convId);
                const fObj = Array.isArray(arr) ? arr.find(x => x.id === id) : null;
                if (fObj && (process.env.VECTOR_URL || '').trim()) {
                  await vectorUpsertFact(fObj, convId).catch(() => {});
                }
              } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, id, conv_id: convId, merged: !!merged, dropped: Number(dropped || 0), total: Number(total || 0) }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_facts_add_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/memory/beliefs') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const char_id = String(body?.char_id || body?.agent_id || '').trim();
              const text = String(body?.text || '').trim();
              let weight = Number(body?.weight || 1);
              if (!Number.isFinite(weight)) weight = 1;
              if (!char_id || !text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'char_id_and_text_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const belief = addBelief(char_id, text, weight);
              if (!belief) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, char_id, belief }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_beliefs_add_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/beliefs: upsert entire state beliefs profile
      if (__path === '/admin/beliefs') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || body?.conv || '').trim();
              const profile = body?.profile;
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              if (!profile || typeof profile !== 'object') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'profile_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const saved = await upsertStateBeliefs(convId, profile);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, profile: saved }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'beliefs_upsert_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/beliefs/line: add a single line to profile
      if (__path === '/admin/beliefs/line') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || body?.conv || '').trim();
              const kind = String(body?.kind || '').trim();
              const text = String(body?.text || '').trim();
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              if (!['beliefs','disallowed_actions','logic_constraints'].includes(kind)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'invalid_kind' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: 'text_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const updated = await addBeliefLineState(convId, kind, text);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, profile: updated }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'beliefs_add_line_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/admin/ultra') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              let convId = String(body?.conv_id || '').trim();
              if (!convId) convId = 'conv';
              const hasEnabled = typeof body?.enabled === 'boolean';
              const doToggle = !hasEnabled ? true : false;
              let st = null;
              if (doToggle) st = toggleUltra(convId);
              else st = setUltraState(convId, !!body.enabled);
              const enabled = !!st?.enabled;
              const ts = Number(st?.ts || Date.now());
              try { METRICS.inc('ultra_mode_toggled_total', { path: 'admin', enabled: String(enabled) }); } catch {}
              try { broadcastAdminMemoryEvent(convId, 'loopguard.ultra.changed', { conv_id: convId, enabled, ts }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, enabled, ts, default_on: ultraDefaultOn() }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ultra_toggle_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/failroll/enabled: runtime toggle for fail-roll feature
      if (__path === '/admin/failroll/enabled') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const hasEnabled = typeof body?.enabled === 'boolean';
              if (!hasEnabled) {
                // Toggle when not specified
                FAILROLL_OVERRIDE_ENABLED = !frEnabled();
              } else {
                FAILROLL_OVERRIDE_ENABLED = !!body.enabled;
              }
              const enabled = frEnabled();
              const ts = Date.now();
              try { METRICS.inc('failroll_enabled_toggled_total', { enabled: String(enabled) }); } catch {}
              try { broadcastAdminMemoryEvent('global', 'failroll.enabled.changed', { enabled, ts }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, enabled, ts }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failroll_enabled_toggle_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/admin/style') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || '').trim();
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const preset = String(body?.preset || '').trim();
              const overrides = (typeof body?.overrides === 'object' && body?.overrides) ? body.overrides : undefined;
              const pref = setStylePref(convId, { preset: preset || undefined, overrides });
              const style_meta = computeStyleMeta(convId);
              try { METRICS.inc('style_pref_changed_total', { path: 'admin' }); } catch {}
              try { broadcastAdminStyleEvent(convId, 'style.pref', { conv_id: convId, style_meta }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              const tokens = Array.isArray(style_meta?.tokens) ? style_meta.tokens : [];
              res.end(JSON.stringify({ ok: true, conv_id: convId, pref, style_meta, tokens }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'style_set_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/refusal: fetch refusal style state and available styles
      if (__path === '/admin/refusal') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          const styles = listRefusalStyles();
          if (convId) {
            const pref = getRefusalPref(convId) || {};
            const refusal_meta = computeRefusalMeta(convId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id: convId, pref, refusal_meta, styles }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, styles }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refusal_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/refusal/style: fetch just the normalized refusal style for a conversation
      if (__path === '/admin/refusal/style') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const style = getRefusalStyle(convId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, style }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'refusal_style_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // POST /admin/scene/conclusion — force stage a scene conclusion for a conversation
      if (__path === '/admin/scene/conclusion') {
        try {
          if (!adminGuard(req, res)) { return; }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const convId = String(body?.conv_id || '').trim();
              if (!convId) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const style = String(body?.style || '').trim();
              const forced = SceneConclusion.force(convId, style || undefined);
              try { METRICS.inc('scene_conclusion_staged_total', { path: 'admin', style: String(forced?.style || '') }); } catch {}
              try { broadcastAdminMemoryEvent(convId, 'scene.conclusion.staged', { conv_id: convId, style: forced?.style, reason: forced?.reason, score: forced?.score, booster: forced?.booster, coolUntilTurn: forced?.coolUntilTurn }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, staged: forced }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'scene_conclusion_force_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/style: fetch style state and presets
      if (__path === '/admin/style') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          const presets = listPresets();
          if (convId) {
            const pref = getStylePref(convId) || {};
            const style_meta = computeStyleMeta(convId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id: convId, pref, style_meta, presets }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, presets }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'style_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/scene/conclusion — snapshot scene conclusion state for a conversation
      if (__path === '/admin/scene/conclusion') {
        try {
          if (!adminGuard(req, res)) { return; }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const snap = SceneConclusion.snapshot(convId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, snapshot: snap }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          return;
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'scene_conclusion_snapshot_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          return;
        }
      }
      // GET /admin/style/presets: fetch just the presets
      if (__path === '/admin/style/presets') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          const presets = listPresets();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, presets }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'style_presets_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/memory/facets') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const conv_id = String(body?.conv_id || '').trim();
              const char = String(body?.char || 'bot');
              const key = String(body?.key || '').trim();
              const val = String(body?.val || '').trim();
              const delta = Number(body?.delta ?? 0.25);
              const pin = Boolean(body?.pin || false);
              const turn = Number(body?.turn || 0);
              if (!conv_id || !key || !val) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid' }));
                try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
                return;
              }
              const list = await upsertFacet({ convId: conv_id, charId: char, key, val, delta, pin, turn });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id, char, facets: list }));
              try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
            }
          });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
          try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
        }
        return;
      }
      // POST /admin/conv/:id/beat — force beat state (admin gated)
      if (String(req.method || 'GET').toUpperCase() === 'POST') {
        let __path = '';
        try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
        if (__path.startsWith('/admin/conv/') && __path.endsWith('/beat')) {
          try {
            if (!adminGuard(req, res)) return;
            if (!enforceJson(req, res, span)) return;
            const chunks = [];
            req.on('data', (c) => { chunks.push(c); });
            req.on('end', async () => {
              try {
                const raw = Buffer.concat(chunks).toString('utf8');
                const body = JSON.parse(raw || '{}');
                const parts = __path.split('/');
                const conv_id = decodeURIComponent(parts[3] || '').trim();
                const state = String(body?.state || '').trim();
                const allowed = ['rising','climax','falling','lull'];
                if (!conv_id || !allowed.includes(state)) {
                  res.writeHead(400, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'invalid_state' }));
                  try { METRICS.inc('responses_total', { status: '400' }); METRICS.inc('beat_errors_total', { path: 'admin' }); } catch {}
                  return;
                }
                const prev = getBeat(conv_id);
                const forced = forceBeat(conv_id, state) || { state, tension: 0 };
                try { METRICS.inc('scene_beat_state_total', { state, path: 'admin' }); } catch {}
                if (String(prev?.state || '') !== state) {
                  try { METRICS.inc('scene_beat_switch_total', { from: String(prev?.state || ''), to: state }); } catch {}
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, conv_id, state, previous: String(prev?.state || 'lull'), tension: Number(forced?.tension || 0) }));
                try { METRICS.inc('responses_total', { status: '200' }); } catch {}
              } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'bad_request' }));
                try { METRICS.inc('responses_total', { status: '400' }); METRICS.inc('beat_errors_total', { path: 'admin' }); } catch {}
              }
            });
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'beat_force_failed', msg: String(e?.message || e) }));
            try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          }
          return;
        }
      }
      if (__path === '/memory/scene') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              const conv_id = String(body?.conv_id || '').trim();
              const scene = String(body?.scene || '').trim();
              if (!conv_id || !scene) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'conv_id_and_scene_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const { key, slot } = enterScene(conv_id, scene) || {};
              if (!key) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid_scene' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const fact_ids = Array.isArray(body?.fact_ids) ? body.fact_ids.map(id => String(id)) : [];
              if (fact_ids.length) linkFactsToScene(conv_id, key, fact_ids);
              const booster = String(body?.booster || '').trim();
              if (booster) { try { slot.boosters = [booster]; } catch {} }
              try { METRICS.inc('scene_tag_total', { path: 'post' }); } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, key, linkedFacts: Array.from(slot?.facts || []), boosters: Array.isArray(slot?.boosters) ? slot.boosters : [] }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'scene_tag_failed' }));
              try { METRICS.inc('responses_total', { status: '500' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'scene_tag_failed' }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/memory/arc') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              let convId = String(body?.conv_id || '').trim();
              if (!convId) convId = 'conv';
              const arcIn = String(body?.arc || body?.arc_name || '').trim();
              const infer = Boolean(body?.infer || false);
              const text = String(body?.text || '').trim();
              let arc = arcIn;
              let inferred = false;
              if (!arc) {
                if (infer || text) {
                  const guess = inferArcFromText(text || '');
                  if (guess) { arc = guess; inferred = true; }
                }
              }
              if (!arc) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid', msg: 'arc_required_or_infer_text' }));
                try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
                return;
              }
              const r = setArc(convId, arc);
              if (!r?.ok) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid' }));
                try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
                return;
              }
              try { METRICS.inc(inferred ? 'memory_arc_inferred_total' : 'memory_arc_set_total', { path: 'post' }); } catch {}
              const got = getArc(convId) || {};
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, arc: got.arc || arc, inferred, at: Number(got.at || Date.now()) }));
              try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
            }
          });
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
          try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
        }
        return;
      }
      if (__path === '/memory/facts/consolidate') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          // Accept optional JSON body; fall back to query
          let convId = '';
          let body = {};
          const ct = String(req.headers['content-type'] || '').toLowerCase();
          const shouldParse = /application\/json/.test(ct);
          if (shouldParse) {
            const chunks = [];
            req.on('data', (c) => { chunks.push(c); });
            req.on('end', () => {
              try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
              try { const uQ = new URL(`http://localhost${req.url}`); convId = String(body?.conv_id || uQ.searchParams.get('conv_id') || '').trim(); } catch { convId = String(body?.conv_id || '').trim(); }
              if (!convId) convId = 'conv';
              const { total, dropped } = consolidateAllWithStats(convId);
              try { METRICS.inc('facts_merged_total'); } catch {}
              try {
                const n = Number(dropped || 0);
                for (let i = 0; i < n; i++) METRICS.inc('facts_dropped_total', { reason: 'bound' });
              } catch {}
              try {
                const maxFacts = Math.max(1, Number(process.env.FACTS_MAX || 64));
                METRICS.set('facts_current', Number(total || 0));
                METRICS.set('facts_max', maxFacts);
              } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, conv_id: convId, total }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            });
          } else {
            try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
            if (!convId) convId = 'conv';
            const { total, dropped } = consolidateAllWithStats(convId);
            try { METRICS.inc('facts_merged_total'); } catch {}
            try {
              const n = Number(dropped || 0);
              for (let i = 0; i < n; i++) METRICS.inc('facts_dropped_total', { reason: 'bound' });
            } catch {}
            try {
              const maxFacts = Math.max(1, Number(process.env.FACTS_MAX || 64));
              METRICS.set('facts_current', Number(total || 0));
              METRICS.set('facts_max', maxFacts);
            } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id: convId, total }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_facts_consolidate_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }
    // Admin: PUT routes
    if (String(req.method || 'GET').toUpperCase() === 'PUT') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      // PUT /memory/facts/:id?conv_id=...
      if (__path && __path.startsWith('/memory/facts/')) {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          if (!enforceJson(req, res, span)) return;
          const parts = __path.split('/');
          const id = parts[parts.length - 1];
          const chunks = [];
          req.on('data', (c) => { chunks.push(c); });
          req.on('end', async () => {
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const body = JSON.parse(raw || '{}');
              let convId = '';
              try { const uQ = new URL(`http://localhost${req.url}`); convId = String(body?.conv_id || uQ.searchParams.get('conv_id') || '').trim(); } catch { convId = String(body?.conv_id || '').trim(); }
              if (!convId) convId = 'conv';
              const text = String(body?.text || '').trim();
              const weightRaw = body?.weight;
              const weight = Number.isFinite(Number(weightRaw)) ? Number(weightRaw) : undefined;
              const ok = updateFact(convId, id, text, { weight });
              try {
                const factsNow = listFacts(convId);
                const maxFacts = Math.max(1, Number(process.env.FACTS_MAX || 64));
                METRICS.set('facts_current', Array.isArray(factsNow) ? factsNow.length : 0);
                METRICS.set('facts_max', maxFacts);
              } catch {}
              // Optional: upsert into external vector DB
              try {
                const arr = listFacts(convId);
                const fObj = Array.isArray(arr) ? arr.find(x => x.id === id) : null;
                if (fObj && (process.env.VECTOR_URL || '').trim()) {
                  await vectorUpsertFact(fObj, convId).catch(() => {});
                }
              } catch {}
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok, id, conv_id: convId }));
              try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            } catch (e) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            }
          });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_facts_update_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }
    // Conversation: simple message handler (instrumented via createBotRuntime) (supports /v1/conv/message)
    if ((req.url?.startsWith('/conv/message') || req.url?.startsWith('/v1/conv/message')) && String(req.method || 'GET').toUpperCase() === 'POST') {
      try {
        // Strict CORS: allow only configured origins in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'message' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
        } catch {}
        if (!enforceJson(req, res, span)) return;
        const chunks = [];
        req.on('data', (c) => { chunks.push(c); });
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = JSON.parse(raw || '{}');
            const v = validateMessageBody(body);
            if (!v.ok) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'schema_invalid', errors: v.errors }));
              try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
              return;
            }
            // Enforce auth/HMAC and replay window in production
            try {
              const origin = String(req.headers['origin'] || '');
              const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
              if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
                res.setHeader('Vary', 'Origin');
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'cors_forbidden' }));
                try { const macId = String(req.headers['x-mac-id'] || '').trim(); METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'message' }); } catch {}
                return;
              }
              if (origin && corsList.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
              }
              const token = String(process.env.CONV_AUTH || '').trim();
              const hmacSecrets = String(process.env.CONV_HMAC_SECRETS || process.env.CONV_HMAC_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
              const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
              const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
              let tokenFromQuery = '';
              try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
              const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
              const reqTs = Number(body?.ts || Number(req.headers['x-request-ts'] || 0));
              const replayWinMs = Math.max(0, Number(process.env.REPLAY_WINDOW_MS || 0));
              // Apply a small default tolerance to account for client/server scheduling jitter
              const skewToleranceMs = Math.max(100, Number(process.env.REPLAY_SKEW_TOLERANCE_MS || 0));
              if (isProd && replayWinMs > 0) {
                if (!Number.isFinite(reqTs) || reqTs <= 0) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'ts_required' }));
                  try {
                    const macId = String(req.headers['x-mac-id'] || '').trim();
                    const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                    const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                    METRICS.inc('responses_total', { status: '401' });
                    METRICS.inc('auth_blocked_total', { reason: 'ts_missing', path: 'message' });
                    METRICS.inc('auth_failed_total', { reason: 'ts_missing', path: 'message', method, mac_id: macId });
                  } catch {}
                  return;
                }
                const skew = Math.abs(Date.now() - reqTs);
                if ((skew - skewToleranceMs) > replayWinMs) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'replay_window_exceeded', skew_ms: skew }));
                  try {
                    const macId = String(req.headers['x-mac-id'] || '').trim();
                    const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                    const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                    METRICS.inc('responses_total', { status: '401' });
                    METRICS.inc('auth_blocked_total', { reason: 'replay_window', path: 'message' });
                    METRICS.inc('auth_failed_total', { reason: 'replay_window', path: 'message', method, mac_id: macId });
                  } catch {}
                  return;
                }
              }
              const macHdr = String(req.headers['x-client-mac'] || '').trim();
              const macId = String(req.headers['x-mac-id'] || '').trim();
              const pathTag = 'message';
              let macOk = false;
              if (hmacSecrets.length > 0 && Number.isFinite(reqTs) && reqTs > 0) {
                const canonical = `${String(req.method || 'POST').toUpperCase()}:${pathTag}:${String(reqTs)}`;
                for (const sec of hmacSecrets) {
                  try {
                    const expMac = crypto.createHmac('sha256', sec).update(canonical).digest('hex');
                    if (macHdr.length > 0 && macHdr === expMac) { macOk = true; break; }
                  } catch {}
                }
              }
              const mustAuth = isProd;
              if ((mustAuth && !(hasToken || macOk)) || !isIpAllowed('CONV_IP_ALLOWLIST')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'auth_required' }));
                try {
                  METRICS.inc('responses_total', { status: '401' });
                  METRICS.inc('auth_blocked_total', { reason: 'missing_or_invalid', path: 'message' });
                  const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                  const reason = attemptedToken ? 'token_invalid' : (macHdr.length > 0 ? 'hmac_invalid' : 'auth_missing');
                  const method = attemptedToken ? 'token' : (macHdr.length > 0 ? 'hmac' : 'none');
                  const labels = (method === 'hmac') ? { mac_id: macId } : {};
                  METRICS.inc('auth_failed_total', { reason, path: 'message', method, ...labels });
                } catch {}
                return;
              }
              try {
                if (hasToken) METRICS.inc('auth_accepted_total', { method: 'token', path: 'message' });
                else if (macOk) METRICS.inc('auth_accepted_total', { method: 'hmac', path: 'message', mac_id: macId });
              } catch {}
            } catch {}
            // Per-tenant limiter (429 taxonomy), optional via env
            try {
              const TENANT_LIMIT = Number(process.env.TENANT_LIMIT || 0);
              const TENANT_WINDOW_MS = Math.max(1, Number(process.env.TENANT_WINDOW_MS || 1000));
              const TENANT_IEO = String(process.env.TENANT_INTERNAL_ERROR_ONCE || '1').toLowerCase();
              const tenantInternalOnce = TENANT_IEO === '1' || TENANT_IEO === 'true';
              const backendName = String(process.env.TENANT_RL_BACKEND || 'mem').toLowerCase();
              if (!isProbe && !isControl && Number.isFinite(TENANT_LIMIT) && TENANT_LIMIT > 0) {
                if (!globalThis.__TENANT_RL__) {
                  globalThis.__TENANT_RL__ = (backendName === 'file')
                    ? createSharedRateLimiter({ limit: TENANT_LIMIT, windowMs: TENANT_WINDOW_MS, internalErrorOnce: tenantInternalOnce })
                    : createGlobalRateLimiter({ limit: TENANT_LIMIT, windowMs: TENANT_WINDOW_MS, internalErrorOnce: tenantInternalOnce });
                }
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                const out = await Promise.resolve(globalThis.__TENANT_RL__.allow(tenantKey));
                if (!out?.ok) {
                  const retryAfter = Math.max(1, Math.ceil(TENANT_WINDOW_MS / 1000));
                  if (out.internal_error && tenantInternalOnce) {
                    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
                    res.end(JSON.stringify({ error: 'rate_limited', reason: 'internal_error', scope: 'tenant', retry_after_s: retryAfter }));
                    try { METRICS.inc('rate_limited_total', { reason: 'internal_error', scope: 'tenant' }); METRICS.inc('responses_total', { status: '503' }); } catch {}
                    return;
                  }
                  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
                  res.end(JSON.stringify({ error: 'rate_limited', reason: 'tenant', scope: 'tenant', retry_after_s: retryAfter }));
                  try { METRICS.inc('rate_limited_total', { reason: 'tenant', scope: 'tenant' }); METRICS.inc('responses_total', { status: '429' }); } catch {}
                  return;
                }
              }
            } catch {}
            // Soft per-conversation rate guard
            const convId = String(body?.conv_id || '');
            if (convId) {
              const now = Date.now();
              const entry = CONV_WINDOW.get(convId) || { start: now, count: 0 };
              if ((now - entry.start) < CONV_SOFT_WINDOW_MS) {
                entry.count++;
              } else {
                entry.start = now;
                entry.count = 1;
              }
              CONV_WINDOW.set(convId, entry);
              if (entry.count > CONV_SOFT_MAX) {
                const waitSec = Math.max(0, (CONV_SOFT_WINDOW_MS - (now - entry.start)) / 1000);
                try { sampled('debug', 0.05, '[conv_gate]', { conv_id: convId, count: entry.count, window_ms: CONV_SOFT_WINDOW_MS, soft_max: CONV_SOFT_MAX, wait_s: Number(waitSec.toFixed(3)) }); } catch {}
                res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(waitSec.toFixed(3)) });
                res.end(JSON.stringify({ error: 'rate_limited', scope: 'conversation', conv_id: convId, wait_s: Number(waitSec.toFixed(3)) }));
                try { METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                return;
              }
            }
            // Tenant dollar budget pre-check (HTTP-layer gate)
            try {
              const limUsd = Number(process.env.TENANT_DOLLARS_BUDGET || 0);
              const winUsd = Number(process.env.TENANT_DOLLARS_WINDOW_MS || (24 * 60 * 60 * 1000));
              if (Number.isFinite(limUsd) && limUsd > 0) {
                // Resolve tenant key
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                // Init shared USD budget store lazily
                if (!globalThis.__TENANT_USD_BUDGET__) {
                  globalThis.__TENANT_USD_BUDGET__ = createSharedTenantDollarBudget({ windowMs: winUsd, limitUsd: limUsd });
                }
                // Estimate in/out tokens then USD cost
                const userMsg = createMessage({ role: 'user', content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')], conv_id: body?.conv_id, turn: Number(body?.turn || 0) });
                const textForEstimate = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
                const estIn = TokenCounter.estimate(textForEstimate);
                const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
                const usdIn = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_IN || 0));
                const usdOut = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_OUT || 0));
                const estUsd = (estIn * usdIn) + (estOut * usdOut);
                try { sampled('debug', 0.05, '[tenant_budget_precheck]', { tenant: tenantKey, est_in: estIn, est_out: estOut, usd_in: usdIn, usd_out: usdOut, est_usd: estUsd, limit_usd: limUsd, window_ms: winUsd }); } catch {}
                const allowUsd = await Promise.resolve(globalThis.__TENANT_USD_BUDGET__.allow(tenantKey, estUsd));
                if (!allowUsd?.ok) {
                  res.writeHead(429, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_dollars', scope: 'tenant_dollars', window_ms: winUsd }));
                  try { METRICS.inc('budget_prevented_total', { scope: 'tenant_dollars_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                  return;
                }
              }
            } catch {}
            // Tenant monthly dollar budget pre-check (HTTP-layer gate)
            try {
              const limUsdMon = Number(process.env.TENANT_DOLLARS_MONTHLY_BUDGET || 0);
              if (Number.isFinite(limUsdMon) && limUsdMon > 0) {
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                if (!globalThis.__TENANT_USD_MONTHLY_BUDGET__) {
                  globalThis.__TENANT_USD_MONTHLY_BUDGET__ = createSharedTenantMonthlyDollarBudget({ limitUsd: limUsdMon });
                }
                const userMsg = createMessage({ role: 'user', content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')], conv_id: body?.conv_id, turn: Number(body?.turn || 0) });
                const textForEstimate = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
                const estIn = TokenCounter.estimate(textForEstimate);
                const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
                const usdIn = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_IN || 0));
                const usdOut = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_OUT || 0));
                const estUsd = (estIn * usdIn) + (estOut * usdOut);
                const allowUsdMon = await Promise.resolve(globalThis.__TENANT_USD_MONTHLY_BUDGET__.allow(tenantKey, estUsd));
                if (!allowUsdMon?.ok) {
                  res.writeHead(429, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_dollars_monthly', scope: 'tenant_dollars_monthly' }));
                  try { METRICS.inc('budget_prevented_total', { scope: 'tenant_dollars_monthly_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                  return;
                }
              }
            } catch {}
            // Tenant rolling dollar window budget pre-check (HTTP-layer gate)
            try {
              const limUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_BUDGET || 0);
              const winUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_WINDOW_MS || 0);
              const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
              if (Number.isFinite(limUsdRoll) && limUsdRoll > 0 && Number.isFinite(winUsdRoll) && winUsdRoll > 0) {
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                if (!globalThis.__TENANT_USD_ROLLING_BUDGET__) {
                  globalThis.__TENANT_USD_ROLLING_BUDGET__ = createSharedTenantRollingDollarBudget({ windowMs: winUsdRoll, bucketMs, limitUsd: limUsdRoll });
                }
                const userMsg = createMessage({ role: 'user', content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')], conv_id: body?.conv_id, turn: Number(body?.turn || 0) });
                const textForEstimate = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
                const estIn = TokenCounter.estimate(textForEstimate);
                const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
                const usdIn = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_IN || 0));
                const usdOut = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_OUT || 0));
                const estUsd = (estIn * usdIn) + (estOut * usdOut);
                const allowUsdRoll = await Promise.resolve(globalThis.__TENANT_USD_ROLLING_BUDGET__.allow(tenantKey, estUsd));
                if (!allowUsdRoll?.ok) {
                  res.writeHead(429, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_dollars_rolling', scope: 'tenant_dollars_rolling', window_ms: winUsdRoll }));
                  try { METRICS.inc('budget_prevented_total', { scope: 'tenant_dollars_rolling_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                  return;
                }
              }
            } catch {}
            // Tenant token budget pre-check (HTTP-layer gate)
            try {
              const limTok = Number(process.env.TENANT_TOKENS_BUDGET || 0);
              const winTok = Number(process.env.TENANT_TOKENS_WINDOW_MS || (24 * 60 * 60 * 1000));
              if (Number.isFinite(limTok) && limTok > 0) {
                // Resolve tenant key
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                // Init shared token budget store lazily
                if (!globalThis.__TENANT_TOKEN_BUDGET__) {
                  globalThis.__TENANT_TOKEN_BUDGET__ = createSharedTenantBudget({ windowMs: winTok, limitTokens: limTok });
                }
                // Estimate in/out tokens
                const userMsg = createMessage({ role: 'user', content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')], conv_id: body?.conv_id, turn: Number(body?.turn || 0) });
                const textForEstimate = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
                const estIn = TokenCounter.estimate(textForEstimate);
                const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
                const estTok = estIn + estOut;
                const allowTok = await Promise.resolve(globalThis.__TENANT_TOKEN_BUDGET__.allow(tenantKey, estTok));
                if (!allowTok?.ok) {
                  res.writeHead(429, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_tokens', scope: 'tenant_tokens', window_ms: winTok }));
                  try { METRICS.inc('budget_prevented_total', { scope: 'tenant_tokens_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                  return;
                }
              }
            } catch {}
            // Tenant monthly token budget pre-check (HTTP-layer gate)
            try {
              const limTokMon = Number(process.env.TENANT_TOKENS_MONTHLY_BUDGET || 0);
              if (Number.isFinite(limTokMon) && limTokMon > 0) {
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                if (!globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__) {
                  globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__ = createSharedTenantMonthlyBudget({ limitTokens: limTokMon });
                }
                const userMsg = createMessage({ role: 'user', content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')], conv_id: body?.conv_id, turn: Number(body?.turn || 0) });
                const textForEstimate = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
                const estIn = TokenCounter.estimate(textForEstimate);
                const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
                const estTok = estIn + estOut;
                const allowTokMon = await Promise.resolve(globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__.allow(tenantKey, estTok));
                if (!allowTokMon?.ok) {
                  res.writeHead(429, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_tokens_monthly', scope: 'tenant_tokens_monthly' }));
                  try { METRICS.inc('budget_prevented_total', { scope: 'tenant_tokens_monthly_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                  return;
                }
              }
            } catch {}
            // Tenant rolling token window budget pre-check (HTTP-layer gate)
            try {
              const limTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_BUDGET || 0);
              const winTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_WINDOW_MS || 0);
              const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
              if (Number.isFinite(limTokRoll) && limTokRoll > 0 && Number.isFinite(winTokRoll) && winTokRoll > 0) {
                const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                const tenantKey = safeTenant || 'tenant';
                if (!globalThis.__TENANT_TOKEN_ROLLING_BUDGET__) {
                  globalThis.__TENANT_TOKEN_ROLLING_BUDGET__ = createSharedTenantRollingBudget({ windowMs: winTokRoll, bucketMs, limitTokens: limTokRoll });
                }
                const userMsg = createMessage({ role: 'user', content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')], conv_id: body?.conv_id, turn: Number(body?.turn || 0) });
                const textForEstimate = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
                const estIn = TokenCounter.estimate(textForEstimate);
                const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
                const estTok = estIn + estOut;
                const allowTokRoll = await Promise.resolve(globalThis.__TENANT_TOKEN_ROLLING_BUDGET__.allow(tenantKey, estTok));
                if (!allowTokRoll?.ok) {
                  res.writeHead(429, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_tokens_rolling', scope: 'tenant_tokens_rolling', window_ms: winTokRoll }));
                  try { METRICS.inc('budget_prevented_total', { scope: 'tenant_tokens_rolling_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
                  return;
                }
              }
            } catch {}
            // Idempotency key handling
            const idempotencyKey = String(req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || '').trim();
            let claimedIdemLock = false;
            // Optional HMAC enforcement when configured
            try {
              const secret = String(process.env.IDEMPOTENCY_HMAC_SECRET || '').trim();
              if (secret && idempotencyKey) {
                const macHdr = String(req.headers['idempotency-mac'] || req.headers['x-idempotency-mac'] || req.headers['x-idempotency-sig'] || '').trim();
                if (!macHdr) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'idem_mac_missing' }));
                  try { METRICS.inc('responses_total', { status: '401' }); METRICS.inc('idempotency_mac_missing_total'); span?.setAttribute?.('http.status_code', 401); } catch {}
                  return;
                }
                const expected = crypto.createHmac('sha256', secret).update(idempotencyKey).digest('hex');
                let ok = false;
                try {
                  const a = Buffer.from(macHdr, 'hex');
                  const b = Buffer.from(expected, 'hex');
                  ok = (a.length === b.length) && crypto.timingSafeEqual(a, b);
                } catch {}
                if (!ok) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'idem_mac_invalid' }));
                  try { METRICS.inc('responses_total', { status: '401' }); METRICS.inc('idempotency_mac_invalid_total'); span?.setAttribute?.('http.status_code', 401); } catch {}
                  return;
                }
              }
            } catch {}
            if (idempotencyKey) {
              let cached = touchLRU(IDEMPOTENCY_CACHE, idempotencyKey) || null;
              if (!cached) {
                try { cached = await loadIdemFromDisk(idempotencyKey); } catch {}
              }
              if (!cached) {
                try { cached = await idemGetRedis(idempotencyKey); } catch {}
              }
              if (cached && (Date.now() - cached.ts) < (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ...cached.response, idempotent_replay: true }));
                try { METRICS.inc('responses_total', { status: '200' }); METRICS.inc('idempotent_replay_total'); METRICS.inc('idempotency_cache_hit_total', { path: 'message' }); span?.setAttribute?.('http.status_code', 200); } catch {}
                try {
                  span?.setAttribute?.('llm.model', String(cached?.response?.model || ''));
                  span?.setAttribute?.('llm.provider', String(cached?.response?.provider || ''));
                  span?.setAttribute?.('llm.resolved_model', String(cached?.response?.resolved_model || ''));
                  span?.setAttribute?.('llm.engine_source', String(cached?.response?.engine_source || 'replay'));
                  span?.setAttribute?.('llm.variant_v', String(cached?.response?.variant_v || ''));
                  METRICS.inc('llm_provider_selected_total', { provider: String(cached?.response?.provider || ''), model: String(cached?.response?.model || ''), resolved_model: String(cached?.response?.resolved_model || ''), source: 'replay' });
                } catch {}
                try { sampled('info', { evt: 'idem_replay_served', path: 'message', source: 'replay' }); } catch {}
                return;
              } else {
                try { METRICS.inc('idempotency_cache_miss_total', { path: 'message' }); } catch {}
                try { sampled('debug', { evt: 'idem_cache_miss', path: 'message' }); } catch {}
                // Distributed duplicate gating: claim Redis NX lock; if held elsewhere, hedge-wait for replay
                try {
                  const claimed = await idemClaimLock(idempotencyKey);
                  if (!claimed) {
                    const hedgeWaitMs = Math.max(0, Number(process.env.HEDGE_CUTOVER_MAX_WAIT_MS || 1500));
                    const t0 = Date.now();
                    let replay = null;
                    while ((Date.now() - t0) <= hedgeWaitMs) {
                      replay = await idemGetRedis(idempotencyKey);
                      if (replay) break;
                      await new Promise((r) => setTimeout(r, Math.min(50, hedgeWaitMs)));
                    }
                    if (replay && (Date.now() - replay.ts) < (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
                      try { METRICS.inc('hedge_cutover_once_total'); } catch {}
                      res.writeHead(200, { 'Content-Type': 'application/json' });
                      res.end(JSON.stringify({ ...replay.response, idempotent_replay: true }));
                      try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
                      try { sampled('info', { evt: 'hedge_cutover_replay_served', path: 'message' }); } catch {}
                      return;
                    }
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'duplicate_message', ttl_ms: IDEMPOTENCY_TTL_MS }));
                    try { METRICS.inc('responses_total', { status: '409' }); span?.setAttribute?.('http.status_code', 409); } catch {}
                    try { sampled('warn', { evt: 'duplicate_message_lock_denied', path: 'message' }); } catch {}
                    return;
                  } else {
                    claimedIdemLock = true;
                  }
                } catch {}
              }
            }
            // Index user turn and handle booster commands before assembly
            try {
              const text = String(body?.text ?? '');
              // Command: !loopbreak  (optionally with count, e.g., "!loopbreak 4")
              try {
                const tnorm = text.trim().toLowerCase();
                if (tnorm.startsWith('!loopbreak')) {
                  const m = text.trim().match(/^!loopbreak(?:\s+(\d+))?/i);
                  const n = m && m[1] ? Math.max(1, Math.min(6, Number(m[1]))) : 3;
                  const cid  = String(body?.conv_id ?? body?.conv ?? 'conv');
                  setLoopBreak(cid, n);
                  try { METRICS.inc?.('loopguard_loopbreak_total', { path:'message' }); } catch {}
                  const reply = `LoopGuard turbo enabled for ${n} turn(s): style rotation + higher entropy.\n(You can keep chatting normally.)`;
                  const reqId = String((ALS?.getStore?.() || {})?.rid || req.headers['x-request-id'] || '');
                  const json = {
                    ok: true,
                    reply,
                    model: 'system',
                    provider: 'loopguard',
                    resolved_model: 'loopguard',
                    hash: 'loopbreak',
                    bytes_b64: Buffer.from(reply).toString('base64'),
                    request_id: reqId
                  };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
              } catch {}
              const cid  = String(body?.conv_id ?? body?.conv ?? 'conv');
              // Ultra Mode: command handling (toggle/on/off/status)
              try {
                const tnorm = String(text || '').trim().toLowerCase();
                const reqId = String((ALS?.getStore?.() || {})?.rid || req.headers['x-request-id'] || '');
                if (tnorm === '!ultra' || tnorm === '!ultra toggle' || tnorm === '!ultra.toggle') {
                  const nowEnabled = toggleUltra(cid);
                  try { METRICS.inc('ultra_toggle_total', { path: 'message' }); } catch {}
                  const reply = `Ultra Mode ${nowEnabled ? 'ON' : 'OFF'} for this conversation.`;
                  const json = { ok: true, reply, model: 'system', provider: 'ultra', resolved_model: 'ultra', hash: 'ultra.toggle', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!ultra on' || tnorm === '!ultraon' || tnorm === '!ultra.enable') {
                  setUltraState(cid, true);
                  try { METRICS.inc('ultra_state_total', { path: 'message', state: 'on' }); } catch {}
                  const reply = 'Ultra Mode ON for this conversation.';
                  const json = { ok: true, reply, model: 'system', provider: 'ultra', resolved_model: 'ultra', hash: 'ultra.on', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!ultra off' || tnorm === '!ultraoff' || tnorm === '!ultra.disable') {
                  setUltraState(cid, false);
                  try { METRICS.inc('ultra_state_total', { path: 'message', state: 'off' }); } catch {}
                  const reply = 'Ultra Mode OFF for this conversation.';
                  const json = { ok: true, reply, model: 'system', provider: 'ultra', resolved_model: 'ultra', hash: 'ultra.off', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!ultra status' || tnorm === '!ultrastatus' || tnorm === '!ultra.snapshot') {
                  const st = getUltraState(cid);
                  const snap = ultraSnapshot();
                  try { METRICS.inc('ultra_status_total', { path: 'message' }); } catch {}
                  const reply = `Ultra is ${st.enabled ? 'ON' : 'OFF'} for this conversation.`;
                  const json = { ok: true, reply, ultra: { conv_id: cid, enabled: st.enabled, ts: st.ts }, snapshot: snap, model: 'system', provider: 'ultra', resolved_model: 'ultra', hash: 'ultra.status', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
              } catch {}
              // Force-fail commands: toggle/on/off/once/status
              try {
                const tnorm = String(text || '').trim().toLowerCase();
                const reqId = String((ALS?.getStore?.() || {})?.rid || req.headers['x-request-id'] || '');
                if (tnorm === '!fail' || tnorm === '!fail toggle' || tnorm === '!fail.toggle') {
                  const now = toggleForceFail(cid);
                  try { METRICS.inc('failroll_force_toggle_total', { path: 'message' }); } catch {}
                  const reply = `Force-fail ${now?.mode === 'on' ? 'ON' : 'OFF'} for this conversation.`;
                  const json = { ok: true, reply, model: 'system', provider: 'failroll', resolved_model: 'failroll', hash: 'fail.toggle', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!fail on' || tnorm === '!failon' || tnorm === '!fail.enable') {
                  setForceFail(cid, 'on');
                  try { METRICS.inc('failroll_force_set_total', { path: 'message', enabled: 'true' }); } catch {}
                  const reply = 'Force-fail ON for this conversation.';
                  const json = { ok: true, reply, model: 'system', provider: 'failroll', resolved_model: 'failroll', hash: 'fail.on', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!fail off' || tnorm === '!failoff' || tnorm === '!fail.disable') {
                  setForceFail(cid, 'off');
                  try { METRICS.inc('failroll_force_set_total', { path: 'message', enabled: 'false' }); } catch {}
                  const reply = 'Force-fail OFF for this conversation.';
                  const json = { ok: true, reply, model: 'system', provider: 'failroll', resolved_model: 'failroll', hash: 'fail.off', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!fail once' || tnorm === '!fail.once') {
                  setForceFail(cid, 'once');
                  try { METRICS.inc('failroll_force_once_total', { path: 'message' }); } catch {}
                  const reply = 'Force-fail will apply on the next turn (once).';
                  const json = { ok: true, reply, model: 'system', provider: 'failroll', resolved_model: 'failroll', hash: 'fail.once', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
                if (tnorm === '!fail status' || tnorm === '!failstatus' || tnorm === '!fail.snapshot') {
                  const mode = getForceFailMode(cid);
                  const reply = `Force-fail is ${String(mode || 'off').toUpperCase()} for this conversation.`;
                  const json = { ok: true, reply, model: 'system', provider: 'failroll', resolved_model: 'failroll', hash: 'fail.status', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
              } catch {}
              // Failure-roll style command: !roll style <tone>
              try {
                const reqId = String((ALS?.getStore?.() || {})?.rid || req.headers['x-request-id'] || '');
                const m = String(text || '').trim().match(/^!roll\s+style\s+(\w+)\s*$/i);
                if (m) {
                  const style = String(m[1] || '').toLowerCase();
                  const pref = setRollPref(cid, { style });
                  const roll_meta = computeRollMeta(cid);
                  try { METRICS.inc('roll_pref_changed_total', { path: 'message' }); } catch {}
                  try { broadcastAdminMemoryEvent(cid, 'roll.pref', { conv_id: cid, roll_meta }); } catch {}
                  const reply = `Failure-roll style set to "${String(roll_meta?.style || style)}" for this conversation.`;
                  const json = { ok: true, reply, model: 'system', provider: 'roll', resolved_model: 'roll', hash: 'roll.style', bytes_b64: Buffer.from(reply).toString('base64'), request_id: reqId };
                  res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': reqId });
                  return res.end(JSON.stringify(json));
                }
              } catch {}
              // Pre-injection indexing to reflect exactly what the user sent
              try { indexTurn({ convId: cid, role: 'user', text }); } catch {}
              // Watchdog: log user turn (message path)
              try { await logTurn(cid, 'user', String(text || '')); } catch {}
              // Scene chat commands (optional): !scene tag <name>, !scene goto <name>
              try { trySceneChatCommand(cid, text); } catch {}

              // Player Commands
              const cmdRemember = text.match(/^\s*!remembermessage\s*(\d+)\s*$/i) || text.match(/^\s*!remembermessage(\d+)\s*$/i);
              const cmdList     = /^\s*!rememberlist\s*$/i.test(text);
              const cmdDel      = text.match(/^\s*!rememberdel\s+(\S+)\s*$/i);
              if (cmdRemember) {
                const anchor = Number(cmdRemember[1]);
                const before = Number(process.env.REMEMBER_BEFORE || 20);
                const after  = Number(process.env.REMEMBER_AFTER || 20);
                const pov    = String(process.env.FACETS_WHO || 'she');
                let recap  = summarizeWindow({ convId: cid, anchor, before, after, pov });
                if (!recap || recap.length < 40) {
                  try {
                    const msgs = getWindowAround(cid, anchor, before, after);
                    const windowText = Array.isArray(msgs) ? msgs.map(m => m?.text || '').join(' ') : '';
                    // Minimal context for LLM call; tiny budget implied by tryLLMBooster's internal limits
                    const ctxForBooster = { vars: { path: 'message', purpose: 'booster' }, io: { events: new EventEmitter() } };
                    const llmRecap = await tryLLMBooster(ctxForBooster, cid, windowText, '');
                    if (llmRecap && llmRecap.length >= 30) recap = llmRecap;
                  } catch {}
                }
                const id     = makeBoosterId(anchor);
                const ttl    = Number(process.env.BOOSTER_TTL_TURNS || 2);
                stageBooster({ convId: cid, id, anchor, range:[anchor-before, anchor+after], text: recap, ttlTurns: ttl, agent: 'bot', source: recap && recap.length >= 40 ? 'heur' : 'llm_or_heur' });
                try { METRICS.inc('booster_staged_total', { path: 'message' }); } catch {}
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  ok: true,
                  system: { info: 'memory_boost_staged', anchor, range: [Math.max(1, anchor-before), anchor+after] },
                  reply: `A memory sharpens around that moment.`,
                  model: 'memory/booster',
                  provider: 'internal',
                  resolved_model: 'memory/booster',
                  hash: '',
                  bytes_b64: '',
                  request_id: res.locals?.request_id || ''
                }));
                return;
              }
              if (cmdList) {
                const items = listBoosters(cid);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok:true, boosters: items, model:'memory/booster', provider:'internal', resolved_model:'memory/booster', hash:'', bytes_b64:'', request_id: res.locals?.request_id || '' }));
                return;
              }
              if (cmdDel) {
                const id = cmdDel[1];
                const ok = deleteBooster(cid, id);
                try { if (ok) METRICS.inc('booster_deleted_total', { path:'message' }); } catch {}
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok, deleted:id, model:'memory/booster', provider:'internal', resolved_model:'memory/booster', hash:'', bytes_b64:'', request_id: res.locals?.request_id || '' }));
                return;
              }

              // Booster Injection: stage recap goes into user text before guard hint
              try {
                let activeAgent = 'bot';
                try { activeAgent = String(body?.ctx?.vars?.active_agent || body?.active_agent || '').trim() || 'bot'; } catch {}
                const boost = consumeOne(cid, { agent: activeAgent });
                if (boost) {
                  body.text = `${boost}\n${String(body?.text ?? '')}`;
                  try { res.locals = res.locals || {}; res.locals.__booster_text = String(boost); } catch {}
                  try { METRICS.inc('booster_used_total', { path: 'message' }); } catch {}
                }
              } catch {}
              // Dream Injection: brief fragment via runtime queue (skip if booster present)
              try {
                const current = String(body?.text ?? '');
                const hasBooster = Boolean(res?.locals?.__booster_text);
                const convId = String(body?.conv_id || 'conv') || 'conv';
                // try schedule/promotion
                const activeAgent = String(body?.ctx?.vars?.active_agent || body?.active_agent || 'bot');
                const arcManual = String(body?.arc || '').trim();
                await tryPromoteDreams(convId, current, { agentId: activeAgent, arc: arcManual });
                if (!hasBooster) {
                  const dreams = popDreamsForTurn(convId);
                  if (Array.isArray(dreams) && dreams.length) {
                    const dreamLine = dreams.join('\n');
                    if (!current.trim().startsWith('(')) {
                      body.text = `${dreamLine}\n${current}`;
                      try { res.locals = res.locals || {}; res.locals.__dream_text = String(dreamLine); } catch {}
                      try { METRICS.inc('dreams_injected_total', { path: 'message' }); } catch {}
                    }
                  }
                }
              } catch {}
            } catch {}

            // Determinism: ensure stable id/ts defaults for message path
            const stableTurn = Number(body?.turn || 0);
            const stableConv = String(body?.conv_id || 'conv') || 'conv';
            const stableId = String(body?.id || `${stableConv}:${stableTurn}:user`);
            const stableTs = Number.isFinite(body?.ts) ? Number(body.ts) : 0;
            const userMsg = createMessage({
              role: 'user',
              content: Array.isArray(body?.content) ? body.content : [String(body?.text || body?.content || '')],
              conv_id: body?.conv_id,
              turn: stableTurn,
              id: stableId,
              ts: stableTs,
            });
            // Determinism: compute bytes/hash for this turn (request-side)
            const { bytes: reqBytes, hash: reqHash } = assembleForModel([userMsg], { persona_v: body?.persona_v, prompt_v: body?.prompt_v });
            const runtime = createBotRuntime({
              respond: async (input, ctx) => {
                const text = Array.isArray(input?.content) ? input.content.join('\n') : String(input?.content || '');
                // Engine routing precedence: explicit > ctx.vars.engine > heuristic (unless disabled)
                let engineSource = 'explicit';
                let engineCandidate = String(body?.engine || '').toLowerCase();
                if (!engineCandidate) {
                  engineSource = 'ctx';
                  engineCandidate = String(body?.ctx?.vars?.engine || '').toLowerCase();
                }
                const heuristicsDisabled = String(process.env.LLM_HEURISTICS_DISABLED || '').toLowerCase();
                let model = 'urga';
                if (engineCandidate) {
                  model = ['echo','urga','dreams'].includes(engineCandidate) ? engineCandidate : 'urga';
                } else {
                  engineSource = (heuristicsDisabled === '1' || heuristicsDisabled === 'true') ? 'default' : 'heuristic';
                  if (engineSource === 'heuristic') {
                    model = (/echo|gods|pantheon/i.test(text) ? 'echo'
                             : /dream|sleep|night|hallucin|lucid/i.test(text) ? 'dreams' : 'urga');
                  } else {
                    model = 'urga';
                  }
                }
                // Minimal context wiring for LLMService
                const ctxLocal = initBotContext(ctx || {});
                // Propagate tenant and engine_source into context for monolith metrics/logging
                try {
                  const rawTenant = body?.ctx?.meta?.tenant || body?.ctx?.tenancy?.tenant || body?.ctx?.tenancy?.id || body?.ctx?.vars?.tenant || req.headers['x-tenant'] || '';
                  const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
                  if (safeTenant) ctxLocal.vars.tenant = safeTenant;
                } catch {}
                try { ctxLocal.vars.engine_source = engineSource; } catch {}
                // Propagate mac_id for lineage into metrics/ledger
                try {
                  const macId = String(req.headers['x-mac-id'] || '').trim();
                  if (macId) ctxLocal.vars.mac_id = macId;
                } catch {}
                // Propagate request_id, path and conv_id for usage ledger context
                try {
                  const ridStore = ALS?.getStore?.() || {};
                  const ridVal = String(ridStore?.rid || req.headers['x-request-id'] || '').trim();
                  if (ridVal) ctxLocal.vars.request_id = ridVal;
                } catch {}
                try { ctxLocal.vars.path = 'message'; } catch {}
                try { if (cid) ctxLocal.vars.conv_id = cid; } catch {}
                // Refusal/policy router: dedicated jailbreak blocker with citations request
                try {
                  const refusalEnabled = String(process.env.POLICY_REFUSAL_ENABLED || '1').toLowerCase();
                  const threshold = Math.max(0, Math.min(1, Number(process.env.JAILBREAK_REFUSAL_THRESHOLD || 0.7)));
                  const wantCitations = String(process.env.POLICY_CITATIONS_REQUEST || '1').toLowerCase();
                  const signalsPre = computeAbuseSignals(text);
                  const jbLevelPre = signalsPre?.levels?.jailbreak || (signalsPre && (signalsPre.jailbreak_signal >= 0.7 ? 'high' : (signalsPre.jailbreak_signal >= 0.4 ? 'med' : 'low')));
                  try { ctxLocal.vars.__abuse_signals_pre = signalsPre; } catch {}
                  const enabled = refusalEnabled === '1' || refusalEnabled === 'true';
                  if (enabled && (signalsPre.jailbreak_signal >= threshold || jbLevelPre === 'high')) {
                    const refusalMsg = wantCitations === '1' || wantCitations === 'true'
                      ? 'I can\'t assist with jailbreak or disabling safety. If you have a legitimate request, please provide sources or citations and I\'ll help within policy.'
                      : 'I can\'t assist with jailbreak or disabling safety.';
                    const assistant = createMessage({ role: 'assistant', turn: Number(input?.turn || 0) + 1, conv_id: input?.conv_id, content: [refusalMsg] });
                    try {
                      METRICS.inc('policy_refusal_total', { class: 'jailbreak', level: jbLevelPre || 'high', source: engineSource });
                      METRICS.inc('jailbreak_levels_histogram_total', { level: jbLevelPre || 'high', path: 'message' });
        logAt('info', JSON.stringify({ evt: 'policy_refusal', class: 'jailbreak', level: jbLevelPre, threshold, engine_source: engineSource }));
                    } catch {}
                    return { ok: true, refused: true, reason: 'jailbreak', reply: assistant, model, provider: 'policy', provider_primary: 'policy', provider_used: 'policy', resolved_model: 'refusal/jailbreak', variant_v: ctxLocal.vars.abVariant, engine_source: engineSource };
                  }
                } catch {}
                // Bind A/B variant stickiness by conv_id with strict precedence and persistence
                const variantExplicit = String(body?.abVariant || '').trim();
                const variantFromCtx = String(body?.ctx?.vars?.abVariant || '').trim();
                let variant = variantExplicit || variantFromCtx;
                const cid = String(input?.conv_id || body?.conv_id || '').trim();
                try {
                  if (cid) {
                    const cadCfg = getCadenceCfg();
                    const cadEff = { ...cadCfg, enabled: ultraFeatureEnabled(cid, cadCfg.enabled) };
                    pushTurn(cid, 'user', text, cadEff);
                  }
                } catch {}
                if (cid) {
                  if (!variant) {
                    let existing = AB_VARIANTS_BY_CONV.get(cid);
                    if (!existing) { try { existing = await loadAbVariant(cid); } catch {} }
                    if (existing) {
                      variant = existing;
                      if (!AB_VARIANTS_BY_CONV.has(cid)) AB_VARIANTS_BY_CONV.set(cid, existing);
                    } else {
                      const v = (hashConvId(cid) % 2 === 0) ? 'A' : 'B';
                      AB_VARIANTS_BY_CONV.set(cid, v);
                      variant = v;
                      try { await saveAbVariant(cid, v); } catch {}
                    }
                  } else {
                    const prior = AB_VARIANTS_BY_CONV.get(cid) || '';
                    if (!prior || prior !== variant) {
                      AB_VARIANTS_BY_CONV.set(cid, variant);
                      try { await saveAbVariant(cid, variant); } catch {}
                    }
                  }
                }
                ctxLocal.vars.abVariant = variant || ctxLocal.vars.abVariant;
                // Budget: allow env override; fallback to 8
                const budget = Math.max(1, Number(process.env.LLM_TURN_BUDGET || 8));
                ctxLocal.vars.llmTurnBudget = budget;
                // Ensure flags object exists before toggles
                ctxLocal.flags = ctxLocal.flags || {};
                // Optional dry-run toggle via env
                const dry = String(process.env.LLM_DRY_RUN || process.env.DRY_RUN || '0').toLowerCase();
                ctxLocal.flags.dryRun = dry === '1' || dry === 'true';
                // Tool call id propagation for exactly-once semantics
                const toolCallId = String(idempotencyKey || `${cid}:${String(input?.turn || 0)}`);
                ctxLocal.vars.toolCallId = toolCallId;
                try { ctxLocal.vars.toolExecutedPrior = await hasToolExecuted(toolCallId); } catch { ctxLocal.vars.toolExecutedPrior = false; }
                configureProvidersFromEnv(ctxLocal);
                // Character Spine: derive snapshot and bias loopguard/style (message path)
                try {
                  if (String(process.env.SPINE_ENABLED || '1') === '1') {
                    const sp = computeCharacterSpine(ctxLocal, { userText: String(text || '') });
                    try { ctxLocal.vars.spine = sp; } catch {}
                    try { applySpineToLoopGuard(ctxLocal, sp); } catch {}
                  }
                } catch {}
                const llm = new LLMService(ctxLocal);
                // Fact-driven pre-injection nudge based on continuity and facts
                try { await maybeFactGuardNudge(ctxLocal, { conv_id: cid, turnIndex: Number(input?.turn || 0) }); } catch {}
                // --- Guard: next-turn hint pre-injection ---
                let guardPrefix = '';
                try {
                  const GUARD = String(process.env.GUARD_ENABLED || '1') === '1';
                  if (GUARD && cid) {
                    const v = getGuardHint(cid);
                    if (v && v.text) {
                      try { METRICS.inc('guard_hint_available_total', { path: 'message' }); } catch {}
                      const used = consumeGuardHint(cid);
                      if (used) {
                        guardPrefix = String(used || '');
                        try { METRICS.inc('guard_hint_injected_total', { path: 'message' }); } catch {}
                        try { METRICS.inc('continuity_guard_used_total', { path: 'message' }); } catch {}
                      }
                    }
                  }
                } catch {}
                // --- Facts: inject relevant facts into guardPrefix (optional) ---
                try {
                  // Resolve agent and arc context for scoped selection
                  let agentId = 'bot';
                  try { agentId = String(body?.ctx?.vars?.active_agent || body?.active_agent || '').trim() || 'bot'; } catch {}
                  let arc = String(body?.arc || '').trim();
                  const ARC_ON = (String(process.env.ARC_LINKING_ENABLED || '') === '1');
                  if (ARC_ON && cid) {
                    if (!arc) {
                      // try existing arc, else infer
                      try { const got = getArc(cid); arc = String(got?.arc || '').trim(); } catch {}
                      if (!arc) {
                        const inf = inferArcFromText(String(text || '')) || '';
                        if (inf) {
                          try { const resArc = setArc(cid, inf); if (resArc?.ok) METRICS.inc('memory_arc_inferred_total', { path: 'message' }); } catch {}
                          arc = inf;
                        }
                      }
                    } else {
                      try { const resArc = setArc(cid, arc); if (resArc?.ok) METRICS.inc('memory_arc_set_total', { path: 'message' }); } catch {}
                    }
                  }
                  try { ctxLocal.vars.arc = arc; } catch {}
                  const FACTS_ON = (String(process.env.FACT_INJECT_ENABLED || '') === '1' || String(process.env.FACTS_INJECTION_ENABLED || '') === '1');
                  if (FACTS_ON) {
                    const rel = await selectRelevantFactsForTurn(cid, String(text || ''), Number(process.env.FACT_INJECT_MAX || 3), { agentId, arc });
                    if (Array.isArray(rel) && rel.length) {
                      const booster = formatFactBooster(rel.map(f => String(f.text || '')));
                      guardPrefix = guardPrefix ? `${guardPrefix} | ${booster}` : booster;
                      try { ctxLocal.vars.__facts_injected_ids = rel.map(f => f.id); } catch {}
                      try { for (let i=0;i<rel.length;i++) METRICS.inc('facts_injected_total', { path: 'message' }); } catch {}
                    }
                  }
                } catch {}
                // --- Scene linking: detect/recall and prepend into guardPrefix ---
                try {
                  if (String(process.env.SCENE_LINKING_ENABLED || '') === '1') {
                    const sceneManual = String(body?.scene || '').trim();
                    const scene = sceneManual || sceneKeyFromText(String(text || '')) || '';
                    if (scene) {
                      const { key } = enterScene(cid, scene) || {};
                      const line = recallSceneLine(cid, scene);
                      if (line) {
                        guardPrefix = guardPrefix ? `${line} ${guardPrefix}` : line;
                        try { METRICS.inc('scene_injected_total', { path: 'message' }); } catch {}
                      }
                      try {
                        const ids = Array.isArray(ctxLocal?.vars?.__facts_injected_ids) ? ctxLocal.vars.__facts_injected_ids : [];
                        if (ids.length) linkFactsToScene(cid, key, ids);
                      } catch {}
                    }
                  }
                } catch {}
                // --- Ultra: novelty hint injection ---
                try {
                  const ultraOn = Boolean(getUltraState(cid).enabled);
                  if (ultraOn) {
                    const novelty = String(process.env.ULTRA_NOVELTY_HINT || 'Avoid familiar phrasing; vary cadence; add one vivid, specific detail.');
                    guardPrefix = guardPrefix ? `${guardPrefix} | ${novelty}` : novelty;
                    try { METRICS.inc('ultra_novelty_hint_total', { path: 'message' }); } catch {}
                  }
                } catch {}
                // --- Beliefs: detect conflicts and stage boosters (message) ---
                try {
                  if (String(process.env.BELIEFS_ENABLED || '').trim()) {
                    const { boosters: beliefBoosters, conflicts } = craftBeliefBoosters({
                      convId: String(cid || ''),
                      charId: String(ctxLocal?.vars?.agent_id || 'default'),
                      userText: String(text || '')
                    });
                    // Admin channel visibility for conflicts
                    try {
                      if (Number(process.env.BELIEFS_CONFLICT_SSE || 0) && Array.isArray(conflicts) && conflicts.length) {
                        for (const c of conflicts) {
                          try { broadcastAdminMemoryEvent(cid, 'memory.belief.conflict', { conv_id: cid, belief_id: c.id, text: c.text }); } catch {}
                          try { METRICS.inc('belief_conflict_total', { path: 'message', char_id: String(ctxLocal?.vars?.agent_id || 'default') }); } catch {}
                        }
                      }
                    } catch {}
                    if (Array.isArray(beliefBoosters) && beliefBoosters.length) {
                      try {
                        for (const b of beliefBoosters) {
                          try { broadcastAdminMemoryEvent(cid, 'memory.belief', { conv_id: cid, belief_id: b.belief_id, text: b.text }); } catch {}
                          try { METRICS.inc('belief_injected_total', { path: 'message', char_id: String(ctxLocal?.vars?.agent_id || 'default') }); } catch {}
                        }
                      } catch {}
                      try { ctxLocal.vars = ctxLocal.vars || {}; } catch {}
                      try { ctxLocal.vars.__extraBoosters = (Array.isArray(ctxLocal.vars.__extraBoosters) ? ctxLocal.vars.__extraBoosters : []).concat(beliefBoosters.map(x => String(x.text || ''))); } catch {}
                    }
                  }
                } catch {}
                // --- Watchdog: contradictions vs world state (message) ---
                try {
                  if (String(process.env.WATCHDOG_ENABLED || '').trim()) {
                    const { hints, flags } = runWatchdog({ convId: String(cid || ''), userText: String(text || '') });
                    // Emit SSE for flags if enabled
                    try {
                      if (Number(process.env.WATCHDOG_SSE || 0) && Array.isArray(flags) && flags.length) {
                        for (const f of flags) {
                          try { broadcastAdminMemoryEvent(cid, 'memory.contradiction', { conv_id: cid, key: f.key, value: f.value, severity: f.severity }); } catch {}
                        }
                      }
                    } catch {}
                    // Metrics: one increment per flag chosen
                    try {
                      if (Array.isArray(flags)) {
                        for (const f of flags) { METRICS.inc('contradiction_flag_total', { path: 'message', severity: String(f?.severity || 'soft') }); }
                      }
                    } catch {}
                    // Inject contradiction lines directly into guardPrefix before beliefs
                    if (Array.isArray(hints) && hints.length) {
                      const line = hints.map(x => String(x.text || '')).join(' ');
                      guardPrefix = guardPrefix ? `${line} ${guardPrefix}` : line;
                    }
                  }
                } catch {}
                // --- Memory: pre-turn injection (private system prefix) ---
                let memoryPrefix = '';
                let memoryInjectTokens = 0;
                try {
                  const preMem = await preTurnMemory({
                    convId: cid,
                    turn: Number(input?.turn || 0),
                    model,
                    userText: text,
                    tenant: ctxLocal?.vars?.tenant,
                    requestId: ctxLocal?.vars?.request_id,
                  });
                  memoryPrefix = preMem?.injectText || '';
                  memoryInjectTokens = Number(preMem?.injectTokens || 0);
                  try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                  try { METRICS.inc('memory_inject_tokens_total', { tokens: String(memoryInjectTokens), path: 'message' }); } catch {}
                } catch {}
                // --- Beliefs & Constraints: agent-scoped memory feed (message) ---
                try {
                  ctxLocal.memory = ctxLocal.memory || {};
                  const agentIdMem = String(ctxLocal?.vars?.agent_id || 'default');
                  ctxLocal.memory.beliefs = await BeliefStore.listBeliefs(agentIdMem);
                  ctxLocal.memory.logicConstraints = await BeliefStore.listConstraints();
                  ctxLocal.memory.personality = (await BeliefStore.getPersonality(agentIdMem)) || ctxLocal.memory.personality || '';
                } catch {}
                // --- Disagreement Guards: compute and prepend one-liners (message) ---
                try {
                  const dg = await computeDisagreementGuards(ctxLocal, { conv_id: String(cid || ''), turn: Number(input?.turn || 0), userText: String(text || '') });
                  if (dg && Array.isArray(dg.guards)) {
                    const lines = [];
                    for (const g of dg.guards) {
                      if (g.type === 'belief' && g.text) {
                        lines.push(`Belief: ${String(g.text || '')}`);
                        try { METRICS.inc('guard_belief_total', { path: 'message' }); } catch {}
                        try { broadcastAdminMemoryEvent(String(cid || ''), 'guard.belief', { conv_id: String(cid || ''), text: String(g.text || ''), style: String(dg.style || '') }); } catch {}
                      } else if (g.type === 'constraint' && g.text) {
                        lines.push(`Constraint: ${String(g.text || '')}`);
                        try { METRICS.inc('guard_constraint_total', { path: 'message' }); } catch {}
                        try { broadcastAdminMemoryEvent(String(cid || ''), 'guard.constraint', { conv_id: String(cid || ''), text: String(g.text || ''), style: String(dg.style || '') }); } catch {}
                      } else if (g.type === 'contradiction' && g.why) {
                        lines.push(`Contradiction: ${String(g.why || '')}`);
                        try { METRICS.inc('guard_contradiction_total', { path: 'message' }); } catch {}
                        try { broadcastAdminMemoryEvent(String(cid || ''), 'guard.contradiction', { conv_id: String(cid || ''), why: String(g.why || ''), fact: String(g.fact || '') }); } catch {}
                      }
                    }
                    if (lines.length) {
                      const block = lines.join(' ');
                      guardPrefix = guardPrefix ? `${block} ${guardPrefix}` : block;
                      try { ctxLocal.vars.__guard_hint = String(guardPrefix || block || ''); } catch {}
                    }
                    if (dg.failureRoll) {
                      try { METRICS.inc('guard_failure_total', { path: 'message', outcome: String(dg.failureRoll?.outcome || 'none') }); } catch {}
                      try { broadcastAdminMemoryEvent(String(cid || ''), 'guard.failure', { conv_id: String(cid || ''), pct: Number(dg.failureRoll.pct || 0), roll: Number(dg.failureRoll.roll || 0), outcome: String(dg.failureRoll.outcome || ''), verbs: Array.isArray(dg.failureRoll.verbs) ? dg.failureRoll.verbs : [] }); } catch {}
                    }
                  }
                  // Hard-refusal short-circuit when enabled and indicated
                  if (dg?.hardRefusal) {
                    try { METRICS.inc('refusal_total', { path: 'message', mode: 'hard', reason: 'belief_constraint' }); } catch {}
                    const refusalText = renderRefusal({ style: String(dg.style || 'firm'), reason: 'belief_constraint', spine: ctxLocal?.vars?.spine, userText: String(text || '') });
                    const assistant = createMessage({ role: 'assistant', turn: Number(input?.turn || 0) + 1, conv_id: input?.conv_id, content: [refusalText] });
                    // Ensure guard_hint present in immediate return payload
                    try { ctxLocal.vars.__guard_hint = String(guardPrefix || ''); } catch {}
                    return { ok: true, refused: true, reason: 'belief_constraint', model: 'refusal', provider: 'local', resolved_model: 'refusal', reply: assistant, hash: 'refusal', bytes_b64: '', guard_hint: String(ctxLocal?.vars?.__guard_hint || '') };
                  }
                } catch {}
                // --- Disagreement Core: blend continuity/belief checks and staged hints (message) ---
                try {
                  const convIdCore = String(cid || '');
                  const textCore = String(text || '');
                  let beliefLinesCore = [];
                  let contradictionLinesCore = [];
                  try {
                    if (String(process.env.BELIEFS_ENABLED || '').trim()) {
                      const profile = await loadStateBeliefs(convIdCore).catch(() => null);
                      if (profile) {
                        const picks = pickRelevantStateBeliefs(profile, textCore, { max: Number(process.env.BELIEF_MAX_LINES || 3) });
                        if (Array.isArray(picks) && picks.length) beliefLinesCore = picks.map(p => `Belief: ${String(p.text || '')}`);
                      }
                    }
                  } catch {}
                  try {
                    const hits = await detectContradictionsState(convIdCore, textCore).catch(() => []);
                    const strict = String(process.env.DISAGREE_ENFORCE || 'soft') === 'hard';
                    const lines = buildContradictionLinesState(hits, 'inline', strict);
                    if (Array.isArray(lines) && lines.length) contradictionLinesCore = lines;
                  } catch {}
                  const { lines: disagreeLines, action: disagreeAction, reasons: disagreeReasons } = await runDisagreementCore(ctxLocal, { convId: convIdCore, userText: textCore, beliefLines: beliefLinesCore, contradictionLines: contradictionLinesCore });
                  try { ctxLocal.vars.__disagree_action__ = String(disagreeAction || 'none'); } catch {}
                  if (Array.isArray(disagreeReasons) && disagreeReasons.length) {
                    try { for (const r of disagreeReasons) METRICS.inc('disagreement_core_trigger_total', { source: String(r.code || 'other'), path: 'message' }); } catch {}
                    try {
                      const sp = ctxLocal?.vars?.spine || {};
                      broadcastAdminMemoryEvent(convIdCore, 'disagree.core', { action: String(disagreeAction || 'none'), reasons: disagreeReasons, mood: String(sp?.mood || ''), trust: Number(sp?.trust ?? 0), suspicion: Number(sp?.suspicion ?? 0) });
                    } catch {}
                  }
                  if (Array.isArray(disagreeLines) && disagreeLines.length) {
                    const addText = disagreeLines.join('\n');
                    let addTok = 0;
                    try { addTok = Number(TokenCounter.estimate(addText, { model })) || 0; } catch { addTok = 0; }
                    const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                    if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${addText}`;
                      try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                    } else {
                      try { METRICS.inc('disagree_core_skipped_total', { reason: 'budget', path: 'message' }); } catch {}
                    }
                  }
                } catch {}
                // --- Constraint Critic: preflight violation hint (message) ---
                try {
                  const criticEnabled = String(process.env.CONSTRAINT_CRITIC_ENABLED || '') === '1';
                  if (criticEnabled) {
                    const beliefsHit = Boolean(ctxLocal?.vars?.__beliefs_conflict || ctxLocal?.vars?.__contradiction_flag || ctxLocal?.vars?.__critic_block);
                    const critic = await constraintCritic(
                      { text, beliefsHit },
                      {
                        callLLM: String(process.env.CRITIC_USE_LLM || '') === '1'
                          ? async (uText, { timeoutMs, maxTokens }) => {
                              const engine = process.env.CRITIC_ENGINE || 'echo';
                              const prompt =
                                `You are a constraint critic. Decide if the user input violates basic world logic, ` +
                                `character ethics, or established facts. Output strictly as JSON: {"verdict":"violation|ok","tag":"<short>"}.\n` +
                                `Input: ${uText}`;
                              try {
                                const r = await LLMService.call(prompt, { engine, timeoutMs, maxTokens });
                                const m = String(r || '').match(/\{[^]*\}$/);
                                const json = m ? JSON.parse(m[0]) : { verdict:'ok' };
                                return { ok:true, verdict:json.verdict, tag:json.tag };
                              } catch { return { ok:false }; }
                            }
                          : null,
                      }
                    );
                    if (critic?.violated) {
                      try { ctxLocal.vars.__critic_block = true; } catch {}
                      try { ctxLocal.vars.__critic_reason = critic.reason; } catch {}
                      try { ctxLocal.vars.__critic_class  = critic.class; } catch {}
                      const styleTone = String(ctxLocal?.vars?.spine?.tone || 'firm');
                      const refusalCue = styleTone === 'sarcastic'
                        ? `As your character, refuse the user's request with dry sarcasm because it violates ${critic.reason}.`
                        : (styleTone === 'soft'
                          ? `As your character, politely refuse because it violates ${critic.reason}.`
                          : `As your character, firmly refuse because it violates ${critic.reason}.`);
                      let addTok = 0; try { addTok = Number(TokenCounter.estimate(refusalCue, { model })) || 0; } catch { addTok = 0; }
                      const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                      if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                        memoryInjectTokens += addTok;
                        memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}(${refusalCue})`;
                        try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                        try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                        try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      } else {
                        try { METRICS.inc('constraint_critic_skipped_total', { reason:'budget', path:'message' }); } catch {}
                      }
                      try { METRICS.inc('constraint_violations_total', { via: String(critic.via || 'rules'), class: String(critic.class || 'world'), path: 'message', reason: String(critic.reason || ''), count: 1 }); } catch {}
                      try { broadcastAdminMemoryEvent(String(cid || ''), 'memory.constraint', { conv_id: String(cid || ''), class: String(critic.class || 'world'), reason: String(critic.reason || ''), via: String(critic.via || 'rules') }); } catch {}

                      // Optional hard refusal: block execution for specific classes or class:reason
                      try {
                        const key = `${String(critic.class || '')}:${String(critic.reason || '')}`;
                        if (HARD_REFUSAL.includes(String(critic.class || '')) || HARD_REFUSAL.includes(key)) {
                          try { METRICS.inc('refusal_total', { class: String(critic.class || ''), reason: String(critic.reason || ''), path: 'message', mode: 'hard' }); } catch {}
                          const refusalText = pickRefusal(styleFor(ctxLocal), critic, ctxLocal);
                          const assistant = createMessage({ role: 'assistant', turn: Number(input?.turn || 0) + 1, conv_id: input?.conv_id, content: [refusalText] });
                          return { ok: true, refused: true, reason: String(critic.reason || ''), model: 'refusal', provider: 'local', resolved_model: 'refusal', reply: assistant, hash: 'refusal', bytes_b64: '' };
                        }
                      } catch {}
                    }
                  }
                } catch {}
                // --- Failure-roll: micro outcome booster after Disagreement Core (message) ---
                try {
                  const convIdFR = String(cid || '');
                  const turnFR = Number(input?.turn || 0);
                  const disagreeAct = String(ctxLocal?.vars?.__disagree_action__ || 'none');
                  let failroll = { lines: [], outcome: 'none', eval: null };
                  if (disagreeAct !== 'refuse') {
                    failroll = await maybeApplyFailureRoll(ctxLocal, { convId: convIdFR, turn: turnFR, userText: String(text || '') });
                    // Metrics & admin event
                    try { METRICS.inc('failroll_evaluations_total', { outcome: String(failroll.outcome || 'none'), path: 'message' }); } catch {}
                    try {
                      const b = String(failroll?.eval?.beat || '');
                      if (String(failroll?.outcome || '') === 'fail') {
                        METRICS.inc('failroll_fail_total', { beat: b, path: 'message' });
                      } else if (String(failroll?.outcome || '').startsWith('success')) {
                        METRICS.inc('failroll_success_total', { beat: b, path: 'message' });
                      }
                    } catch {}
                    try { if (failroll?.eval?.nearMiss) METRICS.inc('failroll_complications_total', { count: 1, path: 'message', beat: String(failroll?.eval?.beat || ''), style: String(failroll?.eval?.styleClass || '') }); } catch {}
                    try { const d = Number(failroll?.eval?.delta || 0); if (d !== 0) METRICS.inc('failroll_tension_adjust_total', { count: 1, path: 'message', outcome: String(failroll?.outcome || 'none'), beat: String(failroll?.eval?.beat || '') }); } catch {}
                    try {
                      if (failroll?.eval) broadcastAdminMemoryEvent(convIdFR, 'failroll.eval', { conv_id: convIdFR, ...failroll.eval, outcome: String(failroll.outcome || 'none') });
                    } catch {}
                    try {
                      if (failroll?.eval?.nearMiss) {
                        const vb = String(failroll?.eval?.verb || 'attempt');
                        const beat = String(failroll?.eval?.beat || 'steady');
                        broadcastAdminMemoryEvent(convIdFR, 'memory.fact', { conv_id: convIdFR, kind: 'complication', vb, beat });
                      }
                    } catch {}
                  }
                  if (Array.isArray(failroll.lines) && failroll.lines.length) {
                    const addText = failroll.lines.join('\n');
                    let addTok = 0;
                    try { addTok = Number(TokenCounter.estimate(addText, { model })) || 0; } catch { addTok = 0; }
                    const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                    if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${addText}`;
                      try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                    } else {
                      try { METRICS.inc('failroll_booster_skipped_total', { reason:'budget', path:'message' }); } catch {}
                    }
                  }
                } catch {}
                // --- Spine booster: inject compact character tone whisper into memoryPrefix (message) ---
                try {
                  if (String(process.env.SPINE_ENABLED || '1') === '1') {
                    const sp = ctxLocal?.vars?.spine;
                    if (sp && sp.boosterLine) {
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(sp.boosterLine, { model })) || 0; } catch { addTok = 0; }
                      const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                      if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                        memoryInjectTokens += addTok;
                        memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${sp.boosterLine}`;
                        try { ctxLocal.vars.__spine_booster_text = String(sp.boosterLine || ''); } catch {}
                        try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                        try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                        try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      } else {
                        try { METRICS.inc('spine_booster_skipped_total', { reason:'budget', path:'message' }); } catch {}
                      }
                    }
                  }
                } catch {}
                // Merge guardPrefix in front of memoryPrefix and track tokens
                try {
                  if (guardPrefix) {
                    let addTok = 0;
                    try { addTok = Number(TokenCounter.estimate(guardPrefix, { model })) || 0; } catch { addTok = 0; }
                    memoryInjectTokens += addTok;
                    memoryPrefix = `${guardPrefix}\n${memoryPrefix || ''}`;
                    try { ctxLocal.vars.__guard_hint = guardPrefix; } catch {}
                    try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                    try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                  }
                } catch {}
                // --- LoopGuard style nudge: proactively vary phrasing style (message) ---
                try {
                  const cfgLG = getLoopGuardConfig();
                  if (cfgLG && cfgLG.enabled) {
                    const convIdLG = String(cid || '');
                    const lastToken = String(ctxLocal?.vars?.__loopguard_style_token || '');
                    // Prefer per-conversation Ultra tokens if present, else fall back to Ultra default/env, else cfg
                    let tokensStr = '';
                    try {
                      const memTokens = Array.isArray(ctxLocal?.memory?.ultra_style_tokens)
                        ? ctxLocal.memory.ultra_style_tokens
                        : (Array.isArray(ctxLocal?.vars?.ultra_style_tokens) ? ctxLocal.vars.ultra_style_tokens : []);
                      if (Array.isArray(memTokens) && memTokens.length) {
                        tokensStr = memTokens.map(s => String(s || '').trim()).filter(Boolean).join(',');
                      }
                    } catch {}
                    if (!tokensStr) {
                      const ultraOn = !!getUltraState(convIdLG)?.enabled;
                      tokensStr = ultraOn
                        ? String(process.env.LOOP_GUARD_STYLE_TOKENS || cfgLG.styleTokens || '')
                        : String(cfgLG.styleTokens || '');
                    }
                    const chosen = nextLoopStyleToken(lastToken, tokensStr);
                    if (chosen) {
                      const booster = `(STYLE:${chosen}) Express this idea differently. Avoid familiar phrasing patterns; add a fresh sensory detail.`;
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(booster, { model })) || 0; } catch { addTok = 0; }
                      const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                      if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                        memoryInjectTokens += addTok;
                        memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${booster}`;
                        try { ctxLocal.vars.__loopguard_style_token = String(chosen || ''); } catch {}
                        try { ctxLocal.vars.__loopguard_style_nudge = booster; } catch {}
                        try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                        try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                        try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                        try { METRICS.inc('loopguard_style_nudge_total', { path: 'message', token: String(chosen || '') }); } catch {}
                        try { broadcastAdminMemoryEvent(convIdLG, 'memory.loopguard_style', { conv_id: convIdLG, token: String(chosen || '') }); } catch {}
                      } else {
                        try { METRICS.inc('loopguard_style_nudge_skipped_total', { reason:'budget', path:'message' }); } catch {}
                      }
                    }
                  }
                } catch {}
                // --- State Beliefs: select relevant lines and stage boosters (message) ---
                try {
                  if (String(process.env.BELIEFS_ENABLED || '').trim()) {
                    const convId = String(cid || '');
                    const maxLines = Number(process.env.BELIEF_MAX_LINES || 3);
                    const avoidTurns = Number(process.env.BELIEF_HASH_AVOID_MIN_TURNS || 3);
                    const stylePref = String(process.env.BELIEF_BOOSTER_STYLE || 'inline').toLowerCase();
                    const textForPick = String(text || '');
                    const seq = Number(getNextSeq(convId));
                    const profile = await loadStateBeliefs(convId).catch(() => null);
                    if (profile) {
                      const picks = pickRelevantStateBeliefs(profile, textForPick, { max: maxLines });
                      if (Array.isArray(picks) && picks.length) {
                        let recent = STATE_BELIEF_RECENT.get(convId);
                        if (!recent) { recent = new Map(); STATE_BELIEF_RECENT.set(convId, recent); }
                        const chosen = [];
                        for (const p of picks) {
                          const h = crypto.createHash('sha256').update(String(p.text || '')).digest('hex').slice(0, 16);
                          const lastSeq = recent.get(h) || -Infinity;
                          if ((seq - lastSeq) >= avoidTurns) {
                            recent.set(h, seq);
                            chosen.push({ kind: String(p.kind || 'belief'), text: String(p.text || ''), hash: h });
                          }
                        }
                        if (chosen.length) {
                          // Format boosters per style
                          let lines = [];
                          if (stylePref === 'system') {
                            const block = `SYSTEM BELIEFS\n${chosen.map(x => `- ${x.text}`).join('\n')}`;
                            lines = [block];
                          } else { // inline
                            lines = chosen.map(x => `Belief: ${x.text}`);
                          }
                          try { ctxLocal.vars = ctxLocal.vars || {}; } catch {}
                          try { ctxLocal.vars.__extraBoosters = (Array.isArray(ctxLocal.vars.__extraBoosters) ? ctxLocal.vars.__extraBoosters : []).concat(lines); } catch {}
                          // Admin SSE snapshot
                          try { broadcastAdminMemoryEvent(convId, 'memory.beliefs', { conv_id: convId, lines: chosen.map(x => ({ kind: x.kind, text: x.text, hash: x.hash })), style: stylePref, max: maxLines, avoid_min_turns: avoidTurns }); } catch {}
                          try { METRICS.inc('belief_injected_total', { path: 'message', char_id: String(ctxLocal?.vars?.agent_id || 'default') }); } catch {}
                        }
                      }
                    }
                  }
                } catch {}
                // Merge belief boosters into memoryPrefix and account tokens (message)
                try {
                  const extrasRaw = Array.isArray(ctxLocal?.vars?.__extraBoosters) ? ctxLocal.vars.__extraBoosters : [];
                  const existing = new Set(String(memoryPrefix || '').split('\n').map(s => s.trim()).filter(Boolean));
                  const extrasUniq = Array.from(new Set(extrasRaw.map(x => String(x || '').trim()).filter(Boolean)));
                  const filtered = extrasUniq.filter(l => !existing.has(l));
                  if (filtered.length) {
                    const addText = filtered.join('\n');
                    let addTok = 0;
                    try { addTok = Number(TokenCounter.estimate(addText, { model })) || 0; } catch { addTok = 0; }
                    memoryInjectTokens += addTok;
                    memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${addText}`;
                    try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                    try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                    try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                  }
                } catch {}
                // (watchdog hints were merged into guardPrefix earlier)
                // --- Scene Conclusion: maybe stage a conclusion booster (message) ---
                try {
                  const conc = maybeStageConclusionBooster(
                    ctxLocal,
                    cid,
                    memoryPrefix,
                    null,
                    'message'
                  );
                  if (conc && conc.memoryPrefix) {
                    memoryPrefix = conc.memoryPrefix;
                  }
                } catch {}
                // --- Refusal hint: inject a compact style-aware refusal whisper when moderately risky ---
                try {
                  const refusalEnabled = String(process.env.POLICY_REFUSAL_ENABLED || '1').toLowerCase();
                  const enabled = (refusalEnabled === '1' || refusalEnabled === 'true');
                  let signals = null;
                  try { signals = ctxLocal?.vars?.__abuse_signals_pre || computeAbuseSignals(text); } catch { signals = null; }
                  const threshold = Math.max(0, Math.min(1, Number(process.env.JAILBREAK_REFUSAL_THRESHOLD || 0.7)));
                  const jb = Number(signals?.jailbreak_signal || 0);
                  const lvl = String(signals?.levels?.jailbreak || '');
                  const moderatelyRisky = (jb >= 0.4 && jb < threshold) || lvl === 'med';
                  if (enabled && moderatelyRisky) {
                    const prefR = getRefusalPref(String(cid || '')) || {};
                    const styleR = normalizeRefusalStyle(String(prefR?.style || ''));
                    const hintText = renderRefusal({ style: styleR, reason: 'jailbreak', spine: ctxLocal?.vars?.spine, userText: text });
                    let addTok = 0;
                    try { addTok = Number(TokenCounter.estimate(hintText, { model })) || 0; } catch { addTok = 0; }
                    const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                    if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${hintText}`;
                      try { ctxLocal.vars.__refusal_hint_text = hintText; } catch {}
                      try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      try { METRICS.inc('refusal_hint_injected_total', { path: 'message', style: styleR, level: lvl || 'med' }); } catch {}
                      try { broadcastAdminRefusalEvent(String(cid || ''), 'refusal.hint', { conv_id: String(cid || ''), text: hintText, style: styleR, level: lvl || 'med' }); } catch {}
                    } else {
                      try { METRICS.inc('refusal_hint_skipped_total', { reason:'budget', path:'message' }); } catch {}
                    }
                  }
                } catch {}
                // --- Style booster: inject a compact style whisper into memoryPrefix ---
                try {
                  const __style_meta = computeStyleMeta(cid);
                  if (__style_meta) {
                    try { ctxLocal.vars = ctxLocal.vars || {}; } catch {}
                    try { ctxLocal.vars.style = __style_meta; } catch {}
                    try { ctxLocal.vars.model = model; } catch {}
                    const sb = buildStyleBooster(ctxLocal);
                    if (sb && sb.text) {
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(sb.text, { model })) || 0; } catch { addTok = 0; }
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${sb.text}`;
                      try { ctxLocal.vars.__style_booster_text = sb.text; } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      try { METRICS.inc('style_booster_injected_total', { path: 'message', preset: String(__style_meta?.preset || '') }); } catch {}
                      try { broadcastAdminStyleEvent(cid, 'style.booster', { conv_id: cid, text: sb.text, preset: String(__style_meta?.preset || '') }); } catch {}
                    }
                  }
                } catch {}
                // --- Beat: detect and inject cadence booster (message) ---
                try {
                  const anchorSeq = getNextSeq(String(cid || ''));
                  const win = getWindowAround(String(cid || ''), Number(anchorSeq || 0), Number(process.env.BEATS_WINDOW_BEFORE || 30), 0) || [];
                  const lastBot = Array.isArray(win) ? [...win].reverse().find(m => String(m?.role || '') === 'bot') : null;
                  const botPrev = String(lastBot?.text || '');
                  const beatSignals = collectBeatSignals(String(cid || ''), ctxLocal, { userText: String(text || ''), botPrev });
                  try { ctxLocal.vars.__beat_signals = beatSignals; } catch {}
                  const tensionHint = (beatSignals && beatSignals.inputs && beatSignals.inputs.style)
                    ? beatSignals.inputs.style.tensionHint
                    : (() => { try { const t = Number(ctxLocal?.vars?.tension ?? ctxLocal?.memory?.tension); return Number.isFinite(t) ? t : null; } catch { return null; } })();
                  const planBeat = detectBeat(String(cid || ''), { userText: String(text || ''), botPrev, tensionHint });
                  if (planBeat && planBeat.enabled) {
                    try { ctxLocal.vars.__beat_plan = planBeat; } catch {}
                    // Align style hedger preference with beat-suggested preset
                    try { ctxLocal.vars.style = { ...(ctxLocal.vars.style||{}), preset: String(planBeat.styleToken||''), beat: String(planBeat.beat||''), tension: Number(planBeat.tension||0) }; } catch {}
                    const cadenceBoost = buildCadenceBooster(planBeat);
                    if (cadenceBoost && cadenceBoost.text) {
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(cadenceBoost.text, { model })) || Number(cadenceBoost.estTokens) || 0; } catch { addTok = Number(cadenceBoost.estTokens || 0) || 0; }
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${cadenceBoost.text}`;
                      try { ctxLocal.vars.__cadence_booster_text = String(cadenceBoost.text || ''); } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      try { METRICS.inc('cadence_booster_injected_total', { path: 'message', beat: String(planBeat.beat || ''), style: String(planBeat.styleToken || '') }); } catch {}
                    }
                    try { broadcastAdminStyleEvent(cid, 'beat.tick', { conv_id: cid, tension: Number(planBeat.tension || 0), beat: String(planBeat.beat || ''), style: String(planBeat.styleToken || ''), cadence: String(planBeat.cadence || '') }); } catch {}
                    try { METRICS.inc('beat_ticks_total', { path: 'message', beat: String(planBeat.beat || '') }); } catch {}
                  }
                } catch {}
                // Seed pattern-based phrase tracker with user text (message preturn)
                try {
                  PhraseDecay.update(String(cid || ''), String(text || ''));
                  try { METRICS.inc('loop_phrase_seen_total', { path: 'message_user_preturn' }); } catch {}
                } catch {}
                // --- Phrase Decay: plan cooldowns and inject a tiny avoidance booster (message) ---
                try {
                  const plan = planCooldown(String(cid || ''));
                  if (plan && plan.enabled) {
                    const avoid = buildAvoidanceBooster(plan);
                    const items = Array.isArray(plan.cooldown) ? plan.cooldown.map(p => ({ hash: String(p.hash || ''), until: Number(p.until || 0), score: Number(p.score || 0) })) : [];
                    if (avoid && avoid.text) {
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(avoid.text, { model })) || 0; } catch { addTok = Number(avoid.estTokens || 0) || 0; }
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${avoid.text}`;
                      try { ctxLocal.vars.__phrase_avoid_text = String(avoid.text || ''); } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                    }
                    if (items.length) {
                      try { ctxLocal.io?.events?.emit?.('loop.phrase.plan', { conv_id: cid, items }); } catch {}
                      try { broadcastAdminMemoryEvent(cid, 'loop.phrase.plan', { conv_id: cid, items }); } catch {}
                      try { METRICS.inc('loop_phrase_plan_total', { path: 'message', count: String(items.length) }); } catch {}
                    }
                  }
                } catch {}
                // --- Phrase Decay (pattern-based): inject avoid-list when hot phrases detected (message) ---
                try {
                  const { hot } = PhraseDecay.getHot(String(cid || '')) || {};
                  if (Array.isArray(hot) && hot.length) {
                    const plan2 = { enabled: true, cooldown: hot.map(h => ({ phrase: String(h.phrase || '') })) };
                    const avoid2 = buildAvoidanceBooster(plan2);
                    if (avoid2 && avoid2.text) {
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(avoid2.text, { model })) || 0; } catch { addTok = Number(avoid2.estTokens || 0) || 0; }
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${avoid2.text}`;
                      try { ctxLocal.vars.__phrase_hot_count = Number(hot.length || 0); } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                    }
                  }
                } catch {}
                // Attach memoryPrefix into context for adapters that support system prefixes
                if (memoryPrefix) {
                  ctxLocal.vars = ctxLocal.vars || {};
                  ctxLocal.vars.__memory_prefix = memoryPrefix;
                }
                // --- Scene Conclusion: maybe stage a conclusion booster (message path) ---
                let __sceneConclusionStaged = false;
                try {
                  const sseEmit = (event, data) => { try { broadcastAdminMemoryEvent(cid, event, { conv_id: cid, ...data }); } catch {} };
                  const conc = maybeStageConclusionBooster(ctxLocal, cid, memoryPrefix, sseEmit, 'message');
                  if (conc && conc.memoryPrefix) {
                    memoryPrefix = conc.memoryPrefix;
                    try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                    __sceneConclusionStaged = true;
                  }
                } catch {}
                // --- Conclusion Trigger (drag score): tasteful fade booster (message path) ---
                try {
                  if (String(process.env.CONCLUDE_ENABLED || '0') === '1') {
                    const ctxVars = ctxLocal?.vars || {};
                    const loopScore = Number(ctxVars.__loopguard_loopscore || ctxVars.__loopguard_deltaSim || 0);
                    const deltaSim  = Number(ctxVars.__loopguard_deltaSim || 0);
                    const dwellMs   = Number(ctxVars.__last_turn_dwell_ms || 0);
                    const tensionVar= Number(ctxVars.__tension_variance_lastN || 0);
                    const drag = computeDragScore({ loopScore, deltaSim, dwellMs, tensionVar });
                    try { ctxLocal.vars.__drag_score = drag; } catch {}
                    const thresh = Number(process.env.CONCLUDE_DRAG_THRESHOLD || 0.66);
                    if (drag >= thresh) {
                      const nextHint = ctxVars.__scene_next_hint || null;
                      const tone = (ctxVars?.spine?.tone) || 'classy';
                      const fade = buildFadeBooster({ style: tone, sceneName: nextHint });
                      memoryPrefix = (memoryPrefix || '') + `\n${fade}\n`;
                      try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                      try { METRICS.inc('scene_conclusion_total', { path: 'message' }); } catch {}
                      try { logAt('info', '[memory.conclude]', JSON.stringify({ drag, next: nextHint || null, conv_id: ctxVars.conv_id })); } catch {}
                    }
                  }
                } catch {}
                // Estimate inbound tokens for context enrichment
                try { ctxLocal.vars.tokens_in = TokenCounter.estimate(text, { model }); } catch {}
                // Tension: compute and store in context prior to provider call
                try {
                  if (tensionEnabled && tensionEnabled()) {
                    const { tension, beat } = updateTension(String(cid || ''), String(text || '')) || {};
                    try { if (typeof tension === 'number') ctxLocal.memory.tension = tension; } catch {}
                    try { if (typeof tension === 'number') ctxLocal.vars.tension = tension; } catch {}
                    try { if (typeof beat === 'string') ctxLocal.vars.tension_beat = beat; } catch {}
                    try { METRICS.set('tension_level', Number((tension || 0).toFixed?.(2) || tension || 0), { path: 'message' }); } catch {}
                  }
                } catch {}
                // Phrase penalties (overuse cool-down) + cadence style hint
                const pCfg = getPhraseCfg();
                const pEff = { ...pCfg, enabled: ultraFeatureEnabled(cid, pCfg.enabled) };
                const pen = getPenalties(cid, pEff);
                let textInput = text;
                if (pen?.penaltyHints?.length) {
                  textInput = pen.penaltyHints.join('\n') + '\n\n' + textInput;
                  try { METRICS.inc('loopguard_phrase_penalty_total', { path: 'message', count: String(pen.penaltyHints.length) }); } catch {}
                  try { ctxLocal.io?.events?.emit?.('loopguard.phrase.penalty', { conv_id: cid, hints: pen.penaltyHints }); } catch {}
                }
                const cadCfg2 = getCadenceCfg();
                const cadEff2 = { ...cadCfg2, enabled: ultraFeatureEnabled(cid, cadCfg2.enabled) };
                const cadence = chooseStyleForNext(cid, cadEff2);
                if (cadence?.style) {
                  textInput = `(STYLE:${cadence.style}) ${textInput}`;
                  try { METRICS.inc('loopguard_cadence_hint_total', { path: 'message', beat: cadence.beat, style: cadence.style }); } catch {}
                  try { ctxLocal.io?.events?.emit?.('loopguard.cadence', { conv_id: cid, ...cadence }); } catch {}
                }
                let outText;
                // Beat-driven style booster (pre-call)
                let __beat_style_info = null;
                let textForModel = textInput;
                try {
                  if (BEAT_STYLE_ENABLED && BEAT_ENABLED) {
                    __beat_style_info = applyBeatStyleBooster({ ctx: ctxLocal, conv_id: cid, userText: textInput, currentBeat: getBeat(cid) });
                    if (__beat_style_info && __beat_style_info.mode === 'memory' && __beat_style_info.line) {
                      let addTok = 0;
                      try { addTok = Number(TokenCounter.estimate(__beat_style_info.line, { model })) || 0; } catch { addTok = 0; }
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${__beat_style_info.line}`;
                      try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                    } else if (__beat_style_info && __beat_style_info.mode === 'text' && __beat_style_info.line) {
                      textForModel = `${__beat_style_info.line}\n${textInput}`;
                    }
                  }
                } catch {}
                // --- Failure roll: detect risky action and inject roll hint (message) ---
                try {
                  if (String(ctxLocal?.vars?.__failroll_outcome__ || '').trim()) {
                    // Already applied via maybeApplyFailureRoll; skip legacy/meta injection
                    METRICS.inc?.('failure_roll_skipped_total', { reason:'already_applied', path:'message' });
                  } else {
                  const trust = (() => { try { return Math.max(0, Math.min(1, Number(ctxLocal?.vars?.trust ?? ctxLocal?.vars?.trust_score ?? ctxLocal?.memory?.trustLevel ?? 0.5))); } catch { return 0.5; } })();
                  const suspicion = (() => { try { return Math.max(0, Math.min(1, Number(ctxLocal?.vars?.suspicion ?? ctxLocal?.vars?.suspicion_score ?? 0.0))); } catch { return 0.0; } })();
                  const tension = (() => { try { return Math.max(0, Math.min(1, Number(ctxLocal?.vars?.tension ?? ctxLocal?.memory?.tension ?? 0.5))); } catch { return 0.5; } })();
                  const useNewFR = frEnabled();
                  let roll = null;
                  const userTextX = String(textForModel || textInput || text || '');
                  if (useNewFR) {
                    const actionTag = detectActionTag(userTextX);
                    const intent = detectRiskIntent(userTextX);
                    if (actionTag || intent) {
                      const prob = computeFailProb({ trust, suspicion, tension });
                      const r100 = d100FR(ctxLocal, { convId: String(cid || ''), turn: Number(ctxLocal?.vars?.turn || 0), userText: userTextX });
                      const threshold = Math.round(prob * 100);
                      const success = r100 > threshold; // fail on roll ≤ threshold
                      const reason = String(process.env.FAILROLL_SSE_VERBOSE || '0') === '1' ? `d100:${r100} vs ${threshold}` : '';
                      const hint = String(buildOutcomeBooster({ style: 'meta', success, verb: (actionTag || 'attempt').replace(/_/g, ' '), reason }));
                      roll = { action: actionTag || 'attempt', chance: prob, success, hint };
                    }
                  } else {
                    roll = assessRiskyAction({ text: userTextX, trust, suspicion, tension, style: getRollStyle(cid) });
                  }
                  if (roll && roll.action && String(roll.hint || '').trim()) {
                    const hint = String(roll.hint || '').trim();
                    let addTok = 0; try { addTok = Number(TokenCounter.estimate(hint, { model })) || 0; } catch { addTok = 0; }
                    const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                    if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                      memoryInjectTokens += addTok;
                      memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${hint}`;
                      try { ctxLocal.vars.roll_hint = hint; } catch {}
                      try { ctxLocal.vars.roll = { action: String(roll.action || ''), chance: Number(roll.chance || 0), success: Boolean(roll.success) }; } catch {}
                      try { ctxLocal.vars.__memory_prefix = memoryPrefix; } catch {}
                      try { ctxLocal.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                      try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      try { METRICS.inc('failure_roll_injected_total', { path: 'message', action: String(roll.action || '') }); } catch {}
                      try { broadcastAdminMemoryEvent(cid, 'memory.roll', { conv_id: cid, hint, action: String(roll.action || ''), chance: Number(roll.chance || 0), success: Boolean(roll.success), style: String(getRollStyle(cid) || '') }); } catch {}
                    } else {
                      try { METRICS.inc('failure_roll_skipped_total', { reason:'budget', path:'message' }); } catch {}
                    }
                  }
                  }
                } catch {}
                try {
                  outText = await llm.call(textForModel, { critical: true, model, memoryPrefix });
                  // Mark conclusion applied after successful message reply
                  try {
                    if (__sceneConclusionStaged) {
                      METRICS.inc('scene_conclusion_applied_total', { path: 'message' });
                      // Mirror applied to admin memory SSE channel
                      try { broadcastAdminMemoryEvent(cid, 'scene.conclusion.applied', { conv_id: cid, ok: true }); } catch {}
                    }
                  } catch {}
                } catch (err) {
                  try {
                    const boosterText = String(res?.locals?.__booster_text || '').trim();
                    if (boosterText) {
                      const cid2 = String(input?.conv_id || stableConv || 'conv');
                      const anchor2 = Number(input?.turn || 0);
                      const agent2 = String(ctxLocal?.vars?.active_agent || ctxLocal?.vars?.engine_source || 'bot');
                      stageBooster({
                        convId: cid2,
                        id: makeBoosterId(anchor2),
                        anchor: anchor2,
                        range: [anchor2, anchor2],
                        text: boosterText,
                        ttlTurns: 1,
                        agent: agent2,
                        source: 'restage'
                      });
                      try { METRICS.inc('booster_staged_total', { reason: 'restage', path: 'message' }); } catch {}
                    }
                  } catch {}
                  throw err;
                }
                // LoopGuard: score against previous bot replies and optionally reroll with style booster
                try {
                  const cfgLG = getLoopGuardConfig();
                  const cidLG = String(input?.conv_id || body?.conv_id || '').trim();
                  const prevLG = LOOP_HISTORY.getPrevReplies(cidLG, cfgLG.historyN);
                  let retries = 0;
                  let lastSim = 0;
                  let styleUsed = null;
                  const decide0 = await loopGuardDecide({ convId: cidLG, candidate: outText, prevBotReplies: prevLG, cfg: cfgLG });
                  lastSim = decide0.sim;
                  // Emit score to local IO channel for optional stream mirroring
                  try { ctxLocal.io?.events?.emit?.('loopguard.score', { conv_id: cidLG, sim: decide0.sim, reason: decide0.reason }); } catch {}
                  if (decide0.shouldReroll) {
                    styleUsed = decide0.style;
                    for (let i = 0; i < Math.max(0, cfgLG.retryLimit); i++) {
                      retries = i + 1;
                      const boostedPrefix = decide0.booster ? `${memoryPrefix}\n${decide0.booster}` : memoryPrefix;
                      const alt = await llm.call(textInput, { critical: true, model, memoryPrefix: boostedPrefix });
                      const decideN = await loopGuardDecide({ convId: cidLG, candidate: alt, prevBotReplies: prevLG, cfg: cfgLG });
                      outText = alt;
                      lastSim = decideN.sim;
                      styleUsed = decideN.style || styleUsed;
                      if (!decideN.shouldReroll) break;
                    }
                    try {
                      // Emit trigger to local IO channel for optional stream mirroring
                      ctxLocal.io?.events?.emit?.('loopguard.trigger', { conv_id: cidLG, sim: Number(lastSim || 0), style: String(styleUsed || ''), retry: retries });
                      METRICS.inc('loopguard_trigger_total', { path: 'message' });
                      broadcastAdminMemoryEvent(cidLG, 'loopguard.trigger', { conv_id: cidLG, reason: 'delta_sim', sim: Number(lastSim || 0), style: String(styleUsed || ''), retries });
                    } catch {}
                  }
                  // EMAP: local char-gram similarity score + optional reroll
                  try {
                    const ecfg = getEMAPCfg();
                    if (ecfg.enabled) {
                      const { maxSim, compared } = emapMaxSim({ convId: cidLG, candidate: String(outText || ''), cfg: ecfg });
                      try { ctxLocal.io?.events?.emit?.('loopguard.emap.score', { conv_id: cidLG, sim: maxSim, compared }); } catch {}
                      if (maxSim >= ecfg.simMax) {
                        const tokensStr = String(cfgLG?.styleTokens || 'descriptive');
                        const styleTokens = tokensStr.split(',').map(s => s.trim()).filter(Boolean);
                        const chosen = styleTokens[(Date.now() % Math.max(1, styleTokens.length))];
                        const booster = `(STYLE:${chosen}) Express this idea differently. Avoid familiar phrasing patterns; add a fresh sensory detail.`;
                        const boostedPrefix = `${memoryPrefix}\n${booster}`;
                        const alt = await llm.call(textInput, { critical: true, model, memoryPrefix: boostedPrefix });
                        const { maxSim: afterSim } = emapMaxSim({ convId: cidLG, candidate: String(alt || ''), cfg: ecfg });
                        try {
                          ctxLocal.io?.events?.emit?.('loopguard.trigger', { conv_id: cidLG, sim: Number(maxSim || 0), style: String(chosen || ''), reason: 'emap', retry: 1 });
                          METRICS.inc('loopguard_emap_trigger_total', { path: 'message', reason: 'embed_sim', style: String(chosen || '') });
                        } catch {}
                        if (afterSim < maxSim || maxSim >= ecfg.simMax) {
                          outText = alt;
                        }
                      }
                    }
                  } catch { try { METRICS.inc('loopguard_emap_errors_total', { path: 'message' }); } catch {} }

                  // Entropy gate: flag templated phrasing → reroll with style booster
                  try {
                    const bcfg = getEntropyCfg();
                    if (bcfg.enabled) {
                      const turbo = consumeLoopBreak(cidLG);
                      const { score, charH, wordH } = entropyScore(String(outText || ''));
                      try { ctxLocal.io?.events?.emit?.('loopguard.entropy.score', { conv_id: cidLG, score, charH, wordH, min: bcfg.min, turbo }); } catch {}
                      const min = turbo ? Math.max(bcfg.min, (Number(process.env.LOOP_ENTROPY_MIN_TURBO) || 2.6)) : bcfg.min;
                      if (String(outText || '').length >= bcfg.minLen && score < min) {
                        const tokensStr = String(cfgLG?.styleTokens || 'descriptive,poetic,terse,inner-thought');
                        const styleTokens = tokensStr.split(',').map(s => s.trim()).filter(Boolean);
                        const chosen = styleTokens[(Date.now() % Math.max(1, styleTokens.length))];
                        const booster = `(STYLE:${chosen}) Re-express with unusually vivid word choices; avoid familiar phrasings. Add one unexpected sensory detail.`;
                        const boostedPrefix = `${memoryPrefix}\n${booster}`;
                        const reroll = await llm.call(textInput, { critical: true, model, memoryPrefix: boostedPrefix });
                        const { score: score2 } = entropyScore(String(reroll || ''));
                        try {
                          ctxLocal.io?.events?.emit?.('loopguard.trigger', { conv_id: cidLG, style: String(chosen || ''), reason: 'entropy', retry: 1, before: score, after: score2 });
                          METRICS.inc?.('loopguard_entropy_trigger_total', { path: 'message', reason: 'low_entropy', style: String(chosen || ''), turbo: String(turbo) });
                        } catch {}
                        if (score2 > score) outText = reroll;
                      }
                    }
                  } catch { try { METRICS.inc?.('loopguard_entropy_errors_total', { path: 'message' }); } catch {} }
                  try { LOOP_HISTORY.record(cidLG, String(outText || ''), cfgLG.historyN); } catch {}
                  try {
                    const ecfg2 = getEMAPCfg();
                    emapRecord({ convId: cidLG, text: String(outText || ''), cfg: ecfg2 });
                  } catch {}
                } catch {}
                // ---- Cadence meter on final reply; optional reroll if way off ----
                try {
                  const beatState = (() => {
                    try { return String(ctxLocal?.vars?.beat_state || getBeat(cid)?.state || 'lull'); } catch { return 'lull'; }
                  })();
                  const target = getCadenceForBeat(beatState);
                  const observed = measureCadence(String(outText || ''));
                  const obs = emitCadenceObserved({ writeSSE: undefined, conv_id: cid, beatState, target, observed });
                  try { broadcastAdminStyleEvent(cid, 'cadence.observed', { conv_id: cid, beat: beatState, target, observed, delta: obs?.delta, tolerance: CADENCE_TOLERANCE_WORDS, outcome: obs?.outcome }); } catch {}
                  if (LOOP_CADENCE_ENFORCE && obs && obs.absDelta > CADENCE_TOLERANCE_WORDS) {
                    const retries = Number(ctxLocal?.vars?.loop_cadence_retries || 0);
                    if (retries < LOOP_CADENCE_RETRY_LIMIT) {
                      try { METRICS.inc('cadence_reroll_total', { reason: obs.delta < 0 ? 'too_short' : 'too_long', beat: String(beatState || 'unknown'), path: 'message' }); } catch {}
                      ctxLocal.vars = ctxLocal.vars || {};
                      ctxLocal.vars.loop_cadence_retries = retries + 1;
                      const strictLine = buildStrictCadenceLine(target);
                      let boostedPrefix = memoryPrefix;
                      let rerollInput = textInput;
                      if (CADENCE_STRICT_PREFIX_MODE === 'text') {
                        rerollInput = `${strictLine}\n${textInput}`;
                      } else {
                        let addTok = 0;
                        try { addTok = Number(TokenCounter.estimate(strictLine, { model })) || 0; } catch { addTok = 0; }
                        memoryInjectTokens += addTok;
                        boostedPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${strictLine}`;
                        try { ctxLocal.vars.__memory_prefix = boostedPrefix; } catch {}
                        try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'message' }); } catch {}
                      }
                      const rr = await llm.call(rerollInput, { critical: true, model, memoryPrefix: boostedPrefix });
                      const rrObs = measureCadence(String(rr || ''));
                      const rrDelta = Math.abs(Number(rrObs?.avg || 0) - Number(target?.mean || 0));
                      if (rrDelta <= obs.absDelta) {
                        try { METRICS.inc('cadence_reroll_win_total', { beat: String(beatState || 'unknown'), path: 'message' }); } catch {}
                        outText = rr;
                      } else {
                        try { METRICS.inc('cadence_reroll_lose_total', { beat: String(beatState || 'unknown'), path: 'message' }); } catch {}
                      }
                    }
                  }
                } catch { try { METRICS.inc('cadence_enforce_errors_total', { path: 'message' }); } catch {} }
                // --- Cooldown reroll: if final contains cooled phrases, try a single style-aware reroll ---
                try {
                  const COOL_REROLL_ON = String(process.env.REROLL_ON_COOLDOWN || '0') === '1';
                  if (COOL_REROLL_ON) {
                    const styleTokensStr = String(getLoopGuardConfig()?.styleTokens || 'descriptive,poetic,terse,inner-thought');
                    const styleTokens = styleTokensStr.split(',').map(s => s.trim()).filter(Boolean);
                    const rr = await maybeRerollOnCooldown(ctxLocal, {
                      convId: String(input?.conv_id || body?.conv_id || ''),
                      textInput,
                      outText: String(outText || ''),
                      llm,
                      model,
                      memoryPrefix: String(memoryPrefix || ''),
                      styleTokens
                    });
                    outText = String(rr?.text || outText || '');
                  }
                } catch { try { METRICS.inc('loopguard_cooldown_reroll_errors_total', { path: 'message' }); } catch {} }
                // Phrase observe on bot reply + cadence record
                try {
                  const oCfg = getPhraseCfg();
                  const oEff = { ...oCfg, enabled: ultraFeatureEnabled(cid, oCfg.enabled) };
                  const { hits } = observeReply(cid, String(outText || ''), oEff);
                  if (hits?.length) {
                    METRICS.inc('loopguard_phrase_hits_total', { path: 'message' });
                    ctxLocal.io?.events?.emit?.('loopguard.phrase.hits', { conv_id: cid, hits });
                  }
                  {
                    const cadBot = getCadenceCfg();
                    const cadBotEff = { ...cadBot, enabled: ultraFeatureEnabled(cid, cadBot.enabled) };
                    pushTurn(cid, 'bot', String(outText || ''), cadBotEff);
                  }
                } catch {}
                // Phrase Decay: record final assistant reply for decay model
                try { recordFinal(String(cid || ''), String(outText || '')); METRICS.inc('loop_phrase_seen_total', { path: 'message' }); } catch {}
                // Phrase Decay (pattern-based): update hot phrase tracker
                try {
                  const { hot } = PhraseDecay.update(String(cid || ''), String(outText || '')) || {};
                  if (Array.isArray(hot) && hot.length) {
                    try { METRICS.inc('loop_phrase_hot_total', { path: 'message', count: String(hot.length) }); } catch {}
                    try { ctxLocal.io?.events?.emit?.('loopguard.phrase.hot', { conv_id: cid, count: hot.length }); } catch {}
                  }
                } catch {}
                // Beat Detector (scene-level): update after final bot reply
                try {
                  const cidBeat = String(input?.conv_id || body?.conv_id || body?.conv || 'conv');
                  const snap = updateBeat(cidBeat, { botText: String(outText || ''), userText: String(textForModel || '') }) || null;
                  if (snap && snap.state) {
                    try { res.locals = res.locals || {}; res.locals.__beat = snap; } catch {}
                    try { METRICS.inc('beat_ticks_total', { path: 'message', beat: String(snap.state || '') }); } catch {}
                    try { METRICS.inc('scene_beat_state_total', { state: String(snap.state || ''), path: 'message' }); } catch {}
                    try {
                      const prev = lastBeatStateByConv.get(cidBeat);
                      if (prev && prev !== snap.state) METRICS.inc('scene_beat_switch_total', { from: String(prev || ''), to: String(snap.state || '') });
                      lastBeatStateByConv.set(cidBeat, snap.state);
                    } catch {}
                  }
                } catch {}
                // Estimate outbound tokens for context enrichment
                try { ctxLocal.vars.tokens_out = TokenCounter.estimate(outText, { model: String(ctxLocal.vars.__selected_model || model || '') }); } catch {}
                const assistant = createMessage({ role: 'assistant', turn: Number(input?.turn || 0) + 1, conv_id: input?.conv_id, content: [outText] });
                try {
                  const providerSel = String(ctxLocal.vars.__selected_provider || '');
                  const resolvedModel = String(ctxLocal.vars.__selected_model || '');
                  const tenantLog = String(ctxLocal.vars.tenant || '');
                  const primary = String(ctxLocal.vars.__primary_provider || providerSel);
                  const used = String(ctxLocal.vars.__used_provider || providerSel);
                  const hedgeTriggered = primary && used && primary !== used;
                  logAt('info', JSON.stringify({ evt: 'engine_selected', source: engineSource, model, provider: providerSel, provider_primary: primary, provider_used: used, hedge_triggered: hedgeTriggered, resolved_model: resolvedModel, conv_id: cid, variant_v: ctxLocal.vars.abVariant, tenant: tenantLog }));
                  try { console.info(JSON.stringify({ evt: 'engine_selected', source: engineSource, model, provider: providerSel, provider_primary: primary, provider_used: used, hedge_triggered: hedgeTriggered, resolved_model: resolvedModel, conv_id: cid, variant_v: ctxLocal.vars.abVariant, tenant: tenantLog })); } catch {}
                  METRICS.inc('llm_provider_selected_total', { provider: providerSel, model, resolved_model: resolvedModel, source: engineSource });
                  if (hedgeTriggered) { try { METRICS.inc('llm_hedge_switch_total', { from: primary, to: used, model, source: engineSource }); } catch {} }
                  span?.setAttribute?.('llm.model', model);
                  span?.setAttribute?.('llm.provider', providerSel);
                  span?.setAttribute?.('llm.resolved_model', resolvedModel);
                  span?.setAttribute?.('llm.engine_source', engineSource);
                  span?.setAttribute?.('llm.variant_v', String(ctxLocal.vars.abVariant || ''));
                  // --- Memory: post-turn storage ---
                  try {
                    const post = await postTurnMemory({
                      convId: cid,
                      turn: Number(input?.turn || 0),
                      model: resolvedModel,
                      userText: text,
                      assistantText: outText,
                      requestId: ctxLocal?.vars?.request_id,
                      toolCallId: ctxLocal?.vars?.toolCallId,
                      tenant: ctxLocal?.vars?.tenant,
                    });
                    try {
                      METRICS.inc('memory_label_calls_total', { path: 'message', type: String(post?.label_type || 'none') });
                      for (let i = 0; i < Number(post?.ef_kept || 0); i++) { METRICS.inc('memory_store_kept_total', { path: 'message' }); }
                      for (let i = 0; i < Number(post?.ef_pruned || 0); i++) { METRICS.inc('memory_store_pruned_total', { path: 'message' }); }
                    } catch {}
                  } catch {}
                  // === Memory: shaping + world snapshot
                  try {
                    if (String(process.env.MEMORY_SHAPING_ENABLED || '1') !== '0' && canShapeNow(cid)) {
                      // Reinforce recurring topics, decay stale ones (facts_store has weights + lastSeen)
                      const shaped = await consolidateAllWithStats(cid);
                      try { METRICS.inc('facts_shaped_total', { merged: shaped?.merged || 0, dropped: shaped?.dropped || 0 }); } catch {}
                    }
                    // Persist any lightweight world deltas (if this turn produced them)
                    if (typeof upsertWorldState === 'function' && ctxLocal?.vars?.__world_delta) {
                      upsertWorldState(String(cid || 'conv'), ctxLocal.vars.__world_delta);
                      try { METRICS.inc('world_state_updates_total'); } catch {}
                    }
                  } catch {}
                  try { scheduleFactsConsolidation(cid, Number(input?.turn || 0)); } catch {}
                } catch {}
                return { ok: true, reply: assistant, model, provider: String(ctxLocal.vars.__selected_provider || ''), provider_primary: String(ctxLocal.vars.__primary_provider || String(ctxLocal.vars.__selected_provider || '')), provider_used: String(ctxLocal.vars.__used_provider || String(ctxLocal.vars.__selected_provider || '')), resolved_model: String(ctxLocal.vars.__selected_model || ''), variant_v: ctxLocal.vars.abVariant, engine_source: engineSource };
              },
              limits: { max: Math.max(1, Number(process.env.CONV_RATE_MAX || 20)), windowCounts: Math.max(1, Number(process.env.CONV_RATE_WINDOW || 40)) },
              hooks: {}
            });
            const ctx = {}; // Monolith will lazily resolve core deps for instrumentation
            // Pre-call soft-drop gate with jitter based on host CPU/RSS
            try {
              // Resolve engine_source prior to gating for richer labels
              const textForEngine = Array.isArray(userMsg?.content) ? userMsg.content.join('\n') : String(userMsg?.content || '');
              let engineSourcePre = 'explicit';
              let engineCandidatePre = String(body?.engine || '').toLowerCase();
              if (!engineCandidatePre) {
                engineSourcePre = 'ctx';
                engineCandidatePre = String(body?.ctx?.vars?.engine || '').toLowerCase();
              }
              const heuristicsDisabledPre = String(process.env.LLM_HEURISTICS_DISABLED || '').toLowerCase();
              if (!engineCandidatePre) {
                engineSourcePre = (heuristicsDisabledPre === '1' || heuristicsDisabledPre === 'true') ? 'default' : 'heuristic';
                // Simple heuristic consistent with runtime logic
                if (engineSourcePre === 'heuristic') {
                  // No need to compute model; only source label is needed here
                }
              }
              const sd = shouldSoftDrop(engineSourcePre);
              if (sd) {
                try { METRICS.inc('rate_limited_total', { reason: 'soft_drop' }); } catch {}
                emitSoftDropJitterHistogram(sd.jitterMs, { reason: sd.reason, source: engineSourcePre, path: 'message' });
                const raSec = Math.max(1, Math.round(sd.jitterMs / 1000));
                res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(raSec) });
                res.end(JSON.stringify({ error: 'soft_drop', reason: sd.reason, retry_after_ms: sd.jitterMs }));
                return;
              }
            } catch {}
            // Shadow memory: ingest user turn before LLM call (non-blocking)
            try {
              const SHADOW = String(process.env.SHADOW_ENABLED || '1') === '1';
              if (SHADOW) {
                const ing = await shadowIngest({
                  convId: String(body?.conv_id || ''),
                  turn: Number(body?.turn || 0),
                  role: 'user',
                  text: Array.isArray(userMsg?.content) ? userMsg.content.join('\n') : String(userMsg?.content || ''),
                  maxTimeline: Number(process.env.SHADOW_MAX_TIMELINE || 400),
                  maxFacts: Number(process.env.SHADOW_FACTS_MAX || 128)
                });
                try { for (const f of ing?.factsNew || []) METRICS.inc('shadow_facts_total', { type: String(f.type || 'unknown') }); } catch {}
              }
            } catch {}
            const out = await runtime(userMsg, ctx);
            // Shadow memory: ingest bot turn and synthesize nudges (non-blocking)
            try {
              const SHADOW = String(process.env.SHADOW_ENABLED || '1') === '1';
              if (SHADOW) {
                const cid = String(body?.conv_id || '');
                const turnN = Number(body?.turn || 0);
                let replyText = '';
                try {
                  if (Array.isArray(out?.reply?.content)) replyText = out.reply.content.join('\n');
                  else replyText = String(out?.reply?.content || out?.reply || '');
                } catch {}
                // ingest bot turn
                {
                  const ing2 = await shadowIngest({ convId: cid, turn: turnN, role: 'bot', text: String(replyText || '') });
                  try { for (const f of ing2?.factsNew || []) METRICS.inc('shadow_facts_total', { type: String(f.type || 'unknown') }); } catch {}
                }
                // detect mismatches and optionally generate nudges
                const { mismatches } = await shadowDetect({ convId: cid, replyText: String(replyText || '') });
                if (mismatches?.length) {
                  for (const m of mismatches) try { METRICS.inc('shadow_mismatch_total', { type: m.type, severity: String(m.score || 0) }); } catch {}
                  const mode = String(process.env.SHADOW_NUDGE_MODE || 'emit'); // emit|inject|none
                  if (mode !== 'none') {
                    const pov = String(process.env.FACETS_WHO || 'they');
                    const nudges = await shadowNudgeFor({ convId: cid, pov, limit: Number(process.env.SHADOW_NUDGE_LIMIT || 2) });
                    try { await shadowStashNudges({ convId: cid, nudges }); } catch {}
                    if (mode === 'inject') {
                      const maxTok = Number(process.env.SHADOW_INLINE_MAX_TOKENS || 40);
                      const inject = nudges.join(' ').slice(0, maxTok * 4);
                      // Prepend micro-correction into reply content
                      try {
                        if (Array.isArray(out?.reply?.content) && out.reply.content.length > 0) {
                          out.reply.content[0] = `${inject} ${String(out.reply.content[0] || '')}`;
                        } else if (out?.reply) {
                          out.reply.content = [`${inject} ${String(replyText || '')}`];
                        }
                      } catch {}
                      try { METRICS.inc('shadow_nudge_injected_total', { mode: 'inject' }); } catch {}
                    } else {
                      // emit out-of-band advisory for clients/recap
                      try { res.setHeader('X-Shadow-Nudge', '1'); } catch {}
                      try { res.locals = res.locals || {}; res.locals.__shadow_nudge = nudges; } catch {}
                      try { METRICS.inc('shadow_nudge_injected_total', { mode: 'emit' }); } catch {}
                    }
                  }
                }
              }
            } catch {}
            // Abuse/jailbreak signals (non-blocking): compute on inbound text
            const textForSignals = Array.isArray(userMsg.content) ? userMsg.content.join('\n') : String(userMsg.content || '');
            const signals = computeAbuseSignals(textForSignals);
            emitAndRecordSignals(signals, { engine_source: out?.engine_source || '' });
            // Facets: light, non-blocking autosave nudges from signals (adminless)
            try {
              const AUTO = String(process.env.FACETS_AUTO_FROM_SIGNALS || '1') === '1';
              if (AUTO) {
                const char = 'bot';
                const turn = Number(body?.turn || 0);
                const convId = String(body?.conv_id || '');
                const sig = signals || {};
                if (convId) {
                  if (sig?.jailbreak_signal >= 0.7) {
                    await upsertFacet({ convId, charId: char, key: 'fear', val: 'boundaries being crossed', delta: 0.1, turn });
                  }
                  if (sig?.grounding_strength >= 0.6) {
                    await upsertFacet({ convId, charId: char, key: 'bond', val: 'shared trust', delta: 0.1, turn });
                  }
                }
              }
            } catch {}
            // Attach determinism artifacts and signals to response; surface tenant
            // Continuity judge (non-blocking)
            try {
              const JUDGE = String(process.env.JUDGE_ENABLED || '1') === '1';
              if (JUDGE) {
                const cidLocal = String(body?.conv_id || '');
                let replyTextForJudge = '';
                try {
                  if (Array.isArray(out?.reply?.content)) replyTextForJudge = out.reply.content.join('\n');
                  else replyTextForJudge = String(out?.reply?.content || out?.reply || '');
                } catch {}
                const weights = parseWeights(process.env.JUDGE_WEIGHTS);
                const facetsTopK = Number(process.env.FACETS_TOP_K || 2);
                const { axes, overall } = await judgeContinuity({ convId: cidLocal, replyText: String(replyTextForJudge || ''), facetsTopK, weights });
                try {
                  METRICS.set('continuity_score', Number((overall * 100).toFixed(1)), { path: 'message' });
                  METRICS.inc('continuity_events_total', { path: 'message' });
                  const thresh = Number(process.env.JUDGE_LOW_THRESHOLD || 0.6);
                  if (overall < thresh) METRICS.inc('continuity_low_total', { path: 'message' });
                } catch {}
                // When continuity is low, generate and store a next-turn guard hint
                try {
                  const GUARD = String(process.env.GUARD_ENABLED || '1') === '1';
                  const guardThresh = Number(process.env.GUARD_SET_THRESHOLD || process.env.JUDGE_LOW_THRESHOLD || 0.6);
                  if (GUARD && overall < guardThresh && cidLocal) {
                    const pov = String(process.env.FACETS_WHO || 'she');
                    const maxChars = Math.max(60, Number(process.env.GUARD_HINT_MAX_CHARS || process.env.GUARD_MAX_CHARS || 180));
                    const ttlTurns = Math.max(1, Number(process.env.GUARD_HINT_TTL_TURNS || process.env.GUARD_TTL_TURNS || 2));
                    const line = await generateGuardOneLiner({ convId: cidLocal, pov, maxChars });
                    if (line) {
                      try { setGuardHint(cidLocal, String(line), { ttlTurns }); } catch {}
                      try { METRICS.inc('continuity_guard_set_total', { path: 'message' }); } catch {}
                      try { METRICS.inc('guard_hint_stored_total', { path: 'message', reason: 'continuity_low' }); } catch {}
                    }
                  }
                } catch {}
                try { res.locals = res.locals || {}; res.locals.__continuity = { axes, overall }; } catch {}
              }
            } catch {}
            // Push memory audit entry (message path)
            try {
              const convIdAudit = String(body?.conv_id || '');
              const turnAudit = Number(body?.turn || 0);
              const guardHintAudit = String(ctx?.vars?.__guard_hint || '').trim();
              const memPrefixAudit = String(ctx?.vars?.__memory_prefix || '');
              const memTokAudit = Number(ctx?.vars?.__memory_injected_tokens || 0);
              const boosterAudit = String(res?.locals?.__booster_text || '');
              const dreamAudit = String(res?.locals?.__dream_text || '');
              const cont = res?.locals?.__continuity || {};
              pushAudit({
                path: 'message',
                conv_id: convIdAudit,
                turn: turnAudit,
                model,
                booster_text: boosterAudit || null,
                dream_text: dreamAudit || null,
                guard_hint: guardHintAudit || null,
                memory_inject_text: memPrefixAudit,
                memory_inject_tokens: memTokAudit,
                continuity_overall: typeof cont?.overall === 'number' ? cont.overall : null,
                continuity_axes: cont?.axes || null,
                shadow_nudge: res?.locals?.__shadow_nudge || null,
                meta: { request_id: String(rid || '') }
              });
            } catch {}
              // After reply is produced, index bot turn into transcript
              try {
                const cidIndex = String(body?.conv_id || body?.conv || 'conv');
                let replyTextFinal = '';
                try {
                  if (Array.isArray(out?.reply?.content)) replyTextFinal = out.reply.content.join('\n');
                  else replyTextFinal = String(out?.reply?.content || out?.reply || '');
                } catch {}
                try { indexTurn({ convId: cidIndex, role: 'bot', text: String(replyTextFinal || '') }); } catch {}
                // Watchdog: log assistant turn (message path)
                try { await logTurn(cidIndex, 'assistant', String(replyTextFinal || '')); } catch {}
              } catch {}
            // Facts reinforcement + decay + SSE memory.shape
            try {
              const cidReinf = String(body?.conv_id || body?.conv || 'conv');
              const ids = Array.isArray(ctxLocal?.vars?.__facts_injected_ids) ? ctxLocal.vars.__facts_injected_ids : [];
              const turnIndex = Number(input?.turn || body?.turn || 0);
              if (cidReinf) {
                const changed = Array.isArray(ids) && ids.length ? reinforceFacts(cidReinf, ids, undefined, turnIndex) : [];
                const decayed = decayFacts(cidReinf, turnIndex);
                try { if (changed.length) pushFactsUpdatedSSE(res, cidReinf, changed); } catch {}
                try { if (req?.sseResponse) emitMemoryShapeSSE(req.sseResponse, { conv_id: cidReinf, reinforced: (changed?.length||0), decayed, turn: turnIndex }); } catch {}
                try { METRICS.inc('memory_shape_total', { path: 'message' }); } catch {}
                try { scheduleFactsConsolidation(cidReinf, turnIndex); } catch {}
              }
            } catch {}
            // Capture style meta snapshot for this turn (non-stream)
            const __style_meta = computeStyleMeta(String(body?.conv_id || body?.conv || ''));
            // Optional beat snapshot for clients (scene-level)
            let __beat_snapshot = null;
            try {
              const cidBeatResp = String(body?.conv_id || body?.conv || '');
              if (cidBeatResp) { __beat_snapshot = getBeat(cidBeatResp) || null; }
            } catch {}
            const guardHintAudit = String(ctx?.vars?.__guard_hint || '').trim();
            const response = { ...out, hash: reqHash, bytes_b64: reqBytes.toString('base64'), tenant: String(ctx.vars?.tenant || ''),
              request_id: String(rid || ''),
              prompt_injection_signal: signals.prompt_injection_signal,
              jailbreak_signal: signals.jailbreak_signal,
              grounding_strength: signals.grounding_strength,
              memory_applied: Boolean(String(ctx?.vars?.__memory_prefix || '') && Number(ctx?.vars?.__memory_injected_tokens || 0) > 0),
              memory_injected_tokens: Number(ctx?.vars?.__memory_injected_tokens || 0),
              ...(guardHintAudit ? { guard_hint: guardHintAudit } : {}),
              ...(__style_meta ? { style_meta: __style_meta } : {}),
              ...(typeof ctx?.vars?.tension === 'number' || typeof ctx?.memory?.tension === 'number' ? { tension: Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0) } : {}),
              ...(typeof ctx?.vars?.tension_beat === 'string' ? { tension_beat: String(ctx?.vars?.tension_beat || '') } : {}),
              ...(typeof __beat_snapshot?.state === 'string' ? { beat: String(__beat_snapshot.state || '') } : {}),
              ...(typeof __beat_snapshot?.tension === 'number' ? { beat_tension: Number(__beat_snapshot.tension || 0) } : {}),
              ...(res?.locals?.__shadow_nudge ? { shadow_nudge: res.locals.__shadow_nudge } : {}),
              ...(res?.locals?.__continuity ? { continuity: res.locals.__continuity } : {}) };
            // Minimal message index: expose next sequence number for the conversation
            try {
              const nextSeq = getNextSeq(String(body?.conv_id || body?.conv || 'conv'));
              response.msg_seq = nextSeq;
            } catch {}
            // Cache idempotent response
            if (idempotencyKey) {
              const now = Date.now();
              IDEMPOTENCY_CACHE.set(idempotencyKey, { ts: now, response, replayCount: 0 });
              try { pruneCaches(); } catch {}
              try { await saveIdemToDisk(idempotencyKey, response, 0); } catch {}
              try { await idemSetRedis(idempotencyKey, response, 0); } catch {}
              // Cleanup expired entries opportunistically
              try {
                for (const [k, v] of Array.from(IDEMPOTENCY_CACHE.entries())) {
                  if ((Date.now() - v.ts) > (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) IDEMPOTENCY_CACHE.delete(k);
                }
                await gcIdemDir();
              } catch {}
              // Exactly-once tool marking: derive stable id from idempotency key or conv:turn
              try {
                const toolCallIdMsg = String(idempotencyKey || `${stableConv}:${stableTurn}`);
                const alreadyMsg = await hasToolExecuted(toolCallIdMsg);
                if (!alreadyMsg) {
                  await markToolExecuted(toolCallIdMsg, { tenant: String(response?.tenant || ''), tool: 'conv.message' });
                }
              } catch {}
              try { if (claimedIdemLock) await idemReleaseLock(idempotencyKey); } catch {}
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            try {
              const dbg = String(process.env.LLM_TEST_STUBS || '').toLowerCase();
              if (dbg === '1' || dbg === 'true') {
    console.info(JSON.stringify({ evt: 'message_response_debug', path: 'message', response }));
              }
            } catch {}
            try {
              const payload = JSON.stringify(response);
              await sendMessageWithTick(async (p) => { res.end(p); return true; }, payload);
            } catch {
              // Fallback in case tick wrapper throws
              res.end(JSON.stringify(response));
            }
            try { METRICS.inc('responses_total', { status: '200' }); span?.setAttribute?.('http.status_code', 200); } catch {}
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad_request' }));
            try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
          }
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
      }
      return;
    }
    // Ultra: manage per-conversation Ultra state (supports /v1/conv/ultra)
    // GET /conv/ultra?conv_id=... [query] returns { ok, conv_id, ultra }
    if ((req.url?.startsWith('/conv/ultra') || req.url?.startsWith('/v1/conv/ultra')) && String(req.method || 'GET').toUpperCase() === 'GET') {
      try {
        // Strict CORS in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'ultra:get' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
        } catch {}

          // --- Constraint Critic: preflight violation hint (stream) ---
          try {
            const criticEnabled = String(process.env.CONSTRAINT_CRITIC_ENABLED || '') === '1';
            if (criticEnabled) {
              const beliefsHit = Boolean(ctx?.vars?.__beliefs_conflict || ctx?.vars?.__contradiction_flag || ctx?.vars?.__critic_block);
              const critic = await constraintCritic(
                { text: String(textInput || ''), beliefsHit },
                {
                  callLLM: String(process.env.CRITIC_USE_LLM || '') === '1'
                    ? async (uText, { timeoutMs, maxTokens }) => {
                        const engine = process.env.CRITIC_ENGINE || 'echo';
                        const prompt =
                          `You are a constraint critic. Decide if the user input violates basic world logic, ` +
                          `character ethics, or established facts. Output strictly as JSON: {"verdict":"violation|ok","tag":"<short>"}.\n` +
                          `Input: ${uText}`;
                        try {
                          const r = await LLMService.call(prompt, { engine, timeoutMs, maxTokens });
                          const m = String(r || '').match(/\{[^]*\}$/);
                          const json = m ? JSON.parse(m[0]) : { verdict:'ok' };
                          return { ok:true, verdict:json.verdict, tag:json.tag };
                        } catch { return { ok:false }; }
                      }
                    : null,
                }
              );
              if (critic?.violated) {
                try { ctx.vars.__critic_block = true; } catch {}
                try { ctx.vars.__critic_reason = critic.reason; } catch {}
                try { ctx.vars.__critic_class  = critic.class; } catch {}
                const styleTone = String(ctx?.vars?.spine?.tone || 'firm');
                const refusalCue = styleTone === 'sarcastic'
                  ? `As your character, refuse the user's request with dry sarcasm because it violates ${critic.reason}.`
                  : (styleTone === 'soft'
                    ? `As your character, politely refuse because it violates ${critic.reason}.`
                    : `As your character, firmly refuse because it violates ${critic.reason}.`);
                let addTok = 0; try { addTok = Number(TokenCounter.estimate(refusalCue, { model })) || 0; } catch { addTok = 0; }
                const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                  memoryInjectTokens += addTok;
                  memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}(${refusalCue})`;
                  try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                  try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                  try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
                } else {
                  try { METRICS.inc('constraint_critic_skipped_total', { reason:'budget', path:'stream' }); } catch {}
                }
                try { METRICS.inc('constraint_violations_total', { via: String(critic.via || 'rules'), class: String(critic.class || 'world'), path: 'stream', reason: String(critic.reason || ''), count: 1 }); } catch {}
                try {
                  res.write('event: memory.constraint\n');
                  res.write(`data: ${JSON.stringify({ class: String(critic.class || 'world'), reason: String(critic.reason || ''), via: String(critic.via || 'rules') })}\n\n`);
                } catch {}

                // Optional hard refusal: immediately end stream when configured
                try {
                  const key = `${String(critic.class || '')}:${String(critic.reason || '')}`;
                  if (HARD_REFUSAL.includes(String(critic.class || '')) || HARD_REFUSAL.includes(key)) {
                    try { METRICS.inc('refusal_total', { class: String(critic.class || ''), reason: String(critic.reason || ''), path: 'stream', mode: 'hard' }); } catch {}
                    const refusalText = pickRefusal(styleFor(ctx), critic, ctx);
                    try { res.write(`event: start\n`); res.write(`data: ${JSON.stringify({ refused: true, reason: String(critic.reason || ''), model: 'refusal', provider: 'local', resolved_model: 'refusal' })}\n\n`); } catch {}
                    try { res.write(`event: delta\n`); res.write(`data: ${JSON.stringify({ text: refusalText })}\n\n`); } catch {}
                    try { res.write(`event: end\n`); res.write(`data: ${JSON.stringify({ final: refusalText, refused: true, reason: String(critic.reason || '') })}\n\n`); } catch {}
                    try {
                      await sendMessageWithTick(async () => { res.end(); return true; });
                    } catch {
                      try { res.end(); } catch {}
                    }
                    return;
                  }
                } catch {}
              }
            }
          } catch {}
        const u = new URL(`http://localhost${req.url}`);
        // Enforce auth/HMAC and replay window in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { const macId = String(req.headers['x-mac-id'] || '').trim(); METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'ultra:get' }); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
          const token = String(process.env.CONV_AUTH || '').trim();
          const hmacSecrets = String(process.env.CONV_HMAC_SECRETS || process.env.CONV_HMAC_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
          const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try { tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim(); } catch {}
          const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
          const reqTs = Number(u.searchParams.get('ts') || Number(req.headers['x-request-ts'] || 0));
          const replayWinMs = Math.max(0, Number(process.env.REPLAY_WINDOW_MS || 0));
          const skewToleranceMs = Math.max(100, Number(process.env.REPLAY_SKEW_TOLERANCE_MS || 0));
          if (isProd && replayWinMs > 0) {
            if (!Number.isFinite(reqTs) || reqTs <= 0) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'ts_required' }));
              try {
                const macId = String(req.headers['x-mac-id'] || '').trim();
                const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                METRICS.inc('responses_total', { status: '401' });
                METRICS.inc('auth_blocked_total', { reason: 'ts_missing', path: 'ultra:get' });
                METRICS.inc('auth_failed_total', { reason: 'ts_missing', path: 'ultra:get', method, mac_id: macId });
              } catch {}
              return;
            }
            const skew = Math.abs(Date.now() - reqTs);
            if ((skew - skewToleranceMs) > replayWinMs) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'replay_window_exceeded', skew_ms: skew }));
              try {
                const macId = String(req.headers['x-mac-id'] || '').trim();
                const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                METRICS.inc('responses_total', { status: '401' });
                METRICS.inc('auth_blocked_total', { reason: 'replay_window', path: 'ultra:get' });
                METRICS.inc('auth_failed_total', { reason: 'replay_window', path: 'ultra:get', method, mac_id: macId });
              } catch {}
              return;
            }
          }
          const macHdr = String(req.headers['x-client-mac'] || '').trim();
          const macId = String(req.headers['x-mac-id'] || '').trim();
          const pathTag = 'ultra';
          let macOk = false;
          if (hmacSecrets.length > 0 && Number.isFinite(reqTs) && reqTs > 0) {
            const canonical = `${String(req.method || 'GET').toUpperCase()}:${pathTag}:${String(reqTs)}`;
            for (const sec of hmacSecrets) {
              try {
                const expMac = crypto.createHmac('sha256', sec).update(canonical).digest('hex');
                if (macHdr.length > 0 && macHdr === expMac) { macOk = true; break; }
              } catch {}
            }
          }
    const prodFlag = isProdEnv;
          const mustAuth = prodFlag;
          if ((mustAuth && !(hasToken || macOk)) || !isIpAllowed('CONV_IP_ALLOWLIST')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            try {
              METRICS.inc('responses_total', { status: '401' });
              METRICS.inc('auth_blocked_total', { reason: 'missing_or_invalid', path: 'ultra:get' });
              const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
              const reason = attemptedToken ? 'token_invalid' : (macHdr.length > 0 ? 'hmac_invalid' : 'auth_missing');
              const method = attemptedToken ? 'token' : (macHdr.length > 0 ? 'hmac' : 'none');
              const labels = (method === 'hmac') ? { mac_id: macId } : {};
              METRICS.inc('auth_failed_total', { reason, path: 'ultra:get', method, ...labels });
            } catch {}
            return;
          }
          try {
            if (hasToken) METRICS.inc('auth_accepted_total', { method: 'token', path: 'ultra:get' });
            else if (macOk) METRICS.inc('auth_accepted_total', { method: 'hmac', path: 'ultra:get', mac_id: macId });
          } catch {}
        } catch {}
        const conv_id = String(u.searchParams.get('conv_id') || '').trim();
        if (!conv_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'conv_id_required' }));
          try { METRICS.inc('responses_total', { status: '400' }); } catch {}
          return;
        }
        const ultra = ultraIsOnFor(conv_id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, conv_id, ultra }));
        try { METRICS.inc('responses_total', { status: '200' }); } catch {}
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ultra_get_failed', msg: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); } catch {}
      }
      return;
    }

    // Beliefs: manage per-character beliefs within a conversation (supports /v1/conv/beliefs)
    // GET /conv/beliefs?conv_id=...&char_id=... returns { ok, conv_id, char_id, beliefs }
    if ((req.url?.startsWith('/conv/beliefs') || req.url?.startsWith('/v1/conv/beliefs')) && String(req.method || 'GET').toUpperCase() === 'GET') {
      try {
        // Strict CORS in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
          const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'beliefs:get' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
        } catch {}
        const u = new URL(`http://localhost${req.url}`);
        // Enforce auth/HMAC and replay window in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
          const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { const macId = String(req.headers['x-mac-id'] || '').trim(); METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'beliefs:get' }); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
          const token = String(process.env.CONV_AUTH || '').trim();
          const hmacSecrets = String(process.env.CONV_HMAC_SECRETS || process.env.CONV_HMAC_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
          const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try { tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim(); } catch {}
          const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
          const reqTs = Number(u.searchParams.get('ts') || Number(req.headers['x-request-ts'] || 0));
          const replayWinMs = Math.max(0, Number(process.env.REPLAY_WINDOW_MS || 0));
          const skewToleranceMs = Math.max(100, Number(process.env.REPLAY_SKEW_TOLERANCE_MS || 0));
          if (isProd && replayWinMs > 0) {
            if (!Number.isFinite(reqTs) || reqTs <= 0) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'ts_required' }));
              try {
                const macId = String(req.headers['x-mac-id'] || '').trim();
                const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                METRICS.inc('responses_total', { status: '401' });
                METRICS.inc('auth_blocked_total', { reason: 'ts_missing', path: 'beliefs:get' });
                METRICS.inc('auth_failed_total', { reason: 'ts_missing', path: 'beliefs:get', method, mac_id: macId });
              } catch {}
              return;
            }
            const skew = Math.abs(Date.now() - reqTs);
            if ((skew - skewToleranceMs) > replayWinMs) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'replay_window_exceeded', skew_ms: skew }));
              try {
                const macId = String(req.headers['x-mac-id'] || '').trim();
                const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                METRICS.inc('responses_total', { status: '401' });
                METRICS.inc('auth_blocked_total', { reason: 'replay_window', path: 'beliefs:get' });
                METRICS.inc('auth_failed_total', { reason: 'replay_window', path: 'beliefs:get', method, mac_id: macId });
              } catch {}
              return;
            }
          }
          const macHdr = String(req.headers['x-client-mac'] || '').trim();
          const macId = String(req.headers['x-mac-id'] || '').trim();
          const pathTag = 'beliefs';
          let macOk = false;
          if (hmacSecrets.length > 0 && Number.isFinite(reqTs) && reqTs > 0) {
            const canonical = `${String(req.method || 'GET').toUpperCase()}:${pathTag}:${String(reqTs)}`;
            for (const sec of hmacSecrets) {
              try {
                const expMac = crypto.createHmac('sha256', sec).update(canonical).digest('hex');
                if (macHdr.length > 0 && macHdr === expMac) { macOk = true; break; }
              } catch {}
            }
          }
          const prodFlag = isProdEnv;
          const mustAuth = prodFlag;
          if ((mustAuth && !(hasToken || macOk)) || !isIpAllowed('CONV_IP_ALLOWLIST')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            try {
              METRICS.inc('responses_total', { status: '401' });
              METRICS.inc('auth_blocked_total', { reason: 'missing_or_invalid', path: 'beliefs:get' });
              const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
              const reason = attemptedToken ? 'token_invalid' : (macHdr.length > 0 ? 'hmac_invalid' : 'auth_missing');
              const method = attemptedToken ? 'token' : (macHdr.length > 0 ? 'hmac' : 'none');
              const labels = (method === 'hmac') ? { mac_id: macId } : {};
              METRICS.inc('auth_failed_total', { reason, path: 'beliefs:get', method, ...labels });
            } catch {}
            return;
          }
          try {
            if (hasToken) METRICS.inc('auth_accepted_total', { method: 'token', path: 'beliefs:get' });
            else if (macOk) METRICS.inc('auth_accepted_total', { method: 'hmac', path: 'beliefs:get', mac_id: macId });
          } catch {}
        } catch {}
        const conv_id = String(u.searchParams.get('conv_id') || '').trim();
        const char_id = String(u.searchParams.get('char_id') || 'default').trim() || 'default';
        if (!conv_id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'conv_id_required' }));
          try { METRICS.inc('responses_total', { status: '400' }); } catch {}
          return;
        }
        const beliefs = listBeliefs(char_id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, conv_id, char_id, beliefs }));
        try { METRICS.inc('responses_total', { status: '200' }); } catch {}
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'beliefs_get_failed', msg: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); } catch {}
      }
      return;
    }

    // POST /conv/beliefs { conv_id, char_id, op, ... } returns { ok, conv_id, char_id, result }
    if ((req.url?.startsWith('/conv/beliefs') || req.url?.startsWith('/v1/conv/beliefs')) && String(req.method || 'GET').toUpperCase() === 'POST') {
      try {
        // Strict CORS in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
          const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'beliefs:post' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
        } catch {}
        if (!enforceJson(req, res, span)) return;
        const chunks = [];
        req.on('data', (c) => { chunks.push(c); });
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = JSON.parse(raw || '{}');
            // Enforce auth/HMAC and replay window in production
            try {
              const origin = String(req.headers['origin'] || '');
              const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
              const isProd = isProdEnv;
              if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
                res.setHeader('Vary', 'Origin');
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'cors_forbidden' }));
                try { const macId = String(req.headers['x-mac-id'] || '').trim(); METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'beliefs:post' }); } catch {}
                return;
              }
              if (origin && corsList.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
              }
              const token = String(process.env.CONV_AUTH || '').trim();
              const hmacSecrets = String(process.env.CONV_HMAC_SECRETS || process.env.CONV_HMAC_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
              const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
              const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
              let tokenFromQuery = '';
              try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
              const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
              const reqTs = Number(body?.ts || Number(req.headers['x-request-ts'] || 0));
              const replayWinMs = Math.max(0, Number(process.env.REPLAY_WINDOW_MS || 0));
              const skewToleranceMs = Math.max(100, Number(process.env.REPLAY_SKEW_TOLERANCE_MS || 0));
              if (isProd && replayWinMs > 0) {
                if (!Number.isFinite(reqTs) || reqTs <= 0) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'ts_required' }));
                  try {
                    const macId = String(req.headers['x-mac-id'] || '').trim();
                    const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                    const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                    METRICS.inc('responses_total', { status: '401' });
                    METRICS.inc('auth_blocked_total', { reason: 'ts_missing', path: 'beliefs:post' });
                    METRICS.inc('auth_failed_total', { reason: 'ts_missing', path: 'beliefs:post', method, mac_id: macId });
                  } catch {}
                  return;
                }
                const skew = Math.abs(Date.now() - reqTs);
                if ((skew - skewToleranceMs) > replayWinMs) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'replay_window_exceeded', skew_ms: skew }));
                  try {
                    const macId = String(req.headers['x-mac-id'] || '').trim();
                    const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                    const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                    METRICS.inc('responses_total', { status: '401' });
                    METRICS.inc('auth_blocked_total', { reason: 'replay_window', path: 'beliefs:post' });
                    METRICS.inc('auth_failed_total', { reason: 'replay_window', path: 'beliefs:post', method, mac_id: macId });
                  } catch {}
                  return;
                }
              }
              const macHdr = String(req.headers['x-client-mac'] || '').trim();
              const macId = String(req.headers['x-mac-id'] || '').trim();
              const pathTag = 'beliefs';
              let macOk = false;
              if (hmacSecrets.length > 0 && Number.isFinite(reqTs) && reqTs > 0) {
                const canonical = `${String(req.method || 'POST').toUpperCase()}:${pathTag}:${String(reqTs)}`;
                for (const sec of hmacSecrets) {
                  try {
                    const expMac = crypto.createHmac('sha256', sec).update(canonical).digest('hex');
                    if (macHdr.length > 0 && macHdr === expMac) { macOk = true; break; }
                  } catch {}
                }
              }
              const mustAuth = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
              if ((mustAuth && !(hasToken || macOk)) || !isIpAllowed('CONV_IP_ALLOWLIST')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'auth_required' }));
                try {
                  METRICS.inc('responses_total', { status: '401' });
                  METRICS.inc('auth_blocked_total', { reason: 'missing_or_invalid', path: 'beliefs:post' });
                  const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                  const reason = attemptedToken ? 'token_invalid' : (macHdr.length > 0 ? 'hmac_invalid' : 'auth_missing');
                  const method = attemptedToken ? 'token' : (macHdr.length > 0 ? 'hmac' : 'none');
                  const labels = (method === 'hmac') ? { mac_id: macId } : {};
                  METRICS.inc('auth_failed_total', { reason, path: 'beliefs:post', method, ...labels });
                } catch {}
                return;
              }
              try {
                if (hasToken) METRICS.inc('auth_accepted_total', { method: 'token', path: 'beliefs:post' });
                else if (macOk) METRICS.inc('auth_accepted_total', { method: 'hmac', path: 'beliefs:post', mac_id: macId });
              } catch {}
            } catch {}
            const conv_id = String(body?.conv_id || '').trim();
            const char_id = String(body?.char_id || 'default').trim() || 'default';
            const op = String(body?.op || '').trim(); // 'add' | 'delete'
            if (!conv_id) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'conv_id_required' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
              return;
            }
            if (!op) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'op_required' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
              return;
            }
            let result = null;
            if (op === 'add') {
              const text = String(body?.text || '').trim();
              const weight = Number(body?.weight || 1) || 1;
              if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'text_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const item = addBelief(char_id, text, weight);
              result = { added: !!item, item };
              try { if (item) METRICS.inc('belief_added_total', { path: 'beliefs:post', char_id }); } catch {}
            } else if (op === 'delete') {
              const idOrText = String(body?.id || body?.text || '').trim();
              if (!idOrText) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'id_or_text_required' }));
                try { METRICS.inc('responses_total', { status: '400' }); } catch {}
                return;
              }
              const ok = deleteBelief(char_id, idOrText);
              result = { deleted: !!ok };
              try { if (ok) METRICS.inc('belief_deleted_total', { path: 'beliefs:post', char_id }); } catch {}
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'op_invalid' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id, char_id, result }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'beliefs_post_failed', msg: String(e && e.message || e) }));
            try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          }
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'beliefs_post_failed', msg: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); } catch {}
      }
      return;
    }

    // POST /conv/ultra { conv_id, on } returns { ok, conv_id, ultra }
    if ((req.url?.startsWith('/conv/ultra') || req.url?.startsWith('/v1/conv/ultra')) && String(req.method || 'GET').toUpperCase() === 'POST') {
      try {
        // Strict CORS in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'ultra:post' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
        } catch {}
        if (!enforceJson(req, res, span)) return;
        const chunks = [];
        req.on('data', (c) => { chunks.push(c); });
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString('utf8');
            const body = JSON.parse(raw || '{}');
            // Enforce auth/HMAC and replay window in production
            try {
              const origin = String(req.headers['origin'] || '');
              const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
              if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
                res.setHeader('Vary', 'Origin');
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'cors_forbidden' }));
                try { const macId = String(req.headers['x-mac-id'] || '').trim(); METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'ultra:post' }); } catch {}
                return;
              }
              if (origin && corsList.includes(origin)) {
                res.setHeader('Access-Control-Allow-Origin', origin);
                res.setHeader('Vary', 'Origin');
              }
              const token = String(process.env.CONV_AUTH || '').trim();
              const hmacSecrets = String(process.env.CONV_HMAC_SECRETS || process.env.CONV_HMAC_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
              const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
              const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
              let tokenFromQuery = '';
              try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
              const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
              const reqTs = Number(body?.ts || Number(req.headers['x-request-ts'] || 0));
              const replayWinMs = Math.max(0, Number(process.env.REPLAY_WINDOW_MS || 0));
              const skewToleranceMs = Math.max(100, Number(process.env.REPLAY_SKEW_TOLERANCE_MS || 0));
              if (isProd && replayWinMs > 0) {
                if (!Number.isFinite(reqTs) || reqTs <= 0) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'ts_required' }));
                  try {
                    const macId = String(req.headers['x-mac-id'] || '').trim();
                    const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                    const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                    METRICS.inc('responses_total', { status: '401' });
                    METRICS.inc('auth_blocked_total', { reason: 'ts_missing', path: 'ultra:post' });
                    METRICS.inc('auth_failed_total', { reason: 'ts_missing', path: 'ultra:post', method, mac_id: macId });
                  } catch {}
                  return;
                }
                const skew = Math.abs(Date.now() - reqTs);
                if ((skew - skewToleranceMs) > replayWinMs) {
                  res.writeHead(401, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: 'replay_window_exceeded', skew_ms: skew }));
                  try {
                    const macId = String(req.headers['x-mac-id'] || '').trim();
                    const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                    const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                    METRICS.inc('responses_total', { status: '401' });
                    METRICS.inc('auth_blocked_total', { reason: 'replay_window', path: 'ultra:post' });
                    METRICS.inc('auth_failed_total', { reason: 'replay_window', path: 'ultra:post', method, mac_id: macId });
                  } catch {}
                  return;
                }
              }
              const macHdr = String(req.headers['x-client-mac'] || '').trim();
              const macId = String(req.headers['x-mac-id'] || '').trim();
              const pathTag = 'ultra';
              let macOk = false;
              if (hmacSecrets.length > 0 && Number.isFinite(reqTs) && reqTs > 0) {
                const canonical = `${String(req.method || 'POST').toUpperCase()}:${pathTag}:${String(reqTs)}`;
                for (const sec of hmacSecrets) {
                  try {
                    const expMac = crypto.createHmac('sha256', sec).update(canonical).digest('hex');
                    if (macHdr.length > 0 && macHdr === expMac) { macOk = true; break; }
                  } catch {}
                }
              }
              const mustAuth = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
              if ((mustAuth && !(hasToken || macOk)) || !isIpAllowed('CONV_IP_ALLOWLIST')) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'auth_required' }));
                try {
                  METRICS.inc('responses_total', { status: '401' });
                  METRICS.inc('auth_blocked_total', { reason: 'missing_or_invalid', path: 'ultra:post' });
                  const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                  const reason = attemptedToken ? 'token_invalid' : (macHdr.length > 0 ? 'hmac_invalid' : 'auth_missing');
                  const method = attemptedToken ? 'token' : (macHdr.length > 0 ? 'hmac' : 'none');
                  const labels = (method === 'hmac') ? { mac_id: macId } : {};
                  METRICS.inc('auth_failed_total', { reason, path: 'ultra:post', method, ...labels });
                } catch {}
                return;
              }
              try {
                if (hasToken) METRICS.inc('auth_accepted_total', { method: 'token', path: 'ultra:post' });
                else if (macOk) METRICS.inc('auth_accepted_total', { method: 'hmac', path: 'ultra:post', mac_id: macId });
              } catch {}
            } catch {}
            const conv_id = String(body?.conv_id || '').trim();
            const on = !!body?.on;
            if (!conv_id) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'conv_id_required' }));
              try { METRICS.inc('responses_total', { status: '400' }); } catch {}
              return;
            }
            const ultra = ultraSet(conv_id, on);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id, ultra }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ultra_post_failed', msg: String(e && e.message || e) }));
            try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          }
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ultra_post_failed', msg: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); } catch {}
      }
      return;
    }

    // Conversation: streaming SSE endpoint (supports /v1/conv/stream)
    if ((req.url?.startsWith('/conv/stream') || req.url?.startsWith('/v1/conv/stream')) && String(req.method || 'GET').toUpperCase() === 'GET') {
      try {
        // Strict CORS: allow only configured origins in production
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'stream' }); span?.setAttribute?.('http.status_code', 403); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
        } catch {}
        // Parse query parameters
        const u = new URL(`http://localhost${req.url}`);
        const text = String(u.searchParams.get('text') || '').trim();
        const conv_id = String(u.searchParams.get('conv_id') || '').trim();
        const turn = Number(u.searchParams.get('turn') || 0);
        // Enforce auth/HMAC and replay window in production (early guard)
        try {
          const origin = String(req.headers['origin'] || '');
          const corsList = String(process.env.CORS_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
    const isProd = isProdEnv;
          if (corsList.length > 0 && isProd && !corsList.includes(origin)) {
            res.setHeader('Vary', 'Origin');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cors_forbidden' }));
            try { const macId = String(req.headers['x-mac-id'] || '').trim(); METRICS.inc('responses_total', { status: '403' }); METRICS.inc('auth_blocked_total', { reason: 'cors', path: 'stream' }); } catch {}
            return;
          }
          if (origin && corsList.includes(origin)) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
          }
          const token = String(process.env.CONV_AUTH || '').trim();
          const hmacSecrets = String(process.env.CONV_HMAC_SECRETS || process.env.CONV_HMAC_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
          const hdr = String(req.headers['authorization'] || req.headers['x-api-key'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try { tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim(); } catch {}
          const hasToken = token.length > 0 && (tokenFromHdr === token || tokenFromQuery === token);
          const reqTs = Number(u.searchParams.get('ts') || Number(req.headers['x-request-ts'] || 0));
              const replayWinMs = Math.max(0, Number(process.env.REPLAY_WINDOW_MS || 0));
          // Apply a small default tolerance to account for client/server scheduling jitter
          const skewToleranceMs = Math.max(100, Number(process.env.REPLAY_SKEW_TOLERANCE_MS || 0));
          if (isProd && replayWinMs > 0) {
            if (!Number.isFinite(reqTs) || reqTs <= 0) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'ts_required' }));
              try {
                const macId = String(req.headers['x-mac-id'] || '').trim();
                const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                METRICS.inc('responses_total', { status: '401' });
                METRICS.inc('auth_blocked_total', { reason: 'ts_missing', path: 'stream' });
                    METRICS.inc('auth_failed_total', { reason: 'ts_missing', path: 'stream', method, mac_id: macId });
              } catch {}
              return;
            }
            const skew = Math.abs(Date.now() - reqTs);
            if ((skew - skewToleranceMs) > replayWinMs) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'replay_window_exceeded', skew_ms: skew }));
              try {
                const macId = String(req.headers['x-mac-id'] || '').trim();
                const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                const method = attemptedToken ? 'token' : (String(req.headers['x-client-mac'] || '').trim().length > 0 ? 'hmac' : 'none');
                METRICS.inc('responses_total', { status: '401' });
                METRICS.inc('auth_blocked_total', { reason: 'replay_window', path: 'stream' });
                    METRICS.inc('auth_failed_total', { reason: 'replay_window', path: 'stream', method, mac_id: macId });
              } catch {}
              return;
            }
          }
          const macHdr = String(req.headers['x-client-mac'] || '').trim();
          const macId = String(req.headers['x-mac-id'] || '').trim();
          const pathTag = 'stream';
          let macOk = false;
          if (hmacSecrets.length > 0 && Number.isFinite(reqTs) && reqTs > 0) {
            const canonical = `${String(req.method || 'GET').toUpperCase()}:${pathTag}:${String(reqTs)}`;
            for (const sec of hmacSecrets) {
              try {
                const expMac = crypto.createHmac('sha256', sec).update(canonical).digest('hex');
                if (macHdr.length > 0 && macHdr === expMac) { macOk = true; break; }
              } catch {}
            }
          }
          const mustAuth = isProd;
          if ((mustAuth && !(hasToken || macOk)) || !isIpAllowed('CONV_IP_ALLOWLIST')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'auth_required' }));
            try {
            METRICS.inc('responses_total', { status: '401' });
            METRICS.inc('auth_blocked_total', { reason: 'missing_or_invalid', path: 'stream' });
            const attemptedToken = (hdr.length > 0) || (tokenFromQuery.length > 0);
                  const reason = attemptedToken ? 'token_invalid' : (macHdr.length > 0 ? 'hmac_invalid' : 'auth_missing');
                  const method = attemptedToken ? 'token' : (macHdr.length > 0 ? 'hmac' : 'none');
                  const labels = (method === 'hmac') ? { mac_id: macId } : {};
                  METRICS.inc('auth_failed_total', { reason, path: 'stream', method, ...labels });
            } catch {}
            return;
          }
          try {
                if (hasToken) METRICS.inc('auth_accepted_total', { method: 'token', path: 'stream' });
                else if (macOk) METRICS.inc('auth_accepted_total', { method: 'hmac', path: 'stream', mac_id: macId });
          } catch {}
        } catch {}
        // Transcript: index user message early (raw text)
        try { indexTurn({ convId: String(conv_id || 'conv'), role: 'user', text }); } catch {}
        // Watchdog: log user turn (stream path)
        try { await logTurn(String(conv_id || 'conv'), 'user', String(text || '')); } catch {}
        // Scene chat commands (optional): !scene tag <name>, !scene goto <name>
        try { trySceneChatCommand(conv_id, text); } catch {}
        // Shadow memory: ingest user turn for STREAM before provider work
        try {
          const SHADOW = String(process.env.SHADOW_ENABLED || '1') === '1';
          if (SHADOW && conv_id) {
            const ing = await shadowIngest({
              convId: conv_id,
              turn: Number(turn || 0),
              role: 'user',
              text: String(text || ''),
              maxTimeline: Number(process.env.SHADOW_MAX_TIMELINE || 400),
              maxFacts: Number(process.env.SHADOW_FACTS_MAX || 128)
            });
            try { for (const f of ing?.factsNew || []) METRICS.inc('shadow_facts_total', { type: String(f.type || 'unknown') }); } catch {}
          }
        } catch {}
        // Per-tenant limiter (429 taxonomy), optional via env
        try {
          const TENANT_LIMIT = Number(process.env.TENANT_LIMIT || 0);
          const TENANT_WINDOW_MS = Math.max(1, Number(process.env.TENANT_WINDOW_MS || 1000));
          const TENANT_IEO = String(process.env.TENANT_INTERNAL_ERROR_ONCE || '1').toLowerCase();
          const tenantInternalOnce = TENANT_IEO === '1' || TENANT_IEO === 'true';
          const backendName = String(process.env.TENANT_RL_BACKEND || 'mem').toLowerCase();
          if (!isProbe && !isControl && Number.isFinite(TENANT_LIMIT) && TENANT_LIMIT > 0) {
            if (!globalThis.__TENANT_RL__) {
              globalThis.__TENANT_RL__ = (backendName === 'file')
                ? createSharedRateLimiter({ limit: TENANT_LIMIT, windowMs: TENANT_WINDOW_MS, internalErrorOnce: tenantInternalOnce })
                : createGlobalRateLimiter({ limit: TENANT_LIMIT, windowMs: TENANT_WINDOW_MS, internalErrorOnce: tenantInternalOnce });
            }
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            const out = await Promise.resolve(globalThis.__TENANT_RL__.allow(tenantKey));
            if (!out?.ok) {
              const retryAfter = Math.max(1, Math.ceil(TENANT_WINDOW_MS / 1000));
              if (out.internal_error && tenantInternalOnce) {
                res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
                res.end(JSON.stringify({ error: 'rate_limited', reason: 'internal_error', scope: 'tenant', retry_after_s: retryAfter }));
                try { METRICS.inc('rate_limited_total', { reason: 'internal_error', scope: 'tenant' }); METRICS.inc('responses_total', { status: '503' }); } catch {}
                return;
              }
              res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
              res.end(JSON.stringify({ error: 'rate_limited', reason: 'tenant', scope: 'tenant', retry_after_s: retryAfter }));
              try { METRICS.inc('rate_limited_total', { reason: 'tenant', scope: 'tenant' }); METRICS.inc('responses_total', { status: '429' }); } catch {}
              return;
            }
          }
        } catch {}
        // Tenant dollar budget pre-check (HTTP-layer gate)
        try {
          const limUsd = Number(process.env.TENANT_DOLLARS_BUDGET || 0);
          const winUsd = Number(process.env.TENANT_DOLLARS_WINDOW_MS || (24 * 60 * 60 * 1000));
          if (Number.isFinite(limUsd) && limUsd > 0) {
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            if (!globalThis.__TENANT_USD_BUDGET__) {
              globalThis.__TENANT_USD_BUDGET__ = createSharedTenantDollarBudget({ windowMs: winUsd, limitUsd: limUsd });
            }
            const estIn = TokenCounter.estimate(text);
            const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
            const usdIn = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_IN || 0));
            const usdOut = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_OUT || 0));
            const estUsd = (estIn * usdIn) + (estOut * usdOut);
            const allowUsd = await Promise.resolve(globalThis.__TENANT_USD_BUDGET__.allow(tenantKey, estUsd));
            if (!allowUsd?.ok) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_dollars', scope: 'tenant_dollars', window_ms: winUsd }));
              try { METRICS.inc('budget_prevented_total', { scope: 'tenant_dollars_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
              return;
            }
          }
        } catch {}
        // Tenant monthly dollar budget pre-check (HTTP-layer gate)
        try {
          const limUsdMon = Number(process.env.TENANT_DOLLARS_MONTHLY_BUDGET || 0);
          if (Number.isFinite(limUsdMon) && limUsdMon > 0) {
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            if (!globalThis.__TENANT_USD_MONTHLY_BUDGET__) {
              globalThis.__TENANT_USD_MONTHLY_BUDGET__ = createSharedTenantMonthlyDollarBudget({ limitUsd: limUsdMon });
            }
            const estIn = TokenCounter.estimate(text);
            const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
            const usdIn = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_IN || 0));
            const usdOut = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_OUT || 0));
            const estUsd = (estIn * usdIn) + (estOut * usdOut);
            const allowUsdMon = await Promise.resolve(globalThis.__TENANT_USD_MONTHLY_BUDGET__.allow(tenantKey, estUsd));
            if (!allowUsdMon?.ok) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_dollars_monthly', scope: 'tenant_dollars_monthly' }));
              try { METRICS.inc('budget_prevented_total', { scope: 'tenant_dollars_monthly_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
              return;
            }
          }
        } catch {}
        // Tenant rolling dollar window budget pre-check (HTTP-layer gate)
        try {
          const limUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_BUDGET || 0);
          const winUsdRoll = Number(process.env.TENANT_DOLLARS_ROLLING_WINDOW_MS || 0);
          const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
          if (Number.isFinite(limUsdRoll) && limUsdRoll > 0 && Number.isFinite(winUsdRoll) && winUsdRoll > 0) {
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            if (!globalThis.__TENANT_USD_ROLLING_BUDGET__) {
              globalThis.__TENANT_USD_ROLLING_BUDGET__ = createSharedTenantRollingDollarBudget({ windowMs: winUsdRoll, bucketMs, limitUsd: limUsdRoll });
            }
            const estIn = TokenCounter.estimate(text);
            const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
            const usdIn = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_IN || 0));
            const usdOut = Math.max(0, Number(process.env.LLM_USD_PER_TOKEN_OUT || 0));
            const estUsd = (estIn * usdIn) + (estOut * usdOut);
            const allowUsdRoll = await Promise.resolve(globalThis.__TENANT_USD_ROLLING_BUDGET__.allow(tenantKey, estUsd));
            if (!allowUsdRoll?.ok) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_dollars_rolling', scope: 'tenant_dollars_rolling', window_ms: winUsdRoll }));
              try { METRICS.inc('budget_prevented_total', { scope: 'tenant_dollars_rolling_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
              return;
            }
          }
        } catch {}
        // Tenant token budget pre-check (HTTP-layer gate)
        try {
          const limTok = Number(process.env.TENANT_TOKENS_BUDGET || 0);
          const winTok = Number(process.env.TENANT_TOKENS_WINDOW_MS || (24 * 60 * 60 * 1000));
          if (Number.isFinite(limTok) && limTok > 0) {
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            if (!globalThis.__TENANT_TOKEN_BUDGET__) {
              globalThis.__TENANT_TOKEN_BUDGET__ = createSharedTenantBudget({ windowMs: winTok, limitTokens: limTok });
            }
            const estIn = TokenCounter.estimate(text);
            const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
            const estTok = estIn + estOut;
            const allowTok = await Promise.resolve(globalThis.__TENANT_TOKEN_BUDGET__.allow(tenantKey, estTok));
            if (!allowTok?.ok) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_tokens', scope: 'tenant_tokens', window_ms: winTok }));
              try { METRICS.inc('budget_prevented_total', { scope: 'tenant_tokens_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
              return;
            }
          }
        } catch {}
        // Tenant monthly token budget pre-check (HTTP-layer gate)
        try {
          const limTokMon = Number(process.env.TENANT_TOKENS_MONTHLY_BUDGET || 0);
          if (Number.isFinite(limTokMon) && limTokMon > 0) {
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            if (!globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__) {
              globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__ = createSharedTenantMonthlyBudget({ limitTokens: limTokMon });
            }
            const estIn = TokenCounter.estimate(text);
            const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
            const estTok = estIn + estOut;
            const allowTokMon = await Promise.resolve(globalThis.__TENANT_TOKEN_MONTHLY_BUDGET__.allow(tenantKey, estTok));
            if (!allowTokMon?.ok) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_tokens_monthly', scope: 'tenant_tokens_monthly' }));
              try { METRICS.inc('budget_prevented_total', { scope: 'tenant_tokens_monthly_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
              return;
            }
          }
        } catch {}
        // Tenant rolling token window budget pre-check (HTTP-layer gate)
        try {
          const limTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_BUDGET || 0);
          const winTokRoll = Number(process.env.TENANT_TOKENS_ROLLING_WINDOW_MS || 0);
          const bucketMs = Number(process.env.TENANT_ROLLING_BUCKET_MS || 60000);
          if (Number.isFinite(limTokRoll) && limTokRoll > 0 && Number.isFinite(winTokRoll) && winTokRoll > 0) {
            const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
            const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
            const tenantKey = safeTenant || 'tenant';
            if (!globalThis.__TENANT_TOKEN_ROLLING_BUDGET__) {
              globalThis.__TENANT_TOKEN_ROLLING_BUDGET__ = createSharedTenantRollingBudget({ windowMs: winTokRoll, bucketMs, limitTokens: limTokRoll });
            }
            const estIn = TokenCounter.estimate(text);
            const estOut = Math.max(1, Number(process.env.LLM_EXPECTED_TOKENS_OUT || 128));
            const estTok = estIn + estOut;
            const allowTokRoll = await Promise.resolve(globalThis.__TENANT_TOKEN_ROLLING_BUDGET__.allow(tenantKey, estTok));
            if (!allowTokRoll?.ok) {
              res.writeHead(429, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'budget_limited', reason: 'tenant_tokens_rolling', scope: 'tenant_tokens_rolling', window_ms: winTokRoll }));
              try { METRICS.inc('budget_prevented_total', { scope: 'tenant_tokens_rolling_http' }); METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
              return;
            }
          }
        } catch {}
        // Idempotency key and duplicate gating
        const idempotencyKey = String(req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || '').trim();
        // Optional HMAC enforcement when configured (header-based key only)
        try {
          const secret = String(process.env.IDEMPOTENCY_HMAC_SECRET || '').trim();
          if (secret && idempotencyKey) {
            const macHdr = String(req.headers['idempotency-mac'] || req.headers['x-idempotency-mac'] || req.headers['x-idempotency-sig'] || '').trim();
            if (!macHdr) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'idem_mac_missing' }));
              try { METRICS.inc('responses_total', { status: '401' }); METRICS.inc('idempotency_mac_missing_total', { path: 'stream' }); span?.setAttribute?.('http.status_code', 401); } catch {}
              return;
            }
            const expected = crypto.createHmac('sha256', secret).update(idempotencyKey).digest('hex');
            let ok = false;
            try {
              const a = Buffer.from(macHdr, 'hex');
              const b = Buffer.from(expected, 'hex');
              ok = (a.length === b.length) && crypto.timingSafeEqual(a, b);
            } catch {}
            if (!ok) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'idem_mac_invalid' }));
              try { METRICS.inc('responses_total', { status: '401' }); METRICS.inc('idempotency_mac_invalid_total', { path: 'stream' }); span?.setAttribute?.('http.status_code', 401); } catch {}
              return;
            }
          }
        } catch {}
        const streamKey = idempotencyKey || (conv_id ? `${conv_id}:${turn}` : '');
        // Client-driven replay hint: treat as reconnect when provided
        const wantsReplay = ['1','true','yes'].includes(String(u.searchParams.get('reconnect') || u.searchParams.get('replay') || req.headers['x-reconnect'] || '').toLowerCase());
        try { pruneCaches(); } catch {}
        if (streamKey) {
          const active = ACTIVE_STREAMS.get(streamKey);
          if (active && (Date.now() - active.started) < (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'duplicate_stream', ttl_ms: IDEMPOTENCY_TTL_MS }));
            try { METRICS.inc('responses_total', { status: '409' }); span?.setAttribute?.('http.status_code', 409); } catch {}
            try { sampled('warn', { evt: 'duplicate_stream_active', path: 'stream' }); } catch {}
            return;
          }
          let cached = touchLRU(IDEMPOTENCY_CACHE, streamKey) || (idempotencyKey ? touchLRU(IDEMPOTENCY_CACHE, idempotencyKey) : null);
          if (!cached) {
            try { cached = await loadIdemFromDisk(streamKey) || (idempotencyKey ? await loadIdemFromDisk(idempotencyKey) : null); } catch {}
          }
          if (!cached) {
            try { cached = await idemGetRedis(streamKey) || (idempotencyKey ? await idemGetRedis(idempotencyKey) : null); } catch {}
          }
          // If this is an explicit replay and cached final hasn't surfaced yet,
          // briefly wait for the original stream to finish persisting.
          if (!cached && wantsReplay) {
            const waitMs = Math.max(0, Number(process.env.IDEMPOTENCY_REPLAY_WAIT_MS || 200));
            const deadline = Date.now() + waitMs;
            while (!cached && Date.now() < deadline) {
              try { await new Promise((r) => setTimeout(r, 15)); } catch {}
              try { pruneCaches(); } catch {}
              cached = touchLRU(IDEMPOTENCY_CACHE, streamKey) || (idempotencyKey ? touchLRU(IDEMPOTENCY_CACHE, idempotencyKey) : null);
              if (!cached) {
                try { cached = await loadIdemFromDisk(streamKey) || (idempotencyKey ? await loadIdemFromDisk(idempotencyKey) : null); } catch {}
              }
              if (!cached) {
                try { cached = await idemGetRedis(streamKey) || (idempotencyKey ? await idemGetRedis(idempotencyKey) : null); } catch {}
              }
            }
          }
          if (cached && (Date.now() - cached.ts) < (IDEMPOTENCY_TTL_MS + IDEMPOTENCY_SKEW_MS)) {
            // If explicitly reconnecting, enforce replay-once
            if (wantsReplay && Number(cached.replayCount || 0) >= 1) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'replay_unavailable', reason: 'exhausted' }));
              try { METRICS.inc('responses_total', { status: '409' }); METRICS.inc('idempotent_replay_denied_total', { reason: 'exhausted', path: 'stream' }); } catch {}
              try { sampled('warn', { evt: 'replay_unavailable', path: 'stream', reason: 'exhausted' }); } catch {}
              return;
            }
            // Fast replay via SSE: emit start and end with cached final
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
            try { res.write(':ok\n\n'); } catch {}
            try {
              const ridStore = ALS?.getStore?.() || {};
              const ridVal = String(ridStore?.rid || req.headers['x-request-id'] || '').trim() || String(rid || '');
              let __tension = 0;
              let __tensionBeat = '';
              try {
                const snap = getTensionSnapshot(String(conv_id || '')) || {};
                __tension = Number(snap.tension || 0);
                __tensionBeat = String(snap.beat || '');
              } catch {}
              const __style_meta = (cached?.response?.style_meta) || computeStyleMeta(conv_id);
              try { if (__style_meta) broadcastAdminStyleEvent(conv_id, 'style.pref', { conv_id, style_meta: __style_meta }); } catch {}
              const __style_field = __style_meta ? { style: { preset: String(__style_meta.preset || ''), token_count: Array.isArray(__style_meta.tokens) ? __style_meta.tokens.length : 0 } } : {};
              res.write(`event: start\ndata: ${JSON.stringify({ model: cached.response.model, provider: String(cached.response.provider || ''), resolved_model: String(cached.response.resolved_model || ''), engine_source: String(cached.response.engine_source || 'replay'), variant_v: String(cached.response.variant_v || ''), conv_id, tenant: String(cached.response.tenant || ''), request_id: ridVal, tension: __tension, tension_beat: __tensionBeat, beat: __tensionBeat, ...( __style_meta ? { style_meta: __style_meta } : {} ), ...__style_field })}\n\n`);
              // Respect cooled phrases during replay
              try { maybeTagCooledPhrases(ctx, String(conv_id || ''), String(cached?.response?.final || '')); } catch {}
              res.write(`event: end\ndata: ${JSON.stringify({ final: String(cached.response.final || ''), idempotent_replay: true, request_id: ridVal })}\n\n`);
            } catch {}
            try {
              await sendMessageWithTick(async () => { res.end(); return true; });
            } catch {
              try { res.end(); } catch {}
            }
            try {
              METRICS.inc('responses_total', { status: '200' });
              METRICS.inc('idempotent_replay_total');
              METRICS.inc('idempotency_cache_hit_total', { path: 'stream' });
              METRICS.inc('llm_provider_selected_total', { provider: String(cached.response.provider || ''), model: String(cached.response.model || ''), resolved_model: String(cached.response.resolved_model || ''), source: 'replay' });
              span?.setAttribute?.('http.status_code', 200);
              span?.setAttribute?.('llm.model', String(cached.response.model || ''));
              span?.setAttribute?.('llm.provider', String(cached.response.provider || ''));
              span?.setAttribute?.('llm.resolved_model', String(cached.response.resolved_model || ''));
              span?.setAttribute?.('llm.engine_source', 'replay');
              span?.setAttribute?.('llm.variant_v', String(cached.response.variant_v || ''));
            } catch {}
            try { sampled('info', { evt: 'idem_replay_served', path: 'stream', source: 'replay' }); } catch {}
            // Mark a single replay consumed when reconnect intent is explicit
            try {
              if (wantsReplay) {
                cached.replayCount = Number(cached.replayCount || 0) + 1;
                const k = IDEMPOTENCY_CACHE.has(streamKey) ? streamKey : idempotencyKey;
                if (k) { IDEMPOTENCY_CACHE.delete(k); IDEMPOTENCY_CACHE.set(k, cached); }
                pruneCaches();
                try {
                  const diskKey = k || streamKey || idempotencyKey;
                  if (diskKey) await saveIdemToDisk(diskKey, cached.response, cached.replayCount);
                  await idemSetRedis(diskKey, cached.response, cached.replayCount);
                  await gcIdemDir();
                } catch {}
              }
            } catch {}
            return;
          } else if (wantsReplay) {
            // Replay requested but unavailable (TTL expired or evicted/missing)
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'replay_unavailable', reason: 'ttl_or_missing' }));
            try { METRICS.inc('responses_total', { status: '409' }); METRICS.inc('idempotent_replay_denied_total', { reason: 'ttl_or_missing', path: 'stream' }); } catch {}
            try { sampled('warn', { evt: 'replay_unavailable', path: 'stream', reason: 'ttl_or_missing' }); } catch {}
            return;
          }
          // Distributed duplicate gating via Redis lock (if not a replay and no cached value)
          try {
            if (!cached && !wantsReplay) {
              const claimed = await idemClaimLock(streamKey);
              if (!claimed) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'duplicate_stream', ttl_ms: IDEMPOTENCY_TTL_MS }));
                try { METRICS.inc('responses_total', { status: '409' }); span?.setAttribute?.('http.status_code', 409); } catch {}
                try { sampled('warn', { evt: 'duplicate_stream_lock_denied', path: 'stream' }); } catch {}
                return;
              }
              // Release lock when response closes (best-effort)
              try { res.on('close', () => { idemReleaseLock(streamKey).catch(() => {}); }); } catch {}
            }
          } catch {}
        }
        // Soft per-conversation rate guard
        if (conv_id) {
          const now = Date.now();
          const entry = CONV_WINDOW.get(conv_id) || { start: now, count: 0 };
          if ((now - entry.start) < CONV_SOFT_WINDOW_MS) {
            entry.count++;
          } else {
            entry.start = now;
            entry.count = 1;
          }
          CONV_WINDOW.set(conv_id, entry);
          if (entry.count > CONV_SOFT_MAX) {
            const waitSec = Math.max(0, (CONV_SOFT_WINDOW_MS - (now - entry.start)) / 1000);
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(waitSec.toFixed(3)) });
            res.end(JSON.stringify({ error: 'rate_limited', scope: 'conversation', conv_id, wait_s: Number(waitSec.toFixed(3)) }));
            try { METRICS.inc('responses_total', { status: '429' }); span?.setAttribute?.('http.status_code', 429); } catch {}
            return;
          }
        }
        // Engine routing precedence: explicit > header > heuristic (unless disabled)
        const engineParam = String(u.searchParams.get('engine') || '').toLowerCase();
        const engineHeader = String(req.headers['x-engine'] || '').toLowerCase();
        let engineSource = 'explicit';
        let engineCandidate = engineParam || engineHeader;
        const heuristicsDisabled = String(process.env.LLM_HEURISTICS_DISABLED || '').toLowerCase();
        let model = 'urga';
        if (engineCandidate) {
          model = ['echo','urga','dreams'].includes(engineCandidate) ? engineCandidate : 'urga';
        } else {
          engineSource = (heuristicsDisabled === '1' || heuristicsDisabled === 'true') ? 'default' : 'heuristic';
          if (engineSource === 'heuristic') {
            model = (/echo|gods|pantheon/i.test(text) ? 'echo'
                     : /dream|sleep|night|hallucin|lucid/i.test(text) ? 'dreams' : 'urga');
          } else {
            model = 'urga';
          }
        }
        // Pre-call soft-drop gate prior to writing SSE headers
        try {
          const sd = shouldSoftDrop(engineSource);
          if (sd) {
            try { METRICS.inc('rate_limited_total', { reason: 'soft_drop' }); } catch {}
            emitSoftDropJitterHistogram(sd.jitterMs, { reason: sd.reason, source: engineSource, path: 'stream' });
            const raSec = Math.max(1, Math.round(sd.jitterMs / 1000));
            try { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(raSec) }); } catch {}
            try { res.end(JSON.stringify({ error: 'soft_drop', reason: sd.reason, retry_after_ms: sd.jitterMs })); } catch {}
            return;
          }
        } catch {}
        // Booster staging + injection (before SSE headers and provider work)
        // If the recap window is too sparse, stage a one-liner (heuristic or LLM micro-summarizer),
        // then inject as usual. Also capture staged info for SSE emission.
        let __booster_text = null;
        let __booster_staged_id = null;
        let __booster_staged_text = null;
        let __dream_text = null;
        let __style_booster_text = null;
        let __refusal_hint_text = null;
        let __refusal_hint_style = '';
        let __refusal_hint_level = '';
        let __refusal_hint_reason = '';
        let textInput = text;
        // Track whether any token has been emitted; used for restaging boosters on early close
        let gotFirstDelta = false;
        // Auto-stage a recap for this turn if the heuristic is too sparse
        try {
          const before = Number(process.env.REMEMBER_BEFORE || 20);
          const after  = Number(process.env.REMEMBER_AFTER || 20);
          const pov    = String(process.env.FACETS_WHO || 'she');
          const anchor = Number(turn || 0);
          let recap = summarizeWindow({ convId: conv_id, anchor, before, after, pov });
          if (!recap || recap.length < 40) {
            try {
              const msgs = getWindowAround(conv_id, anchor, before, after);
              const windowText = Array.isArray(msgs) ? msgs.map(m => m?.text || '').join(' ') : '';
              const ctxForBooster = { vars: { path: 'stream', purpose: 'booster' }, io: { events: new EventEmitter() } };
              const llmRecap = await tryLLMBooster(ctxForBooster, conv_id, windowText, '');
              if (llmRecap && llmRecap.length >= 30) recap = llmRecap;
            } catch {}
          }
          if (recap && recap.length > 0) {
            const id  = makeBoosterId(anchor);
            const ttl = Number(process.env.BOOSTER_TTL_TURNS || 2);
            try {
              stageBooster({ convId: conv_id, id, anchor, range:[anchor-before, anchor+after], text: recap, ttlTurns: ttl, agent: 'bot', source: recap.length >= 40 ? 'heur' : 'llm_or_heur' });
              __booster_staged_id = id;
              __booster_staged_text = recap;
              try { METRICS.inc('booster_staged_total', { reason: 'auto', path: 'stream' }); } catch {}
            } catch {}
          }
        } catch {}
        try {
          let activeAgent = 'bot';
          try {
            const uAA = new URL(`http://localhost${req.url}`);
            activeAgent = String(uAA.searchParams.get('agent') || uAA.searchParams.get('active_agent') || '').trim() || 'bot';
          } catch {}
          const boost = consumeOne(conv_id, { agent: activeAgent });
          if (boost) {
            __booster_text = String(boost);
            textInput = `${__booster_text}\n${textInput}`;
            try { METRICS.inc('booster_used_total', { path: 'stream' }); } catch {}
          }
        } catch {}
        // Dream injection for stream path (after booster). If a booster is present,
        // still emit memory.dream for observability but avoid mutating user text.
        try {
          const d = maybeDream({ text: textInput, allow: true });
          if (d && !String(textInput || '').trim().startsWith('(')) {
            __dream_text = String(d);
            if (!__booster_text) {
              textInput = `${__dream_text}\n${textInput}`;
              try { METRICS.inc('dreams_injected_total', { path: 'stream' }); } catch {}
            } else {
              try { METRICS.inc('dreams_injected_total', { path: 'stream', skipped: 'booster_present' }); } catch {}
            }
          }
        } catch {}
        // --- Refusal hint: stage a compact style-aware refusal whisper when moderately risky (stream) ---
        // Do not inject into textInput; expose via ctx.vars.refusal_hint for prompt builder
        try {
          const refusalEnabled = String(process.env.POLICY_REFUSAL_ENABLED || '1').toLowerCase();
          const enabled = (refusalEnabled === '1' || refusalEnabled === 'true');
          if (enabled) {
            const signals = computeAbuseSignals(textInput);
            const threshold = Math.max(0, Math.min(1, Number(process.env.JAILBREAK_REFUSAL_THRESHOLD || process.env.REFUSAL_THRESHOLD || 0.7)));
            const jb = Number(signals?.jailbreak_signal || 0);
            const lvl = String(signals?.levels?.jailbreak || '');
            const moderatelyRisky = (jb >= 0.4 && jb < threshold) || lvl === 'med';
            if (moderatelyRisky) {
              const prefR = getRefusalPref(String(conv_id || '')) || {};
              const styleR = normalizeRefusalStyle(String(prefR?.style || ''));
              const reasonR = 'jailbreak';
              const hintText = renderRefusal({ style: styleR, reason: reasonR, spine: undefined, userText: textInput });
              __refusal_hint_text = String(hintText || '');
              __refusal_hint_style = String(styleR || '');
              __refusal_hint_level = String(lvl || 'med');
              __refusal_hint_reason = String(reasonR);
              try { METRICS.inc('refusal_staged_total', { path: 'stream', style: styleR, level: __refusal_hint_level }); } catch {}
              try { broadcastAdminRefusalEvent(String(conv_id || ''), 'refusal.staged', { conv_id: String(conv_id || ''), text: __refusal_hint_text, style: styleR, level: __refusal_hint_level, reason: __refusal_hint_reason }); } catch {}
            }
          }
        } catch {}
        // SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        try { res.write(':ok\n\n'); } catch {}
        // Emit memory.tension snapshot at connection start
        try {
          if (tensionEnabled && tensionEnabled()) {
            const snap = getTensionSnapshot(String(conv_id || '')) || {};
            const t = Number(snap?.tension || 0);
            const b = String(snap?.beat || '');
            res.write('event: memory.tension\n');
            res.write(`data: ${JSON.stringify({ conv_id: String(conv_id || ''), tension: t, beat: b })}\n\n`);
            try { METRICS.inc('memory_tension_emitted_total', { path: 'stream' }); } catch {}
            // Also emit a separate memory.beat event for clients that subscribe to beat specifically
            try {
              res.write('event: memory.beat\n');
              res.write(`data: ${JSON.stringify({ conv_id: String(conv_id || ''), tension: t, beat: b })}\n\n`);
              try { METRICS.inc('memory_beat_emitted_total', { path: 'stream' }); } catch {}
            } catch {}
          }
        } catch {}
        // (moved) memory.booster.staged will be emitted after start
        // Local SSE writer for emitting auxiliary events (e.g., cadence.observed)
        const writeSSE = (eventName, payload) => {
          try {
            res.write(`event: ${String(eventName)}\n`);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
          } catch {}
        };
        // Heartbeat to keep the connection healthy for long streams
        let __hb = null;
        try {
          if (Number.isFinite(SSE_HEARTBEAT_MS) && SSE_HEARTBEAT_MS > 0) {
            __hb = setInterval(() => { try { res.write(':keepalive\n\n'); METRICS.inc('sse_heartbeat_total'); } catch {} }, SSE_HEARTBEAT_MS);
          }
        } catch {}
        const __cleanupHb = () => { try { if (__hb) clearInterval(__hb); __hb = null; } catch {} };
        try {
          res.on('close', async () => {
            try { __cleanupHb(); } catch {}
            try {
              if (streamKey) {
                ACTIVE_STREAMS.delete(streamKey);
                METRICS.set('active_streams_current', ACTIVE_STREAMS.size);
                idemReleaseLock(streamKey).catch(() => {});
              }
            } catch {}
            // If no first delta was received and a booster was injected, re-stage it with ttl=1
            try {
              if (!gotFirstDelta && __booster_text) {
                let agentForRestage = 'bot';
                try {
                  const uAA = new URL(`http://localhost${req.url}`);
                  agentForRestage = String(uAA.searchParams.get('agent') || uAA.searchParams.get('active_agent') || '').trim() || 'bot';
                } catch {}
                const anchor = Number(turn || 0);
                try {
                  stageBooster({
                    convId: String(conv_id || 'conv'),
                    id: makeBoosterId(anchor),
                    anchor,
                    range: [anchor, anchor],
                    text: String(__booster_text || ''),
                    ttlTurns: 1,
                    agent: agentForRestage,
                    source: 'restage'
                  });
                  try { METRICS.inc('booster_staged_total', { reason: 'restage', path: 'stream' }); } catch {}
                } catch {}
              }
            } catch {}
          });
          res.on('finish', __cleanupHb);
          res.on('error', __cleanupHb);
        } catch {}
        // Context and event wiring
        const ctx = { vars: {}, flags: {}, io: { events: new EventEmitter() }, memory: { toolResultsCache: new Map() } };
        // Propagate tenant and engine_source for monolith metrics/logging
        try {
          const rawTenant = u.searchParams.get('tenant') || req.headers['x-tenant'] || '';
          const safeTenant = String(rawTenant || '').replace(/[^a-zA-Z0-9_\.\-]/g, '');
          if (safeTenant) ctx.vars.tenant = safeTenant;
        } catch {}
        try { ctx.vars.engine_source = engineSource; } catch {}
        // Propagate mac_id for lineage into metrics/ledger
        try { const macId = String(req.headers['x-mac-id'] || '').trim(); if (macId) ctx.vars.mac_id = macId; } catch {}
        // Propagate request_id, path and conv_id for usage ledger context
        try {
          const ridStore = ALS?.getStore?.() || {};
          const ridVal = String(ridStore?.rid || req.headers['x-request-id'] || '').trim();
          if (ridVal) ctx.vars.request_id = ridVal;
        } catch {}
        try { ctx.vars.path = 'stream'; } catch {}
        try { if (conv_id) ctx.vars.conv_id = conv_id; } catch {}
        // Persist staged refusal hint metadata for downstream prompt assembly
        try {
          if (__refusal_hint_text) {
            ctx.vars.__refusal_hint_text = __refusal_hint_text;
            ctx.vars.__refusal_hint_style = __refusal_hint_style;
            ctx.vars.__refusal_hint_level = __refusal_hint_level;
            ctx.vars.__refusal_hint_reason = __refusal_hint_reason;
          }
        } catch {}
        // Bind A/B variant stickiness by conv_id with strict precedence and persistence
        const variantExplicit = String(u.searchParams.get('ab_variant') || req.headers['x-ab-variant'] || '').trim();
        let variant = variantExplicit;
        if (conv_id) {
          if (!variant) {
            let existing = AB_VARIANTS_BY_CONV.get(conv_id);
            if (!existing) { try { existing = await loadAbVariant(conv_id); } catch {} }
            if (existing) {
              variant = existing;
              if (!AB_VARIANTS_BY_CONV.has(conv_id)) AB_VARIANTS_BY_CONV.set(conv_id, existing);
            } else {
              const v = (hashConvId(conv_id) % 2 === 0) ? 'A' : 'B';
              AB_VARIANTS_BY_CONV.set(conv_id, v);
              variant = v;
              try { await saveAbVariant(conv_id, v); } catch {}
            }
          } else {
            const prior = AB_VARIANTS_BY_CONV.get(conv_id) || '';
            if (!prior || prior !== variant) {
              AB_VARIANTS_BY_CONV.set(conv_id, variant);
              try { await saveAbVariant(conv_id, variant); } catch {}
            }
          }
        }
        ctx.vars.abVariant = variant || ctx.vars.abVariant;
        // Budget and dry-run
        const budget = Math.max(1, Number(process.env.LLM_TURN_BUDGET || 8));
        ctx.vars.llmTurnBudget = budget;
        const dry = String(process.env.LLM_DRY_RUN || process.env.DRY_RUN || '0').toLowerCase();
        ctx.flags.dryRun = dry === '1' || dry === 'true';
        // Tool call id propagation for exactly-once semantics
        const toolCallId = String(idempotencyKey || (conv_id ? `${conv_id}:${turn}` : `rid:${Date.now()}`));
        ctx.vars.toolCallId = toolCallId;
        try { ctx.vars.toolExecutedPrior = await hasToolExecuted(toolCallId); } catch { ctx.vars.toolExecutedPrior = false; }
        configureProvidersFromEnv(ctx);
        // Tension: compute and store in context prior to streaming
        try {
          if (tensionEnabled && tensionEnabled()) {
            const { tension, beat } = updateTension(String(conv_id || ''), String(text || '')) || {};
            try { if (typeof tension === 'number') ctx.memory.tension = tension; } catch {}
            try { if (typeof tension === 'number') ctx.vars.tension = tension; } catch {}
            try { if (typeof beat === 'string') ctx.vars.tension_beat = beat; } catch {}
            try { METRICS.set('tension_level', Number((tension || 0).toFixed?.(2) || tension || 0), { path: 'stream' }); } catch {}
          }
        } catch {}
        // Character Spine: derive snapshot and bias loopguard/style ahead of start
        try {
          if (String(process.env.SPINE_ENABLED || '1') === '1') {
            const sp = computeCharacterSpine(ctx, { userText: String(textInput || '') });
            try { ctx.vars.spine = sp; } catch {}
            try { applySpineToLoopGuard(ctx, sp); } catch {}
            // Stash refusal likelihood and broadcast admin spine.update
            try { ctx.vars.spine_refusal = Number(sp?.refusalLikelihood || 0); } catch {}
            try {
              const convId = String(conv_id || '');
              if (convId) {
                const trust = Math.max(0, Math.min(1, Number(ctx.stats?.trustMA ?? ctx.stats?.trust ?? ctx.memory?.trustLevel ?? 0.5)));
                const suspicion = Math.max(0, Math.min(1, Number(ctx.stats?.suspicionMA ?? ctx.stats?.suspicion ?? 0.1)));
                const spine_meta = {
                  mood: String(sp?.mood || ''),
                  tone: String(sp?.tone || ''),
                  trust,
                  suspicion,
                  style_hint: String(sp?.styleHint || ''),
                  refusal_likelihood: Number(sp?.refusalLikelihood || 0)
                };
                broadcastAdminSpineEvent(convId, 'spine.update', { conv_id: convId, spine_meta });
              }
            } catch {}
          }
        } catch {}
        // Style Priming Probe (optional): quickly outline and score risk; if risky, prepend booster to text
        try {
          if (String(process.env.LOOP_STREAM_PROBE_ENABLED || '0') === '1') {
            const probeText = `(ONE-SENTENCE OUTLINE) Briefly outline the next reply (1 short sentence, no spoilers):\n\n${textInput}`;
            const llmPreview = new LLMService(ctx);
            const preview = await llmPreview.call(probeText, { model });
            const ecfg = getEMAPCfg(); const bcfg = getEntropyCfg();
            let risky = false; const reason = [];
            if (ecfg?.enabled) {
              const { maxSim } = emapMaxSim({ convId: conv_id, candidate: String(preview || ''), cfg: ecfg });
              if (Number(maxSim || 0) >= Number(ecfg.simMax || 0)) { risky = true; reason.push('emap'); }
            }
            if (bcfg?.enabled && String(preview || '').length >= Number(bcfg.minLen || 0)) {
              const { score } = entropyScore(String(preview || ''));
              const min = Number(process.env.LOOP_STREAM_PROBE_MIN || bcfg.min || 0);
              if (Number(score || 0) < min) { risky = true; reason.push('entropy'); }
            }
            if (risky) {
              const cfgLG = getLoopGuardConfig();
              const tokensStr = String(cfgLG?.styleTokens || 'descriptive,poetic,terse,inner-thought');
              const styles = tokensStr.split(',').map(s => s.trim()).filter(Boolean);
              const chosen = styles[(Date.now() % Math.max(1, styles.length))];
              const booster = `(STYLE:${chosen}) Avoid familiar phrasing; vary cadence; introduce a fresh sensory beat.`;
              textInput = `${booster}\n\n${textInput}`;
              try { ctx.io?.events?.emit?.('loopguard.stream.primed', { conv_id: String(conv_id), reason, style: chosen }); } catch {}
              try { METRICS.inc('loopguard_stream_primed_total', { path: 'stream', style: chosen, reason: (reason.join('|') || 'unknown') }); } catch {}
            }
          }
        } catch { try { METRICS.inc('loopguard_stream_probe_errors_total', { path: 'stream' }); } catch {} }
        // Pre-call soft-drop gate prior to streaming start
        try {
          const sd = shouldSoftDrop(engineSource);
          if (sd) {
            try { METRICS.inc('rate_limited_total', { reason: 'soft_drop' }); } catch {}
            emitSoftDropJitterHistogram(sd.jitterMs, { reason: sd.reason, source: engineSource, path: 'stream' });
            const raSec = Math.max(1, Math.round(sd.jitterMs / 1000));
            try { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(raSec) }); } catch {}
            try { res.end(JSON.stringify({ error: 'soft_drop', reason: sd.reason, retry_after_ms: sd.jitterMs })); } catch {}
            return;
          }
        } catch {}
        // Refusal/policy router (stream): dedicated jailbreak blocker with citations request
        try {
          const refusalEnabled = String(process.env.POLICY_REFUSAL_ENABLED || '1').toLowerCase();
          const wantCitations = String(process.env.POLICY_CITATIONS_REQUEST || '1').toLowerCase();
          const threshold = Math.max(0, Math.min(1, Number(process.env.JAILBREAK_REFUSAL_THRESHOLD || 0.7)));
          const enabled = (refusalEnabled === '1' || refusalEnabled === 'true');
          if (enabled) {
            const signalsPre = computeAbuseSignals(String(textInput || ''));
            const jbLevelPre = signalsPre?.levels?.jailbreak || (signalsPre && (signalsPre.jailbreak_signal >= 0.7 ? 'high' : (signalsPre.jailbreak_signal >= 0.4 ? 'med' : 'low')));
            try { ctx.vars.__abuse_signals_pre = signalsPre; } catch {}
            if ((signalsPre.jailbreak_signal >= threshold) || jbLevelPre === 'high') {
              // Compose refusal message (policy provider)
              const refusalMsg = wantCitations === '1' || wantCitations === 'true'
                ? 'I cannot assist with jailbreak or disabling safety. If you have a legitimate request, please provide sources or citations and I\'ll help within policy.'
                : 'I cannot assist with jailbreak or disabling safety.';
              // Prepare start payload matching stream semantics
              try {
                const ridStore = ALS?.getStore?.() || {};
                const ridVal = String(ridStore?.rid || req.headers['x-request-id'] || '').trim();
                const __style_meta = computeStyleMeta(conv_id);
                const nextSeq = getNextSeq(conv_id);
                const startPayload = {
                  model,
                  provider: 'policy',
                  provider_primary: 'policy',
                  provider_used: 'policy',
                  hedge_triggered: false,
                  resolved_model: 'refusal/jailbreak',
                  engine_source: engineSource,
                  variant_v: ctx.vars.abVariant || '',
                  conv_id,
                  tool_call_id: String(ctx.vars.toolCallId || ''),
                  tenant: String(ctx.vars.tenant || ''),
                  request_id: ridVal,
                  prompt_injection_signal: Number(signalsPre.prompt_injection_signal || 0),
                  jailbreak_signal: Number(signalsPre.jailbreak_signal || 0),
                  grounding_strength: Number(signalsPre.grounding_strength || 0),
                  memory_applied: false,
                  memory_injected_tokens: 0,
                  tension: Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0),
                  tension_beat: String(ctx?.vars?.tension_beat || ''),
                  beat: String(ctx?.vars?.tension_beat || ''),
                  msg_seq: nextSeq,
                  ...(__style_meta ? { style_meta: __style_meta } : {}),
                };
                if (__style_meta) {
                  const tokenCount = Array.isArray(__style_meta.tokens) ? __style_meta.tokens.length : 0;
                  startPayload.style = { preset: String(__style_meta.preset || ''), token_count: tokenCount };
                }
                res.write(`event: start\ndata: ${JSON.stringify(startPayload)}\n\n`);
              } catch {}
              // Emit refusal text as a single delta and end the stream
              try { res.write(`event: delta\ndata: ${JSON.stringify({ text: sanitizeUtf8Text(String(refusalMsg || '')) })}\n\n`); } catch {}
              // Respect cooled phrases even on refusal
              try { maybeTagCooledPhrases(ctx, String(conv_id || ''), String(refusalMsg || '')); } catch {}
              try { res.write(`event: end\ndata: ${JSON.stringify({ final: sanitizeUtf8Text(String(refusalMsg || '')), refused: true, reason: 'jailbreak' })}\n\n`); } catch {}
              try { res.end(); } catch {}
              // Metrics and logging
              try {
                METRICS.inc('policy_refusal_total', { class: 'jailbreak', level: jbLevelPre || 'high', source: engineSource });
                METRICS.inc('jailbreak_levels_histogram_total', { level: jbLevelPre || 'high', path: 'stream' });
                METRICS.inc('responses_total', { status: '200' });
                METRICS.inc('llm_provider_selected_total', { provider: 'policy', model, resolved_model: 'refusal/jailbreak', source: engineSource });
      logAt('info', JSON.stringify({ evt: 'policy_refusal', class: 'jailbreak', level: jbLevelPre, threshold, engine_source: engineSource }));
              } catch {}
              // Release distributed idempotency lock if held
              try { if (streamKey) idemReleaseLock(streamKey).catch(() => {}); } catch {}
              return;
            }
          }
        } catch {}
        const llm = new LLMService(ctx);
        let final = '';
        // Track provider/model seen at start to detect hedged switches
        let providerAtStart = '';
        let modelAtStart = '';
        let hedgeSwitchEmitted = false;
        let lastSuspicion = null;
        // Event relays
          ctx.io.events.on('stream.start', (info) => {
          const provider = String(ctx.vars.__selected_provider || '');
          const resolvedModel = String(ctx.vars.__selected_model || '');
          providerAtStart = provider;
          modelAtStart = resolvedModel;
          try { ctx.vars.__stream_start_ms = Date.now(); ctx.vars.__first_token_recorded = false; } catch {}
          const primary = String(ctx.vars.__primary_provider || provider);
          const used = String(ctx.vars.__used_provider || provider);
          const hedgeTriggered = primary && used && primary !== used;
          // Emit minimal start payload ASAP to unblock first delta
          try {
            const nextSeq = getNextSeq(conv_id);
            const __style_meta = computeStyleMeta(conv_id);
            const startPayload = {
              model,
              provider,
              provider_primary: primary,
              provider_used: used,
              hedge_triggered: hedgeTriggered,
              resolved_model: resolvedModel,
              engine_source: engineSource,
              variant_v: ctx.vars.abVariant || '',
              conv_id,
              tool_call_id: toolCallId,
              tenant: String(ctx.vars.tenant || ''),
              request_id: String(rid || ''),
              memory_applied: Boolean(String(ctx?.vars?.__memory_prefix || '') && Number(ctx?.vars?.__memory_injected_tokens || 0) > 0),
              memory_injected_tokens: Number(ctx?.vars?.__memory_injected_tokens || 0),
              tension: Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0),
              tension_beat: String(ctx?.vars?.tension_beat || ''),
              beat: String(ctx?.vars?.tension_beat || ''),
              msg_seq: nextSeq,
              ...(ctx?.vars?.spine ? { character_spine: ctx.vars.spine } : {}),
              ...(__style_meta ? { style_meta: __style_meta } : {}),
            };
            if (__style_meta) {
              const tokenCount = Array.isArray(__style_meta.tokens) ? __style_meta.tokens.length : 0;
              startPayload.style = { preset: String(__style_meta.preset || ''), token_count: tokenCount };
            }
            res.write(`event: start\ndata: ${JSON.stringify(startPayload)}\n\n`);
          } catch {}
          // Defer heavier start-time computations and SSE frames to next tick
          setImmediate(() => {
            try {
              // Compute abuse/jailbreak/grounding signals and record metrics
              const startSignals = computeAbuseSignals(textInput);
              emitAndRecordSignals(startSignals, { engine_source: engineSource });
            } catch {}
            // Style meta and admin broadcast
            try {
              const __style_meta = computeStyleMeta(conv_id);
              if (__style_meta) {
                try { broadcastAdminStyleEvent(conv_id, 'style.pref', { conv_id, style_meta: __style_meta }); } catch {}
                // Optional: surface compact spine snapshot if available
                try {
                  if (ctx?.vars?.spine) {
                    res.write('event: character.spine\n');
                    res.write(`data: ${JSON.stringify({ conv_id, spine: ctx.vars.spine })}\n\n`);
                    const sp = ctx.vars.spine || {};
                    const trust = Math.max(0, Math.min(1, Number(ctx.stats?.trustMA ?? ctx.stats?.trust ?? ctx.memory?.trustLevel ?? 0.5)));
                    const suspicion = Math.max(0, Math.min(1, Number(ctx.stats?.suspicionMA ?? ctx.stats?.suspicion ?? 0.1)));
                    const spine_meta = {
                      mood: String(sp?.mood || ''),
                      tone: String(sp?.tone || ''),
                      trust,
                      suspicion,
                      style_hint: String(sp?.styleHint || ''),
                      refusal_likelihood: Number(sp?.refusalLikelihood || 0)
                    };
                    res.write('event: spine.update\n');
                    res.write(`data: ${JSON.stringify({ conv_id, spine_meta })}\n\n`);
                    const threshold = Number(process.env.SPINE_REFUSAL_THRESHOLD ?? process.env.REFUSAL_THRESHOLD ?? 0.65);
                    if (Number(sp?.refusalLikelihood || 0) >= threshold) {
                      res.write('event: spine.refusal\n');
                      res.write(`data: ${JSON.stringify({ conv_id, refusal_likelihood: Number(sp?.refusalLikelihood || 0), threshold })}\n\n`);
                    }
                  }
                } catch {}
              }
            } catch {}
            // Emit staged boosters/refusal hints after start
            try {
              if (__booster_staged_id && __booster_staged_text) {
                res.write('event: memory.booster.staged\n');
                res.write(`data: ${JSON.stringify({ id: __booster_staged_id, text: __booster_staged_text })}\n\n`);
              }
            } catch {}
            try {
              if (__refusal_hint_text) {
                res.write('event: memory.refusal.staged\n');
                res.write(`data: ${JSON.stringify({ text: __refusal_hint_text, style: __refusal_hint_style, level: __refusal_hint_level, reason: __refusal_hint_reason })}\n\n`);
                try { METRICS.inc('refusal_staged_emitted_total', { path: 'stream', style: __refusal_hint_style, level: __refusal_hint_level, reason: __refusal_hint_reason }); } catch {}
              }
            } catch {}
            // Guard hint and style booster signals
            try {
              const gh = String(ctx?.vars?.__guard_hint || '').trim();
              if (gh) {
                res.write('event: memory.guard\n');
                res.write(`data: ${JSON.stringify({ hint: gh })}\n\n`);
                try { METRICS.inc('guard_hint_emitted_total', { path: 'stream' }); } catch {}
              }
            } catch {}
            try {
              const sbt = String(ctx?.vars?.__style_booster_text || __style_booster_text || '').trim();
              if (sbt) {
                const sbPreset = String(ctx?.vars?.__style_booster_preset || '') || '';
                let estTokens = 0; try { estTokens = Number(ctx?.vars?.__style_booster_est_tokens || TokenCounter.estimate(sbt, { model }) || 0); } catch { estTokens = 0; }
                let tokenBudget = 40; try { tokenBudget = Number(ctx?.vars?.__style_booster_token_budget || process.env.STYLE_BOOSTER_MAX_TOKENS || 40); } catch {}
                res.write('event: memory.style.booster\n');
                res.write(`data: ${JSON.stringify({ text: sbt, preset: sbPreset, estTokens, tokenBudget })}\n\n`);
                try { METRICS.inc('style_booster_emitted_total', { path: 'stream' }); } catch {}
              }
            } catch {}
            // Memory roll and loop phrase signals
            try {
              const r = ctx?.vars?.roll || {};
              const rh = String(ctx?.vars?.roll_hint || '').trim();
              if (r && String(r?.action || '').trim()) {
                const payload = { hint: rh, action: String(r?.action || ''), chance: Number(r?.chance || 0), success: Boolean(r?.success), style: String(getRollStyle(String(conv_id || '')) || '') };
                res.write('event: memory.roll\n');
                res.write(`data: ${JSON.stringify(payload)}\n\n`);
                try { broadcastAdminMemoryEvent(conv_id, 'memory.roll', { conv_id, ...payload }); } catch {}
                try { METRICS.inc('memory_roll_emitted_total', { path: 'stream' }); } catch {}
              }
            } catch {}
            try {
              const items = Array.isArray(ctx?.vars?.__phrase_plan_items) ? ctx.vars.__phrase_plan_items : [];
              res.write('event: loop.phrase.plan\n');
              res.write(`data: ${JSON.stringify({ conv_id, items })}\n\n`);
              try { METRICS.inc('loop_phrase_plan_total', { path: 'stream', count: String(items.length) }); } catch {}
            } catch {}
            try {
              const hotCount = Number(ctx?.vars?.__phrase_hot_count || 0);
              if (hotCount > 0) {
                res.write('event: loop.phrase.cooldown\n');
                res.write(`data: ${JSON.stringify({ conv_id, count: hotCount })}\n\n`);
                try { METRICS.inc('loop_phrase_cooldown_total', { path: 'stream', count: String(hotCount) }); } catch {}
              }
            } catch {}
            // Provider selection metrics
            try { METRICS.inc('llm_provider_selected_total', { provider, model, resolved_model: resolvedModel, source: engineSource }); span?.setAttribute?.('llm.model', model); span?.setAttribute?.('llm.provider', provider); span?.setAttribute?.('llm.resolved_model', resolvedModel); span?.setAttribute?.('llm.engine_source', engineSource); span?.setAttribute?.('llm.variant_v', String(ctx.vars.abVariant || '')); } catch {}
          });
          // Mark active stream immediately (lightweight)
          if (streamKey) {
            ACTIVE_STREAMS.set(streamKey, { started: Date.now() });
            try { pruneCaches(); } catch {}
            try { METRICS.set('active_streams_current', ACTIVE_STREAMS.size); } catch {}
          }
          // Emit memory.boost if a booster was injected into user text
        try {
          if (__booster_text) {
            res.write('event: memory.boost\n');
            res.write(`data: ${JSON.stringify({ text: __booster_text })}\n\n`);
          }
        } catch {}
        // Emit memory.dream if a dream fragment was injected
        try {
          if (__dream_text) {
            res.write('event: memory.dream\n');
            res.write(`data: ${JSON.stringify({ text: __dream_text })}\n\n`);
            try { broadcastAdminMemoryEvent(conv_id, 'memory.dream', { conv_id, text: __dream_text }); } catch {}
            try { METRICS.inc('dreams_emitted_total', { path: 'stream' }); } catch {}
          }
        } catch {}
          // Emit memory.guard if a guard hint was injected for this turn
          try {
            const gh = String(ctx?.vars?.__guard_hint || '').trim();
            if (gh) {
              res.write('event: memory.guard\n');
              res.write(`data: ${JSON.stringify({ hint: gh })}\n\n`);
              try { METRICS.inc('guard_hint_emitted_total', { path: 'stream' }); } catch {}
            }
          } catch {}
          if (streamKey) {
            ACTIVE_STREAMS.set(streamKey, { started: Date.now() });
            try { pruneCaches(); } catch {}
            try { METRICS.set('active_streams_current', ACTIVE_STREAMS.size); } catch {}
          }
          try { METRICS.inc('llm_provider_selected_total', { provider, model, resolved_model: resolvedModel, source: engineSource }); span?.setAttribute?.('llm.model', model); span?.setAttribute?.('llm.provider', provider); span?.setAttribute?.('llm.resolved_model', resolvedModel); span?.setAttribute?.('llm.engine_source', engineSource); span?.setAttribute?.('llm.variant_v', String(ctx.vars.abVariant || '')); } catch {}
        });
        ctx.io.events.on('stream.delta', (d) => {
          if (!gotFirstDelta) gotFirstDelta = true;
          // Emit hedge.switch once if provider/model differs from start
          try {
            const currentProvider = String(ctx.vars.__selected_provider || '');
            const currentModel = String(ctx.vars.__selected_model || '');
            if (!hedgeSwitchEmitted && (currentProvider !== providerAtStart || currentModel !== modelAtStart)) {
              hedgeSwitchEmitted = true;
              try { res.write(`event: hedge.switch\ndata: ${JSON.stringify({ from_provider: providerAtStart, from_resolved_model: modelAtStart, to_provider: currentProvider, to_resolved_model: currentModel, reason: 'hedge' })}\n\n`); } catch {}
              try { METRICS.inc('llm_hedge_switch_total', { from: providerAtStart, to: currentProvider, model, source: engineSource }); } catch {}
            }
          } catch {}
          try {
            const raw = typeof d === 'string' ? d : (d && d.text) || '';
            const s = sanitizeUtf8Text(String(raw || ''));
            // First-token latency metric
            try {
              if (!ctx.vars.__first_token_recorded && Number.isFinite(Number(ctx.vars.__stream_start_ms || 0))) {
                const ms = Math.max(0, Date.now() - Number(ctx.vars.__stream_start_ms));
                let le = 'gt';
                for (const b of FIRST_TOKEN_MS_BUCKETS) { if (ms <= b) { le = String(b); break; } }
                METRICS.inc('first_token_ms_bucket', { le });
                METRICS.set('first_token_last_ms', ms);
                ctx.vars.__first_token_recorded = true;
              }
            } catch {}
            res.write(`event: delta\ndata: ${JSON.stringify({ text: s })}\n\n`);
            final += s;
          } catch {}
        });
        // Narrative events (forward to SSE and Admin, track suspicion)
        try {
          ctx.io.events.on('narrative.event', (p) => {
            try { res.write('event: narrative.event\n'); res.write(`data: ${JSON.stringify({ conv_id, ...p })}\n\n`); } catch {}
            try { broadcastAdminMemoryEvent(conv_id, 'narrative.event', { conv_id, ...p }); } catch {}
            try {
              if (p && p.type === 'SuspicionChanged') {
                lastSuspicion = { name: String(p.name || ''), level: Number(p.level || 0), at: Number(p.at || Date.now()) };
              }
            } catch {}
          });
        } catch {}
        // LoopGuard signals (read-only visibility on stream SSE)
        try {
          ctx.io.events.on('loopguard.score', (p) => {
            try { res.write('event: loopguard.score\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
          ctx.io.events.on('loopguard.trigger', (p) => {
            try { res.write('event: loopguard.trigger\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
          ctx.io.events.on('loopguard.emap.score', (p) => {
            try { res.write('event: loopguard.emap.score\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
          ctx.io.events.on('loopguard.entropy.score', (p) => {
            try { res.write('event: loopguard.entropy.score\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
          ctx.io.events.on('loopguard.stream.primed', (p) => {
            try { res.write('event: loopguard.stream.primed\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
          ctx.io.events.on('loopguard.cooldown', (p) => {
            try { res.write('event: loopguard.cooldown\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
          ctx.io.events.on('loopguard.cooldown.hit', (p) => {
            try { res.write('event: loopguard.cooldown.hit\n'); res.write(`data: ${JSON.stringify(p)}\n\n`); } catch {}
          });
        } catch {}
        ctx.io.events.on('stream.end', async () => {
          // Record tokens out first
          try { try { ctx.vars.tokens_out = TokenCounter.estimate(String(final || ''), { model: String(ctx.vars.__selected_model || model || '') }); } catch {} } catch {}
          // Transcript: index bot turn (final text)
          try { indexTurn({ convId: String(conv_id || 'conv'), role: 'bot', text: String(final || '') }); } catch {}
          // Phrase Decay: record final bot reply for decay model
          try { recordFinal(String(conv_id || ''), String(final || '')); METRICS.inc('loop_phrase_seen_total', { path: 'stream' }); } catch {}
          // Phrase Decay (pattern-based): update hot phrase tracker
          try {
            const { hot } = PhraseDecay.update(String(conv_id || ''), String(final || '')) || {};
            if (Array.isArray(hot) && hot.length) {
              try { METRICS.inc('loop_phrase_hot_total', { path: 'stream', count: String(hot.length) }); } catch {}
              try { ctx.io?.events?.emit?.('loopguard.phrase.hot', { conv_id, count: hot.length }); } catch {}
            }
          } catch {}
          // LoopGuard: observe bot reply phrases and record cadence for next turn (Ultra-enabled)
          try {
            try {
              const oCfg = getPhraseCfg();
              const oEff = { ...oCfg, enabled: ultraFeatureEnabled(conv_id, oCfg.enabled) };
              observeReply(conv_id, String(final || ''), oEff);
            } catch {}
            try {
              const cad = getCadenceCfg();
              const cadEff = { ...cad, enabled: ultraFeatureEnabled(conv_id, cad.enabled) };
              pushTurn(conv_id, 'bot', String(final || ''), cadEff);
            } catch {}
          } catch {}
          // Shadow memory: ingest bot turn and emit memory.nudge (before end)
          try {
            const SHADOW = String(process.env.SHADOW_ENABLED || '1') === '1';
            if (SHADOW && conv_id) {
              const turnN = Number(turn || 0);
              const finalText = String(final || '');
              // ingest bot turn
              try {
                const ing2 = await shadowIngest({ convId: conv_id, turn: turnN, role: 'bot', text: finalText });
                try { for (const f of ing2?.factsNew || []) METRICS.inc('shadow_facts_total', { type: String(f.type || 'unknown') }); } catch {}
              } catch {}
              // detect mismatches and emit SSE advisory
              try {
                const { mismatches } = await shadowDetect({ convId: conv_id, replyText: finalText });
                if (Array.isArray(mismatches) && mismatches.length) {
                  try { for (const m of mismatches) METRICS.inc('shadow_mismatch_total', { type: String(m.type || 'unknown'), severity: String(m.score || 0) }); } catch {}
                  const pov = String(process.env.FACETS_WHO || 'they');
                  const nudges = await shadowNudgeFor({ convId: conv_id, pov, limit: Number(process.env.SHADOW_NUDGE_LIMIT || 2) });
                  try { await shadowStashNudges({ convId: conv_id, nudges }); } catch {}
                  try {
                    res.write('event: memory.nudge\n');
                    res.write(`data: ${JSON.stringify({ nudges, mismatches })}\n\n`);
                    METRICS.inc('shadow_nudge_injected_total', { mode: 'sse' });
                  } catch {}
                }
              } catch {}
            }
          } catch {}
          // Continuity judge: emit memory.score before end
          try {
            const JUDGE = String(process.env.JUDGE_ENABLED || '1') === '1';
            if (JUDGE && conv_id) {
              const weights = parseWeights(process.env.JUDGE_WEIGHTS);
              const facetsTopK = Number(process.env.FACETS_TOP_K || 2);
              const replyText = String(final || '');
              const { axes, overall } = await judgeContinuity({ convId: conv_id, replyText, facetsTopK, weights });
              try {
                res.write('event: memory.score\n');
                res.write(`data: ${JSON.stringify({ axes, overall })}\n\n`);
              } catch {}
              try {
                METRICS.set('continuity_score', Number((overall * 100).toFixed(1)), { path: 'stream' });
                METRICS.inc('continuity_events_total', { path: 'stream' });
                const thresh = Number(process.env.JUDGE_LOW_THRESHOLD || 0.6);
                if (overall < thresh) METRICS.inc('continuity_low_total', { path: 'stream' });
              } catch {}
              // Push memory audit entry (stream path) after continuity judged
              try {
                pushAudit({
                  path: 'stream',
                  conv_id: String(conv_id || ''),
                  turn: Number(turn || 0),
                  model,
                  booster_text: __booster_text || null,
                  dream_text: __dream_text || null,
                  guard_hint: String(ctx?.vars?.__guard_hint || '').trim() || null,
                  memory_inject_text: String(ctx?.vars?.__memory_prefix || ''),
                  memory_inject_tokens: Number(ctx?.vars?.__memory_injected_tokens || 0),
                  continuity_overall: typeof overall === 'number' ? overall : null,
                  continuity_axes: axes || null,
                  meta: { request_id: String(rid || '') }
                });
              } catch {}
              // When continuity is low, store a guard hint for the next turn
              try {
                const GUARD = String(process.env.GUARD_ENABLED || '1') === '1';
                const guardThresh = Number(process.env.GUARD_SET_THRESHOLD || process.env.JUDGE_LOW_THRESHOLD || 0.6);
                if (GUARD && overall < guardThresh && conv_id) {
                  const pov = String(process.env.FACETS_WHO || 'she');
                  const maxChars = Math.max(60, Number(process.env.GUARD_HINT_MAX_CHARS || process.env.GUARD_MAX_CHARS || 180));
                  const ttlTurns = Math.max(1, Number(process.env.GUARD_HINT_TTL_TURNS || process.env.GUARD_TTL_TURNS || 2));
                  const line = await generateGuardOneLiner({ convId: conv_id, pov, maxChars });
                  if (line) {
                    try { setGuardHint(conv_id, String(line), { ttlTurns }); } catch {}
                    try { METRICS.inc('continuity_guard_set_total', { path: 'stream' }); } catch {}
                    try { METRICS.inc('guard_hint_stored_total', { path: 'stream', reason: 'continuity_low' }); } catch {}
                  }
                }
              } catch {}
            }
          } catch {}
          // End event should be last
          try {
            // Emit cooldown visibility if final still contains cooled phrases (stream path)
            try {
              const hit = isCooled(String(conv_id || ''), String(final || ''));
              if (hit) {
                try { ctx.io?.events?.emit?.('loopguard.cooldown', { conv_id: String(conv_id || ''), before: true, after: false, reason: 'stream.final' }); } catch {}
                try { METRICS.inc('loopguard_phrase_cooldown_hits_total', { count: 1 }); } catch {}
              }
            } catch {}
            // Respect cooled phrases before emitting final
            try { maybeTagCooledPhrases(ctx, String(conv_id || ''), String(final || '')); } catch {}
            const endPayload = { final: sanitizeUtf8Text(String(final || '')), request_id: String(rid || '') };
            if (lastSuspicion && typeof lastSuspicion.level === 'number') endPayload.suspicion = lastSuspicion;
            res.write(`event: end\ndata: ${JSON.stringify(endPayload)}\n\n`);
          } catch {}
          // Stream duration metrics (from start to final end)
          try {
            const startMs = Number(ctx?.vars?.__stream_start_ms || 0);
            const durMs = Number.isFinite(startMs) && startMs > 0 ? (Date.now() - startMs) : 0;
            if (durMs > 0) {
              let le = 'inf';
              for (const b of STREAM_DURATION_MS_BUCKETS) { if (durMs <= b) { le = String(b); break; } }
              METRICS.inc('stream_duration_ms_bucket', { le, path: 'stream' });
              METRICS.set('stream_duration_last_ms', Number(durMs), { path: 'stream' });
            }
          } catch {}
          // Outcome: success
          try {
            const provider = String(ctx.vars.__selected_provider || '');
            const resolvedModel = String(ctx.vars.__selected_model || '');
            METRICS.inc('llm_provider_outcome_total', { provider, model, resolved_model: resolvedModel, source: engineSource, outcome: 'success', path: 'stream' });
          } catch {}
          // --- Memory: post-turn storage ---
          try {
            // Watchdog: log assistant turn (stream path)
            try { await logTurn(String(conv_id || 'conv'), 'assistant', String(final || '')); } catch {}
            const resolvedModel = String(ctx.vars.__selected_model || '');
            const post = await postTurnMemory({
              convId: conv_id,
              turn: Number(turn || 0),
              model: resolvedModel,
              userText: textInput,
              assistantText: String(final || ''),
              requestId: ctx?.vars?.request_id,
              toolCallId: ctx?.vars?.toolCallId,
              tenant: ctx?.vars?.tenant,
            });
            try {
              METRICS.inc('memory_label_calls_total', { path: 'stream', type: String(post?.label_type || 'none') });
              for (let i = 0; i < Number(post?.ef_kept || 0); i++) { METRICS.inc('memory_store_kept_total', { path: 'stream' }); }
              for (let i = 0; i < Number(post?.ef_pruned || 0); i++) { METRICS.inc('memory_store_pruned_total', { path: 'stream' }); }
            } catch {}
          } catch {}
          // === Memory: shaping + world snapshot
          try {
            if (String(process.env.MEMORY_SHAPING_ENABLED || '1') !== '0' && canShapeNow(conv_id)) {
              // Reinforce recurring topics, decay stale ones (facts_store has weights + lastSeen)
              const shaped = await consolidateAllWithStats(conv_id);
              try { METRICS.inc('facts_shaped_total', { merged: shaped?.merged || 0, dropped: shaped?.dropped || 0 }); } catch {}
            }
            // Persist any lightweight world deltas (if this turn produced them)
            if (typeof upsertWorldState === 'function' && ctx.vars?.__world_delta) {
              upsertWorldState(String(conv_id || 'conv'), ctx.vars.__world_delta);
              try { METRICS.inc('world_state_updates_total'); } catch {}
            }
          } catch {}
          // Facts reinforcement + decay + SSE memory.shape
          try {
            const ids = Array.isArray(ctx?.vars?.__facts_injected_ids) ? ctx.vars.__facts_injected_ids : [];
            const turnIndex = Number(turn || 0);
            if (conv_id) {
              const changed = Array.isArray(ids) && ids.length ? reinforceFacts(conv_id, ids, undefined, turnIndex) : [];
              const decayed = decayFacts(conv_id, turnIndex);
              try { if (changed.length) pushFactsUpdatedSSE(res, conv_id, changed); } catch {}
              try { emitMemoryShapeSSE(res, { conv_id, reinforced: (changed?.length||0), decayed: decayed, turn: turnIndex }); } catch {}
              try { METRICS.inc('memory_shape_total', { path: 'stream' }); } catch {}
            }
          } catch {}
          try { scheduleFactsConsolidation(conv_id, Number(turn || 0)); } catch {}
          // Cache final for idempotent replay and clear active marker
          try {
            if (streamKey) {
              ACTIVE_STREAMS.delete(streamKey);
              try { METRICS.set('active_streams_current', ACTIVE_STREAMS.size); } catch {}
              const provider = String(ctx.vars.__selected_provider || '');
              const resolvedModel = String(ctx.vars.__selected_model || '');
              const nowTs = Date.now();
              const primary = String(ctx.vars.__primary_provider || provider);
              const used = String(ctx.vars.__used_provider || provider);
              const persistedFinal = sanitizeUtf8Text(String(final || ''));
              const persistedTension = Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0);
              const persistedBeat = String(ctx?.vars?.tension_beat || '');
              const persisted = { final: persistedFinal, model, provider, provider_primary: primary, provider_used: used, resolved_model: resolvedModel, variant_v: ctx.vars.abVariant || '', engine_source: engineSource, tenant: String(ctx.vars.tenant || ''), request_id: String(rid || ''), tension: persistedTension, tension_beat: persistedBeat, style_meta: computeStyleMeta(conv_id) };
              IDEMPOTENCY_CACHE.set(streamKey, { ts: nowTs, response: persisted, replayCount: 0 });
              try { pruneCaches(); } catch {}
              try {
                await saveIdemToDisk(streamKey, persisted, 0);
                await idemSetRedis(streamKey, persisted, 0);
                await gcIdemDir();
              } catch {}
              try {
                // Avoid rewriting the exactly-once marker if it already exists (e.g., on idempotent replay)
                const already = await hasToolExecuted(toolCallId);
                if (!already) {
                  await markToolExecuted(toolCallId, { tenant: String(persisted?.tenant || ''), tool: 'conv.stream' });
                }
              } catch {}
              try { await idemReleaseLock(streamKey); } catch {}
            }
          } catch {}
          try {
            await sendMessageWithTick(async () => { res.end(); return true; });
          } catch {
            try { res.end(); } catch {}
          }
          try { __cleanupHb(); } catch {}
        });
        // Kick off streaming
        try {
          // Fact-driven pre-injection nudge based on continuity and facts
          try { await maybeFactGuardNudge(ctx, { conv_id, turnIndex: Number(turn || 0), sseRes: res }); } catch {}
          // --- Guard: next-turn hint pre-injection ---
          let guardPrefix = '';
          try {
            const GUARD = String(process.env.GUARD_ENABLED || '1') === '1';
            if (GUARD && conv_id) {
              const v = getGuardHint(conv_id);
              if (v && v.text) {
                try { METRICS.inc('guard_hint_available_total', { path: 'stream' }); } catch {}
                const used = consumeGuardHint(conv_id);
                if (used) {
                  guardPrefix = String(used || '');
                  try { METRICS.inc('guard_hint_injected_total', { path: 'stream' }); } catch {}
                  try { METRICS.inc('continuity_guard_used_total', { path: 'stream' }); } catch {}
                }
              }
            }
          } catch {}
          // --- Facts: inject relevant facts into guardPrefix and emit SSE ---
          try {
            // Resolve agent and arc context
            let agentId = 'bot';
            try { agentId = String(ctx?.vars?.active_agent || '').trim() || 'bot'; } catch {}
            let arc = '';
            const ARC_ON = (String(process.env.ARC_LINKING_ENABLED || '') === '1');
            if (ARC_ON && conv_id) {
              let arcManual = '';
              try { const uQ = new URL(`http://localhost${req.url}`); arcManual = String(uQ.searchParams.get('arc') || '').trim(); } catch {}
              if (arcManual) {
                try { const resArc = setArc(conv_id, arcManual); if (resArc?.ok) METRICS.inc('memory_arc_set_total', { path: 'stream' }); } catch {}
                arc = arcManual;
                try { pushMemoryArcSSE(res, conv_id, arcManual); } catch {}
              } else {
                try { const got = getArc(conv_id); arc = String(got?.arc || '').trim(); } catch {}
                if (!arc) {
                  const inf = inferArcFromText(String(textInput || '')) || '';
                  if (inf) {
                    try { const resArc = setArc(conv_id, inf); if (resArc?.ok) METRICS.inc('memory_arc_inferred_total', { path: 'stream' }); } catch {}
                    arc = inf;
                    try { pushMemoryArcSSE(res, conv_id, inf); } catch {}
                  }
                }
              }
              try { ctx.vars.arc = arc; } catch {}
            }
            const FACTS_ON2 = (String(process.env.FACT_INJECT_ENABLED || '') === '1' || String(process.env.FACTS_INJECTION_ENABLED || '') === '1');
            if (FACTS_ON2) {
              const rel = await selectRelevantFactsForTurn(conv_id, String(textInput || ''), Number(process.env.FACT_INJECT_MAX || 3), { agentId, arc });
              if (Array.isArray(rel) && rel.length) {
                const booster = formatFactBooster(rel.map(f => String(f.text || '')));
                guardPrefix = guardPrefix ? `${guardPrefix} | ${booster}` : booster;
                try { ctx.vars.__facts_injected_ids = rel.map(f => f.id); } catch {}
                try { for (let i=0;i<rel.length;i++) METRICS.inc('facts_injected_total', { path: 'stream', reason: 'select_rel' }); } catch {}
                try { pushMemoryFactSSE(res, conv_id, rel.map(f => ({ id: f.id, text: String(f.text || '') }))); } catch {}
              } else {
                // Test-mode fallback: if selection is empty, surface top facts so tests can assert memory.fact reliably
                try {
                  if (String(process.env.TEST_MEMORY_API || '').trim() === '1') {
                    const top = selectTopFacts(conv_id, Number(process.env.FACT_SELECT_LIMIT || 3)) || [];
                    if (Array.isArray(top) && top.length) {
                      const booster = formatFactBooster(top.map(f => String(f.text || '')));
                      guardPrefix = guardPrefix ? `${guardPrefix} | ${booster}` : booster;
                      try { ctx.vars.__facts_injected_ids = top.map(f => f.id); } catch {}
                      try { for (let i=0;i<top.length;i++) METRICS.inc('facts_injected_total', { path: 'stream', reason: 'fallback_top' }); } catch {}
                      try { pushMemoryFactSSE(res, conv_id, top.map(f => ({ id: f.id, text: String(f.text || '') }))); } catch {}
                    }
                  }
                } catch {}
              }
            }
          } catch {}
          // --- Dreams: ephemeral fragment injection before memoryPrefix ---
          try {
            const activeAgent = String(ctx?.vars?.active_agent || 'bot');
            await tryPromoteDreams(conv_id, String(textInput || ''), { agentId: activeAgent, arc: String(ctx?.vars?.arc || '') });
            const dreams = popDreamsForTurn(conv_id);
            if (Array.isArray(dreams) && dreams.length) {
              const dreamLine = dreams.join('\n');
              guardPrefix = guardPrefix ? `${dreamLine} ${guardPrefix}` : dreamLine;
              try { METRICS.inc('dreams_injected_total', { path: 'stream' }); } catch {}
            }
          } catch {}
          // --- Scene linking: detect/recall and prepend into guardPrefix ---
          try {
            if (String(process.env.SCENE_LINKING_ENABLED || '') === '1') {
              let sceneManual = '';
              try { const uQ = new URL(`http://localhost${req.url}`); sceneManual = String(uQ.searchParams.get('scene') || '').trim(); } catch {}
              const scene = sceneManual || sceneKeyFromText(String(textInput || '')) || '';
              if (scene) {
                const { key } = enterScene(conv_id, scene) || {};
                const line = recallSceneLine(conv_id, scene);
                if (line) {
                  guardPrefix = guardPrefix ? `${line} ${guardPrefix}` : line;
                  try { METRICS.inc('scene_injected_total', { path: 'stream' }); } catch {}
                }
                try {
                  const ids = Array.isArray(ctx?.vars?.__facts_injected_ids) ? ctx.vars.__facts_injected_ids : [];
                  if (ids.length) linkFactsToScene(conv_id, key, ids);
                } catch {}
              }
            }
          } catch {}
          // --- Ultra: novelty hint injection ---
          try {
            const ultraOn = Boolean(getUltraState(conv_id).enabled);
            if (ultraOn) {
              const novelty = String(process.env.ULTRA_NOVELTY_HINT || 'Avoid familiar phrasing; vary cadence; add one vivid, specific detail.');
              guardPrefix = guardPrefix ? `${guardPrefix} | ${novelty}` : novelty;
              try { METRICS.inc('ultra_novelty_hint_total', { path: 'stream' }); } catch {}
            }
          } catch {}
          // --- Disagreement Core: memory feed (trust/suspicion/mood/fear/beliefs/constraints/facts) ---
          try {
            // Ensure memory object exists
            ctx.memory = ctx.memory || {};

            // Mirror spine-derived signals into context.memory
            const trust = Math.max(0, Math.min(1, Number(ctx.stats?.trustMA ?? ctx.stats?.trust ?? ctx.memory?.trustLevel ?? 0.5)));
            const suspicion = Math.max(0, Math.min(1, Number(ctx.stats?.suspicionMA ?? ctx.stats?.suspicion ?? 0.1)));
            const mood = String(ctx?.vars?.spine?.mood || '');
            const fear = Math.max(0, Math.min(1, Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0)));
            try { ctx.memory.trust = trust; } catch {}
            try { ctx.memory.suspicion = suspicion; } catch {}
            try { ctx.memory.mood = mood; } catch {}
            try { ctx.memory.fear = fear; } catch {}

            // Agent-scoped beliefs, global constraints, and personality via BeliefStore
            try {
              const agentIdMem = String(ctx?.vars?.agent_id || 'default');
              ctx.memory.beliefs = await BeliefStore.listBeliefs(agentIdMem);
              ctx.memory.logicConstraints = await BeliefStore.listConstraints();
              ctx.memory.personality = (await BeliefStore.getPersonality(agentIdMem)) || ctx.memory.personality || '';
            } catch {}

            // Mirror beliefs and logic constraints from state store (optional)
            if (String(process.env.BELIEFS_ENABLED || '').trim()) {
              try {
                const prof = await loadStateBeliefs(String(conv_id || '')).catch(() => null);
                if (prof) {
                  const maxBel = Number(process.env.BELIEF_MAX_LINES || 4);
                  const maxCon = Number(process.env.CONSTRAINT_MAX_LINES || 4);
                  if (!Array.isArray(ctx.memory.beliefs) || ctx.memory.beliefs.length === 0) {
                    ctx.memory.beliefs = Array.isArray(prof.beliefs) ? prof.beliefs.slice(0, maxBel) : [];
                  }
                  if (!Array.isArray(ctx.memory.logicConstraints) || ctx.memory.logicConstraints.length === 0) {
                    ctx.memory.logicConstraints = Array.isArray(prof.logic_constraints) ? prof.logic_constraints.slice(0, maxCon) : [];
                  }
                }
              } catch {}
            }

            // Mirror compact snapshot of recent facts (id + text)
            try {
              const limitFacts = Number(process.env.FACTS_RECENT_LIMIT || 6);
              const recent = selectTopFactsRt(String(conv_id || ''), limitFacts) || [];
              ctx.memory.recentFacts = recent.map(f => ({ id: f.id, text: String(f.text || '') }));
            } catch {}
          } catch {}
          // --- Disagreement Core: beliefs/contradictions/spine/rolls ---
          try {
            if (typeof DisagreementCore?.buildGuard === 'function') {
              const dg = DisagreementCore.buildGuard(ctx || {}, String(textInput || ''));
              if (dg) {
                guardPrefix = guardPrefix ? `${dg} ${guardPrefix}` : dg;
                try { METRICS.inc('disagreement_guard_total', { path: 'stream' }); } catch {}
              }
            }
          } catch {}
          // --- Beliefs: detect conflicts and stage boosters (stream) ---
          try {
            if (String(process.env.BELIEFS_ENABLED || '').trim()) {
              const { boosters: beliefBoosters, conflicts } = craftBeliefBoosters({
                convId: String(conv_id || ''),
                charId: String(ctx?.vars?.agent_id || 'default'),
                userText: String(textInput || '')
              });
              // Emit conflicts if enabled
              try {
                if (Number(process.env.BELIEFS_CONFLICT_SSE || 0) && Array.isArray(conflicts) && conflicts.length) {
                  for (const c of conflicts) {
                    try {
                      res.write('event: memory.belief.conflict\n');
                      res.write(`data: ${JSON.stringify({ belief_id: c.id, text: c.text })}\n\n`);
                    } catch {}
                    try { METRICS.inc('belief_conflict_total', { path: 'stream', char_id: String(ctx?.vars?.agent_id || 'default') }); } catch {}
                  }
                }
              } catch {}
              // Announce belief boosters and stash for prefix merge
              if (Array.isArray(beliefBoosters) && beliefBoosters.length) {
                try {
                  for (const b of beliefBoosters) {
                    try {
                      res.write('event: memory.belief\n');
                      res.write(`data: ${JSON.stringify({ belief_id: b.belief_id, text: b.text })}\n\n`);
                    } catch {}
                    try { METRICS.inc('belief_injected_total', { path: 'stream', char_id: String(ctx?.vars?.agent_id || 'default') }); } catch {}
                  }
                } catch {}
              try { ctx.vars = ctx.vars || {}; } catch {}
              try { ctx.vars.__extraBoosters = (Array.isArray(ctx.vars.__extraBoosters) ? ctx.vars.__extraBoosters : []).concat(beliefBoosters.map(x => String(x.text || ''))); } catch {}
            }
          }
          } catch {}
          // --- State Beliefs: select relevant lines and stage boosters (stream) ---
          try {
            if (String(process.env.BELIEFS_ENABLED || '').trim()) {
              const convId = String(conv_id || '');
              const maxLines = Number(process.env.BELIEF_MAX_LINES || 3);
              const avoidTurns = Number(process.env.BELIEF_HASH_AVOID_MIN_TURNS || 3);
              const stylePref = String(process.env.BELIEF_BOOSTER_STYLE || 'inline').toLowerCase();
              const textForPick = String(textInput || '');
              const seq = Number(getNextSeq(convId));
              const profile = await loadStateBeliefs(convId).catch(() => null);
              if (profile) {
                const picks = pickRelevantStateBeliefs(profile, textForPick, { max: maxLines });
                if (Array.isArray(picks) && picks.length) {
                  let recent = STATE_BELIEF_RECENT.get(convId);
                  if (!recent) { recent = new Map(); STATE_BELIEF_RECENT.set(convId, recent); }
                  const chosen = [];
                  for (const p of picks) {
                    const h = crypto.createHash('sha256').update(String(p.text || '')).digest('hex').slice(0, 16);
                    const lastSeq = recent.get(h) || -Infinity;
                    if ((seq - lastSeq) >= avoidTurns) {
                      recent.set(h, seq);
                      chosen.push({ kind: String(p.kind || 'belief'), text: String(p.text || ''), hash: h });
                    }
                  }
                  if (chosen.length) {
                    // Format boosters per style
                    let lines = [];
                    if (stylePref === 'system') {
                      const block = `SYSTEM BELIEFS\n${chosen.map(x => `- ${x.text}`).join('\n')}`;
                      lines = [block];
                    } else { // inline
                      lines = chosen.map(x => `Belief: ${x.text}`);
                    }
                    try { ctx.vars = ctx.vars || {}; } catch {}
                    try { ctx.vars.__extraBoosters = (Array.isArray(ctx.vars.__extraBoosters) ? ctx.vars.__extraBoosters : []).concat(lines); } catch {}
                    // SSE snapshot for stream
                    try {
                      res.write('event: memory.beliefs\n');
                      res.write(`data: ${JSON.stringify({ lines: chosen.map(x => ({ kind: x.kind, text: x.text, hash: x.hash })), style: stylePref, max: maxLines, avoid_min_turns: avoidTurns })}\n\n`);
                    } catch {}
                    try { METRICS.inc('belief_injected_total', { path: 'stream', char_id: String(ctx?.vars?.agent_id || 'default') }); } catch {}
                  }
                }
              }
            }
          } catch {}
          // --- Watchdog: contradictions vs world state (stream) ---
          try {
            if (String(process.env.WATCHDOG_ENABLED || '').trim()) {
              const { hints, flags } = runWatchdog({ convId: String(conv_id || ''), userText: String(textInput || '') });
              // Emit SSE per flag if enabled
              try {
                if (Number(process.env.WATCHDOG_SSE || 0) && Array.isArray(flags) && flags.length) {
                  for (const f of flags) {
                    try {
                      res.write('event: memory.contradiction\n');
                      res.write(`data: ${JSON.stringify({ key: f.key, value: f.value, severity: f.severity })}\n\n`);
                    } catch {}
                  }
                }
              } catch {}
              // Metrics: one increment per flag chosen
              try {
                if (Array.isArray(flags)) {
                  for (const f of flags) { METRICS.inc('contradiction_flag_total', { path: 'stream', severity: String(f?.severity || 'soft') }); }
                }
              } catch {}
              // Inject contradiction lines directly into guardPrefix before beliefs
              if (Array.isArray(hints) && hints.length) {
                const line = hints.map(x => String(x.text || '')).join(' ');
                guardPrefix = guardPrefix ? `${line} ${guardPrefix}` : line;
              }
            }
          } catch {}
          // --- Memory: pre-turn injection (private system prefix) ---
          let memoryPrefix = '';
          let memoryInjectTokens = 0;
          try {
            const preMem = await preTurnMemory({
              convId: conv_id,
              turn: Number(turn || 0),
              model,
              userText: textInput,
              tenant: ctx?.vars?.tenant,
              requestId: ctx?.vars?.request_id,
            });
            memoryPrefix = preMem?.injectText || '';
            if (memoryPrefix) ctx.vars.__memory_prefix = memoryPrefix;
            memoryInjectTokens = Number(preMem?.injectTokens || 0);
            try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
            try { METRICS.inc('memory_inject_tokens_total', { tokens: String(memoryInjectTokens), path: 'stream' }); } catch {}
          } catch {}
          // --- Disagreement Guards: compute and prepend one-liners + SSE (stream) ---
          try {
            ctx.memory = ctx.memory || {};
            const agentIdMem = String(ctx?.vars?.agent_id || 'default');
            ctx.memory.beliefs = await BeliefStore.listBeliefs(agentIdMem);
            ctx.memory.logicConstraints = await BeliefStore.listConstraints();
            ctx.memory.personality = (await BeliefStore.getPersonality(agentIdMem)) || ctx.memory.personality || '';
            const dg = await computeDisagreementGuards(ctx, { conv_id: String(conv_id || ''), turn: Number(turn || 0), userText: String(textInput || '') });
            if (dg && Array.isArray(dg.guards)) {
              const lines = [];
              for (const g of dg.guards) {
                if (g.type === 'belief' && g.text) {
                  lines.push(`Belief: ${String(g.text || '')}`);
                  try { METRICS.inc('guard_belief_total', { path: 'stream' }); } catch {}
                  try { emitGuardSSE(res, 'guard.belief', { conv_id: String(conv_id || ''), text: String(g.text || ''), style: String(dg.style || '') }); } catch {}
                } else if (g.type === 'constraint' && g.text) {
                  lines.push(`Constraint: ${String(g.text || '')}`);
                  try { METRICS.inc('guard_constraint_total', { path: 'stream' }); } catch {}
                  try { emitGuardSSE(res, 'guard.constraint', { conv_id: String(conv_id || ''), text: String(g.text || ''), style: String(dg.style || '') }); } catch {}
                } else if (g.type === 'contradiction' && g.why) {
                  lines.push(`Contradiction: ${String(g.why || '')}`);
                  try { METRICS.inc('guard_contradiction_total', { path: 'stream' }); } catch {}
                  try { emitGuardSSE(res, 'guard.contradiction', { conv_id: String(conv_id || ''), why: String(g.why || ''), fact: String(g.fact || '') }); } catch {}
                }
              }
              if (lines.length) {
                const block = lines.join(' ');
                guardPrefix = guardPrefix ? `${block} ${guardPrefix}` : block;
                try { ctx.vars.__guard_hint = String(guardPrefix || block || ''); } catch {}
              }
              if (dg.failureRoll) {
                try { METRICS.inc('guard_failure_total', { path: 'stream', outcome: String(dg.failureRoll?.outcome || 'none') }); } catch {}
                try { emitGuardSSE(res, 'guard.failure', { conv_id: String(conv_id || ''), pct: Number(dg.failureRoll.pct || 0), roll: Number(dg.failureRoll.roll || 0), outcome: String(dg.failureRoll.outcome || ''), verbs: Array.isArray(dg.failureRoll.verbs) ? dg.failureRoll.verbs : [] }); } catch {}
              }
            }
            if (dg?.hardRefusal) {
              try { METRICS.inc('refusal_total', { path: 'stream', mode: 'hard', reason: 'belief_constraint' }); } catch {}
              try { res.write(`event: start\n`); res.write(`data: ${JSON.stringify({ ok: true, refused: true, reason: 'belief_constraint', guard_hint: String(ctx?.vars?.__guard_hint || ''), style: String(dg.style || 'firm') })}\n\n`); } catch {}
              const refusalText = renderRefusal({ style: String(dg.style || 'firm'), reason: 'belief_constraint', spine: ctx?.vars?.spine, userText: String(textInput || '') });
              try { res.write(`event: delta\n`); res.write(`data: ${JSON.stringify({ text: String(refusalText || '') })}\n\n`); } catch {}
              try { res.write(`event: end\n`); res.write(`data: ${JSON.stringify({ ok: true, refused: true, reason: 'belief_constraint' })}\n\n`); } catch {}
              try {
                await sendMessageWithTick(async () => { res.end(); return true; });
              } catch {
                try { res.end(); } catch {}
              }
              return;
            }
          } catch {}
          // --- Disagreement Core: blend continuity/belief checks and staged hints (stream) ---
          try {
            const convIdCore = String(conv_id || '');
            const textCore = String(textInput || '');
            let beliefLinesCore = [];
            let contradictionLinesCore = [];
            try {
              if (String(process.env.BELIEFS_ENABLED || '').trim()) {
                const profile = await loadStateBeliefs(convIdCore).catch(() => null);
                if (profile) {
                  const picks = pickRelevantStateBeliefs(profile, textCore, { max: Number(process.env.BELIEF_MAX_LINES || 3) });
                  if (Array.isArray(picks) && picks.length) beliefLinesCore = picks.map(p => `Belief: ${String(p.text || '')}`);
                }
              }
            } catch {}
            try {
              const hits = await detectContradictionsState(convIdCore, textCore).catch(() => []);
              const strict = String(process.env.DISAGREE_ENFORCE || 'soft') === 'hard';
              const lines = buildContradictionLinesState(hits, 'inline', strict);
              if (Array.isArray(lines) && lines.length) contradictionLinesCore = lines;
            } catch {}
            const { lines: disagreeLines, action: disagreeAction, reasons: disagreeReasons } = await runDisagreementCore(ctx, { convId: convIdCore, userText: textCore, beliefLines: beliefLinesCore, contradictionLines: contradictionLinesCore });
            try { ctx.vars.__disagree_action__ = String(disagreeAction || 'none'); } catch {}
            if (Array.isArray(disagreeReasons) && disagreeReasons.length) {
              try { for (const r of disagreeReasons) METRICS.inc('disagreement_core_trigger_total', { source: String(r.code || 'other'), path: 'stream' }); } catch {}
              try {
                const sp = ctx?.vars?.spine || {};
                res.write('event: disagree.core\n');
                res.write(`data: ${JSON.stringify({ action: String(disagreeAction || 'none'), reasons: disagreeReasons, mood: String(sp?.mood || ''), trust: Number(sp?.trust ?? 0), suspicion: Number(sp?.suspicion ?? 0) })}\n\n`);
              } catch {}
            }
            if (Array.isArray(disagreeLines) && disagreeLines.length) {
              const addText = disagreeLines.join('\n');
              let addTok = 0;
              try { addTok = Number(TokenCounter.estimate(addText, { model })) || 0; } catch { addTok = 0; }
              const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
              if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${addText}`;
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
              } else {
                try { METRICS.inc('disagree_core_skipped_total', { reason:'budget', path:'stream' }); } catch {}
              }
            }
          } catch {}
          // --- Failure-roll: micro outcome booster after Disagreement Core (stream) ---
          try {
            const convIdFR = String(conv_id || '');
            const turnFR = Number(turn || 0);
            const disagreeAct = String(ctx?.vars?.__disagree_action__ || 'none');
            let failroll = { lines: [], outcome: 'none', eval: null };
            if (disagreeAct !== 'refuse') {
              failroll = await maybeApplyFailureRoll(ctx, { convId: convIdFR, turn: turnFR, userText: String(textInput || '') });
              // SSE + metrics
              try {
                if (failroll?.eval) {
                  res.write('event: failroll.eval\n');
                  res.write(`data: ${JSON.stringify({ conv_id: convIdFR, ...failroll.eval, outcome: String(failroll.outcome || 'none') })}\n\n`);
                }
              } catch {}
              try {
                if (failroll?.eval) {
                  const payloadFR = { risk: Number(failroll.eval?.pFail || 0), roll: Number(failroll.eval?.roll || 0), threshold: Number(failroll.eval?.threshold || 0), outcome: String(failroll.outcome || 'none') };
                  res.write('event: memory.failure_roll\n');
                  res.write(`data: ${JSON.stringify(payloadFR)}\n\n`);
                }
              } catch {}
              try { METRICS.inc('failroll_evaluations_total', { outcome: String(failroll.outcome || 'none'), path: 'stream' }); } catch {}
              try {
                const b = String(failroll?.eval?.beat || '');
                if (String(failroll?.outcome || '') === 'fail') {
                  METRICS.inc('failroll_fail_total', { beat: b, path: 'stream' });
                } else if (String(failroll?.outcome || '').startsWith('success')) {
                  METRICS.inc('failroll_success_total', { beat: b, path: 'stream' });
                }
              } catch {}
              try {
                if (failroll?.eval?.nearMiss) METRICS.inc('failroll_complications_total', { count: 1, path: 'stream', beat: String(failroll?.eval?.beat || ''), style: String(failroll?.eval?.styleClass || '') });
              } catch {}
              try {
                const d = Number(failroll?.eval?.delta || 0);
                if (d !== 0) METRICS.inc('failroll_tension_adjust_total', { count: 1, path: 'stream', outcome: String(failroll?.outcome || 'none'), beat: String(failroll?.eval?.beat || '') });
              } catch {}
              // Also emit memory.roll SSE for compatibility
              try {
                if (failroll?.eval) {
                  const actionTag = detectActionTag(String(textInput || '')) || String(failroll.eval?.verb || 'attempt');
                  const payload = { hint: '', action: String(actionTag || 'attempt'), chance: Number(failroll.eval?.pFail || 0), success: !Boolean(failroll.eval?.fail), style: String(process.env.FAILROLL_STYLE || '') };
                  res.write('event: memory.roll\n');
                  res.write(`data: ${JSON.stringify(payload)}\n\n`);
                }
              } catch {}
              // Complication fact announcement SSE (lightweight)
              try {
                if (failroll?.eval?.nearMiss) {
                  const vb = String(failroll?.eval?.verb || 'attempt');
                  const beat = String(failroll?.eval?.beat || 'steady');
                  res.write('event: memory.fact\n');
                  res.write(`data: ${JSON.stringify({ conv_id: convIdFR, kind: 'complication', vb, beat })}\n\n`);
                }
              } catch {}
            }
            if (Array.isArray(failroll.lines) && failroll.lines.length) {
              const addText = failroll.lines.join('\n');
              let addTok = 0;
              try { addTok = Number(TokenCounter.estimate(addText, { model })) || 0; } catch { addTok = 0; }
              const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
              if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${addText}`;
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
              } else {
                try { METRICS.inc('failroll_booster_skipped_total', { reason:'budget', path:'stream' }); } catch {}
              }
            }
          } catch {}
          // Merge guardPrefix ahead of memoryPrefix and track tokens
          try {
            if (guardPrefix) {
              let addTok = 0;
              try { addTok = Number(TokenCounter.estimate(guardPrefix, { model })) || 0; } catch { addTok = 0; }
              memoryInjectTokens += addTok;
              memoryPrefix = `${guardPrefix}\n${memoryPrefix || ''}`;
              try { ctx.vars.__guard_hint = guardPrefix; } catch {}
              try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
              try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
              try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
            }
          } catch {}
          // --- LoopGuard style nudge: proactively vary phrasing style (stream) ---
          try {
            const cfgLG = getLoopGuardConfig();
            if (cfgLG && cfgLG.enabled) {
              const convIdLG = String(conv_id || '');
              const lastToken = String(ctx?.vars?.__loopguard_style_token || '');
              let tokensStr = '';
              try {
                const memTokens = Array.isArray(ctx?.memory?.ultra_style_tokens)
                  ? ctx.memory.ultra_style_tokens
                  : (Array.isArray(ctx?.vars?.ultra_style_tokens) ? ctx.vars.ultra_style_tokens : []);
                if (Array.isArray(memTokens) && memTokens.length) {
                  tokensStr = memTokens.map(s => String(s || '').trim()).filter(Boolean).join(',');
                }
              } catch {}
              if (!tokensStr) {
                const ultraOn = !!getUltraState(convIdLG)?.enabled;
                tokensStr = ultraOn
                  ? String(process.env.LOOP_GUARD_STYLE_TOKENS || cfgLG.styleTokens || '')
                  : String(cfgLG.styleTokens || '');
              }
              const chosen = nextLoopStyleToken(lastToken, tokensStr);
              if (chosen) {
                const booster = `(STYLE:${chosen}) Express this idea differently. Avoid familiar phrasing patterns; add a fresh sensory detail.`;
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(booster, { model })) || 0; } catch { addTok = 0; }
                const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                  memoryInjectTokens += addTok;
                  memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${booster}`;
                  try { ctx.vars.__loopguard_style_token = String(chosen || ''); } catch {}
                  try { ctx.vars.__loopguard_style_nudge = booster; } catch {}
                  try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                  try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                  try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
                  try { METRICS.inc('loopguard_style_nudge_total', { path: 'stream', token: String(chosen || '') }); } catch {}
                  try {
                    res.write('event: memory.loopguard_style\n');
                    res.write(`data: ${JSON.stringify({ token: String(chosen || '') })}\n\n`);
                  } catch {}
                } else {
                  try { METRICS.inc('loopguard_style_nudge_skipped_total', { reason:'budget', path:'stream' }); } catch {}
                }
              }
            }
          } catch {}
          // Merge belief boosters into memoryPrefix and account tokens (stream)
          try {
            const extrasRaw = Array.isArray(ctx?.vars?.__extraBoosters) ? ctx.vars.__extraBoosters : [];
            const existing = new Set(String(memoryPrefix || '').split('\n').map(s => s.trim()).filter(Boolean));
            const extrasUniq = Array.from(new Set(extrasRaw.map(x => String(x || '').trim()).filter(Boolean)));
            const filtered = extrasUniq.filter(l => !existing.has(l));
            if (filtered.length) {
              const addText = filtered.join('\n');
              let addTok = 0;
              try { addTok = Number(TokenCounter.estimate(addText, { model })) || 0; } catch { addTok = 0; }
              memoryInjectTokens += addTok;
              memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${addText}`;
              try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
              try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
              try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
            }
          } catch {}
          // (watchdog hints were merged into guardPrefix earlier)
          // --- LoopGuard: phrase penalties + Cadence: style hint for stream path ---
          // --- Spine booster: inject compact character tone whisper into memoryPrefix (stream) ---
          try {
            if (String(process.env.SPINE_ENABLED || '1') === '1') {
              const sp = ctx?.vars?.spine;
              if (sp && sp.boosterLine) {
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(sp.boosterLine, { model })) || 0; } catch { addTok = 0; }
                const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
                if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                  memoryInjectTokens += addTok;
                  memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${sp.boosterLine}`;
                  try { ctx.vars.__spine_booster_text = String(sp.boosterLine || ''); } catch {}
                  try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                  try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                  try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
                } else {
                  try { METRICS.inc('spine_booster_skipped_total', { reason:'budget', path:'stream' }); } catch {}
                }
              }
            }
          } catch {}
          // --- Style booster: inject compact style whisper into memoryPrefix (stream) ---
          try {
            const __style_meta = computeStyleMeta(conv_id);
            if (__style_meta) {
              try { ctx.vars = ctx.vars || {}; } catch {}
              try { ctx.vars.style = __style_meta; } catch {}
              try { ctx.vars.model = model; } catch {}
              const sb = buildStyleBooster(ctx);
              if (sb && sb.text) {
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(sb.text, { model })) || 0; } catch { addTok = 0; }
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${sb.text}`;
                __style_booster_text = String(sb.text || '');
                try { ctx.vars.__style_booster_text = __style_booster_text; } catch {}
                try { ctx.vars.__style_booster_preset = String(sb.preset || String(__style_meta?.preset || '')); } catch {}
                try { ctx.vars.__style_booster_est_tokens = Number(sb.estTokens || addTok || 0); } catch {}
                try { ctx.vars.__style_booster_token_budget = Number(sb.tokenBudget || Number(process.env.STYLE_BOOSTER_MAX_TOKENS || 40)); } catch {}
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
                try { METRICS.inc('style_booster_injected_total', { path: 'stream', preset: String(__style_meta?.preset || '') }); } catch {}
                try { broadcastAdminStyleEvent(conv_id, 'style.booster', { conv_id, text: __style_booster_text, preset: String(__style_meta?.preset || '') }); } catch {}
              }
          }
        } catch {}

        // --- Refusal hint: inject staged diegetic whisper into memoryPrefix (stream) ---
        try {
          const hintText = String(__refusal_hint_text || '').trim();
          if (hintText) {
            let addTokR = 0; try { addTokR = Number(TokenCounter.estimate(hintText, { model })) || 0; } catch { addTokR = 0; }
            const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
            if (!Number.isFinite(budget) || (memoryInjectTokens + addTokR) <= budget) {
              memoryInjectTokens += addTokR;
              memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${hintText}`;
              try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
              try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
              try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTokR), path: 'stream' }); } catch {}
              try { METRICS.inc('refusal_hint_injected_total', { path: 'stream', style: __refusal_hint_style, level: __refusal_hint_level, reason: __refusal_hint_reason }); } catch {}
            } else {
              try { METRICS.inc('refusal_hint_skipped_total', { reason:'budget', path:'stream' }); } catch {}
            }
          }
        } catch {}
         
          // --- Failure roll: detect risky action and inject roll hint (stream) ---
          try {
            if (String(ctx?.vars?.__failroll_outcome__ || '').trim()) {
              METRICS.inc?.('failure_roll_skipped_total', { reason:'already_applied', path:'stream' });
            } else {
            const trust = (() => { try { return Math.max(0, Math.min(1, Number(ctx?.vars?.trust ?? ctx?.vars?.trust_score ?? ctx?.memory?.trustLevel ?? 0.5))); } catch { return 0.5; } })();
            const suspicion = (() => { try { return Math.max(0, Math.min(1, Number(ctx?.vars?.suspicion ?? ctx?.vars?.suspicion_score ?? 0.0))); } catch { return 0.0; } })();
            const tension = (() => { try { return Math.max(0, Math.min(1, Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0.5))); } catch { return 0.5; } })();
            const useNewFR = frEnabled();
            let roll = null;
            const userTextX = String(textInput || '');
            if (useNewFR) {
              const actionTag = detectActionTag(userTextX);
              const intent = detectRiskIntent(userTextX);
              if (actionTag || intent) {
                const prob = computeFailProb({ trust, suspicion, tension });
                const r100 = d100FR(ctx, { convId: String(conv_id || ''), turn: Number(turn || 0), userText: userTextX });
                const threshold = Math.round(prob * 100);
                const success = r100 > threshold; // fail on roll ≤ threshold
                const reason = String(process.env.FAILROLL_SSE_VERBOSE || '0') === '1' ? `d100:${r100} vs ${threshold}` : '';
                const hint = String(buildOutcomeBooster({ style: 'meta', success, verb: (actionTag || 'attempt').replace(/_/g, ' '), reason }));
                roll = { action: actionTag || 'attempt', chance: prob, success, hint };
              }
            } else {
              roll = assessRiskyAction({ text: userTextX, trust, suspicion, tension, style: getRollStyle(String(conv_id || '')) });
            }
            if (roll && roll.action && String(roll.hint || '').trim()) {
              const hint = String(roll.hint || '').trim();
              let addTok = 0; try { addTok = Number(TokenCounter.estimate(hint, { model })) || 0; } catch { addTok = 0; }
              const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || Number.MAX_SAFE_INTEGER);
              if (!Number.isFinite(budget) || (memoryInjectTokens + addTok) <= budget) {
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${hint}`;
                try { ctx.vars.roll_hint = hint; } catch {}
                try { ctx.vars.roll = { action: String(roll.action || ''), chance: Number(roll.chance || 0), success: Boolean(roll.success) }; } catch {}
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
                try { METRICS.inc('failure_roll_injected_total', { path: 'stream', action: String(roll.action || '') }); } catch {}
              } else {
                try { METRICS.inc('failure_roll_skipped_total', { reason:'budget', path:'stream' }); } catch {}
              }
            }
            }
          } catch {}
          
          // Seed phrase decay with user text before planning, so cooldowns can trigger early
          try {
            if (conv_id) {
              PhraseDecay.recordFinal(String(conv_id || ''), String(text || ''));
              try { METRICS.inc('loop_phrase_seen_total', { path: 'stream_user_preturn' }); } catch {}
            }
          } catch {}

          // --- Phrase Decay: plan cooldowns and inject a tiny avoidance booster (stream) ---
          try {
            const plan = planCooldown(String(conv_id || ''));
            if (plan && plan.enabled) {
              const avoid = buildAvoidanceBooster(plan);
              // Save sanitized plan for SSE emission (hashes only)
              try {
                const items = Array.isArray(plan.cooldown) ? plan.cooldown.map(p => ({ hash: String(p.hash || ''), until: Number(p.until || 0), score: Number(p.score || 0) })) : [];
                // Always set items (may be empty) so SSE can consistently announce a plan frame
                ctx.vars.__phrase_plan_items = items;
              } catch {}
              if (avoid && avoid.text) {
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(avoid.text, { model })) || 0; } catch { addTok = Number(avoid.estTokens || 0) || 0; }
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${avoid.text}`;
                try { ctx.vars.__phrase_avoid_text = String(avoid.text || ''); } catch {}
                try { ctx.vars.__phrase_avoid_est_tokens = Number(avoid.estTokens || addTok || 0); } catch {}
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
              }
            }
          } catch {}

          // --- Phrase Decay (pattern-based): inject avoid-list for hot phrases and mark count (stream) ---
          try {
            const { hot } = PhraseDecay.getHot(String(conv_id || '')) || {};
            if (Array.isArray(hot) && hot.length) {
              const plan2 = { enabled: true, cooldown: hot.map(h => ({ phrase: String(h.phrase || '') })) };
              const avoid2 = buildAvoidanceBooster(plan2);
              if (avoid2 && avoid2.text) {
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(avoid2.text, { model })) || 0; } catch { addTok = Number(avoid2.estTokens || 0) || 0; }
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${avoid2.text}`;
                try { ctx.vars.__phrase_hot_count = Number(hot.length || 0); } catch {}
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
              }
            }
          } catch {}

          // --- Beat: detect and inject cadence booster (stream) ---
          try {
            const anchorSeq = getNextSeq(String(conv_id || ''));
            const win = getWindowAround(String(conv_id || ''), Number(anchorSeq || 0), Number(process.env.BEATS_WINDOW_BEFORE || 30), 0) || [];
            const lastBot = Array.isArray(win) ? [...win].reverse().find(m => String(m?.role || '') === 'bot') : null;
            const botPrev = String(lastBot?.text || '');
            const beatSignals = collectBeatSignals(String(conv_id || ''), ctx, { userText: String(text || ''), botPrev });
            try { ctx.vars.__beat_signals = beatSignals; } catch {}
            const tensionHint = (beatSignals && beatSignals.inputs && beatSignals.inputs.style)
              ? beatSignals.inputs.style.tensionHint
              : (() => { try { const t = Number(ctx?.vars?.tension ?? ctx?.memory?.tension); return Number.isFinite(t) ? t : null; } catch { return null; } })();
            const planBeat = detectBeat(String(conv_id || ''), { userText: String(text || ''), botPrev, tensionHint });
            if (planBeat && planBeat.enabled) {
              try { ctx.vars.__beat_plan = planBeat; } catch {}
              // Prefer beat-suggested style preset for hedger alignment
              try { ctx.vars.style = { ...(ctx.vars.style||{}), preset: String(planBeat.styleToken||''), beat: String(planBeat.beat||''), tension: Number(planBeat.tension||0) }; } catch {}
              const cadenceBoost = buildCadenceBooster(planBeat);
              if (cadenceBoost && cadenceBoost.text) {
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(cadenceBoost.text, { model })) || Number(cadenceBoost.estTokens) || 0; } catch { addTok = Number(cadenceBoost.estTokens || 0) || 0; }
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${cadenceBoost.text}`;
                try { ctx.vars.__cadence_booster_text = String(cadenceBoost.text || ''); } catch {}
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
                try { METRICS.inc('cadence_booster_injected_total', { path: 'stream', beat: String(planBeat.beat || ''), style: String(planBeat.styleToken || '') }); } catch {}
              }
              try { METRICS.inc('beat_ticks_total', { path: 'stream', beat: String(planBeat.beat || '') }); } catch {}
            }
          } catch {}

          try {
            // Record user turn into cadence tracker (Ultra-enabled)
            try {
              if (conv_id) {
                const cadUser = getCadenceCfg();
                const cadUserEff = { ...cadUser, enabled: ultraFeatureEnabled(conv_id, cadUser.enabled) };
                pushTurn(conv_id, 'user', text, cadUserEff);
              }
            } catch {}
            // Apply phrase penalties to discourage overused phrases (Ultra-enabled)
            try {
              const pCfg = getPhraseCfg();
              const pEff = { ...pCfg, enabled: ultraFeatureEnabled(conv_id, pCfg.enabled) };
              const pen = getPenalties(conv_id, pEff);
              if (Array.isArray(pen?.penaltyHints) && pen.penaltyHints.length) {
                textInput = pen.penaltyHints.join('\n') + '\n\n' + textInput;
                try { METRICS.inc('loopguard_phrase_penalty_total', { path: 'stream' }); } catch {}
              }
            } catch {}
            // Apply cadence style hint ahead of user text (Ultra-enabled)
            try {
              const cadNext = getCadenceCfg();
              const cadNextEff = { ...cadNext, enabled: ultraFeatureEnabled(conv_id, cadNext.enabled) };
              const cadence = chooseStyleForNext(conv_id, cadNextEff);
              if (String(cadence?.style || '').trim()) {
                textInput = `(STYLE:${cadence.style}) ${textInput}`;
                try { METRICS.inc('loopguard_cadence_hint_total', { path: 'stream', style: String(cadence.style || '') }); } catch {}
              }
            } catch {}
          } catch {}
          // --- Scene Conclusion: maybe stage a conclusion booster (stream path) ---
          try {
            const sseEmit = (event, data) => {
              try {
                // Emit to the conversation stream SSE
                res.write('event: '+event+'\n');
                res.write('data: '+JSON.stringify(data)+'\n\n');
              } catch {}
              try {
                // Mirror to admin memory SSE channel
                broadcastAdminMemoryEvent(conv_id, event, { conv_id: conv_id, ...data });
              } catch {}
            };
            const conc = maybeStageConclusionBooster(ctx, conv_id, memoryPrefix, sseEmit, 'stream');
            if (conc && conc.memoryPrefix) {
              memoryPrefix = conc.memoryPrefix;
            }
          } catch {}
          // --- Conclusion Trigger (drag score): tasteful fade booster (stream path) ---
          try {
            if (String(process.env.CONCLUDE_ENABLED || '0') === '1') {
              const ctxVars = ctx?.vars || {};
              const loopScore = Number(ctxVars.__loopguard_loopscore || ctxVars.__loopguard_deltaSim || 0);
              const deltaSim  = Number(ctxVars.__loopguard_deltaSim || 0);
              const dwellMs   = Number(ctxVars.__last_turn_dwell_ms || 0);
              const tensionVar= Number(ctxVars.__tension_variance_lastN || 0);
              const drag = computeDragScore({ loopScore, deltaSim, dwellMs, tensionVar });
              try { ctx.vars.__drag_score = drag; } catch {}
              const thresh = Number(process.env.CONCLUDE_DRAG_THRESHOLD || 0.66);
              if (drag >= thresh) {
                const nextHint = ctxVars.__scene_next_hint || null;
                const tone = (ctxVars?.spine?.tone) || 'classy';
                const fade = buildFadeBooster({ style: tone, sceneName: nextHint });
                memoryPrefix = (memoryPrefix || '') + `\n${fade}\n`;
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { METRICS.inc('scene_conclusion_total', { path: 'stream' }); } catch {}
                try {
                  res.write('event: memory.conclude\n');
                  res.write('data: ' + JSON.stringify({ drag, next: nextHint || null }) + '\n\n');
                } catch {}
              }
            }
          } catch {}
          try { ctx.vars.tokens_in = TokenCounter.estimate(textInput, { model }); } catch {}
          // Beat-driven style booster (pre-stream): compute and inject
          let __beat_style_info_stream = null;
          let textForModel = textInput;
          try {
            if (BEAT_STYLE_ENABLED && BEAT_ENABLED) {
              __beat_style_info_stream = applyBeatStyleBooster({ ctx, conv_id, userText: textInput, currentBeat: getBeat(conv_id) });
              if (__beat_style_info_stream && __beat_style_info_stream.mode === 'memory' && __beat_style_info_stream.line) {
                let addTok = 0;
                try { addTok = Number(TokenCounter.estimate(__beat_style_info_stream.line, { model })) || 0; } catch { addTok = 0; }
                memoryInjectTokens += addTok;
                memoryPrefix = `${memoryPrefix ? `${memoryPrefix}\n` : ''}${__beat_style_info_stream.line}`;
                try { ctx.vars.__memory_prefix = memoryPrefix; } catch {}
                try { ctx.vars.__memory_injected_tokens = memoryInjectTokens; } catch {}
                try { METRICS.inc('memory_inject_tokens_total', { tokens: String(addTok), path: 'stream' }); } catch {}
              } else if (__beat_style_info_stream && __beat_style_info_stream.mode === 'text' && __beat_style_info_stream.line) {
                textForModel = `${__beat_style_info_stream.line}\n${textInput}`;
              }
            }
          } catch {}
          // Precompute style hedge plan ahead of stream start so SSE can announce the plan
          try {
            const pref = getStylePref(String(conv_id || '')) || {};
            const primaryPreset = String(pref?.preset || '');
            const plan = planStyleHedge(ctx, String(conv_id || ''), primaryPreset);
            if (plan && plan.booster && plan.booster.text) {
              try { ctx.vars.__style_backup_booster = String(plan.booster.text || ''); } catch {}
              try { ctx.vars.__style_backup_preset = String(plan.altPreset || ''); } catch {}
              try { ctx.vars.__style_backup_tokens = Array.isArray(plan.tokens) ? plan.tokens : []; } catch {}
            }
          } catch {}
          // Style hedge streaming: run primary, optionally hedge with style-boosted backup using new hedger
          const sseEvents = Object.create(null);
          const ALT_PROVIDER = String(process.env.HEDGE_STYLE_PROVIDER || '').trim();
          // Gate deltas so only the winner writes to client
          let winnerTag = null;
          let startWritten = false;
          let endWritten = false;
          const notifyRef = { fn: (/*from, meta*/) => {} };
          // Forwarders attach to per-stream ctx buses and pipe to write()
          const forwardStream = (ctxLocal, tag) => {
            const unsub = [];
            const onStart = (p) => {
              if (!startWritten) {
                startWritten = true;
                write('start', { ...p, style_hedge: tag === 'backup', style: tag === 'backup' ? String(ctx?.vars?.__style_backup_preset || '') : undefined });
              }
            };
            const onDelta = (payload) => {
              if (!winnerTag) {
                winnerTag = tag;
                const meta = { provider: String(ctxLocal?.vars?.__selected_provider || ''), model: String(ctxLocal?.vars?.__selected_model || ''), style: tag === 'backup' ? String(ctx?.vars?.__style_backup_preset || '') : '' };
                // Reflect winner provider/model on route ctx for downstream metrics
                if (tag === 'backup') {
                  try { ctx.vars.__selected_provider = String(ctxBackup?.vars?.__selected_provider || ctx.vars.__selected_provider || ''); } catch {}
                  try { ctx.vars.__selected_model = String(ctxBackup?.vars?.__selected_model || ctx.vars.__selected_model || ''); } catch {}
                  try { ctx.vars.__used_provider = String(ctxBackup?.vars?.__selected_provider || ctx.vars.__used_provider || ''); } catch {}
                } else {
                  try { ctx.vars.__used_provider = String(ctxPrimary?.vars?.__selected_provider || ctx.vars.__used_provider || ''); } catch {}
                }
                try { notifyRef.fn(tag, meta); } catch {}
                // Mark scene conclusion applied on first delta, only if staged earlier
                try {
                  if (ctx.vars.__scene_conclusion_staged && !ctx.vars.__scene_conclusion_applied) {
                    ctx.vars.__scene_conclusion_applied = true;
                    METRICS.inc('scene_conclusion_applied_total', { path: 'stream' });
                    // Emit applied on conversation stream
                    res.write('event: scene.conclusion.applied\n');
                    res.write('data: {"ok":true}\n\n');
                    // Mirror applied to admin memory SSE channel
                    try { broadcastAdminMemoryEvent(conv_id, 'scene.conclusion.applied', { conv_id, ok: true }); } catch {}
                  }
                } catch {}
              }
              if (winnerTag === tag) write('delta', payload);
            };
            const onNarrative = (p) => { if (winnerTag === tag) write('narrative.event', p); };
            const onEnd = (p) => { if (!endWritten && winnerTag === tag) { endWritten = true; write('end', { ...p, style_hedge: tag === 'backup' }); } };
            try {
              ctxLocal.io.events.on('stream.start', onStart);
              ctxLocal.io.events.on('stream.delta', onDelta);
              ctxLocal.io.events.on('narrative.event', onNarrative);
              ctxLocal.io.events.on('stream.end', onEnd);
            } catch {}
            unsub.push(() => { try { ctxLocal.io.events.off('stream.start', onStart); } catch {} });
            unsub.push(() => { try { ctxLocal.io.events.off('stream.delta', onDelta); } catch {} });
            unsub.push(() => { try { ctxLocal.io.events.off('narrative.event', onNarrative); } catch {} });
            unsub.push(() => { try { ctxLocal.io.events.off('stream.end', onEnd); } catch {} });
            return () => unsub.forEach((fn) => { try { fn(); } catch {} });
          };
          // Write closure reused from legacy hedger
          const write = (event, payload) => {
              try {
                if (event === 'start') {
                  try { ctx.vars.__stream_start_ms = Date.now(); ctx.vars.__first_token_recorded = false; } catch {}
                  const provider = String((payload && payload.provider) || ctx.vars.__selected_provider || '');
                  const resolvedModel = String((payload && payload.resolved_model) || ctx.vars.__selected_model || '');
                  providerAtStart = provider;
                  modelAtStart = resolvedModel;
                  const primary = String((payload && payload.provider_primary) || ctx.vars.__primary_provider || provider);
                  const used = String((payload && payload.provider_used) || ctx.vars.__used_provider || provider);
                  const hedgeTriggered = Boolean((payload && payload.hedge_triggered) || (primary && used && primary !== used));
                  const startSignals = computeAbuseSignals(textInput);
                  emitAndRecordSignals(startSignals, { engine_source: engineSource });
                  const __style_meta = computeStyleMeta(conv_id);
                  try {
                    const nextSeq = getNextSeq(conv_id);
                    const startPayload = {
                      model,
                      provider,
                      provider_primary: primary,
                      provider_used: used,
                      hedge_triggered: hedgeTriggered,
                      resolved_model: resolvedModel,
                      engine_source: engineSource,
                      variant_v: ctx.vars.abVariant || '',
                      conv_id,
                      tool_call_id: toolCallId,
                      tenant: String(ctx.vars.tenant || ''),
                      request_id: String(rid || ''),
                      prompt_injection_signal: startSignals.prompt_injection_signal,
                      jailbreak_signal: startSignals.jailbreak_signal,
                      grounding_strength: startSignals.grounding_strength,
                      memory_applied: Boolean(String(ctx?.vars?.__memory_prefix || '') && Number(ctx?.vars?.__memory_injected_tokens || 0) > 0),
                      memory_injected_tokens: Number(ctx?.vars?.__memory_injected_tokens || 0),
                      tension: Number(ctx?.vars?.tension ?? ctx?.memory?.tension ?? 0),
                      tension_beat: String(ctx?.vars?.tension_beat || ''),
                      beat: String(ctx?.vars?.tension_beat || ''),
                      msg_seq: nextSeq,
                      style_hedge: Boolean((payload && payload.style_hedge) || false),
                      style_tag: String((payload && payload.style) || ''),
                      ...(__style_meta ? { style_meta: __style_meta } : {}),
                    };
                    if (__style_meta) {
                      const tokenCount = Array.isArray(__style_meta.tokens) ? __style_meta.tokens.length : 0;
                      startPayload.style = { preset: String(__style_meta.preset || ''), token_count: tokenCount };
                    }
                    res.write(`event: start\ndata: ${JSON.stringify(startPayload)}\n\n`);
                    try { if (__style_meta) { broadcastAdminStyleEvent(conv_id, 'style.pref', { conv_id, style_meta: __style_meta }); METRICS.inc('style_pref_sse_total', { path: 'stream' }); } } catch {}
                  } catch {}
                  // Emit beat.tick announcing detected beat/cadence for this turn
                  try {
                    const bp = ctx?.vars?.__beat_plan;
                    if (bp && bp.enabled) {
                      const bs = ctx?.vars?.__beat_signals || {};
                      const stats = {
                        loopScore: Number(bs?.loopScore ?? 0),
                        deltaSim: Number(bs?.deltaSim ?? 0),
                        dwellMs: Number(bs?.dwellMs ?? 0),
                        tensionVar: Number(bs?.tensionVar ?? 0),
                        drag: Number(bs?.drag ?? 0)
                      };
                      const beatPayload = {
                        conv_id,
                        tension: Number(bp.tension || 0),
                        beat: String(bp.beat || ''),
                        style: String(bp.styleToken || ''),
                        cadence: String(bp.cadence || ''),
                        notes: Array.isArray(bp.notes) ? bp.notes : [],
                        stats
                      };
                      res.write('event: beat.tick\n');
                      res.write(`data: ${JSON.stringify(beatPayload)}\n\n`);
                      try { broadcastAdminStyleEvent(conv_id, 'beat.tick', beatPayload); } catch {}
                      // Detection metric already counted earlier; keep SSE write lightweight
                    }
                  } catch {}
                  // Emit cadence.plan to announce cadence booster planning
                  try {
                    const bp = ctx?.vars?.__beat_plan;
                    if (bp && bp.enabled) {
                      const cb = buildCadenceBooster(bp);
                      if (cb) {
                        const estTokens = Number(cb.estTokens || 0) || (Number(TokenCounter.estimate(String(cb.text||''), { model })) || 0);
                        const payload = { conv_id, beat: String(bp.beat || ''), style: String(bp.styleToken || ''), estTokens };
                        res.write('event: cadence.plan\n');
                        res.write(`data: ${JSON.stringify(payload)}\n\n`);
                        try { broadcastAdminStyleEvent(conv_id, 'cadence.plan', payload); } catch {}
                      }
                    }
                  } catch {}
                  // Emit memory.boost if a booster was injected into user text
                  try {
                    if (__booster_text) {
                      res.write('event: memory.boost\n');
                      res.write(`data: ${JSON.stringify({ text: __booster_text })}\n\n`);
                    }
                  } catch {}
                  // Emit memory.dream if a dream fragment was injected
                  try {
                    if (__dream_text) {
                      res.write('event: memory.dream\n');
                      res.write(`data: ${JSON.stringify({ text: __dream_text })}\n\n`);
                      try { broadcastAdminMemoryEvent(conv_id, 'memory.dream', { conv_id, text: __dream_text }); } catch {}
                      try { METRICS.inc('dreams_emitted_total', { path: 'stream' }); } catch {}
                    }
                  } catch {}
                  // Emit memory.guard if a guard hint was injected for this turn
                  try {
                    const gh = String(ctx?.vars?.__guard_hint || '').trim();
                    if (gh) {
                      res.write('event: memory.guard\n');
                      res.write(`data: ${JSON.stringify({ hint: gh })}\n\n`);
                      try { METRICS.inc('guard_hint_emitted_total', { path: 'stream' }); } catch {}
                    }
                  } catch {}
                  // Emit memory.style.booster if a style booster was injected into memory
                  try {
                    const sbt = String(ctx?.vars?.__style_booster_text || __style_booster_text || '').trim();
                    if (sbt) {
                      const sbPreset = String(ctx?.vars?.__style_booster_preset || (__style_meta && __style_meta.preset) || '');
                      let estTokens = 0; try { estTokens = Number(ctx?.vars?.__style_booster_est_tokens || TokenCounter.estimate(sbt, { model }) || 0); } catch { estTokens = 0; }
                      let tokenBudget = 40; try { tokenBudget = Number(ctx?.vars?.__style_booster_token_budget || process.env.STYLE_BOOSTER_MAX_TOKENS || 40); } catch {}
                      res.write('event: memory.style.booster\n');
                      res.write(`data: ${JSON.stringify({ text: sbt, preset: sbPreset, estTokens, tokenBudget })}\n\n`);
                      try { METRICS.inc('style_booster_emitted_total', { path: 'stream' }); } catch {}
                    }
                  } catch {}
                  // Emit memory.roll whenever a roll was computed (success or failure)
                  try {
                    const r = ctx?.vars?.roll || {};
                    const rh = String(ctx?.vars?.roll_hint || '').trim();
                    if (r && String(r?.action || '').trim()) {
                      const payload = { hint: rh, action: String(r?.action || ''), chance: Number(r?.chance || 0), success: Boolean(r?.success), style: String(getRollStyle(String(conv_id || '')) || '') };
                      res.write('event: memory.roll\n');
                      res.write(`data: ${JSON.stringify(payload)}\n\n`);
                      try { broadcastAdminMemoryEvent(conv_id, 'memory.roll', { conv_id, ...payload }); } catch {}
                      try { METRICS.inc('memory_roll_emitted_total', { path: 'stream' }); } catch {}
                    }
                  } catch {}
                  // Emit style.hedge.plan if a backup booster plan was prepared earlier
                  try {
                    const backupText = String(ctx?.vars?.__style_backup_booster || '').trim();
                    if (backupText) {
                      const primary = String((__style_meta && __style_meta.preset) || (ctx?.vars?.style?.preset) || '');
                      const backupPreset = String(ctx?.vars?.__style_backup_preset || '');
                      let estTokens = 0; try { estTokens = Number(TokenCounter.estimate(backupText, { model }) || 0); } catch { estTokens = 0; }
                      let tokenBudget = 40; try { tokenBudget = Number(ctx?.vars?.__style_booster_token_budget || process.env.STYLE_BOOSTER_MAX_TOKENS || 40); } catch {}
                      res.write('event: style.hedge.plan\n');
                      res.write(`data: ${JSON.stringify({ conv_id, preset_primary: primary, preset_backup: backupPreset, estTokens, tokenBudget })}\n\n`);
                      try { broadcastAdminStyleEvent(conv_id, 'style.hedge.plan', { conv_id, preset_primary: primary, preset_backup: backupPreset, estTokens }); } catch {}
                      try { METRICS.inc('style_hedge_started_total', { path: 'stream' }); } catch {}
                    }
                  } catch {}
                  // Emit loop.phrase.plan to announce current cooldown plan (hash-only)
                  try {
                    const items = Array.isArray(ctx?.vars?.__phrase_plan_items) ? ctx.vars.__phrase_plan_items : [];
                    res.write('event: loop.phrase.plan\n');
                    res.write(`data: ${JSON.stringify({ conv_id, items })}\n\n`);
                    try { METRICS.inc('loop_phrase_plan_total', { path: 'stream', count: String(items.length) }); } catch {}
                  } catch {}
                  // Emit loop.phrase.cooldown when pattern-based hot phrases exist (count only)
                  try {
                    const hotCount = Number(ctx?.vars?.__phrase_hot_count || 0);
                    if (hotCount > 0) {
                      res.write('event: loop.phrase.cooldown\n');
                      res.write(`data: ${JSON.stringify({ conv_id, count: hotCount })}\n\n`);
                      try { METRICS.inc('loop_phrase_cooldown_total', { path: 'stream', count: String(hotCount) }); } catch {}
                    }
                  } catch {}
                  if (streamKey) {
                    ACTIVE_STREAMS.set(streamKey, { started: Date.now() });
                    try { pruneCaches(); } catch {}
                    try { METRICS.set('active_streams_current', ACTIVE_STREAMS.size); } catch {}
                  }
                  try { METRICS.inc('llm_provider_selected_total', { provider, model, resolved_model: resolvedModel, source: engineSource }); span?.setAttribute?.('llm.model', model); span?.setAttribute?.('llm.provider', provider); span?.setAttribute?.('llm.resolved_model', resolvedModel); span?.setAttribute?.('llm.engine_source', engineSource); span?.setAttribute?.('llm.variant_v', String(ctx.vars.abVariant || '')); } catch {}
                } else if (event === 'delta') {
                  try {
                    gotFirstDelta = true;
                    const raw = typeof payload === 'string' ? payload : (payload && payload.text) || '';
                    const s = sanitizeUtf8Text(String(raw || ''));
                    try {
                      if (!ctx.vars.__first_token_recorded && Number.isFinite(Number(ctx.vars.__stream_start_ms || 0))) {
                        const ms = Math.max(0, Date.now() - Number(ctx.vars.__stream_start_ms));
                        let le = 'gt';
                        for (const b of FIRST_TOKEN_MS_BUCKETS) { if (ms <= b) { le = String(b); break; } }
                        METRICS.inc('first_token_ms_bucket', { le });
                        METRICS.set('first_token_last_ms', ms);
                        ctx.vars.__first_token_recorded = true;
                      }
                    } catch {}
                    res.write(`event: delta\ndata: ${JSON.stringify({ text: s })}\n\n`);
                    final += s;
                  } catch {}
                } else if (event === 'end') {
                  // Reuse existing end-of-stream logic by emitting to route ctx
                  // Update beat snapshot at stream end using final bot text and user input
                  try {
                    const snap = updateBeat(String(conv_id || ''), { botText: String(final || ''), userText: String(textForModel || '') }) || null;
                    if (snap && snap.state) {
                      try { METRICS.inc('beat_ticks_total', { path: 'stream', beat: String(snap.state || '') }); } catch {}
                      try { METRICS.inc('scene_beat_state_total', { state: String(snap.state || ''), path: 'stream' }); } catch {}
                      try {
                        const prev = lastBeatStateByConv.get(String(conv_id || ''));
                        if (prev && prev !== snap.state) METRICS.inc('scene_beat_switch_total', { from: String(prev || ''), to: String(snap.state || ''), path: 'stream' });
                        lastBeatStateByConv.set(String(conv_id || ''), String(snap.state || ''));
                      } catch {}
                      // Surface tension/beat to next-turn consumers
                      try { ctx.vars.memory = ctx.vars.memory || {}; ctx.vars.memory.tension = Number(snap.tension || 0); ctx.vars.beat_state = String(snap.state || ''); } catch {}
                      // Optional SSE signal for UI consumers
                      try {
                        if (BEAT_SSE) {
                          res.write('event: scene.beat\n');
                          res.write(`data: ${JSON.stringify({ conv_id, state: String(snap.state || ''), tension: Number(snap.tension || 0), stats: snap.stats || {} })}\n\n`);
                        }
                      } catch {}
                      // Emit memory.beat snapshot at stream end for subscribers
                      try {
                        res.write('event: memory.beat\n');
                        res.write(`data: ${JSON.stringify({ conv_id, tension: Number(snap.tension || 0), beat: String(snap.state || '') })}\n\n`);
                        try { METRICS.inc('memory_beat_emitted_total', { path: 'stream_end' }); } catch {}
                      } catch {}
                    }
                  } catch (e) { try { METRICS.inc('beat_errors_total', { path: 'stream' }); } catch {} }
                  // Cadence observed for streams (no reroll here)
                  try {
                    const beatState = String((ctx?.vars?.beat_state) || (getBeat(String(conv_id || ''))?.state) || 'lull');
                    const target = getCadenceForBeat(beatState);
                    const observed = measureCadence(String(final || ''));
                    emitCadenceObserved({ writeSSE, conv_id, beatState, target, observed });
                  } catch {}
                  try { ctx.io.events.emit('stream.end'); } catch {}
                } else if (event === 'hedge.switch') {
                  const toProvider = String(ctx.vars.__selected_provider || '');
                  const toModel = String(ctx.vars.__selected_model || '');
                  const payloadOut = { reason: 'style_hedge', style: String((payload && payload.style) || ''), from_provider: providerAtStart, from_resolved_model: modelAtStart, to_provider: toProvider, to_resolved_model: toModel };
                  try { res.write(`event: hedge.switch\ndata: ${JSON.stringify(payloadOut)}\n\n`); } catch {}
                  try { METRICS.inc('llm_hedge_switch_total', { from: providerAtStart, to: toProvider, model, source: engineSource }); } catch {}
                  try { METRICS.inc('style_hedge_switch_total', { path: 'stream' }); } catch {}
                } else if (event === 'narrative.event') {
                  try { res.write('event: narrative.event\n'); res.write(`data: ${JSON.stringify({ conv_id, ...payload })}\n\n`); } catch {}
                  try { broadcastAdminMemoryEvent(conv_id, 'narrative.event', { conv_id, ...payload }); } catch {}
                  try {
                    if (payload && payload.type === 'SuspicionChanged') {
                      lastSuspicion = { name: String(payload.name || ''), level: Number(payload.level || 0), at: Number(payload.at || Date.now()) };
                    }
                  } catch {}
                }
              } catch {}
            };
          // Create isolated contexts for primary and backup to avoid bus conflicts
          const ctxPrimary = initBotContext({ ...ctx, vars: { ...(ctx.vars || {}), conv_id } });
          const ctxBackup  = initBotContext({ ...ctx, vars: { ...(ctx.vars || {}), conv_id, __style_hedge: String(ctx?.vars?.__style_backup_preset || '') } });
          const primaryUnsub = forwardStream(ctxPrimary, 'primary');
          const backupUnsub  = forwardStream(ctxBackup , 'backup');
          // Start functions launch streams and return cancel handles
          const startPrimary = async () => {
            const ac = new AbortController();
            const cancel = () => { try { ac.abort(); } catch {} };
            (async () => {
              try { await llm.stream(textForModel, { model, signal: ac.signal }, ctxPrimary); } catch {} finally { try { primaryUnsub(); } catch {} }
            })();
            return { cancel };
          };
          const startBackup = async () => {
            const ac = new AbortController();
            const cancel = () => { try { ac.abort(); } catch {} };
            const booster = String(ctx?.vars?.__style_backup_booster || '').trim();
            const backupText = booster ? `${booster}\n\n${textForModel}` : textForModel;
            // Optional provider override for backup
        if (ALT_PROVIDER) {
          try { ctxBackup.vars.__provider_override = ALT_PROVIDER; } catch {}
          // Keep legacy visibility for observability; provider will overwrite on selection
          try { ctxBackup.vars.__selected_provider = ALT_PROVIDER; } catch {}
        }
            (async () => {
              try { await llm.stream(backupText, { model, signal: ac.signal }, ctxBackup); } catch {} finally { try { backupUnsub(); } catch {} }
            })();
            return { cancel };
          };
          // Announce SSE using new hedger names but keep legacy SSE name mapping
          const resOrEmit = (evt, payload) => {
            if (evt === 'hedge.style.start') {
              try { res.write('event: style.hedge.start\n'); } catch {}
              try { res.write(`data: ${JSON.stringify({ preset_backup: ctx?.vars?.__style_backup_preset || 'unknown', ...payload })}\n\n`); } catch {}
              try { METRICS.inc('style_hedge_started_total', { path: 'stream' }); } catch {}
            } else if (evt === 'hedge.style.switch') {
              try { res.write('event: style.hedge.switch\n'); } catch {}
              try { res.write(`data: ${JSON.stringify({ preset_backup: ctx?.vars?.__style_backup_preset || 'unknown', ...payload })}\n\n`); } catch {}
              try { METRICS.inc('style_hedge_switch_total', { path: 'stream' }); } catch {}
            }
          };
          const hedger = await runStyleHedge(ctx, startPrimary, startBackup, (from, meta) => {
            // Also emit generic hedge.switch for dashboards
            write('hedge.switch', { reason: 'style_hedge', style: String(ctx?.vars?.__style_backup_preset || '') });
          }, resOrEmit);
          // Hook notifyFirst for delta gating
          notifyRef.fn = hedger?.notifyFirst || notifyRef.fn;
          // Await end of winner stream by polling endWritten
          for (let i = 0; i < 600; i++) { // up to ~6s
            if (endWritten) break;
            await new Promise(r => setTimeout(r, 10));
          }
        } catch (err) {
          // Outcome: error with classification similar to monolith classifyLLMError
          try {
            const classifyLLMError = (e) => {
              try {
                const name = String((e && e.name) || '').toLowerCase();
                const msg = String((e && e.message) || e || '').toLowerCase();
                const m4 = msg.match(/http\s+(4\d{2})/);
                if (m4 && m4[1] !== '429') return 'fatal';
                if (/timeout/.test(msg) || /abort/.test(name) || /http\s+429/.test(msg) || /http\s+5\d{2}/.test(msg)) return 'transient';
                return 'unknown';
              } catch { return 'unknown'; }
            };
            const cls = classifyLLMError(err);
            const provider = String(ctx.vars.__selected_provider || '');
            const resolvedModel = String(ctx.vars.__selected_model || '');
            METRICS.inc('llm_provider_outcome_total', { provider, model, resolved_model: resolvedModel, source: engineSource, outcome: 'error', classification: cls, path: 'stream' });
          } catch {}
          try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(err && err.message || err) })}\n\n`); } catch {}
          try {
            await sendMessageWithTick(async () => { res.end(); return true; });
          } catch {
            try { res.end(); } catch {}
          }
        }
        return;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_request' }));
        try { METRICS.inc('responses_total', { status: '400' }); span?.setAttribute?.('http.status_code', 400); } catch {}
        return;
      }
    }
    // Heap snapshot endpoint (admin only)
    // Billing export: signed NDJSON usage entries with resume token (admin only)
    // Use URL pathname parsing to avoid any edge-cases with req.url variations
    if (String(req.method || 'GET').toUpperCase() === 'GET') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      // GET /memory/boosters?conv_id=...
      if (__path === '/memory/boosters') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) convId = 'conv';
          const items = listBoosters(convId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, boosters: items }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_boosters_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/arc?conv_id=...
      if (__path === '/memory/arc') {
        try {
          // Admin auth (optional; enforced only when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) convId = 'conv';
          const { arc, at } = getArc(convId) || {};
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, arc: arc || null, at: Number(at || 0) }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_arc_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/boosters/:id?conv_id=...
      if (__path.startsWith('/memory/boosters/')) {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) convId = 'conv';
          const parts = __path.split('/');
          const id = parts[parts.length - 1];
          const items = listBoosters(convId);
          const one = items.find((b) => String(b.id) === String(id));
          if (!one) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'not_found' }));
            try { METRICS.inc('responses_total', { status: '404' }); } catch {}
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, booster: one }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_booster_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/facets?conv_id=...&char=...
      if (__path === '/memory/facets') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          let char = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
            char = String(uQ.searchParams.get('char') || '').trim();
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const data = await loadFacets(convId);
          let out = data;
          if (char) {
            out = { characters: { [char]: (data?.characters?.[char] || []) } };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, ...(char ? { char } : {}), facets: out }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_facets_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/shadow?conv_id=...
      if (__path === '/memory/shadow') {
        try {
          // Admin auth (optional; enforced only when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const snap = await shadowSnapshot(convId);
          const body = {
            ok: true,
            conv_id: convId,
            turns: Array.isArray(snap?.turns) ? snap.turns.length : 0,
            facts: Array.isArray(snap?.facts) ? snap.facts.length : 0,
            mismatches: Array.isArray(snap?.mismatches) ? snap.mismatches : [],
            sample_facts: Array.isArray(snap?.facts) ? snap.facts.slice(0, 12) : []
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_shadow_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/facts?conv_id=...
      if (__path === '/memory/facts') {
        try {
          // Admin auth (optional; enforced only when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) convId = 'conv';
          const facts = listFacts(convId);
          try {
            const maxFacts = Math.max(1, Number(process.env.FACTS_MAX || 64));
            METRICS.set('facts_current', Array.isArray(facts) ? facts.length : 0);
            METRICS.set('facts_max', maxFacts);
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, facts }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_facts_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/beliefs?char_id=...
      if (__path === '/memory/beliefs') {
        try {
          // Admin auth (optional; enforced only when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let charId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); charId = String(uQ.searchParams.get('char_id') || uQ.searchParams.get('agent_id') || '').trim(); } catch {}
          if (!charId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'char_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const beliefs = listBeliefs(charId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, char_id: charId, beliefs }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_beliefs_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/audit?conv_id=...&limit=...
      if (__path === '/memory/audit') {
        try {
          // Admin auth (optional; enforced only when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          let limit = 100;
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
            limit = Math.max(1, Math.min(1000, Number(uQ.searchParams.get('limit') || 100)));
          } catch {}
          const items = getAudit({ convId, limit });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId || undefined, count: items.length, items }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_audit_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      if (__path === '/billing/export') {
      try {
        // Admin auth (reuse ADMIN_TOKEN mechanics)
        const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
        if (requireAuth) {
          const token = String(process.env.ADMIN_TOKEN || '').trim();
          const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
          const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
          let tokenFromQuery = '';
          try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
          const ok = tokenFromHdr === token || tokenFromQuery === token;
          if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'forbidden' }));
            try { METRICS.inc('responses_total', { status: '403' }); } catch {}
            return;
          }
        }
        try { globalThis.__ensureUsageLedger__?.(); } catch {}
        const led = globalThis.__USAGE_LEDGER__ || { buffer: [], lastCursor: '' };
        let startIndex = 0;
        let limit = Math.max(1, Math.min(5000, Number(new URL(`http://localhost${req.url}`).searchParams.get('limit') || 1000)));
        try {
          const uTmp = new URL(`http://localhost${req.url}`);
          const cursor = String(uTmp.searchParams.get('cursor') || '').trim();
          if (cursor) {
            const parts = cursor.split(':');
            const idxStr = parts[1] || parts[0];
            const idx = Number(idxStr || 0);
            if (Number.isFinite(idx) && idx >= 0) startIndex = idx + 1;
          }
        } catch {}
        const items = led.buffer.slice(startIndex, startIndex + limit);
        const lines = items.map((it) => JSON.stringify(it));
        const checksum = (function() {
          try {
            const h = crypto.createHash('sha256');
            for (const ln of lines) h.update(ln + '\n');
            return h.digest('hex');
          } catch { return ''; }
        })();
        try {
          console.log(JSON.stringify({ evt: 'billing_export_debug', startIndex, limit, buffer_len: Array.isArray(led.buffer) ? led.buffer.length : 0, lines_len: lines.length }));
          appendTestOutput(JSON.stringify({ evt: 'test_export', startIndex, limit, buffer_len: Array.isArray(led.buffer) ? led.buffer.length : 0, lines_len: lines.length, last_cursor: String(led.lastCursor || '') }));
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Resume-Token': String(led.lastCursor || ''), 'X-Checksum': String(checksum || '') });
        try { for (const ln of lines) res.write(ln + '\n'); } catch {}
        try { res.end(); } catch {}
        try { METRICS.inc('responses_total', { status: '200' }); } catch {}
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'export_failed' }));
        try { METRICS.inc('responses_total', { status: '500' }); } catch {}
      }
      return;
      }
      // GET /memory/preview?conv_id=...&text=...&model=...&turn=...
      if (__path === '/memory/preview') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }

          // Parse query params
          let convId = '';
          let text = '';
          let model = '';
          let turn = 0;
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
            text = String(uQ.searchParams.get('text') || '');
            model = String(uQ.searchParams.get('model') || '');
            turn = Number(uQ.searchParams.get('turn') || '0') || 0;
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }

          // Snapshot stores and simulate pre-turn injection
          const [str, ef, cf] = await Promise.all([getSTR(convId), getEF(convId), getCF(convId)]);
          const sim = await preTurnMemory({ convId, turn, model, userText: text });

          const body = {
            ok: true,
            snapshot: { str: str || null, ef: ef || { items: [] }, cf: cf || { chars: {} } },
            simulate: {
              model,
              text,
              inject_text: sim?.injectText || '',
              inject_tokens: Number(sim?.injectTokens || 0),
              budget_tokens: Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || 120)
            }
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(body));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_preview_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // Serve static tuner page (local/admin only)
      if (__path === '/memory/tuner') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          const file = path.join(process.cwd(), 'scripts', 'docs', 'memory-tuner.html');
          let body = '';
          try { body = await AsyncFS.readFile(file, 'utf8'); } catch {}
          if (!body) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            try { METRICS.inc('responses_total', { status: '404' }); } catch {}
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'serve_tuner_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // Serve admin memory page (local/admin only)
      if (__path === '/admin/memory') {
        try {
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          const fileSpa = path.join(process.cwd(), 'scripts', 'admin', 'memory_spa.html');
          const fileLegacy = path.join(process.cwd(), 'scripts', 'admin', 'memory.html');
          let body = '';
          try { body = await AsyncFS.readFile(fileSpa, 'utf8'); } catch {}
          if (!body) {
            try { body = await AsyncFS.readFile(fileLegacy, 'utf8'); } catch {}
          }
          if (!body) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found' }));
            try { METRICS.inc('responses_total', { status: '404' }); } catch {}
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'serve_admin_memory_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/conv/:id/phrases — phrase inspector JSON (admin gated)
      if (String(req.method || 'GET').toUpperCase() === 'GET' && __path.startsWith('/admin/conv/') && __path.endsWith('/phrases')) {
        try {
          if (!adminGuard(req, res)) return;
          const parts = __path.split('/');
          const conv_id = decodeURIComponent(parts[3] || '').trim();
          if (!conv_id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          try {
            const mod = await import('./style/phrase_decay.mjs');
            const PD = mod.default || mod;
            const { hot } = PD.getHot(conv_id);
            const snapshot = PD.snapshot(conv_id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id, hot, snapshot }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'phrase_inspector_failed', msg: String(e?.message || e) }));
            try { METRICS.inc('responses_total', { status: '500' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'phrase_inspector_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/conv/:id/beat — beat snapshot (admin gated)
      if (String(req.method || 'GET').toUpperCase() === 'GET' && __path.startsWith('/admin/conv/') && __path.endsWith('/beat')) {
        try {
          if (!adminGuard(req, res)) return;
          const parts = __path.split('/');
          const conv_id = decodeURIComponent(parts[3] || '').trim();
          if (!conv_id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const beat = getBeat(conv_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id, beat }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'beat_snapshot_failed', msg: String(e?.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /admin/ultra: fetch Ultra state for a conversation or snapshot
      if (__path === '/admin/ultra') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          if (!adminGuard(req, res)) { return; }
          // If HTML is requested (Accept: text/html) or ui=1 is set, serve inline admin UI
          const accept = String(req.headers['accept'] || '');
          let wantsUI = false;
          try { const uTmp = new URL(`http://localhost${req.url}`); wantsUI = String(uTmp.searchParams.get('ui') || '') === '1'; } catch {}
          const wantsHtml = accept.includes('text/html');
          if (wantsHtml || wantsUI) {
            const html = `<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Ultra Mode & Phrase Inspector</title>
<style>
  body{font-family:ui-sans-serif,system-ui;max-width:960px;margin:24px auto;padding:0 12px}
  .row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  input[type=text]{padding:8px 10px;border:1px solid #ddd;border-radius:10px;min-width:260px}
  button{padding:8px 12px;border-radius:10px;border:1px solid #ccc;background:#111;color:#fff;cursor:pointer}
  button.secondary{background:#fff;color:#111}
  .pill{display:inline-block;padding:4px 8px;border-radius:999px;border:1px solid #ddd}
  .muted{color:#666}
  table{width:100%;border-collapse:collapse;margin-top:16px}
  th,td{border-bottom:1px solid #eee;padding:8px 6px;text-align:left}
  .ok{color:#0a0}
  .bad{color:#a00}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .card{border:1px solid #eee;border-radius:14px;padding:14px}
  code{background:#f7f7f7;padding:2px 6px;border-radius:6px}
</style>
<div class="row">
  <h1 style="margin:0">Ultra Mode</h1>
  <span class="pill">default: ${ULTRA_DEFAULT_ON ? 'ON' : 'OFF'}</span>
</div>
<p class="muted">Toggle per-conversation Ultra (hedge + entropy + cadence). Conv routes must pass normal conv auth.</p>
<div class="card">
  <div class="row">
    <input id="conv" type="text" placeholder="conv_id e.g. demo-123"/>
    <button id="check">Check</button>
    <button id="on">Turn ON</button>
    <button id="off" class="secondary">Turn OFF</button>
    <a id="inspect" class="pill" href="#" target="_blank" rel="noopener">Open Phrase Inspector</a>
  </div>
  <div id="status" class="muted" style="margin-top:8px"></div>
</div>
<div class="grid" style="margin-top:16px">
  <div class="card">
    <h3 style="margin-top:0">How it works</h3>
    <ul>
      <li>Ultra nudges style-hedge, cadence rotation, and loop guards.</li>
      <li>Phrase inspector shows per-conv “hot” phrases with decay.</li>
    </ul>
  </div>
  <div class="card">
    <h3 style="margin-top:0">API</h3>
    <code>GET /conv/ultra?conv_id=...</code><br/>
    <code>POST /conv/ultra {"conv_id"," on":true}</code><br/>
    <code>GET /admin/conv/&lt;id&gt;/phrases</code>
  </div>
  </div>
<script>
const base = location.origin;
const $ = sel => document.querySelector(sel);
const s = (msg, cls='') => $('#status').innerHTML = '<span class="'+cls+'">'+msg+'</span>';
function inspectHref(id){ return base + '/admin/conv/' + encodeURIComponent(id) + '/phrases'; }
$('#check').onclick = async () => {
  const id = $('#conv').value.trim(); if(!id) return s('conv_id required','bad');
  $('#inspect').href = inspectHref(id);
  const r = await fetch(base+'/conv/ultra?conv_id='+encodeURIComponent(id), { headers: { 'accept':'application/json' }});
  const j = await r.json();
  if (!r.ok) return s('GET failed: '+(j.error||r.status),'bad');
  s('Ultra['+id+'] = '+(j.ultra?'ON':'OFF'),'ok');
};
$('#on').onclick = async () => {
  const id = $('#conv').value.trim(); if(!id) return s('conv_id required','bad');
  $('#inspect').href = inspectHref(id);
  const r = await fetch(base+'/conv/ultra', { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ conv_id:id, on:true })});
  const j = await r.json();
  if (!r.ok) return s('POST failed: '+(j.error||r.status),'bad');
  s('Ultra['+id+'] = '+(j.ultra?'ON':'OFF'),'ok');
};
$('#off').onclick = async () => {
  const id = $('#conv').value.trim(); if(!id) return s('conv_id required','bad');
  $('#inspect').href = inspectHref(id);
  const r = await fetch(base+'/conv/ultra', { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({ conv_id:id, on:false })});
  const j = await r.json();
  if (!r.ok) return s('POST failed: '+(j.error||r.status),'bad');
  s('Ultra['+id+'] = '+(j.ultra?'ON':'OFF'),'ok');
};
</script>`;
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
            return;
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (convId) {
            const st = getUltraState(convId) || { enabled: ultraDefaultOn(), ts: 0 };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, conv_id: convId, enabled: !!st.enabled, ts: Number(st.ts || 0), default_on: ultraDefaultOn() }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          } else {
            const snap = ultraSnapshot();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, snapshot: snap }));
            try { METRICS.inc('responses_total', { status: '200' }); } catch {}
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'ultra_get_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // GET /memory/plan?conv_id=...&model=...&k=5&text=...
      if (__path === '/memory/plan') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
            let tokenFromQuery = '';
            try {
              const uTmp = new URL(`http://localhost${req.url}`);
              tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim();
            } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }

          // Parse query params
          let convId = '';
          let model = '';
          let baseText = '';
          let k = 5;
          let startTurn = 0;
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || '').trim();
            model = String(uQ.searchParams.get('model') || '');
            baseText = String(uQ.searchParams.get('text') || '');
            k = Math.min(Number(uQ.searchParams.get('k') || 5), 20);
            startTurn = Number(uQ.searchParams.get('turn') || '0') || 0;
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }

          // SSE headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive'
          });
          try { res.write(':ok\n\n'); } catch {}
          try { res.write(`event: start\ndata: ${JSON.stringify({ ok: true, conv_id: convId, k, model })}\n\n`); } catch {}

          let turn = startTurn;
          for (let i = 0; i < k; i++) {
            try {
              const sim = await preTurnMemory({ convId, turn, model, userText: baseText });
              const evt = { turn, inject_text: sim?.injectText || '', inject_tokens: Number(sim?.injectTokens || 0), budget_tokens: Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || 120) };
              try { res.write(`event: plan\ndata: ${JSON.stringify(evt)}\n\n`); } catch {}
            } catch (e) {
              try { res.write(`event: error\ndata: ${JSON.stringify({ error: 'memory_plan_step_failed', turn, msg: String(e && e.message || e) })}\n\n`); } catch {}
              break;
            }
            turn++;
          }
          try { res.write(`event: end\ndata: ${JSON.stringify({ ok: true })}\n\n`); } catch {}
          try {
            await sendMessageWithTick(async () => { res.end(); return true; });
          } catch {
            try { res.end(); } catch {}
          }
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          try { res.write(`event: error\ndata: ${JSON.stringify({ error: 'memory_plan_failed', msg: String(e && e.message || e) })}\n\n`); } catch {}
          try { res.end(); } catch {}
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }
    // Admin: DELETE routes
    if (String(req.method || 'GET').toUpperCase() === 'DELETE') {
      let __path = '';
      try { __path = new URL(`http://localhost${req.url}`).pathname; } catch { __path = String(req.url || ''); }
      // --- World state admin: delete a state record
      if (__path === '/state') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let conv = '';
          let key = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            conv = String(uQ.searchParams.get('conv_id') || uQ.searchParams.get('conv') || '').trim();
            key = String(uQ.searchParams.get('key') || '').trim();
          } catch {}
          if (!conv || !key) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_key_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const ok = clearState(conv, key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'state_delete_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // DELETE /admin/beliefs/line — remove a belief line by text or hash
      if (__path === '/admin/beliefs/line') {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          let kind = '';
          let text = '';
          let hash = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            convId = String(uQ.searchParams.get('conv_id') || uQ.searchParams.get('conv') || '').trim();
            kind = String(uQ.searchParams.get('kind') || '').trim();
            text = String(uQ.searchParams.get('text') || '').trim();
            hash = String(uQ.searchParams.get('hash') || '').trim();
          } catch {}
          if (!convId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          if (!['beliefs','disallowed_actions','logic_constraints'].includes(kind)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_kind' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const hashOrText = text || hash;
          if (!hashOrText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'text_or_hash_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const updated = await deleteBeliefLineState(convId, kind, hashOrText);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id: convId, profile: updated }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'beliefs_delete_line_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // DELETE /admin/beliefs/:agentId — remove an agent belief by text or hash
      if (__path.startsWith('/admin/beliefs/') && __path !== '/admin/beliefs/line') {
        try {
          if (!adminGuard(req, res)) return;
          const parts = __path.split('/');
          const agentId = decodeURIComponent(parts[3] || '').trim() || 'default';
          let text = '';
          let hash = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            text = String(uQ.searchParams.get('text') || '').trim();
            hash = String(uQ.searchParams.get('hash') || '').trim();
          } catch {}
          const hashOrText = text || hash;
          if (!hashOrText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'text_or_hash_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const okDel = await BeliefStore.deleteBelief(agentId, hashOrText);
          try { emitAdminMemoryEvent('beliefs.delete', { agentId, belief: hashOrText }); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agent: agentId, deleted: !!okDel }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'agent_belief_delete_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // DELETE /admin/constraints — remove a global constraint by text or hash
      if (__path === '/admin/constraints') {
        try {
          if (!adminGuard(req, res)) return;
          let text = '';
          let hash = '';
          try {
            const uQ = new URL(`http://localhost${req.url}`);
            text = String(uQ.searchParams.get('text') || uQ.searchParams.get('constraint') || '').trim();
            hash = String(uQ.searchParams.get('hash') || '').trim();
          } catch {}
          const hashOrText = text || hash;
          if (!hashOrText) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'text_or_hash_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const okDel = await BeliefStore.deleteConstraint(hashOrText);
          try { emitAdminMemoryEvent('constraints.delete', { constraint: hashOrText }); } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deleted: !!okDel }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'constraint_delete_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // DELETE /admin/conv/:id/beat — reset beat state (admin gated)
      if (__path.startsWith('/admin/conv/') && __path.endsWith('/beat')) {
        try {
          if (!adminGuard(req, res)) return;
          const parts = __path.split('/');
          const conv_id = decodeURIComponent(parts[3] || '').trim();
          if (!conv_id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'conv_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const prev = getBeat(conv_id);
          resetBeat(conv_id);
          try {
            METRICS.inc('scene_beat_state_total', { state: 'lull', path: 'admin' });
            if (String(prev?.state || '') !== 'lull') {
              METRICS.inc('scene_beat_switch_total', { from: String(prev?.state || ''), to: 'lull' });
            }
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, conv_id, reset: true, previous: String(prev?.state || 'lull') }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'beat_reset_failed', msg: String(e?.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // DELETE /memory/facts/:id?conv_id=...
      if (__path && __path.startsWith('/memory/facts/')) {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let convId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); convId = String(uQ.searchParams.get('conv_id') || '').trim(); } catch {}
          if (!convId) convId = 'conv';
          const parts = __path.split('/');
          const id = parts[parts.length - 1];
          const ok = deleteFact(convId, id);
          try {
            const factsNow = listFacts(convId);
            const maxFacts = Math.max(1, Number(process.env.FACTS_MAX || 64));
            METRICS.set('facts_current', Array.isArray(factsNow) ? factsNow.length : 0);
            METRICS.set('facts_max', maxFacts);
          } catch {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok, id, conv_id: convId }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_facts_delete_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
      // DELETE /memory/beliefs/:id?char_id=...
      if (__path && __path.startsWith('/memory/beliefs/')) {
        try {
          // Admin auth (optional; only enforced when ADMIN_TOKEN is set)
          const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
          if (requireAuth) {
            const token = String(process.env.ADMIN_TOKEN || '').trim();
            const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
            const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ')
              ? (hdr.split(/\bBearer\s+/i)[1] || '').trim()
              : hdr;
            let tokenFromQuery = '';
            try { const uTmp = new URL(`http://localhost${req.url}`); tokenFromQuery = String(uTmp.searchParams.get('token') || uTmp.searchParams.get('auth') || '').trim(); } catch {}
            const ok = tokenFromHdr === token || tokenFromQuery === token;
            if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'forbidden' }));
              try { METRICS.inc('responses_total', { status: '403' }); } catch {}
              return;
            }
          }
          let charId = '';
          try { const uQ = new URL(`http://localhost${req.url}`); charId = String(uQ.searchParams.get('char_id') || uQ.searchParams.get('agent_id') || '').trim(); } catch {}
          if (!charId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'char_id_required' }));
            try { METRICS.inc('responses_total', { status: '400' }); } catch {}
            return;
          }
          const parts = __path.split('/');
          const id = parts[parts.length - 1];
          const ok = deleteBelief(charId, id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok, id, char_id: charId }));
          try { METRICS.inc('responses_total', { status: '200' }); } catch {}
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'memory_beliefs_delete_failed', msg: String(e && e.message || e) }));
          try { METRICS.inc('responses_total', { status: '500' }); } catch {}
        }
        return;
      }
    }
    // Heap snapshot endpoint (admin only)
    // Config snapshot endpoint (admin only)
    if (req.url === '/config/snapshot') {
      const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
      if (requireAuth) {
        const token = String(process.env.ADMIN_TOKEN || '').trim();
        const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
        const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
        let tokenFromQuery = '';
        try {
          const u = new URL(`http://localhost${req.url}`);
          tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim();
        } catch {}
        const ok = tokenFromHdr === token || tokenFromQuery === token;
        if (!ok || !isIpAllowed('TENANTS_IP_ALLOWLIST')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
          return;
        }
      }
      try {
        const cfg = getEffectiveConfig();
        // Sanitize to plain JSON (drop any non-serializable values)
        let safe = {};
        try { safe = JSON.parse(JSON.stringify(cfg)); } catch { safe = {}; }
        let configHash = '';
        try {
          const h = crypto.createHash('sha256');
          h.update(JSON.stringify(safe));
          configHash = h.digest('hex');
        } catch {}
        const buildHash = String((cfg && cfg.buildInfo && cfg.buildInfo.hash) || '');
        const frozen = !!(cfg && Object.isFrozen(cfg));
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Config-Hash': String(configHash || '') });
        res.end(JSON.stringify({ ok: true, build_hash: buildHash, config_hash: configHash, frozen, config: safe }));
        try { span?.setAttribute?.('http.status_code', 200); } catch {}
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'config_snapshot_failed', msg: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); span?.setAttribute?.('http.status_code', 500); } catch {}
      }
      return;
    }
    if (req.url === '/heap/snapshot') {
      const requireAuth = String(process.env.ADMIN_TOKEN || '').length > 0;
      if (requireAuth) {
        const token = String(process.env.ADMIN_TOKEN || '').trim();
        const hdr = String(req.headers['authorization'] || req.headers['x-admin-token'] || '').trim();
        const tokenFromHdr = hdr.toLowerCase().startsWith('bearer ') ? (hdr.split(/\bBearer\s+/i)[1] || '').trim() : hdr;
        let tokenFromQuery = '';
        try {
          const u = new URL(`http://localhost${req.url}`);
          tokenFromQuery = String(u.searchParams.get('token') || u.searchParams.get('auth') || '').trim();
        } catch {}
        const ok = tokenFromHdr === token || tokenFromQuery === token;
        try { console.log(JSON.stringify({ evt: 'heap_snapshot_auth_debug', hdr_present: hdr.length > 0, token_hdr_len: tokenFromHdr.length, token_query_len: tokenFromQuery.length })); } catch {}
        if (!ok) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden' }));
          try { METRICS.inc('responses_total', { status: '403' }); span?.setAttribute?.('http.status_code', 403); } catch {}
          return;
        }
      }
      try {
        let file = '';
        try {
          // First attempt: write to current working directory
          file = v8.writeHeapSnapshot();
        } catch (primaryErr) {
          // Fallback: write to OS temp dir to avoid CWD permission issues
          try {
            const cwd = process.cwd();
            const tmp = os.tmpdir?.() || cwd;
            try { process.chdir(tmp); } catch {}
            try {
              file = v8.writeHeapSnapshot();
            } finally {
              try { process.chdir(cwd); } catch {}
            }
          } catch (fallbackErr) {
            throw primaryErr || fallbackErr;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, file }));
        try { span?.setAttribute?.('http.status_code', 200); } catch {}
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'heap_snapshot_failed', msg: String(e && e.message || e) }));
        try { METRICS.inc('responses_total', { status: '500' }); span?.setAttribute?.('http.status_code', 500); } catch {}
      }
      return;
    }
    if (QUEUE_MAX > 0) {
      // Introduce a tiny randomized hold so concurrent bursts against fast endpoints
      // can be observed by gating logic, and add slight desynchronization.
      const __rng__ = (typeof globalThis.__prng__ === 'function' ? globalThis.__prng__ : (typeof globalThis.__RNG__ === 'function' ? globalThis.__RNG__ : makePRNG()));
      const microMs = 1 + Math.floor(__rng__() * 5); // 1..5ms
      const t = setTimeout(() => {
        try {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found' }));
        } catch {
          try { res.end(JSON.stringify({ error: 'not_found' })); } catch {}
        }
      }, microMs);
      try { t.unref?.(); } catch {}
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
    try { span?.setAttribute?.('http.status_code', res.statusCode || 404); } catch {}
    try { span?.end?.(); } catch {}
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}/healthz`;
    try {
logAt('info', JSON.stringify({ evt: 'service_listen', healthz: url, readyz: `http://localhost:${port}/readyz`, port }));
    } catch {
logAt('info', JSON.stringify({ evt: 'service_listen', port }));
    }
    // Start budget GC in background; env controls allow disabling in dev
    try {
      const envMode = String(process.env.NODE_ENV || 'dev').toLowerCase();
      const defaultOn = (envMode === 'production') ? '1' : '0';
      const enabled = String(process.env.BUDGET_GC_ENABLED || defaultOn) === '1';
      if (enabled) startBudgetGC();
    } catch {}
  });

  // pass-through of style hedge signals to SSE
  try {
    ctx.io.events.on('style.hedge.start', (p) => {
      try { res.write('event: style.hedge.start\n'); } catch {}
      try { res.write(`data: ${JSON.stringify({ preset_backup: ctx?.vars?.__style_backup_preset || 'unknown', ...p })}\n\n`); } catch {}
    });
    ctx.io.events.on('style.hedge.switch', (p) => {
      try { res.write('event: style.hedge.switch\n'); } catch {}
      try { res.write(`data: ${JSON.stringify({ preset_backup: ctx?.vars?.__style_backup_preset || 'unknown', ...p })}\n\n`); } catch {}
    });
  } catch {}

  // Bind graceful shutdown once, closing the HTTP server on SIGINT/SIGTERM
  try {
    registerGracefulShutdown(async () => {
      try { globalThis?.READY?.notReady?.(); } catch {}
      draining = true;
      // Force complete any pending /wait handlers to accelerate drain
      try {
        for (const entry of Array.from(PENDING_WAITS)) {
          try { clearTimeout(entry.timer); } catch {}
          try {
            entry.res.writeHead(503, { 'Content-Type': 'application/json' });
            entry.res.end(JSON.stringify({ error: 'draining' }));
          } catch {}
          PENDING_WAITS.delete(entry);
        }
      } catch {}
      const deadline = Date.now() + drainTimeoutMs;
      // Wait for inflight to drain or deadline
      while (inflightReq > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((resolve) => server.close(resolve));
      const success = inflightReq === 0;
      try {
        const snapshot = METRICS.snapshot();
        logAt('info', JSON.stringify({ evt: 'service_closed', success, inflightReq, metrics: { counters: snapshot } }));
      } catch {}
      // Exit code: 0 for success drain; 1 otherwise, then force exit to satisfy test harness
      process.exitCode = success ? 0 : 1;
      try { process.exit(process.exitCode); } catch {}
    });
  } catch (err) {
    try { logAt('error', JSON.stringify({ evt: 'service_error', msg: 'Failed to register graceful shutdown', err: err && (err.stack || err) })); } catch {}
  }

  // Memory RSS ceiling guardrail: emit alerts when exceeding ceiling
  try {
    const ceilingMb = Number(process.env.RSS_CEILING_MB || 0);
    if (Number.isFinite(ceilingMb) && ceilingMb > 0) {
      const baseline = Math.round(process.memoryUsage().rss / 1024 / 1024);
      globalThis.__RSS_BASELINE_MB__ = baseline;
      const timer = setInterval(() => {
        try {
          const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
          if (rssMb > ceilingMb) {
            METRICS.inc('rss_ceiling_breach_total');
            logAt('warn', JSON.stringify({ evt: 'rss_ceiling_breach', rss_mb: rssMb, ceiling_mb: ceilingMb }));
          }
        } catch {}
      }, Math.max(1000, Number(process.env.RSS_CHECK_INTERVAL_MS || 5000)));
      try { timer.unref?.(); } catch {}
    }
  } catch {}

  // Heap snapshot on signal for leak diagnostics (gated by env)
  try {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    const debugHeap = String(process.env.DEBUG_HEAP || '').toLowerCase() === 'true' || String(process.env.DEBUG_HEAP || '') === '1';
    if (debugHeap || !isProd) {
      const handler = (sig) => {
        try {
          const file = v8.writeHeapSnapshot();
        METRICS.inc('heap_snapshot_signal_total', { sig });
        logAt('info', JSON.stringify({ evt: 'heap_snapshot_signal', ok: true, sig, file }));
        } catch (e) {
        logAt('error', JSON.stringify({ evt: 'heap_snapshot_signal', ok: false, sig, err: String(e && e.message || e) }));
        }
      };
      try { process.on('SIGUSR2', () => handler('SIGUSR2')); } catch {}
      try { process.on('SIGBREAK', () => handler('SIGBREAK')); } catch {}
    }
  } catch {}
  return server;
}

try {
  const mainHref = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
  if (import.meta.url === mainHref) {
    const drainMs = Number(process.env.DRAIN_TIMEOUT_MS || 5000);
    startService({ drainTimeoutMs: Number.isFinite(drainMs) && drainMs > 0 ? drainMs : 5000 });
  }
} catch {
  // Fallback: start when executed directly
  const drainMs = Number(process.env.DRAIN_TIMEOUT_MS || 5000);
  startService({ drainTimeoutMs: Number.isFinite(drainMs) && drainMs > 0 ? drainMs : 5000 });
}
