import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    // Run e2e tests sequentially to avoid database deadlocks with TRUNCATE
    fileParallelism: false,
    env: {
      DISABLE_EMAIL: 'true',
      DISABLE_S3_UPLOAD: 'true',
      NODE_ENV: 'test',
    },
  },
});
