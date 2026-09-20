import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Build workspace dists if missing: e2e tests spawn CLIs from source,
    // and those child processes don't get vitest's aliases.
    globalSetup: ['./test/helpers/ensure-build.ts'],
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts', 'test/integration/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000
  },
  resolve: {
    alias: {
      'aquaman-core': path.resolve(__dirname, 'packages/proxy/src/core/index.ts'),
      'aquaman-proxy': path.resolve(__dirname, 'packages/proxy/src/index.ts'),
      'aquaman-plugin': path.resolve(__dirname, 'packages/plugin/src/index.ts')
    }
  }
});
