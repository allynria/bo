# Deployment Runbook

## Blue/Green

- Prepare `blue` and `green` environments with identical configuration.
- Deploy new version to `green`.
- Health checks:
  - `/healthz` returns 200 and minimal body (prod minimal mode).
  - `/readyz` returns 200 with admin auth and IP allowlist checks.
  - `/metrics` available with admin auth for canary diagnostics.
- Switch traffic gradually via LB or gateway:
  - 1% → 10% → 25% → 50% → 100%, with 2–5 minute holds at each step.
- Revert commands (example, adjust to your infra):
  - Kubernetes: `kubectl rollout undo deployment/urga-service`
  - Gateway route: restore previous backend target; keep `blue` as primary.

## Auto-Rollback Triggers

- Probe failures: `/readyz` non-200 sustained for >60s.
- Latency breach: `respond_ms P99` exceeds SLO target or >10% regression vs baseline.
- Backpressure sustained: `backpressure_sustained_total` and `backpressure_sustained_ms_bucket` increments beyond threshold.

## Canary Observability Checklist

- Dashboards distinguish taxonomy:
  - 4xx policy (`policy`), 429 per-client (`client`), 503 capacity (`backpressure`).
- Watch counters:
  - `responses_total{status}`
  - `rate_limited_total{reason}`
  - `arrivals_total`, `completions_total`, `respond_ms_bucket{le}`
  - `rss_ceiling_breach_total`

## What Good Looks Like (Streaming)

Short targets for time-to-first-token and hedge rate by environment. Actual values depend on model/provider and network; adjust during canaries.

| Env     | First token p50 | p90      | p99       | Hedge rate target |
| ------- | --------------- | -------- | --------- | ----------------- |
| local   | ≤ 150 ms        | ≤ 350 ms | ≤ 800 ms  | ≤ 5%              |
| staging | ≤ 200 ms        | ≤ 500 ms | ≤ 1000 ms | ≤ 8%              |
| canary  | ≤ 220 ms        | ≤ 550 ms | ≤ 1100 ms | ≤ 6%              |
| prod    | ≤ 250 ms        | ≤ 600 ms | ≤ 1200 ms | ≤ 3%              |

Notes:

- First-token is measured from request acceptance to `event: start` emission.
- Hedge rate is ratio of streams that emit `hedge.switch` to total streams.
- Investigate if prod p99 drifts >20% vs baseline or hedge rate exceeds target for >10 minutes.

## What to Capture Before Restart

- Logs: recent 10–30 minutes; ensure JSON-only, redacted (Authorization/cookies/tokens/emails/phones).
- Metrics snapshot: `/metrics` output.
- Heap: `/heap/snapshot?token=…` file path; capture start/end for leak diff.
- Traces: enable `OTEL_ENABLED=1` and collect spans around `http.request`; if extended instrumentation is enabled around FS, include those spans.

## Backup/Restore for Critical JSON State

- Any atomic JSON state written by modules should be copied before restart.
- To restore: place files back into expected shard directories; the app re-acquires locks safely on startup.

## Container Hardening Notes

- Use the provided `Dockerfile` (non-root user, minimal base).
- Run with read-only rootfs; writable mounts only for `/tmp` and application work dir.
- Set `ulimits` and `seccomp` via orchestrator (Docker/K8s) policies.

## Tenant Budgets

- Purpose: pre-deny requests at the HTTP layer when a tenant exceeds configured dollar or token budgets over a sliding window.
- Endpoints gated: `/conv/message` and `/conv/stream`.
- Behavior on denial:
  - Returns `429` with JSON `{ error: 'budget_limited', reason: 'tenant_dollars'|'tenant_tokens', scope, window_ms }`.
  - Increments `budget_prevented_total{scope}` and `responses_total{status="429"}`.

- Dollar budget configuration:
  - `TENANT_DOLLARS_BUDGET`: allowed USD per window.
  - `TENANT_DOLLARS_WINDOW_MS`: window length in milliseconds.
  - `LLM_USD_PER_TOKEN_IN`: cost per input token.
  - `LLM_USD_PER_TOKEN_OUT`: cost per output token.
  - `LLM_EXPECTED_TOKENS_OUT`: expected output tokens used for pre-check estimation.
  - Metrics scope label: `tenant_dollars_http`.

