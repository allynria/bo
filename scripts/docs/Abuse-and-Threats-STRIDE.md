# STRIDE: Abuse & Threats Overview (LLM Service)

This one‑page map summarizes key threats to the service using STRIDE, with practical mitigations implemented or planned. It focuses on the LLM gateway, provider orchestration, and HTTP endpoints.

## Spoofing
- Credential spoofing (API keys, auth headers) via compromised env or headers.
- Mitigations: secrets gate (`secrets_ok`), log redaction, restricted `/readyz` with allowlist, per‑tenant budget guards.

## Tampering
- Prompt or response tampering through middleboxes or client proxies.
- Mitigations: prompt scrubbing before provider calls, UTF‑8 sanitizer for streamed deltas, idempotency cache to detect replay variations.

## Repudiation
- Ambiguous accountability for actions originating from generated content.
- Mitigations: request IDs (`x-request-id`), probe vs. work separation, minimal event telemetry, metrics snapshots for audit.

## Information Disclosure
- Leakage of secrets/PII in outbound provider payloads or logs.
- Mitigations: outbound PII scrubbing (`__scrubText__`), JSON‑only logs in production, healthz minimal mode, redaction patterns for tokens, cookies, emails, phone numbers.

## Denial of Service
- Backpressure overload, excessive concurrency, budget exhaustion.
- Mitigations: queue depth gating (`QUEUE_MAX`), sustained BP detection (`BP_SUSTAIN_MS`), global rate limiter, per‑conversation soft window, circuit breaker (`CB`).

## Elevation of Privilege
- Jailbreak or injection causing provider to execute unintended actions.
- Mitigations: abuse detectors (injection/jailbreak signal buckets), grounding strength heuristic, hedged generation with safe fallback, variant A/B isolation when needed.

## Operational Notes
- `checkSecrets()` marks service not ready when required envs are missing; `/healthz` surfaces `secrets_ok` and `missing_secrets`.
- Use stub providers (`LLM_TEST_STUBS=1`) in CI to avoid external calls and prevent secret dependencies.
- Keep env‑driven providers explicit (`URGA_PROVIDER`, `ECHO_PROVIDER`, `DREAMS_PROVIDER`) to limit accidental exposure.

