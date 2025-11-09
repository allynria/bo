// scripts/disagree/core.mjs
import { rulesCritique, llmCritique } from '../critics/constraint_critic.mjs';
import { buildRefusalBooster } from '../state/refusal_templates.mjs';
import { loadSpine, saveSpine } from '../state/character_spine.mjs';

export async function runDisagreementCore(ctx, { convId, userText, beliefLines, contradictionLines }) {
  if (!Number(process.env.CRITIC_ENABLED || '1')) {
    return { lines: [], action: 'none', reasons: [] };
  }

  // Collect evidence from earlier passes
  const reasons = [];
  if (beliefLines?.length)        reasons.push({ code: 'belief',        msg: 'violates established beliefs' });
  if (contradictionLines?.length) reasons.push({ code: 'contradiction', msg: 'conflicts with recent events' });

  // Lightweight rules critic
  const beliefsList = (ctx?.vars?.beliefs_for_core || []);        // OPTIONAL: hydrate from your beliefs_store if handy
  const recentFacts = (ctx?.vars?.recent_facts_for_core || []);   // OPTIONAL: supply from your fact window
  try { reasons.push(...rulesCritique({ userText, beliefs: beliefsList, recentFacts }).reasons); } catch {}

  // Optional micro LLM critic
  try {
    const llm = await llmCritique({ ctx, userText });
    for (const r of llm.reasons) reasons.push(r);
  } catch {}

  // Decide action
  const hasBlock = reasons.length > 0;
  const enforce = String(process.env.DISAGREE_ENFORCE || 'soft');

  let lines = [];
  let action = 'none';

  // Pull spine for tone / thresholds synergy
  let spine = null;
  try { spine = await loadSpine(convId, 'bot'); } catch { spine = { mood: 'neutral', trust: 0.5, suspicion: 0.1 }; }
  const appendWhy = !!Number(process.env.DISAGREE_APPEND_REASON || '1');
  const why = appendWhy && hasBlock ? ` ${reasons[0].msg}.` : '';

  if (hasBlock && enforce === 'hard') {
    const style = (spine.mood === 'hostile' || spine.mood === 'annoyed') ? 'firm'
                : (spine.mood === 'guarded') ? 'guarded'
                : 'soft';
    lines.push(buildRefusalBooster({ character: 'She', style, mood: spine.mood, reason: (appendWhy ? reasons.map(r=>r.msg).join('; ') : undefined) }));
    action = 'refuse';
  } else if (hasBlock) {
    // Soft mode: inject a cautionary continuity nudge that strongly biases refusal, but allows creativity.
    lines.push(`(Continuity check: ${reasons.map(r => r.msg).join('; ')}. Keep the world and character consistent.)`);
    action = 'constrain';
  }

  // Emit metrics & SSE for show-off (optional; safe with optional chaining)
  if (hasBlock) {
    try { for (const r of reasons) ctx?.metrics?.inc?.('disagreement_core_trigger_total', { count: 1, source: r.code || 'other' }); } catch {}
    try { ctx?.io?.events?.emit?.('disagree.core', { action, reasons, mood: spine.mood, trust: spine.trust, suspicion: spine.suspicion }); } catch {}
  }

  // Save spine gently (e.g., raise suspicion a bit when contradiction pressure appears)
  try {
    if (hasBlock && enforce === 'hard') {
      spine.suspicion = Math.min(1, (spine.suspicion ?? 0.1) + 0.02);
      await saveSpine(convId, 'bot', spine);
    }
  } catch {}

  return { lines, action, reasons };
}

