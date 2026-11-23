/**
 * Stand-ins for the Bitwarden CLI. The real `bw` is never run by a test: it
 * may be signed in to a real account on the machine.
 *
 * `createFakeBw()` answers `spawnSync` for an in-process `BitwardenStore`
 * (the test file mocks `node:child_process` and hands every call to
 * `fake.spawnSync`). `FAKE_BW_SCRIPT` is the same model as a `#!/bin/sh`
 * body for a private PATH, for tests that start the CLI as a process.
 *
 * The model follows what Bitwarden documents and what its CLI source does:
 * `bw status` prints `{ status, userId }` with `unauthenticated`, `locked` or
 * `unlocked`; the vault is open only under a `BW_SESSION` the CLI accepts; a
 * command that needs the vault without one prints "Vault is locked." and
 * exits 1 when `BW_NOINTERACTION` is set; `bw lock` and a later `bw unlock`
 * end earlier session keys.
 */

export interface FakeBwCall {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
  input?: string;
}

export interface FakeBw {
  /** Every `bw` and `which` call, with its arguments and environment. */
  calls: FakeBwCall[];
  /** Calls of `bw` only. */
  bwCalls(...prefix: string[]): FakeBwCall[];
  state: {
    installed: boolean;
    loggedIn: boolean;
    userId: string;
    /** Sessions the CLI accepts right now. */
    sessions: Set<string>;
    /** Item name to password. */
    items: Map<string, string>;
  };
  /** What `bw lock` does: every session key stops working. */
  lock(): void;
  spawnSync(cmd: string, args?: string[], opts?: { env?: Record<string, string | undefined>; input?: string }): {
    status: number; stdout: string; stderr: string; signal: null; pid: number; output: unknown[];
  };
}

/** Shaped like what `bw unlock --raw` prints: base64 of 64 bytes. */
export function fakeSession(seed: string): string {
  return Buffer.from(seed.padEnd(64, '.').slice(0, 64)).toString('base64');
}

export function createFakeBw(): FakeBw {
  const calls: FakeBwCall[] = [];
  const state: FakeBw['state'] = {
    installed: true,
    loggedIn: true,
    userId: 'user-1',
    sessions: new Set<string>(),
    items: new Map<string, string>(),
  };
  const reply = (status: number, stdout = '', stderr = '') => ({ status, stdout, stderr, signal: null, pid: 1, output: [] });
  let nextId = 1;
  const ids = new Map<string, string>();
  const idOf = (name: string): string => {
    if (!ids.has(name)) ids.set(name, `item-${nextId++}`);
    return ids.get(name)!;
  };

  return {
    calls,
    state,
    bwCalls: (...prefix) => calls.filter((c) => c.cmd === 'bw' && prefix.every((p, i) => c.args[i] === p)),
    lock: () => state.sessions.clear(),
    spawnSync(cmd, args = [], opts = {}) {
      const env = opts.env ?? (process.env as Record<string, string | undefined>);
      calls.push({ cmd, args, env: { ...env }, input: opts.input });
      if (cmd === 'which') return state.installed ? reply(0, '/usr/local/bin/bw\n') : reply(1);
      if (cmd !== 'bw') return reply(127, '', `${cmd}: not found`);
      const session = env['BW_SESSION'];
      const open = state.loggedIn && session !== undefined && state.sessions.has(session);
      if (args[0] === 'status') {
        if (!state.loggedIn) return reply(0, JSON.stringify({ status: 'unauthenticated', userId: null }));
        return reply(0, JSON.stringify({ status: open ? 'unlocked' : 'locked', userId: state.userId }));
      }
      if (!state.loggedIn) return reply(1, '', 'You are not logged in.');
      if (!open) return reply(1, '', 'Vault is locked.');
      if (args[0] === 'sync') return reply(0, 'Syncing complete.');
      if (args[0] === 'list' && args[1] === 'folders') return reply(0, JSON.stringify([{ id: 'folder-1', name: 'aquaman' }]));
      if (args[0] === 'list' && args[1] === 'items') {
        const search = args[2] === '--search' ? args[3] : undefined;
        const found = [...state.items.keys()]
          .filter((name) => search === undefined || name.includes(search))
          .map((name) => ({ id: idOf(name), name, folderId: 'folder-1' }));
        return reply(0, JSON.stringify(found));
      }
      if (args[0] === 'get' && args[1] === 'item') {
        const name = [...state.items.keys()].find((n) => idOf(n) === args[2]);
        if (name === undefined) return reply(1, '', 'Not found.');
        return reply(0, JSON.stringify({ id: args[2], name, login: { password: state.items.get(name) } }));
      }
      if (args[0] === 'create' && args[1] === 'item') {
        const item = JSON.parse(Buffer.from(opts.input ?? '', 'base64').toString('utf-8')) as { name: string; login: { password: string } };
        state.items.set(item.name, item.login.password);
        return reply(0, JSON.stringify({ id: idOf(item.name) }));
      }
      if (args[0] === 'edit' && args[1] === 'item') {
        const item = JSON.parse(Buffer.from(opts.input ?? '', 'base64').toString('utf-8')) as { name: string; login: { password: string } };
        state.items.set(item.name, item.login.password);
        return reply(0, JSON.stringify({ id: args[2] }));
      }
      if (args[0] === 'delete' && args[1] === 'item') {
        const name = [...state.items.keys()].find((n) => idOf(n) === args[2]);
        if (name === undefined) return reply(1, '', 'Not found.');
        state.items.delete(name);
        return reply(0);
      }
      return reply(1, '', `fake bw: unsupported command ${args.join(' ')}`);
    },
  };
}

