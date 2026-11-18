/**
 * Conformance: the service name aquaman keeps the audit anchor under cannot
 * be reached by a caller.
 *
 * The anchor is only worth something if the software being audited cannot
 * move it through aquaman. Every entry point that takes a service name is
 * tried here against a proxy set up to be as permissive as its inputs can
 * make it: the reserved reference is declared in projects.yaml, routed in
 * projects.yaml, allowed in config.yaml and in the static list, the reserved
 * name has a service definition and is in the proxied list, and a second run
 * swaps in a scope that says yes to everything. One row per entry point and
 * spelling. After each, the stored anchor is what it was and no response
 * carried it.
 *
 * What this does not show: software that writes to the credential store
 * directly (the vault's own CLI, the encrypted file) is outside aquaman and
 * can move the anchor. That limit is a row in
 * nist/au-9-au-10-tampering.test.ts.
 *
 * NIST SP 800-53 AU-9 (protection of audit information), AC-3, AC-6.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUDIT_ANCHOR_KEY,
  RESERVED_SERVICE,
  createBrokerScope,
  createCredentialProxy,
  createServiceRegistry,
  isReservedService,
  loadProjectRefs,
  reservedServiceRefusal,
  type BrokerScope,
  type CredentialProxy,
  type CredentialPrompter,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { createOpenShellDriverCore } from '../../packages/proxy/src/openshell/credential-driver.js';
import { loadConfigAllowedRefs } from '../../packages/proxy/src/broker-scope.js';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const LOOPBACK_TOKEN = 'aqm_lb_reserved_test_token_0123456789abcdef';
const ANCHOR = JSON.stringify({ v: 1, seq: 41, hash: 'c0ffee'.repeat(10) + 'abcd', at: '2026-11-18T10:00:00.000Z' });
const ANCHOR_HASH = 'c0ffee'.repeat(10) + 'abcd';

/** Every spelling that is reserved, and that the service-name grammar lets through. */
const SPELLINGS = ['aquaman_internal', 'aquaman-internal', 'aquaman.internal', 'aquamaninternal'];

describe('isReservedService', () => {
  it.each([...SPELLINGS, 'AQUAMAN_INTERNAL', 'Aquaman-Internal'])('reserves %s', (name) => {
    expect(isReservedService(name)).toBe(true);
    expect(reservedServiceRefusal(name, 'audit_anchor')).toMatchObject({ allowed: false, code: 'broker_ref_reserved' });
  });

  it.each(['aquaman', 'internal', 'aquaman_internal2', 'my_aquaman_internal', 'aquaman__internal', 'github', '', undefined, null, 7])(
    'does not reserve %s',
    (name) => {
      expect(isReservedService(name)).toBe(false);
    },
  );

  it('the name aquaman uses is one of them, and has no hyphen for 1Password item names to split on', () => {
    expect(RESERVED_SERVICE).toBe('aquaman_internal');
    expect(isReservedService(RESERVED_SERVICE)).toBe(true);
    expect(RESERVED_SERVICE).toMatch(/^[a-z0-9][a-z0-9._]*$/);
    expect(AUDIT_ANCHOR_KEY).toMatch(/^[a-z0-9][a-z0-9._]*$/);
    expect(reservedServiceRefusal('github', 'token')).toBeNull();
  });
});

