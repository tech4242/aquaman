/**
 * E2E tests for `aquaman credentials add` stdin handling.
 *
 * The CLI must accept piped (non-TTY) stdin so users can script credential
 * provisioning, e.g.: `printf "$VALUE" | aquaman credentials add svc key`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TEST_TIMEOUT = 30_000;

function runCli(
  args: string[],
  tempEnv: TempEnv,
  stdinValue?: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn('npx', ['tsx', CLI_PATH, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...tempEnv.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('exit', (code) => resolve({ stdout, stderr, exitCode: code }));

    if (stdinValue !== undefined) {
      proc.stdin!.write(stdinValue);
    }
    proc.stdin!.end();
  });
}

describe('aquaman credentials add — piped stdin', () => {
  let env: TempEnv;

  beforeEach(() => {
    env = createTempEnv({ withConfig: true });
  });

  afterEach(() => {
    env.cleanup();
  });

  it('stores the value read from stdin when input is piped (no trailing newline)', async () => {
    const secret = 'piped-secret-no-newline';

    const addResult = await runCli(['credentials', 'add', 'testsvc', 'testkey'], env, secret);
    expect(addResult.exitCode).toBe(0);
    expect(addResult.stdout + addResult.stderr).toMatch(/stored|Credential/i);

    const listResult = await runCli(['credentials', 'list'], env);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain('testsvc/testkey');

    // Round-trip via the same encrypted file the CLI just wrote (explicit
    // path so this test process doesn't depend on AQUAMAN_CONFIG_DIR leaking
    // into our own env).
    const store = new EncryptedFileStore(
      env.env.AQUAMAN_ENCRYPTION_PASSWORD,
      path.join(env.aquamanDir, 'credentials.enc')
    );
    const got = await store.get('testsvc', 'testkey');
    expect(got).toBe(secret);
  }, TEST_TIMEOUT);

  it('stores the value when piped input has a trailing newline (printf-then-newline / echo style)', async () => {
    const secret = 'piped-secret-trailing-nl';

    const addResult = await runCli(['credentials', 'add', 'svc2', 'key2'], env, secret + '\n');
    expect(addResult.exitCode).toBe(0);

    const store = new EncryptedFileStore(
      env.env.AQUAMAN_ENCRYPTION_PASSWORD,
      path.join(env.aquamanDir, 'credentials.enc')
    );
    const got = await store.get('svc2', 'key2');
    expect(got).toBe(secret);  // trailing newline must be stripped
  }, TEST_TIMEOUT);

  it('preserves multi-line values verbatim except for a single trailing newline', async () => {
    // PEM keys, JSON blobs, etc. legitimately contain embedded newlines.
    const secret = 'line1\nline2\nline3';

    const addResult = await runCli(['credentials', 'add', 'svc3', 'key3'], env, secret);
    expect(addResult.exitCode).toBe(0);

    const store = new EncryptedFileStore(
      env.env.AQUAMAN_ENCRYPTION_PASSWORD,
      path.join(env.aquamanDir, 'credentials.enc')
    );
    const got = await store.get('svc3', 'key3');
    expect(got).toBe(secret);
  }, TEST_TIMEOUT);
});
