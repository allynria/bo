// Probe script to measure logAt outputs under different LOG_LEVELs.
// Prints a single JSON line with counts for debug/info/warn/error triggered by logAt calls.

const counts = { debug: 0, info: 0, warn: 0, error: 0 };
const orig = { ...console };
console.debug = (..._a) => { counts.debug++; };
console.info = (..._a) => { counts.info++; };
console.warn = (..._a) => { counts.warn++; };
console.error = (..._a) => { counts.error++; };

const monolith = await import('../../../monolith.js');
const { logAt } = monolith;

// Record baseline after module import (some modules log during import)
const baseline = { ...counts };

// Trigger one call at each level
logAt('debug', '[probe] debug');
logAt('info', '[probe] info');
logAt('warn', '[probe] warn');
logAt('error', '[probe] error');

const result = {
  debug: counts.debug - baseline.debug,
  info: counts.info - baseline.info,
  warn: counts.warn - baseline.warn,
  error: counts.error - baseline.error
};

process.stdout.write(JSON.stringify(result) + "\n");
