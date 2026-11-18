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
}

const DEFAULT_MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_ARCHIVES = 10;

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

function readLines(file: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  return content.trim().split('\n').filter(line => line.length > 0);
}

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
  private enabled: boolean;
  private walEnabled: boolean;
  private maxLogSizeBytes: number;
  private maxArchives: number;
  private lastHash: string = GENESIS_HASH;
  private lastSeq: number = 0;
  private entryCount: number = 0;
  private initialized: boolean = false;
  private entryListener: (() => void) | null = null;

  constructor(options: AuditLoggerOptions) {
    this.logDir = expandPath(options.logDir);
    this.currentLogPath = path.join(this.logDir, 'current.jsonl');
    this.walPath = path.join(this.logDir, 'current.wal');
    this.enabled = options.enabled ?? true;
    this.walEnabled = options.walEnabled ?? true;
    this.maxLogSizeBytes = options.maxLogSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES;
    this.maxArchives = options.maxArchives ?? DEFAULT_MAX_ARCHIVES;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.enabled) {
      this.initialized = true;
      return;
    }

    // Ensure directories exist
    const archiveDir = path.join(this.logDir, 'archive');
    const integrityDir = path.join(this.logDir, 'integrity');

    fs.mkdirSync(this.logDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(integrityDir, { recursive: true, mode: 0o700 });

    // Recover state from existing log
    await this.recoverState();

    // Recover from WAL if present
    if (this.walEnabled) {
      await this.recoverFromWal();
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
  private async recoverState(): Promise<void> {
    const lines = readLines(this.currentLogPath);
    this.entryCount = lines.length;

    let source = lines;
    if (source.length === 0) {
      const archives = this.archiveFiles();
      for (let i = archives.length - 1; i >= 0 && source.length === 0; i--) source = readLines(archives[i]);
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

  private async recoverFromWal(): Promise<void> {
    if (!fs.existsSync(this.walPath)) {
      return;
    }

    const walContent = fs.readFileSync(this.walPath, 'utf-8');
    const lines = walContent.trim().split('\n').filter(line => line.length > 0);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // A crash after the main log was written and before the WAL was
        // cleared leaves the entry in both. Writing it twice would break the chain.
        if (entry.hash === this.lastHash) continue;
        // Write to main log
        fs.appendFileSync(this.currentLogPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
        this.lastHash = entry.hash;
        this.lastSeq = Number.isSafeInteger(entry.seq) ? (entry.seq as number) : this.lastSeq + 1;
        this.entryCount++;
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
    if (!this.initialized) {
      await this.initialize();
    }

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

    // Whoever anchors the log learns that it grew. The entry is on disk
    // already, so nothing the listener does can undo or fail the write.
    try {
      this.entryListener?.();
    } catch {
      // the listener's own problem
    }

    // Auto-rotate if the current log has crossed the size threshold.
    if (this.maxLogSizeBytes > 0) {
      try {
        const { size } = fs.statSync(this.currentLogPath);
        if (size >= this.maxLogSizeBytes) {
          await this.rotateLog();
          this.pruneArchives();
        }
      } catch {
        // statSync failed (e.g. file removed between write and stat) — skip rotation
      }
    }

    return entry;
  }

  /**
   * Delete archive files beyond `maxArchives`, oldest first. The newest
   * archive is never deleted, whatever the setting: the current file's first
   * entry links to it, and verification needs it to follow that link.
   */
  private pruneArchives(): void {
    if (!Number.isFinite(this.maxArchives) || this.maxArchives <= 0) return;
    const keep = Math.max(1, Math.floor(this.maxArchives));
    const archives = this.archiveFiles();
    for (const file of archives.slice(0, Math.max(0, archives.length - keep))) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort
      }
    }
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
   * where the retained log begins.
   */
  async verifyChain(): Promise<ChainVerification> {
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
    const lines = content.trim().split('\n').filter(line => line.length > 0);

    let entries: AuditEntry[] = lines.map(line => JSON.parse(line) as AuditEntry);

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

  /** Call `listener` after each entry is written. One listener; `null` removes it. */
  onEntryWritten(listener: (() => void) | null): void {
    this.entryListener = listener;
  }

  async rotateLog(): Promise<string> {
    if (!fs.existsSync(this.currentLogPath)) {
      throw new Error('No log file to rotate');
    }

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
    // so its first entry links to the last entry of the archive.
    this.entryCount = 0;

    return archivePath;
  }
}

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  return new AuditLogger(options);
}
