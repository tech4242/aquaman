/**
 * E2E test — aquaman-coder's BrokerClient against a live aquaman proxy.
 *
 * Boots a real proxy on a temp UDS, runs a real handlePreToolUse
 * dispatch, and asserts the resolved credential matches the vault value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { BrokerClient, handlePreToolUse } from 'aquaman-coder';
import { tmpSocketPath, cleanupSocket } from '../helpers/uds-proxy.js';

describe('aquaman-coder broker-client E2E', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    store = new MemoryStore();
    socketPath = tmpSocketPath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-coder-e2e-'));
    await store.set('anthropic', 'api_key', 'sk-ant-coder-e2e');
    await store.set('github', 'token', 'ghp_coder_e2e_token');
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic', 'github'],
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    store?.clear();
    if (socketPath) cleanupSocket(socketPath);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('health endpoint responds via BrokerClient', async () => {
    const client = new BrokerClient({ socketPath });
    const result = await client.health();
    expect(result.status).toBe('ok');
  });

  it('resolve materializes a credential from the vault', async () => {
    const client = new BrokerClient({ socketPath });
    const result = await client.resolve({ service: 'anthropic', key: 'api_key' });
    expect(result.value).toBe('sk-ant-coder-e2e');
    expect(result.expiresAt).toBeDefined();
  });

  it('resolve throws on missing credential', async () => {
    const client = new BrokerClient({ socketPath });
    await expect(
      client.resolve({ service: 'anthropic', key: 'missing_key' })
    ).rejects.toThrow();
  });

  it('handlePreToolUse end-to-end: rewrites Bash to wrap with aquaman-coder exec', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpDir, 'app-'));
    const projectsPath = path.join(tmpDir, 'projects.yaml');
    fs.writeFileSync(projectsPath, `projects:
  app:
    paths: ["${projectDir}"]
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
`);
    const client = new BrokerClient({ socketPath });
    const result = await handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'curl https://api.github.com' }, cwd: projectDir },
      { broker: client, projectsPath }
    );
    const out = result?.hookSpecificOutput as any;
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput.command).toContain('aquaman-coder exec --');
    expect(out.updatedInput.command).toContain('curl https://api.github.com');
    expect(out.additionalContext).toContain('ANTHROPIC_API_KEY');
  });

  it('broker error surfaces as a clean message when proxy is down', async () => {
    await proxy.stop();
    const client = new BrokerClient({ socketPath });
    await expect(client.resolve({ service: 'anthropic', key: 'api_key' }))
      .rejects.toThrow(/Cannot reach aquaman proxy/);
  });
});

/**
 * E2E: spawning `aquaman-coder exec` against a real proxy must redact the
 * resolved value from the child's stdout EVEN IF the value has no
 * recognizable shape (i.e., wouldn't trip any BUILTIN_PATTERN).
 *
 * This is the test that would have failed before the value-based redaction
 * fix — and is the smoke-test version of what we run from OPERATIONS.md.
 */
describe('aquaman-coder exec — value-based redaction E2E', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let tmpHome: string;
  let projectDir: string;
  let socketPathLocal: string;

  // The whole point: a string with no provider prefix, no length match for any
  // BUILTIN_PATTERN. If this leaks to stdout, our value-based redaction failed.
  const DUMMY_VALUE = 'dummy-no-shape-value-12345-arbitrary';

  beforeEach(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-coder-exec-'));
    tmpHome = path.join(tmpRoot, 'home');
    projectDir = path.join(tmpRoot, 'project');
    fs.mkdirSync(path.join(tmpHome, '.aquaman'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    socketPathLocal = path.join(tmpHome, '.aquaman', 'proxy.sock');
    store = new MemoryStore();
    await store.set('dummysvc', 'token', DUMMY_VALUE);

    proxy = createCredentialProxy({
      socketPath: socketPathLocal,
      store,
      allowedServices: ['dummysvc'],
    });
    await proxy.start();

    fs.writeFileSync(
      path.join(tmpHome, '.aquaman', 'projects.yaml'),
      `version: 1
projects:
  testproj:
    paths: ["${projectDir}"]
    env:
      TESTKEY: aquaman://dummysvc/token
`
    );
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    store?.clear();
    try { fs.rmSync(path.dirname(tmpHome), { recursive: true, force: true }); } catch { /* */ }
  });

  it('strips the injected value from stdout even when no builtin pattern would match it', async () => {
    const { spawn } = await import('node:child_process');
    const coderCli = path.resolve('packages/coder/src/cli/index.ts');

    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const proc = spawn(
        'npx',
        ['tsx', coderCli, 'exec', '--', 'sh', '-c', 'printf "[%s]" "$TESTKEY"'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: projectDir,
          env: { ...process.env, HOME: tmpHome },
        }
      );
      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (d) => { stdout += d.toString(); });
      proc.stderr!.on('data', (d) => { stderr += d.toString(); });
      proc.on('exit', (code) => resolve({ stdout, stderr, code }));
    });

    expect(result.code).toBe(0);
    // The CHILD process must have actually seen the value (env injection works).
    // But the value MUST NOT appear in stdout (redaction works).
    expect(result.stdout).not.toContain(DUMMY_VALUE);
    expect(result.stdout).toContain('[REDACTED:injected-value]');
    // Brackets prove the value was non-empty when the child printed it.
    expect(result.stdout).toBe('[[REDACTED:injected-value]]');
  }, 30_000);
});
