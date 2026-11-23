/**
 * Conformance: a rule set on one name of a vault item holds for every name
 * that item can be asked for under.
 *
 * Two backends join service and key into one item name. 1Password titles an
 * item `aquaman-<service>-<key>`, so `cloudflare-ai/api_key` and
 * `cloudflare/ai-api_key` are one item. systemd-creds names a credential
 * `<service>--<key>`, so `team--prod/token` and `team/prod--token` are one
 * file. A program running as the user can declare the second name in
 * projects.yaml without a dialog. The ask-first mark, the approval, the
 * cooldown after a no and the tier that is never handed out over the
 * loopback listener are therefore all compared on the item (the store's
 * `itemIdentity`), not on the name alone.
 *
 * The real OnePasswordStore over a stand-in for `op` (`spawnSync` replaced;
 * no `op` is run) and the real SystemdCredsStore over a stand-in for
 * `systemd-creds` (`execFile` replaced; nothing is run), a real proxy on a
 * temporary socket and a loopback port, the real broker scope, the real
 * OpenShell driver core. The person is a scripted prompter; no dialog is
 * opened.
 *
 * MITRE ATLAS AML.T0055; NIST SP 800-53 AC-3, AC-6; OWASP Agentic ASI09.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
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

import {
  createCredentialProxy,
  createBrokerScope,
  createServiceRegistry,
  promptMessage,
  type BrokerScope,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptRequest,
  type PromptResult,
} from 'aquaman-proxy';
import type { CredentialStore } from 'aquaman-core';
import { createOpenShellDriverCore, DriverError } from '../../packages/proxy/src/openshell/credential-driver.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const SECRET = 'item-names-value-0123456789abcdef';
const COPY_SECRET = 'item-names-copy-0123456789abcdef';
const TOKEN = 'aqm_lb_item_names_test_token_0123456789';

interface Backend {
  name: string;
  /** The name the person marked, and the other name of the same item. */
  marked: { service: string; key: string };
  other: { service: string; key: string };
  /** A store holding the value under the marked name and the ask-first record naming it. */
  open(dir: string, extra?: Record<string, string>): Promise<CredentialStore>;
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
    marked: { service: 'cloudflare-ai', key: 'api_key' },
    other: { service: 'cloudflare', key: 'ai-api_key' },
    async open(_dir, extra = {}) {
      fakeOp({
        'aquaman-cloudflare-ai-api_key': SECRET,
        'aquaman-aquaman_internal-ask_first': JSON.stringify({ v: 1, refs: ['cloudflare-ai/api_key', ...Object.keys(extra)] }),
        ...Object.fromEntries(Object.entries(extra).map(([name, value]) => [`aquaman-${name.replace('/', '-')}`, value])),
      });
      const { OnePasswordStore } = await import('aquaman-core');
      return new OnePasswordStore();
    },
  },
  {
    name: 'systemd-creds (<service>--<key>)',
    marked: { service: 'team--prod', key: 'token' },
    other: { service: 'team', key: 'prod--token' },
    async open(dir, extra = {}) {
      fakeSystemdCreds();
      const { SystemdCredsStore } = await import('aquaman-core');
      const store = new SystemdCredsStore({ credsDir: path.join(dir, 'creds.d') });
      await store.set('team--prod', 'token', SECRET);
      for (const [name, value] of Object.entries(extra)) await store.set(name.split('/')[0], name.split('/')[1], value);
      await store.set('aquaman_internal', 'ask_first', JSON.stringify({ v: 1, refs: ['team--prod/token', ...Object.keys(extra)] }));
      return store;
    },
  },
];

