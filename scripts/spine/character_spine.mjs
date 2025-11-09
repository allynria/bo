// Character Spine: derives mood/tone/openness from existing runtime signals
// Safe to call on every turn; returns a compact snapshot + an in-character booster line.

export function computeCharacterSpine(ctx, { userText = '' } = {}) {
  const now = Date.now();
  // ---- Read signals (use whatever exists; fall back gracefully) ----
  const stats = (ctx && ctx.stats) || {};
  // trust: prefer the stable moving average your monolith computes
  const trustMA = clamp01(stats.trustMA ?? stats.trust ?? ctx?.memory?.trustLevel ?? 0.5);
  // suspicion: if you track it (many repos do alongside jailbreak/injection), else derive from low trust
  const suspicionMA = clamp01(stats.suspicionMA ?? stats.suspicion ?? (1 - trustMA) * 0.5);
  // tension: you already surface context.memory.tension for cadence/hallucination ticker
  const tension = clamp01(ctx?.memory?.tension ?? 0.3);
  // continuity breaks (if your contradiction detector writes flags)
  const lastContradictionAt = ctx?.memory?.lastContradictionAt ?? 0;
  const contradictionFresh = now - lastContradictionAt < 15_000; // 15s “fresh” window

  // ---- Map to mood/tone/openness/refusal ----
  const openness = clamp01(trustMA * (1 - 0.6 * suspicionMA));
  const guardedness = clamp01(suspicionMA * (1 - trustMA / 2));
  const refusalLikelihood = clamp01(0.15 + guardedness * 0.65 + (contradictionFresh ? 0.1 : 0));

  // mood buckets by trust/tension
  const mood = (() => {
    if (openness > 0.75 && tension < 0.3) return 'warm';
    if (openness > 0.6 && tension >= 0.3 && tension < 0.6) return 'focused';
    if (tension >= 0.6 && openness >= 0.45) return 'tense';
    if (guardedness > 0.6) return 'wary';
    if (guardedness > 0.4) return 'annoyed';
    return 'neutral';
  })();

  // tone selection (used by style schedulers / LoopGuard rerolls)
  const tone = (() => {
    if (mood === 'warm') return 'warm';
    if (mood === 'focused') return 'descriptive';
    if (mood === 'tense') return 'terse';
    if (mood === 'annoyed') return 'blunt';
    if (mood === 'wary') return 'restrained';
    return 'neutral';
  })();

  // style hint (what our style/cadence scheduler should bias toward)
  const styleHint = (() => {
    if (tone === 'terse' || tone === 'blunt' || tone === 'restrained') return 'terse';
    if (tone === 'warm') return 'poetic';
    if (tone === 'descriptive') return 'descriptive';
    return 'neutral';
  })();

  // ---- Tiny in-character booster (stealth memory prefix) ----
  // Keep it 1 short line; don’t spam per turn—your prompt builder can throttle.
  const boosterLine = buildBoosterLine({ mood, tone, tension, openness });

  // impulses: compact action hints consumed by schedulers/critics without free-form text
  const impulses = [];
  if (refusalLikelihood > 0.6) impulses.push('refusal_bias');
  if (guardedness > 0.5) impulses.push('hedge_early');
  if (styleHint === 'terse') impulses.push('slow_cadence');
  if (tone === 'descriptive' || styleHint === 'poetic') impulses.push('add_detail');
  if (openness > 0.7 && tension < 0.5) impulses.push('expand');

  return {
    mood,
    tone,
    trust: trustMA,
    openness, // 0..1
    refusalLikelihood, // 0..1
    styleHint, // 'terse' | 'poetic' | 'descriptive' | 'neutral'
    boosterLine, // "(She stays guarded…)" etc.
    impulses, // compact action hints for schedulers
  };
}

function buildBoosterLine({ mood, tone, tension, openness }) {
  // Subtle, first-person-adjacent internal hint. Keep it compact; model-agnostic.
  if (tone === 'terse' || mood === 'wary') {
    return '(She keeps her guard up; words come clipped, trust hard-won.)';
  }
  if (mood === 'tense') {
    return '(A taut silence stretches; she chooses each word carefully.)';
  }
  if (mood === 'warm' && openness > 0.75) {
    return '(Warmth lingers at the edges of her voice; memories soften the moment.)';
  }
  if (tone === 'descriptive') {
    return '(Details sharpen: textures, breath, the quiet weight between them.)';
  }
  return ''; // No-op when unsure
}

function clamp01(x) {
  x = Number.isFinite(x) ? x : 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function applySpineToLoopGuard(ctx, spine) {
  // If your loop-guard scheduler exists on ctx.vars.* from earlier patches,
  // bias it with the computed styleHint. Otherwise, no-op.
  try {
    if (!ctx || !ctx.vars) return;
    ctx.vars.spine_style = spine?.styleHint || 'neutral';
    // Optional: tighten retry budget if refusal is likely
    if (typeof ctx.vars.loop_retry_limit === 'number') {
      const cut = spine.refusalLikelihood > 0.6 ? 1 : 0;
      ctx.vars.loop_retry_limit = Math.max(0, ctx.vars.loop_retry_limit - cut);
    }
  } catch {}
}

/**
 * updateFromTurn: fold turn outcomes back into trust/suspicion EMAs.
 * Keeps API compact and side-effect-free aside from ctx.stats / ctx.memory updates.
 */
export function updateFromTurn(
  ctx,
  { accepted = true, refused = false, suspicion = 0, loops = 0, contradiction = false } = {}
) {
  try {
    const stats = (ctx.stats ||= {});
    const alphaRaw = Number(process.env.SPINE_EMA_ALPHA || 0.85);
    const alpha = Number.isFinite(alphaRaw) ? Math.min(0.99, Math.max(0.01, alphaRaw)) : 0.85;
    const baseTrust = clamp01(stats.trustMA ?? stats.trust ?? 0.5);
    const baseSusp = clamp01(stats.suspicionMA ?? stats.suspicion ?? 0.4);
    // signal targets from turn
    const trustTarget = clamp01((accepted ? 0.72 : 0.35) - Math.min(0.2, loops * 0.05));
    const suspTarget = clamp01((refused ? 0.7 : 0.35) + Math.min(0.3, suspicion));
    const trustMA = clamp01(alpha * baseTrust + (1 - alpha) * trustTarget);
    const suspicionMA = clamp01(alpha * baseSusp + (1 - alpha) * suspTarget);
    stats.trustMA = trustMA;
    stats.suspicionMA = suspicionMA;
    if (contradiction) {
      ctx.memory = { ...(ctx.memory || {}), lastContradictionAt: Date.now() };
    }
    return { trustMA, suspicionMA };
  } catch {
    return { trustMA: undefined, suspicionMA: undefined };
  }
}
