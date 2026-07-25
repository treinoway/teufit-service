import { inject } from 'vitest';

/**
 * Runs in every E2E worker BEFORE any test module (and therefore before
 * src/db.js constructs the pg Pool). Injects the ephemeral Testcontainers
 * DATABASE_URL provided by test/e2e/global-setup.js.
 *
 * dotenv (imported by src/db.js) never overrides an already-set env var, so
 * setting it here keeps the app pointed at the throwaway container, not .env's
 * dev database.
 */
const databaseUrl = inject('DATABASE_URL');
if (databaseUrl) {
  process.env.DATABASE_URL = databaseUrl;
}
