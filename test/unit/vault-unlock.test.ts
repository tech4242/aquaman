/**
 * `aquaman unlock` and `aquaman lock` without a machine: what is asked of
 * whom, in which order, what is said and which exit code comes back. The
 * terminal, `bw` and the daemon are scripted.
 */

import { describe, it, expect } from 'vitest';
import { runUnlock, runLock, type UnlockDeps, type ProxyReply, type BwStatus } from '../../packages/proxy/src/vault-unlock.js';
import { VAULT_UNLOCK_PATH, VAULT_LOCK_PATH } from '../../packages/proxy/src/vault-session.js';
import { fakeSession } from '../helpers/fake-bw.js';

const SESSION = fakeSession('unlock-unit');
const SHELL_SESSION = fakeSession('already-in-the-shell');

interface World {
  deps: UnlockDeps;
  said: string[];
  posts: Array<{ path: string; body: Record<string, unknown> }>;
  order: string[];
}

function world(over: Partial<{
  backend: string;
  isTerminal: boolean;
  shellSession: string;
  installed: boolean;
  status: BwStatus | null;
  unlock: { code: number | null; stdout: string };
  health: { reachable: boolean; vault?: string };
  reply: (path: string, body: Record<string, unknown>) => ProxyReply;
}> = {}): World {
  const said: string[] = [];
  const posts: World['posts'] = [];
  const order: string[] = [];
  const deps: UnlockDeps = {
    backend: over.backend ?? 'bitwarden',
    isTerminal: over.isTerminal ?? true,
    shellSession: over.shellSession,
    bwInstalled: () => { order.push('bwInstalled'); return over.installed ?? true; },
    bwStatus: () => { order.push('bwStatus'); return over.status === undefined ? 'locked' : over.status; },
    bwUnlock: async () => { order.push('bwUnlock'); return over.unlock ?? { code: 0, stdout: `${SESSION}\n` }; },
    daemon: {
      health: async () => { order.push('health'); return over.health ?? { reachable: true, vault: 'locked' }; },
      post: async (path, body) => {
        order.push(`post ${path}`);
        posts.push({ path, body });
        return over.reply ? over.reply(path, body) : { status: 200, json: { status: path === VAULT_LOCK_PATH ? 'locked' : 'unlocked' } };
      },
    },
    say: (line) => said.push(line),
  };
  return { deps, said, posts, order };
}

