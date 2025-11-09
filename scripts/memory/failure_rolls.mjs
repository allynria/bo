import * as crypto from 'node:crypto';

export function extractRiskHints(userText) {
  const s = String(userText || '').toLowerCase();
  const hints = [];
  const patterns = [
    [/\bpickpocket\b/g, 'pickpocket'],
    [/(pick\s*(the)?\s*lock|lock\s*pick|lockpick)/g, 'lockpick'],
    [/\bsneak\b/g, 'sneak'],
    [/\bsteal\b/g, 'steal'],
    [/\bclimb\b/g, 'climb'],
    [/\bjump\b/g, 'jump'],
    [/\brun\b/g, 'run'],
    [/\bdash\b/g, 'dash'],
    [/\battack\b/g, 'attack'],
    [/\bdodge\b/g, 'dodge'],
    [/\bparry\b/g, 'parry'],
    [/\bgrapple\b/g, 'grapple'],
    [/\bhack\b/g, 'hack'],
    [/\bbluff\b/g, 'bluff'],
    [/\bintimidat(e|ion|ing)?\b/g, 'intimidate'],
    [/\bcharm\b/g, 'charm'],
    [/\bshoot\b/g, 'shoot'],
  ];
  for (const [re, tag] of patterns) {
    if (re.test(s)) hints.push(tag);
  }
  return hints;
}

export function computeRiskScore(params, cfg = {}) {
  const basePct = Number(cfg.FAILURE_BASE_PCT ?? 35);
  const noisePct = Number(cfg.FAILURE_NOISE_PCT ?? 0);
  const trust = Number(params?.spine?.trust ?? 0.5);
  const suspicion = Number(params?.spine?.suspicion ?? 0.0);
  const tension = Number(params?.world?.tension ?? 0.5);
  const beliefsHit = Boolean(params?.beliefsHit);
  const hints = Array.isArray(params?.riskHints) ? params.riskHints : [];

  const hintBonus = Math.min(20, hints.length * 5);
  const beliefBonus = beliefsHit ? 10 : 0;
  const trustTerm = (0.5 - Math.max(0, Math.min(1, trust))) * 40;
  const suspicionTerm = Math.max(0, Math.min(1, suspicion)) * 30;
  const tensionTerm = Math.max(0, Math.min(1, tension)) * 20;

  const noiseTerm = noisePct ? noisePct * (hash01(String(params?.userText || '')) - 0.5) * 2 : 0;

  const score =
    basePct + hintBonus + beliefBonus + trustTerm + suspicionTerm + tensionTerm + noiseTerm;
  return Math.max(1, Math.min(99, Math.round(score)));
}

export function decideRoll(thresholdPct, seed) {
  const threshold = Math.max(1, Math.min(99, Math.round(Number(thresholdPct || 50))));
  const r01 = hash01(String(seed || ''));
  const roll = Math.max(1, Math.min(100, Math.ceil(r01 * 100)));
  const success = roll > threshold; // fail on roll ≤ threshold
  return { roll, threshold, outcome: success ? 'success' : 'fail' };
}

function hash01(s) {
  const h = crypto.createHash('sha256').update(s).digest('hex');
  const n = parseInt(h.slice(0, 8), 16) >>> 0;
  return (n % 10000) / 10000;
}
