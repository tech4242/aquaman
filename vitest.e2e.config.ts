import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000
  },
  resolve: {
    alias: {
      'aquaman-core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      'aquaman-proxy': path.resolve(__dirname, 'packages/proxy/src/index.ts'),
      'aquaman-plugin': path.resolve(__dirname, 'packages/openclaw/src/index.ts')
    }
  }
});
