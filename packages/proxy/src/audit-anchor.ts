/**
 * The audit log's anchor.
 *
 * The log's hash chain is unkeyed and lives in one directory, so the chain
 * alone cannot show that the end of the log was cut off, that the log was
 * emptied or deleted, or that it was rebuilt from scratch: each of those
 * leaves a chain that is valid on its own terms. The anchor is a small record
 * of where the log ended, `{ v, seq, hash, at }`, kept in the credential
 * store under a reserved service name. `aquaman audit verify` compares the
 * two: the log must reach the anchored sequence and hold the anchored hash
 * there.
 *
 * The process that writes the log writes the anchor: at most once per
 * interval while entries arrive, never while idle, and once more on graceful
 * shutdown. An anchor only moves forward. The one way back is
 * `aquaman audit accept`, which a person confirms at a terminal.
 *
 * What the anchor does not cover: entries written after the last anchor (up
 * to one interval's worth), and software that can write to the credential
 * store, which can move the anchor as well as the log.
 */

import type { AuditLogger, ChainVerification } from './core/audit/logger.js';
import type { CredentialStore } from './core/credentials/store.js';
import { RESERVED_SERVICE } from './broker-scope.js';

/** The anchor's key under `RESERVED_SERVICE`. */
export const AUDIT_ANCHOR_KEY = 'audit_anchor';
export const DEFAULT_ANCHOR_INTERVAL_SECONDS = 60;

export interface AuditAnchor {
  v: 1;
  /** Sequence of the anchored entry. */
  seq: number;
  /** Hash of the anchored entry. */
  hash: string;
  /** When the anchor was written, ISO 8601. */
  at: string;
}

/** The stored value is there but is not an anchor. */
export class AuditAnchorFormatError extends Error {}

const FIX_ACCEPT =
  'If you did not change the log, treat the missing entries as removed and find out what did it. ' +
  'If the change was intended (a backup restored, a log deleted on purpose), stop the proxy and run: aquaman audit accept';

/**
 * Backends where each write starts a vendor CLI, which can ask the person to
 * unlock the vault. An anchor a minute would be a prompt a minute.
 */
const PROMPTING_BACKENDS: readonly string[] = ['1password', 'bitwarden', 'keeper'];
export const PROMPTING_BACKEND_ANCHOR_INTERVAL_SECONDS = 900;

/**
 * Seconds between anchor writes: `audit.anchorIntervalSeconds` when set.
 * Unset, 60, or 900 for a backend whose writes can prompt. `0` (or anything
 * below) is off. A value that is not a number is ignored.
 */
export function resolveAnchorInterval(config: { audit?: { anchorIntervalSeconds?: unknown }; credentials?: { backend?: string } }): number {
  const value = config.audit?.anchorIntervalSeconds;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return PROMPTING_BACKENDS.includes(config.credentials?.backend ?? '')
      ? PROMPTING_BACKEND_ANCHOR_INTERVAL_SECONDS
      : DEFAULT_ANCHOR_INTERVAL_SECONDS;
  }
  return Math.max(0, value);
}

/** Read the anchor. `null` when there is none; throws when the store fails or the value is not an anchor. */
export async function readAuditAnchor(store: CredentialStore): Promise<AuditAnchor | null> {
  const raw = await store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const a = parsed as Partial<AuditAnchor> | null;
  if (
    !a || typeof a !== 'object' || a.v !== 1 ||
    !Number.isSafeInteger(a.seq) || (a.seq as number) < 1 ||
    typeof a.hash !== 'string' || !/^[0-9a-f]{64}$/.test(a.hash) ||
    typeof a.at !== 'string'
  ) {
    throw new AuditAnchorFormatError(`the value stored at ${RESERVED_SERVICE}/${AUDIT_ANCHOR_KEY} is not an audit anchor`);
  }
  return { v: 1, seq: a.seq as number, hash: a.hash, at: a.at };
}

/** Store an anchor for this position through the store's own `set`. */
export async function writeAuditAnchor(store: CredentialStore, position: { seq: number; hash: string }): Promise<AuditAnchor> {
  const anchor: AuditAnchor = { v: 1, seq: position.seq, hash: position.hash, at: new Date().toISOString() };
  await store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify(anchor));
  return anchor;
}

