/**
 * The audit log's anchor.
 *
 * The log's hash chain is unkeyed and lives in one directory, so the chain
 * alone cannot show that the end of the log was cut off, that the log was
 * emptied or deleted, or that it was rebuilt from scratch: each of those
 * leaves a chain that is valid on its own terms. The anchor is a small record
 * of where the log ended and where it is supposed to begin,
 * `{ v, seq, hash, at, from }`, kept in the credential store under a reserved
 * service name. `aquaman audit verify` compares the two: the log must reach
 * the anchored sequence, hold the anchored hash there, and begin no later
 * than `from`.
 *
 * `from` is the lowest sequence that is supposed to be on disk. Pruning old
 * archives is the only thing that raises it, so a log that begins later than
 * its anchor says has lost entries some other way.
 *
 * A process that writes the log writes the anchor: at most once per interval
 * while entries arrive, at once after it pruned, never while idle, and once
 * more on graceful shutdown. Several processes may write one log and one
 * anchor, so each write starts from the anchor the store holds at that
 * moment. An anchor only moves forward. The one way back is
 * `aquaman audit accept`, which a person confirms at a terminal.
 *
 * What the anchor does not cover: entries written after the last anchor (up
 * to one interval's worth), an anchor written without `from`, and software
 * that can write to the credential store, which can move the anchor as well
 * as the log.
 */

import type { AuditLogger, ChainVerification } from './core/audit/logger.js';
import type { CredentialStore } from './core/credentials/store.js';
import { RESERVED_SERVICE } from './broker-scope.js';

/** The anchor's key under `RESERVED_SERVICE`. */
export const AUDIT_ANCHOR_KEY = 'audit_anchor';
export const DEFAULT_ANCHOR_INTERVAL_SECONDS = 60;
/** How long a stopping process waits for its last anchor write. */
export const DEFAULT_ANCHOR_STOP_TIMEOUT_MS = 5000;

export interface AuditAnchor {
  v: 1;
  /** Sequence of the anchored entry. */
  seq: number;
  /** Hash of the anchored entry. */
  hash: string;
  /** When the anchor was written, ISO 8601. */
  at: string;
  /**
   * The lowest sequence that was supposed to be on disk when the anchor was
   * written. Absent on an anchor written without it; such an anchor says
   * nothing about where the log begins.
   */
  from?: number;
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

/** A store that keeps values in memory and can be asked to read past that (`CachingStore`). */
type MaybeCached = CredentialStore & { getFresh?(service: string, key: string): Promise<string | null> };

/**
 * Read the anchor. `null` when there is none; throws when the store fails or
 * the value is not an anchor. A serving process reads it through a store
 * that may cache, and the anchor another process wrote in the meantime must
 * not be answered from memory, so the read goes to the backend where the
 * store offers that.
 */
export async function readAuditAnchor(store: CredentialStore): Promise<AuditAnchor | null> {
  const cached: MaybeCached = store;
  const raw = cached.getFresh
    ? await cached.getFresh(RESERVED_SERVICE, AUDIT_ANCHOR_KEY)
    : await store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
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
    typeof a.at !== 'string' ||
    (a.from !== undefined && (!Number.isSafeInteger(a.from) || a.from < 1))
  ) {
    throw new AuditAnchorFormatError(`the value stored at ${RESERVED_SERVICE}/${AUDIT_ANCHOR_KEY} is not an audit anchor`);
  }
  return { v: 1, seq: a.seq as number, hash: a.hash, at: a.at, ...(a.from === undefined ? {} : { from: a.from }) };
}

/** Store an anchor for this position through the store's own `set`. */
export async function writeAuditAnchor(store: CredentialStore, position: { seq: number; hash: string; from?: number }): Promise<AuditAnchor> {
  const anchor: AuditAnchor = {
    v: 1,
    seq: position.seq,
    hash: position.hash,
    at: new Date().toISOString(),
    ...(position.from === undefined ? {} : { from: position.from }),
  };
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
   * `head_missing`: the log begins later than the anchor's `from`.
   */
  state: 'matches' | 'truncated' | 'missing' | 'rebuilt' | 'unverifiable' | 'head_missing';
  /** Entries in the log after the anchored one; they are not anchored yet. */
  unanchored: number;
  message: string;
}

/**
 * Compare the log on disk with an anchor. `lastSeq` is the sequence of the
 * log's newest entry and `firstSeq` the sequence it begins at.
 */
