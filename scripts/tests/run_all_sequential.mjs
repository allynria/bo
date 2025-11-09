import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const testsDir = join(process.cwd(), 'scripts', 'tests');

// Discover tests
const all = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(testsDir, f))
  .sort();

// Optional fast mode: skip soak/long tests when FAST_SUITE=1
const fastPatterns = [/soak/i, /steady_load/i, /chaos/i, /cold_start/i];
const fastMode = process.env.FAST_SUITE === '1';
const tests = fastMode ? all.filter((p) => !fastPatterns.some((r) => r.test(p))) : all;

// CLI flags
const argv = process.argv.slice(2);
const wantCoverage = argv.includes('--coverage');
const wantCI = argv.includes('--ci');
const coverageDir = join(process.cwd(), 'coverage');
if (wantCoverage) {
  try { mkdirSync(coverageDir, { recursive: true }); } catch {}
}

console.log(`Running ${tests.length} tests sequentially${fastMode ? ' (FAST_SUITE)' : ''}...`);

let failures = 0;
for (const file of tests) {
  console.log(`\n=== Running: ${file} ===`);
  const timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 60000);
  const res = spawnSync(process.execPath, ['--test', file], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(wantCI ? { CI: '1', TEST_CI: '1' } : {}),
      ...(wantCoverage ? { NODE_V8_COVERAGE: coverageDir } : {}),
    },
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (res.error && res.error.code === 'ETIMEDOUT') {
    failures++;
    console.error(`Test timed out after ${timeoutMs}ms: ${file}`);
  } else if (res.status !== 0) {
    failures++;
    console.error(`Test failed: ${file} (exit=${res.status})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
