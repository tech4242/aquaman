/**
 * Conformance: an agent cannot make aquaman read a vault item the person did
 * not approve.
 *
 * A link points an aquaman reference at an item aquaman did not write. The
 * way an agent asks for one is `POST /broker/request` with `from`. This file
 * attacks that path, one row per attack: no dialog means no link; a decline
 * means no link and no read; nothing in the vault is touched before the
 * person agrees; the loopback listener does not take the request; a link
 * does not widen the broker scope; nothing is written or deleted through a
 * link; a link never replaces a stored value; and hostile locator text stays
 * one bounded line below aquaman's own wording.
 *
 * The person is a scripted prompter and the vault is an in-memory backend
 * that records every touch. config.yaml and projects.yaml are real files in
 * a temp directory, read by the real broker scope and link map.
 *
 * Limit, as an `it.fails` row: software running as the same user can write
 * `credentials.links` into config.yaml itself. The dialog is where a person
 * decides about a request; it is not a boundary inside one user account.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), AC-6 (least privilege), AU-2 (audit events); OWASP Agentic
 * ASI09 (human-agent trust exploitation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  createCredentialProxy,
  createBrokerScope,
  promptMessage,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptRequest,
  type PromptResult,
  type RequestInfo,
} from 'aquaman-proxy';
import {
  LinkedStore,
  createCredentialLinker,
  createLinkSource,
  loadCredentialLinks,
  writeCredentialLink,
  parseLocatorFor,
  type CredentialStore,
  type ParsedLocator,
} from 'aquaman-core';
import { CountingStore } from '../helpers/counting-store.js';
import { LinkableStore } from '../helpers/linkable-store.js';
import { udsFetch } from '../helpers/uds-proxy.js';

const ITEM = 'bw://GitHub/password';
const ITEM_VALUE = 'ghp_value_of_the_users_own_item_0123456789';
const OTHER_ITEM = 'bw://Production database/password';
const OTHER_VALUE = 'pg_value_the_agent_was_never_given_access_to';
const LOOPBACK_TOKEN = 'aqm_lb_vault_links_test_0123456789';

/** Counts every operation on the backend, linked reads included. */
class CountingVault extends CountingStore {
  linked = 0;
  constructor(private vault: LinkableStore) { super(vault); }
  async readLinked(locator: ParsedLocator): Promise<string | null> {
    this.linked++;
    return this.vault.readLinked(locator);
  }
  touches(): number {
    return this.gets + this.sets + this.deletes + this.lists + this.existsCalls + this.linked;
  }
}