export async function compareLogWithAnchor(
  logger: AuditLogger,
  anchor: AuditAnchor,
  lastSeq: number = logger.getPosition().lastSeq,
  firstSeq: number | null = logger.getRetainedFrom(),
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
  if (anchor.from !== undefined && firstSeq !== null && firstSeq > anchor.from) {
    return {
      state: 'head_missing',
      unanchored: 0,
      message: `entries ${anchor.from} to ${firstSeq - 1} are missing: they were on disk when the anchor was written (${anchor.at}), and the log now begins at sequence ${firstSeq}`,
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
  /** How long `stop()` waits for the last write. Default: 5000 ms. */
  stopTimeoutMs?: number;
}

export interface AuditAnchorWriter {
  /** Settles once the log has been compared with the stored anchor. Never rejects. */
  readonly ready: Promise<void>;
  /** Write the anchor now if the log has grown since the last one. Never rejects. */
  flush(): Promise<void>;
  /**
   * Stop listening to the logger and write a last anchor. Never rejects, and
   * settles after `stopTimeoutMs` at the latest: a store that does not answer
   * must not keep a stopping process alive.
   */
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

  /** The anchor this writer last read or wrote. `undefined` until the store has been read; `null` when it holds none. */
  let anchored: AuditAnchor | null | undefined;
  let paused = false;
  let stale = false;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let chain: Promise<void> = Promise.resolve();
  // Where the log began when this process opened it. The logger's own figure
  // goes up when it prunes, and that must not look like missing entries.
  const firstSeqAtStart = logger.getRetainedFrom();

  const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  const retryNote = `It is tried again in ${opts.intervalSeconds} seconds. Run: aquaman doctor`;

  /** The anchor the store holds now. `false` when it could not be read or is not an anchor; both are reported. */
  const readStored = async (): Promise<AuditAnchor | null | false> => {
    try {
      return await readAuditAnchor(store);
    } catch (err) {
      if (err instanceof AuditAnchorFormatError) {
        paused = true;
        anchored = null;
        report(`AUDIT FAILURE: ${reason(err)}, so the audit log cannot be checked against it. No new anchor is written. Run: aquaman audit verify`);
      } else {
        report(`AUDIT FAILURE: could not read the audit anchor from the credential store: ${reason(err)}. Requests are still served and logged. ${retryNote}`);
      }
      return false;
    }
  };

  /** Read the stored anchor once and compare the log with it. False when the store could not be read. */
  const load = async (): Promise<boolean> => {
    const found = await readStored();
    // A value that is not an anchor is a finding, not a store that failed: nothing is retried.
    if (found === false) return paused;
    anchored = found;
    if (found) {
      let comparison = await compareLogWithAnchor(logger, found, logger.getPosition().lastSeq, firstSeqAtStart);
      if (comparison.state === 'truncated' || comparison.state === 'missing') {
        // What this process knows of the log ends at its own last write, and
        // another process may have written and anchored since. The files decide.
        comparison = await compareLogWithAnchor(logger, found, (await logger.verifyChain()).lastSeq, firstSeqAtStart);
      }
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
    // Cleared before the store is touched, so an entry that arrives meanwhile asks for another write.
    stale = false;
    // Another process may anchor the same log, so what the store holds now
    // decides what is written, not what this process wrote last.
    const stored = await readStored();
    if (stored === false) {
      stale = !paused;
      return;
    }
    const position = logger.getPosition();
    const from = Math.max(logger.getRetainedFrom(), stored?.from ?? 1);
    // Forward only: the sequence never goes back and `from` never goes down.
    const ahead = stored !== null && stored.seq >= position.lastSeq ? stored : null;
    if (ahead && ahead.from !== undefined && ahead.from >= from) {
      anchored = ahead;
      return;
    }
    // An anchor that is already as far on keeps its entry and only learns where the log begins.
    const target = ahead ?? { seq: position.lastSeq, hash: position.lastHash };
    try {
      anchored = await writeAuditAnchor(store, { seq: target.seq, hash: target.hash, from });
    } catch (err) {
      stale = true;
      report(
        `AUDIT FAILURE: could not write the audit anchor to the credential store: ${reason(err)}. ` +
        `Requests are still served and logged; entries after sequence ${stored?.seq ?? 0} are not anchored yet. ${retryNote}`,
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
    // A write that failed is tried again at the next interval, entries or not.
    if (stale) arm();
  };

  logger.onEntryWritten(markStale);
  // Pruning moved the beginning of the log. Until the anchor says so, the
  // log looks as if it had lost its early entries, so this write does not
  // wait for the interval.
  logger.onPruned(() => {
    stale = true;
    void flush();
  });
  const ready = (chain = chain.then(async () => { await load(); }).catch((err) => {
    report(`AUDIT FAILURE: the audit log could not be compared with its anchor: ${reason(err)}. ${retryNote}`);
  }));

  return {
    ready,
    flush,
    async stop() {
      stopped = true;
      logger.onEntryWritten(null);
      logger.onPruned(null);
      const limit = opts.stopTimeoutMs ?? DEFAULT_ANCHOR_STOP_TIMEOUT_MS;
      let deadline: NodeJS.Timeout | undefined;
      const late = await Promise.race([
        flush().then(() => false),
        new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(true), limit); }),
      ]);
      clearTimeout(deadline);
      if (late) {
        report(
          `AUDIT FAILURE: the last audit anchor was not written: the credential store did not answer within ${limit} ms while stopping. ` +
          `Entries after sequence ${anchored?.seq ?? 0} are not anchored until a proxy runs again. Run: aquaman audit verify`,
        );
      }
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
     * `matches`, `truncated`, `missing`, `rebuilt`, `unverifiable`, `head_missing`: see `AnchorComparison`.
     * `not_anchored`: the store holds no anchor yet. Passes.
     * `off`: the store holds no anchor and anchoring is switched off. Passes.
     * `not_checked`: `--chain-only`. Passes on the chain alone.
     * `unreadable`: the credential store could not be read. Fails.
     * `malformed`: the stored value is not an anchor. Fails.
     */
    status: AnchorComparison['state'] | 'not_anchored' | 'off' | 'not_checked' | 'unreadable' | 'malformed';
    seq?: number;
    at?: string;
    /** The anchor's `from`, when it has one: the lowest sequence that is supposed to be on disk. */
    from?: number;
    /** Entries after the anchored one, when the anchor matches. */
    unanchored?: number;
    message: string;
  };
  /** What to run, when something failed. */
  fix?: string;
}

/**
 * What `aquaman audit verify` checks: the chain, then the log against the
 * anchor in the credential store. It reads and never writes, so `logger` can
 * be one opened with `readOnly`.
 */
export async function verifyAuditLog(opts: {
  logger: AuditLogger;
  /** Opens the credential store; may throw (locked, password missing, CLI not signed in). */
  openStore: () => Promise<CredentialStore>;
  /** Whether a serving process would write anchors under the current config. */
  anchoring: boolean;
  chainOnly?: boolean;
}): Promise<AuditVerification> {
  if (opts.chainOnly) {
    const chain = await opts.logger.verifyChain();
    return {
      valid: chain.valid,
      chain,
      anchor: { status: 'not_checked', message: 'the anchor was not checked (--chain-only), so a truncated, emptied, deleted or rebuilt log is not detected by this run' },
    };
  }

  let store: CredentialStore | undefined;
  for (let attempt = 1; ; attempt++) {
    const chain = await opts.logger.verifyChain();
    let anchor: AuditAnchor | null;
    try {
      store ??= await opts.openStore();
      anchor = await readAuditAnchor(store);
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

    const comparison = await compareLogWithAnchor(opts.logger, anchor, chain.lastSeq, chain.verifiedFrom);
    const matches = comparison.state === 'matches';
    // A serving process may write, prune and anchor between the read of the
    // log and the read of the anchor. A difference counts when a second look
    // finds one too.
    if (!matches && attempt === 1) continue;
    // An anchor without `from` says nothing about a log that begins later than sequence 1.
    const beginsLate = anchor.from === undefined && chain.verifiedFrom !== null && chain.verifiedFrom > 1;
    return {
      valid: chain.valid && matches,
      chain,
      anchor: {
        status: comparison.state,
        seq: anchor.seq,
        at: anchor.at,
        ...(anchor.from === undefined ? {} : { from: anchor.from }),
        ...(matches ? { unanchored: comparison.unanchored } : {}),
        message: matches
          ? `${comparison.message} (written ${anchor.at}); ${comparison.unanchored} ${comparison.unanchored === 1 ? 'entry' : 'entries'} since the last anchor, not yet anchored` +
            (beginsLate ? `; the log begins at sequence ${chain.verifiedFrom} and this anchor does not record where it should begin, so it was not checked for missing early entries` : '')
          : comparison.message,
      },
      ...(matches ? {} : { fix: FIX_ACCEPT }),
    };
  }
}

export type AcceptResult =
  | { accepted: true; previousSeq: number | null; seq: number }
  | { accepted: false; reason: string; fix: string };

/**
 * `aquaman audit accept`, after the person has confirmed: record the reset in
 * the log and set the anchor to the log as it is, whatever sequence the old
 * anchor held, with `from` at the first entry that is on disk. The caller
 * makes sure no proxy is serving; `logger` is a writer and takes the log's
 * lock like any other.
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
  await writeAuditAnchor(store, { seq: entry.seq as number, hash: entry.hash, from: chain.verifiedFrom ?? (entry.seq as number) });
  return { accepted: true, previousSeq: previous ? previous.seq : null, seq: entry.seq as number };
}