describe('aquaman unlock', () => {
  it('asks bw for the session and hands it to the daemon in a request body; nothing it says contains the session', async () => {
    const w = world();
    expect(await runUnlock(w.deps)).toEqual({ status: 'unlocked', exitCode: 0 });
    expect(w.posts).toEqual([{ path: VAULT_UNLOCK_PATH, body: { session: SESSION } }]);
    expect(w.said.join('\n')).not.toContain(SESSION);
    expect(w.said.join('\n')).toContain('aquaman does not see it');
    expect(w.said.join('\n')).toContain('in memory');
  });

  it('the daemon is asked first: with none running nobody is asked for a password, and the exit code is 3', async () => {
    const w = world({ health: { reachable: false } });
    expect(await runUnlock(w.deps)).toEqual({ status: 'daemon_not_running', exitCode: 3 });
    expect(w.order).toEqual(['health']);
    expect(w.said.join('\n')).toContain('aquaman daemon');
    expect(w.said.join('\n')).toContain('aquaman service install');
  });

  it.each(['keychain', '1password', 'encrypted-file', 'keeper'])('with the %s backend it says so and exits 1 without touching anything', async (backend) => {
    const w = world({ backend });
    expect(await runUnlock(w.deps)).toEqual({ status: 'wrong_backend', exitCode: 1 });
    expect(w.order).toEqual([]);
    expect(w.said[0]).toContain(`The configured backend is ${backend}`);
  });

  it('a proxy that reports no vault state does not take a session: exit 1, nobody asked', async () => {
    const w = world({ health: { reachable: true } });
    expect(await runUnlock(w.deps)).toEqual({ status: 'unsupported', exitCode: 1 });
    expect(w.order).toEqual(['health']);
  });

  it('a daemon that is unlocked and whose session bw still accepts: nothing to do, exit 0, no terminal needed', async () => {
    const w = world({ health: { reachable: true, vault: 'unlocked' }, isTerminal: false });
    expect(await runUnlock(w.deps)).toEqual({ status: 'already_unlocked', exitCode: 0 });
    expect(w.posts).toEqual([{ path: VAULT_UNLOCK_PATH, body: { check: true } }]);
    expect(w.order).not.toContain('bwUnlock');
  });

  it('a daemon that says unlocked but whose session has ended is unlocked again', async () => {
    const w = world({
      health: { reachable: true, vault: 'unlocked' },
      reply: (_path, body) => ({ status: 200, json: { status: body['check'] ? 'locked' : 'unlocked' } }),
    });
    expect(await runUnlock(w.deps)).toEqual({ status: 'unlocked', exitCode: 0 });
    expect(w.posts.map((p) => p.body)).toEqual([{ check: true }, { session: SESSION }]);
  });

  it('without a terminal it fails with the fix and starts no bw', async () => {
    const w = world({ isTerminal: false });
    expect(await runUnlock(w.deps)).toEqual({ status: 'no_terminal', exitCode: 1 });
    expect(w.order).toEqual(['health']);
    expect(w.said.join('\n')).toContain('needs a terminal');
    expect(w.said.join('\n')).toContain('a person runs `aquaman unlock` in a terminal');
  });

  it('bw not installed: exit 1 with where to get it', async () => {
    const w = world({ installed: false });
    expect(await runUnlock(w.deps)).toEqual({ status: 'bw_not_found', exitCode: 1 });
    expect(w.said.join('\n')).toContain('https://bitwarden.com/help/cli/');
    expect(w.order).not.toContain('bwStatus');
  });

  it('bw not logged in: the person\'s step is bw login, and no password is asked for', async () => {
    const w = world({ status: 'unauthenticated' });
    expect(await runUnlock(w.deps)).toEqual({ status: 'not_logged_in', exitCode: 1 });
    expect(w.said.join('\n')).toContain('bw login');
    expect(w.order).not.toContain('bwUnlock');
  });

  it('a bw whose status cannot be read: exit 1', async () => {
    const w = world({ status: null });
    expect(await runUnlock(w.deps)).toEqual({ status: 'bw_failed', exitCode: 1 });
    expect(w.posts).toEqual([]);
  });

  it('a shell that already holds a session bw accepts hands that one over and does not ask for the password again', async () => {
    const w = world({ shellSession: SHELL_SESSION, status: 'unlocked' });
    expect(await runUnlock(w.deps)).toEqual({ status: 'unlocked', exitCode: 0 });
    expect(w.order).not.toContain('bwUnlock');
    expect(w.posts).toEqual([{ path: VAULT_UNLOCK_PATH, body: { session: SHELL_SESSION } }]);
    expect(w.said.join('\n')).not.toContain(SHELL_SESSION);
  });

  it('a shell session bw no longer accepts is not handed over: bw asks again', async () => {
    const w = world({ shellSession: SHELL_SESSION, status: 'locked' });
    await runUnlock(w.deps);
    expect(w.order).toContain('bwUnlock');
    expect(w.posts).toEqual([{ path: VAULT_UNLOCK_PATH, body: { session: SESSION } }]);
  });

  it.each([
    ['a wrong master password', { code: 1, stdout: '' }],
    ['a bw that could not be started', { code: null, stdout: '' }],
    ['a bw that exits 0 and prints nothing', { code: 0, stdout: '' }],
    ['a bw that prints something that is not a session', { code: 0, stdout: 'Your vault is now unlocked!\n\nTo unlock your vault, set your session key...' }],
    ['a bw that prints a session and fails', { code: 1, stdout: SESSION }],
  ])('%s: exit 2, nothing is sent to the daemon, and what bw printed is not repeated', async (_name, unlock) => {
    const w = world({ unlock });
    expect(await runUnlock(w.deps)).toEqual({ status: 'bw_unlock_failed', exitCode: 2 });
    expect(w.posts).toEqual([]);
    expect(w.said.join('\n')).not.toContain('session key');
    expect(w.said.join('\n')).not.toContain(SESSION);
  });

  it('a daemon that refuses the session: exit 4 with its fix', async () => {
    const w = world({ reply: () => ({ status: 403, json: { error: 'The Bitwarden CLI does not open the vault with that session', fix: 'Run: aquaman unlock', code: 'session_refused' } }) });
    expect(await runUnlock(w.deps)).toEqual({ status: 'refused', exitCode: 4 });
    expect(w.said.join('\n')).toContain('does not open the vault');
    expect(w.said.join('\n')).toContain('Fix: Run: aquaman unlock');
  });

  it('a daemon that echoes the session back does not get it onto the screen', async () => {
    const w = world({ reply: (_p, body) => ({ status: 500, json: { error: `cannot use ${String(body['session'])}`, fix: `retry with ${String(body['session'])}` } }) });
    expect((await runUnlock(w.deps)).exitCode).toBe(4);
    expect(w.said.join('\n')).not.toContain(SESSION);
    expect(w.said.join('\n')).toContain('[session]');
  });

  it('a daemon that went away after the password was typed: exit 3, and the session is not shown or kept', async () => {
    const w = world({ reply: () => ({ error: 'Cannot reach the aquaman proxy', code: 'proxy_unreachable' }) });
    expect(await runUnlock(w.deps)).toEqual({ status: 'daemon_not_running', exitCode: 3 });
    expect(w.said.join('\n')).not.toContain(SESSION);
  });

  it('a socket error that is not "nobody there": exit 4', async () => {
    const w = world({ reply: () => ({ error: 'timed out waiting for the proxy', code: 'proxy_error' }) });
    expect(await runUnlock(w.deps)).toEqual({ status: 'refused', exitCode: 4 });
  });
});

