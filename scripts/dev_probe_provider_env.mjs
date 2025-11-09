import { EventEmitter } from 'events';
import { LLMService, registerLLMProvider, configureProvidersFromEnv, MessageClock } from '../monolith.js';

function makeStubProvider(name) {
  return {
    name,
    async generate({ prompt, options, stream, onDelta }) {
      const model = options?.model || '';
      if (options?.context?.vars) {
        options.context.vars.__selected_provider = name;
        options.context.vars.__selected_model = model;
      }
      // streaming not required for env precedence probe; return marker
      return `provider:${name},model:${model}`;
    }
  };
}

async function runCase(caseName, env, modelName) {
  // Apply environment variables for this case
  const prev = {
    DREAMS_PROVIDER: process.env.DREAMS_PROVIDER,
    URGA_PROVIDER: process.env.URGA_PROVIDER,
    ECHO_PROVIDER: process.env.ECHO_PROVIDER
  };
  process.env.DREAMS_PROVIDER = env.DREAMS_PROVIDER ?? '';
  process.env.URGA_PROVIDER = env.URGA_PROVIDER ?? '';
  process.env.ECHO_PROVIDER = env.ECHO_PROVIDER ?? '';

  const io = { events: new EventEmitter() };
  const ctx = {
    io,
    vars: { llmTurnBudget: 5 },
    memory: { trustLevel: 10, corruption: 0, messageCount: 0 },
    settings: {},
    state: {},
    providers: { llm: null }
  };

  // Register stub providers (idempotent across cases)
  registerLLMProvider('stub-dreams', makeStubProvider('stub-dreams'));
  registerLLMProvider('stub-urga', makeStubProvider('stub-urga'));
  registerLLMProvider('stub-echo', makeStubProvider('stub-echo'));

  // Configure providers from env for this context
  configureProvidersFromEnv(ctx);

  // Directly exercise composite provider to avoid unrelated call paths
  const composite = ctx.providers.llm;
  const out = await composite.generate({ prompt: 'test prompt', options: { model: modelName || '', context: ctx }, stream: false });
  const providerMatch = String(out || '').match(/provider:([^,]+)/);
  const modelMatch = String(out || '').match(/model:([^,]+)/);

  // Restore previous env to avoid side effects
  process.env.DREAMS_PROVIDER = prev.DREAMS_PROVIDER ?? '';
  process.env.URGA_PROVIDER = prev.URGA_PROVIDER ?? '';
  process.env.ECHO_PROVIDER = prev.ECHO_PROVIDER ?? '';

  const res = {
    case: caseName,
    env,
    provider: (typeof ctx.vars.__selected_provider !== 'undefined') ? ctx.vars.__selected_provider : (providerMatch ? providerMatch[1] : null),
    model: (typeof ctx.vars.__selected_model !== 'undefined') ? ctx.vars.__selected_model : (modelMatch ? modelMatch[1] : null),
    now: MessageClock.now()
  };
  return res;
}

async function main() {
  const results = [];

  // Helper to compute expected provider given model and env (unknown/empty means unavailable)
  const pickExpected = (model, env) => {
    const has = (x) => x && x !== 'unknown-provider';
    if (model === 'dreams') {
      return has(env.DREAMS_PROVIDER) ? env.DREAMS_PROVIDER : has(env.URGA_PROVIDER) ? env.URGA_PROVIDER : has(env.ECHO_PROVIDER) ? env.ECHO_PROVIDER : null;
    } else if (model === 'echo') {
      return has(env.ECHO_PROVIDER) ? env.ECHO_PROVIDER : has(env.URGA_PROVIDER) ? env.URGA_PROVIDER : has(env.DREAMS_PROVIDER) ? env.DREAMS_PROVIDER : null;
    } else {
      return has(env.URGA_PROVIDER) ? env.URGA_PROVIDER : has(env.ECHO_PROVIDER) ? env.ECHO_PROVIDER : has(env.DREAMS_PROVIDER) ? env.DREAMS_PROVIDER : null;
    }
  };

  const cases = [
    // dreams
    { name: 'dreams_direct', model: 'dreams', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: 'stub-urga', ECHO_PROVIDER: 'stub-echo' } },
    { name: 'dreams_fallback_urga', model: 'dreams', env: { DREAMS_PROVIDER: '', URGA_PROVIDER: 'stub-urga', ECHO_PROVIDER: 'stub-echo' } },
    { name: 'dreams_fallback_echo', model: 'dreams', env: { DREAMS_PROVIDER: 'unknown-provider', URGA_PROVIDER: '', ECHO_PROVIDER: 'stub-echo' } },
    // echo
    { name: 'echo_direct', model: 'echo', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: 'stub-urga', ECHO_PROVIDER: 'stub-echo' } },
    { name: 'echo_fallback_urga', model: 'echo', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: 'stub-urga', ECHO_PROVIDER: '' } },
    { name: 'echo_fallback_dreams', model: 'echo', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: '', ECHO_PROVIDER: 'unknown-provider' } },
    // default
    { name: 'default_direct_urga', model: '', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: 'stub-urga', ECHO_PROVIDER: 'stub-echo' } },
    { name: 'default_fallback_echo', model: '', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: '', ECHO_PROVIDER: 'stub-echo' } },
    { name: 'default_fallback_dreams', model: '', env: { DREAMS_PROVIDER: 'stub-dreams', URGA_PROVIDER: 'unknown-provider', ECHO_PROVIDER: '' } }
  ];

  let allPass = true;
  for (const c of cases) {
    const expProvider = pickExpected(c.model || '', c.env);
    const r = await runCase(c.name, c.env, c.model);
    r.expected_provider = expProvider;
    r.expected_model = c.model || '';
    r.pass = (r.provider === expProvider) && (r.model === (c.model || ''));
    if (!r.pass) allPass = false;
    results.push(r);
  }

  if (!allPass) {
    console.error(JSON.stringify({ ok: false, reason: 'env precedence assertions failed', results }));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, results }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  process.exitCode = 1;
});
