// signals.mjs — centralized beat/tension signal collection
// Gathers cheap, already-computed metrics from the route context for reuse by
// style and scene beat detectors, without re-computing expensive features.

import { computeDragScore } from '../memory/conclusion_trigger.mjs';

function num(x, d=0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function str(x, d='') {
  const s = String(x || '');
  return s.length ? s : d;
}

export function collectBeatSignals(convId='', ctx=null, inputs={}) {
  const conv = str(convId || ctx?.vars?.conv_id || '');
  const ctxVars = (ctx && ctx.vars) || {};

  const tension = (typeof ctxVars.tension === 'number')
    ? ctxVars.tension
    : (typeof ctx?.memory?.tension === 'number') ? ctx.memory.tension : null;
  const beatHint = str(ctxVars.tension_beat || '') || null;

  const loopScore = num(ctxVars.__loopguard_loopscore, null);
  const deltaSim  = num(ctxVars.__loopguard_deltaSim, null);
  const dwellMs   = num(ctxVars.__last_turn_dwell_ms, null);
  const tensionVar= num(ctxVars.__tension_variance_lastN, null);
  const styleToken= str(ctxVars.__loopguard_style_token || '', null);

  // Drag score: prefer precomputed; compute lightly if needed from existing pieces
  let drag = (typeof ctxVars.__drag_score === 'number') ? ctxVars.__drag_score : null;
  if (drag == null) {
    try {
      const d = computeDragScore({ loopScore: num(loopScore, 0), deltaSim: num(deltaSim, 0), dwellMs: num(dwellMs, 0), tensionVar: num(tensionVar, 0) });
      if (typeof d === 'number') drag = d;
    } catch {}
  }

  const heartbeatMs = num(process.env.SSE_HEARTBEAT_MS, null);

  const userText = String(inputs?.userText || ctxVars.user_text || '');
  const botPrev  = String(inputs?.botPrev || ctxVars.last_bot_text || '');
  const botText  = String(inputs?.botText || ctxVars.bot_text || '');

  return {
    conv_id: conv,
    tension,
    beatHint,
    loopScore,
    deltaSim,
    dwellMs,
    tensionVar,
    drag,
    styleToken,
    heartbeatMs,
    inputs: {
      style: { userText, botPrev, tensionHint: (typeof tension === 'number') ? tension : null },
      scene: { botText, userText }
    }
  };
}

export default { collectBeatSignals };