for (const backend of BACKENDS) {
  const markedName = `${backend.marked.service}/${backend.marked.key}`;
  const otherName = `${backend.other.service}/${backend.other.key}`;

  describe(`ask first, by item: ${backend.name}`, () => {
    let dir: string;
    let configPath: string;
    let projectsPath: string;
    let servicesPath: string;
    let scope: BrokerScope;
    let store: CredentialStore;
    let proxy: CredentialProxy;
    let socketPath = '';
    let port = 0;
    let shown: Array<{ text: string; request: PromptRequest }>;
    let answers: PromptResult[];

    const prompter: CredentialPrompter = {
      async askValue() { return { outcome: 'declined' }; },
      async askApproval(request) {
        shown.push({ text: promptMessage(request, 'approval'), request });
        return answers.shift() ?? { outcome: 'declined' };
      },
      async askLoginItem() { return { outcome: 'declined' }; },
    };

    async function start(opts: { extra?: Record<string, string>; allowedServices?: string[]; isolated?: string[] } = {}): Promise<void> {
      store = await backend.open(dir, opts.extra);
      socketPath = tmpSocketPath();
      port = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
      });
      scope = createBrokerScope({
        configPath,
        projectsPath,
        loopbackDeniedServices: opts.isolated,
        itemIdentity: (service, key) => store.itemIdentity?.(service, key),
      });
      proxy = createCredentialProxy({
        socketPath,
        store,
        allowedServices: opts.allowedServices ?? [],
        serviceRegistry: createServiceRegistry({ configPath: servicesPath }),
        broker: scope,
        credentialRequests: { prompter, declare: () => {} },
        loopback: { port, token: TOKEN },
      });
      await proxy.start();
    }

    /** What a program running as the user can do without a dialog: declare the other name in a project. */
    const declareOtherName = () =>
      fs.writeFileSync(projectsPath, `projects:\n  app:\n    paths: ["${dir}"]\n    env:\n      X: "aquaman://${otherName}"\n`);

    beforeEach(() => {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-item-names-')));
      configPath = path.join(dir, 'config.yaml');
      projectsPath = path.join(dir, 'projects.yaml');
      servicesPath = path.join(dir, 'services.yaml');
      fs.writeFileSync(configPath, `broker:\n  allowedRefs: ["aquaman://${markedName}"]\n`);
      shown = [];
      answers = [];
    });

    afterEach(async () => {
      if (proxy?.isRunning()) await proxy.stop();
      if (socketPath) cleanupSocket(socketPath);
      fs.rmSync(dir, { recursive: true, force: true });
      vi.resetAllMocks();
    });

    const post = (urlPath: string, body: unknown) =>
      udsFetch(socketPath, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const resolve = (ref: { service: string; key: string }, extra: Record<string, unknown> = {}) => post('/broker/resolve', { ...ref, ...extra });
    const loopback = async (body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}/broker/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.text() };
    };

    it('the two names are one item, and the value is there under both', async () => {
      await start();
      expect(store.itemIdentity!(backend.marked.service, backend.marked.key)).toBe(store.itemIdentity!(backend.other.service, backend.other.key));
      expect(await store.get(backend.other.service, backend.other.key)).toBe(SECRET);
    });

    it('asked for under its other name, the marked item is not handed out: the person is asked, and the dialog says which mark it is about', async () => {
      await start();
      declareOtherName();
      const res = await resolve(backend.other);
      expect(res.body).not.toContain(SECRET);
      expect(JSON.parse(res.body).code).toBe('ask_first_declined');
      expect(shown).toHaveLength(1);
      expect(shown[0].text).toContain(`Credential: ${otherName}`);
      expect(shown[0].text.split('\n').at(-1)).toBe(`This is the same vault item as the marked credential: ${markedName}`);
    });

    it('without a dialog (ask: false, and the loopback listener) the other name is answered ask_first_required', async () => {
      await start();
      declareOtherName();
      const quiet = await resolve(backend.other, { ask: false });
      const overLoopback = await loopback(backend.other);
      for (const res of [quiet, overLoopback]) {
        expect(res.body).not.toContain(SECRET);
        expect(JSON.parse(res.body).code).toBe('ask_first_required');
      }
      expect(shown).toEqual([]);
    });

    it('a no about one name is a no for the other: one dialog, and /broker/available says so', async () => {
      await start();
      declareOtherName();
      const first = await resolve(backend.marked);
      const second = await resolve(backend.other);
      expect(first.body + second.body).not.toContain(SECRET);
      expect(JSON.parse(second.body).code).toBe('ask_first_declined');
      expect(shown).toHaveLength(1);
      const available = JSON.parse((await post('/broker/available', { refs: [backend.marked, backend.other] })).body).available;
      expect(available).toEqual([false, false]);
    });

    it('a yes about one name covers the other: the person allowed the item, and is not asked twice', async () => {
      await start();
      declareOtherName();
      answers = [{ outcome: 'approved' }];
      expect(JSON.parse((await resolve(backend.other)).body).value).toBe(SECRET);
      expect(JSON.parse((await resolve(backend.marked)).body).value).toBe(SECRET);
      expect(shown).toHaveLength(1);
    });

    it('over the loopback listener, an item of the isolated tier is not handed out under its other name', async () => {
      // The tier is a list of services. The other name of one of its items
      // belongs, by name, to a service that is not on the list.
      await start({ isolated: [backend.marked.service] });
      declareOtherName();
      answers = [{ outcome: 'approved' }, { outcome: 'approved' }];
      const byName = await loopback(backend.marked);
      const byOtherName = await loopback(backend.other);
      expect(JSON.parse(byName.body).code).toBe('broker_ref_isolated');
      expect(JSON.parse(byOtherName.body).code).toBe('broker_ref_isolated');
      expect(byName.body + byOtherName.body).not.toContain(SECRET);
      // A reference of that other service that is a different item is not caught up in it.
      fs.writeFileSync(configPath, `broker:\n  allowedRefs: ["aquaman://${backend.other.service}/unrelated"]\n`);
      expect(JSON.parse((await loopback({ service: backend.other.service, key: 'unrelated' })).body).code).toBe('credential_not_found');
    });

    it('forwarding for a service that services.yaml defines under the other name does not send the marked item upstream', async () => {
      const got: string[] = [];
      const upstream = http.createServer((req, res) => { got.push(String(req.headers['x-key'])); res.end('ok'); });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
      const upstreamPort = (upstream.address() as net.AddressInfo).port;
      fs.writeFileSync(servicesPath, `services:\n  - name: ${backend.other.service}\n    upstream: http://127.0.0.1:${upstreamPort}\n    authHeader: x-key\n    credentialKey: ${backend.other.key}\n`);
      await start({ allowedServices: [backend.other.service] });
      try {
        const res = await udsFetch(socketPath, `/${backend.other.service}/anything`);
        expect(res.status).toBe(403);
        expect(JSON.parse(res.body).code).toBe('ask_first_declined');
        expect(got).toEqual([]);
        expect(shown).toHaveLength(1);
      } finally {
        await new Promise((r) => upstream.close(r));
      }
    });
  });
}

