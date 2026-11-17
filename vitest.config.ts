import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'mock-core/**/*.test.ts'],
    globalSetup: ['test/helpers/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 120000,
  },
});
