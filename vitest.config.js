import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    restoreMocks: true,
    clearMocks: true,
    mockReset: true,
    env: {
      DISABLE_EMAIL: 'true',
      NODE_ENV: 'test',
    },
  },
});
