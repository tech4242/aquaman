/**
 * The Bitwarden session and the cache in front of it, with the stand-in `bw`
 * from test/helpers/fake-bw.ts: a vault the store knows to be locked serves
 * nothing from the cache, whichever call found out, and a session is adopted
 * only for the account the proxy started with.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const cp = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => cp);

import { BitwardenStore } from '../../packages/proxy/src/core/credentials/backends/bitwarden.js';
import { isVaultLocked } from '../../packages/proxy/src/core/credentials/vault-lock.js';
import { CachingStore } from '../../packages/proxy/src/core/credentials/caching-store.js';
import { createFakeBw, fakeSession, type FakeBw } from '../helpers/fake-bw.js';

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
afterEach(() => { delete process.env['BW_SESSION']; });

describe('bitwarden session: the cache and the account', () => {
  it('once the store knows the vault is locked (found by exists()), a cached value is not served', async () => {
    const inner = new BitwardenStore({ serving: true });
    const store = new CachingStore(inner, 900);
    bw.state.sessions.add(SESSION);
    expect((await store.adoptSession!(SESSION)).ok).toBe(true);
    expect(await store.get('github', 'token')).toBe('ghp_fake_value');

    bw.lock(); // `bw lock` somewhere else
    let thrown: unknown;
    try { await store.exists('slack', 'bot_token'); } catch (err) { thrown = err; }
    expect(isVaultLocked(thrown)).toBe(true);
    // The process now reports itself locked (what /_health and `aquaman status` show)...
    expect(store.vaultState!()).toBe('locked');
    // ...and does not serve what it read while the vault was open.
    let second: unknown;
    try { await store.get('github', 'token'); } catch (err) { second = err; }
    expect(isVaultLocked(second)).toBe(true);
  });

  it('a session is refused for a pinned account when `bw status` names no account', async () => {
    const store = new BitwardenStore({ serving: true }); // pins user-1
    bw.state.userId = ''; // a bw that answers { status: "unlocked", userId: "" }
    bw.state.sessions.add(OTHER);
    const result = await store.adoptSession(OTHER);
    expect(result).toMatchObject({ ok: false, code: 'account_changed' });
  });
});
