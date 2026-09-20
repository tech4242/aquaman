/**
 * Compliance test — credential-broker scoping (v0.15.0+).
 *
 * `POST /broker/resolve` is the one endpoint that hands a credential VALUE to
 * its caller. Through v0.14.x it served any service/key in the vault, in every
 * mode, to any process that could reach the socket. ClawScan flagged
 * aquaman-plugin 0.14.x for exactly that, because the OpenClaw plugin's own
 * proxy exposed it to the gateway's agents. These tests pin the fix:
 *
 *   - NIST AC-3 / ATLAS AML.T0055 (unsecured credentials): an OpenClaw-hosted
 *     proxy never materializes a credential, proven against the real
 *     `aquaman openclaw plugin-mode` process.
 *   - NIST AC-6 (least privilege): the daemon materializes only refs the user
 *     declared, and refuses everything else BEFORE touching the vault.
 *   - ATLAS AML.T0098 (credential harvesting): the LLM-provider tier is never
 *     materialized over the loopback listener, even when declared.
 *   - NIST AU-2: refusals are audited, like resolves.
 *   - Fail closed: an unparseable projects.yaml declares nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, createBrokerScope, HERMES_SUPPORTED_SERVICES, type CredentialProxy } from 'aquaman-proxy';
import type { RequestInfo } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { CountingStore } from '../helpers/counting-store.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TOKEN = 'aqm_lb_broker_scope_compliance_0123456789';

const resolveBody = (service: string, key: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ service, key }),
});

describe('Credential broker scoping — compliance (v0.15.0+)', () => {
  let proxy: CredentialProxy | null = null;
  let socketPath: string;
  let tmpDir: string;
  let counting: CountingStore;
  let requestLog: RequestInfo[];

  beforeEach(async () => {
    socketPath = tmpSocketPath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-broker-scope-'));
    const memory = new MemoryStore();
    await memory.set('github', 'token', 'ghp_declared_value_1234567890');
    await memory.set('slack', 'bot_token', 'xoxb-undeclared-value-1234567890');
    await memory.set('anthropic', 'api_key', 'sk-ant-isolated-value-1234567890');
    counting = new CountingStore(memory);
    requestLog = [];
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    proxy = null;
    cleanupSocket(socketPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function start(broker?: ReturnType<typeof createBrokerScope>, loopback = false) {
    proxy = createCredentialProxy({
      socketPath,
      store: counting,
      allowedServices: ['anthropic', 'github', 'slack'],
      broker,
      loopback: loopback ? { port: 0, token: TOKEN, host: '127.0.0.1' } : undefined,
      onRequest: (info) => requestLog.push(info),
    });
    await proxy.start();
  }

  describe('NIST AC-3 / ATLAS T0055 — a proxy without a scope never materializes', () => {
    it('refuses every broker request with broker_disabled and never reads the vault', async () => {
      await start(undefined);
      for (const [service, key] of [['github', 'token'], ['anthropic', 'api_key'], ['slack', 'bot_token']]) {
        const res = await udsFetch(socketPath, '/broker/resolve', resolveBody(service, key));
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body).code).toBe('broker_disabled');
        expect(res.body).not.toMatch(/ghp_declared|xoxb-undeclared|sk-ant-isolated/);
      }
      expect(counting.gets).toBe(0);
    });
  });

  describe('NIST AC-6 — the daemon materializes declared refs only', () => {
    it('serves a declared ref and refuses an undeclared one without a vault lookup', async () => {
      await start(createBrokerScope({
        projectsPath: path.join(tmpDir, 'projects.yaml'),
        allowedRefs: ['aquaman://github/token'],
      }));

      const ok = await udsFetch(socketPath, '/broker/resolve', resolveBody('github', 'token'));
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body).value).toBe('ghp_declared_value_1234567890');
      expect(counting.gets).toBe(1);

      const denied = await udsFetch(socketPath, '/broker/resolve', resolveBody('slack', 'bot_token'));
      expect(denied.status).toBe(404);
      expect(JSON.parse(denied.body).code).toBe('broker_ref_not_declared');
      expect(denied.body).not.toContain('xoxb-undeclared');
      expect(counting.gets).toBe(1); // the refusal never reached the vault
    });

    it('a refusal reads the same whether or not the vault holds the credential', async () => {
      await start(createBrokerScope({ projectsPath: path.join(tmpDir, 'projects.yaml') }));
      const stored = await udsFetch(socketPath, '/broker/resolve', resolveBody('slack', 'bot_token'));
      const absent = await udsFetch(socketPath, '/broker/resolve', resolveBody('slack', 'no_such_key'));
      expect(stored.status).toBe(absent.status);
      expect(JSON.parse(stored.body).code).toBe(JSON.parse(absent.body).code);
    });

    it('declarations in projects.yaml take effect (and lapse) without a restart', async () => {
      const projectsPath = path.join(tmpDir, 'projects.yaml');
      await start(createBrokerScope({ projectsPath }));

      const before = await udsFetch(socketPath, '/broker/resolve', resolveBody('github', 'token'));
      expect(before.status).toBe(404);

      fs.writeFileSync(projectsPath, `version: 1\nprojects:\n  app:\n    paths: ["${tmpDir}"]\n    env:\n      GITHUB_TOKEN: aquaman://github/token\n`);
      const during = await udsFetch(socketPath, '/broker/resolve', resolveBody('github', 'token'));
      expect(during.status).toBe(200);

      // Nudge the mtime forward so the change is visible even on coarse clocks.
      fs.writeFileSync(projectsPath, 'version: 1\nprojects: {}\n');
      const later = new Date(Date.now() + 5_000);
      fs.utimesSync(projectsPath, later, later);
      const after = await udsFetch(socketPath, '/broker/resolve', resolveBody('github', 'token'));
      expect(after.status).toBe(404);
    });

    it('fails closed when projects.yaml cannot be parsed', async () => {
      const projectsPath = path.join(tmpDir, 'projects.yaml');
      fs.writeFileSync(projectsPath, 'projects: [unclosed\n  env: {GITHUB_TOKEN: aquaman://github/token\n');
      await start(createBrokerScope({ projectsPath }));
      const res = await udsFetch(socketPath, '/broker/resolve', resolveBody('github', 'token'));
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('broker_ref_not_declared');
      expect(body.error).toMatch(/cannot parse/);
      expect(counting.gets).toBe(0);
    });
  });

  describe('ATLAS T0098 — the LLM-provider tier stays on the proxy path over loopback', () => {
    it('refuses declared provider keys over loopback but not the declared project secret', async () => {
      await start(createBrokerScope({
        projectsPath: path.join(tmpDir, 'projects.yaml'),
        allowedRefs: ['aquaman://anthropic/api_key', 'aquaman://github/token'],
        loopbackDeniedServices: HERMES_SUPPORTED_SERVICES,
      }), true);
      const base = `http://${proxy!.getLoopbackAddress()}`;
      const post = (service: string, key: string) =>
        fetch(`${base}/broker/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN },
          body: JSON.stringify({ service, key }),
        });

      const provider = await post('anthropic', 'api_key');
      expect(provider.status).toBe(404);
      const providerText = await provider.text();
      expect(JSON.parse(providerText).code).toBe('broker_ref_isolated');
      expect(providerText).not.toContain('sk-ant-isolated');

      const project = await post('github', 'token');
      expect(project.status).toBe(200);
      expect(counting.gets).toBe(1);
    });
  });

  describe('NIST AU-2 — refusals are audited', () => {
    it('emits an unauthenticated BROKER event naming the refused ref', async () => {
      await start(createBrokerScope({ projectsPath: path.join(tmpDir, 'projects.yaml') }));
      await udsFetch(socketPath, '/broker/resolve', resolveBody('slack', 'bot_token'));
      const events = requestLog.filter((r) => r.method === 'BROKER');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ service: 'slack', statusCode: 404, authenticated: false });
      expect(events[0].error).toBe('broker_ref_not_declared: slack/bot_token');
    });
  });
});

/**
 * The same guarantees against the real CLI processes, in an isolated
 * AQUAMAN_CONFIG_DIR with the encrypted-file backend. The broker never talks
 * to an upstream, so these requests stay local.
 */
