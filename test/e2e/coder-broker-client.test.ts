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
import { createCredentialProxy, createBrokerScope, type CredentialProxy } from 'aquaman-proxy';
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
      broker: createBrokerScope({
        projectsPath: '/nonexistent/aquaman-test/projects.yaml',
        allowedRefs: ['aquaman://anthropic/api_key', 'aquaman://anthropic/missing_key', 'aquaman://github/token'],
      }),
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
      // The real daemon wiring: declared refs come from projects.yaml, which
      // is written below AFTER the proxy starts (exercises the mtime reload).
      broker: createBrokerScope({ projectsPath: path.join(tmpHome, '.aquaman', 'projects.yaml') }),
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

  it('a routed binding gives the command the proxy token and URL, never the credential', async () => {
    const { spawn } = await import('node:child_process');
    const coderCli = path.resolve('packages/coder/src/cli/index.ts');
    const routedToken = 'aqm_lb_exec_route_token_0123456789';
    await proxy.stop();
    await store.set('stripe', 'secret_key', 'sk_live_never_in_the_command');
    proxy = createCredentialProxy({
      socketPath: socketPathLocal,
      store,
      allowedServices: ['dummysvc', 'stripe'],
      broker: createBrokerScope({ projectsPath: path.join(tmpHome, '.aquaman', 'projects.yaml') }),
      loopback: { port: 0, token: routedToken, host: '127.0.0.1' },
    });
    await proxy.start();
    fs.writeFileSync(
      path.join(tmpHome, '.aquaman', 'projects.yaml'),
      `version: 1
projects:
  testproj:
    paths: ["${projectDir}"]
    env:
      STRIPE_SECRET_KEY: aquaman://stripe/secret_key
    routes:
      STRIPE_SECRET_KEY:
        url_env: STRIPE_API_BASE
        base_path: /v1
`
    );
    // The command reports the length and a hash-free fingerprint of what it got, so redaction does not hide the answer.
    const script = 'printf "url=%s keylen=%s prefix=%s" "$STRIPE_API_BASE" "${#STRIPE_SECRET_KEY}" "$(printf %s "$STRIPE_SECRET_KEY" | cut -c1-7)"';
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const proc = spawn('npx', ['tsx', coderCli, 'exec', '--', 'sh', '-c', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: projectDir,
        env: { ...process.env, HOME: tmpHome },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (d) => { stdout += d.toString(); });
      proc.stderr!.on('data', (d) => { stderr += d.toString(); });
      proc.on('exit', (code) => resolve({ stdout, stderr, code }));
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`url=http://${proxy.getLoopbackAddress()}/stripe/v1`);
    expect(result.stdout).toContain(`keylen=${routedToken.length}`);
    expect(result.stdout).toContain('prefix=aqm_lb_');
    expect(result.stdout + result.stderr).not.toContain('sk_live_never_in_the_command');
  }, 60_000);

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

  it('a reference with no stored credential leaves that one variable unset and the command still runs', async () => {
    const { spawn } = await import('node:child_process');
    const coderCli = path.resolve('packages/coder/src/cli/index.ts');
    fs.writeFileSync(
      path.join(tmpHome, '.aquaman', 'projects.yaml'),
      `version: 1
projects:
  testproj:
    paths: ["${projectDir}"]
    env:
      TESTKEY: aquaman://dummysvc/token
      NOT_YET: aquaman://dummysvc/not_added_yet
`
    );
    // Asynchronous on purpose: the proxy lives in this process and has to answer.
    const run = () => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn(
        'npx',
        ['tsx', coderCli, 'exec', '--', 'sh', '-c', 'printf "[%s][%s]" "$TESTKEY" "${NOT_YET-unset}"; exit 7'],
        { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: tmpHome } },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (d) => { stdout += d.toString(); });
      proc.stderr!.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    });

    const missing = await run();
    expect(missing.status).toBe(7);
    expect(missing.stdout).toBe('[[REDACTED:injected-value]][unset]');
    expect(missing.stderr).toContain('NOT_YET is not set for this command');
    expect(missing.stderr).toContain('aquaman credentials add dummysvc not_added_yet');

    // Once it is in the vault the same command gets it, with no restart.
    await store.set('dummysvc', 'not_added_yet', 'second-shapeless-value-67890');
    const present = await run();
    expect(present.status).toBe(7);
    expect(present.stdout).toBe('[[REDACTED:injected-value]][[REDACTED:injected-value]]');
    expect(present.stderr).not.toContain('is not set');
  }, 60_000);

  it('with nothing at all to inject, the command is not run under the wrapper', async () => {
    const { spawn } = await import('node:child_process');
    const coderCli = path.resolve('packages/coder/src/cli/index.ts');
    fs.writeFileSync(
      path.join(tmpHome, '.aquaman', 'projects.yaml'),
      `version: 1
projects:
  testproj:
    paths: ["${projectDir}"]
    env:
      NOPE: aquaman://dummysvc/never_added
`
    );
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const proc = spawn('npx', ['tsx', coderCli, 'exec', '--', 'sh', '-c', 'echo ran'], {
        cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: tmpHome },
      });
      let stdout = '';
      let stderr = '';
      proc.stdout!.on('data', (d) => { stdout += d.toString(); });
      proc.stderr!.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('ran');
    expect(r.stderr).toContain('was not run');
  }, 30_000);

  it('with no proxy to ask, the command does not run at all', async () => {
    const { spawnSync } = await import('node:child_process');
    const coderCli = path.resolve('packages/coder/src/cli/index.ts');
    await proxy.stop();
    const r = spawnSync('npx', ['tsx', coderCli, 'exec', '--', 'sh', '-c', 'echo ran'], {
      cwd: projectDir, encoding: 'utf-8', env: { ...process.env, HOME: tmpHome },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('ran');
    expect(r.stderr).toContain('failed to resolve TESTKEY');
  }, 30_000);
});
