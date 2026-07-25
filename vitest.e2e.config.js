import { defineConfig } from 'vitest/config';

// E2E config: runs against a throwaway PostgreSQL container (Testcontainers),
// wired up in test/e2e/global-setup.js. Never touches the local/dev database.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.test.js'],
    globalSetup: ['./test/e2e/global-setup.js'],
    // Runs per worker, before any test module imports src/db.js — sets the
    // ephemeral DATABASE_URL from the container.
    setupFiles: ['./test/e2e/setup-env.js'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    // Sequential — avoids TRUNCATE deadlocks between e2e files sharing the DB.
    fileParallelism: false,
    // Container start + migrations can take a while on a cold image pull.
    hookTimeout: 120000,
    testTimeout: 30000,
    env: {
      DISABLE_EMAIL: 'true',
      DISABLE_S3_UPLOAD: 'true',
      DISABLE_POSTAL_CODE_VALIDATION: 'true',
      NODE_ENV: 'test',
      ASAAS_WEBHOOK_SECRET: 'test-webhook-secret-123',
    },
  },
});
