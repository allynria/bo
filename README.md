# Urga Service

This service provides message and stream endpoints with idempotency guarantees, distributed durability via Redis (optional), and optional HMAC enforcement for idempotency keys.

## Idempotency
- Endpoints: `POST /conv/message`, `GET /conv/stream`.
- Idempotent behavior is keyed by `Idempotency-Key` (header). Responses for a given key are cached and re-served for the TTL window without executing tools again.
- When the `IDEMPOTENCY_HMAC_SECRET` is set, requests must also include `Idempotency-MAC`, a hex `HMAC-SHA256(secret, key)` of the idempotency key. Missing or invalid MACs return `401`.

### Headers
- `Idempotency-Key`: Arbitrary string chosen by the client to deduplicate requests.
- `Idempotency-MAC`: Hex digest of `HMAC-SHA256(secret, Idempotency-Key)`. Required when `IDEMPOTENCY_HMAC_SECRET` is set.

Example (Node):

```js
import crypto from 'node:crypto';

const secret = process.env.IDEMPOTENCY_HMAC_SECRET;
const key = 'your-idempotency-key';
const mac = crypto.createHmac('sha256', secret).update(key).digest('hex');
const headers = { 'Idempotency-Key': key, 'Idempotency-MAC': mac };
```

### Environment Variables
- `IDEMPOTENCY_TTL_MS` (default `30000`): TTL window for idempotent replay.
- `IDEMPOTENCY_REDIS_URL`: Optional Redis connection URL for distributed idempotency index.
- `IDEMPOTENCY_LOCK_TTL_MS` (default `60000`): TTL for distributed stream-duplicate lock keys.
- `IDEMPOTENCY_HMAC_SECRET`: Optional secret to enforce HMAC on idempotency keys.

### Tool Isolation
- `TOOL_MEMORY_MB` (defaults vary by `NODE_ENV`): Max old-space size (MB) for isolated tool workers. Defaults: `production=128`, `dev=96`, `test=64`. Can be overridden via env.
- `TOOL_TIMEOUT_MS` (defaults vary by `NODE_ENV`): Max runtime (ms) before fail-closed termination of a tool worker. Defaults: `production=5000`, `dev=3000`, `test=2000`. Can be overridden via env.
- `TOOL_FS_ALLOWLIST`: Comma-separated paths or JSON array of absolute paths allowed for tool FS access. Default is the internal marker path `TMPDIR/urga_tool`.
- `TOOL_NET_ALLOWLIST`: Comma-separated `host` or `host:port` entries allowed for outbound requests from tools.
- `TOOL_FAIL_CLOSED` (default `1`): When enabled, any operation not explicitly allowlisted is denied.
- `TOOL_NET_TIMEOUT_MS` (default `3000`): Per-request timeout used by network probes inside the worker.

Supported worker operations (`TOOL_OP`):
- `mark`: Write an exactly-once marker file (used by idempotency tool markers).
- `net_probe`: HEAD a URL to check reachability (subject to allowlist).
- `fetch_url`: GET a URL and report `statusCode` and `bytes`.
- `post_json`: POST a JSON body to a URL and report `statusCode` and `bytes`.
- `write_file`: Write base64 content to a path within the FS allowlist.
- `read_file`: Read a file and return base64 content.
- `read_json`: Read and parse a JSON file.

IPv6 note: when targeting IPv6 literals, use bracketed URLs (e.g., `http://[::1]:8080/`). In `TOOL_NET_ALLOWLIST`, allow `host:port` without brackets (e.g., `::1:8080`).

Example (allowlist allow): start a local HTTP server and permit `127.0.0.1:<port>` in `TOOL_NET_ALLOWLIST`, then use the worker op `fetch_url` to GET that URL. The worker exits `0` with `{ ok: true, statusCode: 200, bytes: N }` when allowed.

### Redis-backed Durability (Optional)
- When `IDEMPOTENCY_REDIS_URL` is set, idempotent entries are persisted to Redis under `idem:val:<key>` with `EX` TTL matching `IDEMPOTENCY_TTL_MS`.
- The stream endpoint uses `idem:lock:<key>` (`NX` + `PX`) to gate duplicates across pods. Locks are released on stream end.
- The service gracefully degrades to file-backed artifacts and in-memory LRU when Redis is unavailable.

### Dev/Staging Validation
1. Set `IDEMPOTENCY_REDIS_URL` to your cluster Redis (or local instance) and deploy to multiple pods.
2. Send concurrent requests across pods with the same `Idempotency-Key`:
   - Message: the second and subsequent should replay with `idempotent_replay: true`.
   - Stream: concurrent attempts should return `409 duplicate_stream` while one stream is active.
