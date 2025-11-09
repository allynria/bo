import { EventEmitter } from 'events';
import { LLMService, MessageClock } from '../monolith.js';

// Streaming probe: verifies that LLMService.stream emits start/delta/end and uses model 'dreams'
async function main() {
  const io = { events: new EventEmitter() };
  const deltas = [];
  let started = false;
  let ended = false;
  let modelSeen = null;

  // Attach listeners to capture streaming lifecycle
  io.events.on('stream.start', (payload) => {
    started = true;
    if (payload && payload.model && !modelSeen) modelSeen = payload.model;
  });
  io.events.on('stream.delta', (payload) => {
    // capture delta text
    if (payload && typeof payload.text === 'string') deltas.push(payload.text);
  });
  io.events.on('stream.end', (payload) => {
    ended = true;
  });

  // Minimal context with explicit LLM budget allowance
  const context = {
    io,
    vars: { llmTurnBudget: 5, purpose: 'dream' },
    memory: { trustLevel: 10, corruption: 0, messageCount: 0 },
    settings: {},
    state: {},
    // Directly stub a provider that emits deltas; ModelAdapter will pass stream:true
    providers: {
      llm: {
        name: 'stub-stream-dreams',
        async generate({ prompt, options, stream, onDelta }) {
          const model = options?.model || 'dreams';
          if (stream && typeof onDelta === 'function') {
            onDelta('stub:');
            onDelta(model);
          }
          return `stub:${model}`;
        },
      },
    },
  };

  const service = new LLMService(context);
  const text = await service.stream('lucid visions', { model: 'dreams', purpose: 'dream' });

  const result = {
    ok: true,
    started,
    ended,
    deltas: deltas,
    delta_count: deltas.length,
    model_seen: modelSeen || 'dreams',
    text,
    now: MessageClock.now(),
  };
  const joined = deltas.join('');
  const passed =
    started &&
    ended &&
    text === 'stub:dreams' &&
    joined === 'stub:dreams' &&
    modelSeen === 'dreams';
  if (!passed) {
    console.error(JSON.stringify({ ok: false, reason: 'streaming assertions failed', result }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
});
