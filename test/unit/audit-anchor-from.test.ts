/**
 * The audit anchor beyond one writer and one end of the log: `from` (where
 * the log is supposed to begin), several processes anchoring into one store,
 * the write that follows pruning, the bound on the last write at shutdown,
 * and the second look `audit verify` takes before it reports a difference.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, CachingStore, MemoryStore, type CredentialStore } from 'aquaman-core';
import {
  AUDIT_ANCHOR_KEY,
  AuditAnchorFormatError,
  RESERVED_SERVICE,
  acceptAuditLog,
  compareLogWithAnchor,
  createAuditAnchorWriter,
  readAuditAnchor,
  verifyAuditLog,
  writeAuditAnchor,
  type AuditAnchor,
} from 'aquaman-proxy';
import { DEFAULT_ANCHOR_STOP_TIMEOUT_MS } from '../../packages/proxy/src/audit-anchor.js';
import { auditVerifyCommand } from '../../packages/proxy/src/cli/audit-commands.js';
import { CountingStore } from '../helpers/counting-store.js';

const access = { service: 'github', operation: 'use' as const, success: true };
const HASH = 'ab'.repeat(32);

describe('audit anchor: where the log begins, and several writers', () => {
  let dir: string;
  let inner: MemoryStore;
  let store: CountingStore;
  let reports: string[];

  const fill = async (logger: AuditLogger, count: number) => {
    for (let i = 0; i < count; i++) await logger.logCredentialAccess('s', 'agent', access);
  };
  const stored = async (): Promise<AuditAnchor | null> => {
    const raw = await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
    return raw === null ? null : JSON.parse(raw);
  };
  const put = (anchor: Record<string, unknown>) =>
    inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify({ v: 1, at: '2026-11-18T10:00:00.000Z', ...anchor }));
  const writer = (logger: AuditLogger, overrides: { store?: CredentialStore; intervalSeconds?: number; stopTimeoutMs?: number } = {}) =>
    createAuditAnchorWriter({
      logger,
      store: overrides.store ?? store,
      intervalSeconds: overrides.intervalSeconds ?? 3600,
      stopTimeoutMs: overrides.stopTimeoutMs,
      report: (line) => reports.push(line),
    });
  const open = async (options: Partial<ConstructorParameters<typeof AuditLogger>[0]> = {}, logDir = dir) => {
    const logger = new AuditLogger({ logDir, ...options });
    await logger.initialize();
    return logger;
  };
  /** A logger that rotates after every entry and keeps one archive, so every entry after the first prunes. */
  const pruning = () => open({ maxLogSizeBytes: 1, maxArchives: 1 });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const reader = () => open({ readOnly: true });
  const verify = (from: CredentialStore = store) => reader().then((logger) => verifyAuditLog({ logger, openStore: async () => from, anchoring: true }));
  const current = () => path.join(dir, 'current.jsonl');
  const lines = () => fs.readFileSync(current(), 'utf-8').trim().split('\n');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-anchor-from-'));
    inner = new MemoryStore();
    store = new CountingStore(inner);
    reports = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('the stored value', () => {
    it('carries `from` when it is given one and leaves it out when it is not, and reads back the same', async () => {
      const withFrom = await writeAuditAnchor(inner, { seq: 9, hash: HASH, from: 4 });
      expect(withFrom).toMatchObject({ v: 1, seq: 9, hash: HASH, from: 4 });
      expect(await readAuditAnchor(inner)).toEqual(withFrom);

      const without = await writeAuditAnchor(inner, { seq: 9, hash: HASH });
      expect('from' in without).toBe(false);
      const read = await readAuditAnchor(inner);
      expect(read).toEqual(without);
      expect('from' in read!).toBe(false);
    });

    it.each([0, -1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 2])('a `from` of %s is not an anchor', async (from) => {
      await put({ seq: 9, hash: HASH, from });
      await expect(readAuditAnchor(inner)).rejects.toThrow(AuditAnchorFormatError);
    });
  });

  describe('compareLogWithAnchor', () => {
    it('names a log that begins later than `from` as head_missing, with the range, and passes one that begins at or before it', async () => {
      const logger = await open();
      await fill(logger, 6);
      const { lastHash } = logger.getPosition();
      const anchor = (from?: number): AuditAnchor => ({ v: 1, seq: 6, hash: lastHash, at: '2026-11-18T10:00:00.000Z', ...(from === undefined ? {} : { from }) });

      expect(await compareLogWithAnchor(logger, anchor(2), 6, 5)).toEqual({
        state: 'head_missing',
        unanchored: 0,
        message: 'entries 2 to 4 are missing: they were on disk when the anchor was written (2026-11-18T10:00:00.000Z), and the log now begins at sequence 5',
      });
      expect((await compareLogWithAnchor(logger, anchor(5), 6, 5)).state).toBe('matches');
      expect((await compareLogWithAnchor(logger, anchor(5), 6, 1)).state).toBe('matches');
      // An anchor without `from`, and a log with no beginning to speak of, are not compared on it.
      expect((await compareLogWithAnchor(logger, anchor(), 6, 5)).state).toBe('matches');
      expect((await compareLogWithAnchor(logger, anchor(1), 6, null)).state).toBe('matches');
      // Left out, the beginning is the logger's own figure.
      expect((await compareLogWithAnchor(logger, anchor(1))).state).toBe('matches');
    });

    it('a different entry at the anchored sequence is reported before a missing head', async () => {
      const logger = await open();
      await fill(logger, 6);
      const result = await compareLogWithAnchor(logger, { v: 1, seq: 6, hash: HASH, at: 'then', from: 1 }, 6, 5);
      expect(result.state).toBe('rebuilt');
    });
  });

  describe('the writer and `from`', () => {
    it('anchors a log that was never pruned with from 1', async () => {
      const logger = await open();
      const w = writer(logger);
      await w.ready;
      await fill(logger, 3);
      await w.stop();
      expect(await stored()).toMatchObject({ seq: 3, from: 1 });
    });

    it('anchors a log that already began later when it was first opened, and had no anchor, from where it began', async () => {
      await fill(await open(), 6);
      const entries = lines();
      fs.writeFileSync(path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries[3] + '\n');
      fs.writeFileSync(current(), entries.slice(4).join('\n') + '\n');

      const logger = await open();
      const w = writer(logger);
      await w.ready;
      await w.stop();
      expect(await stored()).toMatchObject({ seq: 6, from: 4 });
      expect((await verify()).valid).toBe(true);
    });

    it('writes at once after pruning, with the new beginning, and does not wait for the interval', async () => {
      const logger = await pruning();
      const w = writer(logger);
      await w.ready;
      await fill(logger, 1);
      await settle();
      // One archive, nothing pruned, an hour until the first write.
      expect(store.sets).toBe(0);

      await fill(logger, 1);
      await settle();
      expect(store.sets).toBe(1);
      expect(await stored()).toMatchObject({ seq: 2, from: 2 });
      expect(logger.getRetainedFrom()).toBe(2);
      expect(await verify()).toMatchObject({ valid: true, chain: { verifiedFrom: 2 }, anchor: { status: 'matches', from: 2 } });

      await fill(logger, 2);
      await settle();
      expect(await stored()).toMatchObject({ seq: 4, from: 4 });
      await w.stop();
      expect(reports).toEqual([]);
    });

    it('a write after pruning that fails is reported and tried again at the interval, without a new entry', async () => {
      const logger = await pruning();
      const w = writer(logger, { intervalSeconds: 0.05 });
      await w.ready;
      const set = vi.spyOn(inner, 'set').mockRejectedValueOnce(new Error('vault is locked'));
      await fill(logger, 2);
      await settle();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatch(/^AUDIT FAILURE: could not write the audit anchor to the credential store: vault is locked\. .*entries after sequence 0 are not anchored yet/);
      expect(await stored()).toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(set).toHaveBeenCalledTimes(2);
      expect(await stored()).toMatchObject({ seq: 2, from: 2 });
      await w.stop();
    });

    it('pruning in a process whose anchoring is paused writes nothing', async () => {
      await put({ seq: 40, hash: HASH, from: 1 });
      const logger = await pruning();
      const w = writer(logger);
      await w.ready;
      expect(w.isPaused()).toBe(true);
      await fill(logger, 4);
      await settle();
      await w.stop();
      expect(store.sets).toBe(0);
      expect(await stored()).toMatchObject({ seq: 40, from: 1 });
    });

    it('after stop, pruning is no longer listened to', async () => {
      const logger = await pruning();
      const w = writer(logger);
      await w.ready;
      await w.stop();
      await fill(logger, 4);
      await settle();
      expect(store.sets).toBe(0);
    });

    it('a process that starts on a log that begins later than its anchor says pauses and reports the range', async () => {
      await fill(await open(), 6);
      await put({ seq: 6, hash: (await open()).getPosition().lastHash, from: 1 });
      const entries = lines();
      fs.writeFileSync(path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries[3] + '\n');
      fs.writeFileSync(current(), entries.slice(4).join('\n') + '\n');

      const logger = await open();
      const w = writer(logger);
      await w.ready;
      expect(w.isPaused()).toBe(true);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain('AUDIT FAILURE: the audit log does not match its anchor: entries 1 to 3 are missing');
      await fill(logger, 2);
      await w.stop();
      expect(store.sets).toBe(0);
    });

    it('its own pruning before the store could first be read is not taken for missing entries', async () => {
      // Three archives of one entry each, anchored at 3, nothing pruned.
      const earlier = await open({ maxLogSizeBytes: 1, maxArchives: 0 });
      await fill(earlier, 3);
      await put({ seq: 3, hash: earlier.getPosition().lastHash, from: 1 });

      const logger = await open({ maxLogSizeBytes: 1, maxArchives: 2 });
      const get = vi.spyOn(inner, 'get').mockRejectedValueOnce(new Error('vault is locked'));
      const w = writer(logger);
      await w.ready;
      expect(reports).toHaveLength(1);

      // Pruned while the anchor was still unread. The log now begins at 3, by this process's own doing.
      await fill(logger, 1);
      await w.flush();
      expect(get).toHaveBeenCalled();
      expect(logger.getRetainedFrom()).toBe(3);
      expect(w.isPaused()).toBe(false);
      expect(reports).toHaveLength(1);
      expect(await stored()).toMatchObject({ seq: 4, from: 3 });
      expect((await verify()).valid).toBe(true);
      await w.stop();
    });
  });

  describe('several processes anchoring into one store', () => {
    it('a writer whose log reads lower than the stored anchor does not move it back, whatever it read when it started', async () => {
      // Two logs, one store: B starts first and finds no anchor.
      const logA = await open({}, path.join(dir, 'a'));
      const logB = await open({}, path.join(dir, 'b'));
      await fill(logA, 5);
      await fill(logB, 3);
      const b = writer(logB);
      await b.ready;
      const a = writer(logA);
      await a.flush();
      expect(await stored()).toMatchObject({ seq: 5 });
      const anchored = await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);

      await b.flush();
      await b.stop();
      expect(await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY)).toBe(anchored);
      expect(store.sets).toBe(1);
      await a.stop();
      expect(reports).toEqual([]);
    });

    it('two processes on one log: the one that last wrote anchors, the other finds the anchor further on and leaves it', async () => {
      const logA = await open();
      const logB = await open();
      const a = writer(logA);
      const b = writer(logB);
      await Promise.all([a.ready, b.ready]);
      await fill(logB, 2);
      await fill(logA, 3);
      await a.flush();
      expect(await stored()).toMatchObject({ seq: 5, from: 1 });
      // B knows the log up to its own last write, sequence 2.
      await b.flush();
      expect(await stored()).toMatchObject({ seq: 5, from: 1 });
      expect(store.sets).toBe(1);

      await fill(logB, 1);
      await b.stop();
      await a.stop();
      expect(await stored()).toMatchObject({ seq: 6, from: 1 });
      expect(store.sets).toBe(2);
      expect((await verify()).valid).toBe(true);
    });

    it('each process behind its own cache: the anchor another process wrote is read from the backend, not from memory', async () => {
      // Two processes on one log, as in daemons with a backend whose reads are cached for 15 minutes.
      const cacheA = new CachingStore(inner, 900);
      const cacheB = new CachingStore(store, 900);
      const logA = await open();
      await fill(logA, 2);
      const a = writer(logA, { store: cacheA });
      await a.flush();
      // B starts and reads the anchor at 2 into its cache, then writes entry 3.
      const logB = await open();
      const b = writer(logB, { store: cacheB });
      await b.ready;
      expect(store.gets).toBe(1);
      await fill(logB, 1);

      await fill(logA, 2);
      await a.flush();
      expect(await stored()).toMatchObject({ seq: 5 });

      // B knows the log up to 3 and remembers an anchor at 2. The store holds 5.
      await b.flush();
      expect(store.gets).toBe(2);
      expect(store.sets).toBe(0);
      expect(await stored()).toMatchObject({ seq: 5 });
      await a.stop();
      await b.stop();
      expect((await verify()).valid).toBe(true);
    });

    it('a process that reads the anchor late, after another wrote and anchored further, is not taken to be behind its anchor', async () => {
      const logB = await open();
      const get = vi.spyOn(inner, 'get').mockRejectedValueOnce(new Error('vault is locked'));
      const b = writer(logB);
      await b.ready;
      expect(reports).toHaveLength(1);
      await fill(logB, 1);

      // Another process on the same log goes on to 4 and anchors it. B still knows the log up to 1.
      const logA = await open();
      await fill(logA, 3);
      const a = writer(logA);
      await a.flush();
      expect(await stored()).toMatchObject({ seq: 4 });

      await b.flush();
      expect(get).toHaveBeenCalled();
      expect(b.isPaused()).toBe(false);
      expect(reports).toHaveLength(1);
      expect(await stored()).toMatchObject({ seq: 4 });
      await fill(logB, 1);
      await b.stop();
      await a.stop();
      expect(await stored()).toMatchObject({ seq: 5 });
    });

    it('`from` never goes down: a writer that never pruned keeps the beginning another process recorded', async () => {
      const logger = await open();
      await fill(logger, 4);
      const w = writer(logger);
      await w.ready;
      // Another process pruned and said so, after this one started.
      await put({ seq: 2, hash: (await reader().then((r) => r.hashAt(2)))!, from: 2 });
      await fill(logger, 1);
      await w.stop();
      expect(logger.getRetainedFrom()).toBe(1);
      expect(await stored()).toMatchObject({ seq: 5, from: 2 });
    });

    it('a writer that pruned tells an anchor that is further on where the log begins now, and keeps that anchor\'s entry', async () => {
      const logger = await pruning();
      const w = writer(logger);
      await w.ready;
      // Another process on the same log is further on.
      await put({ seq: 50, hash: HASH, from: 1 });
      await fill(logger, 2);
      await settle();
      expect(await stored()).toMatchObject({ seq: 50, hash: HASH, from: 2 });
      // Nothing more to say: the next write is skipped.
      await w.stop();
      expect(store.sets).toBe(1);
    });

    it('an anchor without `from` that is further on is given one, and its entry is kept', async () => {
      const logger = await open();
      const w = writer(logger);
      await w.ready;
      await put({ seq: 50, hash: HASH });
      await fill(logger, 2);
      await w.stop();
      expect(await stored()).toMatchObject({ seq: 50, hash: HASH, from: 1 });
    });

    it('an anchor without `from` that is behind is replaced by one with it', async () => {
      const logger = await open();
      await fill(logger, 2);
      await put({ seq: 2, hash: logger.getPosition().lastHash });
      const w = writer(logger);
      await w.ready;
      await fill(logger, 1);
      await w.stop();
      const anchor = await stored();
      expect(anchor).toMatchObject({ seq: 3, from: 1 });
    });

    it('a stored value that stopped being an anchor while the process ran is reported once and not overwritten', async () => {
      const logger = await open();
      const w = writer(logger);
      await w.ready;
      await inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, 'replaced by something else');
      await fill(logger, 2);
      await w.flush();
      expect(w.isPaused()).toBe(true);
      expect(reports).toEqual([
        `AUDIT FAILURE: the value stored at ${RESERVED_SERVICE}/${AUDIT_ANCHOR_KEY} is not an audit anchor, so the audit log cannot be checked against it. No new anchor is written. Run: aquaman audit verify`,
      ]);
      await fill(logger, 1);
      await w.stop();
      expect(store.sets).toBe(0);
      expect(await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY)).toBe('replaced by something else');
      expect(reports).toHaveLength(1);
    });

    it('a store that cannot be read just before a write is reported, nothing is written blind, and the write is tried again', async () => {
      const logger = await open();
      const w = writer(logger, { intervalSeconds: 0.05 });
      await w.ready;
      const get = vi.spyOn(inner, 'get').mockRejectedValueOnce(new Error('vault is locked'));
      await fill(logger, 2);
      await w.flush();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatch(/^AUDIT FAILURE: could not read the audit anchor from the credential store: vault is locked\./);
      expect(store.sets).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await stored()).toMatchObject({ seq: 2, from: 1 });
      await w.stop();
    });
  });

  describe('stopping', () => {
    it('waits five seconds at most by default', () => {
      expect(DEFAULT_ANCHOR_STOP_TIMEOUT_MS).toBe(5000);
    });

    it.each([
      ['write', (s: MemoryStore) => { s.set = () => new Promise<void>(() => {}); }],
      ['read', (s: MemoryStore) => { s.get = () => new Promise<string | null>(() => {}); }],
    ])('a store whose %s never answers does not hold up the process: stop settles after the bound and says the last anchor was not written', async (_what, hang) => {
      const logger = await open();
      const w = writer(logger, { stopTimeoutMs: 80 });
      await w.ready;
      await fill(logger, 3);
      hang(inner);

      const started = Date.now();
      await w.stop();
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(75);
      expect(took).toBeLessThan(2000);
      expect(reports).toEqual([
        'AUDIT FAILURE: the last audit anchor was not written: the credential store did not answer within 80 ms while stopping. ' +
        'Entries after sequence 0 are not anchored until a proxy runs again. Run: aquaman audit verify',
      ]);
    });

    it('a store that answers in time is not reported, and the bound leaves no timer behind', async () => {
      vi.useFakeTimers();
      try {
        const logger = await open();
        const w = writer(logger, { stopTimeoutMs: 60_000 });
        await w.ready;
        await fill(logger, 2);
        await w.stop();
        expect(await stored()).toMatchObject({ seq: 2 });
        expect(reports).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('verifyAuditLog', () => {
    it('reports a missing head as invalid, with the range and the fix, and includes the anchor\'s `from`', async () => {
      const logger = await open();
      await fill(logger, 6);
      await writeAuditAnchor(inner, { seq: 6, hash: logger.getPosition().lastHash, from: 1 });
      const entries = lines();
      fs.writeFileSync(path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries[3] + '\n');
      fs.writeFileSync(current(), entries.slice(4).join('\n') + '\n');

      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain).toMatchObject({ valid: true, verifiedFrom: 4 });
      expect(result.anchor).toMatchObject({ status: 'head_missing', seq: 6, from: 1 });
      expect(result.anchor.message).toMatch(/^entries 1 to 3 are missing: they were on disk when the anchor was written \(.*\), and the log now begins at sequence 4$/);
      expect(result.anchor.unanchored).toBeUndefined();
      expect(result.fix).toContain('aquaman audit accept');
    });

    it('a difference that a serving process caused between the two reads is not reported: the second look decides', async () => {
      const serving = await open();
      await fill(serving, 5);
      await writeAuditAnchor(inner, { seq: 5, hash: serving.getPosition().lastHash, from: 1 });

      // The log has been read up to 5. Before the anchor is read, the process writes two entries and anchors them.
      const get = inner.get.bind(inner);
      let opened = 0;
      let reads = 0;
      inner.get = async (service, key) => {
        if (reads++ === 0) {
          await fill(serving, 2);
          await writeAuditAnchor(inner, { seq: 7, hash: serving.getPosition().lastHash, from: 1 });
        }
        return get(service, key);
      };
      const result = await verifyAuditLog({ logger: await reader(), openStore: async () => { opened++; return inner; }, anchoring: true });
      expect(result.valid).toBe(true);
      expect(result.anchor).toMatchObject({ status: 'matches', seq: 7, unanchored: 0 });
      expect(result.chain.lastSeq).toBe(7);
      expect(reads).toBe(2);
      expect(opened).toBe(1);
    });

    it('a difference that is still there at the second look is reported, and the store is opened once', async () => {
      const logger = await open();
      await fill(logger, 3);
      await put({ seq: 9, hash: HASH, from: 1 });
      let opened = 0;
      const result = await verifyAuditLog({ logger: await reader(), openStore: async () => { opened++; return store; }, anchoring: true });
      expect(result).toMatchObject({ valid: false, anchor: { status: 'truncated', seq: 9 } });
      expect(store.gets).toBe(2);
      expect(opened).toBe(1);
    });

    it('a matching anchor is read once', async () => {
      const logger = await open();
      await fill(logger, 3);
      await writeAuditAnchor(inner, { seq: 3, hash: logger.getPosition().lastHash, from: 1 });
      expect((await verify()).valid).toBe(true);
      expect(store.gets).toBe(1);
    });
  });

  describe('audit verify, printed', () => {
    const printed = async (from: CredentialStore = store): Promise<{ code: number; out: string }> => {
      const out: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((line: string) => { out.push(line); });
      const code = await auditVerifyCommand({}, { config: { audit: { enabled: true, logDir: dir } }, openStore: async () => from, proxyRunning: async () => false });
      vi.restoreAllMocks();
      return { code, out: out.join('\n') };
    };

    it('says where the anchor has the log begin after pruning', async () => {
      const logger = await pruning();
      const w = writer(logger);
      await w.ready;
      await fill(logger, 4);
      await w.stop();
      const { code, out } = await printed();
      expect(code).toBe(0);
      expect(out).toContain('  Sequence: 4 to 4 (verified from sequence 4, where the anchor says the log begins)');
    });

    it('says so when nothing says where the log should begin, and lists a missing head as the failure', async () => {
      const logger = await open();
      await fill(logger, 6);
      const entries = lines();
      fs.writeFileSync(path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries[3] + '\n');
      fs.writeFileSync(current(), entries.slice(4).join('\n') + '\n');

      // No anchor at all.
      const bare = await printed();
      expect(bare.code).toBe(0);
      expect(bare.out).toContain('  Sequence: 4 to 6 (verified from sequence 4; earlier entries are not on disk, and no anchor says whether they should be)');

      // An anchor without `from`.
      await writeAuditAnchor(inner, { seq: 6, hash: logger.getPosition().lastHash });
      const legacy = await printed();
      expect(legacy.code).toBe(0);
      expect(legacy.out).toContain('(verified from sequence 4; earlier entries are not on disk, and no anchor says whether they should be)');
      expect(legacy.out).toContain('the log begins at sequence 4 and this anchor does not record where it should begin, so it was not checked for missing early entries');

      // An anchor that says the log begins at 1.
      await writeAuditAnchor(inner, { seq: 6, hash: logger.getPosition().lastHash, from: 1 });
      const failed = await printed();
      expect(failed.code).toBe(1);
      expect(failed.out).toContain('Audit log integrity FAILED');
      expect(failed.out).toMatch(/ {2}- Anchor: entries 1 to 3 are missing: they were on disk when the anchor was written/);
      expect(failed.out).toContain('aquaman audit accept');
    });
  });

  describe('acceptAuditLog', () => {
    it('sets `from` to the first entry that is on disk', async () => {
      const logger = await open();
      await fill(logger, 6);
      await writeAuditAnchor(inner, { seq: 6, hash: logger.getPosition().lastHash, from: 1 });
      const entries = lines();
      fs.writeFileSync(path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries[3] + '\n');
      fs.writeFileSync(current(), entries.slice(4).join('\n') + '\n');
      expect((await verify()).anchor.status).toBe('head_missing');

      expect(await acceptAuditLog({ logger: new AuditLogger({ logDir: dir }), store })).toEqual({ accepted: true, previousSeq: 6, seq: 7 });
      expect(await stored()).toMatchObject({ seq: 7, from: 4 });
      expect(await verify()).toMatchObject({ valid: true, chain: { verifiedFrom: 4 }, anchor: { status: 'matches', from: 4 } });
    });

    it('on an empty log, `from` is the entry that records the reset', async () => {
      await put({ seq: 6, hash: HASH, from: 3 });
      expect(await acceptAuditLog({ logger: new AuditLogger({ logDir: dir }), store })).toEqual({ accepted: true, previousSeq: 6, seq: 1 });
      expect(await stored()).toMatchObject({ seq: 1, from: 1 });
      expect((await verify()).valid).toBe(true);
    });
  });
});
