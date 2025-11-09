/**
 * Memory broker: pre-turn injection + post-turn storage with token budget guard.
 */
import { TokenCounter, SafeText, sampled } from '../../monolith.js';
import { selectWithDiversity } from './selector.mjs';
import { loadFacets, pickFacets, facetToNarrative } from './facets.mjs';
import { shadowSnapshot } from './shadow.mjs';
import {
  initMemoryStore,
  getSTR,
  setSTR,
  getEF,
  pushEF,
  getCF,
  upsertCF,
  cheapHash,
} from './store.mjs';
import { labelExchange } from './labeler.mjs';
import {
  buildRecapLine,
  pickEpisodicCue,
  renderEpisodicCue,
  renderFacetEcho,
} from './injectors.mjs';
import { craftBeliefBoosters } from './belief_enforcer.mjs';

const env = (k, d) => process.env[k] ?? d;

const ENABLED = env('MEMORY_ENABLED', '1') !== '0';
const SUMM_EVERY = Number(env('MEMORY_STR_SUMMARIZE_EVERY', 4));
const INJECT_BUDGET = Number(env('MEMORY_INJECT_BUDGET_TOKENS', 120));
const MIN_IMPORTANCE = Number(env('MEMORY_MIN_IMPORTANCE', 0.6));
const ECHO_PROB = Number(env('MEMORY_ECHO_PROB_PCT', 35));

function randPct() {
  const r = globalThis.__RNG__ ? globalThis.__RNG__() : Math.random();
  return r * 100;
}

export async function preTurnMemory({ convId, turn, model, userText }) {
  if (!ENABLED) return { injectText: '' };
  await initMemoryStore();

  const [str, ef, cf] = await Promise.all([getSTR(convId), getEF(convId), getCF(convId)]);
  const snippets = [];

  // A) Short recap line (if present)
  if (str?.recap) snippets.push(buildRecapLine(str.recap));

  // B) Episodic cue (one)
  const cue = renderEpisodicCue(pickEpisodicCue(ef));
  if (cue) snippets.push(cue);

  // C) Merge STR/EF/CF into snippet candidates with recency decay + diversity selection
  const HALF = Number(process.env.MEMORY_EF_DECAY_HALF_LIFE_TURNS || 24);
  function decayScore(imp, age) {
    if (!HALF || HALF <= 0) return imp || 0;
    const k = Math.pow(0.5, Math.max(0, age) / HALF);
    return (imp || 0) * k;
  }
  if (ef?.items?.length) {
    const T = Number(process.env.MEMORY_EF_TEMPERATURE || 0.7);
    const L = Number(process.env.MEMORY_EF_LAMBDA || 0.75); // alpha
    const K = Math.max(1, Math.min(16, Number(process.env.MEMORY_EF_TOP_K || 8)));
    const nowTurn = turn || 0;
    const candidates = ef.items.map((it) => ({
      ...it,
      // recency decayed importance
      imp2: decayScore(it.imp || 1, Math.max(0, nowTurn - (it.turn || 0))),
      rec: 0, // already absorbed in imp2
    }));
    const picked = selectWithDiversity(candidates, {
      k: K,
      importance: (it) => it.imp2,
      recency: () => 0,
      alpha: L,
      temperature: T,
      simFn: (a, b) => {
        // prefer diversity on textual memory; fall back to 0 when missing
        if (!a?.txt || !b?.txt) return 0;
        const A = (a.txt + '').toLowerCase(),
          B = (b.txt + '').toLowerCase();
        const aSet = new Set(A.match(/[a-z0-9]+/g) || []);
        const bSet = new Set(B.match(/[a-z0-9]+/g) || []);
        if (!aSet.size && !bSet.size) return 0;
        let inter = 0;
        for (const x of aSet) if (bSet.has(x)) inter++;
        return inter / (aSet.size + bSet.size - inter || 1);
      },
    });
    for (const it of picked) {
      const who = SafeText.stripDangerous(String(it.who || 'they'));
      const txtBase = SafeText.stripDangerous(String(it.txt || ''));
      const txt = SafeText.clamp(
        txtBase,
        Math.max(40, Math.min(160, Number(process.env.MEMORY_EF_SNIPPET_MAX_CHARS || 120)))
      );
      if (txt.length < txtBase.length)
        sampled('debug', 0.02, '[broker] EF snippet truncated/sanitized');
      snippets.push(`(${who} remembered: ${txt})`);
    }
  }

  // D) Facet echo (sample first character if any)
  const firstChar = Object.keys(cf?.chars || {})[0];
  const facet = firstChar ? cf.chars[firstChar] : null;
  const echoAllowed = randPct() < ECHO_PROB;
  if (echoAllowed) {
    const echo = renderFacetEcho(facet);
    if (echo) snippets.push(echo);
  }

  // --- Facets activation (mini-persona memory) ---
  try {
    const enable = String(process.env.FACETS_ENABLED || '1') === '1';
    if (enable) {
      const frac = Math.max(0, Math.min(1, Number(process.env.FACETS_BUDGET_FRACTION || 0.35)));
      const k = Math.max(0, Math.min(4, Number(process.env.FACETS_TOP_K || 2)));
      const T = Number(process.env.FACETS_TEMPERATURE || 0.7);
      const L = Number(process.env.FACETS_LAMBDA || 0.75);
      const half = Number(process.env.FACETS_DECAY_HALF_LIFE_TURNS || 64);
      const who = process.env.FACETS_WHO || 'they';
      // Budget coordination with the caller: rely on MEMORY_INJECT_BUDGET_TOKENS env (read up in service)
      const totalBudget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || 120);
      const facetBudget = Math.floor(totalBudget * frac);
      // Load and pick
      const store = await loadFacets(convId);
      const charId = process.env.FACETS_CHAR_ID || 'bot';
      const list = store.characters?.[charId] || [];
      if (list.length) {
        const chosen = pickFacets({
          list,
          nowTurn: turn || 0,
          k,
          temperature: T,
          alpha: L,
          halfLife: half,
        });
        // Synthesize narrative lines (roughly ~10–16 tokens each)
        const lines = [];
        for (const f of chosen) {
          const line = facetToNarrative(f, who);
          if (line) lines.push(line);
          // stop if we think we hit budget; very rough token estimate: ~1 token per 4 chars
          const approxTokens = Math.floor(lines.join(' ').length / 4);
          if (approxTokens >= facetBudget) break;
        }
        // Put facets near the top but under any dream fragment so it reads like reflection -> memory
        if (lines.length) snippets.splice(1, 0, ...lines);
      }
    }
  } catch {}

  // --- Shadow nudges (if last turn had mismatches) ---
  try {
    const SHADOW = String(process.env.SHADOW_ENABLED || '1') === '1';
    if (SHADOW) {
      const budget = Number(process.env.MEMORY_INJECT_BUDGET_TOKENS || 120);
      const share = Math.max(0, Math.min(1, Number(process.env.SHADOW_RECAP_FRACTION || 0.4)));
      const allow = Math.floor(budget * share);
      const snap = await shadowSnapshot(convId);
      const mm = snap?.mismatches || [];
      if (Array.isArray(mm) && mm.length) {
        const limit = Math.max(1, Number(process.env.SHADOW_NUDGE_LIMIT || 2));
        const lines = (snap.__last_nudges || []).slice(0, limit).filter(Boolean);
        const approx = Math.floor(lines.join(' ').length / 4);
        if (lines.length && approx <= allow) {
          snippets.unshift(...lines);
        }
      }
    }
  } catch {}

  // --- Belief boosters (exactly-once per cooldown) ---
  try {
    const charId = process.env.FACETS_CHAR_ID || 'default';
    const { boosters } = craftBeliefBoosters({ convId, charId, userText });
    if (Array.isArray(boosters) && boosters.length) {
      for (const b of boosters) {
        const t = String(b?.text || '').trim();
        if (t) snippets.push(t);
      }
    }
  } catch {}

  // Hard token budget
  const encoderModel = model || 'o200k_base';
  let out = '';
  let injectTokens = 0;
  for (const s of snippets) {
    if (!s) continue;
    const candidate = (out ? out + '\n' : '') + s;
    const n = TokenCounter.estimate(candidate, { model: encoderModel });
    if (n <= INJECT_BUDGET) {
      out = candidate;
      injectTokens = n;
    } else break;
  }

  return { injectText: out, injectTokens };
}

