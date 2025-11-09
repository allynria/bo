// Probe dynamic import behavior with absolute Windows path specifiers
(async () => {
  try {
    const spec = process.argv[2] || '';
    const mod = await import(spec);
    const keys = Object.keys(mod || {});
    process.stdout.write(JSON.stringify({ ok: true, keys: keys.slice(0, 10) }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ ok: false, code: e && e.code, msg: e && e.message }) + '\n'
    );
    process.exit(1);
  }
})();
