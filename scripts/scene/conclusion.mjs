// ESM module
// Scene Conclusion Trigger - lightweight heuristic driven by loop/novelty signals.
// Public API:
//  - updateStats(convId, { entropy, deltaSim, embedSim, newEntitiesDetected })
//  - maybeStageConclusion(convId, { now, style? }) -> { staged:boolean, reason, booster, style, score, coolUntilTurn }
//  - snapshot(convId)
//  - force(convId, style?) -> staged payload (bypasses heuristics, respects minimal cooldown of 1 turn)

const _S = new Map(); // convId -> state

const envBool = (k, d) => (process.env[k] ?? (d ? '1' : '0')) === '1';
const envNum = (k, d) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};
const envStr = (k, d) => String(process.env[k] ?? d);

export const CONCLUDE_ENABLED = envBool('CONCLUDE_ENABLED', true);
export const CONCLUDE_MIN_TURNS = envNum('CONCLUDE_MIN_TURNS', 6);
export const CONCLUDE_MIN_TIME_MS = envNum('CONCLUDE_MIN_TIME_MS', 60_000);
export const CONCLUDE_LOW_ENTROPY_TURNS = envNum('CONCLUDE_LOW_ENTROPY_TURNS', 3);
export const CONCLUDE_HIGH_SIM_TURNS = envNum('CONCLUDE_HIGH_SIM_TURNS', 3);
export const CONCLUDE_NO_NEW_ENT_TURNS = envNum('CONCLUDE_NO_NEW_ENTITIES_TURNS', 3);
export const CONCLUDE_COOLDOWN_TURNS = envNum('CONCLUDE_COOLDOWN_TURNS', 4);
export const CONCLUDE_STYLE = envStr('CONCLUDE_STYLE', 'fade'); // fade|cut|bookmark

function get(convId) {
  if (!_S.has(convId)) {
    _S.set(convId, {
      turn: 0,
      startedAt: Date.now(),
      lastSceneStart: Date.now(),
      // rolling streaks
      lowEntropyStreak: 0,
      highSimStreak: 0,
      noNewEntityStreak: 0,
      // last observed
      lastEntropy: null,
      lastDeltaSim: null,
      lastEmbedSim: null,
      lastNewEntitiesTs: Date.now(),
      // control
      lastStagedTurn: -999,
      coolUntilTurn: -1,
      lastReason: '',
      lastStyle: CONCLUDE_STYLE,
      lastScore: 0,
    });
  }
  return _S.get(convId);
}

export function updateStats(convId, { entropy, deltaSim, embedSim, newEntitiesDetected }) {
  const s = get(convId);
  s.turn += 1;
  if (entropy != null) s.lastEntropy = entropy;
  if (deltaSim != null) s.lastDeltaSim = deltaSim;
  if (embedSim != null) s.lastEmbedSim = embedSim;

  // Heuristics
  const LOW_ENTROPY = entropy != null && entropy < (Number(process.env.LOOP_ENTROPY_MIN) || 2.1);
  const HIGH_SIM =
    (deltaSim ?? 0) > (Number(process.env.LOOP_DELTA_SIM_THRESHOLD) || 0.68) ||
    (embedSim ?? 0) > (Number(process.env.LOOP_EMBED_SIM_MAX) || 0.91);

  if (LOW_ENTROPY) s.lowEntropyStreak++;
  else s.lowEntropyStreak = 0;
  if (HIGH_SIM) s.highSimStreak++;
  else s.highSimStreak = 0;

  if (newEntitiesDetected) {
    s.lastNewEntitiesTs = Date.now();
    s.noNewEntityStreak = 0;
  } else {
    s.noNewEntityStreak++;
  }

  return s;
}

function makeBooster(style) {
  // Keep it small and classy. Not OOC—just a gentle narrative director’s note.
  if (style === 'cut') {
    return '(The moment crests; cut on a meaningful beat. Resolve a small thread in one tight paragraph, then pivot with a clear new hook.)';
  } else if (style === 'bookmark') {
    return '(They acknowledge the lull and bookmark this scene with a quiet detail. Conclude gracefully, then seed one fresh direction.)';
  }
  // default: fade
  return '(The scene has run long. Close with a subtle, evocative beat—one paragraph that resolves the current mood, then hint at the next scene.)';
}

export function maybeStageConclusion(convId, { now = Date.now(), style } = {}) {
  const s = get(convId);
  if (!CONCLUDE_ENABLED) return { staged: false, reason: 'disabled' };
  if (s.turn < CONCLUDE_MIN_TURNS) return { staged: false, reason: 'warmup' };
  if (now - s.lastSceneStart < CONCLUDE_MIN_TIME_MS) return { staged: false, reason: 'too_soon' };
  if (s.turn <= s.coolUntilTurn) return { staged: false, reason: 'cooldown' };

  const lowEntropyOK = s.lowEntropyStreak >= CONCLUDE_LOW_ENTROPY_TURNS;
  const highSimOK = s.highSimStreak >= CONCLUDE_HIGH_SIM_TURNS;
  const noNewEntOK = s.noNewEntityStreak >= CONCLUDE_NO_NEW_ENT_TURNS;

  const signals = [lowEntropyOK ? 1 : 0, highSimOK ? 1 : 0, noNewEntOK ? 1 : 0];
  const score = signals.reduce((a, b) => a + b, 0);
  if (score < 2) return { staged: false, reason: 'weak_signals', score };

  const chosenStyle = style || CONCLUDE_STYLE;
  const booster = makeBooster(chosenStyle);
  s.lastStagedTurn = s.turn;
  s.coolUntilTurn = s.turn + CONCLUDE_COOLDOWN_TURNS;
  s.lastReason = `lowEntropy:${s.lowEntropyStreak}, highSim:${s.highSimStreak}, noNew:${s.noNewEntityStreak}`;
  s.lastStyle = chosenStyle;
  s.lastScore = score;

  return {
    staged: true,
    reason: s.lastReason,
    score,
    style: chosenStyle,
    booster,
    coolUntilTurn: s.coolUntilTurn,
  };
}

export function snapshot(convId) {
  const s = get(convId);
  return {
    turn: s.turn,
    startedAt: s.startedAt,
    lastSceneStart: s.lastSceneStart,
    lowEntropyStreak: s.lowEntropyStreak,
    highSimStreak: s.highSimStreak,
    noNewEntityStreak: s.noNewEntityStreak,
    lastEntropy: s.lastEntropy,
    lastDeltaSim: s.lastDeltaSim,
    lastEmbedSim: s.lastEmbedSim,
    lastNewEntitiesTs: s.lastNewEntitiesTs,
    lastStagedTurn: s.lastStagedTurn,
    coolUntilTurn: s.coolUntilTurn,
    lastReason: s.lastReason,
    lastStyle: s.lastStyle,
    lastScore: s.lastScore,
    enabled: CONCLUDE_ENABLED,
  };
}

export function force(convId, style) {
  const s = get(convId);
  const chosenStyle = style || CONCLUDE_STYLE;
  const booster = makeBooster(chosenStyle);
  s.lastStagedTurn = s.turn;
  s.coolUntilTurn = Math.max(s.turn + 1, s.turn); // minimal cooldown
  s.lastReason = 'force';
  s.lastStyle = chosenStyle;
  s.lastScore = 3;
  return {
    staged: true,
    reason: 'force',
    score: 3,
    style: chosenStyle,
    booster,
    coolUntilTurn: s.coolUntilTurn,
  };
}

export default { updateStats, maybeStageConclusion, snapshot, force };
