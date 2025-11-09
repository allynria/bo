#!/usr/bin/env bash
# why: hard fail CI if critical prod guarantees regress
set -euo pipefail

red() { printf "\e[31m%s\e[0m\n" "$*"; }
green() { printf "\e[32m%s\e[0m\n" "$*"; }

fail() { red "❌ $*"; exit 1; }
pass() { green "✅ $*"; }

# 1) node_modules must NOT be tracked
if git ls-tree -r --name-only HEAD | grep -qE '^node_modules/'; then
  fail "node_modules/ is tracked in git"
else
  pass "node_modules/ not tracked"
fi

# 2) Dockerfile must contain HEALTHCHECK
if grep -q '^HEALTHCHECK ' Dockerfile; then
  pass "Dockerfile has HEALTHCHECK"
else
  fail "Dockerfile missing HEALTHCHECK"
fi

# 3) Service must expose /healthz and /readyz (grep JS/TS sources)
if grep -R -nE '/healthz\b' --include='*.{js,mjs,ts,tsx}' scripts/ monolith.js 2>/dev/null; then
  pass "/healthz found"
else
  fail "No /healthz endpoint detected"
fi

if grep -R -nE '/readyz\b' --include='*.{js,mjs,ts,tsx}' scripts/ monolith.js 2>/dev/null; then
  pass "/readyz found"
else
  fail "No /readyz endpoint detected"
fi

# 4) Graceful shutdown signals + server.close
if grep -R -nE 'SIGTERM|SIGINT|process\.on\(' --include='*.{js,mjs,ts,tsx}' scripts/ monolith.js 2>/dev/null \
  && grep -R -nE 'server\.close\(' --include='*.{js,mjs,ts,tsx}' scripts/ monolith.js 2>/dev/null; then
  pass "Graceful shutdown detected"
else
  fail "Graceful shutdown not detected (signals + server.close)"
fi

pass "Repo guards passed"
