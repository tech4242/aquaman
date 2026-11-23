/**
 * A vault that is locked, as a state a serving process can be in.
 *
 * Some backends are opened by a session that only a person can produce
 * (Bitwarden: the master password, typed into `bw`). A daemon started at
 * login has no such session, and a session it holds can be ended from
 * outside (`bw lock`, `bw logout`, a later `bw unlock`). Neither is a reason
 * to stop serving: every read that needs the vault fails with
 * `VaultLockedError`, which carries the machine-readable code and the command
 * a person runs, and everything that does not need the vault keeps working.
 */

export const VAULT_LOCKED_CODE = 'vault_locked';
/** What a person runs to open the vault of a running daemon. */
export const VAULT_UNLOCK_FIX = 'Run: aquaman unlock';

export class VaultLockedError extends Error {
  readonly code = VAULT_LOCKED_CODE;

  constructor(message: string, readonly fix: string = VAULT_UNLOCK_FIX) {
    super(message);
    this.name = 'VaultLockedError';
  }
}

/** True for a `VaultLockedError`, also one that crossed a module boundary. */
export function isVaultLocked(err: unknown): err is Error & { code: typeof VAULT_LOCKED_CODE; fix?: string } {
  return err instanceof Error && (err as { code?: unknown }).code === VAULT_LOCKED_CODE;
}

export type VaultState = 'locked' | 'unlocked';

/**
 * What a store answers when it is handed a session. A refusal never repeats
 * the session or anything the vault's CLI printed.
 */
export type SessionAdoption =
  | { ok: true }
  | {
      ok: false;
      /**
       * `session_malformed`: not the shape of a session, so the CLI was not run.
       * `session_refused`: the CLI does not open the vault with it.
       * `not_logged_in`: the CLI is not logged in to any account.
       * `account_changed`: the CLI is logged in to another account than the one this process started with.
       * `vault_cli_failed`: the CLI could not be run or its answer could not be read.
       */
      code: 'session_malformed' | 'session_refused' | 'not_logged_in' | 'account_changed' | 'vault_cli_failed';
      error: string;
      fix: string;
    };
