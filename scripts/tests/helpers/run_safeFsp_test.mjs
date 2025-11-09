import { safeFsp } from '../../../monolith.js';

async function main() {
  const target = 'enospc.trigger.txt';
  console.log(JSON.stringify({ type: typeof safeFsp.writeFile }));
  try {
    await safeFsp.writeFile(target, 'x', 'utf8');
    console.log(JSON.stringify({ wrote: true }));
  } catch (e) {
    console.log(
      JSON.stringify({ wrote: false, code: e && e.code, msg: e && e.message, stack: e && e.stack })
    );
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e) }));
  process.exitCode = 1;
});
