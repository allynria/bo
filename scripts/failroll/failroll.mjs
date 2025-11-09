// scripts/failroll/failroll.mjs
import crypto from 'node:crypto';

export function detectRiskIntent(userText, pattern = process.env.FAILROLL_RISK_REGEX) {
  const pat = String(pattern || '').trim();
  let rx = null;
  if (pat) {
    try {
      rx = new RegExp(pat, 'i');
    } catch {
      rx = null;
    }
    return !!(userText && rx && rx.test(String(userText)));
  }
  // Fallback: common risky actions so tests work without FAILROLL_RISK_REGEX
  const fallbackRx =
    /\b(sneak|stealth|slip\s+past|pick\s+the?\s*lock|lockpick|lock\s*pick|lie|deceive|bluff|fabricate|pretend|intimidate|threaten|coerce|charm|steal|pickpocket|snatch|lift|dodge|evade|sidestep|parry|deflect|shoot|fire\b|take\s+(?:an|the)\s*shot|hack|bypass|override|climb|scale\b|ascend|jump\s+(?:the\s*)?gap|leap\s+across)\b/i;
  return !!(userText && fallbackRx.test(String(userText)));
}

export function computeFailProb({ base, trust = 0.5, suspicion = 0.0, tension = 0.0 }) {
  const b = Number(base ?? process.env.FAILROLL_BASE_CHANCE ?? 0.35);
  const tw = Number(process.env.FAILROLL_TRUST_WEIGHT ?? -0.35);
  const sw = Number(process.env.FAILROLL_SUSPICION_WEIGHT ?? 0.3);
  const aw = Number(process.env.FAILROLL_TENSION_WEIGHT ?? 0.2);
  const min = Number(process.env.FAILROLL_MIN ?? 0.05);
  const max = Number(process.env.FAILROLL_MAX ?? 0.9);

  let p = b + tw * trust + sw * suspicion + aw * tension;
  if (Number.isNaN(p)) p = b;
  return Math.min(max, Math.max(min, p));
}

// deterministic-ish per-turn roll (seed on conv + turn + text hash)
export function d100(ctx, { convId, turn, userText }) {
  const seed = `${convId}|${turn}|${String(userText).slice(0, 128)}`;
  const h = crypto.createHash('sha256').update(seed).digest();
  // 0..255 -> 0..1
  const r = h[0] / 255;
  return Math.floor(r * 100) + 1; // 1..100
}

export function buildOutcomeBooster({
  style = 'diegetic',
  success,
  verb = 'attempt',
  reason = '',
}) {
  if (style === 'meta') {
    return `(Check: ${verb} → ${success ? 'success' : 'failure'}${reason ? ` — ${reason}` : ''})`;
  }
  // diegetic micro-narration
  if (success) {
    return `(Against the odds, the attempt works—quick, quiet, almost lucky.)`;
  }
  return `(Despite the effort, it slips: a snag, a glance, a breath too loud—the attempt fails.)`;
}