describe('links to existing vault items', () => {
  let dir: string;
  let configPath: string;
  let projectsPath: string;
  let socketPath: string;
  let proxy: CredentialProxy;
  let vault: LinkableStore;
  let counting: CountingVault;
  let store: CredentialStore;
  /** What the person was shown, in order, with the vault touches made up to that moment. */
  let shown: Array<{ kind: 'value' | 'approval'; request: PromptRequest; touchesBefore: number; text: string }>;
  let log: RequestInfo[];
  let loopbackPort = 0;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-vl-')));
    configPath = path.join(dir, 'config.yaml');
    projectsPath = path.join(dir, 'projects.yaml');
    socketPath = path.join(dir, 'p.sock');
  });
  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** `broker.allowedRefs`, written the way `aquaman broker allow` writes it. */
  function declare(service: string, key: string): void {
    const raw = fs.existsSync(configPath) ? (parseYaml(fs.readFileSync(configPath, 'utf-8')) ?? {}) : {};
    const refs = new Set<string>(raw.broker?.allowedRefs ?? []);
    refs.add(`aquaman://${service}/${key}`);
    raw.broker = { ...raw.broker, allowedRefs: [...refs] };
    fs.writeFileSync(configPath, stringifyYaml(raw), { mode: 0o600 });
  }
  const links = () => Object.fromEntries(loadCredentialLinks(configPath).links);
  const declaredRefs = (): string[] => (fs.existsSync(configPath) ? parseYaml(fs.readFileSync(configPath, 'utf-8'))?.broker?.allowedRefs ?? [] : []);

  async function start(opts: {
    answer?: PromptResult | (() => Promise<PromptResult>);
    withScope?: boolean;
    withRequests?: boolean;
    withLinks?: boolean;
    loopback?: boolean;
    backend?: 'bitwarden' | 'encrypted-file';
  } = {}) {
    vault = new LinkableStore({ [ITEM]: ITEM_VALUE, [OTHER_ITEM]: OTHER_VALUE });
    counting = new CountingVault(vault);
    const backend = opts.backend ?? 'bitwarden';
    store = new LinkedStore(counting, backend, createLinkSource(configPath));
    shown = [];
    log = [];
    const ask = (kind: 'value' | 'approval') => async (request: PromptRequest): Promise<PromptResult> => {
      shown.push({ kind, request, touchesBefore: counting.touches(), text: promptMessage(request, kind) });
      const a = opts.answer ?? (kind === 'value' ? { outcome: 'entered', value: 'typed-by-the-person' } : { outcome: 'approved' });
      return typeof a === 'function' ? a() : a;
    };
    const prompter: CredentialPrompter = { askValue: ask('value'), askApproval: ask('approval') };
    if (opts.loopback) {
      loopbackPort = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
      });
    }
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['github'],
      broker: opts.withScope === false ? undefined : createBrokerScope({ configPath, projectsPath, loopbackDeniedServices: ['anthropic'] }),
      credentialRequests: opts.withRequests === false
        ? undefined
        : {
            prompter,
            declare,
            links: opts.withLinks === false ? undefined : createCredentialLinker({ store, backend, configPath }),
          },
      loopback: opts.loopback ? { port: loopbackPort, token: LOOPBACK_TOKEN } : undefined,
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const post = (urlPath: string, body: unknown) =>
    udsFetch(socketPath, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const request = (body: Record<string, unknown>) => post('/broker/request', { service: 'github', key: 'token', ...body });
  const resolve = (service = 'github', key = 'token') => post('/broker/resolve', { service, key });

  /** Nothing was linked, nothing declared, and the vault was not touched in any way. */
  function expectNothingHappened(): void {
    expect(links()).toEqual({});
    expect(declaredRefs()).toEqual([]);
    expect(counting.touches()).toBe(0);
    expect(vault.linkedReads).toEqual([]);
  }

  describe('an approved request', () => {
    it('reads the item once, only after the person agreed, writes the link, declares the reference and returns no value', async () => {
      await start();
      const res = await request({ from: ITEM, project: '/code/app' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'linked', ref: 'aquaman://github/token' });

      expect(shown).toHaveLength(1);
      expect(shown[0].kind).toBe('approval');
      expect(shown[0].request).toMatchObject({ service: 'github', key: 'token', from: ITEM, project: '/code/app' });
      // Up to the moment the dialog opened, the vault had not been touched.
      expect(shown[0].touchesBefore).toBe(0);
      expect(vault.linkedReads).toEqual([ITEM]);

      expect(links()).toEqual({ 'github/token': ITEM });
      expect(declaredRefs()).toEqual(['aquaman://github/token']);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);

      for (const text of [res.body, JSON.stringify(res.headers), JSON.stringify(log), fs.readFileSync(configPath, 'utf-8')]) {
        expect(text).not.toContain(ITEM_VALUE);
      }
      expect(log.filter((l) => l.method === 'BROKER_REQUEST')).toMatchObject([{ service: 'github', path: '/broker/request', statusCode: 200 }]);
      expect(log.find((l) => l.method === 'BROKER_REQUEST')?.error).toBeUndefined();

      // From here on the reference resolves to the item's value, like any declared credential.
      expect(JSON.parse((await resolve()).body).value).toBe(ITEM_VALUE);
    });

    it('a routed request links without declaring: the value is still not handed out', async () => {
      await start();
      const res = await request({ from: ITEM, routed: true });
      expect(JSON.parse(res.body)).toEqual({ status: 'linked', ref: 'aquaman://github/token' });
      expect(links()).toEqual({ 'github/token': ITEM });
      expect(declaredRefs()).toEqual([]);
      const refused = await resolve();
      expect(refused.status).toBe(404);
      expect(JSON.parse(refused.body).code).toBe('broker_ref_not_declared');
      expect(refused.body).not.toContain(ITEM_VALUE);
    });

    it('asking again for the same link asks nobody; a request without `from` for a linked reference is ready', async () => {
      await start();
      await request({ from: ITEM });
      expect(JSON.parse((await request({ from: ITEM })).body)).toEqual({ status: 'ready', ref: 'aquaman://github/token' });
      expect(JSON.parse((await request({})).body)).toEqual({ status: 'ready', ref: 'aquaman://github/token' });
      expect(shown).toHaveLength(1);
    });
  });

  describe('no dialog shown means no link', () => {
    const cases: Array<[string, Parameters<typeof start>[0], Record<string, unknown>, { status: number; match: Record<string, unknown>; dialogs: number }]> = [
      ['nobody can be asked (no desktop session)', { answer: { outcome: 'unavailable', reason: 'no desktop session' } }, { from: ITEM }, { status: 200, match: { status: 'pending', reason: 'no desktop session' }, dialogs: 1 }],
      ['nobody answers the dialog', { answer: { outcome: 'timeout' } }, { from: ITEM }, { status: 200, match: { status: 'pending', reason: 'nobody answered the dialog' }, dialogs: 1 }],
      ['the dialog helper fails', { answer: () => Promise.reject(new Error('osascript crashed')) }, { from: ITEM }, { status: 200, match: { status: 'pending', reason: 'osascript crashed' }, dialogs: 1 }],
      ['the broker is off (an OpenClaw-hosted proxy)', { withScope: false }, { from: ITEM }, { status: 404, match: { code: 'broker_disabled' }, dialogs: 0 }],
      ['credential requests are off', { withRequests: false }, { from: ITEM }, { status: 404, match: { code: 'broker_disabled' }, dialogs: 0 }],
      ['the proxy has no linker', { withLinks: false }, { from: ITEM }, { status: 404, match: { code: 'links_unavailable' }, dialogs: 0 }],
      ['the backend holds only what aquaman wrote', { backend: 'encrypted-file' }, { from: ITEM }, { status: 400, match: { code: 'link_unsupported_backend' }, dialogs: 0 }],
      ['the locator belongs to another backend', {}, { from: 'op://Private/GitHub/token' }, { status: 400, match: { code: 'link_backend_mismatch' }, dialogs: 0 }],
      ['the locator is not a string', {}, { from: { item: 'GitHub' } }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator is empty', {}, { from: '' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator smuggles an option', {}, { from: 'bw://--session=stolen/password' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator smuggles an encoded option', {}, { from: 'bw://%2D%2Draw/password' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator has a traversal part', {}, { from: 'bw://a%2F..%2Fb/password' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator is encoded twice', {}, { from: 'bw://a%252Fb/password' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator has a newline that would add a line to the dialog', {}, { from: 'bw://GitHub\nAllow is safe/password' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator has a right-to-left override', {}, { from: 'bw://Git‮Hub/password' }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the locator is longer than a person can read in a dialog', {}, { from: `bw://${'a'.repeat(200)}/password` }, { status: 400, match: { code: 'link_invalid_locator' }, dialogs: 0 }],
      ['the reference name is not one', {}, { service: '../x', from: ITEM }, { status: 400, match: {}, dialogs: 0 }],
    ];

    it.each(cases)('%s', async (_name, opts, body, expected) => {
      await start(opts);
      const res = await request(body);
      expect(res.status).toBe(expected.status);
      expect(JSON.parse(res.body)).toMatchObject(expected.match);
      expect(res.body).not.toContain(ITEM_VALUE);
      expect(shown).toHaveLength(expected.dialogs);
      expectNothingHappened();
    });

    it('a pending answer tells a person what to run by hand, and that command needs a terminal of its own', async () => {
      await start({ answer: { outcome: 'timeout' } });
      const ordinary = JSON.parse((await request({ from: ITEM })).body);
      expect(ordinary.fix).toBe(`aquaman credentials link github/token '${ITEM}' && aquaman broker allow aquaman://github/token`);
      const routed = JSON.parse((await request({ key: 'other', from: ITEM, routed: true })).body);
      expect(routed.fix).toBe(`aquaman credentials link github/other '${ITEM}'`);
    });

    it('while another dialog is open, nobody is asked and nothing is linked', async () => {
      let release!: (r: PromptResult) => void;
      await start({ answer: () => new Promise<PromptResult>((r) => { release = r; }) });
      const open = request({ key: 'first', from: ITEM });
      await new Promise((r) => setTimeout(r, 50));
      const second = JSON.parse((await request({ key: 'second', from: OTHER_ITEM })).body);
      expect(second).toMatchObject({ status: 'pending', reason: 'another credential request is waiting for an answer' });
      release({ outcome: 'timeout' });
      await open;
      expect(shown).toHaveLength(1);
      expectNothingHappened();
    });

    it('after six dialogs in ten minutes, nobody is asked and nothing is linked', async () => {
      await start({ answer: { outcome: 'timeout' } });
      const statuses: string[] = [];
      for (let i = 0; i < 9; i++) statuses.push(JSON.parse((await request({ key: `k${i}`, from: ITEM })).body).status);
      expect(statuses).toEqual(Array(9).fill('pending'));
      expect(shown).toHaveLength(6);
      expectNothingHappened();
    });
  });

  describe('a decline', () => {
    it('links nothing, reads nothing, hands back no command, and is audited', async () => {
      await start({ answer: { outcome: 'declined' } });
      const res = await request({ from: ITEM });
      const body = JSON.parse(res.body);
      expect(body).toEqual({ status: 'declined', ref: 'aquaman://github/token', reason: 'the person at the dialog said no' });
      expect(body.fix).toBeUndefined();
      expect(shown).toHaveLength(1);
      expectNothingHappened();
      expect(log.find((l) => l.method === 'BROKER_REQUEST')?.error).toBe('declined: github/token');
    });

    it('is not asked about again for ten minutes, whatever item is named next', async () => {
      await start({ answer: { outcome: 'declined' } });
      await request({ from: ITEM });
      for (const body of [{ from: ITEM }, { from: OTHER_ITEM }, { from: ITEM, routed: true }]) {
        const again = JSON.parse((await request(body)).body);
        expect(again.status).toBe('declined');
        expect(again.fix).toBeUndefined();
      }
      expect(shown).toHaveLength(1);
      expectNothingHappened();
    });
  });

  describe('nothing in the vault is read before the person agrees', () => {
    it.each([
      ['an item that exists', ITEM],
      ['an item that does not exist', 'bw://No such item/password'],
      ['an item the agent should not learn about', OTHER_ITEM],
    ])('%s: the answers before a dialog are identical, so a request cannot probe the vault', async (_name, locator) => {
      await start({ answer: { outcome: 'declined' } });
      const res = await request({ from: locator });
      expect(shown[0].touchesBefore).toBe(0);
      expect(JSON.parse(res.body)).toEqual({ status: 'declined', ref: 'aquaman://github/token', reason: 'the person at the dialog said no' });
      expect(counting.touches()).toBe(0);
    });

    it('an existing item and a missing one are indistinguishable when nobody answers', async () => {
      await start({ answer: { outcome: 'timeout' } });
      const there = JSON.parse((await request({ key: 'a', from: ITEM })).body);
      const missing = JSON.parse((await request({ key: 'a', from: 'bw://No such item/password' })).body);
      expect({ ...missing, fix: '' }).toEqual({ ...there, fix: '' });
      expect(counting.touches()).toBe(0);
    });

    it('once the person agreed, a missing item is reported, nothing is written, and the refusal is audited', async () => {
      await start();
      const res = await request({ from: 'bw://No such item/password' });
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ code: 'link_unreadable', error: 'Nothing could be read at bw://No such item/password' });
      expect(body.fix).toContain('Check the item and field names');
      expect(links()).toEqual({});
      expect(declaredRefs()).toEqual([]);
      expect(log.find((l) => l.method === 'BROKER_REQUEST')?.error).toBe('link_unreadable: github/token');
    });

    it('once the person agreed, a vault that fails is reported with its error and nothing is written', async () => {
      await start();
      vault.failWith = 'bw command failed: Vault is locked.';
      const res = await request({ from: ITEM });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'link_unreadable', error: expect.stringContaining('Vault is locked') });
      expect(links()).toEqual({});
      expect(declaredRefs()).toEqual([]);
    });
  });

  describe('the loopback listener', () => {
    const overLoopback = (urlPath: string, body: unknown, token = LOOPBACK_TOKEN) =>
      fetch(`http://127.0.0.1:${loopbackPort}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aquaman-token': token },
        body: JSON.stringify(body),
      });

    it.each([
      ['with the loopback token', LOOPBACK_TOKEN, 404, 'broker_request_local_only'],
      ['with no valid token', 'aqm_lb_wrong', 401, undefined],
    ])('refuses a link request %s, shows nothing and reads nothing', async (_name, token, status, code) => {
      await start({ loopback: true });
      const res = await overLoopback('/broker/request', { service: 'github', key: 'token', from: ITEM }, token);
      expect(res.status).toBe(status);
      const body = await res.json() as { code?: string };
      if (code) expect(body.code).toBe(code);
      expect(shown).toEqual([]);
      expectNothingHappened();
    });

    it('a link does not open an isolated service: a linked and declared anthropic key is still refused over loopback', async () => {
      await start({ loopback: true });
      writeCredentialLink(configPath, 'anthropic/api_key', ITEM);
      declare('anthropic', 'api_key');
      const res = await overLoopback('/broker/resolve', { service: 'anthropic', key: 'api_key' });
      expect(res.status).toBe(404);
      expect((await res.json() as { code: string }).code).toBe('broker_ref_isolated');
      expect(counting.touches()).toBe(0);
    });
  });

  describe('a link does not widen the broker scope', () => {
    it('a linked reference that is not declared is refused before the vault is looked at', async () => {
      await start();
      writeCredentialLink(configPath, 'github/token', ITEM);
      const res = await resolve();
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('broker_ref_not_declared');
      expect(res.body).not.toContain(ITEM_VALUE);

      const available = await post('/broker/available', { refs: [{ service: 'github', key: 'token' }] });
      expect(JSON.parse(available.body)).toEqual({ available: [false] });
      expect(counting.touches()).toBe(0);
    });

    it('declaring one linked reference opens that one and no other linked item', async () => {
      await start();
      writeCredentialLink(configPath, 'github/token', ITEM);
      writeCredentialLink(configPath, 'postgres/password', OTHER_ITEM);
      declare('github', 'token');
      expect(JSON.parse((await resolve()).body).value).toBe(ITEM_VALUE);
      const other = await resolve('postgres', 'password');
      expect(other.status).toBe(404);
      expect(other.body).not.toContain(OTHER_VALUE);
      expect(vault.linkedReads).toEqual([ITEM]);
    });

    it('a linked reference that is not declared goes through the ordinary approval before it is handed out', async () => {
      await start({ answer: { outcome: 'declined' } });
      writeCredentialLink(configPath, 'github/token', ITEM);
      const res = JSON.parse((await request({})).body);
      expect(res.status).toBe('declined');
      expect(shown.map((s) => s.kind)).toEqual(['approval']);
      expect(shown[0].request.from).toBeUndefined();
      expect(declaredRefs()).toEqual([]);
      expect((await resolve()).status).toBe(404);
    });

    it('the proxy forwards for the configured services only: a link adds none', async () => {
      await start();
      writeCredentialLink(configPath, 'stripe/secret_key', ITEM);
      const res = await udsFetch(socketPath, '/stripe/v1/charges');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body).not.toContain(ITEM_VALUE);
      expect(counting.touches()).toBe(0);
    });
  });

  describe('nothing is written or deleted through a link', () => {
    beforeEach(async () => {
      await start();
      await request({ from: ITEM });
      counting.resetCounts();
      counting.linked = 0;
    });

    it.each([
      ['set', () => store.set('github', 'token', 'overwritten-by-aquaman'), /does not write to/],
      ['delete', () => store.delete('github', 'token'), /does not delete/],
    ])('%s is refused with the way to unlink, and the backend is not asked to change anything', async (_name, act, why) => {
      await expect(act()).rejects.toThrow(why);
      await expect(act()).rejects.toThrow(/aquaman credentials unlink github\/token/);
      expect(counting.sets + counting.deletes).toBe(0);
      expect(vault.items.get(ITEM)).toBe(ITEM_VALUE);
      expect(await vault.get('github', 'token')).toBeNull();
    });

    it('a value request for a linked reference whose item is gone is refused, not turned into a typed value', async () => {
      vault.items.delete(ITEM);
      const before = shown.length;
      const res = await request({});
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'link_unreadable', fix: expect.stringContaining('aquaman credentials unlink github/token') });
      expect(shown).toHaveLength(before);
      expect(counting.sets).toBe(0);
      expect(links()).toEqual({ 'github/token': ITEM });
    });

    it('unlinking removes the link only: the item is as it was and is no longer read', async () => {
      expect(writeCredentialLink(configPath, 'github/token', null)).toBe(true);
      expect(vault.items.get(ITEM)).toBe(ITEM_VALUE);
      const res = await resolve();
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('credential_not_found');
      expect(counting.linked).toBe(0);
      expect(counting.sets + counting.deletes).toBe(0);
    });
  });

  describe('a link never replaces a stored value, and the other way round', () => {
    it('a reference with a value stored by aquaman is not linked, even after the person agreed', async () => {
      await start();
      await vault.set('github', 'token', 'ghp_stored_by_aquaman');
      const res = await request({ from: ITEM });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'link_value_stored', fix: 'To use the vault item instead, first run: aquaman credentials delete github token' });
      expect(shown[0].touchesBefore).toBe(0);
      expect(links()).toEqual({});
      expect(declaredRefs()).toEqual([]);
      expect(vault.linkedReads).toEqual([]);
      expect(await vault.get('github', 'token')).toBe('ghp_stored_by_aquaman');
      expect(log.find((l) => l.method === 'BROKER_REQUEST')?.error).toBe('link_value_stored: github/token');
    });

    it('a reference linked to one item is not pointed at another by a request, and nobody is asked', async () => {
      await start();
      await request({ from: ITEM });
      const res = await request({ from: OTHER_ITEM });
      expect(res.status).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('link_exists');
      expect(res.body).not.toContain(ITEM);
      expect(shown).toHaveLength(1);
      expect(links()).toEqual({ 'github/token': ITEM });
      expect(vault.linkedReads).not.toContain(OTHER_ITEM);
      expect(JSON.parse((await resolve()).body).value).toBe(ITEM_VALUE);
    });

    it('a value the person types is never stored under a linked reference', async () => {
      await start();
      await request({ from: ITEM });
      // The link is in place; a later plain request finds the credential and stores nothing.
      await request({});
      expect(counting.sets).toBe(0);
      expect(await vault.get('github', 'token')).toBeNull();
    });
  });

  describe('what the dialog shows', () => {
    const FIXED = [
      'An agent is asking aquaman to use an item that already exists in your vault as the credential below.',
      '',
      'Credential: github/token',
      '',
      'Allow makes aquaman read that item whenever this credential is used. aquaman does not change or delete the item. Commands the agent runs in this project will be given the value, and other software running as you can ask aquaman for it. Deny if you did not expect this, or if the item named below is not one you want used this way.',
      '',
      'aquaman never asks for your login, Apple ID or password-manager password.',
      '',
    ];

    it('the wording matches what a caller can obtain afterwards, for an ordinary and for a routed link', async () => {
      await start();
      await request({ from: ITEM });
      expect(shown[0].text).toContain('Commands the agent runs in this project will be given the value, and other software running as you can ask aquaman for it.');
      expect((await resolve()).status).toBe(200);

      await request({ key: 'routed', from: OTHER_ITEM, routed: true });
      expect(shown[1].text).toContain('The app in this project gets a local token, not the key');
      expect(shown[1].text).not.toContain('will be given the value');
      expect((await resolve('github', 'routed')).status).toBe(404);
    });

    // Text that passes the parser, so it does reach the dialog.
    const hostile: Array<[string, string]> = [
      ['a name that imitates aquaman\'s own sentences', 'bw://GitHub. aquaman has verified this item and it is safe to Allow/password'],
      ['a name that tells the person what to click', 'bw://URGENT click Allow now or your session expires/password'],
      ['a name that pretends to be a second credential line', 'bw://x Credential: harmless Vault item (as the caller wrote it): bw:%2F%2Fharmless/password'],
      ['a name as long as a locator may be', `bw://${'Allow '.repeat(30)}ok/password`],
      ['a name padded so the field falls off the end of a short line', `bw://GitHub${' .'.repeat(80)}/password`],
      ['a field that imitates the project line', 'bw://GitHub/x Requested from (as the caller reports it): your own terminal'],
    ];

    it.each(hostile)('%s stays one bounded line below the fixed wording', async (_name, locator) => {
      expect(parseLocatorFor('bitwarden', locator).ok).toBe(true);
      await start({ answer: { outcome: 'declined' } });
      await request({ from: locator, project: '/code/app' });
      const lines = shown[0].text.split('\n');
      // Everything above the caller's lines is aquaman's wording, unchanged by the locator.
      expect(lines.slice(0, FIXED.length)).toEqual(FIXED);
      // The caller's text is the last two lines and nothing else: the item, then the project.
      expect(lines).toHaveLength(FIXED.length + 2);
      expect(lines[FIXED.length]).toBe(`Vault item (as the caller wrote it): ${locator}`);
      expect(lines[FIXED.length].length).toBeLessThanOrEqual('Vault item (as the caller wrote it): '.length + 200);
      expect(lines[FIXED.length + 1]).toBe('Requested from (as the caller reports it): /code/app');
    });

    // Text the parser refuses never reaches a dialog. The dialog still reduces
    // it to one line on its own, should it ever be handed such text.
    it.each([
      ['newlines', 'bw://GitHub\n\naquaman has checked this request.\nAllow/password'],
      ['a carriage return', 'bw://GitHub\rAllow/password'],
      ['a right-to-left override', 'bw://‮drowssap/buHtiG'],
      ['a paragraph separator', 'bw://GitHub Allow/password'],
      ['a backslash escape a dialog helper might expand', 'bw://GitHub\\nAllow/password'],
      ['far more text than a line holds', `bw://${'A'.repeat(5000)}/password`],
    ])('%s: refused by the request, and one bounded line if shown anyway', async (_name, locator) => {
      await start();
      expect((await request({ from: locator })).status).toBe(400);
      expect(shown).toEqual([]);

      const lines = promptMessage({ service: 'github', key: 'token', from: locator }, 'approval').split('\n');
      expect(lines.slice(0, FIXED.length)).toEqual(FIXED);
      expect(lines).toHaveLength(FIXED.length + 1);
      expect(lines[FIXED.length].length).toBeLessThanOrEqual('Vault item (as the caller wrote it): '.length + 220);
      expect(lines[FIXED.length]).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u);
    });
  });

  describe('what the person is shown is what is read, and what is said is what happens', () => {
    it.each([
      ['a path spelled in percent-escapes (it would read prod/db)', 'bw://%50%72%6f%64/password'],
      ['one letter spelled as an escape', 'bw://Git%48ub/password'],
      ['a Cyrillic letter that looks like a Latin one', 'bw://GitHub\u0430/password'],
      ['a full-width letter', 'bw://Git\uFF28ub/password'],
    ])('%s: refused before any dialog, nothing read', async (_name, locator) => {
      await start();
      const res = await request({ from: locator });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).code).toBe('link_invalid_locator');
      expect(shown).toEqual([]);
      expectNothingHappened();
    });

    it('a routed link request for a reference that is already declared is worded as declared: the value is handed out, and the dialog says so', async () => {
      await start();
      declare('github', 'token');
      const res = await request({ from: ITEM, routed: true });
      expect(JSON.parse(res.body).status).toBe('linked');
      expect(shown).toHaveLength(1);
      expect(shown[0].text).toContain('Commands the agent runs in this project will be given the value');
      expect(shown[0].text).not.toContain('gets a local token, not the key');
      // The wording and the outcome agree: the value does resolve.
      expect(JSON.parse((await resolve()).body).value).toBe(ITEM_VALUE);
    });

    it('a routed link request for an undeclared reference keeps the routed wording, and the value does not resolve', async () => {
      await start();
      await request({ from: ITEM, routed: true });
      expect(shown[0].text).toContain('gets a local token, not the key');
      expect((await resolve()).status).toBe(404);
    });
  });

  describe('a link change is reported to the serving process', () => {
    it('a link that appears, is re-pointed or goes away after the first reading is reported; the first reading is not', () => {
      const changes: Array<{ name: string; locator?: string }> = [];
      writeCredentialLink(configPath, 'github/token', ITEM);
      const source = createLinkSource(configPath, (c) => changes.push(c));
      expect([...source().keys()]).toEqual(['github/token']);
      expect(changes).toEqual([]);

      const touch = () => { const t = new Date(Date.now() + changes.length * 2000 + 2000); fs.utimesSync(configPath, t, t); };
      writeCredentialLink(configPath, 'stripe/secret_key', OTHER_ITEM); touch();
      source();
      expect(changes).toEqual([{ name: 'stripe/secret_key', locator: OTHER_ITEM }]);

      writeCredentialLink(configPath, 'stripe/secret_key', null);
      writeCredentialLink(configPath, 'github/token', null);
      writeCredentialLink(configPath, 'github/token', OTHER_ITEM); touch();
      source();
      expect(changes.slice(1)).toEqual([{ name: 'github/token', locator: OTHER_ITEM }, { name: 'stripe/secret_key' }]);
    });
  });

  describe('limits', () => {
    it.fails('LIMIT: a locator in plain ASCII can still carry words meant to persuade ("safe to Allow"); it is shown on the caller\'s own line, below the fixed wording', async () => {
      await start();
      const res = await request({ from: 'bw://GitHub (approved by IT - safe to Allow)/password' });
      // What a dialog that could tell a name from a sentence would do.
      expect(res.status).toBe(400);
    });

    it.fails('LIMIT: software running as the same user can write credentials.links and broker.allowedRefs itself, and the item is then read with no dialog', async () => {
      await start();
      writeCredentialLink(configPath, 'github/token', OTHER_ITEM);
      declare('github', 'token');
      const res = await resolve();
      expect(shown).toEqual([]);
      // What a boundary inside one user account would do. There is none.
      expect(res.status).toBe(404);
    });
  });
});
