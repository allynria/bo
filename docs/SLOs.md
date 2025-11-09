# Service SLOs

- Latency SLOs: `respond_ms`
  - P50 ≤ 5 ms
  - P95 ≤ 15 ms
  - P99 ≤ 25 ms
  - CI soak gate fails if P99 exceeds target or >10% regression from baseline.

- Error budgets
  - 4xx policy: ≤ 0.1% of total requests (intentional client errors excluded)
  - 429 per-client: ≤ 1% under normal load, may exceed during abuse; monitored
  - 5xx capacity/backpressure: ≤ 0.05% sustained; any spike triggers investigation

- Backpressure thresholds
  - `QUEUE_MAX` tuned per instance; gating starts at `effectiveDepth >= QUEUE_MAX`
  - `BP_SUSTAIN_MS` default 2000 ms; sustained backpressure emits alerts and counters

- Memory budgets
  - `--max-old-space-size` pinned via `NODE_OPTIONS` for CI runs
  - RSS ceiling alert: `RSS_CEILING_MB` configurable; breach emits `rss_ceiling_breach_total`
  - Soak budget: RSS monotonic growth ≤ 5%; heap snapshot size proxy ≤ 5%
