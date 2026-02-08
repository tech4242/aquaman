/**
 * E2E tests for `aquaman migrate openclaw --auto` command.
 *
 * Tests the guided migration flow with temp environments.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
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
});
