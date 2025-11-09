/**
 * Computes a drag score based on recent repeats, low deltaSim novelty, long dwell,
 * and low tension variance. Emits suggestion to stage a fade booster.
 */
export function computeDragScore({ loopScore = 0, deltaSim = 0, dwellMs = 0, tensionVar = 0 }) {
  // normalize features into 0..1
  const dwellTarget = Number(process.env.CONCLUDE_DWELL_TARGET_MS || 120000); // default 2 min
  const dwell = Math.min(
    1,
    dwellMs / (Number.isFinite(dwellTarget) && dwellTarget > 0 ? dwellTarget : 120000)
  );
  const lowVar = 1 - Math.min(1, Math.max(0, Number(tensionVar)));
  const score =
    0.35 * Number(loopScore || 0) +
    0.25 * Number(deltaSim || 0) +
    0.25 * Number(dwell || 0) +
    0.15 * Number(lowVar || 0);
  return Math.max(0, Math.min(1, score));
}

export function buildFadeBooster({ style = 'classy', sceneName = null }) {
  const line =
    style === 'noir'
      ? `(The night exhales; the scene thins to cigarette smoke and streetlight.)`
      : style === 'poetic'
        ? `(The moment loosens, soft as thread pulled from a heavy tapestry.)`
        : `(The scene draws to a gentle close, its echoes lingering.)`;
  const scene = sceneName ? `\n(Next: ${sceneName})` : '';
  return `${line}${scene}`;
}
