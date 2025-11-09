import { stateIO } from '../../../monolith.js';

async function main() {
  const target = process.env.TARGET || 'kill_write_target.json';
  const killMs = Number(process.env.KILL_MS || 50);
  const payload = { time: Date.now(), data: 'large'.repeat(1000) };
  setTimeout(() => { try { process.exit(1); } catch {} }, killMs);
  try { await stateIO.writeJsonAtomic(target, payload); } catch {}
}

main().catch(e => { /* ignore */ });
