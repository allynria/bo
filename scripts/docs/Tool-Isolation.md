# Tool Isolation Hardening

This document describes per-tool POLA (Principle of Least Authority) policies and OS-level confinement examples for isolated workers.

## JSON Policy (v1)

Each tool declares a JSON policy with least authority:

```
{
  "version": 1,
  "tool": "echo",
  "idempotent_op_name": "mark", // optional
  "fs": { "allow": ["C:/tools/echo/tmp", "/var/lib/tools/echo"] },
  "net": { "allow": ["localhost", "example.com:443"] },
  "limits": { "memory_mb": 64, "timeout_ms": 2000 }
}
```

- `fs.allow`: absolute paths the tool may read/write (recursive).
- `net.allow`: hostnames or `host:port` entries the tool may contact.
- `limits.timeout_ms`: hard cap enforced by the worker.
- `limits.memory_mb`: recommended cap; configure process `--max-old-space-size` in the launcher.
- `idempotent_op_name`: optional declaration when the tool’s idempotent operation must be enforced.

### Minimal Example: Single Directory, No Network

Realistic minimal policy for a file-only tool that reads/writes one directory and has no network access:

```
{
  "version": 1,
  "tool": "report-generator",
  "fs": { "allow": ["/var/app/work"] },
  "net": { "allow": [] },
  "limits": { "memory_mb": 128, "timeout_ms": 5000 }
}
```

- Windows path variant: use `"C:/app/work"` under `fs.allow`.
- Recommend setting `TOOL_NO_NETWORK=1` to enforce no-network at runtime in addition to the empty allowlist.

## Enforcement

- The worker fails closed when `TOOL_POLICY_REQUIRED=1` and no policy is found.
- When the policy’s `net.allow` is empty and `TOOL_POLICY_REQUIRED=1`, the worker requires `--no-network` (or `TOOL_NO_NETWORK=1`) and fails closed otherwise.
- FS and NET allowlists are enforced at syscall boundary via path checks and HTTP/HTTPS/fetch patching.
- Timeout cap: the worker exits with code `124` if the cap elapses.

## Configuration

- Provide the policy via `TOOL_POLICY_JSON`, `TOOL_POLICY_PATH`, or `TOOL_POLICY_DIR` + `TOOL_NAME`.
- Existing env-based allowlists (`TOOL_FS_ALLOWLIST`, `TOOL_NET_ALLOWLIST`) remain supported when a policy is not required or not present.

## Seccomp Profile Sample

See `scripts/docs/seccomp-no-network.json` for a minimal seccomp profile that denies socket-related syscalls to enforce no-network workers.

## AppArmor Profile Sample

See `scripts/docs/apparmor-tool-worker.profile` for an example AppArmor profile that confines file access to declared directories and denies network.

## CI Checks

- Tests verify policy linting, fail-closed behavior when policy is missing, and `--no-network` enforcement when `net.allow` is empty.
- Integrate `npm test` in CI to run `scripts/tests/*.test.mjs` which includes these checks.
