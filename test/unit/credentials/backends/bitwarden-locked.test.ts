/**
 * The Bitwarden backend in a serving process: a locked vault is a state, a
 * session can be handed over, and a session `bw` stops accepting lands in
 * the same state. `bw` is the stand-in from test/helpers/fake-bw.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cp = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => cp);

import { BitwardenStore } from '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js';
import { VaultLockedError, isVaultLocked, VAULT_UNLOCK_FIX } from '../../../../packages/proxy/src/core/credentials/vault-lock.js';
import { CachingStore } from '../../../../packages/proxy/src/core/credentials/caching-store.js';
import { LinkedStore } from '../../../../packages/proxy/src/core/credentials/linked-store.js';
import { MemoryStore } from '../../../../packages/proxy/src/core/credentials/store.js';
import { parseLocatorFor } from '../../../../packages/proxy/src/core/credentials/links.js';
import { createFakeBw, fakeSession, type FakeBw } from '../../../helpers/fake-bw.js';

const SESSION = fakeSession('first');
const OTHER = fakeSession('second');

let bw: FakeBw;

beforeEach(() => {
  bw = createFakeBw();
  bw.state.items.set('aquaman::github::token', 'ghp_fake_value');
  cp.spawnSync.mockReset();
  cp.spawnSync.mockImplementation((cmd: string, args?: string[], opts?: { env?: Record<string, string>; input?: string }) => bw.spawnSync(cmd, args, opts));
  delete process.env['BW_SESSION'];
});

afterEach(() => {
  delete process.env['BW_SESSION'];
});

const serving = () => new BitwardenStore({ serving: true });

async function lockedError(run: () => Promise<unknown>): Promise<VaultLockedError> {
  try {
    await run();
  } catch (err) {
    expect(isVaultLocked(err)).toBe(true);
    return err as VaultLockedError;
  }
  throw new Error('expected the vault to be locked');
}

describe('start', () => {
  it('a one-shot command still refuses to start on a locked vault, with the fix for a shell', () => {
    let thrown: unknown;
    try { new BitwardenStore(); } catch (err) { thrown = err; }
    expect(isVaultLocked(thrown)).toBe(true);
    expect((thrown as VaultLockedError).message).toContain('Bitwarden vault is locked');
    expect((thrown as VaultLockedError).fix).toBe('Run: export BW_SESSION=$(bw unlock --raw)');
  });

  it('a one-shot command still refuses to start logged out', () => {
    bw.state.loggedIn = false;
    expect(() => new BitwardenStore()).toThrow('Not logged in to Bitwarden. Run: bw login');
  });

  it.each([
    ['locked, no session', () => {}],
    ['locked, a BW_SESSION bw does not accept', () => { process.env['BW_SESSION'] = OTHER; }],
    ['logged out', () => { bw.state.loggedIn = false; }],
  ])('a serving process starts when the vault is %s, in the locked state', (_name, arrange) => {
    arrange();
    const store = serving();
    expect(store.vaultState()).toBe('locked');
  });

  it('a serving process starts unlocked on a BW_SESSION bw accepts', async () => {
    bw.state.sessions.add(SESSION);
    process.env['BW_SESSION'] = SESSION;
    const store = serving();
    expect(store.vaultState()).toBe('unlocked');
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
  });

  it('a serving process still refuses to start without the bw program', () => {
    bw.state.installed = false;
    expect(() => serving()).toThrow('Bitwarden CLI (bw) not found');
  });
});

describe('while locked', () => {
  it.each([
    ['get', (s: BitwardenStore) => s.get('github', 'token')],
    ['exists', (s: BitwardenStore) => s.exists('github', 'token')],
    ['list', (s: BitwardenStore) => s.list()],
    ['set', (s: BitwardenStore) => s.set('github', 'token', 'v')],
    ['delete', (s: BitwardenStore) => s.delete('github', 'token')],
    ['readLinked', (s: BitwardenStore) => {
      const parsed = parseLocatorFor('bitwarden', 'bw://Work GitHub/password');
      if (!parsed.ok) throw new Error('locator');
      return s.readLinked(parsed.locator);
    }],
  ])('%s fails with vault_locked and the fix, and does not start bw', async (_name, run) => {
    const store = serving();
    const before = bw.calls.length;
    const err = await lockedError(() => run(store));
    expect(err.code).toBe('vault_locked');
    expect(err.fix).toBe(VAULT_UNLOCK_FIX);
    expect(err.message).toContain('aquaman unlock');
    expect(bw.calls.length).toBe(before);
  });
});

describe('adoptSession', () => {
  it('takes a session bw accepts; reads then run under it, in the environment and never in the arguments', async () => {
    const store = serving();
    bw.state.sessions.add(SESSION);
    expect(await store.adoptSession(SESSION)).toEqual({ ok: true });
    expect(store.vaultState()).toBe('unlocked');
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    const reads = bw.bwCalls('list', 'items');
    expect(reads.length).toBeGreaterThan(0);
    for (const call of bw.bwCalls()) {
      expect(call.args.join(' ')).not.toContain(SESSION);
      expect(call.env['BW_NOINTERACTION']).toBe('true');
    }
    expect(reads[0].env['BW_SESSION']).toBe(SESSION);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['with a line break', `${SESSION}\nBW_SESSION=x`],
    ['with a space', `${SESSION} --raw`],
    ['not base64', '$(touch /tmp/x)aaaaaaaaaaaaaaaa'],
    ['far too long', 'A'.repeat(600)],
  ])('refuses a value that is not the shape of a session (%s) without starting bw', async (_name, value) => {
    const store = serving();
    const before = bw.calls.length;
    const result = await store.adoptSession(value);
    expect(result).toMatchObject({ ok: false, code: 'session_malformed' });
    expect(bw.calls.length).toBe(before);
    expect(store.vaultState()).toBe('locked');
  });

  it('refuses a session bw does not accept, and says nothing of the session', async () => {
    const store = serving();
    const result = await store.adoptSession(OTHER);
    expect(result).toMatchObject({ ok: false, code: 'session_refused', fix: 'Run: aquaman unlock' });
    expect(JSON.stringify(result)).not.toContain(OTHER);
    expect(store.vaultState()).toBe('locked');
  });

  it('a refused session leaves a working one in place', async () => {
    const store = serving();
    bw.state.sessions.add(SESSION);
    await store.adoptSession(SESSION);
    expect(await store.adoptSession(OTHER)).toMatchObject({ ok: false, code: 'session_refused' });
    expect(store.vaultState()).toBe('unlocked');
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    expect(bw.bwCalls('get', 'item').pop()!.env['BW_SESSION']).toBe(SESSION);
  });

  it('says a person has to log in when bw is logged out', async () => {
    bw.state.loggedIn = false;
    const store = serving();
    expect(await store.adoptSession(SESSION)).toMatchObject({ ok: false, code: 'not_logged_in', fix: expect.stringContaining('bw login') });
  });

  it('refuses a session for another account than the one the process started with', async () => {
    const store = serving();
    bw.state.userId = 'user-2';
    bw.state.sessions.add(SESSION);
    expect(await store.adoptSession(SESSION)).toMatchObject({ ok: false, code: 'account_changed' });
    expect(store.vaultState()).toBe('locked');
  });

  it('a process that started logged out takes the first account it is unlocked for, and only that one', async () => {
    bw.state.loggedIn = false;
    const store = serving();
    bw.state.loggedIn = true;
    bw.state.sessions.add(SESSION);
    expect(await store.adoptSession(SESSION)).toEqual({ ok: true });
    bw.state.userId = 'user-2';
    bw.state.sessions.add(OTHER);
    expect(await store.adoptSession(OTHER)).toMatchObject({ ok: false, code: 'account_changed' });
  });

  it('reports a bw that cannot be asked, without adopting anything', async () => {
    const store = serving();
    cp.spawnSync.mockImplementation(() => { throw new Error('spawnSync bw EACCES'); });
    expect(await store.adoptSession(SESSION)).toMatchObject({ ok: false, code: 'vault_cli_failed' });
    expect(store.vaultState()).toBe('locked');
  });
});

describe('a session that goes stale', () => {
  async function unlocked(): Promise<BitwardenStore> {
    const store = serving();
    bw.state.sessions.add(SESSION);
    await store.adoptSession(SESSION);
    return store;
  }

  it.each([
    ['bw lock', () => bw.lock(), 'Vault is locked.'],
    ['another bw unlock, which ends earlier keys', () => { bw.state.sessions.clear(); bw.state.sessions.add(OTHER); }, 'Vault is locked.'],
    ['bw logout', () => { bw.state.loggedIn = false; }, 'You are not logged in.'],
  ])('after %s the next read is vault_locked with the same fix, not an unexplained error or a missing credential', async (_name, end) => {
    const store = await unlocked();
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    end();
    const err = await lockedError(() => store.get('github', 'token'));
    expect(err.fix).toBe(VAULT_UNLOCK_FIX);
    expect(store.vaultState()).toBe('locked');
    // From here on bw is not started again until a session is handed over.
    const before = bw.calls.length;
    await lockedError(() => store.exists('github', 'token'));
    expect(bw.calls.length).toBe(before);
  });

  it('a bw failure that is not about the lock stays an ordinary error and does not lock the store', async () => {
    const store = await unlocked();
    cp.spawnSync.mockImplementation((cmd: string, args?: string[], opts?: { env?: Record<string, string> }) =>
      args?.[0] === 'list' && args?.[1] === 'items'
        ? { status: 1, stdout: '', stderr: 'Request failed.', signal: null, pid: 1, output: [] }
        : bw.spawnSync(cmd, args, opts));
    await expect(store.list()).rejects.toThrow('bw command failed: Request failed.');
    expect(store.vaultState()).toBe('unlocked');
  });

  it('checkSession asks bw and locks the store when the session is no longer accepted', async () => {
    const store = await unlocked();
    expect(await store.checkSession()).toBe('unlocked');
    bw.lock();
    expect(store.vaultState()).toBe('unlocked');
    expect(await store.checkSession()).toBe('locked');
    expect(store.vaultState()).toBe('locked');
  });

  it('can be unlocked again with a new session', async () => {
    const store = await unlocked();
    bw.lock();
    await lockedError(() => store.get('github', 'token'));
    bw.state.sessions.add(OTHER);
    expect(await store.adoptSession(OTHER)).toEqual({ ok: true });
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
  });
});

describe('forgetSession', () => {
  it('drops the session, including the copy the process was started with, and bw is not told', async () => {
    bw.state.sessions.add(SESSION);
    process.env['BW_SESSION'] = SESSION;
    const store = serving();
    expect(store.vaultState()).toBe('unlocked');
    const before = bw.calls.length;
    store.forgetSession();
    expect(bw.calls.length).toBe(before);
    expect(process.env['BW_SESSION']).toBeUndefined();
    expect(store.vaultState()).toBe('locked');
    await lockedError(() => store.get('github', 'token'));
    // The key itself still works for whoever else holds it: bw was not locked.
    expect(bw.state.sessions.has(SESSION)).toBe(true);
  });

  it('a BW_SESSION left in the process environment is not passed to bw once the store holds another', async () => {
    process.env['BW_SESSION'] = OTHER;
    const store = serving();
    bw.state.sessions.add(SESSION);
    await store.adoptSession(SESSION);
    await store.get('github', 'token');
    expect(bw.bwCalls('get', 'item').pop()!.env['BW_SESSION']).toBe(SESSION);
  });
});

describe('through the wrappers a daemon uses', () => {
  it('CachingStore passes the session through, and drops cached values when the session is forgotten', async () => {
    const inner = serving();
    const store = new CachingStore(inner, 900);
    expect(store.vaultState!()).toBe('locked');
    bw.state.sessions.add(SESSION);
    expect(await store.adoptSession!(SESSION)).toEqual({ ok: true });
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    store.forgetSession!();
    await lockedError(() => store.get('github', 'token'));
  });

  it('CachingStore drops cached values when a read finds the vault locked, and when a check does', async () => {
    const store = new CachingStore(serving(), 900);
    bw.state.sessions.add(SESSION);
    bw.state.items.set('aquaman::github::other', 'second_value');
    await store.adoptSession!(SESSION);
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    bw.lock();
    // A cached value is still served until something reaches the vault.
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    await lockedError(() => store.get('github', 'other'));
    await lockedError(() => store.get('github', 'token'));

    bw.state.sessions.add(OTHER);
    await store.adoptSession!(OTHER);
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');
    bw.lock();
    expect(await store.checkSession!()).toBe('locked');
    await lockedError(() => store.get('github', 'token'));
  });

  it('LinkedStore passes the session through, and a linked read on a locked vault is vault_locked', async () => {
    const store = new LinkedStore(serving(), 'bitwarden', () => new Map([['github/token', 'bw://Work GitHub/password']]));
    expect(store.vaultState!()).toBe('locked');
    const err = await lockedError(() => store.get('github', 'token'));
    expect(err.fix).toBe(VAULT_UNLOCK_FIX);
    await lockedError(() => store.exists('github', 'token'));
    bw.state.sessions.add(SESSION);
    expect(await store.adoptSession!(SESSION)).toEqual({ ok: true });
    expect(store.vaultState!()).toBe('unlocked');
  });

  it('a store whose backend takes no session offers none of this', () => {
    const cached = new CachingStore(new MemoryStore(), 900);
    const linked = new LinkedStore(new MemoryStore(), 'keychain', () => new Map());
    for (const store of [cached, linked]) {
      expect(store.vaultState).toBeUndefined();
      expect(store.adoptSession).toBeUndefined();
      expect(store.checkSession).toBeUndefined();
      expect(store.forgetSession).toBeUndefined();
    }
  });
});
