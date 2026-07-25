#!/usr/bin/env bash
set -euo pipefail

# Run from repo root
cd "$(dirname "$0")/.."

# E2E runs against a throwaway PostgreSQL container spun up by Testcontainers
# (see test/e2e/global-setup.js). It NEVER touches the local/dev database or its
# Docker volume — no `docker compose up`, no `down -v`. Requires a running Docker
# daemon. Any DATABASE_URL in the environment is ignored (the container provides
# its own, injected per worker via test/e2e/setup-env.js).
echo "[e2e] Running Vitest e2e suite (ephemeral Postgres via Testcontainers)..."
npx vitest run --config vitest.e2e.config.js
