export function assertProdGuards(env = process.env) {
  const prod = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const debugHeap = String(env.DEBUG_HEAP || '').toLowerCase() === 'true' || String(env.DEBUG_HEAP || '') === '1';
  if (prod && debugHeap) {
    throw new Error('Refusing to start: DEBUG_HEAP=true in production');
  }
}
