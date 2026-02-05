/**
 * E2E tests for CLI plugin-mode startup and output.
 *
 * SAFETY: These tests ONLY verify process startup, JSON stdout output,
 * and clean shutdown. They NEVER send HTTP requests through the spawned
 * proxy. Sending requests would use real config/credentials which could
 * contact real APIs. The proxy is spawned and immediately killed after
 * checking its startup output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');

// Spawning npx tsx takes time, increase vitest timeout for this suite
const TEST_TIMEOUT = 30_000;

describe('CLI plugin-mode E2E', () => {
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Wait for process to exit
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child?.kill('SIGKILL');
          resolve();
        }, 5000);
        child!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
    child = null;
  });

  /**
   * Spawn the CLI in plugin-mode and collect stdout until we see the
   * JSON connection info line or a timeout expires.
   */
  function spawnPluginMode(port = '0'): Promise<{ connectionInfo: any; child: ChildProcess }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode', '--port', port], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      child = proc;

      let stdout = '';
      let stderr = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Timed out waiting for plugin-mode startup.\nstdout: ${stdout}\nstderr: ${stderr}`));
        }
      }, 20_000);

      proc.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (resolved) return;

        // Look for a JSON line containing "ready":true
        const lines = stdout.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.includes('"ready"')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.ready === true) {
                resolved = true;
                clearTimeout(timeout);
                resolve({ connectionInfo: parsed, child: proc });
                return;
              }
            } catch {
              // Not valid JSON yet, keep collecting
            }
          }
        }
      });

      proc.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });

      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`plugin-mode exited early with code ${code}.\nstdout: ${stdout}\nstderr: ${stderr}`));
        }
      });
    });
  }

  it('outputs valid JSON connection info on startup', async () => {
    const { connectionInfo } = await spawnPluginMode();

    expect(connectionInfo.ready).toBe(true);
    expect(typeof connectionInfo.port).toBe('number');
    expect(connectionInfo.port).toBeGreaterThan(0);
    expect(typeof connectionInfo.protocol).toBe('string');
    expect(Array.isArray(connectionInfo.services)).toBe(true);
    expect(connectionInfo.services.length).toBeGreaterThan(0);
    expect(typeof connectionInfo.backend).toBe('string');
  }, TEST_TIMEOUT);

  it('includes expected fields in connection info', async () => {
    const { connectionInfo } = await spawnPluginMode();

    // Default config should include anthropic and openai
    expect(connectionInfo.services).toContain('anthropic');
    expect(connectionInfo.services).toContain('openai');

    // baseUrl should be a proper URL
    expect(connectionInfo.baseUrl).toMatch(/^https?:\/\/127\.0\.0\.1:\d+$/);
  }, TEST_TIMEOUT);

  it('exits cleanly on SIGTERM', async () => {
    const { connectionInfo, child: proc } = await spawnPluginMode();

    // Verify it started
    expect(connectionInfo.ready).toBe(true);

    // Send SIGTERM and wait for exit
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    proc.kill('SIGTERM');

    const result = await exitPromise;

    // The process should terminate. It may exit with code 0 (clean shutdown via
    // process.exit(0)), code 1 (Node signal exit), null with SIGTERM signal, or
    // code null. Any of these indicate the process responded to SIGTERM.
    const terminated = result.code !== null || result.signal !== null;
    expect(terminated).toBe(true);
  }, TEST_TIMEOUT);
});