describe('ask first, by item: an OpenShell copy whose name is another name for a marked item (1Password)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-item-names-')));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  it('a copy handle is the gateway\'s own value and is not looked up in the scope; it still goes through the gate, and the marked item is not resolved', async () => {
    // `openshell-ci/deploy.key`, marked, is the item `aquaman-openshell-ci-deploy.key`,
    // and so is the copy `aquaman://openshell/ci-deploy.key`.
    fakeOp({
      'aquaman-openshell-ci-deploy.key': COPY_SECRET,
      'aquaman-aquaman_internal-ask_first': '{"v":1,"refs":["openshell-ci/deploy.key"]}',
    });
    const { OnePasswordStore } = await import('aquaman-core');
    const store = new OnePasswordStore();
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, 'broker:\n  allowedRefs: ["aquaman://openshell-ci/deploy.key"]\n');
    const shown: string[] = [];
    const prompter: CredentialPrompter = {
      async askValue() { return { outcome: 'declined' }; },
      async askApproval(request) { shown.push(promptMessage(request, 'approval')); return { outcome: 'declined' }; },
      async askLoginItem() { return { outcome: 'declined' }; },
    };
    const scope = createBrokerScope({ configPath, projectsPath: path.join(dir, 'projects.yaml') });
    const socketPath = tmpSocketPath();
    const proxy = createCredentialProxy({ socketPath, store, allowedServices: [], broker: scope, credentialRequests: { prompter, declare: () => {} } });
    await proxy.start();
    try {
      const driver = createOpenShellDriverCore({ store, scope, askFirst: proxy.askFirstGate, version: 'test' });
      let out: string;
      try {
        out = JSON.stringify(await driver.resolve([{ request_id: 'r1', provider: 'ci', credential_key: 'KEY', handle: { driver: 'aquaman', handle: 'aquaman://openshell/ci-deploy.key', metadata: { mode: 'copy' } } }]));
      } catch (err) {
        expect(err).toBeInstanceOf(DriverError);
        out = (err as Error).message;
      }
      expect(out).not.toContain(COPY_SECRET);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toContain('This is the same vault item as the marked credential: openshell-ci/deploy.key');
    } finally {
      await proxy.stop();
      cleanupSocket(socketPath);
    }
  });
});
