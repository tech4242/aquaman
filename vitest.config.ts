import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Build workspace dists if missing: e2e tests spawn CLIs from source,
    // and those child processes don't get vitest's aliases.
    globalSetup: ['./test/helpers/ensure-build.ts'],
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // This config runs every suite at once, the ones that start processes
    // included. A worker can be kept off the CPU for seconds by that, which is
    // not the test being slow, so the limit leaves room for it.
    testTimeout: 15000,
    // Tests start the CLI and the daemon as separate processes. This hands those
    // processes a directory to write their own coverage into (see scripts/coverage.mjs).
    setupFiles: ['./test/helpers/child-coverage.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json', 'json-summary', 'lcov', 'html'],
      // A failed or flaky test must not hide the numbers.
      reportOnFailure: true,
      // Everything that ships: all three packages, both CLIs and the plugin's entry file.
      include: ['packages/*/src/**/*.ts', 'packages/plugin/index.ts'],
      // Files that only re-export other modules have nothing to execute.
      exclude: [
        'packages/proxy/src/index.ts',
        'packages/proxy/src/core/index.ts',
        'packages/proxy/src/core/utils/index.ts',
        'packages/proxy/src/core/audit/index.ts',
        'packages/proxy/src/core/credentials/index.ts',
      ],
    }
  },
  resolve: {
    alias: {
      // Map package imports to source for development/testing
      'aquaman-core': path.resolve(__dirname, 'packages/proxy/src/core/index.ts'),
      'aquaman-proxy': path.resolve(__dirname, 'packages/proxy/src/index.ts'),
      'aquaman-plugin': path.resolve(__dirname, 'packages/plugin/index.ts'),
      'aquaman-coder': path.resolve(__dirname, 'packages/coder/src/index.ts')
    }
  }
});
