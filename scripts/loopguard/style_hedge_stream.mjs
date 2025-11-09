/**
 * StyleHedgeStream: launch a primary stream and (optionally) a style-boosted backup
 * after LOOP_STYLE_HEDGE_MS. First delta wins; the loser is cancelled. Emits SSE-friendly
 * events via provided write(event, payload).
 */
import { initBotContext } from '../../monolith.js';

const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

function chooseStyleToken(styleCsv) {
  const arr = String(styleCsv||'').split(',').map(s=>s.trim()).filter(Boolean);
  if (!arr.length) return 'descriptive';
  return arr[(Date.now()/997|0) % arr.length];
}

export async function runStyleHedgeStream({
  serviceCtx, LLMService, text, engine, convId, write, res,
  sseEvents, // shared Map of { started:boolean, winner:'primary'|'backup'|null }
  ultraForce = false,
}) {
  // Enable when explicitly toggled, or when Ultra forces it
  const enabled = (
    ultraForce ||
    String(process.env.STYLE_HEDGE_ENABLED || '') === '1' ||
    String(process.env.LOOP_STYLE_HEDGE_ENABLED || '') === '1'
  );
  if (!enabled) {
    // single normal stream (primary only)
    return LLMService.stream(text, { model: engine }, serviceCtx);
  }

  // Allow tests to drive immediate backup via LLM_HEDGE_FIRST_TOKEN_MS=0, fallback to loopguard var
  const hedgeDelay = Number(
    (process.env.LLM_HEDGE_FIRST_TOKEN_MS ?? process.env.LOOP_STYLE_HEDGE_MS ?? 400)
  );
  const styleTokens = (
    process.env.STYLE_HEDGE_TOKENS ||
    process.env.LOOP_STYLE_HEDGE_TOKENS ||
    'descriptive,poetic,terse,inner-thought'
  );
  const chosen = chooseStyleToken(styleTokens);
  const booster = `(STYLE:${chosen}) Avoid familiar phrasing; vary cadence; introduce a fresh, specific sensory beat.`;

  // We create two isolated contexts so their event buses don't fight.
  const ctxPrimary = initBotContext({ ...serviceCtx, vars: { ...(serviceCtx.vars||{}), conv_id: convId }});
  const ctxBackup  = initBotContext({ ...serviceCtx, vars: { ...(serviceCtx.vars||{}), conv_id: convId, __style_hedge: chosen }});

  let winner = null;
  let primaryEnded = false, backupEnded = false;
  let cancelPrimary = null, cancelBackup = null;

  let startWritten = false;
  let endWritten = false;

  function forwardStream(ctx, tag) {
    const unsub = [];
    const onStart = (p)=> {
      if (!startWritten) {
        startWritten = true;
        write('start', { ...p, style_hedge: tag==='backup', style: tag==='backup'?chosen:undefined });
      }
    };
    const onDelta = (p)=> write('delta', p);
    const onNarrative = (p)=> {
      // Forward narrative events only from the winner once determined to avoid duplicates
      if (winner === tag) {
        write('narrative.event', p);
      }
    };
    const onEnd   = (p)=> {
      if (!endWritten && winner === tag) {
        endWritten = true;
        write('end', { ...p, style_hedge: tag==='backup' });
      }
    };

    ctx.io.events.on('stream.start', onStart);
    ctx.io.events.on('stream.delta', onDelta);
    ctx.io.events.on('narrative.event', onNarrative);
    ctx.io.events.on('stream.end', onEnd);

    unsub.push(()=> ctx.io.events.off('stream.start', onStart));
    unsub.push(()=> ctx.io.events.off('stream.delta', onDelta));
    unsub.push(()=> ctx.io.events.off('narrative.event', onNarrative));
    unsub.push(()=> ctx.io.events.off('stream.end', onEnd));
    return ()=> unsub.forEach(fn=>fn());
  }

  // We gate writing deltas so only the winner's deltas pass to the client.
  let firstDeltaResolved = false;
  function makeDeltaGate(tag) {
    return (payload) => {
      if (!firstDeltaResolved) {
        firstDeltaResolved = true;
        winner = tag;
        sseEvents.winner = tag;
        if (tag === 'backup') {
          // announce hedge switch
          try { serviceCtx?.io?.events?.emit?.('style.hedge.switch', { style: chosen }); } catch {}
          write('hedge.switch', { reason: 'style_hedge', style: chosen });
        }
      }
      if (winner === tag) {
        write('delta', payload);
      }
    };
  }

  // Attach forwarders with delta gating
  const primaryUnsub = forwardStream(ctxPrimary, 'primary');
  const backupUnsub  = forwardStream(ctxBackup , 'backup');

  // Patch delta gate
  const origEmitP = ctxPrimary.io.events.emit.bind(ctxPrimary.io.events);
  ctxPrimary.io.events.emit = (evt, payload)=>{
    if (evt === 'stream.delta') return makeDeltaGate('primary')(payload);
    return origEmitP(evt, payload);
  };
  const origEmitB = ctxBackup.io.events.emit.bind(ctxBackup.io.events);
  ctxBackup.io.events.emit = (evt, payload)=>{
    if (evt === 'stream.delta') return makeDeltaGate('backup')(payload);
    return origEmitB(evt, payload);
  };

  // Cancellation via AbortControllers
  const acPrimary = new AbortController();
  const acBackup  = new AbortController();
  cancelPrimary = ()=> acPrimary.abort();
  cancelBackup  = ()=> acBackup.abort();

  // Launch primary and schedule backup
  const primaryPromise = (async ()=>{
    try {
      const final = await LLMService.stream(text, { model: engine, signal: acPrimary.signal }, ctxPrimary);
      primaryEnded = true;
      return final;
    } catch (e) {
      primaryEnded = true;
      throw e;
    } finally {
      primaryUnsub();
    }
  })();

  // Optional delayed backup
  const backupPromise = (async ()=>{
    // Emit style hedge start just before firing backup
    await sleep(hedgeDelay);
    try { serviceCtx?.io?.events?.emit?.('style.hedge.start', { style: chosen, delay_ms: Number.isFinite(hedgeDelay) ? hedgeDelay : 0 }); } catch {}
    try {
      const final = await LLMService.stream(`${booster}\n\n${text}`, { model: engine, signal: acBackup.signal }, ctxBackup);
      backupEnded = true;
      return final;
    } catch (e) {
      backupEnded = true;
      throw e;
    } finally {
      backupUnsub();
    }
  })();

  // First delta decides; once winner known, cancel loser as soon as we see first delta on winner.
  // We detect by watching 'winner' being set in delta gating above; poll briefly:
  const cancelLoser = (async ()=>{
    for (let i=0;i<200;i++) { // up to ~2s
      if (winner) break;
      await sleep(10);
    }
    if (winner === 'primary' && !backupEnded) cancelBackup?.();
    if (winner === 'backup'  && !primaryEnded) cancelPrimary?.();
  })();

  sseEvents.started = true;
  // Return a promise that resolves once both paths have settled; winner's LLMService.stream has already written deltas.
  await Promise.race([primaryPromise, backupPromise]).catch(()=>{ /* errors handled by SSE error path upstream if needed */ });
  await cancelLoser;
  // We don't need to await both streams; SSE end events will carry the final.
  return (winner === 'backup') ? await backupPromise.catch(()=> '') : await primaryPromise.catch(()=> '');
}
