/**
 * `aquaman unlock` and `aquaman lock`, without the machine: what is asked of
 * whom, in which order, and what is said. cli/unlock.ts connects this to the
 * real terminal, the real `bw` and the daemon's socket.
 *
 * `aquaman unlock` is for a person at a terminal, after logging in to the
 * machine. Bitwarden's own CLI asks for the master password (`bw unlock
 * --raw`, attached to the terminal), so aquaman never sees it. aquaman takes
 * the session `bw` prints and posts it to the running daemon, which keeps it
 * in memory (vault-session.ts).
 *
 * The session is handled like a credential value:
 * - it is read from `bw`'s stdout through a pipe, never shown;
 * - it travels to the daemon in a request body on the Unix socket, never in
 *   a command's arguments, where `ps` would show it;
 * - it is written nowhere, and every line printed here is fixed text or the
 *   daemon's reply with the session cut out of it.
 *
 * Nothing is asked of the person until there is a daemon to hand the session
 * to: a session with nowhere to go would have to be printed or stored, and
 * neither is done.
 */

import { VAULT_LOCK_PATH, VAULT_UNLOCK_PATH } from './vault-session.js';

export type BwStatus = 'unauthenticated' | 'locked' | 'unlocked';

export type ProxyReply = { status: number; json: any } | { error: string; code: string };

export interface UnlockDeps {
  /** The backend in effect for this command. */
  backend: string;
  /** A person can be asked here: stdin and stderr are a terminal. */
  isTerminal: boolean;
  /** The session this shell already holds (`BW_SESSION`), if any. */
  shellSession: string | undefined;
  /** Whether a `bw` executable is on the PATH. */
  bwInstalled(): boolean;
  /** `bw status` under the given session; null when it could not be run or read. */
  bwStatus(session: string | undefined): BwStatus | null;
  /**
   * `bw unlock --raw` with the terminal attached, so `bw` itself asks for
   * the master password. `stdout` is what it printed there: the session.
   */
  bwUnlock(): Promise<{ code: number | null; stdout: string }>;
  daemon: {
    /** What the proxy on the socket says about itself; `vault` only from one whose backend takes a session. */
    health(): Promise<{ reachable: boolean; vault?: string }>;
    post(urlPath: string, body: Record<string, unknown>): Promise<ProxyReply>;
  };
  /** A line for the person (stderr). Never given the session. */
  say(line: string): void;
}

export interface UnlockOutcome {
  /**
   * `unlocked`, `already_unlocked`, `locked` (after `aquaman lock`): exit 0.
   * `wrong_backend`, `no_terminal`, `bw_not_found`, `bw_failed`, `not_logged_in`, `unsupported`: exit 1.
   * `bw_unlock_failed`: exit 2. `daemon_not_running`: exit 3. `refused`: exit 4.
   */
  status: string;
  exitCode: number;
}

const START_DAEMON =
  'Start it first: `aquaman daemon` in a terminal of your own, or `aquaman service install` to have it start at login. Then run: aquaman unlock';

/** A session key is base64 text; anything else `bw` printed is not passed on. */
const SESSION_SHAPE = /^[A-Za-z0-9+/]{16,512}={0,2}$/;

function wrongBackend(deps: Pick<UnlockDeps, 'backend' | 'say'>, command: string): UnlockOutcome {
  deps.say(`aquaman ${command} is for the bitwarden backend. The configured backend is ${deps.backend}, which is not opened by a session.`);
  deps.say('Fix: nothing to do for this backend. To see what is configured, run: aquaman status');
  return { status: 'wrong_backend', exitCode: 1 };
}

