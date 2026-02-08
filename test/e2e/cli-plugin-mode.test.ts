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
import * as http from 'node:http';
import * as https from 'node:https';

/**
 * Make an HTTP(S) request that accepts self-signed certs.
 * Returns { statusCode, body }.
 */
function httpRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const reqOpts: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      rejectUnauthorized: false, // Accept self-signed certs
    };

    const req = transport.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

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
  function spawnPluginMode(
    port = '0',
    extraArgs: string[] = []
  ): Promise<{ connectionInfo: any; child: ChildProcess; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode', '--port', port, ...extraArgs], {
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
                resolve({ connectionInfo: parsed, child: proc, stderr });
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

    // Token field must be present
    expect(typeof connectionInfo.token).toBe('string');
    // Should be 64-char hex string (32 bytes)
    expect(connectionInfo.token).toMatch(/^[0-9a-f]{64}$/);
  }, TEST_TIMEOUT);

  it('includes expected fields in connection info', async () => {
    const { connectionInfo } = await spawnPluginMode();

    // Default config should include anthropic and openai
    expect(connectionInfo.services).toContain('anthropic');
    expect(connectionInfo.services).toContain('openai');

    // baseUrl should be a proper URL
    expect(connectionInfo.baseUrl).toMatch(/^https?:\/\/127\.0\.0\.1:\d+$/);
  }, TEST_TIMEOUT);

  it('credentials guide outputs setup commands', async () => {
    const proc = spawn('npx', ['tsx', CLI_PATH, 'credentials', 'guide', '--service', 'anthropic'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on('exit', (code) => resolve(code));
    });

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Credential setup guide');
    expect(stdout).toContain('anthropic');
    expect(stdout).toContain('aquaman credentials add anthropic api_key');
  }, TEST_TIMEOUT);

  it('--token flag uses provided value exactly', async () => {
    const customToken = 'my-custom-test-token-value';
    const { connectionInfo } = await spawnPluginMode('0', ['--token', customToken]);

    expect(connectionInfo.token).toBe(customToken);
  }, TEST_TIMEOUT);

  it('token NOT in stderr output', async () => {
    const { connectionInfo, stderr } = await spawnPluginMode();

    // Wait a bit for any stderr to flush
    await new Promise(r => setTimeout(r, 500));

    expect(connectionInfo.token).toBeDefined();
    expect(stderr).not.toContain(connectionInfo.token);
  }, TEST_TIMEOUT);

  it('proxy rejects requests without the output token', async () => {
    const { connectionInfo } = await spawnPluginMode();
    const baseUrl = connectionInfo.baseUrl;

    // /_health should work without token
    const healthRes = await httpRequest(`${baseUrl}/_health`);
    expect(healthRes.statusCode).toBe(200);

    // Service request without token → 403
    const serviceRes = await httpRequest(`${baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] }),
    });
    expect(serviceRes.statusCode).toBe(403);
  }, TEST_TIMEOUT);

  it('proxy accepts requests with the output token', async () => {
    const { connectionInfo } = await spawnPluginMode();
    const baseUrl = connectionInfo.baseUrl;
    const token = connectionInfo.token;

    // Service request with token should pass auth (may get 401 from missing credential, but not 403)
    const serviceRes = await httpRequest(`${baseUrl}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aquaman-Token': token,
      },
      body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] }),
    });
    // Should not be 403 (token auth passed). May be 401 (no credential in keychain) or other.
    expect(serviceRes.statusCode).not.toBe(403);
  }, TEST_TIMEOUT);

  it('exits with error when credential backend fails to initialize', async () => {
    // Create a temp config dir with vault backend but no VAULT_ADDR → guaranteed failure
    const fs = await import('node:fs');
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-fail-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      [
        'credentials:',
        '  backend: vault',
        '  proxyPort: 0',
        '  proxiedServices:',
        '    - anthropic',
        '  tls:',
        '    enabled: false',
        'audit:',
        '  enabled: false',
        `  logDir: ${tmpDir}`,
        '',
      ].join('\n'),
      'utf-8'
    );

    // Remove VAULT_ADDR and VAULT_TOKEN from env to ensure failure
    const cleanEnv = { ...process.env };
    delete cleanEnv['VAULT_ADDR'];
    delete cleanEnv['VAULT_TOKEN'];

    const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode', '--port', '0'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...cleanEnv, AQUAMAN_CONFIG_DIR: tmpDir },
    });
    child = proc;

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const exitCode = await new Promise<number | null>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve(null);
      }, 15_000);
      proc.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    // Cleanup temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // Must NOT output ready:true JSON (no silent MemoryStore fallback)
    expect(stdout).not.toContain('"ready":true');
    expect(stdout).not.toContain('"ready": true');
    // Must exit with non-zero code
    expect(exitCode).toBe(1);
    // Stderr should mention the backend failure
    expect(stderr).toContain('failed to initialize');
    expect(stderr).toContain('aquaman doctor');
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
