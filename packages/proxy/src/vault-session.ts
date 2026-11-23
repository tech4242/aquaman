/**
 * `POST /_vault/unlock` and `POST /_vault/lock`: how a running proxy is given,
 * and gives up, the session that opens a vault only a person can unlock
 * (the `bitwarden` backend; see core/credentials/vault-lock.ts).
 *
 * `aquaman unlock` lets Bitwarden's own CLI ask for the master password in
 * the person's terminal and posts the session that comes out of it here. The
 * proxy keeps it in memory. Nothing is written to disk, to the OS keychain or
 * into a login item, and the proxy never sees the master password.
 *
 * Rules for the endpoint:
 *
 * - Unix socket only. The loopback listener is reachable by every local
 *   user, and neither of its tokens is a reason to accept a vault session.
 * - The session is checked against the vault's CLI before it replaces
 *   anything, so a refused session leaves a working proxy working.
 * - The session is never logged, never returned and never part of an error:
 *   every reply is built from fixed text.
 * - Refused sessions are counted. Each one starts the vault's CLI, so a
 *   caller that keeps sending them is told to wait.
 * - Every change of state and every session the CLI refused is audited,
 *   without the value.
 *
 * What it is not: a boundary against software running as the same user.
 * Such software can call this endpoint, and all it gains is what it had: a
 * session it already holds makes the proxy read the vault that session
 * opens, for the account the vault's CLI is logged in to, and anything else
 * is refused. It can also lock the proxy, which costs the person an
 * `aquaman unlock` and nothing else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CredentialStore } from './core/credentials/store.js';
import { VAULT_UNLOCK_FIX } from './core/credentials/vault-lock.js';

/** Both start with `/_`, which no service name can, and which the route token is refused on. */
export const VAULT_UNLOCK_PATH = '/_vault/unlock';
export const VAULT_LOCK_PATH = '/_vault/lock';

/** Refused sessions allowed per window before the endpoint says to wait. */
export const UNLOCK_MAX_REFUSALS = 5;
export const UNLOCK_REFUSAL_WINDOW_MS = 60_000;

const BODY_MAX = 2048;

export interface VaultSessionContext {
  fromLoopback: boolean;
  store: CredentialStore;
  /** When sessions were refused; owned by the proxy so it outlives one request. */
  refusals: number[];
  /** Record a change of state or a refusal; `error` is absent for a success. */
  audit(error?: string): void;
  /** Told once the vault is open, so work that waited for it can go on. */
  onUnlocked?(): void;
}

const NOT_A_SESSION_BACKEND = {
  error: 'The credential backend of this proxy is not opened by a session',
  fix: 'aquaman unlock and aquaman lock are for the bitwarden backend. Run: aquaman status',
  code: 'vault_session_unsupported',
};

function replier(res: ServerResponse): (statusCode: number, body: Record<string, unknown>) => void {
  res.setHeader('Content-Type', 'application/json');
  return (statusCode, body) => {
    res.statusCode = statusCode;
    res.end(JSON.stringify(body));
  };
}

const STATUS_BY_CODE: Record<string, number> = {
  session_malformed: 400,
  session_refused: 403,
  account_changed: 403,
  not_logged_in: 409,
  vault_cli_failed: 502,
};

/**
 *   200 { status: "unlocked" }            the session was accepted, or (`check`) the one held still works
 *   200 { status: "locked" }              `check` only: the proxy holds no session the vault accepts
 *   400/403/409/502 { code, error, fix }  the session was not adopted; the proxy is as it was
 *   429 { code: "unlock_rate_limited" }   too many refused sessions; `bw` was not run
 *   404 { code }                          not the Unix socket, or a backend that takes no session
 */