describe('the reserved service cannot be declared', () => {
  let dir: string;
  let projectsPath: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-rsv-'));
    projectsPath = path.join(dir, 'projects.yaml');
    configPath = path.join(dir, 'config.yaml');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const projectsYaml = (service: string) => [
    'projects:',
    '  app:',
    '    paths: ["/tmp/app"]',
    '    env:',
    `      ANCHOR: aquaman://${service}/audit_anchor`,
    `      ROUTED_ANCHOR: aquaman://${service}/api_key`,
    '      GITHUB_TOKEN: aquaman://github/token',
    '      STRIPE_SECRET_KEY: aquaman://stripe/secret_key',
    '    routes:',
    '      ROUTED_ANCHOR:',
    '        url_env: ANCHOR_BASE_URL',
    '      STRIPE_SECRET_KEY:',
    '        url_env: STRIPE_API_BASE',
    '',
  ].join('\n');

  for (const service of SPELLINGS) {
    it(`projects.yaml: an env ref and a routed ref to ${service} declare nothing; the refs beside them still count`, () => {
      fs.writeFileSync(projectsPath, projectsYaml(service));
      const loaded = loadProjectRefs(projectsPath);
      expect([...loaded.refs]).toEqual(['aquaman://github/token']);
      expect([...loaded.routedRefs!]).toEqual(['aquaman://stripe/secret_key']);
    });

    it(`config.yaml and the static list: ${service} in broker.allowedRefs declares nothing`, () => {
      fs.writeFileSync(configPath, `broker:\n  allowedRefs:\n    - aquaman://${service}/audit_anchor\n    - aquaman://npm/token\n`);
      expect([...loadConfigAllowedRefs(configPath).refs]).toEqual(['aquaman://npm/token']);

      fs.writeFileSync(projectsPath, projectsYaml(service));
      const scope = createBrokerScope({ projectsPath, configPath, allowedRefs: [`aquaman://${service}/audit_anchor`, 'aquaman://aws/key'] });
      expect(scope.declared().map((d) => d.ref)).toEqual(['aquaman://github/token', 'aquaman://aws/key', 'aquaman://npm/token']);
      expect([...scope.routedRefs!()]).toEqual(['aquaman://stripe/secret_key']);
      for (const caller of ['uds', 'loopback'] as const) {
        const decision = scope.check(service, 'audit_anchor', caller);
        expect(decision).toMatchObject({ allowed: false, code: 'broker_ref_reserved' });
        expect((decision as { reason: string }).reason).toBe(
          `aquaman://${service}/audit_anchor is not handed out: "${service}" is reserved for aquaman's own records and cannot be used as a credential`,
        );
        expect((decision as { fix: string }).fix).toContain('aquaman audit verify');
      }
      expect(scope.check('github', 'token', 'uds')).toEqual({ allowed: true });
    });
  }
});

