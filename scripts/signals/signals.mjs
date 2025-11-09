// signals/signals.mjs — central event helpers with standardized labels
// Lightweight: creates normalized event objects and optionally records to ctx.vars.__events

function nowTs(){ try { return Date.now(); } catch { return Number(new Date()); } }

function convIdOf(ctx){
  try { return String(ctx?.vars?.conv_id || ''); } catch { return ''; }
}

function normalize(type){
  const t = String(type || '').trim().toLowerCase();
  // enforce dotted namespaces for consistency
  return t.replace(/\s+/g, '.').replace(/[^a-z0-9_.-]/g, '');
}

function record(ctx, evt){
  try {
    const v = (ctx.vars ||= {});
    const arr = (v.__events ||= []);
    arr.push(evt);
  } catch {}
  return evt;
}

export function emit(ctx, type, payload={}){
  const evt = { type: normalize(type), ts: nowTs(), conv_id: convIdOf(ctx), payload };
  return record(ctx, evt);
}

export function emitMemoryFact(ctx, fact, meta={}){
  return emit(ctx, 'memory.fact', { fact, ...meta });
}

export function emitMemoryScene(ctx, scene, meta={}){
  return emit(ctx, 'memory.scene', { scene, ...meta });
}

export function emitMemoryShape(ctx, shape, meta={}){
  return emit(ctx, 'memory.shape', { shape, ...meta });
}

export function emitMemoryArc(ctx, arc, meta={}){
  return emit(ctx, 'memory.arc', { arc, ...meta });
}

export function emitMemoryDream(ctx, dream, meta={}){
  return emit(ctx, 'memory.dream', { dream, ...meta });
}

export function emitLoopGuardTriggered(ctx, reason, extra={}){
  return emit(ctx, 'loopguard.triggered', { reason, ...extra });
}

export default {
  emit,
  emitMemoryFact,
  emitMemoryScene,
  emitMemoryShape,
  emitMemoryArc,
  emitMemoryDream,
  emitLoopGuardTriggered,
};

