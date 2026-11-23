/**
 * Conformance: the tier that is never handed out over the loopback listener
 * holds for every name one of its vault items can be asked for under.
 *
 * Two backends join service and key into one item name. 1Password titles an
 * item `aquaman-<service>-<key>`, so `cloudflare-ai/api_key` and
 * `cloudflare/ai-api_key` are one item. systemd-creds names a credential
 * `<service>--<key>`, so `team--prod/token` and `team/prod--token` are one
 * file. The tier is a list of services, and a program running as the user
 * can declare the second name in projects.yaml without a dialog: by name it
 * belongs to a service that is not on the list. The scope therefore compares
 * the item (the store's `itemIdentity`), not the name alone.
 *
 * `itemIdentity` is the backend's own item name. A line in
 * `credentials.links` plays no part in it: config.yaml can be written by any
 * program, and such a line must not hide the item a name is kept in.
 *
 * The real OnePasswordStore over a stand-in for `op` (`spawnSync` replaced;
 * no `op` is run) and the real SystemdCredsStore over a stand-in for
 * `systemd-creds` (`execFile` replaced; nothing is run), a real proxy on a
 * temporary socket and a loopback port, the real broker scope.
 *
 * MITRE ATLAS AML.T0055; NIST SP 800-53 AC-3, AC-6.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync, execFile, execFileSync } from 'node:child_process';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

import { createCredentialProxy, createBrokerScope, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore, type CredentialStore } from 'aquaman-core';
import { LinkedStore } from '../../packages/proxy/src/core/credentials/linked-store.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const SECRET = 'item-names-value-0123456789abcdef';
const TOKEN = 'aqm_lb_item_names_test_token_0123456789';

interface Backend {
  name: string;
  /** A name of a service in the tier, and the other name of the same item. */
  isolated: { service: string; key: string };
  other: { service: string; key: string };
  /** A store holding the value under the isolated name. */
  open(dir: string): Promise<CredentialStore>;
}

/** `op` as far as these rows need it: `item get` of what is in `items`. */
function fakeOp(items: Record<string, string>): void {
  vi.mocked(spawnSync).mockImplementation(((cmd: string, args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '', pid: 1, signal: null, output: [] });
    if (cmd === 'which') return ok('/usr/local/bin/op\n');
    if (args[0] === 'account') return ok('{}');
    if (args[0] === 'item' && args[1] === 'get') {
      return args[2] in items
        ? ok(JSON.stringify({ value: items[args[2]] }))
        : { status: 1, stdout: '', stderr: `"${args[2]}" isn't an item in the "aquaman" vault`, pid: 1, signal: null, output: [] };
    }
    return { status: 1, stdout: '', stderr: 'not implemented in the stand-in', pid: 1, signal: null, output: [] };
  }) as never);
}

/** `systemd-creds` as far as these rows need it: encrypt keeps what stdin delivered under the name, decrypt gives it back. */
function fakeSystemdCreds(): void {
  const byName = new Map<string, string>();
  vi.mocked(execFileSync).mockReturnValue('systemd 258 (258.1)\n' as never);
  vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], opts: unknown, cb: unknown) => {
    const done = (typeof opts === 'function' ? opts : cb) as (err: Error | null, stdout: string, stderr: string) => void;
    const name = (args.find((a) => a.startsWith('--name=')) ?? '').slice('--name='.length);
    if (args[1] === 'encrypt') {
      let input = '';
      return { stdin: { write: (chunk: string) => { input += chunk; }, end: () => { byName.set(name, input); done(null, `ENC:${name}`, ''); } } };
    }
    if (args[1] === 'decrypt') {
      if (byName.has(name)) done(null, byName.get(name)!, '');
      else done(new Error('missing'), '', 'missing');
      return {};
    }
    done(new Error('not implemented in the stand-in'), '', '');
    return {};
  }) as never);
}

const BACKENDS: Backend[] = [
  {
    name: '1Password (aquaman-<service>-<key>)',
    isolated: { service: 'cloudflare-ai', key: 'api_key' },
    other: { service: 'cloudflare', key: 'ai-api_key' },
    async open() {
      fakeOp({ 'aquaman-cloudflare-ai-api_key': SECRET });
      const { OnePasswordStore } = await import('aquaman-core');
      return new OnePasswordStore();
    },
  },
  {
    name: 'systemd-creds (<service>--<key>)',
    isolated: { service: 'team--prod', key: 'token' },
    other: { service: 'team', key: 'prod--token' },
    async open(dir) {
      fakeSystemdCreds();
      const { SystemdCredsStore } = await import('aquaman-core');
      const store = new SystemdCredsStore({ credsDir: path.join(dir, 'creds.d') });
      await store.set('team--prod', 'token', SECRET);
      return store;
    },
  },
];

