# Observability & Tracing

- Enable tracing: set `OTEL_ENABLED=1`. The service dynamically imports `@opentelemetry/api` and exposes `globalThis.__OTEL_TRACER__` and `globalThis.__RID_STORE__`.
- Request ID: every HTTP request receives an `x-request-id`. This ID propagates via `AsyncLocalStorage` and is attached to spans as `request_id`.

## FS Instrumentation

- Head sampling: `OTEL_FS_SAMPLE_HEAD_RATE` (e.g., `0.05` for 5%). When enabled:
  - `AsyncFS.writeFileAtomic` uses `fs.writeFileAtomic` spans
  - `AsyncFS.appendFile` uses `fs.appendFile` spans
  - `AsyncFS.readFile` uses `fs.readFile` spans
  - `computeFileHash` uses `fs.computeFileHash` spans
  - `__acquireLock__` uses `fs.acquireLock` spans
- Tail-slow: `OTEL_FS_TAIL_SLOW_MS` (e.g., `50`). If a call exceeds this, a tail span is emitted even when head-sampled off.

## Handler Instrumentation

- `wrapChatHandler` spans: head sampling via `OTEL_HANDLER_SAMPLE_HEAD_RATE`, tail-slow via `OTEL_HANDLER_TAIL_SLOW_MS`.
- Attributes include `request_id` and latency `handler.dur_ms`.

## JSON Logs & Redaction

- Production JSON logs: set `NODE_ENV=production` and `LOG_JSON=1` to enforce JSON-only logs.
- Redaction covers `Authorization`, cookies, API keys, JWT-like tokens, emails, and US phone numbers.

## Metrics

- Built-in counters and histograms record arrivals/completions, rate limits, rename retries, lock waits, and rss ceiling breaches.
- See `docs/SLOs.md` for SLOs and soak gating thresholds.

## Notes

- If `@opentelemetry/api` is not installed, tracing is a no-op; code paths are safe.
- Tracing attributes prefer minimal cardinality (`fs.path`, durations, simple booleans). Avoid attaching high-cardinality payloads.

