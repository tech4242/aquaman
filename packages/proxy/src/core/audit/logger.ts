/**
 * Hash-chained audit logger.
 *
 * Each entry carries a sequence number and the hash of the entry before it,
 * and its own SHA-256 hash covers both. The sequence starts at 1 and never
 * restarts; when the log rotates, the first entry of the new file links to
 * the last entry of the archived one. `verifyChain()` therefore detects an
 * entry altered, inserted, reordered or deleted inside the retained files, a
 * gap in the sequence, and a missing newest archive.
 *
 * The hash is unkeyed, so the chain alone does not show that the end of the
 * log was removed or that the whole log was rebuilt. That is what the anchor
 * kept in the credential store is for (`audit-anchor.ts`).
 *
 * Several processes may have one log open: a daemon and an OpenClaw-hosted
 * proxy on one config directory both write it, and `aquaman audit verify`
 * reads it while they do. Two rules keep the chain whole:
 *
 * - A reader never changes anything. `verifyChain()`, `hashAt()`, `tail()`
 *   and a logger opened with `readOnly` create no file or directory and
 *   leave the write-ahead file alone.
 * - Every write happens under a lock file in the audit directory, held for
 *   the length of one append. Under the lock the writer looks at whether the
 *   log changed since its own last write and, if it did, reads what was
 *   added and goes on from there. Recovery from the write-ahead file,
 *   rotation and pruning happen under the same lock.
 *
 * A writer follows only entries that link to the last one it knows. A log
 * that was cut short or replaced is not followed: the writer goes on from
 * its own last entry, so the change shows as a break in the chain.
 *
 * Note: Credential redaction is handled by OpenClaw's built-in redaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeChainedHash, generateId } from '../utils/hash.js';
import { expandPath } from '../utils/config.js';
import type {
  AuditEntry,
  ToolCall,
  ToolResult,
  CredentialAccess
} from '../types.js';

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

const SENSITIVE_KEY_PATTERNS = [
  'key', 'token', 'secret', 'password', 'credential',
  'authorization', 'api_key', 'apikey', 'access_token',
  'refresh_token', 'client_secret',
];

/**
 * Redact sensitive values from a params/result object.
 * Shallow redaction only — replaces top-level keys matching sensitive patterns.
 */
export function redactSensitiveParams(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_PATTERNS.some(p => lower.includes(p))) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface AuditLoggerOptions {
  logDir: string;
  enabled?: boolean;
  walEnabled?: boolean;
  /**
   * Maximum size of `current.jsonl` before it auto-rotates into `archive/`.
   * Default: 10 MB. Set to 0 to disable auto-rotation.
   */
  maxLogSizeBytes?: number;
  /**
   * Maximum number of archived log files to retain. Older archives are
   * deleted after each rotation. Default: 10. Set to 0 to retain all. The
   * newest archive is always kept.
   *
   * Note: the audit log records request metadata (service, method, path
   * with query stripped, outcome) and the SHA-256 hash chain — not
   * credential values. Operators should still protect `~/.aquaman/audit/`
   * under their normal local-data retention policy.
   */
  maxArchives?: number;
  /**
   * Open the log for reading only: `initialize()` creates nothing and does
   * not touch the write-ahead file, and every write is refused. For commands
   * that inspect a log another process may be writing.
   */
  readOnly?: boolean;
  /** How long a write waits for the lock before it fails. Default: 2000 ms. */
  lockWaitMs?: number;
  /**
   * Age after which a lock is taken over whoever holds it. A writer holds
   * the lock for one append, so a lock this old belongs to a process that
   * stopped or hangs. Default: 5000 ms.
   */
  lockStaleMs?: number;
}

const DEFAULT_MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_ARCHIVES = 10;
const DEFAULT_LOCK_WAIT_MS = 2000;
const DEFAULT_LOCK_STALE_MS = 5000;

/** Result of walking the chain through the current file and the archives it links to. */
export interface ChainVerification {
  valid: boolean;
  errors: string[];
  /** Entries in `current.jsonl`. */
  entries: number;
  /** Sequence of the newest entry in the retained files; 0 when there is none. */
  lastSeq: number;
  /** Hash of that entry; the genesis hash when there is none. */
  lastHash: string;
  /**
   * The earliest sequence the retained files were verified from. Above 1 when
   * older archives have been pruned. `null` when there are no entries.
   */
  verifiedFrom: number | null;
}