describe('Credential broker scoping — real CLI processes', () => {
  const TIMEOUT = 45_000;
  let env: TempEnv;
  let child: ChildProcess | null = null;

  beforeEach(async () => {
    env = createTempEnv({ withConfig: true });
    const store = new EncryptedFileStore(env.env.AQUAMAN_ENCRYPTION_PASSWORD, path.join(env.aquamanDir, 'credentials.enc'));
    await store.set('github', 'token', 'ghp_cli_declared_value_0987654321');
    await store.set('anthropic', 'api_key', 'sk-ant-cli-isolated-value-0987654321');
  });

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { child?.kill('SIGKILL'); resolve(); }, 5_000);
        child!.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    child = null;
    env.cleanup();
  });

  /** Spawn an aquaman CLI command and wait until its socket answers /_health. */
  async function spawnProxy(args: string[]): Promise<string> {
    const socket = path.join(env.aquamanDir, 'proxy.sock');
    const proc = spawn('npx', ['tsx', CLI_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env.env },
    });
    child = proc;
    let output = '';
    proc.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { output += d.toString(); });

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`${args.join(' ')} exited early:\n${output}`);
      try {
        const health = await udsFetch(socket, '/_health');
        if (health.status === 200) return socket;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`${args.join(' ')} never became healthy:\n${output}`);
  }

  it('`aquaman openclaw plugin-mode` never materializes a stored credential (the ClawScan finding)', async () => {
    // Even a projects.yaml declaration must not open the OpenClaw proxy's broker.
    fs.writeFileSync(path.join(env.aquamanDir, 'projects.yaml'),
      'version: 1\nprojects:\n  app:\n    paths: ["/tmp"]\n    env:\n      GITHUB_TOKEN: aquaman://github/token\n');
    const socket = await spawnProxy(['openclaw', 'plugin-mode']);
    for (const [service, key] of [['github', 'token'], ['anthropic', 'api_key']]) {
      const res = await udsFetch(socket, '/broker/resolve', resolveBody(service, key));
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('broker_disabled');
      expect(res.body).not.toMatch(/ghp_cli_declared|sk-ant-cli-isolated/);
    }
  }, TIMEOUT);

  it('`aquaman daemon` serves the ref declared in projects.yaml and refuses the rest', async () => {
    fs.writeFileSync(path.join(env.aquamanDir, 'projects.yaml'),
      'version: 1\nprojects:\n  app:\n    paths: ["/tmp"]\n    env:\n      GITHUB_TOKEN: aquaman://github/token\n');
    const socket = await spawnProxy(['daemon']);

    const declared = await udsFetch(socket, '/broker/resolve', resolveBody('github', 'token'));
    expect(declared.status).toBe(200);
    expect(JSON.parse(declared.body).value).toBe('ghp_cli_declared_value_0987654321');

    const undeclared = await udsFetch(socket, '/broker/resolve', resolveBody('anthropic', 'api_key'));
    expect(undeclared.status).toBe(404);
    expect(JSON.parse(undeclared.body).code).toBe('broker_ref_not_declared');
    expect(undeclared.body).not.toContain('sk-ant-cli-isolated');
  }, TIMEOUT);

  it('`aquaman daemon` picks up `aquaman broker allow` without a restart', async () => {
    const socket = await spawnProxy(['daemon']);
    const before = await udsFetch(socket, '/broker/resolve', resolveBody('github', 'token'));
    expect(before.status).toBe(404);

    const allow = await new Promise<number | null>((resolve) => {
      const p = spawn('npx', ['tsx', CLI_PATH, 'broker', 'allow', 'aquaman://github/token'], {
        stdio: 'ignore',
        env: { ...process.env, ...env.env },
      });
      p.on('exit', resolve);
    });
    expect(allow).toBe(0);

    const after = await udsFetch(socket, '/broker/resolve', resolveBody('github', 'token'));
    expect(after.status).toBe(200);
  }, TIMEOUT);
});
