// Tiny refusal template renderer.
// Exports:
//   renderRefusal({ style, reason, belief, spine, userText })
//   normalizeStyle(style)
//   defaultStyles

export const defaultStyles = {
  firm: [
    "No. That won't happen.",
    "That goes against what I stand for.",
    "Absolutely not."
  ],
  soft: [
    "I'm sorry, but I can't do that.",
    "I won't go along with that.",
    "I have to refuse."
  ],
  sarcastic: [
    "What do you take me for?",
    "Try again. With reality this time.",
    "Cute. Still no."
  ],
  blunt: [
    "No.",
    "Denied.",
    "Refused."
  ]
};

export function normalizeStyle(style) {
  const s = String(style || '').toLowerCase();
  if (defaultStyles[s]) return s;
  return 'firm';
}

export function renderRefusal({ style, reason, belief, spine, userText }) {
  const tone = normalizeStyle(style);
  const bank = defaultStyles[tone];
  const base = pick(bank);

  const why = reasonLine(reason, belief);
  const mood = spineLine(spine);

  // In-character, short, non-OOC. Keep it tight to avoid bloat.
  // Parenthetical booster for memoryPrefix (stealth).
  const line = [
    base,
    why ? ` ${why}` : '',
    mood ? ` ${mood}` : ''
  ].join('').trim();
  return `(${line})`;
}

function reasonLine(reason, belief) {
  const r = String(reason || '').toLowerCase();
  if (r === 'belief_conflict' && belief?.text) {
    return `It conflicts with a truth she holds: ${belief.text}.`;
  }
  if (r === 'logic_violation') {
    return `It doesn't make sense given what's already true.`;
  }
  if (r === 'moral_constraint') {
    return `It's against her principles.`;
  }
  if (r === 'low_trust') {
    return `She doesn't trust the intent behind it.`;
  }
  return '';
}

function spineLine(spine) {
  if (!spine) return '';
  const mood = spine.mood || 'neutral';
  if (mood === 'annoyed' || mood === 'irritated') return "She's still irritated.";
  if (mood === 'guarded') return "She's guarded.";
  if (mood === 'hurt') return "She's still hurt.";
  return '';
}

import { rng } from '../../monolith.js';

function pick(arr) {
  return arr[Math.floor(rng() * arr.length)] || arr[0] || '';
}
