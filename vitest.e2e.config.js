import { defineConfig } from 'vitest/config';

// E2E config: runs against a throwaway PostgreSQL container (Testcontainers),
// wired up in test/e2e/global-setup.js. Never touches the local/dev database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.js'],
    globalSetup: ['./test/e2e/global-setup.js'],
    // Runs per worker, before any test module imports src/db.js — points the
    // worker at its own ephemeral database (one per VITEST_POOL_ID).
    setupFiles: ['./test/e2e/setup-env.js'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    // Files run in parallel, each worker on its own database (see global-setup.js).
    // The suite mostly waits on Postgres, so workers can exceed the CPU count;
    // capped so worker pools (10 connections each) stay under max_connections.
    // Override with --maxWorkers.
    maxWorkers: 4,
    // Container start + migrations can take a while on a cold image pull.
    hookTimeout: 120000,
    testTimeout: 30000,
    env: {
      DISABLE_EMAIL: 'true',
      DISABLE_S3_UPLOAD: 'true',
      DISABLE_POSTAL_CODE_VALIDATION: 'true',
      NODE_ENV: 'test',
      ASAAS_WEBHOOK_SECRET: 'test-webhook-secret-123',
      // Cheap scrypt for the hundreds of signups/logins (honored only under NODE_ENV=test).
      PASSWORD_SCRYPT_COST: '1024',
      // AI e2e tests mock the Anthropic SDK; a placeholder key keeps the AI availability check satisfied.
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  },
});