interface ChainLine {
  /** The parsed entry, or `null` for a line that is not an entry. */
  entry: AuditEntry | null;
  /** The sequence this line holds: its `seq`, or its position for an entry written without one. */
  seq: number;
}

interface ChainFile {
  lines: ChainLine[];
  errors: string[];
}

const splitLines = (content: string): string[] => content.trim().split('\n').filter(line => line.length > 0);

function readLines(file: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  return splitLines(content);
}

interface FilePart {
  text: string;
  ino: number;
  /** The size of the file when it was read. */
  size: number;
}

/**
 * What `file` holds from `offset` to its end, with the inode and size of the
 * file that was read. `null` when there is no such file to read.
 */
function readFrom(file: string, offset: number): FilePart | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { ino, size } = fs.fstatSync(fd);
    const buffer = Buffer.alloc(Math.max(0, size - offset));
    const got = fs.readSync(fd, buffer, 0, buffer.length, offset);
    return { text: buffer.toString('utf-8', 0, got), ino, size };
  } catch {
    return null; // a directory under that name, or a file that cannot be read
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether an entry's hash is the hash of its own content and the previous hash it names. */
function hashMatches(entry: AuditEntry): boolean {
  return entry.hash === computeChainedHash(JSON.stringify({ ...entry, hash: undefined }), entry.previousHash);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read one log file and check it on its own terms: every entry's hash, every
 * link to the entry before it, and sequence numbers that go up by exactly 1.
 *
 * An entry without `seq` counts by position: the n-th line of a file has
 * sequence n. That holds only until the first entry that has one; from there
 * on every entry must carry its own.
 */
function readChainFile(file: string, label: string): ChainFile {
  const lines: ChainLine[] = [];
  const errors: string[] = [];
  let previousHash: string | null = null;
  let previousSeq = 0;
  let numbered = false;

  for (const [i, text] of readLines(file).entries()) {
    const expectedSeq = previousSeq + 1;
    let entry: AuditEntry;
    try {
      entry = JSON.parse(text) as AuditEntry;
      if (entry === null || typeof entry !== 'object') throw new Error('not an entry');
    } catch {
      errors.push(`${label}${i}: failed to parse JSON`);
      lines.push({ entry: null, seq: expectedSeq });
      previousSeq = expectedSeq;
      continue;
    }

    let seq = expectedSeq;
    if (entry.seq === undefined) {
      if (numbered) errors.push(`${label}${i}: sequence number missing (expected ${expectedSeq})`);
    } else if (!Number.isSafeInteger(entry.seq) || entry.seq < 1) {
      errors.push(`${label}${i}: invalid sequence number ${JSON.stringify(entry.seq)}`);
    } else {
      // The first line of a file may start anywhere; what it links to is checked against the archive.
      if (i > 0 && entry.seq !== expectedSeq) {
        errors.push(`${label}${i}: sequence gap (expected ${expectedSeq}, got ${entry.seq})`);
      }
      seq = entry.seq;
      numbered = true;
    }

    if (previousHash !== null && entry.previousHash !== previousHash) {
      errors.push(`${label}${i}: previousHash mismatch (expected ${previousHash}, got ${entry.previousHash})`);
    }
    const expectedHash = computeChainedHash(JSON.stringify({ ...entry, hash: undefined }), entry.previousHash);
    if (entry.hash !== expectedHash) {
      errors.push(`${label}${i}: hash mismatch (expected ${expectedHash}, got ${entry.hash})`);
    }

    lines.push({ entry, seq });
    previousHash = entry.hash;
    previousSeq = seq;
  }
  return { lines, errors };
}

export class AuditLogger {
  private logDir: string;
  private currentLogPath: string;
  private walPath: string;
  private lockPath: string;
  private enabled: boolean;
  private walEnabled: boolean;
  private readOnly: boolean;
  private maxLogSizeBytes: number;
  private maxArchives: number;
  private lockWaitMs: number;
  private lockStaleMs: number;
  private lastHash: string = GENESIS_HASH;
  private lastSeq: number = 0;
  private entryCount: number = 0;
  private initialized: boolean = false;
  private entryListener: (() => void) | null = null;
  private pruneListener: (() => void) | null = null;
  /**
   * The lowest sequence that is supposed to be on disk: where the log began
   * when this logger first read it, raised only by this logger's own pruning.
   */
  private retainedFrom: number = 1;
  private retainedFromKnown: boolean = false;
  /** The file that holds the newest entry this logger knows, and where that entry ends in it. */
  private endOfKnown: { ino: number; size: number } | null = null;
  /** What the current file looked like when this logger last read or wrote it. */
  private seen: string = '';
  private divergenceReported: boolean = false;

  constructor(options: AuditLoggerOptions) {
    this.logDir = expandPath(options.logDir);
    this.currentLogPath = path.join(this.logDir, 'current.jsonl');
    this.walPath = path.join(this.logDir, 'current.wal');
    this.lockPath = path.join(this.logDir, 'write.lock');
    this.enabled = options.enabled ?? true;
    this.walEnabled = options.walEnabled ?? true;
    this.readOnly = options.readOnly ?? false;
    this.maxLogSizeBytes = options.maxLogSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
    this.maxArchives = options.maxArchives ?? DEFAULT_MAX_ARCHIVES;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.enabled) {
      this.initialized = true;
      return;
    }

    if (!this.readOnly) {
      const archiveDir = path.join(this.logDir, 'archive');
      const integrityDir = path.join(this.logDir, 'integrity');

      fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(integrityDir, { recursive: true, mode: 0o700 });
    }

    this.recoverState();

    // An entry in the write-ahead file belongs either to a writer that is in
    // the middle of an append or to one that stopped there. Only the lock
    // tells the two apart, so only a writer that holds it puts the entry
    // into the log. With the lock busy, the first write does it.
    if (!this.readOnly && this.walPending()) {
      try {
        await this.locked(() => this.catchUp());
      } catch {
        // the first write tries again, and fails if it cannot
      }
    }

    this.initialized = true;
  }

  /** Archived log files, oldest first. The name carries the rotation time, so name order is rotation order. */
  private archiveFiles(): string[] {
    const archiveDir = path.join(this.logDir, 'archive');
    let names: string[];
    try {
      names = fs.readdirSync(archiveDir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.startsWith('audit-') && name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(archiveDir, name));
  }

  /**
   * Pick up where the log ends. With entries in `current.jsonl` that is its
   * last line. With none, it is the last line of the newest archive, so a
   * rotated log goes on with the next sequence number and the same chain.
   */
  private recoverState(): void {
    const archives = this.archiveFiles();
    const current = readFrom(this.currentLogPath, 0);
    const lines = splitLines(current?.text ?? '');
    this.entryCount = lines.length;
    // Taken from the bytes that were read, not from a later look at the file:
    // an entry another process appends in between must count as not seen.
    this.seen = current ? `${current.ino}:${current.size}` : this.absentMark(archives);
    this.endOfKnown = current ? { ino: current.ino, size: current.size } : null;

    let source = lines;
    for (let i = archives.length - 1; i >= 0 && source.length === 0; i--) {
      const archive = readFrom(archives[i], 0);
      source = splitLines(archive?.text ?? '');
      if (archive && source.length > 0) this.endOfKnown = { ino: archive.ino, size: archive.size };
    }

    if (!this.retainedFromKnown) {
      this.retainedFromKnown = true;
      this.retainedFrom = this.firstSeqOnDisk() ?? 1;
    }
    if (source.length === 0) return;

    // An entry written without a sequence number counts by its position in the file.
    this.lastSeq = source.length;
    try {
      const lastEntry = JSON.parse(source[source.length - 1]) as AuditEntry;
      this.lastHash = lastEntry.hash;
      if (Number.isSafeInteger(lastEntry.seq)) this.lastSeq = lastEntry.seq as number;
    } catch {
      // If we can't parse the last line, start fresh with integrity warning
      console.error('Warning: Could not parse last audit entry, integrity may be compromised');
    }
  }

  /** The sequence of the oldest entry in the retained files, or `null` when there is none to read. */
  private firstSeqOnDisk(): number | null {
    for (const file of [...this.archiveFiles(), this.currentLogPath]) {
      const first = readLines(file)[0];
      if (first === undefined) continue;
      try {
        const { seq } = JSON.parse(first) as AuditEntry;
        // An entry written without a sequence number is the first of its log.
        return Number.isSafeInteger(seq) ? (seq as number) : 1;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** What stands for the current file while there is none: the newest archive, which a rotation by anyone replaces. */
  private absentMark(archives: string[]): string {
    return `-:${path.basename(archives[archives.length - 1] ?? '')}`;
  }

  private currentMark(): string {
    const stat = fs.statSync(this.currentLogPath, { throwIfNoEntry: false });
    return stat ? `${stat.ino}:${stat.size}` : this.absentMark(this.archiveFiles());
  }

  /** Remember the current file as it is after this logger's own append to it. */
  private noteOwnWrite(): fs.Stats {
    const stat = fs.statSync(this.currentLogPath);
    this.endOfKnown = { ino: stat.ino, size: stat.size };
    this.seen = `${stat.ino}:${stat.size}`;
    return stat;
  }

  // ── Writing under the lock ──────────────────────────────────────────────

  /**
   * Run `work` while holding the lock file. `work` is synchronous, so the
   * lock is held for one append and never across a wait.
   *
   * The lock is a file created with `O_EXCL` that names its holder. A lock
   * whose holder is not running, or that is older than `lockStaleMs`, is
   * removed and taken. A lock that stays held past `lockWaitMs` fails the
   * write; nothing has been written at that point.
   *
   * Taking over is not atomic: two processes that find the same abandoned
   * lock in the same instant can both take it. That needs a writer that
   * stopped inside an append and two others waiting on it.
   */
  private async locked<T>(work: () => T): Promise<T> {
    const deadline = Date.now() + this.lockWaitMs;
    for (let wait = 1; ; wait = Math.min(wait * 2, 25)) {
      const made = this.tryLock();
      if (made !== null) {
        try {
          return work();
        } finally {
          // Removed only while it is still this writer's: a process that was
          // stopped for longer than the stale age has had its lock taken. The
          // file is recognised by inode and time, not read back: opening it
          // costs more than everything else the lock does.
          const now = fs.statSync(this.lockPath, { throwIfNoEntry: false });
          if (now?.ino === made.ino && now.mtimeMs === made.mtimeMs) fs.rmSync(this.lockPath, { force: true });
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `The audit log is locked by another process (${this.lockText() ?? 'its lock file could not be read'}) and did not become free within ${this.lockWaitMs} ms. ` +
          `If that process is not running aquaman, remove ${this.lockPath}`,
        );
      }
      await sleep(wait);
    }
  }

  private lockText(): string | null {
    try {
      return fs.readFileSync(this.lockPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Create the lock file, removing an abandoned one first, and say which file it is. `null` while another writer holds it. */
  private tryLock(): fs.Stats | null {
    const token = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: generateId() });
    for (let attempt = 1; ; attempt++) {
      try {
        fs.writeFileSync(this.lockPath, token, { flag: 'wx', mode: 0o600 });
        return fs.statSync(this.lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const abandoned = this.abandonedLock();
      // Read again before removing, so a lock another writer took in the
      // meantime is left alone. One removal per try: a lock that is back at
      // once belongs to someone, and the caller waits for it.
      if (attempt > 1 || abandoned === null || this.lockText() !== abandoned) return null;
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  /** The text of the lock file when nobody holds it any more, else `null`. */
  private abandonedLock(): string | null {
    let text: string;
    let age: number;
    try {
      text = fs.readFileSync(this.lockPath, 'utf-8');
      age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
    } catch {
      return null; // released between the attempt and this look, or not a file
    }
    if (Math.abs(age) > this.lockStaleMs) return text;
    let pid: unknown;
    try {
      pid = (JSON.parse(text) as { pid?: unknown }).pid;
    } catch {
      return null; // being written right now, or not a lock of ours: its age decides
    }
    // This process never waits while it holds the lock, so its own pid on a
    // lock it is not holding is left from an earlier process with that pid.
    if (pid === process.pid) return text;
    if (!Number.isSafeInteger(pid) || (pid as number) < 1) return null;
    try {
      process.kill(pid as number, 0);
      return null;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH' ? text : null;
    }
  }

  private walPending(): boolean {
    return this.walEnabled && (fs.statSync(this.walPath, { throwIfNoEntry: false })?.size ?? 0) > 0;
  }

  /**
   * Under the lock, before anything is written: follow what other writers
   * added, then finish an append that a stopped writer left in the
   * write-ahead file.
   */
  private catchUp(): void {
    if (this.currentMark() !== this.seen) this.followDisk();
    if (this.walPending()) this.recoverFromWal();
  }

  /**
   * The log changed since this logger last read or wrote it. Read what was
   * added after the entry this logger knows as the newest and, when every
   * added entry links back to it, go on from the last of them.
   *
   * Only the added part is read: the rest of the file this logger's newest
   * entry is in, and the files after it when the log was rotated meanwhile.
   */
  private followDisk(): void {
    if (this.lastSeq === 0 || this.endOfKnown === null) {
      // Nothing of this logger's to continue from, so whatever is there is the log.
      this.recoverState();
      return;
    }
    const tail = this.endOfKnown;
    const files = [...this.archiveFiles(), this.currentLogPath];
    let start = files.length - 1;
    while (start >= 0 && fs.statSync(files[start], { throwIfNoEntry: false })?.ino !== tail.ino) start--;

    let seq = this.lastSeq;
    let hash = this.lastHash;
    let end = tail;
    let inCurrent = 0;
    let linked = start >= 0;
    for (let i = start; linked && i < files.length; i++) {
      const offset = i === start ? tail.size : 0;
      const part = readFrom(files[i], offset);
      if (part === null) continue; // no current file after a rotation
      const added = part.size < offset ? null : splitLines(part.text);
      for (const text of added ?? []) {
        let entry: AuditEntry | null;
        try {
          entry = JSON.parse(text) as AuditEntry | null;
        } catch {
          entry = null;
        }
        if (!entry || entry.seq !== seq + 1 || entry.previousHash !== hash || !hashMatches(entry)) {
          linked = false;
          break;
        }
        seq = entry.seq;
        hash = entry.hash;
      }
      // A file shorter than the place this logger's entry ended at was cut.
      if (added === null) linked = false;
      else if (files[i] === this.currentLogPath) inCurrent = (i === start ? this.entryCount : 0) + added.length;
      end = { ino: part.ino, size: part.size };
    }

    this.seen = this.currentMark();
    if (!linked) {
      if (!this.divergenceReported) {
        this.divergenceReported = true;
        console.error(
          `AUDIT FAILURE: the audit log on disk does not continue from the last entry this process wrote (sequence ${this.lastSeq}): ` +
          'something other than an aquaman writer changed it. This process goes on from its own last entry, so the change shows as a break in the chain. ' +
          'Run: aquaman audit verify',
        );
      }
      return;
    }
    this.lastSeq = seq;
    this.lastHash = hash;
    this.endOfKnown = end;
    this.entryCount = inCurrent;
  }

  /**
   * Put the entries of the write-ahead file into the log. Called only under
   * the lock, where a non-empty file means a writer stopped between its two
   * appends, or after the second and before it emptied the file.
   */
  private recoverFromWal(): void {
    for (const line of readLines(this.walPath)) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // A stop after the main log was written and before the WAL was
        // cleared leaves the entry in both. Writing it twice would break the chain.
        if (entry.hash === this.lastHash) continue;
        // Write to main log
        fs.appendFileSync(this.currentLogPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
        this.lastHash = entry.hash;
        this.lastSeq = Number.isSafeInteger(entry.seq) ? (entry.seq as number) : this.lastSeq + 1;
        this.entryCount++;
        this.noteOwnWrite();
      } catch {
        console.error('Warning: Could not recover WAL entry');
      }
    }

    // Clear WAL after recovery
    fs.writeFileSync(this.walPath, '', { mode: 0o600 });
  }

  async logToolCall(
    sessionId: string,
    agentId: string,
    tool: string,
    params: Record<string, unknown>
  ): Promise<AuditEntry | null> {
    if (!this.enabled) return null;

    const toolCall: ToolCall = {
      id: generateId(),
      sessionId,
      agentId,
      tool,
      params: redactSensitiveParams(params),
      timestamp: new Date()
    };

    return this.writeEntry('tool_call', sessionId, agentId, toolCall);
  }

  async logToolResult(
    sessionId: string,
    agentId: string,
    toolCallId: string,
    result: unknown,
    error?: string
  ): Promise<AuditEntry | null> {
    if (!this.enabled) return null;

    const redactedResult = (result && typeof result === 'object' && !Array.isArray(result))
      ? redactSensitiveParams(result as Record<string, unknown>)
      : result;

    const toolResult: ToolResult = {
      id: generateId(),
      toolCallId,
      result: redactedResult,
      error,
      timestamp: new Date()
    };

    return this.writeEntry('tool_result', sessionId, agentId, toolResult);
  }

  async logCredentialAccess(
    sessionId: string,
    agentId: string,
    access: CredentialAccess
  ): Promise<AuditEntry | null> {
    if (!this.enabled) return null;
    return this.writeEntry('credential_access', sessionId, agentId, access);
  }

  private async writeEntry(
    type: AuditEntry['type'],
    sessionId: string,
    agentId: string,
    data: AuditEntry['data']
  ): Promise<AuditEntry> {
    if (this.readOnly) {
      throw new Error('This audit log was opened for reading only; nothing is written through this logger');
    }
    if (!this.initialized) {
      await this.initialize();
    }

    let pruned = false;
    const written = await this.locked(() => {
      this.catchUp();

      const seq = this.lastSeq + 1;
      const entry: AuditEntry = {
        id: generateId(),
        seq,
        timestamp: new Date(),
        type,
        sessionId,
        agentId,
        data,
        previousHash: this.lastHash,
        hash: '' // Will be computed below
      };

      // The hash covers every field of the entry, the sequence number
      // included, and the previous hash for chain integrity.
      const entryData = JSON.stringify({
        ...entry,
        hash: undefined
      });
      entry.hash = computeChainedHash(entryData, this.lastHash);

      const line = JSON.stringify(entry) + '\n';

      // Write to WAL first (for crash recovery)
      if (this.walEnabled) {
        fs.appendFileSync(this.walPath, line, { mode: 0o600 });
      }

      // Write to main log
      fs.appendFileSync(this.currentLogPath, line, { mode: 0o600 });

      // Clear WAL entry after successful write
      if (this.walEnabled) {
        fs.writeFileSync(this.walPath, '', { mode: 0o600 });
      }

      this.lastHash = entry.hash;
      this.lastSeq = seq;
      this.entryCount++;

      try {
        const { size } = this.noteOwnWrite();
        // Auto-rotate if the current log has crossed the size threshold.
        if (this.maxLogSizeBytes > 0 && size >= this.maxLogSizeBytes) {
          this.rotateUnlocked();
          pruned = this.pruneArchives();
        }
      } catch {
        // the file was removed between the write and the look at it: nothing to rotate
      }

      return entry;
    });

    // Whoever anchors the log learns that it grew, and that it now begins
    // later. The entry is on disk already, so nothing a listener does can
    // undo or fail the write.
    try {
      this.entryListener?.();
      if (pruned) this.pruneListener?.();
    } catch {
      // the listener's own problem
    }

    return written;
  }

  /**
   * Delete archive files beyond `maxArchives`, oldest first. The newest
   * archive is never deleted, whatever the setting: the current file's first
   * entry links to it, and verification needs it to follow that link.
   *
   * Returns whether the log now begins at a later entry than before. This is
   * the only place `retainedFrom` goes up.
   */
  private pruneArchives(): boolean {
    if (!Number.isFinite(this.maxArchives) || this.maxArchives <= 0) return false;
    const keep = Math.max(1, Math.floor(this.maxArchives));
    const archives = this.archiveFiles();
    for (const file of archives.slice(0, Math.max(0, archives.length - keep))) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
    if (archives.length <= keep) return false;
    const from = this.firstSeqOnDisk();
    if (from === null || from <= this.retainedFrom) return false;
    this.retainedFrom = from;
    return true;
  }

  async verifyIntegrity(): Promise<{ valid: boolean; errors: string[] }> {
    const { valid, errors } = await this.verifyChain();
    return { valid, errors };
  }

  /**
   * Check the chain from the newest entry back through the archives.
   *
   * The newest file is `current.jsonl`, or the newest archive when the
   * current file has no entries. A file whose first entry has sequence 1 must
   * start from the genesis hash, and the walk ends there. Any other file must
   * be preceded by an archive that ends with the sequence before it and the
   * hash it names. Only an archive may have nothing before it, because
   * pruning removes archives from the old end; `verifiedFrom` then says
   * where the retained log begins. Whether the log is supposed to begin
   * there is the anchor's question (`from` in `audit-anchor.ts`), not the
   * chain's.
   *
   * Nothing is written. A writer may append or rotate while the files are
   * read, and files read at different moments do not fit together, so a
   * result with errors counts only when nothing changed during the read, or
   * on the third try.
   */
  async verifyChain(): Promise<ChainVerification> {
    for (let attempt = 1; ; attempt++) {
      const before = this.filesMark();
      const result = this.walkChain();
      if (result.valid || attempt === 3 || this.filesMark() === before) return result;
    }
  }

  private filesMark(): string {
    return `${this.currentMark()}|${this.archiveFiles().join('|')}`;
  }

  private walkChain(): ChainVerification {
    const errors: string[] = [];
    const current = readChainFile(this.currentLogPath, 'Entry ');
    errors.push(...current.errors);

    const archives = this.archiveFiles();
    let older = archives.length - 1;
    const nextOlder = (): { file: ChainFile; name: string } | null => {
      while (older >= 0) {
        const name = path.basename(archives[older]);
        const file = readChainFile(archives[older], `Archive ${name} entry `);
        older--;
        if (file.lines.length > 0) return { file, name };
      }
      return null;
    };

    let file: ChainFile = current;
    let where = 'The log';
    let entryLabel = 'Entry ';
    let isCurrent = true;
    if (file.lines.length === 0) {
      const newest = nextOlder();
      if (!newest) {
        return { valid: errors.length === 0, errors, entries: 0, lastSeq: 0, lastHash: GENESIS_HASH, verifiedFrom: null };
      }
      file = newest.file;
      where = `Archive ${newest.name}`;
      entryLabel = `${where} entry `;
      isCurrent = false;
      errors.push(...file.errors);
    }

    const last = file.lines[file.lines.length - 1];
    const lastSeq = last.seq;
    const lastHash = last.entry?.hash ?? GENESIS_HASH;
    let verifiedFrom = file.lines[0].seq;

    for (;;) {
      const first = file.lines[0];
      verifiedFrom = first.seq;
      // A first line that is not an entry is already reported, and there is no link to follow from it.
      if (!first.entry) break;
      if (first.seq === 1) {
        if (first.entry.previousHash !== GENESIS_HASH) {
          errors.push(`${entryLabel}0: previousHash mismatch (expected ${GENESIS_HASH}, got ${first.entry.previousHash})`);
        }
        break;
      }
      const before = nextOlder();
      if (!before) {
        if (isCurrent) {
          errors.push(`The log starts at sequence ${first.seq}, and the archive that holds sequence ${first.seq - 1} is missing`);
        }
        break;
      }
      errors.push(...before.file.errors);
      const end = before.file.lines[before.file.lines.length - 1];
      if (end.seq !== first.seq - 1) {
        errors.push(`${where} starts at sequence ${first.seq}, but archive ${before.name} ends at sequence ${end.seq}`);
        break;
      }
      if (end.entry && end.entry.hash !== first.entry.previousHash) {
        errors.push(`${where} does not link to archive ${before.name}: previousHash mismatch at sequence ${first.seq} (expected ${end.entry.hash}, got ${first.entry.previousHash})`);
        break;
      }
      file = before.file;
      where = `Archive ${before.name}`;
      entryLabel = `${where} entry `;
      isCurrent = false;
    }

    return { valid: errors.length === 0, errors, entries: current.lines.length, lastSeq, lastHash, verifiedFrom };
  }

  /**
   * The hash of the entry with this sequence number in the retained files, or
   * `null` when no retained file holds it. Read from disk, newest file first.
   */
  async hashAt(seq: number): Promise<string | null> {
    for (const file of [this.currentLogPath, ...this.archiveFiles().reverse()]) {
      const { lines } = readChainFile(file, '');
      const line = lines.find((l) => l.seq === seq);
      if (line) return line.entry?.hash ?? null;
    }
    return null;
  }

  async getEntries(options?: {
    limit?: number;
    offset?: number;
    type?: AuditEntry['type'];
    sessionId?: string;
  }): Promise<AuditEntry[]> {
    if (!fs.existsSync(this.currentLogPath)) {
      return [];
    }

    const content = fs.readFileSync(this.currentLogPath, 'utf-8');
    // Only whole lines. A writer in another process may be in the middle of an
    // append, and the part of a line it has written so far is not an entry yet.
    const whole = content.slice(0, content.lastIndexOf('\n') + 1);
    const lines = whole.split('\n').filter(line => line.trim().length > 0);

    // Listing shows what can be read; a line that is not an entry is for
    // `verifyChain()` to report, not a reason to show nothing.
    let entries: AuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // skipped
      }
    }

    // Apply filters
    if (options?.type) {
      entries = entries.filter(e => e.type === options.type);
    }
    if (options?.sessionId) {
      entries = entries.filter(e => e.sessionId === options.sessionId);
    }

    // Apply pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? entries.length;

    return entries.slice(offset, offset + limit);
  }

  async tail(count: number = 10): Promise<AuditEntry[]> {
    const entries = await this.getEntries();
    return entries.slice(-count);
  }

  getStats(): { entryCount: number; lastHash: string } {
    return {
      entryCount: this.entryCount,
      lastHash: this.lastHash
    };
  }

  /**
   * Where the log ends: the sequence and hash of the newest entry this logger
   * has written or found. Sequence 0 and the genesis hash when there is none.
   */
  getPosition(): { lastSeq: number; lastHash: string } {
    return { lastSeq: this.lastSeq, lastHash: this.lastHash };
  }

  /**
   * The lowest sequence that is supposed to be on disk: 1 for a log this
   * logger found whole, the first sequence present for one that already began
   * later, and the first sequence of the oldest archive kept after this
   * logger pruned. It never goes down.
   */
  getRetainedFrom(): number {
    return this.retainedFrom;
  }

  /** Call `listener` after each entry is written. One listener; `null` removes it. */
  onEntryWritten(listener: (() => void) | null): void {
    this.entryListener = listener;
  }

  /** Call `listener` after pruning moved the beginning of the log. One listener; `null` removes it. */
  onPruned(listener: (() => void) | null): void {
    this.pruneListener = listener;
  }

  /** Move the current file into `archive/`, under the lock every write takes. */
  async rotateLog(): Promise<string> {
    if (this.readOnly) {
      throw new Error('This audit log was opened for reading only; it is not rotated through this logger');
    }
    if (!fs.existsSync(this.currentLogPath)) {
      throw new Error('No log file to rotate');
    }
    return this.locked(() => {
      this.catchUp();
      return this.rotateUnlocked();
    });
  }

  private rotateUnlocked(): string {
    const archiveDir = path.join(this.logDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    // Archive names sort in rotation order, and that order is what links the
    // files. Two rotations in one millisecond must not share a name, and a
    // new archive must sort after every existing one.
    const nameAt = (time: number) => `audit-${new Date(time).toISOString().replace(/[:.]/g, '-')}.jsonl`;
    const newest = this.archiveFiles().pop();
    const newestName = newest === undefined ? '' : path.basename(newest);
    let name = nameAt(Date.now());
    if (name <= newestName) {
      // Same millisecond, or a clock that went back: one millisecond after
      // the newest archive's own time. A name with no time in it gets a suffix.
      const m = /^audit-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/.exec(newestName);
      name = m
        ? nameAt(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) + 1)
        : `${newestName.slice(0, -'.jsonl'.length)}_1.jsonl`;
    }
    const archivePath = path.join(archiveDir, name);

    fs.renameSync(this.currentLogPath, archivePath);

    // The new file starts empty. The sequence and the last hash carry over,
    // so its first entry links to the last entry of the archive. The archive
    // is the same file under a new name, so `endOfKnown` still points into it.
    this.entryCount = 0;
    this.seen = this.currentMark();

    return archivePath;
  }
}

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  return new AuditLogger(options);
}