export interface AnchorComparison {
  /**
   * `matches`: the log holds the anchored hash at the anchored sequence.
   * `truncated`: the log ends before the anchored sequence.
   * `missing`: there is no log, or it has no entries.
   * `rebuilt`: the log has a different entry at the anchored sequence.
   * `unverifiable`: the log goes past the anchored sequence, and no retained file holds that entry.
   */
  state: 'matches' | 'truncated' | 'missing' | 'rebuilt' | 'unverifiable';
  /** Entries in the log after the anchored one; they are not anchored yet. */
  unanchored: number;
  message: string;
}

/** Compare the log on disk with an anchor. `lastSeq` is the sequence of the log's newest entry. */
export async function compareLogWithAnchor(
  logger: AuditLogger,
  anchor: AuditAnchor,
  lastSeq: number = logger.getPosition().lastSeq,
): Promise<AnchorComparison> {
  if (lastSeq === 0) {
    return {
      state: 'missing',
      unanchored: 0,
      message: `the log is missing or empty, and the anchor (written ${anchor.at}) records an entry at sequence ${anchor.seq}`,
    };
  }
  if (lastSeq < anchor.seq) {
    return {
      state: 'truncated',
      unanchored: 0,
      message: `the log is truncated: it ends at sequence ${lastSeq}, and the anchor (written ${anchor.at}) records an entry at sequence ${anchor.seq}`,
    };
  }
  const hash = await logger.hashAt(anchor.seq);
  if (hash === null) {
    return {
      state: 'unverifiable',
      unanchored: 0,
      message: `the log reaches sequence ${lastSeq}, and no retained file holds the anchored entry (sequence ${anchor.seq}, written ${anchor.at}), so the log cannot be tied to its anchor`,
    };
  }
  if (hash !== anchor.hash) {
    return {
      state: 'rebuilt',
      unanchored: 0,
      message: `the log was rebuilt: its entry at sequence ${anchor.seq} is not the one the anchor (written ${anchor.at}) records`,
    };
  }
  return { state: 'matches', unanchored: lastSeq - anchor.seq, message: `the anchor matches the entry at sequence ${anchor.seq}` };
}

export interface AuditAnchorWriterOptions {
  logger: AuditLogger;
  store: CredentialStore;
  /** Seconds between writes at most. `0` or below: nothing is read or written. */
  intervalSeconds: number;
  /** Where failures are printed. Default: stderr. */
  report?: (line: string) => void;
}

export interface AuditAnchorWriter {
  /** Settles once the log has been compared with the stored anchor. Never rejects. */
  readonly ready: Promise<void>;
  /** Write the anchor now if the log has grown since the last one. Never rejects. */
  flush(): Promise<void>;
  /** Stop listening to the logger and write a last anchor. Never rejects. */
  stop(): Promise<void>;
  /** Whether anchoring is paused because the log did not match its anchor at start. */
  isPaused(): boolean;
}

/**
 * Keep the anchor in `store` up to date with `logger`.
 *
 * Writes are debounced: the first entry after a write starts a timer, and
 * every entry that arrives before it fires rides on the same write. With no
 * entries there is no timer and no write, which matters for backends where a
 * write runs a CLI, prompts, or re-encrypts a file.
 *
 * Nothing here can fail a request or stop the process: a store that cannot
 * be read or written is reported as `AUDIT FAILURE: ...` and tried again at
 * the next interval.
 */
