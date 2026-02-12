import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000
  },
  resolve: {
    alias: {
      'aquaman-core': resolve(__dirname, '../proxy/src/core/index.ts'),
      'aquaman-proxy': resolve(__dirname, '../proxy/src')
    }
  }
});
