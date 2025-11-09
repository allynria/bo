SSE Resilience & UX Guidance

- Heartbeats: Server sends `:keepalive` every `SSE_HEARTBEAT_MS` (default 15000). Configure via env `SSE_HEARTBEAT_MS`. Clients should treat colon-prefixed lines as comments and not render them.
- Reconnect: On network error or server close, reconnect with jittered backoff (e.g., 250ms × 2^n, max 2s). Include the same `Idempotency-Key` and `?replay=1` to receive a cached final when available.
- Idempotent replay: Pass `Idempotency-Key` on the initial stream; on reconnect use `?replay=1` or header `x-reconnect: 1`. Server emits `idempotent_replay: true` in the `end` event payload when served from cache.
- Hedging: Clients can subscribe to `hedge.switch` events to trace provider/model switchovers during streaming. The `start` payload includes `provider_primary` and `provider_used` for context.
- UTF‑8 validation: Server sanitizes SSE `delta` texts and the `final` payload, replacing invalid surrogate code units with `U+FFFD`. This prevents parse/render errors for consumers.
- Memory stability: The server tracks active streams and prunes with TTL (`IDEMPOTENCY_TTL_MS`) and LRU caps (`ACTIVE_STREAMS_MAX_ITEMS`). Gauge `active_streams_current` appears in `/metrics` for health checks.

Backoff Example

- Attempt 1: immediate reconnect (0 ms)
- Attempt 2: 250 ms
- Attempt 3: 500 ms
- Attempt 4: 1000 ms
- Attempt 5+: min(2000 ms, 250 ms × 2^n) with ±30% jitter
- Reset backoff after a stable stream lasts ≥ 60 seconds

Request ID

- Read `x-request-id` from the SSE HTTP response headers on connect.
- Also available in the `event: start` JSON payload as `request_id` for correlation with logs and traces.

Client Checklist

- Parse `event: start`, `event: delta`, `event: hedge.switch`, `event: end`; ignore `:keepalive`.
- Buffer deltas, render progressively, and verify `end.final` equals concatenated deltas when the stream completes.
- On disconnect, reconnect using the same `Idempotency-Key` to avoid duplicate work and get `end.final` quickly.
- Implement bounded backoff with jitter and give up or surface feedback after a reasonable cap.

Env Controls

- `SSE_HEARTBEAT_MS`: Interval for `:keepalive` heartbeats; set lower in mobile networks.
- `IDEMPOTENCY_TTL_MS`: TTL for replay and active-stream duplicate gating.
- `ACTIVE_STREAMS_MAX_ITEMS`: LRU cap for active stream tracking.

Testing Notes

- Invalid UTF‑8 sanitizer is covered by `scripts/tests/sse_utf8_validation.test.mjs` using a stub provider that emits a stray surrogate.
- Disconnect/replay path is covered by `scripts/tests/sse_disconnect_replay_concat.test.mjs` and checks that `final` starts with the buffered deltas.
- Memory flatness soak is covered by `scripts/tests/sse_memory_flatness_soak.test.mjs`, asserting `active_streams_current` remains bounded.
