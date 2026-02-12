import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      exclude: ['src/cli/index.ts', 'src/types.ts', 'packages/*/src/cli/**'],
      // Core business logic has 86-98% coverage
      // WebSocket/HTTP proxies have lower coverage (integration tests)
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60
      }
    }
  },
  resolve: {
    alias: {
      // Map package imports to source for development/testing
      'aquaman-core': path.resolve(__dirname, 'packages/proxy/src/core/index.ts'),
      'aquaman-proxy': path.resolve(__dirname, 'packages/proxy/src/index.ts'),
      'aquaman-plugin': path.resolve(__dirname, 'packages/plugin/src/index.ts')
    }
  }
});
