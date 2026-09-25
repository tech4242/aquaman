/**
 * E2E — `aquaman get` (v0.16.0).
 *
 * The command fills the "run a command, read the secret from stdout" slot that
 * sbx, Codex, Claude Code, OpenClaw and Hermes all expose. It must go through
 * the daemon (scope-checked and audited), never read the vault directly, print
 * the bare value with no trailing newline when piped, and fail closed with a
 * fix on stderr and nothing on stdout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { udsFetch } from '../helpers/uds-proxy.js';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TIMEOUT = 45_000;
const DECLARED = 'ghp_broker_get_declared_value_0123456789';
const UNDECLARED = 'sk-ant-broker-get-undeclared-0123456789';

describe('aquaman get', () => {
  let env: TempEnv;
  let daemon: ChildProcess | null = null;

  beforeEach(async () => {
    env = createTempEnv({ withConfig: true });
    const store = new EncryptedFileStore(env.env.AQUAMAN_ENCRYPTION_PASSWORD, path.join(env.aquamanDir, 'credentials.enc'));
    await store.set('github', 'token', DECLARED);
    await store.set('anthropic', 'api_key', UNDECLARED);
  });

  afterEach(async () => {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { daemon?.kill('SIGKILL'); resolve(); }, 5_000);
        daemon!.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    daemon = null;
    env.cleanup();
  });

  function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn('npx', ['tsx', CLI_PATH, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env.env },
      });
      let stdout = '';
      let stderr = '';
      p.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
      p.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      p.on('exit', (code) => resolve({ code, stdout, stderr }));
    });
  }

  async function startDaemon(): Promise<void> {
    const socket = path.join(env.aquamanDir, 'proxy.sock');
    daemon = spawn('npx', ['tsx', CLI_PATH, 'daemon'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env.env },
    });
    let output = '';
    daemon.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    daemon.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) throw new Error(`daemon exited early:\n${output}`);
      try {
        if ((await udsFetch(socket, '/_health')).status === 200) return;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`daemon never became healthy:\n${output}`);
  }

  it('prints a declared ref as the bare value, with no trailing newline, and audits the read', async () => {
    expect((await run(['broker', 'allow', 'aquaman://github/token'])).code).toBe(0);
    await startDaemon();

    const res = await run(['get', 'aquaman://github/token']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(DECLARED);

    const auditDir = path.join(env.aquamanDir, 'audit');
    const audit = (fs.readdirSync(auditDir, { recursive: true }) as string[])
      .map((f) => path.join(auditDir, f))
      .filter((f) => fs.statSync(f).isFile())
      .map((f) => fs.readFileSync(f, 'utf-8'))
      .join('\n');
    const reads = audit.split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.type === 'credential_access' && e.data.operation === 'read');
    expect(reads).toEqual([expect.objectContaining({ data: expect.objectContaining({ service: 'github', success: true }) })]);
    expect(audit).not.toContain(DECLARED);
  }, TIMEOUT);

  it('refuses an undeclared ref with the allow fix and prints nothing to stdout', async () => {
    await startDaemon();
    const res = await run(['get', 'aquaman://anthropic/api_key']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('aquaman broker allow aquaman://anthropic/api_key');
    expect(res.stderr).not.toContain(UNDECLARED);
  }, TIMEOUT);

  it('never falls back to the vault when the daemon is not running', async () => {
    expect((await run(['broker', 'allow', 'aquaman://github/token'])).code).toBe(0);
    const res = await run(['get', 'aquaman://github/token']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('aquaman daemon');
  }, TIMEOUT);

  it('rejects a malformed ref before contacting the daemon', async () => {
    const res = await run(['get', 'github/token']);
    expect(res.code).toBe(1);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('aquaman://<service>/<key>');
  }, TIMEOUT);
});

// ClawScan reviews only the plugin artifact (the 0.15.0 report lists 25 plugin
// files, not aquaman-proxy), and the plugin forwards an explicit allowlist of
// CLI commands. `get` must never join that list: it would hand an OpenClaw
// agent a first-party way to print credentials, the class that flagged 0.14.x.
describe('aquaman get is not reachable through the OpenClaw plugin', () => {
  it('the plugin never forwards `get` to the proxy CLI', () => {
    const src = fs.readFileSync(path.resolve('packages/plugin/index.ts'), 'utf-8');
    const forwarded = [...src.matchAll(/execAquamanProxy(?:Cli|Interactive)\(\[\s*'([^']+)'/g)].map((m) => m[1]);
    expect(forwarded.length).toBeGreaterThan(0);
    expect(forwarded).not.toContain('get');
  });
});
