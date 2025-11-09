import { EventEmitter } from 'node:events';
import {
  generateLine,
  MessageClock,
  ModelAdapter,
} from '../monolith.js';

async function main() {
  const io = { events: new EventEmitter() };
  const context = {
    io,
    vars: {},
    stats: {},
    memory: { trustLevel: 5, corruption: 3, messageCount: 0 },
  };

  // Stub provider to capture which model is requested
  let lastModel = null;
  const stubProvider = {
    async generate({ prompt, options = {}, stream = false, onDelta }) {
      lastModel = options?.model || null;
      const out = `stub:${String(options?.model || 'none')}`;
      if (stream && typeof onDelta === 'function') {
        for (const ch of out) onDelta(ch);
        return out;
      }
      return out;
    }
  };

  // Attach stub provider via ModelAdapter path
  context.providers = { llm: stubProvider };
  context.modelAdapter = new ModelAdapter(context);

  const prompt = 'You fall into a velvet void. Sleep calls.';
  const text = await generateLine(context, prompt, { purpose: 'dream', tone: 'soft' });

  const result = {
    ok: true,
    model_seen: lastModel,
    text,
    now: MessageClock.now(),
  };
  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) }) + "\n");
  process.exitCode = 1;
});