describe('the reserved service cannot be reached through the proxy', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let socketPath: string;
  let dir: string;
  let log: RequestInfo[];
  let asked: string[];
  let declaredByRequest: string[];
  let loopbackPort: number;

  /** Which scope the proxy gets: the real one fed hostile files, or one that agrees to everything. */
  type ScopeKind = 'declared everywhere' | 'a scope that allows everything';

  async function start(kind: ScopeKind, service: string): Promise<void> {
    const projectsPath = path.join(dir, 'projects.yaml');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(projectsPath, [
      'projects:',
      '  app:',
      '    paths: ["/tmp/app"]',
      '    env:',
      `      ANCHOR: aquaman://${service}/audit_anchor`,
      `      ROUTED: aquaman://${service}/audit_anchor`,
      '      GITHUB_TOKEN: aquaman://github/token',
      '    routes:',
      '      ROUTED:',
      '        url_env: ANCHOR_BASE_URL',
      '      GITHUB_TOKEN:',
      '        url_env: GITHUB_API_URL',
      '',
    ].join('\n'));
    fs.writeFileSync(configPath, `broker:\n  allowedRefs:\n    - aquaman://${service}/audit_anchor\n`);
    const real = createBrokerScope({ projectsPath, configPath, allowedRefs: [`aquaman://${service}/audit_anchor`] });
    const permissive: BrokerScope = {
      check: () => ({ allowed: true }),
      declared: () => [{ ref: `aquaman://${service}/audit_anchor`, source: 'config.yaml' }],
      declarationError: () => undefined,
      routedRefs: () => new Set([`aquaman://${service}/audit_anchor`, 'aquaman://github/token']),
    };

    const registry = createServiceRegistry();
    registry.override('github', { upstream: `http://127.0.0.1:${upstream.port}` });
    // A definition for the reserved name whose injected key is the anchor.
    registry.register({
      name: service,
      upstream: `http://127.0.0.1:${upstream.port}`,
      authHeader: 'Authorization',
      authPrefix: 'Bearer ',
      credentialKey: 'audit_anchor',
    });

    const prompter: CredentialPrompter = {
      async askValue(r) { asked.push(`value:${r.service}/${r.key}`); return { outcome: 'entered', value: 'typed-by-the-test' }; },
      async askApproval(r) { asked.push(`approval:${r.service}/${r.key}`); return { outcome: 'approved' }; },
    };
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['github', service],
      broker: kind === 'declared everywhere' ? real : permissive,
      credentialRequests: { prompter, declare: (s, k) => { declaredByRequest.push(`${s}/${k}`); } },
      loopback: { port: loopbackPort, token: LOOPBACK_TOKEN },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const post = (urlPath: string, body: unknown) =>
    udsFetch(socketPath, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const loopback = async (urlPath: string, init: { token?: string; body?: unknown } = {}) => {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${init.token ?? LOOPBACK_TOKEN}` };
    const res = await fetch(
      `http://127.0.0.1:${loopbackPort}${urlPath}`,
      init.body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(init.body) },
    );
    return { status: res.status, body: await res.text() };
  };

  interface Attempt {
    name: string;
    /** Returns every response the attempt got. */
    run(service: string): Promise<Array<{ status: number; body: string }>>;
    /** What each response must be. */
    expect(res: { status: number; body: string }): void;
  }

  const reserved = (res: { status: number; body: string }) => {
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('broker_ref_reserved');
  };
  const notFound = (res: { status: number; body: string }) => {
    expect(res.status).toBe(404);
    expect(res.body).toBe('Not found');
  };

  const ATTEMPTS: Attempt[] = [
    {
      name: 'POST /broker/resolve over the Unix socket',
      run: async (service) => [await post('/broker/resolve', { service, key: 'audit_anchor' })],
      expect: reserved,
    },
    {
      name: 'POST /broker/resolve over the loopback listener',
      run: async (service) => [await loopback('/broker/resolve', { body: { service, key: 'audit_anchor' } })],
      expect: reserved,
    },
    {
      name: 'POST /broker/available (alone, and beside a ref that is available)',
      run: async (service) => [
        await post('/broker/available', { refs: [{ service, key: 'audit_anchor' }] }),
        await post('/broker/available', { refs: [{ service: 'github', key: 'token' }, { service, key: 'audit_anchor' }] }),
      ],
      expect(res) {
        expect(res.status).toBe(200);
        const { available } = JSON.parse(res.body) as { available: boolean[] };
        expect(available[available.length - 1]).toBe(false);
        if (available.length === 2) expect(available[0]).toBe(true);
      },
    },
    {
      name: 'POST /broker/request (to have the stored value approved for use)',
      run: async (service) => [await post('/broker/request', { service, key: 'audit_anchor', project: '/tmp/app' })],
      expect: reserved,
    },
    {
      name: 'POST /broker/request for a key that is not stored (to have a value typed in under the reserved service)',
      run: async (service) => [await post('/broker/request', { service, key: 'another_key' })],
      expect: reserved,
    },
    {
      name: 'POST /broker/request with routed: true',
      run: async (service) => [await post('/broker/request', { service, key: 'audit_anchor', routed: true })],
      expect: reserved,
    },
    {
      name: 'POST /broker/route',
      run: async (service) => [await post('/broker/route', { service, key: 'audit_anchor' })],
      expect: reserved,
    },
    {
      name: 'a forwarded request over the Unix socket',
      run: async (service) => [
        await udsFetch(socketPath, `/${service}/v1/anything`),
        await udsFetch(socketPath, `/${service}`, { method: 'POST', body: '{}' }),
      ],
      expect: notFound,
    },
    {
      name: 'a forwarded request over the loopback listener with the loopback token',
      run: async (service) => [await loopback(`/${service}/v1/anything`)],
      expect: notFound,
    },
    {
      name: 'a forwarded request with a route token obtained for another service',
      run: async (service) => {
        const routed = await post('/broker/route', { service: 'github', key: 'token' });
        // Only the permissive scope and the hostile projects.yaml route github; either way the token must not open the reserved name.
        const token = routed.status === 200 ? (JSON.parse(routed.body).token as string) : 'aqm_rt_not_a_token';
        const res = await loopback(`/${service}/v1/anything`, { token });
        // A token the listener does not accept for this path is a 401, an accepted one a 404. Neither forwards.
        return [{ status: res.status === 401 ? 404 : res.status, body: res.status === 401 ? 'Not found' : res.body }];
      },
      expect: notFound,
    },
  ];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-rsv-'));
    upstream = createMockUpstream();
    await upstream.start(0);
    store = new MemoryStore();
    await store.set('github', 'token', 'ghp_reserved_test_value_0123456789');
    log = [];
    asked = [];
    declaredByRequest = [];
    socketPath = tmpSocketPath();
    loopbackPort = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    cleanupSocket(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const kind of ['declared everywhere', 'a scope that allows everything'] as const) {
    for (const service of SPELLINGS) {
      for (const attempt of ATTEMPTS) {
        it(`refused (${kind}, ${service}): ${attempt.name}`, async () => {
          // The anchor sits under the spelling being attacked, so a lookup that got through would find it.
          await store.set(service, 'audit_anchor', ANCHOR);
          await start(kind, service);
          const before = upstream.requests.length;

          const responses = await attempt.run(service);
          for (const res of responses) {
            attempt.expect(res);
            expect(res.body).not.toContain(ANCHOR_HASH);
          }

          // Nothing was stored, replaced, declared, asked of a person, or sent upstream for the reserved name.
          expect(await store.get(service, 'audit_anchor')).toBe(ANCHOR);
          expect(await store.exists(service, 'another_key')).toBe(false);
          expect(asked).toEqual([]);
          expect(declaredByRequest).toEqual([]);
          expect(upstream.requests.slice(before).filter((r) => r.path.includes('anything'))).toEqual([]);
          expect(JSON.stringify(log)).not.toContain(ANCHOR_HASH);
        });
      }
    }
  }

  it('the refusals that are audited name the reference and the reason, never the value', async () => {
    await store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, ANCHOR);
    await start('a scope that allows everything', RESERVED_SERVICE);
    await post('/broker/resolve', { service: RESERVED_SERVICE, key: AUDIT_ANCHOR_KEY });
    await post('/broker/route', { service: RESERVED_SERVICE, key: AUDIT_ANCHOR_KEY });
    expect(log.map((l) => [l.path, l.statusCode, l.error])).toEqual([
      ['/broker/resolve', 404, 'broker_ref_reserved: aquaman_internal/audit_anchor'],
      ['/broker/route', 404, 'broker_ref_reserved: aquaman_internal/audit_anchor'],
    ]);
  });

  it('the same proxy still serves an ordinary declared reference, so the rows above are not passing because everything is refused', async () => {
    await start('a scope that allows everything', RESERVED_SERVICE);
    const res = await post('/broker/resolve', { service: 'github', key: 'token' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).value).toBe('ghp_reserved_test_value_0123456789');
    expect((await udsFetch(socketPath, '/github/user')).status).toBe(200);
  });
});

