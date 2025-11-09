import { EventEmitter } from 'node:events';
import { registerLLMProvider, configureProvidersFromEnv, MessageClock } from '../monolith.js';

function makeStubProvider(name) {
  return {
    name,
    async generate({ prompt, options, stream, onDelta }) {
      const model = options?.model || '';
      if (options?.context?.vars) {
        options.context.vars.__selected_provider = name;
        options.context.vars.__selected_model = model;
      }
      return `provider:${name},model:${model}`;
    },
  };
}

async function runCase(caseName, env, modelName, variant) {
  const prev = {
    URGA_PROVIDER: process.env.URGA_PROVIDER,
    URGA_PROVIDER_A: process.env.URGA_PROVIDER_A,
    URGA_PROVIDER_B: process.env.URGA_PROVIDER_B,
    ECHO_PROVIDER: process.env.ECHO_PROVIDER,
    ECHO_PROVIDER_A: process.env.ECHO_PROVIDER_A,
    ECHO_PROVIDER_B: process.env.ECHO_PROVIDER_B,
    DREAMS_PROVIDER: process.env.DREAMS_PROVIDER,
    DREAMS_PROVIDER_A: process.env.DREAMS_PROVIDER_A,
    DREAMS_PROVIDER_B: process.env.DREAMS_PROVIDER_B,
    LLM_AB_VARIANT: process.env.LLM_AB_VARIANT,
  };

  // Set environment for this case
  process.env.URGA_PROVIDER = env.URGA_PROVIDER ?? '';
  process.env.URGA_PROVIDER_A = env.URGA_PROVIDER_A ?? '';
  process.env.URGA_PROVIDER_B = env.URGA_PROVIDER_B ?? '';
  process.env.ECHO_PROVIDER = env.ECHO_PROVIDER ?? '';
  process.env.ECHO_PROVIDER_A = env.ECHO_PROVIDER_A ?? '';
  process.env.ECHO_PROVIDER_B = env.ECHO_PROVIDER_B ?? '';
  process.env.DREAMS_PROVIDER = env.DREAMS_PROVIDER ?? '';
  process.env.DREAMS_PROVIDER_A = env.DREAMS_PROVIDER_A ?? '';
  process.env.DREAMS_PROVIDER_B = env.DREAMS_PROVIDER_B ?? '';
  // Optional global variant override (probes can also set ctx.vars.abVariant)
  process.env.LLM_AB_VARIANT = variant ? String(variant) : '';

  const io = { events: new EventEmitter() };
  const ctx = {
    io,
    vars: { llmTurnBudget: 5 },
    memory: { trustLevel: 10, corruption: 0, messageCount: 0 },
    settings: {},
    state: {},
    providers: { llm: null },
  };

  // If variant is provided, set it in context
  if (variant) ctx.vars.abVariant = String(variant);

  // Register stub providers (include A/B named variants)
  registerLLMProvider('stub-dreams', makeStubProvider('stub-dreams'));
  registerLLMProvider('stub-dreams-a', makeStubProvider('stub-dreams-a'));
  registerLLMProvider('stub-dreams-b', makeStubProvider('stub-dreams-b'));
  registerLLMProvider('stub-urga', makeStubProvider('stub-urga'));
  registerLLMProvider('stub-urga-a', makeStubProvider('stub-urga-a'));
  registerLLMProvider('stub-urga-b', makeStubProvider('stub-urga-b'));
  registerLLMProvider('stub-echo', makeStubProvider('stub-echo'));
  registerLLMProvider('stub-echo-a', makeStubProvider('stub-echo-a'));
  registerLLMProvider('stub-echo-b', makeStubProvider('stub-echo-b'));

  // Configure composite provider for this context
  configureProvidersFromEnv(ctx);

  // Exercise composite provider directly
  const composite = ctx.providers.llm;
  const out = await composite.generate({
    prompt: 'ab test prompt',
    options: { model: modelName || '', context: ctx },
    stream: false,
  });
  const providerMatch = String(out || '').match(/provider:([^,]+)/);
  const modelMatch = String(out || '').match(/model:([^,]+)/);

  // Restore previous env
  process.env.URGA_PROVIDER = prev.URGA_PROVIDER ?? '';
  process.env.URGA_PROVIDER_A = prev.URGA_PROVIDER_A ?? '';
  process.env.URGA_PROVIDER_B = prev.URGA_PROVIDER_B ?? '';
  process.env.ECHO_PROVIDER = prev.ECHO_PROVIDER ?? '';
  process.env.ECHO_PROVIDER_A = prev.ECHO_PROVIDER_A ?? '';
  process.env.ECHO_PROVIDER_B = prev.ECHO_PROVIDER_B ?? '';
  process.env.DREAMS_PROVIDER = prev.DREAMS_PROVIDER ?? '';
  process.env.DREAMS_PROVIDER_A = prev.DREAMS_PROVIDER_A ?? '';
  process.env.DREAMS_PROVIDER_B = prev.DREAMS_PROVIDER_B ?? '';
  process.env.LLM_AB_VARIANT = prev.LLM_AB_VARIANT ?? '';

  const res = {
    case: caseName,
    env,
    variant: variant || null,
    provider:
      typeof ctx.vars.__selected_provider !== 'undefined'
        ? ctx.vars.__selected_provider
        : providerMatch
          ? providerMatch[1]
          : null,
    model:
      typeof ctx.vars.__selected_model !== 'undefined'
        ? ctx.vars.__selected_model
        : modelMatch
          ? modelMatch[1]
          : null,
    now: MessageClock.now(),
  };
  return res;
}