- Token budget configuration:
  - `TENANT_TOKENS_BUDGET`: allowed tokens per window.
  - `TENANT_TOKENS_WINDOW_MS`: window length in milliseconds.
  - Metrics scope label: `tenant_tokens_http`.

- Monthly budgets (calendar-month caps):
  - Tokens: `TENANT_TOKENS_MONTHLY_BUDGET`.
  - Dollars: `TENANT_DOLLARS_MONTHLY_BUDGET`.
  - HTTP denial scopes: `tenant_tokens_monthly_http`, `tenant_dollars_monthly_http`.
  - Service denial response: `{ error: 'budget_limited', reason: 'tenant_tokens_monthly'|'tenant_dollars_monthly' }`.
  - LLM service fallback scopes: `tenant_tokens_monthly`, `tenant_dollars_monthly`.

- Rolling window budgets (time-bucketed sliding caps):
  - Tokens: `TENANT_TOKENS_ROLLING_BUDGET`, `TENANT_TOKENS_ROLLING_WINDOW_MS`.
  - Dollars: `TENANT_DOLLARS_ROLLING_BUDGET`, `TENANT_DOLLARS_ROLLING_WINDOW_MS`.
  - Bucket granularity: `TENANT_ROLLING_BUCKET_MS` (default `60000`).
  - HTTP denial scopes: `tenant_tokens_rolling_http`, `tenant_dollars_rolling_http`.
  - Service denial response: `{ error: 'budget_limited', reason: 'tenant_tokens_rolling'|'tenant_dollars_rolling', window_ms }`.
  - LLM service fallback scopes: `tenant_tokens_rolling`, `tenant_dollars_rolling`.

- Budget snapshots endpoint:
  - `GET /tenants/budget?tenant=<id>` returns views for configured budgets:
    - `tokens_window` and `usd_window` (sliding-window)
    - `tokens_monthly` and `usd_monthly` (calendar-month)
    - `tokens_rolling` and `usd_rolling` (rolling-window with `bucket_ms`)
  - Each view includes: `ok`, `window_start`, `spent`/`spent_usd`, `limit`/`limit_usd`, plus `window_ms` or `month_key` when applicable.
  - Optional auth via `TENANTS_AUTH` and IP allowlist via `TENANTS_IP_ALLOWLIST`.

- Metrics bridging:
  - Monolith emits `budget_prevented_total{scope}` and `fallback_path_total{reason}`; service aggregates them for `/metrics`.
  - This keeps low cardinality while exposing denial and fallback counters for CI and canaries.

- Storage and GC:
  - File-backed store under `${TMPDIR|TEMP|TMP|.}/urga_budget/<shard>/<shortKey>.json`.
  - GC runs periodically; emits `budget_gc_runs_total` and `budget_gc_deleted_total` counters.
  - Base TMP resolution emits `budget_tmp_base_resolved_total{source}` and `budget_tmp_base_fallback_total{source}`.
  - GC configuration via environment variables:
    - `BUDGET_GC_TTL_MS`: delete files older than this TTL (ms).
    - `BUDGET_GC_INTERVAL_MS`: scan interval (ms) for GC.
    - `BUDGET_GC_MAX_DELETES`: cap deletions per run.
    - `BUDGET_GC_MAX_RUN_MS`: cap time budget per run (ms).
    - `BUDGET_GC_SKEW_MS`: additional drift tolerance applied to TTL checks.
    - Service invokes GC on startup; tune these for operational needs.

- Operational tips:
  - Use `/metrics` to confirm increments after enabling budgets.
  - For canaries, start with generous budgets, then lower to validate 429 behavior before rollout.
  - Keep `LLM_EXPECTED_TOKENS_OUT` in sync with typical responses for accurate pre-checking.

## Rate-Limit Storage and GC