describe('the reserved service cannot be reached through the OpenShell driver', () => {
  const permissive: BrokerScope = {
    check: () => ({ allowed: true }),
    declared: () => [],
    declarationError: () => undefined,
  };

  for (const [kind, scope] of [
    ['declared in the static list', createBrokerScope({ projectsPath: '/nonexistent/projects.yaml', allowedRefs: SPELLINGS.map((s) => `aquaman://${s}/audit_anchor`) })],
    ['a scope that allows everything', permissive],
  ] as const) {
    for (const service of SPELLINGS) {
      it(`refused (${kind}, ${service}): reference mode store and resolve`, async () => {
        const store = new MemoryStore();
        await store.set(service, 'audit_anchor', ANCHOR);
        const events: Array<{ success: boolean; error?: string }> = [];
        const driver = createOpenShellDriverCore({ store, scope, version: 't', onAccess: (e) => { events.push(e); } });
        const ref = `aquaman://${service}/audit_anchor`;

        await expect(driver.store({ provider: 'p', credential_key: 'K', value: ref })).rejects.toMatchObject({
          code: 'failed_precondition',
          message: expect.stringContaining('is reserved for aquaman\'s own records'),
        });
        await expect(driver.resolve([{ request_id: 'r', handle: { handle: ref } }])).rejects.toMatchObject({ code: 'failed_precondition' });
        // Deleting a reference never touches the vault item.
        await driver.delete({ provider: 'p', handle: { handle: ref } });

        expect(await store.get(service, 'audit_anchor')).toBe(ANCHOR);
        expect(events.filter((e) => !e.success)).toHaveLength(2);
        expect(JSON.stringify(events)).not.toContain(ANCHOR_HASH);
        expect(driver.list().map((l) => l.handle)).not.toContain(ref);
      });
    }
  }
});

describe('the reserved service cannot be linked to another vault item', () => {
  const spellings = ['aquaman_internal', 'aquaman-internal', 'aquaman.internal', 'aquamaninternal', 'AQUAMAN_INTERNAL'];
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-rl-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it.each(spellings)('a link named %s/audit_anchor is not a link name', async (service) => {
    const { parseLinkName, writeCredentialLink } = await import('../../packages/proxy/src/core/credentials/links.js');
    expect(parseLinkName(`${service}/audit_anchor`)).toBeNull();
    expect(parseLinkName(`aquaman://${service}/audit_anchor`)).toBeNull();
    const configPath = path.join(dir, 'config.yaml');
    expect(() => writeCredentialLink(configPath, `${service}/audit_anchor`, 'keychain://other/item')).toThrow(/Invalid link name/);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('a link for it written into config.yaml by hand is ignored, so the anchor is still read from where aquaman wrote it', async () => {
    const { loadCredentialLinks } = await import('../../packages/proxy/src/core/credentials/links.js');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, [
      'credentials:',
      '  links:',
      '    aquaman_internal/audit_anchor: keychain://other/item',
      '    github/token: keychain://other/item',
      '',
    ].join('\n'));
    const { links } = loadCredentialLinks(configPath);
    expect([...links.keys()]).toEqual(['github/token']);
  });
});
