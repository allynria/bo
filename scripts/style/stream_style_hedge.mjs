// stream_style_hedge.mjs
// True parallel hedge for /v1/conv/stream: launch primary stream, then (after a short deadline)
// launch a style-alternate backup (and optionally a different provider). Cut over on first token.
//
// Env knobs:
//   STYLE_HEDGE_ENABLED=1
//   STYLE_HEDGE_FIRST_MS=350               (ms before starting backup)
//   STYLE_HEDGE_MAX_MS=2000                (guard: abandon backup after this)
//   HEDGE_STYLE_PROVIDER=stub-dreams       (optional alt provider; falls back to same)
//
// Emitted SSE (from service): hedge.style.start, hedge.style.switch
// Metrics: style_hedge_started_total, style_hedge_switch_total, first_token_ms_bucket handled upstream
//
const CFG = {
  ENABLED: String(process.env.STYLE_HEDGE_ENABLED ?? '1') === '1',
  FIRST_MS: Number(process.env.STYLE_HEDGE_FIRST_MS ?? 350),
  MAX_MS: Number(process.env.STYLE_HEDGE_MAX_MS ?? 2000),
  ALT_PROVIDER: process.env.HEDGE_STYLE_PROVIDER || null,
};

export function getStyleAlt(plan) {
  // Simple alt style from beat suggestion or rotation
  const preferred = plan?.styleToken || 'descriptive';
  // deterministic small rotation
  const ring = ['terse', 'poetic', 'reflective', 'descriptive'];
  const i = Math.max(0, ring.indexOf(preferred));
  return ring[(i + 1) % ring.length];
}

export async function runStyleHedge(ctx, startPrimary, startBackup, onSwitch, resOrEmit) {
  // ctx: request-scoped ctx with io.events
  if (!CFG.ENABLED) return { enabled: false };

  let switched = false;
  let primaryStarted = false;
  let backupStarted = false;
  let stopBackupTimer, abortBackup;

  const announce = (evt, payload) => {
    if (typeof resOrEmit === 'function') return resOrEmit(evt, payload);
    // else service will call res.write itself
  };

  announce('hedge.style.start', {
    first_ms: CFG.FIRST_MS,
    max_ms: CFG.MAX_MS,
    alt_provider: CFG.ALT_PROVIDER || 'same',
  });
  ctx?.metrics?.inc?.('style_hedge_started_total', { path: 'stream' });

  // kick primary now
  const primary = await startPrimary();
  primaryStarted = true;

  // schedule backup
  const backupTimer = setTimeout(async () => {
    backupStarted = true;
    const { cancel } = await startBackup();
    abortBackup = cancel;
  }, CFG.FIRST_MS);
  stopBackupTimer = () => clearTimeout(backupTimer);

  // guard: stop backup attempt after MAX_MS if not needed
  setTimeout(() => {
    if (!switched && abortBackup) {
      try {
        abortBackup();
      } catch {}
    }
  }, CFG.MAX_MS);

  // onSwitch(firstDeltaFrom, meta)
  return {
    notifyFirst(from, meta) {
      if (switched) return;
      switched = true;
      try {
        stopBackupTimer?.();
      } catch {}
      if (from === 'backup' && primary?.cancel) {
        try {
          primary.cancel();
        } catch {}
      }
      if (from === 'primary' && abortBackup) {
        try {
          abortBackup();
        } catch {}
      }
      onSwitch?.(from, meta);
      announce('hedge.style.switch', {
        from,
        provider: meta?.provider,
        model: meta?.model,
        style: meta?.style,
      });
      ctx?.metrics?.inc?.('style_hedge_switch_total', { from, path: 'stream' });
    },
  };
}

export default { runStyleHedge, getStyleAlt };
