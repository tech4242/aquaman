/**
 * Conformance: the Agent Substrate credential provider.
 *
 * The provider is the daemon's one listener that another machine is meant to
 * reach, and it hands out values. The claims: only the egress gateway's
 * identity may call; an actor is given only what was granted to its atespace
 * or to itself; every refusal is decided before the vault is read; a value
 * leaves only after its audit entry is written.
 *
 * A real listener on 127.0.0.1 with certificates from an authority the test
 * makes, called by a real gRPC client. One row per attack; a limit the code
 * does not stop is an `it.fails` row whose name says so.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import * as http2 from 'node:http2';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { MemoryStore, VaultLockedError, type WrapperConfig } from 'aquaman-core';
import { startSubstrateProvider, DEFAULT_CALLER_SPIFFE_ID } from '../../packages/proxy/src/substrate/integration.js';
import { substrateProtoDir } from '../../packages/proxy/src/substrate/grpc-server.js';
import { createTestAuthority, type Leaf, type TestAuthority } from '../helpers/test-pki.js';
import { CountingStore } from '../helpers/counting-store.js';

const SERVER_NAME = 'aquaman-credential-provider.ate-system.svc';
const ACTOR = 'spiffe://substrate-actor.local/actor/team-a/coder';
const VALUE = 'ghp_' + 'substrateProviderTestValue0123456789';

interface AuditRow { session: string; agent: string; service: string; success: boolean; error?: string; note?: string }
type Answer = { value: string } | { code: number; message: string };

describe('Agent Substrate credential provider', () => {
  let dir: string;
  let identities: TestAuthority;   // signs workload identities (the gateway's client certificate)
  let serving: TestAuthority;      // signs the provider's serving certificate
  let gateway: Leaf;
  let server: Awaited<ReturnType<typeof startSubstrateProvider>>;
  let store: CountingStore;
  let inner: MemoryStore;
  let audit: AuditRow[];
  let auditFails = false;
  let configPath: string;
  let servingFile: string;
  let clientCaFile: string;
  let Client: any;

  const writeGrants = (grants: Record<string, string[]>) => {
    fs.writeFileSync(configPath, JSON.stringify({ substrate: { provider: { grants } } }));
    // The grants are re-read when the file's stamp changes; make sure it does within one millisecond tick.
    const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
    fs.utimesSync(configPath, t, t);
  };

  const call = (client: Leaf | null, req: { uri: string; actor_spiffe_id?: string }, trust: string = serving.caPem): Promise<Answer> => {
    const creds = client
      ? grpc.credentials.createSsl(Buffer.from(trust), Buffer.from(client.keyPem), Buffer.from(client.certPem))
      : grpc.credentials.createSsl(Buffer.from(trust));
    const c = new Client(`127.0.0.1:${server.port}`, creds, {
      'grpc.ssl_target_name_override': SERVER_NAME,
      'grpc.default_authority': SERVER_NAME,
      'grpc.enable_retries': 0,
    });
    return new Promise((resolve) => {
      c.FetchSecret({ actor_spiffe_id: ACTOR, ...req }, { deadline: Date.now() + 4000 }, (err: any, res: any) => {
        c.close();
        if (err) resolve({ code: err.code, message: String(err.details ?? err.message) });
        else resolve({ value: Buffer.from(res.opaque_bytes).toString('utf-8') });
      });
    });
  };
  const fetch = (uri: string, actor: string = ACTOR) => call(gateway, { uri, actor_spiffe_id: actor });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqsub-'));
    identities = createTestAuthority(dir, 'pod-identity');
    serving = createTestAuthority(dir, 'service-dns');
    gateway = identities.issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
    const own = serving.issue('provider', { dns: [SERVER_NAME] });
    servingFile = path.join(dir, 'credential-bundle.pem');
    clientCaFile = path.join(dir, 'trust-bundle.pem');
    fs.copyFileSync(own.bundleFile, servingFile);
    fs.copyFileSync(identities.caFile, clientCaFile);
    configPath = path.join(dir, 'config.yaml');

    const definition = protoLoader.loadSync('credprovider.proto', { includeDirs: [substrateProtoDir()], keepCase: true });
    Client = (grpc.loadPackageDefinition(definition) as any).substrate.credprovider.v1.CredentialProvider;

    inner = new MemoryStore();
    store = new CountingStore(inner);
    const config = {
      // The rows below ask far more often than one actor would; the rate has a row of its own.
      substrate: { provider: { enabled: true, listen: '127.0.0.1:0', fetchesPerSecond: 10000, tls: { certFile: servingFile, clientCaFile } } },
    } as unknown as WrapperConfig;
    server = await startSubstrateProvider({
      config,
      store,
      configPath,
      // Every refusal gets its entry here; the limiter has rows of its own below.
      refusalWindowMs: 0,
      audit: {
        logCredentialAccess(session, agent, access) {
          if (auditFails) return Promise.reject(new Error('disk full'));
          audit.push({ session, agent, ...access });
          return Promise.resolve({});
        },
      },
    });
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    audit = [];
    auditFails = false;
    store.gets = 0;
    await inner.set('github', 'token', VALUE);
    await inner.set('stripe', 'api_key', 'sk_test_' + 'x'.repeat(24));
    await inner.set('notes', 'multiline', 'first\nsecond');
    writeGrants({ 'team-a': ['aquaman://github/token', 'aquaman://notes/multiline', 'aquaman://github/absent'], 'team-a/billing': ['aquaman://stripe/api_key'] });
  });

  it('hands a granted reference to the gateway and records who it was for', async () => {
    expect(await fetch('ate-secret://aquaman/github/token')).toEqual({ value: VALUE });
    expect(audit).toEqual([
      { session: 'actor/team-a/coder', agent: 'substrate', service: 'github', operation: 'read', success: true, error: undefined, note: 'aquaman://github/token' },
    ]);
  });

  describe('who may call', () => {
    const refused = async (answer: Promise<Answer>) => {
      const a = await answer;
      expect(a).not.toHaveProperty('value');
      expect(store.gets).toBe(0);
      return a as { code: number; message: string };
    };

    it('a caller without a certificate does not get past the handshake', async () => {
      await refused(call(null, { uri: 'ate-secret://aquaman/github/token' }));
      expect(audit).toEqual([]);
    });

    it('a certificate from another authority does not get past the handshake', async () => {
      const other = createTestAuthority(dir, 'someone-else').issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
      await refused(call(other, { uri: 'ate-secret://aquaman/github/token' }));
    });

    it('a certificate from the serving authority is not a caller', async () => {
      const wrong = serving.issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
      await refused(call(wrong, { uri: 'ate-secret://aquaman/github/token' }));
    });

    it('an expired certificate does not get past the handshake', async () => {
      const old = identities.issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID], expired: true });
      await refused(call(old, { uri: 'ate-secret://aquaman/github/token' }));
    });

    it.each([
      ['another workload of the same authority', ['spiffe://cluster.local/ns/ate-system/sa/aquaman-credential-provider']],
      ['an actor certificate', ['spiffe://substrate-actor.local/actor/team-a/coder']],
      ['the gateway of another namespace', ['spiffe://cluster.local/ns/other/sa/atenet-egress']],
      ['a longer name that begins with the gateway identity', [`${DEFAULT_CALLER_SPIFFE_ID}/x`]],
      ['the gateway identity in upper case', [DEFAULT_CALLER_SPIFFE_ID.toUpperCase().replace('SPIFFE', 'spiffe')]],
      ['two names, one of them the gateway identity', ['spiffe://cluster.local/ns/x/sa/y', DEFAULT_CALLER_SPIFFE_ID]],
      ['one name that reads as two when printed', [`spiffe://cluster.local/ns/x/sa/y, URI:${DEFAULT_CALLER_SPIFFE_ID}`]],
      ['no URI name at all', []],
    ])('%s is refused before the request is looked at', async (_what, uris) => {
      const cert = identities.issue('workload', { uris, dns: ['workload.svc'] });
      const a = await refused(call(cert, { uri: 'ate-secret://aquaman/github/token' }));
      expect(a.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ session: 'caller', agent: 'substrate', service: 'aquaman-substrate', success: false });
    });

    it('TLS 1.2 is not accepted', async () => {
      const outcome = await new Promise<string>((resolve) => {
        const socket = tls.connect({
          host: '127.0.0.1', port: server.port, servername: SERVER_NAME, ca: serving.caPem,
          key: gateway.keyPem, cert: gateway.certPem, ALPNProtocols: ['h2'], maxVersion: 'TLSv1.2',
        });
        socket.once('secureConnect', () => { socket.destroy(); resolve('connected'); });
        socket.once('error', (err) => resolve(`error: ${err.message}`));
      });
      expect(outcome).toMatch(/^error: /);
    });

    it('a caller with another identity is answered when its headers arrive, so it cannot leave calls waiting', async () => {
      const other = identities.issue('workload', { uris: ['spiffe://cluster.local/ns/tenant/sa/app'] });
      const session = http2.connect(`https://127.0.0.1:${server.port}`, {
        ca: serving.caPem, key: other.keyPem, cert: other.certPem, servername: SERVER_NAME,
      });
      try {
        const status = await new Promise<string>((resolve, reject) => {
          const stream = session.request({
            ':method': 'POST', ':path': '/substrate.credprovider.v1.CredentialProvider/FetchSecret',
            'content-type': 'application/grpc', te: 'trailers',
          });
          // No body is sent and the request is never ended.
          const timer = setTimeout(() => reject(new Error('the call was left waiting')), 3000);
          const done = (h: Record<string, unknown>) => { if (h['grpc-status'] !== undefined) { clearTimeout(timer); resolve(String(h['grpc-status'])); } };
          stream.on('response', done);
          stream.on('trailers', done);
          stream.on('error', () => { /* the stream is closed by the answer */ });
        });
        expect(status).toBe(String(grpc.status.PERMISSION_DENIED));
        expect(store.gets).toBe(0);
      } finally {
        session.destroy();
      }
    });

    it('the refusal of a caller says which identity it presented and where it came from', async () => {
      const other = identities.issue('workload', { uris: ['spiffe://cluster.local/ns/tenant/sa/app'] });
      await call(other, { uri: 'ate-secret://aquaman/github/token' });
      expect(audit).toHaveLength(1);
      expect(audit[0].error).toContain('spiffe://cluster.local/ns/tenant/sa/app');
      expect(audit[0].error).toContain('127.0.0.1');
    });

    it('a connection is closed when the authority it was checked against is replaced', async () => {
      const creds = grpc.credentials.createSsl(Buffer.from(serving.caPem), Buffer.from(gateway.keyPem), Buffer.from(gateway.certPem));
      const kept = new Client(`127.0.0.1:${server.port}`, creds, {
        'grpc.ssl_target_name_override': SERVER_NAME, 'grpc.default_authority': SERVER_NAME, 'grpc.enable_retries': 0,
      });
      const ask = (): Promise<Answer> => new Promise((resolve) => {
        kept.FetchSecret({ uri: 'ate-secret://aquaman/github/token', actor_spiffe_id: ACTOR }, { deadline: Date.now() + 4000 }, (err: any, res: any) => {
          resolve(err ? { code: err.code, message: String(err.details) } : { value: Buffer.from(res.opaque_bytes).toString('utf-8') });
        });
      });
      const previous = fs.readFileSync(clientCaFile);
      try {
        expect(await ask()).toEqual({ value: VALUE });
        fs.copyFileSync(createTestAuthority(dir, 'pod-identity-replaced').caFile, clientCaFile);
        expect(server.reload()).toBe(true);
        // The same client, whose connection was opened under the old authority, with the old certificate.
        store.gets = 0;
        expect(await ask()).not.toHaveProperty('value');
        expect(await ask()).not.toHaveProperty('value');
        expect(store.gets).toBe(0);
      } finally {
        kept.close();
        fs.writeFileSync(clientCaFile, previous);
        const t = new Date(Date.now() + 9000);
        fs.utimesSync(clientCaFile, t, t);
        server.reload();
      }
      expect(await fetch('ate-secret://aquaman/github/token')).toEqual({ value: VALUE });
    });

    it('the serving certificate is one the gateway can check by name', async () => {
      const a = await call(gateway, { uri: 'ate-secret://aquaman/github/token' }, identities.caPem);
      expect(a).not.toHaveProperty('value');
    });
  });

  describe('what a request may name', () => {
    it.each([
      ['another provider', 'ate-secret://k8s.io/github/token'],
      ['a provider name that only begins like ours', 'ate-secret://aquaman.evil/github/token'],
      ['no key', 'ate-secret://aquaman/github'],
      ['an empty key', 'ate-secret://aquaman/github/'],
      ['a third segment', 'ate-secret://aquaman/github/token/extra'],
      ['a dot segment', 'ate-secret://aquaman/github/../github/token'],
      ['an escaped separator', 'ate-secret://aquaman/github%2Ftoken/x%2F'],
      ['an escape in the service', 'ate-secret://aquaman/git%68ub/token'],
      ['a query', 'ate-secret://aquaman/github/token?version=2'],
      ['a fragment', 'ate-secret://aquaman/github/token#x'],
      ['a port', 'ate-secret://aquaman:443/github/token'],
      ['a user part', 'ate-secret://x@aquaman/github/token'],
      ['an upper-case service', 'ate-secret://aquaman/GitHub/token'],
      ['another scheme', 'aquaman://github/token'],
      ['a line break', 'ate-secret://aquaman/github/token\n'],
      ['nothing', ''],
    ])('a URI with %s is refused and the vault is not read', async (_what, uri) => {
      const a = await fetch(uri);
      expect(a).toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
      expect(store.gets).toBe(0);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ service: 'aquaman-substrate', success: false });
    });

    it("aquaman's own records are not handed out, granted or not", async () => {
      writeGrants({ 'team-a': ['aquaman://aquaman_internal/audit_anchor'] });
      await inner.set('aquaman_internal', 'audit_anchor', '{"v":1}');
      const a = await fetch('ate-secret://aquaman/aquaman_internal/audit_anchor');
      expect(a).toMatchObject({ code: grpc.status.PERMISSION_DENIED });
      expect(store.gets).toBe(0);
    });

    it('a refusal does not repeat control characters or long text from the request', async () => {
      const a = await fetch(`ate-secret://other/\u001b[31m${'A'.repeat(400)}`) as { message: string };
      expect([...a.message].some((c) => c.charCodeAt(0) < 0x20)).toBe(false);
      expect(a.message.length).toBeLessThan(400);
    });
  });

  describe('which actor is given what', () => {
    const denied = async (uri: string, actor: string) => {
      const a = await fetch(uri, actor);
      expect(a).toMatchObject({ code: grpc.status.PERMISSION_DENIED });
      expect(store.gets).toBe(0);
      expect(audit.at(-1)).toMatchObject({ success: false });
    };

    it.each([
      ['another atespace', 'spiffe://substrate-actor.local/actor/team-b/coder'],
      ['an atespace whose name begins like the granted one', 'spiffe://substrate-actor.local/actor/team-a.evil/coder'],
      ['another trust domain', 'spiffe://cluster.local/actor/team-a/coder'],
      ['a workload identity that is not an actor', 'spiffe://substrate-actor.local/worker-for-actor/team-a/coder'],
      ['an extra segment', 'spiffe://substrate-actor.local/actor/team-a/coder/x'],
      ['no actor name', 'spiffe://substrate-actor.local/actor/team-a'],
      ['an empty actor name', 'spiffe://substrate-actor.local/actor/team-a/'],
      ['a dot segment', 'spiffe://substrate-actor.local/actor/team-b/../team-a/coder'],
      ['an escaped separator', 'spiffe://substrate-actor.local/actor/team-b%2F..%2Fteam-a/coder'],
      ['upper case', 'spiffe://substrate-actor.local/actor/Team-A/coder'],
      ['a query', 'spiffe://substrate-actor.local/actor/team-a/coder?x=1'],
      ['nothing', ''],
    ])('an actor identity with %s gets nothing', async (_what, actor) => {
      await denied('ate-secret://aquaman/github/token', actor);
    });

    it('a reference in the vault that was not granted is refused like one that is not there', async () => {
      await denied('ate-secret://aquaman/stripe/api_key', ACTOR);
      const absent = await fetch('ate-secret://aquaman/nothing/here');
      expect(absent).toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    });

    it('a grant to one actor is not a grant to the atespace', async () => {
      expect(await fetch('ate-secret://aquaman/stripe/api_key', 'spiffe://substrate-actor.local/actor/team-a/billing'))
        .toHaveProperty('value');
      store.gets = 0;
      await denied('ate-secret://aquaman/stripe/api_key', 'spiffe://substrate-actor.local/actor/team-a/coder');
    });

    it('a grant to an atespace is a grant to every actor in it', async () => {
      expect(await fetch('ate-secret://aquaman/github/token', 'spiffe://substrate-actor.local/actor/team-a/billing'))
        .toEqual({ value: VALUE });
    });

    it('a grant taken out of the file stops the next fetch', async () => {
      expect(await fetch('ate-secret://aquaman/github/token')).toHaveProperty('value');
      writeGrants({ 'team-a': [] });
      store.gets = 0;
      await denied('ate-secret://aquaman/github/token', ACTOR);
    });

    it.each([
      ['a file that does not parse', '{ substrate: [unclosed'],
      ['grants that are a list', JSON.stringify({ substrate: { provider: { grants: ['aquaman://github/token'] } } })],
      ['a grant key with a wildcard', JSON.stringify({ substrate: { provider: { grants: { '*': ['aquaman://github/token'] } } } })],
      ['a grant key with three parts', JSON.stringify({ substrate: { provider: { grants: { 'team-a/coder/x': ['aquaman://github/token'] } } } })],
      ['a reference with a wildcard', JSON.stringify({ substrate: { provider: { grants: { 'team-a': ['aquaman://github/*'] } } } })],
      ['a reference that is not a list entry', JSON.stringify({ substrate: { provider: { grants: { 'team-a': 'aquaman://github/token' } } } })],
      ['no file', null],
    ])('%s grants nothing', async (_what, content) => {
      if (content === null) fs.rmSync(configPath);
      else fs.writeFileSync(configPath, content);
      await denied('ate-secret://aquaman/github/token', ACTOR);
    });

    it('a grant is not a declaration for /broker/resolve', async () => {
      const { createBrokerScope } = await import('aquaman-proxy');
      const scope = createBrokerScope({ projectsPath: path.join(dir, 'no-projects.yaml'), configPath });
      expect(scope.check('github', 'token', 'uds').allowed).toBe(false);
    });

    it('an unreadable request is on the account of the actor that sent it', async () => {
      await fetch('ate-secret://aquaman/not a uri');
      expect(audit.at(-1)).toMatchObject({ session: 'actor/team-a/coder', service: 'aquaman-substrate', success: false });
    });

    // The gateway states which actor it fetches for, and the provider has no way to check it.
    it.fails('limit: a gateway that names an actor it is not acting for is believed', async () => {
      // The caller holds the gateway's certificate and asks in the name of an actor of its choosing.
      const a = await fetch('ate-secret://aquaman/stripe/api_key', 'spiffe://substrate-actor.local/actor/team-a/billing');
      expect(a).toMatchObject({ code: grpc.status.PERMISSION_DENIED });
    });
  });

  describe('what is handed out', () => {
    it('a granted reference that is not in the vault is not found', async () => {
      expect(await fetch('ate-secret://aquaman/github/absent')).toMatchObject({ code: grpc.status.NOT_FOUND });
      expect(audit.at(-1)).toMatchObject({ service: 'github', success: false, note: 'aquaman://github/absent' });
    });

    it('a value with a line break is refused with the reason, not passed on for the gateway to reject', async () => {
      const a = await fetch('ate-secret://aquaman/notes/multiline') as { code: number; message: string };
      expect(a.code).toBe(grpc.status.FAILED_PRECONDITION);
      expect(a.message).not.toContain('first');
    });

    it('a locked vault is unavailable, not a refusal', async () => {
      const get = inner.get.bind(inner);
      inner.get = async () => { throw new VaultLockedError(); };
      try {
        const a = await fetch('ate-secret://aquaman/github/token') as { code: number; message: string };
        expect(a.code).toBe(grpc.status.UNAVAILABLE);
        expect(a.message).toContain('aquaman unlock');
      } finally {
        inner.get = get;
      }
    });

    it('a vault that fails is unavailable', async () => {
      const get = inner.get.bind(inner);
      inner.get = async () => { throw new Error('connection refused'); };
      try {
        expect(await fetch('ate-secret://aquaman/github/token')).toMatchObject({ code: grpc.status.UNAVAILABLE });
      } finally {
        inner.get = get;
      }
    });

    it('no value leaves when its audit entry cannot be written', async () => {
      auditFails = true;
      const a = await fetch('ate-secret://aquaman/github/token') as { code: number; message: string };
      expect(a.code).toBe(grpc.status.UNAVAILABLE);
      expect(a.message).toContain('audit log');
      expect(JSON.stringify(a)).not.toContain(VALUE);
    });

    it('a refusal stands when its audit entry cannot be written', async () => {
      auditFails = true;
      expect(await fetch('ate-secret://aquaman/stripe/api_key')).toMatchObject({ code: grpc.status.PERMISSION_DENIED });
      expect(store.gets).toBe(0);
    });

    it('what a vault says in an error reaches the gateway log as one bounded line', async () => {
      const get = inner.get.bind(inner);
      inner.get = async () => { throw new Error(`permission denied\nERROR forged line ${'x'.repeat(500)}`); };
      try {
        const a = await fetch('ate-secret://aquaman/github/token') as { code: number; message: string };
        expect(a.code).toBe(grpc.status.UNAVAILABLE);
        expect(a.message).not.toContain('\n');
        expect(a.message.length).toBeLessThan(400);
      } finally {
        inner.get = get;
      }
    });

    it('a problem in the grants of one atespace is not told to another', async () => {
      fs.writeFileSync(configPath, JSON.stringify({ substrate: { provider: { grants: { 'team-b': ['not a reference\nERROR forged line'], 'team-a': [] } } } }));
      const a = await fetch('ate-secret://aquaman/github/token') as { code: number; message: string };
      expect(a.code).toBe(grpc.status.PERMISSION_DENIED);
      expect(a.message).not.toContain('team-b');
      expect(a.message).not.toContain('forged');
    });

    it('an actor over its rate is told to slow down, and another actor is still served', async () => {
      // A second listener with the rate it has when nothing is configured.
      const main = server;
      const config = { substrate: { provider: { enabled: true, listen: '127.0.0.1:0', tls: { certFile: servingFile, clientCaFile } } } } as unknown as WrapperConfig;
      const limited = await startSubstrateProvider({ config, store, configPath, audit: { logCredentialAccess: () => Promise.resolve({}) } });
      server = limited;
      try {
        const answers = await Promise.all(Array.from({ length: 120 }, () => fetch('ate-secret://aquaman/github/token')));
        const served = answers.filter((x) => 'value' in x).length;
        const slowed = answers.filter((x) => 'code' in x && x.code === grpc.status.UNAVAILABLE) as Array<{ message: string }>;
        // Forty at once, plus what the bucket gained while they were answered.
        expect(served).toBeGreaterThanOrEqual(40);
        expect(served).toBeLessThan(100);
        expect(slowed.length).toBe(120 - served);
        expect(slowed[0].message).toContain('fetches a second');
        expect(await fetch('ate-secret://aquaman/github/token', 'spiffe://substrate-actor.local/actor/team-a/billing')).toEqual({ value: VALUE });
      } finally {
        server = main;
        await limited.stop();
      }
    });

    it('no message carries a stored value', async () => {
      const answers = await Promise.all([
        fetch('ate-secret://aquaman/notes/multiline'),
        fetch('ate-secret://aquaman/stripe/api_key'),
        fetch('ate-secret://aquaman/github/absent'),
      ]);
      const text = JSON.stringify(answers) + JSON.stringify(audit);
      expect(text).not.toContain('sk_test_');
      expect(text).not.toContain('second');
    });
  });

  it.each([false, 0, '', null])('does not start with the audit log switched off (audit.enabled: %j)', async (enabled) => {
    const config = {
      audit: { enabled },
      substrate: { provider: { enabled: true, listen: '127.0.0.1:0', tls: { certFile: servingFile, clientCaFile } } },
    } as unknown as WrapperConfig;
    await expect(startSubstrateProvider({ config, store, configPath, audit: { logCredentialAccess: () => null } }))
      .rejects.toThrow(/audit\.enabled is not true/);
  });

  describe('limits, stated', () => {
    // The daemon caches what it read from a backend that is slow or prompts (HashiCorp Vault: 15 minutes).
    it.fails('limit: a key deleted in a cached backend is not refused until the cache time is over', async () => {
      const { CachingStore } = await import('../../packages/proxy/src/core/credentials/caching-store.js');
      const backend = new MemoryStore();
      await backend.set('github', 'token', VALUE);
      const cached = new CachingStore(backend, 900);
      const { createSubstrateProviderCore } = await import('../../packages/proxy/src/substrate/credential-provider.js');
      const core = createSubstrateProviderCore({
        store: cached, providerName: 'aquaman', actorTrustDomain: 'substrate-actor.local',
        grants: () => ({ grants: new Map([['team-a', new Set(['aquaman://github/token'])]]) }),
      });
      const ask = () => core.fetchSecret({ uri: 'ate-secret://aquaman/github/token', actor_spiffe_id: ACTOR });
      await ask();
      await backend.delete('github', 'token');   // by another process: the vault's own tools, or a second aquaman
      await expect(ask()).rejects.toMatchObject({ code: 'not_found' });
    });

    // aquaman bounds what one connection holds, not how many are opened: that is the NetworkPolicy's part.
    it.fails('limit: a workload with a certificate of the same authority can open as many connections as it likes', async () => {
      const other = identities.issue('workload', { uris: ['spiffe://cluster.local/ns/tenant/sa/app'] });
      const open = (): Promise<boolean> => new Promise((resolve) => {
        const socket = tls.connect({
          host: '127.0.0.1', port: server.port, servername: SERVER_NAME, ca: serving.caPem,
          key: other.keyPem, cert: other.certPem, ALPNProtocols: ['h2'],
        });
        socket.once('secureConnect', () => { sockets.push(socket); resolve(true); });
        socket.once('error', () => resolve(false));
      });
      const sockets: tls.TLSSocket[] = [];
      try {
        const results = await Promise.all(Array.from({ length: 60 }, open));
        expect(results).toContain(false);
      } finally {
        for (const socket of sockets) socket.destroy();
      }
    });
  });

  describe('certificates that are renewed', () => {
    it('a new serving certificate and a new caller authority are adopted without a restart', async () => {
      const nextIdentities = createTestAuthority(dir, 'pod-identity-next');
      const nextServing = createTestAuthority(dir, 'service-dns-next');
      const nextGateway = nextIdentities.issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
      const previous = { serving: fs.readFileSync(servingFile), ca: fs.readFileSync(clientCaFile) };
      try {
        fs.copyFileSync(nextServing.issue('provider', { dns: [SERVER_NAME] }).bundleFile, servingFile);
        fs.copyFileSync(nextIdentities.caFile, clientCaFile);
        expect(server.reload()).toBe(true);

        expect(await call(nextGateway, { uri: 'ate-secret://aquaman/github/token' }, nextServing.caPem)).toEqual({ value: VALUE });
        // The caller the previous authority signed is no longer one.
        store.gets = 0;
        expect(await call(gateway, { uri: 'ate-secret://aquaman/github/token' }, nextServing.caPem)).not.toHaveProperty('value');
        expect(store.gets).toBe(0);
      } finally {
        fs.writeFileSync(servingFile, previous.serving);
        fs.writeFileSync(clientCaFile, previous.ca);
        const t = new Date(Date.now() + 5000);
        fs.utimesSync(servingFile, t, t);
        expect(server.reload()).toBe(true);
      }
      expect(await fetch('ate-secret://aquaman/github/token')).toEqual({ value: VALUE });
    });

    it.each([
      ['a serving file that is cut off', (f: string) => fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').slice(0, 200))],
      ['a serving file that is gone', (f: string) => fs.rmSync(f)],
      ['a key that belongs to another certificate', (f: string) => {
        const other = serving.issue('other', { dns: [SERVER_NAME] });
        fs.writeFileSync(f, other.keyPem + fs.readFileSync(f, 'utf-8').replace(/-----BEGIN (EC )?PRIVATE KEY-----[\s\S]*?-----END (EC )?PRIVATE KEY-----\n/, ''));
      }],
    ])('%s is not adopted, and the listener keeps the set it has', async (_what, damage) => {
      const previous = fs.readFileSync(servingFile);
      try {
        damage(servingFile);
        expect(server.reload()).toBe(false);
        expect(await fetch('ate-secret://aquaman/github/token')).toEqual({ value: VALUE });
      } finally {
        fs.writeFileSync(servingFile, previous);
        server.reload();
      }
    });

    it('an authority bundle with a certificate that does not parse is not adopted', async () => {
      const previous = fs.readFileSync(clientCaFile);
      try {
        fs.writeFileSync(clientCaFile, '-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n');
        expect(server.reload()).toBe(false);
        fs.writeFileSync(clientCaFile, previous.toString('utf-8').slice(0, 300) + '\n-----END CERTIFICATE-----\n');
        expect(server.reload()).toBe(false);
        expect(await fetch('ate-secret://aquaman/github/token')).toEqual({ value: VALUE });
      } finally {
        fs.writeFileSync(clientCaFile, previous);
        server.reload();
      }
    });

    it('an authority bundle with no certificate is not adopted', async () => {
      const previous = fs.readFileSync(clientCaFile);
      try {
        fs.writeFileSync(clientCaFile, '');
        expect(server.reload()).toBe(false);
        expect(await fetch('ate-secret://aquaman/github/token')).toEqual({ value: VALUE });
        // A certificate signed by a public authority would be the risk; one from any other authority stands in for it.
        const outsider = createTestAuthority(dir, 'outsider').issue('atenet-egress', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
        expect(await call(outsider, { uri: 'ate-secret://aquaman/github/token' })).not.toHaveProperty('value');
      } finally {
        fs.writeFileSync(clientCaFile, previous);
        server.reload();
      }
    });
  });
});
