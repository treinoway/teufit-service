#!/usr/bin/env bash
set -euo pipefail

# Run from repo root
cd "$(dirname "$0")/.."

# Default test DATABASE_URL if not already set
export DATABASE_URL="${DATABASE_URL:-postgresql://treinoway_user:treinoway_password@localhost:5433/treinoway_db?schema=public}"

echo "[e2e] Starting test Postgres via docker compose..."
docker compose up -d postgres

echo "[e2e] Waiting for Postgres to be healthy..."
for i in {1..30}; do
  STATUS=$(docker inspect --format='{{json .State.Health.Status}}' treinoway_postgres 2>/dev/null || echo "null")
  if echo "$STATUS" | grep -q '"healthy"'; then
    echo "[e2e] Postgres is healthy."
    break
  fi
  echo "[e2e] Still waiting for Postgres... ($i/30)"
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "[e2e] Postgres did not become healthy in time" >&2
    exit 1
  fi
done

echo "[e2e] Applying Prisma migrations to test database..."
npm run db:migrate:deploy

echo "[e2e] Running Vitest e2e suite..."
DISABLE_POSTAL_CODE_VALIDATION=true npx vitest run test/e2e

echo "[e2e] Stopping test Postgres and removing volumes..."
docker compose down -v
