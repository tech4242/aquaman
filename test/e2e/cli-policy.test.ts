/**
 * E2E tests for `aquaman policy list` and `aquaman policy test` commands.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TEST_TIMEOUT = 30_000;

function runCli(
  args: string,
  tempEnv: TempEnv,
): { stdout: string; stderr: string; exitCode: number | null } {
  try {
    const stdout = execSync(`npx tsx ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      env: {
        ...process.env,
        ...tempEnv.env,
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

/** Write a config.yaml with policy rules into the temp env */
function writeConfigWithPolicy(tempEnv: TempEnv): void {
  const configPath = path.join(tempEnv.aquamanDir, 'config.yaml');
  const existing = readFileSync(configPath, 'utf-8');
  writeFileSync(
    configPath,
    existing + [
      'policy:',
      '  anthropic:',
      '    defaultAction: allow',
      '    rules:',
      '      - method: "*"',
      '        path: "/v1/organizations/**"',
      '        action: deny',
      '  openai:',
      '    defaultAction: allow',
      '    rules:',
      '      - method: "*"',
      '        path: "/v1/organization/**"',
      '        action: deny',
      '      - method: DELETE',
      '        path: "/v1/**"',
      '        action: deny',
      '  slack:',
      '    defaultAction: allow',
      '    rules:',
      '      - method: "*"',
      '        path: "/admin.*"',
      '        action: deny',
      '',
    ].join('\n'),
    'utf-8'
  );
}

describe('aquaman policy E2E', () => {
  let tempEnv: TempEnv;

  afterEach(() => {
    if (tempEnv) tempEnv.cleanup();
  });

  describe('policy list', () => {
    it('shows rules when policies are configured', () => {
      tempEnv = createTempEnv({ withConfig: true });
      writeConfigWithPolicy(tempEnv);

      const { stdout, exitCode } = runCli('policy list', tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('anthropic (default: allow)');
      expect(stdout).toContain('deny');
      expect(stdout).toContain('/v1/organizations/**');
      expect(stdout).toContain('openai (default: allow)');
      expect(stdout).toContain('/v1/organization/**');
      expect(stdout).toContain('slack (default: allow)');
      expect(stdout).toContain('/admin.*');
    }, TEST_TIMEOUT);

    it('shows "not configured" when no policies exist', () => {
      tempEnv = createTempEnv({ withConfig: true });

      const { stdout, exitCode } = runCli('policy list', tempEnv);

      expect(exitCode).toBe(0);
      expect(stdout).toContain('No policies configured');
      expect(stdout).toContain('aquaman setup');
    }, TEST_TIMEOUT);
  });

  describe('policy test', () => {
    it('shows DENIED for matching deny rule', () => {
      tempEnv = createTempEnv({ withConfig: true });
      writeConfigWithPolicy(tempEnv);

      const { stdout, exitCode } = runCli(
        'policy test anthropic GET /v1/organizations/org123/members',
        tempEnv
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('DENIED');
      expect(stdout).toContain('/v1/organizations/**');
    }, TEST_TIMEOUT);

    it('shows ALLOWED when no rule matches', () => {
      tempEnv = createTempEnv({ withConfig: true });
      writeConfigWithPolicy(tempEnv);

      const { stdout, exitCode } = runCli(
        'policy test anthropic POST /v1/messages',
        tempEnv
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('ALLOWED');
      expect(stdout).toContain('default: allow');
    }, TEST_TIMEOUT);

    it('shows DENIED for DELETE on openai', () => {
      tempEnv = createTempEnv({ withConfig: true });
      writeConfigWithPolicy(tempEnv);

      const { stdout, exitCode } = runCli(
        'policy test openai DELETE /v1/files/file-abc',
        tempEnv
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('DENIED');
    }, TEST_TIMEOUT);

    it('shows DENIED for slack admin method', () => {
      tempEnv = createTempEnv({ withConfig: true });
      writeConfigWithPolicy(tempEnv);

      const { stdout, exitCode } = runCli(
        'policy test slack POST /admin.users.list',
        tempEnv
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('DENIED');
      expect(stdout).toContain('/admin.*');
    }, TEST_TIMEOUT);

    it('shows ALLOWED for unknown service', () => {
      tempEnv = createTempEnv({ withConfig: true });
      writeConfigWithPolicy(tempEnv);

      const { stdout, exitCode } = runCli(
        'policy test unknown-service GET /foo',
        tempEnv
      );

      expect(exitCode).toBe(0);
      expect(stdout).toContain('ALLOWED');
      expect(stdout).toContain('no policy');
    }, TEST_TIMEOUT);
  });
});
