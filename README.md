# Project Overview

This service provides a streaming conversation endpoint with in-process metrics for CI validation and diagnostics. Recent improvements include first-token latency buckets and overall stream duration metrics, plus CI gates to enforce performance thresholds.

## Getting Started

- Start the service locally:
  - `PORT=3000 node scripts/service.js`
- Health check:
  - `GET /healthz`
- Metrics snapshot:
  - `GET /metrics` returns counters with labels.

## Performance Gates (CI)

Two CI scripts assert performance distributions based on emitted metrics:

- `scripts/ci/first_token_gate.mjs`
  - Spawns the service and fires concurrent `/conv/stream` requests.
  - Reads `first_token_ms_bucket` counters and ensures a minimum percentage under `FIRST_TOKEN_THRESHOLD_MS`.
  - Env (defaults shown):
    - `FIRST_TOKEN_THRESHOLD_MS=300`
    - `FIRST_TOKEN_MIN_PCT_UNDER=90`
    - `STREAM_REQUESTS=40`
    - `CONCURRENCY=4`

- `scripts/ci/stream_duration_gate.mjs`
  - Waits for the `end` event and asserts `stream_duration_ms_bucket` distribution.
  - Env (defaults shown):
    - `STREAM_DURATION_THRESHOLD_MS=5000`
    - `STREAM_DURATION_MIN_PCT_UNDER=90`
    - `STREAM_REQUESTS=24`
    - `CONCURRENCY=4`

Both gates use stubbed providers in CI via env:

```
SPAWN_SERVICE=1
LOG_JSON=1
NODE_ENV=production
LLM_TEST_STUBS=1
URGA_PROVIDER=stub-urga
LLM_TURN_BUDGET=5
CONV_RATE_MAX=1000
CONV_RATE_WINDOW=2000
CONV_SOFT_MAX=5000
CONV_SOFT_WINDOW_MS=2000
CONV_AUTH=test-token
STREAM_ENGINE=urga
```

### Per-engine thresholds

Configure default thresholds per engine in `scripts/ci/engines.json`. Environment variables still override any values.

Example:

```
{
  "urga": {
    "first_token_threshold_ms": 300,
    "first_token_min_pct_under": 90,
    "first_token_requests": 40,
    "stream_duration_threshold_ms": 5000,
    "stream_duration_min_pct_under": 90,
    "stream_requests": 24,
    "concurrency": 4
  }
}
```

Set `STREAM_ENGINE` to pick an engine’s defaults.

## Metrics

- `first_token_ms_bucket{le}`: counts per latency bucket until first `delta` event.
- `stream_duration_ms_bucket{le}`: counts per bucket from stream start to `end` event.
- `stream_duration_last_ms`: last observed duration (ms).

Selected counters are also summarized for dashboards:

- `summary_auth{kind=ok|blocked}`: aggregated auth successes and blocks
- `summary_rate{kind=limited}`: aggregated rate-limit count
- `summary_responses{status}`: aggregated responses by HTTP status

Bucket boundaries are defined in `scripts/service.js` and cover common thresholds used in CI:

- `FIRST_TOKEN_MS_BUCKETS = [50, 100, 200, 300, 500, 800, 1200, 2000, 3000, 5000, 8000, 12000]`
- `STREAM_DURATION_MS_BUCKETS = [500, 800, 1200, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 60000]`

## Running Locally

First-token gate:

```
node scripts/ci/first_token_gate.mjs
```

Stream-duration gate:

```
node scripts/ci/stream_duration_gate.mjs
```

You can override thresholds:

```
FIRST_TOKEN_THRESHOLD_MS=250 FIRST_TOKEN_MIN_PCT_UNDER=95 node scripts/ci/first_token_gate.mjs
STREAM_DURATION_THRESHOLD_MS=3000 STREAM_DURATION_MIN_PCT_UNDER=95 node scripts/ci/stream_duration_gate.mjs
```

## Notes

- The CI workflow `.github/workflows/perf-gates.yml` runs both gates on pushes and pull requests to `main`/`master`.
- For private metrics or auth, you can pass `METRICS_AUTH` via repository secrets and extend the gate scripts accordingly.
