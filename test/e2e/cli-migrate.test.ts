/**
 * E2E tests for `aquaman migrate openclaw --auto` command.
 *
 * Tests the guided migration flow with temp environments.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TEST_TIMEOUT = 30_000;

function runMigrate(
  args: string[] = [],
  env: Record<string, string> = {},
  tempEnv: TempEnv
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', CLI_PATH, 'migrate', 'openclaw', '--auto', ...args], {
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

    setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: -1 });
    }, 25_000);
  });
}

describe('aquaman migrate openclaw --auto E2E', () => {
  let tempEnv: TempEnv;

  afterEach(() => {
    tempEnv?.cleanup();
  });

  it('exits 1 when no aquaman config exists', async () => {
    // Create temp env WITHOUT config
    tempEnv = createTempEnv({ withOpenClaw: true });

    const { stderr, exitCode } = await runMigrate([], {}, tempEnv);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('No aquaman config found');
  }, TEST_TIMEOUT);

  it('reports nothing to migrate when no credentials exist', async () => {
    tempEnv = createTempEnv({ withConfig: true, withOpenClaw: true });

    const { stdout, exitCode } = await runMigrate(['--dry-run'], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('No plaintext credentials found');
  }, TEST_TIMEOUT);

  it('shows preview of found credentials in dry-run mode', async () => {
    tempEnv = createTempEnv({
      withConfig: true,
      withOpenClaw: true,
      withCredentials: {
        channels: {
          telegram: {
            accounts: {
              mybot: { botToken: '123456:ABC-TEST-TOKEN' }
            }
          },
          slack: {
            accounts: {
              ws1: { botToken: 'xoxb-test-bot-token' }
            }
          }
        },
        credentialFiles: {
          'anthropic.json': { api_key: 'sk-ant-test-key' }
        }
      }
    });

    const { stdout, exitCode } = await runMigrate(['--dry-run'], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Found');
    expect(stdout).toContain('telegram/bot_token');
    expect(stdout).toContain('slack/bot_token');
    expect(stdout).toContain('anthropic/api_key');
    expect(stdout).toContain('dry run');
  }, TEST_TIMEOUT);

  it('migrates credentials in non-TTY mode (skips confirmation)', async () => {
    tempEnv = createTempEnv({
      withConfig: true,
      withOpenClaw: true,
      withCredentials: {
        credentialFiles: {
          'anthropic.json': { api_key: 'sk-ant-migration-test' }
        }
      }
    });

    const { stdout, exitCode } = await runMigrate([], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Migrated');
    expect(stdout).toContain('anthropic/api_key');
  }, TEST_TIMEOUT);

  it('--cleanup deletes credential files after migration', async () => {
    tempEnv = createTempEnv({
      withConfig: true,
      withOpenClaw: true,
      withCredentials: {
        credentialFiles: {
          'xai.json': { api_key: 'xai-cleanup-test' }
        }
      }
    });

    const credFile = path.join(tempEnv.openclawDir, 'credentials', 'xai.json');
    expect(existsSync(credFile)).toBe(true);

    const { stdout, exitCode } = await runMigrate(['--cleanup'], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Migrated');
    expect(stdout).toContain('Deleted');
    expect(existsSync(credFile)).toBe(false);
  }, TEST_TIMEOUT);

  it('--cleanup replaces config tokens with placeholder', async () => {
    tempEnv = createTempEnv({
      withConfig: true,
      withOpenClaw: true,
      withCredentials: {
        channels: {
          telegram: {
            accounts: {
              mybot: { botToken: '123456:CLEANUP-TEST' }
            }
          }
        }
      }
    });

    const { stdout, exitCode } = await runMigrate(['--cleanup'], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Migrated');
    expect(stdout).toContain('Replaced');
    expect(stdout).toContain('placeholder');

    // Verify the config was updated
    const configPath = path.join(tempEnv.openclawDir, 'openclaw.json');
    const updated = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(updated.channels.telegram.accounts.mybot.botToken).toBe('aquaman-proxy-managed');
  }, TEST_TIMEOUT);

  it('--no-cleanup skips plaintext removal', async () => {
    tempEnv = createTempEnv({
      withConfig: true,
      withOpenClaw: true,
      withCredentials: {
        credentialFiles: {
          'anthropic.json': { api_key: 'sk-ant-no-cleanup-test' }
        }
      }
    });

    const credFile = path.join(tempEnv.openclawDir, 'credentials', 'anthropic.json');

    const { stdout, exitCode } = await runMigrate(['--no-cleanup'], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Migrated');
    expect(stdout).not.toContain('Deleted');
    // File should still exist
    expect(existsSync(credFile)).toBe(true);
  }, TEST_TIMEOUT);

  it('non-TTY without --cleanup shows manual cleanup commands', async () => {
    tempEnv = createTempEnv({
      withConfig: true,
      withOpenClaw: true,
      withCredentials: {
        credentialFiles: {
          'anthropic.json': { api_key: 'sk-ant-manual-cleanup' }
        }
      }
    });

    const { stdout, exitCode } = await runMigrate([], {}, tempEnv);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Cleanup');
    expect(stdout).toContain('rm');
    expect(stdout).toContain('anthropic.json');
  }, TEST_TIMEOUT);
});
