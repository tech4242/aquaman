/**
 * E2E tests for `aquaman doctor` command.
 *
 * Uses temp dirs with staged broken states to verify diagnostic output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync, spawn as spawnProc } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TEST_TIMEOUT = 30_000;

function runDoctor(
  tempEnv: TempEnv,
  extraEnv: Record<string, string> = {}
): { stdout: string; stderr: string; exitCode: number | null } {
  try {
    const stdout = execSync(`npx tsx ${CLI_PATH} doctor`, {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...tempEnv.env,
        ...extraEnv,
      },
      timeout: 20_000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.status ?? 1,
    };
  }
}

/** Async version of runDoctor using spawn (doesn't block event loop). */
function runDoctorAsync(
  tempEnv: TempEnv,
  extraEnv: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawnProc('npx', ['tsx', CLI_PATH, 'doctor'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...tempEnv.env,
        ...extraEnv,
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: -1 });
    }, 25_000);

    proc.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

describe('aquaman doctor E2E', () => {
  let tempEnv: TempEnv;

  afterEach(() => {
    if (tempEnv) tempEnv.cleanup();
  });

  describe('missing config', () => {
    it('reports missing config.yaml with fix command', () => {
      tempEnv = createTempEnv();
      const { stdout, exitCode } = runDoctor(tempEnv);

      expect(stdout).toContain('Config missing');
      expect(stdout).toContain('aquaman setup');
      expect(exitCode).toBe(1);
    }, TEST_TIMEOUT);
  });

  describe('with config present', () => {
    it('reports config exists', () => {
      tempEnv = createTempEnv({ withConfig: true });
      const { stdout } = runDoctor(tempEnv);

      expect(stdout).toContain('Config exists');
    }, TEST_TIMEOUT);
  });

  describe('proxy not running', () => {
    it('reports proxy not reachable on configured port', () => {
      tempEnv = createTempEnv({ withConfig: true });
      const { stdout, exitCode } = runDoctor(tempEnv);

      expect(stdout).toContain('Proxy not running');
      expect(stdout).toContain('aquaman start');
      expect(exitCode).toBe(1);
    }, TEST_TIMEOUT);
  });

  describe('OpenClaw integration', () => {
    it('reports missing plugin when openclaw dir exists but no plugin', () => {
      tempEnv = createTempEnv({ withConfig: true, withOpenClaw: true });
      const { stdout } = runDoctor(tempEnv);

      expect(stdout).toContain('Plugin not installed');
    }, TEST_TIMEOUT);

    it('reports missing auth-profiles.json with fix command', () => {
      tempEnv = createTempEnv({ withConfig: true, withPlugin: true });
      const { stdout } = runDoctor(tempEnv);

      expect(stdout).toContain('Auth profiles missing');
      expect(stdout).toContain('aquaman setup');
    }, TEST_TIMEOUT);

    it('reports missing openclaw.json plugin entry', () => {
      tempEnv = createTempEnv({ withConfig: true, withOpenClaw: true });
      // openclaw dir exists but no openclaw.json
      const { stdout } = runDoctor(tempEnv);

      expect(stdout).toMatch(/openclaw\.json not found|Plugin not configured/);
    }, TEST_TIMEOUT);

    it('reports plugin and config issues when openclaw state dir exists but empty', () => {
      tempEnv = createTempEnv({ withConfig: true, withOpenClaw: true });
      const { stdout } = runDoctor(tempEnv);

      // OpenClaw state dir exists, so plugin checks should run
      expect(stdout).toContain('Plugin not installed');
      expect(stdout).toContain('aquaman setup');
    }, TEST_TIMEOUT);
  });

  describe('healthy state', () => {
    it('shows all non-proxy checks as passing when fully configured', () => {
      tempEnv = createTempEnv({
        withConfig: true,
        withPlugin: true,
        withAuthProfiles: true,
      });
      const { stdout } = runDoctor(tempEnv);

      expect(stdout).toContain('Config exists');
      expect(stdout).toContain('Plugin installed');
      expect(stdout).toContain('Plugin configured');
      expect(stdout).toContain('Auth profiles exist');
    }, TEST_TIMEOUT);
  });

  describe('port conflict', () => {
    it('reports port in use by another process', async () => {
      tempEnv = createTempEnv({ withConfig: true });

      // Start a dummy server on a dynamic port to simulate a running proxy
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: 1, services: [] }));
      });

      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' ? addr!.port : 8081);
        });
      });

      try {
        // Override the port in the config to match our dummy server
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          path.join(tempEnv.aquamanDir, 'config.yaml'),
          [
            'credentials:',
            '  backend: keychain',
            `  proxyPort: ${port}`,
            '  proxiedServices:',
            '    - anthropic',
            '    - openai',
            '  tls:',
            '    enabled: false',
            'audit:',
            '  enabled: true',
            `  logDir: ${path.join(tempEnv.aquamanDir, 'audit')}`,
          ].join('\n'),
          'utf-8'
        );

        const { stdout, stderr } = await runDoctorAsync(tempEnv);
        // Should detect that something is running on the port (proxy check passes)
        expect(stdout + stderr).toContain(`Proxy running on port ${port}`);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((err) => err ? reject(err) : resolve());
        });
      }
    }, TEST_TIMEOUT);
  });
});