export async function handleVaultUnlock(req: IncomingMessage, res: ServerResponse, ctx: VaultSessionContext): Promise<void> {
  const reply = replier(res);
  // Before the body is read: a session sent to the wrong listener is not even looked at.
  if (ctx.fromLoopback) {
    req.resume();
    reply(404, {
      error: 'A vault session is only accepted over the Unix socket',
      fix: 'Run in a terminal on the machine itself: aquaman unlock',
      code: 'vault_unlock_socket_only',
    });
    return;
  }
  const { store } = ctx;
  if (!store.adoptSession || !store.checkSession || !store.vaultState) {
    req.resume();
    reply(404, NOT_A_SESSION_BACKEND);
    return;
  }

  let bodyBuf = '';
  for await (const chunk of req) {
    bodyBuf += (chunk as Buffer).toString('utf-8');
    if (bodyBuf.length > BODY_MAX) {
      reply(400, { error: 'Request body too large', fix: VAULT_UNLOCK_FIX });
      return;
    }
  }
  let body: { session?: unknown; check?: unknown } | null;
  try {
    body = JSON.parse(bodyBuf);
  } catch {
    body = null;
  }
  if (body === null || typeof body !== 'object') {
    reply(400, { error: 'Expected { session } or { check: true }', fix: VAULT_UNLOCK_FIX });
    return;
  }

  if (body.session === undefined && body.check === true) {
    const before = store.vaultState();
    let state: 'locked' | 'unlocked';
    try {
      state = await store.checkSession();
    } catch {
      reply(502, { error: 'The vault CLI could not be asked about the session', fix: 'Check that `bw status` works in a terminal. Run: aquaman doctor', code: 'vault_cli_failed' });
      return;
    }
    if (before === 'unlocked' && state === 'locked') ctx.audit('vault locked: the vault no longer accepts the session');
    reply(200, { status: state });
    return;
  }

  if (typeof body.session !== 'string') {
    reply(400, { error: 'Expected { session } or { check: true }', fix: VAULT_UNLOCK_FIX });
    return;
  }

  const now = Date.now();
  while (ctx.refusals.length > 0 && now - ctx.refusals[0] >= UNLOCK_REFUSAL_WINDOW_MS) ctx.refusals.shift();
  if (ctx.refusals.length >= UNLOCK_MAX_REFUSALS) {
    // Not audited: the refusals that led here are on record, and a caller
    // that keeps asking must not be able to fill the log.
    reply(429, {
      error: 'Too many sessions were refused in a short time',
      fix: 'Wait a minute, then run: aquaman unlock',
      code: 'unlock_rate_limited',
    });
    return;
  }

  const result = await store.adoptSession(body.session);
  if (!result.ok) {
    // A value that is not even the shape of a session never reached the CLI:
    // it is not counted, and like other malformed requests it is not audited.
    if (result.code !== 'session_malformed') {
      ctx.refusals.push(now);
      ctx.audit(`unlock refused: ${result.code}`);
    }
    reply(STATUS_BY_CODE[result.code] ?? 403, { error: result.error, fix: result.fix, code: result.code });
    return;
  }
  ctx.audit();
  ctx.onUnlocked?.();
  reply(200, { status: 'unlocked' });
}

/**
 *   200 { status: "locked" }  the proxy holds no session and no cached values now
 *   404 { code }              not the Unix socket, or a backend that takes no session
 */
export async function handleVaultLock(req: IncomingMessage, res: ServerResponse, ctx: VaultSessionContext): Promise<void> {
  const reply = replier(res);
  req.resume();
  if (ctx.fromLoopback) {
    reply(404, {
      error: 'The vault is only locked over the Unix socket',
      fix: 'Run on the machine itself: aquaman lock',
      code: 'vault_lock_socket_only',
    });
    return;
  }
  const { store } = ctx;
  if (!store.forgetSession || !store.vaultState) {
    reply(404, NOT_A_SESSION_BACKEND);
    return;
  }
  const was = store.vaultState();
  store.forgetSession();
  if (was === 'unlocked') ctx.audit();
  reply(200, { status: 'locked' });
}
