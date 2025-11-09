// scripts/memory/constraint_critic.mjs
/**
 * Zero-latency rule critic with optional tiny-LLM fallback.
 * Returns { violated:boolean, reason:string, rule:string, class:'logic'|'ethic'|'world' }
 */

const RULES = [
  // Physics/world basics
  { re: /(jump|fall|leap).*(cliff|tower|roof).*(unharmed|no (?:harm|damage)|land safely)/i, class:'world', reason:'gravity_exists' },
  { re: /(walk|phase|pass).*(through|thru).*(wall|locked door)/i, class:'world', reason:'solid_barriers' },
  // Resurrection/world rules
  { re: /(resurrect|revive|bring back).*(dead|corpse)/i, class:'world', reason:'no_resurrection_magic' },
  // Ethical constraints (character agency, soft refusal path too)
  { re: /(kill|harm).*(child|innocent)/i, class:'ethic', reason:'harm_innocent' },
  { re: /(betray|lie to).*(king|friend|ally)/i, class:'ethic', reason:'betrayal' },
];

export async function constraintCritic({ text, beliefsHit = false }, opts = {}) {
  const enabled = (process.env.CONSTRAINT_CRITIC_ENABLED === '1');
  if (!enabled) return { violated:false };

  // Rule pass first
  for (const r of RULES) {
    if (r.re.test(text)) {
      return { violated:true, reason:r.reason, rule:String(r.re), class:r.class, via:'rules' };
    }
  }

  // If beliefs already hit, treat as a soft violation (lets Failure Rolls nudge up)
  if (beliefsHit && process.env.CRITIC_TREAT_BELIEFS_AS_VIOLATION === '1') {
    return { violated:true, reason:'belief_conflict', rule:'beliefs', class:'world', via:'beliefs' };
  }

  // Optional tiny LLM critic (very small budget)
  const useLLM = (process.env.CRITIC_USE_LLM === '1');
  if (useLLM && opts.callLLM) {
    try {
      const { ok, verdict, tag } = await opts.callLLM(text, {
        timeoutMs: Number(process.env.CRITIC_TIMEOUT_MS || 600),
        maxTokens: Number(process.env.CRITIC_MAX_TOKENS || 64),
      });
      if (ok && verdict === 'violation') {
        return { violated:true, reason: tag || 'llm_flag', rule:'critic_llm', class:'world', via:'llm' };
      }
    } catch { /* swallow */ }
  }
  return { violated:false };
}

