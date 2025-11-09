Abuse/Jailbreak Signals and Sustained Alerting

Overview
- The service computes non-blocking signals on every turn and stream start:
  - `prompt_injection_signal` — heuristic score in [0,1] for prompt-injection patterns.
  - `jailbreak_signal` — heuristic score in [0,1] for jailbreak attempts.
  - `grounding_strength` — heuristic score in [0,1] for citation/URL/number grounding vs fantasy cues.
- Signals are surfaced in responses and SSE `stream.start` events and recorded to metrics with labels.

Endpoints
- `POST /conv/message` — JSON response includes the three signal fields.
- `GET /conv/stream` — SSE `start` payload includes the three signal fields.

Metrics
- Counters (labeled by `level` ∈ {`low`,`med`,`high`} and `source` ∈ {`explicit`,`heuristic`,`default`}):
  - `prompt_injection_signal_total`
  - `jailbreak_signal_total`
  - `grounding_strength_total`
- Sustained alert counter:
  - `abuse_spike_alert_total` (labels: `signal` ∈ {`injection`,`jailbreak`}, `source`)

Bucketing and Alert Policy
- Environment variables control sustained alerting windows:
  - `ABUSE_ALERT_BUCKET_MS` — bucket width in milliseconds (default `60000`, min `250`).
  - `ABUSE_ALERT_SUSTAINED_BUCKETS` — number of consecutive buckets to evaluate (default `3`).
  - `ABUSE_ALERT_THRESHOLD` — required count of `high` level events per bucket (default `20`).
- When, for a signal type, all of the last N buckets meet or exceed the threshold, an alert is emitted:
  - `abuse_spike_alert_total` is incremented with labels `{ signal, source }`.
  - A JSON log line is written: `{ evt: 'abuse_spike_alert', signal, engine_source, bucket_ms, threshold }`.

Heuristics (high-level)
- Prompt Injection: phrases like “ignore all instructions”, “reveal the system prompt”, “override guardrails”.
- Jailbreak: cues like “DAN”, “bypass safety”, “unfiltered”, “uncensored”, “no restrictions”.
- Grounding: increases for citations `[1]`, URLs `https://…`, numeric runs `1234`; decreases for fantasy/roleplay cues.

Usage Notes
- All signals are non-blocking and do not affect the response content.
- Use dashboards to watch `*_signal_total` counters; set alerts only on `abuse_spike_alert_total` to avoid noisy one-offs.
- `engine_source` is propagated in logs and metric labels to distinguish explicit vs heuristic routing.

Verification
- Call `/metrics` to inspect counters; each signal counter will appear with label sets per level/source.
- JSON logs include `{ evt: 'abuse_signals', prompt_injection_signal, jailbreak_signal, grounding_strength, levels, engine_source }` for traceability.