async function main() {
  const results = [];
  let allPass = true;

  const has = (x) => x && x !== 'unknown-provider';
  const expectedFor = (model, env, variant) => {
    const v = String(variant || '').toUpperCase();
    if (model === 'echo') {
      if (v === 'A' && has(env.ECHO_PROVIDER_A)) return env.ECHO_PROVIDER_A;
      if (v === 'B' && has(env.ECHO_PROVIDER_B)) return env.ECHO_PROVIDER_B;
      return has(env.ECHO_PROVIDER)
        ? env.ECHO_PROVIDER
        : has(env.URGA_PROVIDER)
          ? env.URGA_PROVIDER
          : has(env.DREAMS_PROVIDER)
            ? env.DREAMS_PROVIDER
            : null;
    } else if (model === 'dreams') {
      if (v === 'A' && has(env.DREAMS_PROVIDER_A)) return env.DREAMS_PROVIDER_A;
      if (v === 'B' && has(env.DREAMS_PROVIDER_B)) return env.DREAMS_PROVIDER_B;
      return has(env.DREAMS_PROVIDER)
        ? env.DREAMS_PROVIDER
        : has(env.URGA_PROVIDER)
          ? env.URGA_PROVIDER
          : has(env.ECHO_PROVIDER)
            ? env.ECHO_PROVIDER
            : null;
    } else {
      if (v === 'A' && has(env.URGA_PROVIDER_A)) return env.URGA_PROVIDER_A;
      if (v === 'B' && has(env.URGA_PROVIDER_B)) return env.URGA_PROVIDER_B;
      return has(env.URGA_PROVIDER)
        ? env.URGA_PROVIDER
        : has(env.ECHO_PROVIDER)
          ? env.ECHO_PROVIDER
          : has(env.DREAMS_PROVIDER)
            ? env.DREAMS_PROVIDER
            : null;
    }
  };

  const cases = [
    {
      name: 'echo-A prefers variant A provider',
      env: {
        ECHO_PROVIDER_A: 'stub-echo-a',
        ECHO_PROVIDER_B: 'stub-echo-b',
        ECHO_PROVIDER: 'stub-echo',
        URGA_PROVIDER: 'stub-urga',
        DREAMS_PROVIDER: 'stub-dreams',
      },
      model: 'echo',
      variant: 'A',
    },
    {
      name: 'echo-B prefers variant B provider',
      env: {
        ECHO_PROVIDER_A: 'stub-echo-a',
        ECHO_PROVIDER_B: 'stub-echo-b',
        ECHO_PROVIDER: 'stub-echo',
        URGA_PROVIDER: 'stub-urga',
        DREAMS_PROVIDER: 'stub-dreams',
      },
      model: 'echo',
      variant: 'B',
    },
    {
      name: 'dreams-A prefers variant A provider',
      env: {
        DREAMS_PROVIDER_A: 'stub-dreams-a',
        DREAMS_PROVIDER_B: 'stub-dreams-b',
        DREAMS_PROVIDER: 'stub-dreams',
        URGA_PROVIDER: 'stub-urga',
        ECHO_PROVIDER: 'stub-echo',
      },
      model: 'dreams',
      variant: 'A',
    },
    {
      name: 'urga-B prefers variant B provider',
      env: {
        URGA_PROVIDER_A: 'stub-urga-a',
        URGA_PROVIDER_B: 'stub-urga-b',
        URGA_PROVIDER: 'stub-urga',
        ECHO_PROVIDER: 'stub-echo',
        DREAMS_PROVIDER: 'stub-dreams',
      },
      model: 'urga',
      variant: 'B',
    },
    {
      name: 'echo-A falls back to base when A unknown',
      env: {
        ECHO_PROVIDER_A: 'unknown-provider',
        ECHO_PROVIDER_B: 'stub-echo-b',
        ECHO_PROVIDER: 'stub-echo',
        URGA_PROVIDER: 'stub-urga',
        DREAMS_PROVIDER: 'stub-dreams',
      },
      model: 'echo',
      variant: 'A',
    },
    {
      name: 'dreams-B falls back to urga when base missing',
      env: {
        DREAMS_PROVIDER_B: 'unknown-provider',
        DREAMS_PROVIDER: '',
        URGA_PROVIDER: 'stub-urga',
        ECHO_PROVIDER: 'stub-echo',
      },
      model: 'dreams',
      variant: 'B',
    },
  ];

  for (const c of cases) {
    const expProvider = expectedFor(c.model, c.env, c.variant);
    const r = await runCase(c.name, c.env, c.model, c.variant);
    r.expected_provider = expProvider;
    r.expected_model = c.model || '';
    r.pass = r.provider === expProvider && r.model === (c.model || '');
    if (!r.pass) allPass = false;
    results.push(r);
  }

  if (!allPass) {
    console.error(
      JSON.stringify({ ok: false, reason: 'ab env precedence assertions failed', results })
    );
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ ok: true, results }));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  process.exitCode = 1;
});