export async function runUnlock(deps: UnlockDeps): Promise<UnlockOutcome> {
  const { say } = deps;
  if (deps.backend !== 'bitwarden') return wrongBackend(deps, 'unlock');

  const health = await deps.daemon.health();
  if (!health.reachable) {
    say('The aquaman daemon is not running, so there is nothing to hand a session to.');
    say(`Fix: ${START_DAEMON}`);
    return { status: 'daemon_not_running', exitCode: 3 };
  }
  if (health.vault === undefined) {
    say('The proxy on the socket does not take a session: it was started with another backend, or by a version without `aquaman unlock`.');
    say('Fix: stop it (aquaman stop, or stop what started it) and start it again, then run: aquaman unlock');
    return { status: 'unsupported', exitCode: 1 };
  }

  if (health.vault === 'unlocked') {
    // The daemon answers health from memory. Ask it to check its session
    // against `bw`, so "already unlocked" is true at this moment.
    const checked = await deps.daemon.post(VAULT_UNLOCK_PATH, { check: true });
    if (!('error' in checked) && checked.status === 200 && checked.json?.status === 'unlocked') {
      say('The daemon\'s vault is already unlocked. Nothing to do.');
      return { status: 'already_unlocked', exitCode: 0 };
    }
  }

  if (!deps.isTerminal) {
    say('aquaman unlock needs a terminal: Bitwarden asks for the master password there, and only a person has it.');
    say('Fix: a person runs `aquaman unlock` in a terminal window on this machine.');
    return { status: 'no_terminal', exitCode: 1 };
  }
  if (!deps.bwInstalled()) {
    say('The Bitwarden CLI (bw) was not found on the PATH.');
    say('Fix: install it (https://bitwarden.com/help/cli/), run `bw login`, then: aquaman unlock');
    return { status: 'bw_not_found', exitCode: 1 };
  }

  const status = deps.bwStatus(deps.shellSession);
  if (status === null) {
    say('`bw status` could not be run or did not answer with a status.');
    say('Fix: check that `bw status` works in this terminal, then run: aquaman unlock');
    return { status: 'bw_failed', exitCode: 1 };
  }
  if (status === 'unauthenticated') {
    say('The Bitwarden CLI is not logged in.');
    say('Fix: run `bw login`, then: aquaman unlock');
    return { status: 'not_logged_in', exitCode: 1 };
  }

  let session: string;
  if (status === 'unlocked' && deps.shellSession) {
    // This shell already holds a session `bw` accepts. Asking for the master
    // password again would also end that session, so it is the one handed over.
    say('Bitwarden is already unlocked in this shell; handing that session to the daemon.');
    session = deps.shellSession;
  } else {
    say('Bitwarden will ask for your master password. aquaman does not see it.');
    const unlocked = await deps.bwUnlock();
    session = unlocked.stdout.trim();
    if (unlocked.code !== 0 || !SESSION_SHAPE.test(session)) {
      say('Bitwarden did not unlock the vault, so the daemon stays locked.');
      say('Fix: run `aquaman unlock` again. If `bw unlock` fails on its own too, the problem is with the Bitwarden CLI.');
      return { status: 'bw_unlock_failed', exitCode: 2 };
    }
  }

  // Whatever the daemon answers is printed with the session cut out of it.
  const clean = (text: unknown): string => String(text ?? '').split(session).join('[session]');
  const reply = await deps.daemon.post(VAULT_UNLOCK_PATH, { session });
  if ('error' in reply) {
    if (reply.code === 'proxy_unreachable') {
      say('The aquaman daemon stopped before it took the session. The session was not stored anywhere.');
      say(`Fix: ${START_DAEMON}`);
      return { status: 'daemon_not_running', exitCode: 3 };
    }
    say(`The daemon did not take the session: ${clean(reply.error)}`);
    return { status: 'refused', exitCode: 4 };
  }
  if (reply.status === 200 && reply.json?.status === 'unlocked') {
    say('Unlocked. The daemon keeps the session in memory, and nowhere else, until it stops,');
    say('until `aquaman lock`, or until Bitwarden ends the session (`bw lock`, `bw logout`, another `bw unlock`).');
    return { status: 'unlocked', exitCode: 0 };
  }
  say(`The daemon did not take the session: ${clean(reply.json?.error ?? `HTTP ${reply.status}`)}`);
  if (reply.json?.fix) say(`Fix: ${clean(reply.json.fix)}`);
  return { status: 'refused', exitCode: 4 };
}

export type LockDeps = Pick<UnlockDeps, 'backend' | 'daemon' | 'say'>;

/**
 * `aquaman lock`: the daemon drops its session and every value it cached.
 * `bw` is not run, so the session key itself stays valid for anything else
 * that holds a copy; the person is told how to end it everywhere.
 */
export async function runLock(deps: LockDeps): Promise<UnlockOutcome> {
  const { say } = deps;
  if (deps.backend !== 'bitwarden') return wrongBackend(deps, 'lock');
  const reply = await deps.daemon.post(VAULT_LOCK_PATH, {});
  if ('error' in reply) {
    if (reply.code === 'proxy_unreachable') {
      say('The aquaman daemon is not running, so it holds no session.');
      return { status: 'daemon_not_running', exitCode: 3 };
    }
    say(`The daemon did not answer: ${reply.error}`);
    return { status: 'refused', exitCode: 4 };
  }
  if (reply.status === 200 && reply.json?.status === 'locked') {
    say('Locked. The daemon has dropped its session and the credential values it had cached.');
    say('The session key itself is still valid for anything else that holds a copy. To end it everywhere, run: bw lock');
    return { status: 'locked', exitCode: 0 };
  }
  say(`The daemon did not lock: ${String(reply.json?.error ?? `HTTP ${reply.status}`)}`);
  if (reply.json?.fix) say(`Fix: ${String(reply.json.fix)}`);
  return { status: reply.json?.code === 'vault_session_unsupported' ? 'unsupported' : 'refused', exitCode: reply.json?.code === 'vault_session_unsupported' ? 1 : 4 };
}
