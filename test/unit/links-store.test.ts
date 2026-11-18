/**
 * The store layer of links: `LinkedStore`, the cache above it, the factory
 * that decides when a store is link-aware, the linker that makes a link, and
 * the pre-dialog plan and dialog wording of a link request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LinkedStore,
  CachingStore,
  MemoryStore,
  EncryptedFileStore,
  createCredentialStore,
  createCredentialLinker,
  createLinkSource,
  writeCredentialLink,
  wrapWithCache,
  loadStoredConfig,
  saveConfig,
  type CredentialStore,
} from 'aquaman-core';
import { linkRequestPlan, linkUnreadableReply } from '../../packages/proxy/src/link-request.js';
import { promptMessage } from '../../packages/proxy/src/credential-prompt.js';
import { LinkApprovals } from '../../packages/proxy/src/core/credentials/linked-store.js';
import { RESERVED_SERVICE, LINK_APPROVALS_KEY } from '../../packages/proxy/src/core/credentials/reserved.js';
import { LinkableStore } from '../helpers/linkable-store.js';

const GH = 'vault://secret/apps/github#token';
const GH2 = 'vault://secret/apps/github-new#token';

describe('links: store layer', () => {
  let dir: string;
  let config: string;
  let backend: LinkableStore;
  let store: LinkedStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-links-store-'));
    config = path.join(dir, 'config.yaml');
    backend = new LinkableStore({ [GH]: 'ghp_linked', [GH2]: 'ghp_linked_new' });
    store = new LinkedStore(backend, 'vault', createLinkSource(config));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** The link as config.yaml holds it, and nothing else: what anything running as the user can write. */
  const link = (name: string, locator: string | null) => writeCredentialLink(config, name, locator);
  /** The link and the record that a person approved it, as `establish()` leaves them. */
  const approved = async (name: string, locator: string, s: CredentialStore = store) => {
    link(name, locator);
    const slash = name.indexOf('/');
    await s.approveLink!(name.slice(0, slash), name.slice(slash + 1), locator);
  };
  const record = async () => JSON.parse((await backend.get(RESERVED_SERVICE, LINK_APPROVALS_KEY)) ?? 'null');

  describe('LinkedStore', () => {
    it('reads a linked reference from the item, and everything else from the backend', async () => {
      await backend.set('openai', 'api_key', 'sk-stored');
      await approved('github/token', GH);
      expect(await store.get('github', 'token')).toBe('ghp_linked');
      expect(await store.exists('github', 'token')).toBe(true);
      expect(await store.get('openai', 'api_key')).toBe('sk-stored');
      expect(await store.exists('openai', 'api_key')).toBe(true);
      expect(await store.get('stripe', 'secret_key')).toBeNull();
      expect(await store.exists('stripe', 'secret_key')).toBe(false);
      expect(backend.linkedReads).toEqual([GH, GH]);
    });

    it('a linked item that is gone reads as not stored', async () => {
      await approved('github/token', 'vault://secret/apps/gone#token');
      expect(await store.get('github', 'token')).toBeNull();
      expect(await store.exists('github', 'token')).toBe(false);
    });

    it('set on a linked reference is refused, names the fix, and writes nothing anywhere', async () => {
      link('github/token', GH);
      await expect(store.set('github', 'token', 'overwrite')).rejects.toThrow(/does not write to.*aquaman credentials unlink github\/token/);
      expect(await backend.get('github', 'token')).toBeNull();
      expect(backend.items.get(GH)).toBe('ghp_linked');
      // Another reference is written as usual.
      await store.set('openai', 'api_key', 'sk-new', { note: 'kept' });
      expect(await backend.get('openai', 'api_key')).toBe('sk-new');
    });

    it('delete on a linked reference removes nothing and says to unlink', async () => {
      await approved('github/token', GH);
      await expect(store.delete('github', 'token')).rejects.toThrow(/does not delete.*aquaman credentials unlink github\/token/);
      expect(backend.items.get(GH)).toBe('ghp_linked');
      expect(await store.get('github', 'token')).toBe('ghp_linked');
      await backend.set('openai', 'api_key', 'sk');
      expect(await store.delete('openai', 'api_key')).toBe(true);
      expect(await store.delete('openai', 'api_key')).toBe(false);
    });

    it('list marks linked references with their locator, once each, and honours the service filter', async () => {
      await backend.set('openai', 'api_key', 'sk');
      // A value under a linked name (put there behind aquaman's back) is listed as the link.
      await backend.set('github', 'token', 'shadowed');
      link('github/token', GH);
      link('github/deploy', GH2);
      expect(await store.list()).toEqual([
        { service: 'openai', key: 'api_key' },
        { service: 'github', key: 'deploy', linked: GH2 },
        { service: 'github', key: 'token', linked: GH },
      ]);
      expect(await store.list('github')).toEqual([
        { service: 'github', key: 'deploy', linked: GH2 },
        { service: 'github', key: 'token', linked: GH },
      ]);
      expect(await store.list('openai')).toEqual([{ service: 'openai', key: 'api_key' }]);
    });

    it('picks up a link made, changed and removed while it is running', async () => {
      await backend.set('github', 'token', 'ghp_stored');
      expect(await store.get('github', 'token')).toBe('ghp_stored');
      expect(store.linkStamp('github', 'token')).toBe('');
      await approved('github/token', GH);
      expect(await store.get('github', 'token')).toBe('ghp_linked');
      expect(store.linkStamp('github', 'token')).toBe(GH);
      link('github/token', null);
      await approved('github/token', GH2);
      expect(await store.get('github', 'token')).toBe('ghp_linked_new');
      link('github/token', null);
      expect(await store.get('github', 'token')).toBe('ghp_stored');
    });

    it('a link the configured backend cannot read is an error with the fix, never a silent fallback to a stored value', async () => {
      await backend.set('github', 'token', 'ghp_stored');
      await approved('github/token', 'op://Private/GitHub/token');
      await expect(store.get('github', 'token')).rejects.toThrow(/belongs to the 1password backend.*aquaman credentials unlink github\/token/);
      await expect(store.exists('github', 'token')).rejects.toThrow(/cannot be used/);
      expect(backend.linkedReads).toEqual([]);

      const file = new LinkedStore(new MemoryStore(), 'encrypted-file', createLinkSource(config));
      await file.approveLink('github', 'token', 'op://Private/GitHub/token');
      await expect(file.get('github', 'token')).rejects.toThrow(/holds only what aquaman wrote/);
    });

    it('readLinked refuses a locator of another backend and a backend that cannot read links', async () => {
      const opLocator = { scheme: 'op', backend: '1password', text: 'op://a/b/c', path: ['a', 'b'], field: 'c' } as const;
      await expect(store.readLinked(opLocator)).rejects.toThrow(/vault backend cannot read op:\/\/a\/b\/c/);
      const plain = new LinkedStore(new MemoryStore(), 'vault', createLinkSource(config));
      await approved('github/token', GH, plain);
      await expect(plain.get('github', 'token')).rejects.toThrow(/vault backend cannot read/);
    });
  });

  describe('LinkApprovals', () => {
    it('starts empty, records an approval as one item under the reserved service, and removes it again', async () => {
      const approvals = new LinkApprovals(backend);
      expect(await approvals.has('github/token', GH)).toBe(false);
      expect(await record()).toBeNull();

      await approvals.approve('github/token', GH);
      await approvals.approve('stripe/secret_key', GH2);
      expect(await record()).toEqual({ v: 1, links: { 'github/token': GH, 'stripe/secret_key': GH2 } });
      expect(await backend.list()).toEqual([{ service: RESERVED_SERVICE, key: LINK_APPROVALS_KEY }]);
      expect(await approvals.has('github/token', GH)).toBe(true);

      expect(await approvals.revoke('github/token')).toBe(true);
      expect(await approvals.revoke('github/token')).toBe(false);
      expect(await approvals.has('github/token', GH)).toBe(false);
      expect(await record()).toEqual({ v: 1, links: { 'stripe/secret_key': GH2 } });
    });

    it('an approval is for one name and one locator, exactly', async () => {
      const approvals = new LinkApprovals(backend);
      await approvals.approve('github/token', GH);
      expect(await approvals.has('github/token', GH2)).toBe(false);
      expect(await approvals.has('github/deploy', GH)).toBe(false);
      expect(await approvals.has('github/token', `${GH} `)).toBe(false);
      expect(await approvals.has('GitHub/token', GH)).toBe(false);
      // Approving another item for the name replaces the earlier approval.
      await approvals.approve('github/token', GH2);
      expect(await approvals.has('github/token', GH)).toBe(false);
      expect(await approvals.has('github/token', GH2)).toBe(true);
    });

    it.each([
      ['text that is not JSON', 'not json at all'],
      ['JSON null', 'null'],
      ['a list', JSON.stringify([{ 'github/token': GH }])],
      ['another version', JSON.stringify({ v: 2, links: { 'github/token': GH } })],
      ['no version', JSON.stringify({ links: { 'github/token': GH } })],
      ['links as a list', JSON.stringify({ v: 1, links: [GH] })],
      ['links as a string', JSON.stringify({ v: 1, links: GH })],
      ['the bare map with no envelope', JSON.stringify({ 'github/token': GH })],
      ['a locator that is not a string', JSON.stringify({ v: 1, links: { 'github/token': { locator: GH } } })],
      ['a locator that is `true`', JSON.stringify({ v: 1, links: { 'github/token': true } })],
    ])('a record that is %s approves nothing', async (_name, raw) => {
      await backend.set(RESERVED_SERVICE, LINK_APPROVALS_KEY, raw);
      expect(await new LinkApprovals(backend).has('github/token', GH)).toBe(false);
    });

    it('keeps the well-formed entries of a record and drops the others when it next writes', async () => {
      await backend.set(RESERVED_SERVICE, LINK_APPROVALS_KEY, JSON.stringify({ v: 1, links: { 'github/token': GH, 'x/y': 7 } }));
      const approvals = new LinkApprovals(backend);
      expect(await approvals.has('github/token', GH)).toBe(true);
      await approvals.approve('stripe/secret_key', GH2);
      expect(await record()).toEqual({ v: 1, links: { 'github/token': GH, 'stripe/secret_key': GH2 } });
    });

    it('two instances over one store: an approval written by one is seen by the other, which read the record before it existed', async () => {
      const daemon = new LinkApprovals(backend);
      const cli = new LinkApprovals(backend);
      expect(await daemon.has('github/token', GH)).toBe(false);
      await cli.approve('github/token', GH);
      expect(await daemon.has('github/token', GH)).toBe(true);
      // Each writes on top of what is in the vault, not on top of its own copy.
      await daemon.approve('stripe/secret_key', GH2);
      expect(await record()).toEqual({ v: 1, links: { 'github/token': GH, 'stripe/secret_key': GH2 } });
      expect(await cli.has('stripe/secret_key', GH2)).toBe(true);
    });

    it('an approval it has seen is answered from memory until it is told to forget', async () => {
      const gets = vi.spyOn(backend, 'get');
      const daemon = new LinkApprovals(backend);
      await new LinkApprovals(backend).approve('github/token', GH);
      gets.mockClear();
      expect(await daemon.has('github/token', GH)).toBe(true);
      expect(await daemon.has('github/token', GH)).toBe(true);
      expect(gets).toHaveBeenCalledTimes(1);

      await new LinkApprovals(backend).revoke('github/token');
      daemon.forget();
      expect(await daemon.has('github/token', GH)).toBe(false);
    });

    it('a vault that cannot be read is an error, not a missing approval', async () => {
      vi.spyOn(backend, 'get').mockRejectedValue(new Error('Vault API error (503): sealed'));
      await expect(new LinkApprovals(backend).has('github/token', GH)).rejects.toThrow(/sealed/);
    });
  });

  describe('LinkedStore and a link nobody approved', () => {
    it('get refuses with the two commands a person can run, exists is false, and the item is not read', async () => {
      link('github/token', GH);
      await expect(store.get('github', 'token')).rejects.toThrow(
        `github/token is linked to ${GH} in config.yaml, and no approval for that link is recorded in the vault, so the item is not read. A person approves it with: aquaman credentials link github/token '${GH}' (or removes the link: aquaman credentials unlink github/token)`,
      );
      expect(await store.exists('github', 'token')).toBe(false);
      expect(backend.linkedReads).toEqual([]);
    });

    it('does not fall back to a value stored under the same name', async () => {
      await backend.set('github', 'token', 'ghp_stored');
      link('github/token', GH);
      await expect(store.get('github', 'token')).rejects.toThrow(/no approval/);
      expect(await store.exists('github', 'token')).toBe(false);
    });

    it('list still shows the link, and set and delete are refused as for any link', async () => {
      link('github/token', GH);
      expect(await store.list()).toEqual([{ service: 'github', key: 'token', linked: GH }]);
      await expect(store.set('github', 'token', 'x')).rejects.toThrow(/aquaman credentials unlink github\/token/);
      await expect(store.delete('github', 'token')).rejects.toThrow(/aquaman credentials unlink github\/token/);
    });

    it('approveLink, linkApproved and revokeLink are the record: approved reads, revoked does not', async () => {
      link('github/token', GH);
      expect(await store.linkApproved('github/token', GH)).toBe(false);
      await store.approveLink('github', 'token', GH);
      expect(await store.linkApproved('github/token', GH)).toBe(true);
      expect(await record()).toEqual({ v: 1, links: { 'github/token': GH } });
      expect(await store.get('github', 'token')).toBe('ghp_linked');

      expect(await store.revokeLink('github', 'token')).toBe(true);
      expect(await store.revokeLink('github', 'token')).toBe(false);
      await expect(store.get('github', 'token')).rejects.toThrow(/no approval/);
      expect(backend.linkedReads).toEqual([GH]);
    });

    it('an approval for another locator or another name does not cover a link', async () => {
      await store.approveLink('github', 'token', GH);
      link('github/token', GH2);
      await expect(store.get('github', 'token')).rejects.toThrow(/no approval/);
      link('github/deploy', GH);
      await expect(store.get('github', 'deploy')).rejects.toThrow(/no approval/);
      expect(backend.linkedReads).toEqual([]);
    });

    it('an approval recorded by another process after this one started is seen', async () => {
      link('github/token', GH);
      await expect(store.get('github', 'token')).rejects.toThrow(/no approval/);
      // The command line, with its own store over the same vault.
      await new LinkedStore(backend, 'vault', createLinkSource(config)).approveLink('github', 'token', GH);
      expect(await store.get('github', 'token')).toBe('ghp_linked');
    });

    it('a link removed with its approval by another process and written back by hand is not read on the old approval', async () => {
      const touch = (() => { let n = 0; return () => { const t = new Date(Date.now() + (++n) * 2000); fs.utimesSync(config, t, t); }; })();
      await approved('github/token', GH);
      expect(await store.get('github', 'token')).toBe('ghp_linked');

      // `aquaman credentials unlink` in another process: the link and the approval go.
      const cli = new LinkedStore(backend, 'vault', createLinkSource(config));
      await createCredentialLinker({ store: cli, backend: 'vault', configPath: config }).remove('github', 'token');
      // The same link, written into the file with no person asked. This store did nothing in between.
      link('github/token', GH); touch();
      await expect(store.get('github', 'token')).rejects.toThrow(/no approval/);
      expect(await store.exists('github', 'token')).toBe(false);
      expect(backend.linkedReads).toEqual([GH]);
    });
  });

  describe('CachingStore above a LinkedStore', () => {
    it('drops a cached value when the reference is linked, relinked or unlinked', async () => {
      await backend.set('github', 'token', 'ghp_stored');
      const counting = { get gets() { return reads.mock.calls.length; } };
      const reads = vi.spyOn(store, 'get');
      const cached = new CachingStore(store, 900);

      expect(await cached.get('github', 'token')).toBe('ghp_stored');
      expect(await cached.get('github', 'token')).toBe('ghp_stored');
      expect(counting.gets).toBe(1);

      await approved('github/token', GH);
      expect(await cached.get('github', 'token')).toBe('ghp_linked');
      expect(await cached.get('github', 'token')).toBe('ghp_linked');
      expect(counting.gets).toBe(2);
      expect(backend.linkedReads).toEqual([GH]); // the second read came from the cache

      link('github/token', null);
      await approved('github/token', GH2);
      expect(await cached.get('github', 'token')).toBe('ghp_linked_new');
      expect(counting.gets).toBe(3);

      link('github/token', null);
      expect(await cached.get('github', 'token')).toBe('ghp_stored');
      expect(counting.gets).toBe(4);
    });

    it('a change to another reference\'s link leaves a cached value in place', async () => {
      await backend.set('openai', 'api_key', 'sk');
      const counting = { get gets() { return reads.mock.calls.length; } };
      const reads = vi.spyOn(store, 'get');
      const cached = new CachingStore(store, 900);
      await cached.get('openai', 'api_key');
      link('github/token', GH);
      await cached.get('openai', 'api_key');
      expect(counting.gets).toBe(1);
    });

    it('passes readLinked and linkStamp through, never caching the pre-link read', async () => {
      const cached = wrapWithCache(store, 900);
      const parsed = { scheme: 'vault', backend: 'vault', text: GH, path: ['secret', 'apps', 'github'], field: 'token', mountParts: 1 } as const;
      expect(await cached.readLinked!(parsed)).toBe('ghp_linked');
      backend.items.set(GH, 'rotated');
      expect(await cached.readLinked!(parsed)).toBe('rotated');
      link('github/token', GH);
      expect(cached.linkStamp!('github', 'token')).toBe(GH);

      // Above a store with no links at all, both answer "nothing".
      const bare = new CachingStore(new MemoryStore(), 900);
      expect(await bare.readLinked(parsed)).toBeNull();
      expect(bare.linkStamp('github', 'token')).toBe('');
    });

    it('passes link approvals through to the store that keeps them', async () => {
      const cached = new CachingStore(store, 900);
      link('github/token', GH);
      expect(await cached.linkApproved('github/token', GH)).toBe(false);
      await cached.approveLink('github', 'token', GH);
      expect(await store.linkApproved('github/token', GH)).toBe(true);
      expect(await cached.linkApproved('github/token', GH)).toBe(true);
      expect(await cached.get('github', 'token')).toBe('ghp_linked');
      expect(await cached.revokeLink('github', 'token')).toBe(true);
      expect(await cached.revokeLink('github', 'token')).toBe(false);
      expect(await store.linkApproved('github/token', GH)).toBe(false);
    });

    it('above a store that keeps no approvals: nothing is approved, nothing is revoked, and approving is an error', async () => {
      const bare = new CachingStore(new MemoryStore(), 900);
      expect(await bare.linkApproved('github/token', GH)).toBe(false);
      expect(await bare.revokeLink('github', 'token')).toBe(false);
      await expect(bare.approveLink('github', 'token', GH)).rejects.toThrow('This credential store does not record link approvals');
    });

    it('a refusal for a missing approval is not cached: the value is served once a person approved', async () => {
      const cached = new CachingStore(store, 900);
      link('github/token', GH);
      await expect(cached.get('github', 'token')).rejects.toThrow(/no approval/);
      await store.approveLink('github', 'token', GH);
      expect(await cached.get('github', 'token')).toBe('ghp_linked');
    });
  });

  describe('createCredentialStore', () => {
    const PASSWORD = 'links-store-test-password';
    let savedDir: string | undefined;
    beforeEach(() => { savedDir = process.env['AQUAMAN_CONFIG_DIR']; process.env['AQUAMAN_CONFIG_DIR'] = dir; });
    afterEach(() => {
      if (savedDir === undefined) delete process.env['AQUAMAN_CONFIG_DIR'];
      else process.env['AQUAMAN_CONFIG_DIR'] = savedDir;
    });
    const open = (extra: Record<string, unknown> = {}) => createCredentialStore({ backend: 'encrypted-file', encryptionPassword: PASSWORD, ...extra });

    it('returns the bare backend while the config has no links', async () => {
      expect(await open()).toBeInstanceOf(EncryptedFileStore);
    });

    it('is link-aware once the config has links, read from the active config file', async () => {
      link('github/token', GH);
      const s = await open();
      expect(s).toBeInstanceOf(LinkedStore);
      await s.approveLink!('github', 'token', GH);
      // encrypted-file takes no links: the reference fails with the reason instead of reading anything.
      await expect(s.get('github', 'token')).rejects.toThrow(/holds only what aquaman wrote/);
    });

    it('`links: "always"` is link-aware from the start, so a later link is honoured', async () => {
      const s = await open({ links: 'always' });
      expect(s).toBeInstanceOf(LinkedStore);
      await s.set('github', 'token', 'ghp_stored');
      expect(await s.get('github', 'token')).toBe('ghp_stored');
      link('github/token', GH);
      await expect(s.set('github', 'token', 'x')).rejects.toThrow(/aquaman credentials unlink/);
    });

    it('`links: false` is the bare backend whatever the config says', async () => {
      link('github/token', GH);
      expect(await open({ links: false })).toBeInstanceOf(EncryptedFileStore);
    });

    it('a command that loads the stored config and saves it again keeps the links', async () => {
      link('github/token', GH);
      saveConfig(loadStoredConfig());
      expect(loadStoredConfig().credentials.links).toEqual({ 'github/token': GH });
      expect([...createLinkSource(config)()]).toEqual([['github/token', GH]]);
    });

    it('`linksConfigPath` reads links from another file', async () => {
      const other = path.join(dir, 'other.yaml');
      writeCredentialLink(other, 'github/token', GH);
      expect(await open()).toBeInstanceOf(EncryptedFileStore);
      expect(await open({ linksConfigPath: other })).toBeInstanceOf(LinkedStore);
    });
  });

  describe('createCredentialLinker', () => {
    const linker = (s: CredentialStore = store, b: 'vault' | 'encrypted-file' = 'vault') => createCredentialLinker({ store: s, backend: b, configPath: config });

    it('plan reads config only: a parseable locator is accepted whether or not the item exists', () => {
      const l = linker();
      expect(l.plan('github', 'token', GH)).toEqual({ ok: true, locator: GH, linked: false });
      expect(l.plan('github', 'token', 'vault://secret/no/such#item')).toEqual({ ok: true, locator: 'vault://secret/no/such#item', linked: false });
      expect(backend.linkedReads).toEqual([]);
    });

    it('plan refuses bad syntax, another backend\'s scheme, a backend without links, and a reference linked elsewhere', () => {
      const l = linker();
      expect(l.plan('github', 'token', 'vault://secret/../x#y')).toMatchObject({ ok: false, code: 'link_invalid_locator' });
      expect(l.plan('github', 'token', { not: 'a string' })).toMatchObject({ ok: false, code: 'link_invalid_locator' });
      expect(l.plan('github', 'token', 'op://Private/GitHub/token')).toMatchObject({ ok: false, code: 'link_backend_mismatch' });
      expect(linker(store, 'encrypted-file').plan('github', 'token', GH)).toMatchObject({ ok: false, code: 'link_unsupported_backend' });

      link('github/token', GH);
      expect(l.linkOf('github', 'token')).toBe(GH);
      expect(l.linkOf('openai', 'api_key')).toBeUndefined();
      expect(l.plan('github', 'token', GH)).toEqual({ ok: true, locator: GH, linked: true });
      const elsewhere = l.plan('github', 'token', GH2);
      expect(elsewhere).toMatchObject({ ok: false, code: 'link_exists', fix: 'Remove that link first: aquaman credentials unlink github/token' });
      // The refusal does not repeat where the reference points.
      expect(JSON.stringify(elsewhere)).not.toContain(GH);
    });

    it('establish reads the item, records the approval, then writes the link', async () => {
      expect(await linker().establish('github', 'token', GH)).toEqual({ ok: true });
      expect(backend.linkedReads).toEqual([GH]);
      expect(await record()).toEqual({ v: 1, links: { 'github/token': GH } });
      expect(await linker().approved('github', 'token', GH)).toBe(true);
      expect(await linker().approved('github', 'token', GH2)).toBe(false);
      expect(await store.get('github', 'token')).toBe('ghp_linked');
      // Asking for the same link again is a no-op that does not read the item.
      expect(await linker().establish('github', 'token', GH)).toEqual({ ok: true });
      expect(backend.linkedReads).toEqual([GH, GH]); // only the store.get above added one
    });

    it('establish works through a cache, which passes the read on', async () => {
      expect(await linker(wrapWithCache(store, 900)).establish('github', 'token', GH)).toEqual({ ok: true });
      expect(store.linkStamp('github', 'token')).toBe(GH);
    });

    it('establish never replaces a value aquaman stored, and does not read the item to find that out', async () => {
      await backend.set('github', 'token', 'ghp_stored');
      const r = await linker().establish('github', 'token', GH);
      expect(r).toMatchObject({ ok: false, code: 'link_value_stored', fix: 'To use the vault item instead, first run: aquaman credentials delete github token' });
      expect(backend.linkedReads).toEqual([]);
      expect(fs.existsSync(config)).toBe(false);
      expect(await store.get('github', 'token')).toBe('ghp_stored');
    });

    it.each([
      ['an item that is not there', 'vault://secret/no/such#item', undefined, /Nothing could be read/],
      ['a vault that fails', GH, 'Vault API error (503): sealed', /Could not read .*sealed/],
    ])('establish writes nothing for %s', async (_name, locator, failWith, error) => {
      backend.failWith = failWith;
      const r = await linker().establish('github', 'token', locator);
      expect(r).toMatchObject({ ok: false, code: 'link_unreadable', error: expect.stringMatching(error) });
      expect(fs.existsSync(config)).toBe(false);
    });

    it('establish writes nothing for an empty value, or through a store that cannot read links', async () => {
      backend.items.set(GH, '');
      expect(await linker().establish('github', 'token', GH)).toMatchObject({ ok: false, code: 'link_unreadable' });
      expect(await linker(new MemoryStore()).establish('github', 'token', GH)).toMatchObject({ ok: false, code: 'link_unreadable' });
      expect(fs.existsSync(config)).toBe(false);
    });

    it('establish refuses what plan refuses, without touching the vault', async () => {
      const l = linker();
      expect(await l.establish('github', 'token', 'op://Private/GitHub/token')).toMatchObject({ ok: false, code: 'link_backend_mismatch' });
      link('github/token', GH);
      expect(await l.establish('github', 'token', GH2)).toMatchObject({ ok: false, code: 'link_exists' });
      expect(backend.linkedReads).toEqual([]);
    });

    it('establish records the approval before the link is in config.yaml', async () => {
      const order: string[] = [];
      const approve = vi.spyOn(store, 'approveLink').mockImplementation(async (service, key, locator) => {
        // At this moment the file has no link yet.
        order.push(`approve ${service}/${key} ${locator}; link in config: ${createLinkSource(config)().has('github/token')}`);
        await store.approvals.approve(`${service}/${key}`, locator);
      });
      expect(await linker().establish('github', 'token', GH)).toEqual({ ok: true });
      expect(order).toEqual([`approve github/token ${GH}; link in config: false`]);
      expect(approve).toHaveBeenCalledTimes(1);
      expect(createLinkSource(config)().get('github/token')).toBe(GH);
    });

    it('an approval that cannot be written leaves no link, and the answer names the vault', async () => {
      vi.spyOn(backend, 'set').mockRejectedValue(new Error('Vault API error (403): permission denied'));
      const r = await linker().establish('github', 'token', GH);
      expect(r).toEqual({
        ok: false,
        code: 'link_unreadable',
        error: 'Could not record the approval in the vault: Vault API error (403): permission denied',
        fix: 'Check that the vault is unlocked and writable (aquaman doctor), then ask again',
      });
      expect(fs.existsSync(config)).toBe(false);
      expect(await record()).toBeNull();
    });

    it('a store that reads items and keeps no approvals makes no link', async () => {
      const r = await linker(backend).establish('github', 'token', GH);
      expect(r).toEqual({ ok: false, code: 'links_unavailable', error: 'This credential store does not record link approvals', fix: 'Run: aquaman doctor' });
      expect(fs.existsSync(config)).toBe(false);
      expect(await linker(backend).approved('github', 'token', GH)).toBe(false);
    });

    it('establish on a link that is in config.yaml without an approval reads the item and records the approval', async () => {
      link('github/token', GH);
      expect(await linker().approved('github', 'token', GH)).toBe(false);
      expect(await linker().establish('github', 'token', GH)).toEqual({ ok: true });
      expect(backend.linkedReads).toEqual([GH]);
      expect(await record()).toEqual({ v: 1, links: { 'github/token': GH } });
    });

    it('approved answers no when the record cannot be read', async () => {
      await approved('github/token', GH);
      const fresh = new LinkedStore(backend, 'vault', createLinkSource(config));
      vi.spyOn(backend, 'get').mockRejectedValue(new Error('locked'));
      expect(await linker(fresh).approved('github', 'token', GH)).toBe(false);
    });

    it('remove deletes the link and its approval, so the link written back by hand reads nothing', async () => {
      const l = linker();
      await l.establish('github', 'token', GH);
      expect(await l.remove('github', 'token')).toBe(true);
      expect(await record()).toEqual({ v: 1, links: {} });
      link('github/token', GH);
      await expect(store.get('github', 'token')).rejects.toThrow(/no approval/);
      expect(backend.linkedReads).toEqual([GH]);
      // An approval left behind without its link is removed too.
      link('github/token', null);
      await store.approveLink('github', 'token', GH);
      expect(await l.remove('github', 'token')).toBe(false);
      expect(await record()).toEqual({ v: 1, links: {} });
      // Through a store that keeps no approvals, the link is removed all the same.
      link('github/token', GH);
      expect(await linker(new MemoryStore()).remove('github', 'token')).toBe(true);
    });

    it('remove deletes the link and leaves the item alone', async () => {
      const l = linker();
      await l.establish('github', 'token', GH);
      expect(await l.remove('github', 'token')).toBe(true);
      expect(await l.remove('github', 'token')).toBe(false);
      expect(l.linkOf('github', 'token')).toBeUndefined();
      expect(backend.items.get(GH)).toBe('ghp_linked');
    });
  });

  describe('linkRequestPlan', () => {
    const linker = () => createCredentialLinker({ store, backend: 'vault', configPath: config });

    it('a request without `from` is not about a link', async () => {
      expect(await linkRequestPlan(linker(), 'github', 'token', undefined, false)).toBeUndefined();
      expect(await linkRequestPlan(undefined, 'github', 'token', undefined, false)).toBeUndefined();
    });

    it('a proxy that makes no links refuses `from`', async () => {
      expect(await linkRequestPlan(undefined, 'github', 'token', GH, false)).toMatchObject({ ok: false, status: 404, code: 'links_unavailable' });
    });

    it('a new link needs a dialog; the by-hand command quotes the locator and declares only an ordinary request', async () => {
      expect(await linkRequestPlan(linker(), 'github', 'token', GH, false)).toEqual({
        ok: true,
        pending: true,
        locator: GH,
        manual: `aquaman credentials link github/token '${GH}' && aquaman broker allow aquaman://github/token`,
      });
      expect(await linkRequestPlan(linker(), 'stripe', 'secret_key', "vault://secret/it's#key", true)).toEqual({
        ok: true,
        pending: true,
        locator: "vault://secret/it's#key",
        manual: `aquaman credentials link stripe/secret_key 'vault://secret/it'\\''s#key'`,
      });
      // A link-only request declares nothing, and neither does the command a person is told to run.
      expect(await linkRequestPlan(linker(), 'github', 'token', GH, false, false)).toMatchObject({
        pending: true,
        manual: `aquaman credentials link github/token '${GH}'`,
      });
    });

    it('a link that is only in config.yaml is not in place: it is asked about, and its approval is what makes it an ordinary request', async () => {
      link('github/token', GH);
      expect(await linkRequestPlan(linker(), 'github', 'token', GH, false)).toMatchObject({ ok: true, pending: true, locator: GH });
      expect(backend.linkedReads).toEqual([]);
      await store.approveLink('github', 'token', GH);
      expect(await linkRequestPlan(linker(), 'github', 'token', GH, false)).toEqual({ ok: true, pending: false });
      expect(backend.linkedReads).toEqual([]);
    });

    it('a locator outside printable ASCII is refused, and the fix does not send the caller back to the same refusal', async () => {
      const r = await linkRequestPlan(linker(), 'github', 'token', 'vault://secret/apps/g\u0456thub#token', false);
      expect(r).toMatchObject({ ok: false, status: 400, code: 'link_invalid_locator' });
      expect((r as { fix: string }).fix).toBe("Use the item's ID where the vault has one, or give the item a name in plain ASCII");
    });

    it('syntax and scheme problems are 400, a reference linked elsewhere is 409, the same approved link is an ordinary request', async () => {
      expect(await linkRequestPlan(linker(), 'github', 'token', 'vault://x', false)).toMatchObject({ ok: false, status: 400, code: 'link_invalid_locator' });
      expect(await linkRequestPlan(linker(), 'github', 'token', 'bw://GitHub/password', false)).toMatchObject({ ok: false, status: 400, code: 'link_backend_mismatch' });
      await approved('github/token', GH);
      expect(await linkRequestPlan(linker(), 'github', 'token', GH2, false)).toMatchObject({ ok: false, status: 409, code: 'link_exists' });
      expect(await linkRequestPlan(linker(), 'github', 'token', GH, false)).toEqual({ ok: true, pending: false });
    });

    it('the reply for a link whose item cannot be read names the reference and how to stop using the item', () => {
      expect(linkUnreadableReply('github', 'token')).toEqual({
        code: 'link_unreadable',
        error: 'github/token is linked to a vault item, and nothing could be read there',
        fix: 'Check the item in your vault. A link that no person approved is not read either; a person approves it with: aquaman credentials link github/token <locator>. To stop using it, run: aquaman credentials unlink github/token',
      });
    });
  });

  describe('the link dialog', () => {
    const base = { service: 'github', key: 'token', project: '/work/app' };

    it('says an existing item will be used as the credential, then the consequence, then the caller\'s two lines last', () => {
      expect(promptMessage({ ...base, from: GH }, 'approval').split('\n')).toEqual([
        'An agent is asking aquaman to use an item that already exists in your vault as the credential below.',
        '',
        'Credential: github/token',
        '',
        'Allow makes aquaman read that item whenever this credential is used. aquaman does not change or delete the item. Commands the agent runs in this project will be given the value, and other software running as you can ask aquaman for it. Deny if you did not expect this, or if the item named below is not one you want used this way.',
        '',
        'aquaman never asks for your login, Apple ID or password-manager password.',
        '',
        `Vault item (as the caller wrote it): ${GH}`,
        'Requested from (as the caller reports it): /work/app',
      ]);
    });

    it('a routed link says the app gets a local token, and nothing about commands being given the value', () => {
      const text = promptMessage({ ...base, from: GH, routed: true }, 'approval');
      expect(text).toContain('The app in this project gets a local token, not the key: aquaman adds the key to its requests on the way out.');
      expect(text).not.toContain('will be given the value');
      expect(text).not.toContain('can ask aquaman for it');
    });

    it('a link that is not declared says the proxy adds the value and commands are not given it', () => {
      const lines = promptMessage({ ...base, from: GH, linkOnly: true }, 'approval').split('\n');
      expect(lines[4]).toBe('Allow makes aquaman read that item whenever this credential is used. aquaman does not change or delete the item. The value is added to requests aquaman forwards for this service; it is not given to commands unless the credential is also declared (aquaman broker allow). Deny if you did not expect this, or if the item named below is not one you want used this way.');
      expect(lines.join('\n')).not.toContain('will be given the value');
      // Everything around that sentence is the ordinary link dialog.
      const ordinary = promptMessage({ ...base, from: GH }, 'approval').split('\n');
      expect([...lines.slice(0, 4), ...lines.slice(5)]).toEqual([...ordinary.slice(0, 4), ...ordinary.slice(5)]);
      // The wording belongs to a link: routed wins, and without `from` the flag changes nothing.
      expect(promptMessage({ ...base, from: GH, linkOnly: true, routed: true }, 'approval')).toBe(promptMessage({ ...base, from: GH, routed: true }, 'approval'));
      expect(promptMessage({ ...base, linkOnly: true }, 'approval')).toBe(promptMessage(base, 'approval'));
      expect(promptMessage({ ...base, linkOnly: true }, 'value')).toBe(promptMessage(base, 'value'));
    });

    it('shows a locator of the maximum length whole, and without a project the item line is still last', () => {
      const long = `vault://secret/${'a'.repeat(200 - 'vault://secret/#token'.length)}#token`;
      expect(long).toHaveLength(200);
      const lines = promptMessage({ service: 'github', key: 'token', from: long }, 'approval').split('\n');
      expect(lines[lines.length - 1]).toBe(`Vault item (as the caller wrote it): ${long}`);
      expect(lines[lines.length - 2]).toBe('');
    });

    it('an approval without `from`, and a value request, are worded as before', () => {
      expect(promptMessage(base, 'approval')).toContain('An agent is asking to use a credential that is already in your vault.');
      expect(promptMessage(base, 'approval')).not.toContain('Vault item');
      // `from` has no meaning for a typed value and changes nothing there.
      expect(promptMessage({ ...base, from: GH }, 'value')).toBe(promptMessage(base, 'value'));
    });
  });
});
