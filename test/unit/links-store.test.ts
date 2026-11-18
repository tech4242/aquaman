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

  const link = (name: string, locator: string | null) => writeCredentialLink(config, name, locator);

  describe('LinkedStore', () => {
    it('reads a linked reference from the item, and everything else from the backend', async () => {
      await backend.set('openai', 'api_key', 'sk-stored');
      link('github/token', GH);
      expect(await store.get('github', 'token')).toBe('ghp_linked');
      expect(await store.exists('github', 'token')).toBe(true);
      expect(await store.get('openai', 'api_key')).toBe('sk-stored');
      expect(await store.exists('openai', 'api_key')).toBe(true);
      expect(await store.get('stripe', 'secret_key')).toBeNull();
      expect(await store.exists('stripe', 'secret_key')).toBe(false);
      expect(backend.linkedReads).toEqual([GH, GH]);
    });

    it('a linked item that is gone reads as not stored', async () => {
      link('github/token', 'vault://secret/apps/gone#token');
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
      link('github/token', GH);
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
      link('github/token', GH);
      expect(await store.get('github', 'token')).toBe('ghp_linked');
      expect(store.linkStamp('github', 'token')).toBe(GH);
      link('github/token', null);
      link('github/token', GH2);
      expect(await store.get('github', 'token')).toBe('ghp_linked_new');
      link('github/token', null);
      expect(await store.get('github', 'token')).toBe('ghp_stored');
    });

    it('a link the configured backend cannot read is an error with the fix, never a silent fallback to a stored value', async () => {
      await backend.set('github', 'token', 'ghp_stored');
      link('github/token', 'op://Private/GitHub/token');
      await expect(store.get('github', 'token')).rejects.toThrow(/belongs to the 1password backend.*aquaman credentials unlink github\/token/);
      await expect(store.exists('github', 'token')).rejects.toThrow(/cannot be used/);
      expect(backend.linkedReads).toEqual([]);

      const file = new LinkedStore(new MemoryStore(), 'encrypted-file', createLinkSource(config));
      await expect(file.get('github', 'token')).rejects.toThrow(/holds only what aquaman wrote/);
    });

    it('readLinked refuses a locator of another backend and a backend that cannot read links', async () => {
      const opLocator = { scheme: 'op', backend: '1password', text: 'op://a/b/c', path: ['a', 'b'], field: 'c' } as const;
      await expect(store.readLinked(opLocator)).rejects.toThrow(/vault backend cannot read op:\/\/a\/b\/c/);
      const plain = new LinkedStore(new MemoryStore(), 'vault', createLinkSource(config));
      link('github/token', GH);
      await expect(plain.get('github', 'token')).rejects.toThrow(/vault backend cannot read/);
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

      link('github/token', GH);
      expect(await cached.get('github', 'token')).toBe('ghp_linked');
      expect(await cached.get('github', 'token')).toBe('ghp_linked');
      expect(counting.gets).toBe(2);
      expect(backend.linkedReads).toEqual([GH]); // the second read came from the cache

      link('github/token', null);
      link('github/token', GH2);
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

    it('establish reads the item, then writes the link', async () => {
      expect(await linker().establish('github', 'token', GH)).toEqual({ ok: true });
      expect(backend.linkedReads).toEqual([GH]);
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

    it('remove deletes the link and leaves the item alone', async () => {
      const l = linker();
      await l.establish('github', 'token', GH);
      expect(l.remove('github', 'token')).toBe(true);
      expect(l.remove('github', 'token')).toBe(false);
      expect(l.linkOf('github', 'token')).toBeUndefined();
      expect(backend.items.get(GH)).toBe('ghp_linked');
    });
  });

  describe('linkRequestPlan', () => {
    const linker = () => createCredentialLinker({ store, backend: 'vault', configPath: config });

    it('a request without `from` is not about a link', () => {
      expect(linkRequestPlan(linker(), 'github', 'token', undefined, false)).toBeUndefined();
      expect(linkRequestPlan(undefined, 'github', 'token', undefined, false)).toBeUndefined();
    });

    it('a proxy that makes no links refuses `from`', () => {
      expect(linkRequestPlan(undefined, 'github', 'token', GH, false)).toMatchObject({ ok: false, status: 404, code: 'links_unavailable' });
    });

    it('a new link needs a dialog; the by-hand command quotes the locator and declares only an ordinary request', () => {
      expect(linkRequestPlan(linker(), 'github', 'token', GH, false)).toEqual({
        ok: true,
        pending: true,
        locator: GH,
        manual: `aquaman credentials link github/token '${GH}' && aquaman broker allow aquaman://github/token`,
      });
      expect(linkRequestPlan(linker(), 'stripe', 'secret_key', "vault://secret/it's#key", true)).toEqual({
        ok: true,
        pending: true,
        locator: "vault://secret/it's#key",
        manual: `aquaman credentials link stripe/secret_key 'vault://secret/it'\\''s#key'`,
      });
    });

    it('syntax and scheme problems are 400, a reference linked elsewhere is 409, the same link is an ordinary request', () => {
      expect(linkRequestPlan(linker(), 'github', 'token', 'vault://x', false)).toMatchObject({ ok: false, status: 400, code: 'link_invalid_locator' });
      expect(linkRequestPlan(linker(), 'github', 'token', 'bw://GitHub/password', false)).toMatchObject({ ok: false, status: 400, code: 'link_backend_mismatch' });
      link('github/token', GH);
      expect(linkRequestPlan(linker(), 'github', 'token', GH2, false)).toMatchObject({ ok: false, status: 409, code: 'link_exists' });
      expect(linkRequestPlan(linker(), 'github', 'token', GH, false)).toEqual({ ok: true, pending: false });
    });

    it('the reply for a link whose item cannot be read names the reference and how to stop using the item', () => {
      expect(linkUnreadableReply('github', 'token')).toEqual({
        code: 'link_unreadable',
        error: 'github/token is linked to a vault item, and nothing could be read there',
        fix: 'Check the item in your vault. To stop using it, run: aquaman credentials unlink github/token',
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
