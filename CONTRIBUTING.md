# Contributing

Thanks for your interest in contributing. This repo runs a service with a few environment gates and local flows worth understanding before making changes.

## Environment Gates

- `READYZ_AUTH`: When set, the `/readyz` endpoint requires a matching token. Provide via `Authorization: Bearer <token>` or `?token=...`.
- `READYZ_IP_ALLOWLIST`: Optional comma-separated allowlist of IPs permitted to hit readiness endpoints (e.g., `127.0.0.1,10.0.0.2`). When unset or empty, all IPs are allowed.
- `ADMIN_TOKEN`, `TENANTS_AUTH`, `CONV_AUTH`: Tokens used for privileged routes. Pass through headers or query. Do not log tokens.
- Provider secrets (e.g., model API credentials) gate service readiness. Missing required secrets will mark the service not ready until supplied.

## Local Run Flows

- Start the service: `npm start` or `node scripts/service.js`. Defaults to port `3000`; override via `PORT`.
- Quick probes: `npm run probes` to exercise dreams stream and provider env checks.
- Tests: `npm run test:fast` for the core suite; use `npm run test:all` for full coverage. CI runs the fast suite and probes.
- Typecheck: `npm run typecheck` verifies exported TypeScript types without emitting.
- Lint: `npm run lint` enforces structural guardrails (complexity, max-lines). No style rules are enabled.
- Format: `npm run format` applies Prettier; `npm run format:check` validates formatting.

## Coding Guidelines

- Favor stateless helpers under `scripts/utils/` to keep `scripts/service.js` focused on orchestration. Avoid behavior changes during refactors; extract helpers first, then wire calls incrementally.
- Keep changes minimal and targeted. Do not reformat unrelated files during logical edits; use formatting scripts separately.
- Avoid introducing new runtime dependencies without discussion.

## Submitting Changes

1. Ensure `npm run lint`, `npm run typecheck`, and `npm run test:fast` pass locally.
2. Open a PR targeting `main`. CI will run lint, typecheck, tests, probes, and upload coverage artifacts.
3. Describe any environment variables used and assumptions about local/CI runs.