3. Confirm entries are present in Redis and expire after `IDEMPOTENCY_TTL_MS`.

## Scripts
- `npm test`: Runs the full test suite, including idempotency and HMAC enforcement.
- `npm run start`: Starts the service locally.

## Operational Scripts & Guards
- `scripts/repo-guards.sh`: Fails CI if tracked artifacts reappear, if `Dockerfile` is missing a `HEALTHCHECK`, if `/healthz` or `/readyz` endpoints are absent, or if graceful shutdown hooks (`SIGTERM|SIGINT` + `server.close()`) are missing. Why: enforce production guarantees and keep the repository clean.
- `scripts/config-guard.mjs`: Gates dev/debug features and sensitive endpoints based on environment configuration, ensuring debug/heap features do not ship in production. Why: harden production behavior and reduce risk.
- `scripts/service.js`: Exposes `GET /healthz` (liveness) and `GET /readyz` (readiness). Registers signal handlers and calls `server.close()` to drain connections for graceful shutdown. Why: healthy orchestration and safe rollouts.
- `.github/workflows/repo-guards.yml`: Runs `scripts/repo-guards.sh` on PRs and pushes to `main`. Why: prevent regressions from bypassing reviews.
- `.github/workflows/image-security.yml`: Scans container images for known vulnerabilities as part of CI. Why: supply chain and image security.
- `Dockerfile` `HEALTHCHECK`: Probes `/healthz` within the container. Why: early detection of stalled or unhealthy processes.

### Artifact Policy
- Ignored by `.gitignore`: `coverage/`, `dist/`, `build/`, `tmp/`, `tmp_rl/`, `var/usage/`, `out.txt`, `errs.txt`, `probe.txt`, `rename-probe.txt`, `test_output*.txt`, `tmp.kill.write.json*`, `janitor_guard_*.*`, `enospc.trigger.txt`.
- Why: prevent bulky or ephemeral artifacts from polluting the repository and slowing clones.
- CI guard: the repo guard fails if any of these files are tracked.
- History: artifacts were purged from Git history to reduce repository size; collaborators should rebase or re-clone after a history rewrite.

## Notes
- Exactly-once tool markers are written by an isolated worker subprocess with strict FS/network allowlists and memory/time caps. Policy defaults to fail-closed.

### Testing: Duplicate Gating
- Stream duplicates: Covered by `scripts/tests/idempotency_duplicate_contract.test.mjs` using `URGA_PROVIDER=stub-flaky` and `FLAKY_STALL_MS` to hold an active stream. Second concurrent request with the same `Idempotency-Key` returns `409 duplicate_stream` while the first is active.
- Message duplicates (Redis lock): The same test file includes a case that exercises distributed duplicate gating via a Redis `NX` lock. This test is gated by `RUN_IDEMPOTENCY_REDIS_LOCK_TESTS=1` to avoid CI flakiness when Redis is unavailable.
- To run Redis lock coverage locally:
  - Set `IDEMPOTENCY_REDIS_URL` to a reachable Redis (or use a simple stub) and `IDEMPOTENCY_LOCK_TTL_MS` to a suitable value.
  - Run: `RUN_IDEMPOTENCY_REDIS_LOCK_TESTS=1 npm test`.
- Env controls relevant to duplicate gating:
  - `IDEMPOTENCY_TTL_MS`: TTL for replay and active-stream gating.
  - `IDEMPOTENCY_LOCK_TTL_MS`: TTL for distributed locks.
  - `SSE_HEARTBEAT_MS`: Keepalive cadence for streams.
  - `HEDGE_CUTOVER_MAX_WAIT_MS`: Short wait for hedged replay on message duplicates.

### Local Dev Probe
- Quick manual validation: `node scripts/dev_probe_idem_dups.mjs`.
- Optional: set `IDEMPOTENCY_REDIS_URL` to a local Redis (e.g., `redis://localhost:6379`) to exercise the lock path.
- The probe runs two scenarios:
  - `duplicate_stream`: opens one SSE stream and confirms concurrent duplicate returns `409 duplicate_stream`.
  - `duplicate_message`: fires two concurrent POSTs with the same `Idempotency-Key`; the second returns `409 duplicate_message` when a lock is held.

## Production Defaults
- Hedging:
  - `LLM_HEDGE_FIRST_TOKEN_MS=500` (stream hedge threshold)
  - `LLM_HEDGE_NON_STREAM_MS=300` (non-stream hedge threshold)
