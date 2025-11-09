async function main() {
  // Silence non-essential logs to keep stdout JSON-only
  const orig = { info: console.info, warn: console.warn };
  console.info = () => {};
  console.warn = () => {};
  // Avoid retry so first error is preserved for tests
  try {
    process.env.IO_RETRIES = '0';
  } catch {}
  // Ensure a known-closed global circuit breaker at start; allow trip/reset later
  try {
    const start = Date.now();
    let openUntil = 0;
    globalThis.CB = {
      isOpen: () => Date.now() < openUntil,
      trip: (ms = 5000) => {
        const d = Number(ms);
        openUntil = Date.now() + (Number.isFinite(d) && d >= 0 ? d : 5000);
      },
      reset: () => {
        openUntil = 0;
      },
    };
  } catch {}
  const { safeFsp } = await import('../../../monolith.js');
  const target = process.env.TARGET || 'enospc.trigger.txt';
  let firstErrorCode = null;
  let secondError = null;
  let circuitOpen = false;
  try {
    await safeFsp.writeFile(target, 'x', 'utf8');
  } catch (e) {
    firstErrorCode = (e && e.code) || 'ERR';
  }
  try {
    await safeFsp.writeFile(target, 'y', 'utf8');
  } catch (e) {
    secondError = (e && (e.code || e.message)) || 'ERR';
  }
  try {
    circuitOpen = !!globalThis.CB?.isOpen?.();
  } catch {}
  try {
    console.log(
      JSON.stringify({
        firstErrorCode,
        secondError,
        ready: !!globalThis.READY?.isReady?.(),
        circuitOpen,
      })
    );
  } catch {
    console.log(JSON.stringify({ firstErrorCode, secondError, circuitOpen }));
  }
  // Restore console (not strictly necessary since process exits)
  console.info = orig.info;
  console.warn = orig.warn;
}

main().catch((e) => {
  console.error('fs_pressure_probe_error', (e && e.stack) || e);
  process.exitCode = 1;
});