/**
 * The same model as a shell script, built from sh builtins only (the private
 * PATH of a CLI test holds `node` and `which` and nothing else).
 *
 * State lives in `$FAKE_BW_DIR`:
 *   loggedin   exists while the CLI is logged in
 *   session    the one session key the CLI accepts (absent: locked)
 *   calls      one line per invocation: its arguments
 * `$FAKE_BW_MASTER` is the master password and `$FAKE_BW_NEW_SESSION` the
 * key the next successful `unlock` prints. One item exists:
 * `aquaman::github::token` with the password `$FAKE_BW_ITEM_VALUE`.
 */
export const FAKE_BW_SCRIPT = [
  'echo "$*" >> "$FAKE_BW_DIR/calls"',
  'accepted=""',
  'if [ -f "$FAKE_BW_DIR/session" ]; then read -r accepted < "$FAKE_BW_DIR/session"; fi',
  'open=no',
  'if [ -f "$FAKE_BW_DIR/loggedin" ] && [ -n "$BW_SESSION" ] && [ "$BW_SESSION" = "$accepted" ]; then open=yes; fi',
  'case "$1" in',
  '  status)',
  '    if [ ! -f "$FAKE_BW_DIR/loggedin" ]; then echo \'{"status":"unauthenticated","userId":null}\'; exit 0; fi',
  '    if [ "$open" = yes ]; then echo \'{"status":"unlocked","userId":"user-1"}\'; else echo \'{"status":"locked","userId":"user-1"}\'; fi',
  '    exit 0 ;;',
  '  unlock)',
  '    if [ ! -f "$FAKE_BW_DIR/loggedin" ]; then echo "You are not logged in." >&2; exit 1; fi',
  '    if [ "$BW_NOINTERACTION" = true ]; then echo "Master password is required." >&2; exit 1; fi',
  '    printf "? Master password: [input is hidden] " >&2',
  '    read -r typed',
  '    echo "" >&2',
  '    if [ "$typed" != "$FAKE_BW_MASTER" ]; then echo "Invalid master password." >&2; exit 1; fi',
  // A new unlock replaces the accepted key, as the real CLI ends earlier ones.
  '    echo "$FAKE_BW_NEW_SESSION" > "$FAKE_BW_DIR/session"',
  '    printf "%s" "$FAKE_BW_NEW_SESSION"',
  '    exit 0 ;;',
  '  lock)',
  '    echo "" > "$FAKE_BW_DIR/session"',
  '    echo "Your vault is locked."',
  '    exit 0 ;;',
  'esac',
  'if [ ! -f "$FAKE_BW_DIR/loggedin" ]; then echo "You are not logged in." >&2; exit 1; fi',
  'if [ "$open" != yes ]; then echo "Vault is locked." >&2; exit 1; fi',
  'case "$1 $2" in',
  '  "list folders") echo \'[{"id":"folder-1","name":"aquaman"}]\' ;;',
  '  "list items") echo \'[{"id":"item-1","name":"aquaman::github::token","folderId":"folder-1"}]\' ;;',
  '  "get item") echo "{\\"id\\":\\"item-1\\",\\"name\\":\\"aquaman::github::token\\",\\"login\\":{\\"password\\":\\"$FAKE_BW_ITEM_VALUE\\"}}" ;;',
  '  "sync ") echo "Syncing complete." ;;',
  '  *) echo "fake bw: unsupported command $*" >&2; exit 1 ;;',
  'esac',
].join('\n');
