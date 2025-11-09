import { AsyncFS } from '../../../monolith.js';

async function main() {
  const target = process.env.TARGET || 'kill_after_fsync_probe.json';
  const payload = process.env.PAYLOAD || '"payload"';
  try {
    await AsyncFS.writeFileAtomic(target, payload, 'utf8');
    console.log(JSON.stringify({ ok: true }));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, code: e && e.code, msg: e && e.message }));
    process.exit(1);
  }
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
  process.exit(1);
});
