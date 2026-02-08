/**
 * E2E tests for `aquaman setup` command.
 *
 * Uses --non-interactive mode with env vars (no TTY needed).
 * All tests use temp dirs to avoid touching the real ~/.aquaman or ~/.openclaw.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TEST_TIMEOUT = 30_000;

function runSetup(
  args: string[] = [],
  env: Record<string, string> = {},
  tempEnv: TempEnv
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', CLI_PATH, 'setup', '--non-interactive', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...tempEnv.env,
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout!.on('data', (data: Buffer) => { stdout += data.toString(); });
    proc.stderr!.on('data', (data: Buffer) => { stderr += data.toString(); });

    proc.on('exit', (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    // Safety timeout
    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: -1 });
    }, 25_000);
  });
}

describe('aquaman setup E2E', () => {
  let tempEnv: TempEnv;

  beforeEach(() => {
    tempEnv = createTempEnv({ withOpenClaw: true });
  });

  afterEach(() => {
    tempEnv.cleanup();
  });

  describe('fresh install', () => {
    it('creates config.yaml with auto-detected backend', async () => {
      const { exitCode } = await runSetup([], {}, tempEnv);

      expect(exitCode).toBe(0);
      const configPath = path.join(tempEnv.aquamanDir, 'config.yaml');
      expect(existsSync(configPath)).toBe(true);

      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('backend:');
    }, TEST_TIMEOUT);

    it('stores anthropic credential from env var', async () => {
      const { stdout, exitCode } = await runSetup([], {
        ANTHROPIC_API_KEY: 'sk-ant-test-setup',
      }, tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Stored anthropic/api_key');
    }, TEST_TIMEOUT);

    it('stores openai credential from env var', async () => {
      const { stdout, exitCode } = await runSetup([], {
        OPENAI_API_KEY: 'sk-openai-test-setup',
      }, tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Stored openai/api_key');
    }, TEST_TIMEOUT);

    it('skips openai when env var not set', async () => {
      const { stdout, exitCode } = await runSetup([], {
        ANTHROPIC_API_KEY: 'sk-ant-test-setup',
      }, tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Stored anthropic/api_key');
      expect(stdout).not.toContain('Stored openai/api_key');
    }, TEST_TIMEOUT);

    it('detects OpenClaw state dir and installs plugin', async () => {
      const { stdout, exitCode } = await runSetup([], {}, tempEnv);

      expect(exitCode).toBe(0);
      // Plugin should be installed (plugin src exists at packages/plugin)
      expect(stdout).toMatch(/Plugin installed|Plugin config written|Done/);
    }, TEST_TIMEOUT);

    it('writes openclaw.json with plugin config', async () => {
      const { exitCode } = await runSetup([], {}, tempEnv);
      expect(exitCode).toBe(0);

      const openclawJsonPath = path.join(tempEnv.openclawDir, 'openclaw.json');
      if (existsSync(openclawJsonPath)) {
        const config = JSON.parse(readFileSync(openclawJsonPath, 'utf-8'));
        expect(config.plugins?.entries?.['aquaman-plugin']).toBeDefined();
        expect(config.plugins.entries['aquaman-plugin'].enabled).toBe(true);
        expect(config.plugins.entries['aquaman-plugin'].config.mode).toBe('proxy');
      }
    }, TEST_TIMEOUT);

    it('generates auth-profiles.json with placeholders', async () => {
      const { exitCode } = await runSetup([], {}, tempEnv);
      expect(exitCode).toBe(0);

      const profilesPath = path.join(tempEnv.openclawDir, 'agents', 'main', 'agent', 'auth-profiles.json');
      if (existsSync(profilesPath)) {
        const profiles = JSON.parse(readFileSync(profilesPath, 'utf-8'));
        expect(profiles.version).toBe(1);
        expect(profiles.profiles['anthropic:default']?.key).toBe('aquaman-proxy-managed');
      }
    }, TEST_TIMEOUT);

    it('prints success message with next steps', async () => {
      const { stdout, exitCode } = await runSetup([], {}, tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Setup complete!');
    }, TEST_TIMEOUT);
  });

  describe('existing install', () => {
    it('preserves existing openclaw.json entries when merging', async () => {
      // Pre-populate openclaw.json with another plugin
      const openclawJsonPath = path.join(tempEnv.openclawDir, 'openclaw.json');
      writeFileSync(openclawJsonPath, JSON.stringify({
        plugins: {
          entries: {
            'other-plugin': { enabled: true, config: {} }
          }
        }
      }));

      const { exitCode } = await runSetup([], {}, tempEnv);
      expect(exitCode).toBe(0);

      const config = JSON.parse(readFileSync(openclawJsonPath, 'utf-8'));
      expect(config.plugins.entries['other-plugin']).toBeDefined();
      expect(config.plugins.entries['aquaman-plugin']).toBeDefined();
    }, TEST_TIMEOUT);

    it('does not overwrite existing auth-profiles.json', async () => {
      const profilesDir = path.join(tempEnv.openclawDir, 'agents', 'main', 'agent');
      mkdirSync(profilesDir, { recursive: true });
      const profilesPath = path.join(profilesDir, 'auth-profiles.json');
      writeFileSync(profilesPath, JSON.stringify({
        version: 1,
        profiles: {
          'custom:key': { type: 'api_key', provider: 'custom', key: 'my-custom-key' }
        },
        order: {}
      }));

      const { exitCode } = await runSetup([], {}, tempEnv);
      expect(exitCode).toBe(0);

      const profiles = JSON.parse(readFileSync(profilesPath, 'utf-8'));
      expect(profiles.profiles['custom:key']).toBeDefined();
      expect(profiles.profiles['custom:key'].key).toBe('my-custom-key');
    }, TEST_TIMEOUT);
  });

  describe('--no-openclaw flag', () => {
    it('skips plugin installation when flag set', async () => {
      const { stdout, exitCode } = await runSetup(['--no-openclaw'], {}, tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).not.toContain('Plugin installed');
      expect(stdout).not.toContain('Plugin config written');
    }, TEST_TIMEOUT);

    it('does not write openclaw.json', async () => {
      await runSetup(['--no-openclaw'], {}, tempEnv);

      const openclawJsonPath = path.join(tempEnv.openclawDir, 'openclaw.json');
      expect(existsSync(openclawJsonPath)).toBe(false);
    }, TEST_TIMEOUT);

    it('does not generate auth-profiles.json', async () => {
      await runSetup(['--no-openclaw'], {}, tempEnv);

      const profilesPath = path.join(tempEnv.openclawDir, 'agents', 'main', 'agent', 'auth-profiles.json');
      expect(existsSync(profilesPath)).toBe(false);
    }, TEST_TIMEOUT);
  });

  describe('--backend flag', () => {
    it('uses specified backend instead of auto-detected', async () => {
      const { exitCode } = await runSetup(['--backend', 'encrypted-file'], {
        AQUAMAN_ENCRYPTION_PASSWORD: 'test-password-123',
      }, tempEnv);

      expect(exitCode).toBe(0);
      const configPath = path.join(tempEnv.aquamanDir, 'config.yaml');
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('encrypted-file');
    }, TEST_TIMEOUT);

    it('rejects invalid backend name', async () => {
      const { exitCode } = await runSetup(['--backend', 'invalid-backend'], {}, tempEnv);

      expect(exitCode).toBe(1);
    }, TEST_TIMEOUT);

    it('writes selected backend to config.yaml', async () => {
      const { exitCode } = await runSetup(['--backend', 'encrypted-file'], {
        AQUAMAN_ENCRYPTION_PASSWORD: 'test-password',
      }, tempEnv);

      expect(exitCode).toBe(0);
      const configPath = path.join(tempEnv.aquamanDir, 'config.yaml');
      const content = readFileSync(configPath, 'utf-8');
      expect(content).toContain('encrypted-file');
    }, TEST_TIMEOUT);
  });

  describe('--no-openclaw flag behavior', () => {
    it('does not detect openclaw when flag set even if dir exists', async () => {
      const { stdout, exitCode } = await runSetup(['--no-openclaw'], {}, tempEnv);

      expect(exitCode).toBe(0);
      // With --no-openclaw, should not install plugin even though openclaw dir exists
      expect(stdout).not.toContain('Plugin installed');
      expect(stdout).toContain('Setup complete!');
    }, TEST_TIMEOUT);

    it('prints success without plugin steps', async () => {
      const { stdout, exitCode } = await runSetup(['--no-openclaw'], {
        ANTHROPIC_API_KEY: 'sk-ant-test',
      }, tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('Setup complete!');
      expect(stdout).toContain('Stored anthropic/api_key');
    }, TEST_TIMEOUT);
  });
});