export async function postTurnMemory({ convId, turn, model, userText, assistantText }) {
  if (!ENABLED) return { ok: true };

  await initMemoryStore();

  // Label the exchange
  const { type, importance } = labelExchange(userText, assistantText);

  // Every N turns, produce/update STR recap (very small)
  if (turn % SUMM_EVERY === 0) {
    // naive: pick the most recent EF cue + last line of assistant as recap
    const ef = await getEF(convId);
    const cue = pickEpisodicCue(ef);
    const lastLine =
      String(assistantText || '')
        .trim()
        .split('\n')
        .slice(-1)[0]
        ?.trim() || '';
    const recapBase = [cue ? renderEpisodicCue(cue) : '', lastLine].filter(Boolean).join(' ');
    const recap = SafeText.clamp(SafeText.stripDangerous(recapBase), 200); // keep it tiny
    await setSTR(convId, recap, [Math.max(0, turn - SUMM_EVERY + 1), turn]);
  }

  // If important, store EF (track kept/pruned by diff)
  let efKept = 0,
    efPruned = 0;
  const before = await getEF(convId);
  if (type && importance >= MIN_IMPORTANCE) {
    await pushEF(convId, {
      t: type,
      who: 'user',
      txt: extractEFText(userText, assistantText),
      imp: importance,
      turn,
    });
  }
  const after = await getEF(convId);
  efKept = after.items?.length || 0;
  const expected = Math.min(
    (before.items?.length || 0) + (type && importance >= MIN_IMPORTANCE ? 1 : 0),
    Number(process.env.MEMORY_EF_MAX_ITEMS || 64)
  );
  efPruned = Math.max(0, expected - efKept);

  // (Optional) evolve a single facet from assistantText (very naive seed)
  const name = guessFirstCharacterName(assistantText);
  if (name) {
    await upsertCF(convId, name, {
      rel: /warm|gentle|soft/i.test(assistantText) ? 'slowly warming' : undefined,
      key: /saved|rescued|shielded/i.test(assistantText) ? 'nearly died saving her' : undefined,
      fear: /afraid|alone|abandon/i.test(assistantText) ? 'abandonment' : undefined,
    });
  }

  return {
    ok: true,
    label_type: type || null,
    label_importance: importance || 0,
    ef_kept: efKept,
    ef_pruned: efPruned,
  };
}

function extractEFText(userText, assistantText) {
  const u = String(userText || '').trim();
  const a = String(assistantText || '').trim();
  const pick = a || u;
  const base = SafeText.stripDangerous(pick);
  const out = SafeText.clamp(base, 140);
  if (out.length < base.length) sampled('debug', 0.02, '[broker] EF extract truncated/sanitized');
  return out;
}

function guessFirstCharacterName(text = '') {
  // VERY naive: Titlecased token as a "name"
  const m = text.match(/\b([A-Z][a-z]{2,15})\b/);
  return m ? m[1] : null;
}