for (const backend of BACKENDS) {
  const isolatedName = `${backend.isolated.service}/${backend.isolated.key}`;
  const otherName = `${backend.other.service}/${backend.other.key}`;

  describe(`the tier kept off the loopback listener, by item: ${backend.name}`, () => {
    let dir: string;
    let configPath: string;
    let projectsPath: string;
    let store: CredentialStore;
    let proxy: CredentialProxy;
    let socketPath = '';
    let port = 0;

    beforeEach(async () => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-item-names-')));
      configPath = path.join(dir, 'config.yaml');
      projectsPath = path.join(dir, 'projects.yaml');
      fs.writeFileSync(configPath, `broker:\n  allowedRefs: ["aquaman://${isolatedName}"]\n`);
      // What a program running as the user can do without a dialog: declare the other name in a project.
      fs.writeFileSync(projectsPath, `projects:\n  app:\n    paths: ["${dir}"]\n    env:\n      X: "aquaman://${otherName}"\n`);

      store = await backend.open(dir);
      socketPath = tmpSocketPath();
      port = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
      });
      proxy = createCredentialProxy({
        socketPath,
        store,
        allowedServices: [],
        broker: createBrokerScope({
          configPath,
          projectsPath,
          loopbackDeniedServices: [backend.isolated.service],
          itemIdentity: (service, key) => store.itemIdentity?.(service, key),
        }),
        loopback: { port, token: TOKEN },
      });
      await proxy.start();
    });

    afterEach(async () => {
      if (proxy?.isRunning()) await proxy.stop();
      if (socketPath) cleanupSocket(socketPath);
      fs.rmSync(dir, { recursive: true, force: true });
      vi.resetAllMocks();
    });

    const loopback = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/broker/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.text() };
    };

    it('the two names are one item, and the value is there under both', async () => {
      expect(store.itemIdentity!(backend.isolated.service, backend.isolated.key)).toBe(store.itemIdentity!(backend.other.service, backend.other.key));
      expect(await store.get(backend.other.service, backend.other.key)).toBe(SECRET);
    });

    it('over the loopback listener, an item of the isolated tier is not handed out under either name', async () => {
      const byName = await loopback(backend.isolated);
      const byOtherName = await loopback(backend.other);
      expect(byName.status).toBe(404);
      expect(byOtherName.status).toBe(404);
      expect(JSON.parse(byName.body).code).toBe('broker_ref_isolated');
      expect(JSON.parse(byOtherName.body).code).toBe('broker_ref_isolated');
      expect(byName.body + byOtherName.body).not.toContain(SECRET);
    });

    it('a reference of the other service that is a different item is not caught up in it', async () => {
      fs.writeFileSync(configPath, `broker:\n  allowedRefs: ["aquaman://${backend.other.service}/unrelated"]\n`);
      expect(JSON.parse((await loopback({ service: backend.other.service, key: 'unrelated' })).body).code).toBe('credential_not_found');
    });

    it('the tier is about the loopback listener: on the Unix socket the declared name is served as before', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(backend.other) });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).value).toBe(SECRET);
    });
  });
}

describe('the tier kept off the loopback listener, and a link line on a name of an isolated service', () => {
  // A backend that titles an item aquaman-<service>-<key>, as onepassword.ts does.
  class Joined extends MemoryStore {
    itemIdentity(service: string, key: string): string { return `aquaman-${service}-${key}`; }
  }
  const scopeFor = (links: ReadonlyMap<string, string>) => {
    const store = new LinkedStore(new Joined(), '1password', () => links);
    return createBrokerScope({
      configPath: '/nonexistent/config.yaml',
      projectsPath: '/nonexistent/projects.yaml',
      allowedRefs: ['aquaman://openai-org/id', 'aquaman://github/token'],
      loopbackDeniedServices: ['openai'],
      itemIdentity: (service, key) => store.itemIdentity?.(service, key),
    });
  };

  it('openai-org/id is the item of openai/org-id and is not handed out over loopback', () => {
    expect(scopeFor(new Map()).check('openai-org', 'id', 'loopback')).toMatchObject({ allowed: false, code: 'broker_ref_isolated' });
    expect(scopeFor(new Map()).check('github', 'token', 'loopback')).toEqual({ allowed: true });
  });

  const lines: Array<[string, Array<[string, string]>]> = [
    ['on the name the check probes with', [['openai/k', 'op://vault/item/field']]],
    ['on the name that is asked for', [['openai-org/id', 'op://vault/item/field']]],
    ['on both', [['openai/k', 'op://vault/a/field'], ['openai-org/id', 'op://vault/a/field']]],
  ];
  for (const [name, entries] of lines) {
    it(`a link line ${name} does not switch that off`, () => {
      expect(scopeFor(new Map(entries)).check('openai-org', 'id', 'loopback')).toMatchObject({ allowed: false, code: 'broker_ref_isolated' });
    });
  }
});
