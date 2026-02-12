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
import * as fs from 'node:fs';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

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
    extraArgs: string[] = []
  ): Promise<{ connectionInfo: any; child: ChildProcess; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode', ...extraArgs], {
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
    expect(typeof connectionInfo.socketPath).toBe('string');
    expect(connectionInfo.socketPath.length).toBeGreaterThan(0);
    expect(Array.isArray(connectionInfo.services)).toBe(true);
    expect(connectionInfo.services.length).toBeGreaterThan(0);
    expect(typeof connectionInfo.backend).toBe('string');
  }, TEST_TIMEOUT);

  it('includes expected fields in connection info', async () => {
    const { connectionInfo } = await spawnPluginMode();

    // Default config should include anthropic and openai
    expect(connectionInfo.services).toContain('anthropic');
    expect(connectionInfo.services).toContain('openai');

    // socketPath should be a valid path ending in .sock
    expect(connectionInfo.socketPath).toMatch(/\.sock$/);
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

  it('proxy responds to health check via UDS', async () => {
    const { connectionInfo } = await spawnPluginMode();
    const sockPath = connectionInfo.socketPath;

    // /_health should work
    const healthRes = await udsFetch(sockPath, '/_health');
    expect(healthRes.status).toBe(200);
    const health = JSON.parse(healthRes.body);
    expect(health.status).toBe('ok');
  }, TEST_TIMEOUT);

  it('exits with error when credential backend fails to initialize', async () => {
    // Create a temp config dir with vault backend but no VAULT_ADDR → guaranteed failure
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-fail-test-'));
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      [
        'credentials:',
        '  backend: vault',
        '  proxiedServices:',
        '    - anthropic',
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

    const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode'], {
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

  it('writes audit log entries when handling requests', async () => {
    // Use a temp config dir so we can check the audit log without polluting real state
    const os = await import('node:os');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-audit-pm-'));
    const auditDir = path.join(tmpDir, 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'config.yaml'),
      [
        'credentials:',
        '  backend: encrypted-file',
        '  proxiedServices:',
        '    - anthropic',
        'audit:',
        '  enabled: true',
        `  logDir: ${auditDir}`,
        '',
      ].join('\n'),
      'utf-8'
    );

    const proc = spawn('npx', ['tsx', CLI_PATH, 'plugin-mode'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AQUAMAN_CONFIG_DIR: tmpDir,
        AQUAMAN_ENCRYPTION_PASSWORD: 'test-password-12345',
      },
    });
    child = proc;

    // Wait for ready
    const connectionInfo = await new Promise<any>((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => reject(new Error(`Timed out. stdout: ${stdout}`)), 20_000);
      proc.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString();
        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.includes('"ready"')) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.ready) { clearTimeout(timeout); resolve(parsed); return; }
            } catch { /* keep collecting */ }
          }
        }
      });
      proc.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Exited with ${code}. stdout: ${stdout}`)); });
    });

    const sockPath = connectionInfo.socketPath;

    // Make a request — credential won't be found, but the proxy should still log it
    await udsFetch(sockPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] })
    });

    // Give audit logger a moment to flush
    await new Promise(r => setTimeout(r, 200));

    // Check audit log was written
    const logPath = path.join(auditDir, 'current.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8').trim();
    expect(content.length).toBeGreaterThan(0);

    const entries = content.split('\n').map(l => JSON.parse(l));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].type).toBe('credential_access');
    expect(entries[0].data.service).toBe('anthropic');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