- Health:
  - `LLM_HEALTH_MODE=net` (include lightweight provider probes)
  - `LLM_HEALTH_NET_TIMEOUT_MS=250`
  - `LLM_HEALTH_TTL_MS=30000`
- Idempotency:
  - `IDEMPOTENCY_TTL_MS=60000`
  - `IDEMPOTENCY_LOCK_TTL_MS=60000`
  - `IDEMPOTENCY_SKEW_MS=1500`
- Budgets:
  - Configure `TENANT_*` caps you intend to enforce.
  - Include `LLM_USD_PER_TOKEN_IN`, `LLM_USD_PER_TOKEN_OUT`, `LLM_EXPECTED_TOKENS_OUT` for accurate pre-checks.
- Soft-drop:
  - `CPU_SOFT_DROP_PCT=90`
  - `RSS_SOFT_DROP_MB` just under container memory limit.
- Security:
  - `CONV_HMAC_SECRETS` (comma-separated; rotateable)
  - `CORS_ALLOWLIST` origins permitted to call conversation endpoints.
  - `REPLAY_WINDOW_MS=30000`, `REPLAY_SKEW_TOLERANCE_MS=5000` for MAC replay guards.

## Production Requirements
- Set `IDEMPOTENCY_REDIS_URL` in production to enable distributed locks and avoid cross-pod duplicates. Without Redis, concurrent requests with the same idempotency key can race across pods.
- Keep metrics low-cardinality:
  - Do not include `request_id`, `conv_id`, or `mac_id` as labels on counters.
  - Those identifiers belong in logs/NDJSON ledger and traces; use coarse labels like `reason`, `status`, `path`, `provider`, `model` for counters.

See `.env.example` for a ready-to-copy set of defaults.
-
## Scripts & Behaviors Overview
- `scripts/core.mjs`: Core service orchestration and integration glue for endpoints and subsystems.
- `scripts/service.js`: HTTP service entrypoint, health probes (`/healthz`, `/readyz`), graceful shutdown.
- `scripts/state/`: Static configuration for world state and refusal templates; shapes persistent defaults.
- `scripts/memory/`: Memory subsystem — LRU-like stores, audit, judge/labeler, booster, shadow, transcript, arcs; enforces memory shaping, selection, and retention policies.
- `scripts/spine/` and `scripts/state/character_spine.mjs`: Character “spine” orchestration — ties style and scene to produce consistent outputs.
- `scripts/style/`: Style and hedging utilities (booster, hedge, phrase decay, prefs); governs output cadence and hedged behaviors.
- `scripts/scene/`: Scene construction and cadence management (beat detection, scheduler, conclusions).
- `scripts/loopguard/`: Loop guard and entropy controls to prevent runaway loops; cadence and phrase decay maps.
- `scripts/determinism/`: Golden freeze and verification; ensures deterministic outputs under guarded conditions.
- `scripts/critics/` and `scripts/memory/constraint_critic.mjs`: Constraint critics — validate outputs against policies and constraints.
- `scripts/failroll/`: Failure roll orchestration and cooldown mechanics; used by probes/tests to validate resilience paths.
- `scripts/signals/`: Signal bus and SSE-related helpers; coordinates asynchronous events.
- `scripts/probes_run_all.mjs`: Runs a suite of probes for quick local validation.
- `scripts/dev_*`: Development probes (e.g., SSE replay, provider env checks, dreams/tension streams, AB restarts); each targets a specific behavior for manual validation.
- `scripts/ci/contract_check.mjs`: Validates exported API/contract stability; fails CI on breaking changes.
- `scripts/ci/auto_rollback_gate.mjs`: Gating for auto-rollback on failure signals; conservative guard to prevent bad deploys.
- `scripts/ci/first_token_gate.mjs`: Ensures acceptable first-token latency under load; can be used as perf guard.
- `scripts/soak_budget_gate.mjs`: Soak testing budget gate; enforces throughput or spend constraints over time.
- `scripts/soak_failover_hedge.mjs`: Validates failover/hedging behavior during long-running or degraded scenarios.
- `scripts/sdk/`: OpenAPI-based SDK generation helpers.
- `scripts/contract.mjs` and `scripts/conv/`: Contract definitions and conversation helpers; keep API types consistent.
- `scripts/tests/`: Test suite (unit/integration) covering resilience, memory shaping, rate limiting, GC safety, header caps, and tool policy lint.