describe('aquaman lock', () => {
  it('asks the daemon to drop its session, and says what that does and does not do to bw', async () => {
    const w = world();
    expect(await runLock(w.deps)).toEqual({ status: 'locked', exitCode: 0 });
    expect(w.posts).toEqual([{ path: VAULT_LOCK_PATH, body: {} }]);
    expect(w.order).toEqual([`post ${VAULT_LOCK_PATH}`]);
    expect(w.said.join('\n')).toContain('dropped its session');
    expect(w.said.join('\n')).toContain('bw lock');
  });

  it('with another backend: exit 1', async () => {
    const w = world({ backend: 'keychain' });
    expect(await runLock(w.deps)).toEqual({ status: 'wrong_backend', exitCode: 1 });
    expect(w.posts).toEqual([]);
  });

  it('with no daemon there is no session to drop: exit 3', async () => {
    const w = world({ reply: () => ({ error: 'Cannot reach the aquaman proxy', code: 'proxy_unreachable' }) });
    expect(await runLock(w.deps)).toEqual({ status: 'daemon_not_running', exitCode: 3 });
  });

  it('a proxy that takes no session: exit 1; any other refusal: exit 4', async () => {
    const unsupported = world({ reply: () => ({ status: 404, json: { error: 'not opened by a session', fix: 'aquaman status', code: 'vault_session_unsupported' } }) });
    expect(await runLock(unsupported.deps)).toEqual({ status: 'unsupported', exitCode: 1 });
    const other = world({ reply: () => ({ status: 500, json: {} }) });
    expect(await runLock(other.deps)).toEqual({ status: 'refused', exitCode: 4 });
    const broken = world({ reply: () => ({ error: 'socket hang up', code: 'proxy_error' }) });
    expect(await runLock(broken.deps)).toEqual({ status: 'refused', exitCode: 4 });
  });
});
