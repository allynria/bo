import { listState } from './world_state_store.mjs';

const MAX = Number(process.env.WATCHDOG_MAX_HINTS || 2);
const CD = Number(process.env.WATCHDOG_COOLDOWN_MS || 10 * 60 * 1000);
const LOOKBACK = Number(process.env.WATCHDOG_LOOKBACK_TURNS || 24);

// convId -> Map(fingerprint -> lastTs)
const LAST = new Map();
function oncePerCooldown(convId, fp) {
  if (!CD) return true;
  if (!LAST.has(convId)) LAST.set(convId, new Map());
  const m = LAST.get(convId);
  const t = m.get(fp) || 0;
  const ok = Date.now() - t >= CD;
  if (ok) m.set(fp, Date.now());
  return ok;
}

function simpleNegationPair(u, key, val) {
  // very shallow “impossible” patterns with noun coupling to reduce false positives
  const t = String(u || '').toLowerCase();
  const k = String(key || '').toLowerCase();

  // helper: synonyms for locked/openable objects
  const SYNS = {
    door: ['door', 'doors'],
    gate: ['gate', 'gates'],
    hatch: ['hatch', 'hatches'],
    chest: ['chest', 'chests'],
    safe: ['safe', 'safes', 'vault', 'vaults'],
    locker: ['locker', 'lockers'],
  };
  const nouns = SYNS[k] || [k];
  const nounHit = nouns.some((n) => t.includes(n));

  // unlocking phrases – if present, do not flag a contradiction
  const UNLOCK_OK =
    /(unlock|use (the )?key|pick (the )?lock|lockpick|jimmy|force (it|open)|break (the )?lock)/;

  if (val === 'locked') {
    if (!nounHit) return false; // require noun overlap with the state key
    const actionPhrases = [
      'open',
      'push',
      'pull',
      'swing',
      'slide',
      'pry',
      'walk through',
      'go through',
      'step through',
      'pass through',
      'enter',
    ];
    const hasAction = actionPhrases.some((p) => t.includes(p));
    const mentionsOpenObject = nouns.some(
      (n) =>
        t.includes(`open the ${n}`) ||
        t.includes(`open ${n}`) ||
        t.includes(`push the ${n} open`) ||
        t.includes(`pull the ${n} open`) ||
        t.includes(`swing the ${n}`) ||
        t.includes(`slide the ${n} open`) ||
        t.includes(`pry the ${n} open`) ||
        t.includes(`walk through the ${n}`) ||
        t.includes(`go through the ${n}`) ||
        t.includes(`step through the ${n}`) ||
        t.includes(`pass through the ${n}`)
    );
    if ((hasAction || mentionsOpenObject) && !UNLOCK_OK.test(t)) return true;
  }

  if (val === 'dead' && /\b(talks|stands|returns|breathes|alive)\b/.test(t)) return true;
  if (val === 'broken' && /\b(use|works|perfect)\b/.test(t)) return true;
  if (val === 'destroyed' && /\b(see|use|intact)\b/.test(t)) return true;
  if (val === 'missing' && /\b(holding|has|in pocket)\b/.test(t)) return true;
  return false;
}

export function runWatchdog({ convId, userText }) {
  if (!process.env.WATCHDOG_ENABLED) return { hints: [], flags: [] };
  const HARD = String(process.env.WATCHDOG_HARD_RULES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const states = listState(convId);
  if (!states.length || !userText) return { hints: [], flags: [] };

  const flags = [];
  for (const s of states) {
    if (HARD.includes(s.value) && simpleNegationPair(userText, s.key, s.value)) {
      flags.push({ key: s.key, value: s.value, severity: 'hard' });
    } else {
      // soft contradiction: verb phrase vs noun phrase overlap (cheap heuristic)
      const kt = s.key.toLowerCase();
      if (
        userText.toLowerCase().includes(kt) &&
        /undo|ignore|as if|retcon/.test(userText.toLowerCase())
      ) {
        flags.push({ key: s.key, value: s.value, severity: 'soft' });
      }
    }
  }

  const unique = [];
  for (const f of flags) {
    const fp = `${f.key}:${f.value}:${f.severity}`;
    if (oncePerCooldown(convId, fp)) unique.push(f);
  }

  const picked = unique.slice(0, MAX);
  const hints = picked.map((f) => ({
    type: 'contradiction',
    key: f.key,
    value: f.value,
    text: `(That doesn't align with what just happened: ${f.key} is ${f.value}.)`,
    severity: f.severity,
  }));

  return { hints, flags: picked };
}
