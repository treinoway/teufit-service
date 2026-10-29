import { inject } from 'vitest';

/**
 * Runs in every E2E worker BEFORE any test module (and therefore before
 * src/db.js constructs the pg Pool). Points the worker at its own ephemeral
 * Testcontainers database (one per VITEST_POOL_ID, created by
 * test/e2e/global-setup.js), so parallel files never share rows.
 *
 * dotenv (imported by src/db.js) never overrides an already-set env var, so
 * setting it here keeps the app pointed at the throwaway container, not .env's
 * dev database. A missing entry throws instead of falling back to .env.
 */
const databaseUrl = inject('DATABASE_URLS')?.[process.env.VITEST_POOL_ID];
if (!databaseUrl) {
  throw new Error(`No e2e database for VITEST_POOL_ID=${process.env.VITEST_POOL_ID}; check test/e2e/global-setup.js`);
}
process.env.DATABASE_URL = databaseUrl;