- File-backed store under `${TMPDIR|TEMP|TMP|.}/urga_rl/<shard>/<shortKey>.json`.
- GC runs periodically; emits `rl_gc_runs_total` and `rl_gc_deleted_total` counters.
- Base TMP resolution emits `rl_tmp_base_resolved_total{source}` and `rl_tmp_base_fallback_total{source}`.
- GC configuration via environment variables:
  - `RL_GC_TTL_MS`: delete files older than this TTL (ms).
  - `RL_GC_INTERVAL_MS`: scan interval (ms) for GC.
  - `RL_GC_MAX_DELETES`: cap deletions per run.
  - `RL_GC_MAX_RUN_MS`: cap time budget per run (ms).
  - `RL_GC_SKEW_MS`: additional drift tolerance applied to TTL checks.

## Idempotency and Hedging

- Purpose: ensure exactly-once cost attribution and deterministic responses across pods.
- Storage and cache:
  - In-memory LRU: `IDEMPOTENCY_CACHE` for recent replies.
  - Disk-backed: `${TMPDIR|TEMP|TMP|.}/urga_idem/<shard>/<shortKey>.json`.
  - Redis-backed (optional): `IDEMPOTENCY_REDIS_URL` enables shared cache and distributed locks.
- TTL and skew tolerance:
  - `IDEMPOTENCY_TTL_MS`: replay window for cached responses (default `30000`).
  - `IDEMPOTENCY_SKEW_MS`: additional drift tolerance in all TTL checks (default `1500`).
- Distributed duplicate gating:
  - NX lock on `idempotency_key` to gate concurrent duplicates, TTL via `IDEMPOTENCY_LOCK_TTL_MS`.
  - If lock is held elsewhere, hedge-wait up to `HEDGE_CUTOVER_MAX_WAIT_MS` for a cached replay; otherwise respond `409 duplicate_message`.
  - Emits `hedge_cutover_once_total` when a late follower replays the leader’s cached response.
  - Lock is released immediately after final reply is written.
- HMAC enforcement (optional):
  - `CONV_HMAC_SECRETS` or `CONV_HMAC_SECRET`: validates `x-client-mac` over canonical `method:path:ts`.
  - Replay-window guard: `REPLAY_WINDOW_MS` with tolerance `REPLAY_SKEW_TOLERANCE_MS`.
- Streaming hedging telemetry:
  - `event: start` includes `provider_primary` and `provider_used`.
  - `event: hedge.switch` emitted once on provider/model switch.
  - Metric: `llm_hedge_switch_total{from,to,model,source}`.

## Production Defaults

- Hedging:
  - `LLM_HEDGE_FIRST_TOKEN_MS=500` (tune via soak; minimum effective ~100ms).
  - `LLM_HEDGE_NON_STREAM_MS=300` for non-stream requests.
- Health:
  - `LLM_HEALTH_MODE=net` to include lightweight provider probes.
  - `LLM_HEALTH_NET_TIMEOUT_MS=250` for probe timeouts.
  - `LLM_HEALTH_TTL_MS=30000` to cache health results.
- Idempotency:
  - `IDEMPOTENCY_TTL_MS=60000` replay window.
  - `IDEMPOTENCY_LOCK_TTL_MS=60000` distributed duplicate lock TTL.
  - `IDEMPOTENCY_SKEW_MS=1500` tolerance applied to TTL checks.
- Budgets:
  - Set tenant token/USD limits you intend to enforce (`TENANT_*`).
  - Include `LLM_USD_PER_TOKEN_IN`, `LLM_USD_PER_TOKEN_OUT`, and `LLM_EXPECTED_TOKENS_OUT` for accurate pre-checks.
- Soft-drop:
  - `CPU_SOFT_DROP_PCT=90` to preempt under CPU pressure.
  - `RSS_SOFT_DROP_MB` just under container memory limit; jitter buckets can remain at defaults.
- Security:
  - `CONV_HMAC_SECRETS` (comma-separated; rotateable) for HMAC enforcement.
  - `CORS_ALLOWLIST` origins permitted to call conversation endpoints.
  - `REPLAY_WINDOW_MS=30000`, `REPLAY_SKEW_TOLERANCE_MS=5000` for MAC replay guards.