export function createAuditAnchorWriter(opts: AuditAnchorWriterOptions): AuditAnchorWriter {
  const { logger, store } = opts;
  const report = opts.report ?? ((line: string) => console.error(line));
  const intervalMs = opts.intervalSeconds * 1000;

  if (!(intervalMs > 0)) {
    const nothing = Promise.resolve();
    return { ready: nothing, flush: () => nothing, stop: () => nothing, isPaused: () => false };
  }

  /** `undefined` until the store has been read; `null` when it holds no anchor. */
  let anchored: AuditAnchor | null | undefined;
  let paused = false;
  let stale = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();

  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const retryNote = `It is tried again in ${opts.intervalSeconds} seconds. Run: aquaman doctor`;

  /** Read the stored anchor once and compare the log with it. False when the store could not be read. */
  const load = async (): Promise<boolean> => {
    let found: AuditAnchor | null;
    try {
      found = await readAuditAnchor(store);
    } catch (err) {
      if (err instanceof AuditAnchorFormatError) {
        paused = true;
        anchored = null;
        report(`AUDIT FAILURE: ${reason(err)}, so the audit log cannot be checked against it. No new anchor is written. Run: aquaman audit verify`);
        return true;
      }
      report(`AUDIT FAILURE: could not read the audit anchor from the credential store: ${reason(err)}. Requests are still served and logged. ${retryNote}`);
      return false;
    }
    anchored = found;
    if (found) {
      const comparison = await compareLogWithAnchor(logger, found);
      if (comparison.state !== 'matches') {
        paused = true;
        const lead = comparison.state === 'truncated' || comparison.state === 'missing'
          ? 'the audit log is behind its anchor'
          : 'the audit log does not match its anchor';
        report(
          `AUDIT FAILURE: ${lead}: ${comparison.message}. Requests are still served and logged. ` +
          `The anchor is left as it is and no new one is written. Run: aquaman audit verify. ${FIX_ACCEPT}`,
        );
        return true;
      }
    }
    // Entries no anchor covers yet (a first start, or a process that was killed) get one at the next interval.
    if (logger.getPosition().lastSeq > (found?.seq ?? 0)) markStale();
    return true;
  };

  const write = async (): Promise<void> => {
    if (!stale) return;
    if (anchored === undefined && !(await load())) return;
    if (paused) {
      stale = false;
      return;
    }
    const position = logger.getPosition();
    // Forward only: an anchor is never replaced by one for an earlier or equal sequence.
    if (position.lastSeq <= (anchored?.seq ?? 0)) {
      stale = false;
      return;
    }
    // Cleared before the write, so an entry that arrives during it asks for another.
    stale = false;
    try {
      anchored = await writeAuditAnchor(store, { seq: position.lastSeq, hash: position.lastHash });
    } catch (err) {
      stale = true;
      report(
        `AUDIT FAILURE: could not write the audit anchor to the credential store: ${reason(err)}. ` +
        `Requests are still served and logged; entries after sequence ${anchored?.seq ?? 0} are not anchored yet. ${retryNote}`,
      );
    }
  };

  /** One write at a time, in order; the returned promise never rejects. */
  const enqueue = (): Promise<void> => {
    chain = chain.then(write).catch((err) => {
      report(`AUDIT FAILURE: the audit anchor could not be updated: ${reason(err)}. ${retryNote}`);
    });
    return chain;
  };

  const arm = (): void => {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void enqueue().then(() => { if (stale) arm(); });
    }, intervalMs);
    // The timer alone must not keep a process alive that is otherwise done.
    timer.unref();
  };

  function markStale(): void {
    stale = true;
    arm();
  }

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await enqueue();
  };

  logger.onEntryWritten(markStale);
  const ready = (chain = chain.then(async () => { await load(); }).catch((err) => {
    report(`AUDIT FAILURE: the audit log could not be compared with its anchor: ${reason(err)}. ${retryNote}`);
  }));

  return {
    ready,
    flush,
    async stop() {
      stopped = true;
      logger.onEntryWritten(null);
      await flush();
    },
    isPaused: () => paused,
  };
}

/**
 * Start anchoring for a process that owns the audit logger and a credential
 * store while it serves. Returns at once; the first comparison runs in the
 * background so a slow backend does not hold up the listener.
 */
export function startAuditAnchor(
  config: { audit: { enabled: boolean; anchorIntervalSeconds?: unknown } },
  logger: AuditLogger,
  store: CredentialStore,
): AuditAnchorWriter {
  return createAuditAnchorWriter({
    logger,
    store,
    intervalSeconds: config.audit.enabled ? resolveAnchorInterval(config) : 0,
  });
}

export interface AuditVerification {
  /** The chain is valid and nothing about the anchor contradicts the log. */
  valid: boolean;
  chain: ChainVerification;
  anchor: {
    /**
     * `matches`, `truncated`, `missing`, `rebuilt`, `unverifiable`: see `AnchorComparison`.
     * `not_anchored`: the store holds no anchor yet. Passes.
     * `off`: the store holds no anchor and anchoring is switched off. Passes.
     * `not_checked`: `--chain-only`. Passes on the chain alone.
     * `unreadable`: the credential store could not be read. Fails.
     * `malformed`: the stored value is not an anchor. Fails.
     */
    status: AnchorComparison['state'] | 'not_anchored' | 'off' | 'not_checked' | 'unreadable' | 'malformed';
    seq?: number;
    at?: string;
    /** Entries after the anchored one, when the anchor matches. */
    unanchored?: number;
    message: string;
  };
  /** What to run, when something failed. */
  fix?: string;
}

/**
 * What `aquaman audit verify` checks: the chain, then the log against the
 * anchor in the credential store.
 */
