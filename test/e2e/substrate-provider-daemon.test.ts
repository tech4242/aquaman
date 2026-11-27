/**
 * E2E: `aquaman daemon` serving the Agent Substrate credential provider.
 *
 * A real daemon process on an encrypted-file vault in a home of its own, with
 * certificates from an authority the test makes, called by a real gRPC client
 * the way Substrate's egress gateway calls a provider. The gateway itself is
 * run by scripts/e2e-substrate.sh on a kind cluster.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { substrateProtoDir } from '../../packages/proxy/src/substrate/grpc-server.js';
import { DEFAULT_CALLER_SPIFFE_ID } from '../../packages/proxy/src/substrate/integration.js';
import { createTempEnv, type TempEnv } from '../helpers/temp-env.js';
import { createTestAuthority, type Leaf, type TestAuthority } from '../helpers/test-pki.js';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');
const TIMEOUT = 60_000;
const SERVER_NAME = 'aquaman-credential-provider.ate-system.svc';
const VALUE = 'ghp_' + 'substrateDaemonE2eValue0123456789ab';
const ACTOR = 'spiffe://substrate-actor.local/actor/team-a/coder';

describe('aquaman daemon as an Agent Substrate credential provider', () => {
  let env: TempEnv;
  let daemon: ChildProcess | null = null;
  let output = '';
  let port = 0;
  let serving: TestAuthority;
  let gateway: Leaf;
  let Client: any;

  const run = (args: string[]): Promise<{ code: number | null; out: string }> => new Promise((resolve) => {
    const p = spawn('npx', ['tsx', CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env.env, NO_COLOR: '1' } });
    let out = '';
    p.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
    p.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
    p.on('exit', (code) => resolve({ code, out }));
  });

  const fetch = (client: Leaf, uri: string, actor = ACTOR): Promise<{ value?: string; code?: number; message?: string }> => {
    const c = new Client(`127.0.0.1:${port}`,
      grpc.credentials.createSsl(Buffer.from(serving.caPem), Buffer.from(client.keyPem), Buffer.from(client.certPem)),
      { 'grpc.ssl_target_name_override': SERVER_NAME, 'grpc.default_authority': SERVER_NAME, 'grpc.enable_retries': 0 });
    return new Promise((resolve) => {
      c.FetchSecret({ uri, actor_spiffe_id: actor }, { deadline: Date.now() + 5000 }, (err: any, res: any) => {
        c.close();
        resolve(err ? { code: err.code, message: String(err.details) } : { value: Buffer.from(res.opaque_bytes).toString('utf-8') });
      });
    });
  };

  beforeAll(async () => {
    env = createTempEnv({ withConfig: true });
    const pki = path.join(env.aquamanDir, 'pki');
    const identities = createTestAuthority(pki, 'pod-identity');
    serving = createTestAuthority(pki, 'service-dns');
    gateway = identities.issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
    const own = serving.issue('provider', { dns: [SERVER_NAME] });

    fs.appendFileSync(path.join(env.aquamanDir, 'config.yaml'), [
      'substrate:',
      '  provider:',
      '    enabled: true',
      '    listen: 127.0.0.1:0',
      '    tls:',
      `      certFile: ${own.bundleFile}`,
      `      clientCaFile: ${identities.caFile}`,
      '    grants:',
      '      team-a:',
      '        - aquaman://github/token',
      '',
    ].join('\n'));

    const store = new EncryptedFileStore(env.env.AQUAMAN_ENCRYPTION_PASSWORD, path.join(env.aquamanDir, 'credentials.enc'));
    await store.set('github', 'token', VALUE);
    await store.set('stripe', 'api_key', 'sk_test_' + 'y'.repeat(24));

    const definition = protoLoader.loadSync('credprovider.proto', { includeDirs: [substrateProtoDir()], keepCase: true });
    Client = (grpc.loadPackageDefinition(definition) as any).substrate.credprovider.v1.CredentialProvider;

    daemon = spawn('npx', ['tsx', CLI_PATH, 'daemon'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env.env, NO_COLOR: '1' } });
    daemon.stdout!.on('data', (d: Buffer) => { output += d.toString(); });
    daemon.stderr!.on('data', (d: Buffer) => { output += d.toString(); });
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) throw new Error(`daemon exited early:\n${output}`);
      const m = /Agent Substrate credential provider: 127\.0\.0\.1:(\d+)/.exec(output);
      if (m) { port = Number(m[1]); break; }
      if (/credential provider not started/.test(output)) throw new Error(output);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!port) throw new Error(`the provider never reported its address:\n${output}`);
  }, TIMEOUT);

  afterAll(async () => {
    if (daemon && daemon.exitCode === null) {
      daemon.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { daemon?.kill('SIGKILL'); resolve(); }, 5_000);
        daemon!.on('exit', () => { clearTimeout(t); resolve(); });
      });
    }
    env?.cleanup();
  });

  it('hands a granted reference to the gateway and records the actor in a log that verifies', async () => {
    expect(await fetch(gateway, 'ate-secret://aquaman/github/token')).toEqual({ value: VALUE });

    const auditDir = path.join(env.aquamanDir, 'audit');
    const text = (fs.readdirSync(auditDir, { recursive: true }) as string[])
      .map((f) => path.join(auditDir, f)).filter((f) => fs.statSync(f).isFile() && f.endsWith('.jsonl'))
      .map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
    const entries = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.agentId === 'substrate');
    expect(entries).toEqual([expect.objectContaining({
      sessionId: 'actor/team-a/coder',
      data: expect.objectContaining({ service: 'github', operation: 'read', success: true, note: 'aquaman://github/token' }),
    })]);
    expect(text).not.toContain(VALUE);

    const verify = await run(['audit', 'verify', '--chain-only']);
    expect(verify.code).toBe(0);

    const tail = await run(['audit', 'tail']);
    expect(tail.out).toContain('github read OK (aquaman://github/token) for actor/team-a/coder');
  }, TIMEOUT);

  it('refuses a stored reference that was not granted, and the same reference over /broker/resolve', async () => {
    expect(await fetch(gateway, 'ate-secret://aquaman/stripe/api_key')).toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    // The grant is for the provider only: `aquaman get` asks the broker, which was told nothing.
    const get = await run(['get', 'aquaman://github/token']);
    expect(get.code).not.toBe(0);
    expect(get.out).not.toContain(VALUE);
  }, TIMEOUT);

  it('a grant added to the file reaches the running daemon', async () => {
    const file = path.join(env.aquamanDir, 'config.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('        - aquaman://github/token\n', '        - aquaman://github/token\n        - aquaman://stripe/api_key\n'));
    expect(await fetch(gateway, 'ate-secret://aquaman/stripe/api_key')).toHaveProperty('value');
  }, TIMEOUT);

  it('refuses a caller that is not the gateway', async () => {
    const other = createTestAuthority(path.join(env.aquamanDir, 'pki'), 'someone-else').issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
    expect(await fetch(other, 'ate-secret://aquaman/github/token')).not.toHaveProperty('value');
  }, TIMEOUT);

  it('doctor passes against the running daemon and names the caller it accepts', async () => {
    const file = path.join(env.aquamanDir, 'config.yaml');
    // Doctor looks for the listener on the configured port, so give it the one that was bound.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('listen: 127.0.0.1:0', `listen: 127.0.0.1:${port}`));
    const r = await run(['substrate', 'doctor']);
    expect(r.out).toContain(`Only caller accepted: ${DEFAULT_CALLER_SPIFFE_ID}`);
    expect(r.out).toContain('TLS files load');
    expect(r.out).toContain(`Listener accepts connections on port ${port}`);
    expect(r.out).toContain('All checks passed');
    expect(r.code).toBe(0);
  }, TIMEOUT);
});

describe('aquaman substrate doctor without a provider', () => {
  it('fails with what to set when nothing is configured', async () => {
    const env = createTempEnv({ withConfig: true });
    try {
      const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn('npx', ['tsx', CLI_PATH, 'substrate', 'doctor'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env.env, NO_COLOR: '1' } });
        let out = '';
        p.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
        p.stderr!.on('data', (d: Buffer) => { out += d.toString(); });
        p.on('exit', (code) => resolve({ code, out }));
      });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Provider not enabled');
      expect(r.out).toContain('substrate.provider.tls.certFile');
      expect(r.out).toContain('No grants yet');
    } finally {
      env.cleanup();
    }
  }, TIMEOUT);
});
