import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // E2E has its own config (vitest.e2e.config.js) — it needs a Testcontainers
    // Postgres. Excluding it here keeps unit runs and watch mode from ever
    // touching a real database.
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    // No database here (e2e is excluded above), so files run in parallel.
    env: {
      DISABLE_EMAIL: 'true',
      DISABLE_S3_UPLOAD: 'true',
      NODE_ENV: 'test',
      // Applied before any module is imported, unlike mutating process.env in
      // beforeAll — config/index.js reads process.env once at top-level import time,
      // so setting this later has no effect on the cached config snapshot.
      ASAAS_WEBHOOK_SECRET: 'test-webhook-secret-123',
      // AI tests mock the Anthropic SDK; a placeholder key keeps the AI availability check satisfied.
      ANTHROPIC_API_KEY: 'test-anthropic-key',
    },
  },
});