export async function verifyAuditLog(opts: {
  logger: AuditLogger;
  /** Opens the credential store; may throw (locked, password missing, CLI not signed in). */
  openStore: () => Promise<CredentialStore>;
  /** Whether a serving process would write anchors under the current config. */
  anchoring: boolean;
  chainOnly?: boolean;
}): Promise<AuditVerification> {
  const chain = await opts.logger.verifyChain();
  if (opts.chainOnly) {
    return {
      valid: chain.valid,
      chain,
      anchor: { status: 'not_checked', message: 'the anchor was not checked (--chain-only), so a truncated, emptied, deleted or rebuilt log is not detected by this run' },
    };
  }

  let anchor: AuditAnchor | null;
  try {
    anchor = await readAuditAnchor(await opts.openStore());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AuditAnchorFormatError) {
      return {
        valid: false,
        chain,
        anchor: { status: 'malformed', message },
        fix: 'Something other than aquaman changed that value. To replace it with an anchor for the log as it is, stop the proxy and run: aquaman audit accept',
      };
    }
    return {
      valid: false,
      chain,
      anchor: { status: 'unreadable', message: `the credential store could not be read, so the anchor was not checked: ${message}` },
      fix: 'Unlock or sign in to the credential backend and run this again (aquaman doctor says what is wrong). To check the chain alone: aquaman audit verify --chain-only',
    };
  }

  if (!anchor) {
    return {
      valid: chain.valid,
      chain,
      anchor: opts.anchoring
        ? { status: 'not_anchored', message: 'not anchored yet: the credential store holds no anchor for this log. The process that writes the log stores one after it starts' }
        : { status: 'off', message: 'anchoring is off (audit.anchorIntervalSeconds: 0 or audit.enabled: false) and the credential store holds no anchor, so only the chain was checked' },
    };
  }

  const comparison = await compareLogWithAnchor(opts.logger, anchor, chain.lastSeq);
  const matches = comparison.state === 'matches';
  return {
    valid: chain.valid && matches,
    chain,
    anchor: {
      status: comparison.state,
      seq: anchor.seq,
      at: anchor.at,
      ...(matches ? { unanchored: comparison.unanchored } : {}),
      message: matches
        ? `${comparison.message} (written ${anchor.at}); ${comparison.unanchored} ${comparison.unanchored === 1 ? 'entry' : 'entries'} since the last anchor, not yet anchored`
        : comparison.message,
    },
    ...(matches ? {} : { fix: FIX_ACCEPT }),
  };
}

export type AcceptResult =
  | { accepted: true; previousSeq: number | null; seq: number }
  | { accepted: false; reason: string; fix: string };

/**
 * `aquaman audit accept`, after the person has confirmed: record the reset in
 * the log and set the anchor to the log as it is, whatever sequence the old
 * anchor held. The caller makes sure no other process is writing this log.
 *
 * A broken chain is not accepted: the anchor would then vouch for a log that
 * `audit verify` still fails.
 */
export async function acceptAuditLog(opts: { logger: AuditLogger; store: CredentialStore }): Promise<AcceptResult> {
  const { logger, store } = opts;
  const chain = await logger.verifyChain();
  if (!chain.valid) {
    return {
      accepted: false,
      reason: `the chain itself is broken (${chain.errors[0]}), and accepting an anchor does not repair it`,
      fix: 'Move the audit directory aside (for example: mv ~/.aquaman/audit ~/.aquaman/audit.broken) so a new log starts, then run: aquaman audit accept',
    };
  }

  let previous: AuditAnchor | null = null;
  try {
    previous = await readAuditAnchor(store);
  } catch (err) {
    // A stored value that is not an anchor is replaced; a store that cannot be read stops here.
    if (!(err instanceof AuditAnchorFormatError)) throw err;
  }

  const entry = await logger.logCredentialAccess('system', 'system', {
    service: RESERVED_SERVICE,
    operation: 'rotate',
    success: true,
    note: `audit anchor reset by a person: was sequence ${previous ? previous.seq : 'none'}, now sequence ${chain.lastSeq + 1}`,
  });
  if (!entry) {
    return {
      accepted: false,
      reason: 'the reset could not be recorded in the audit log',
      fix: 'Check that the audit directory is writable. Run: aquaman doctor',
    };
  }
  await writeAuditAnchor(store, { seq: entry.seq as number, hash: entry.hash });
  return { accepted: true, previousSeq: previous ? previous.seq : null, seq: entry.seq as number };
}
