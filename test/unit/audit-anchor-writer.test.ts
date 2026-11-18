/**
 * The audit anchor: reading and writing it, comparing the log with it, the
 * writer a serving process runs (debounce, idle, failure, shutdown, forward
 * only), and what `audit verify` and `audit accept` do with it.
 *
 * The store is a MemoryStore behind a counter, so each test can say exactly
 * how many times the backend was written to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, MemoryStore, type CredentialStore } from 'aquaman-core';
import {
  AUDIT_ANCHOR_KEY,
  AuditAnchorFormatError,
  DEFAULT_ANCHOR_INTERVAL_SECONDS,
  RESERVED_SERVICE,
  acceptAuditLog,
  compareLogWithAnchor,
  createAuditAnchorWriter,
  readAuditAnchor,
  resolveAnchorInterval,
  startAuditAnchor,
  verifyAuditLog,
  writeAuditAnchor,
  type AuditAnchor,
} from 'aquaman-proxy';
import { CountingStore } from '../helpers/counting-store.js';

const access = { service: 'github', operation: 'use' as const, success: true };
const INTERVAL = 60;

describe('audit anchor', () => {
  let dir: string;
  let logger: AuditLogger;
  let inner: MemoryStore;
  let store: CountingStore;
  let reports: string[];

  const fill = async (count: number, to: AuditLogger = logger) => {
    for (let i = 0; i < count; i++) await to.logCredentialAccess('s', 'agent', access);
  };
  const stored = async (): Promise<AuditAnchor | null> => {
    const raw = await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
    return raw === null ? null : JSON.parse(raw);
  };
  const writer = (overrides: { store?: CredentialStore; logger?: AuditLogger; intervalSeconds?: number } = {}) =>
    createAuditAnchorWriter({
      logger: overrides.logger ?? logger,
      store: overrides.store ?? store,
      intervalSeconds: overrides.intervalSeconds ?? INTERVAL,
      report: (line) => reports.push(line),
    });
  /** Let the interval pass, and everything the timer started settle. */
  const pass = (seconds = INTERVAL) => vi.advanceTimersByTimeAsync(seconds * 1000);

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-anchor-'));
    logger = new AuditLogger({ logDir: dir });
    await logger.initialize();
    inner = new MemoryStore();
    store = new CountingStore(inner);
    reports = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('resolveAnchorInterval', () => {
    it.each([
      ['unset', {}, DEFAULT_ANCHOR_INTERVAL_SECONDS],
      ['unset, keychain', { credentials: { backend: 'keychain' } }, DEFAULT_ANCHOR_INTERVAL_SECONDS],
      ['unset, 1password (a write can prompt)', { credentials: { backend: '1password' } }, 900],
      ['unset, bitwarden', { credentials: { backend: 'bitwarden' } }, 900],
      ['unset, keeper', { credentials: { backend: 'keeper' } }, 900],
      ['set, 1password', { audit: { anchorIntervalSeconds: 30 }, credentials: { backend: '1password' } }, 30],
      ['no audit section', { audit: undefined }, 60],
      ['a number', { audit: { anchorIntervalSeconds: 5 } }, 5],
      ['a fraction', { audit: { anchorIntervalSeconds: 0.5 } }, 0.5],
      ['zero (off)', { audit: { anchorIntervalSeconds: 0 } }, 0],
      ['negative (off)', { audit: { anchorIntervalSeconds: -10 } }, 0],
      ['a string', { audit: { anchorIntervalSeconds: '30' } }, 60],
      ['not a number', { audit: { anchorIntervalSeconds: Number.NaN } }, 60],
      ['infinity', { audit: { anchorIntervalSeconds: Number.POSITIVE_INFINITY } }, 60],
    ])('%s', (_name, config, expected) => {
      expect(resolveAnchorInterval(config as any)).toBe(expected);
    });
  });

  describe('the stored value', () => {
    it('is written through the store under the reserved service, and read back', async () => {
      vi.setSystemTime(new Date('2026-11-18T10:00:00.000Z'));
      const hash = 'ab'.repeat(32);
      const written = await writeAuditAnchor(store, { seq: 7, hash });
      expect(written).toEqual({ v: 1, seq: 7, hash, at: '2026-11-18T10:00:00.000Z' });
      expect(store.sets).toBe(1);
      expect(await inner.list()).toEqual([{ service: 'aquaman_internal', key: 'audit_anchor' }]);
      expect(await readAuditAnchor(store)).toEqual(written);
    });

    it('is null when there is none', async () => {
      expect(await readAuditAnchor(store)).toBeNull();
    });

    it.each([
      ['not JSON', 'nope'],
      ['JSON null', 'null'],
      ['a string', '"anchor"'],
      ['another version', JSON.stringify({ v: 2, seq: 1, hash: 'ab'.repeat(32), at: 'x' })],
      ['a sequence of 0', JSON.stringify({ v: 1, seq: 0, hash: 'ab'.repeat(32), at: 'x' })],
      ['a sequence that is a string', JSON.stringify({ v: 1, seq: '4', hash: 'ab'.repeat(32), at: 'x' })],
      ['a short hash', JSON.stringify({ v: 1, seq: 4, hash: 'abcd', at: 'x' })],
      ['a hash that is not a string', JSON.stringify({ v: 1, seq: 4, hash: 5, at: 'x' })],
      ['no time', JSON.stringify({ v: 1, seq: 4, hash: 'ab'.repeat(32) })],
    ])('a value that is %s is refused as not an anchor', async (_name, value) => {
      await inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, value);
      await expect(readAuditAnchor(store)).rejects.toBeInstanceOf(AuditAnchorFormatError);
      await expect(readAuditAnchor(store)).rejects.toThrow('the value stored at aquaman_internal/audit_anchor is not an audit anchor');
    });

    it('a store that fails is not mistaken for a missing anchor', async () => {
      const broken = { ...inner, get: async () => { throw new Error('vault is locked'); } } as unknown as CredentialStore;
      await expect(readAuditAnchor(broken)).rejects.toThrow('vault is locked');
    });
  });

  describe('compareLogWithAnchor', () => {
    const anchorAt = async (seq: number): Promise<AuditAnchor> =>
      ({ v: 1, seq, hash: (await logger.hashAt(seq)) ?? 'cd'.repeat(32), at: '2026-11-18T10:00:00.000Z' });

    it('matches, and counts the entries after the anchor', async () => {
      await fill(5);
      expect(await compareLogWithAnchor(logger, await anchorAt(3))).toEqual({
        state: 'matches', unanchored: 2, message: 'the anchor matches the entry at sequence 3',
      });
    });

    it('names a log that ends before the anchor as truncated', async () => {
      await fill(2);
      const result = await compareLogWithAnchor(logger, await anchorAt(6));
      expect(result.state).toBe('truncated');
      expect(result.message).toBe('the log is truncated: it ends at sequence 2, and the anchor (written 2026-11-18T10:00:00.000Z) records an entry at sequence 6');
    });

    it('names a log with no entries as missing', async () => {
      const result = await compareLogWithAnchor(logger, await anchorAt(6));
      expect(result.state).toBe('missing');
      expect(result.message).toContain('the log is missing or empty');
    });

    it('names a different entry at the anchored sequence as rebuilt', async () => {
      await fill(4);
      const result = await compareLogWithAnchor(logger, { ...(await anchorAt(4)), hash: 'ef'.repeat(32) });
      expect(result.state).toBe('rebuilt');
      expect(result.message).toContain('the log was rebuilt: its entry at sequence 4 is not the one the anchor');
    });

    it('says so when the anchored entry is in no retained file', async () => {
      await fill(2);
      const first = await logger.rotateLog();
      await fill(2);
      const anchor = await anchorAt(2);
      fs.rmSync(first);
      const result = await compareLogWithAnchor(logger, anchor);
      expect(result.state).toBe('unverifiable');
      expect(result.message).toContain('no retained file holds the anchored entry (sequence 2');
    });

    it('takes the end of the log from the caller when given one', async () => {
      await fill(5);
      expect((await compareLogWithAnchor(logger, await anchorAt(3), 3)).unanchored).toBe(0);
    });
  });

  describe('the writer', () => {
    it('an idle process reads the anchor once and writes nothing, however long it runs', async () => {
      await fill(3);
      await writeAuditAnchor(inner, { seq: 3, hash: logger.getPosition().lastHash });
      const w = writer();
      await w.ready;
      await pass(INTERVAL * 100);
      expect(store.gets).toBe(1);
      expect(store.sets).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await w.stop();
      expect(store.sets).toBe(0);
      expect(reports).toEqual([]);
    });

    it('a process with nothing logged and nothing anchored writes nothing', async () => {
      const w = writer();
      await w.ready;
      await pass(INTERVAL * 3);
      await w.stop();
      expect(store.sets).toBe(0);
      expect(await stored()).toBeNull();
    });

    it('a burst of entries causes one write per interval, not one per entry', async () => {
      const w = writer();
      await w.ready;
      await fill(50);
      expect(store.sets).toBe(0);
      await pass(INTERVAL - 1);
      expect(store.sets).toBe(0);
      await pass(1);
      expect(store.sets).toBe(1);
      expect(await stored()).toMatchObject({ v: 1, seq: 50, hash: logger.getPosition().lastHash });

      // Entries spread over the next interval: still one write, at its end.
      for (let i = 0; i < 20; i++) {
        await fill(1);
        await pass(2);
      }
      expect(store.sets).toBe(1);
      await pass(INTERVAL);
      expect(store.sets).toBe(2);
      expect(await stored()).toMatchObject({ seq: 70 });

      // Then quiet: no timer left, no further write.
      await pass(INTERVAL * 10);
      expect(store.sets).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
      await w.stop();
    });

    it('a log with entries and no anchor (a first start) is anchored after one interval', async () => {
      await fill(4);
      const w = writer();
      await w.ready;
      expect(store.sets).toBe(0);
      await pass();
      expect(store.sets).toBe(1);
      expect(await stored()).toMatchObject({ seq: 4 });
      await w.stop();
    });

    it('entries a killed process left unanchored are anchored after one interval', async () => {
      await fill(2);
      await writeAuditAnchor(inner, { seq: 2, hash: logger.getPosition().lastHash });
      await fill(3);
      const w = writer();
      await w.ready;
      await pass();
      expect(await stored()).toMatchObject({ seq: 5 });
      expect(store.sets).toBe(1);
      await w.stop();
    });

    it('writes once more on shutdown when the log has grown, and not when it has not', async () => {
      const w = writer();
      await w.ready;
      await fill(3);
      await w.stop();
      expect(store.sets).toBe(1);
      expect(await stored()).toMatchObject({ seq: 3 });
      expect(vi.getTimerCount()).toBe(0);

      // After stop the logger is no longer listened to.
      await fill(2);
      await pass(INTERVAL * 2);
      expect(store.sets).toBe(1);
      await w.stop();
      expect(store.sets).toBe(1);
    });

    it('flush writes now and leaves the writer running', async () => {
      const w = writer();
      await fill(2);
      await w.flush();
      expect(await stored()).toMatchObject({ seq: 2 });
      await fill(1);
      await pass();
      expect(await stored()).toMatchObject({ seq: 3 });
      expect(store.sets).toBe(2);
      await w.stop();
    });

    it('a write that fails is reported, does not throw, and is tried again at the next interval', async () => {
      const w = writer();
      await w.ready;
      let failing = true;
      vi.spyOn(inner, 'set').mockImplementation(async function (this: MemoryStore, ...args: Parameters<MemoryStore['set']>) {
        if (failing) throw new Error('op: not signed in');
        return MemoryStore.prototype.set.apply(inner, args);
      });
      await fill(3);
      await pass();
      expect(store.sets).toBe(1);
      expect(reports).toEqual([
        'AUDIT FAILURE: could not write the audit anchor to the credential store: op: not signed in. ' +
        'Requests are still served and logged; entries after sequence 0 are not anchored yet. It is tried again in 60 seconds. Run: aquaman doctor',
      ]);
      expect(await stored()).toBeNull();

      // Still failing: one more attempt per interval, nothing in between.
      await pass(INTERVAL - 1);
      expect(store.sets).toBe(1);
      await pass(1);
      expect(store.sets).toBe(2);
      expect(reports).toHaveLength(2);

      failing = false;
      await pass();
      expect(store.sets).toBe(3);
      expect(await stored()).toMatchObject({ seq: 3 });
      await pass(INTERVAL * 5);
      expect(store.sets).toBe(3);
      expect(reports).toHaveLength(2);
      await w.stop();
    });

    it('a store that throws something that is not an Error is reported the same way', async () => {
      const w = writer();
      await w.ready;
      vi.spyOn(inner, 'set').mockRejectedValue('backend said no');
      await fill(1);
      await w.stop();
      expect(reports[0]).toContain('could not write the audit anchor to the credential store: backend said no.');
    });

    it('a failing shutdown write is reported and stop still resolves', async () => {
      const w = writer();
      await w.ready;
      vi.spyOn(inner, 'set').mockRejectedValue(new Error('disk full'));
      await fill(1);
      await expect(w.stop()).resolves.toBeUndefined();
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatch(/^AUDIT FAILURE: could not write the audit anchor/);
    });

    it('an anchor that cannot be read at start is reported, retried, and nothing is written before it has been read', async () => {
      await fill(2);
      await writeAuditAnchor(inner, { seq: 9, hash: 'ab'.repeat(32) });
      let locked = true;
      vi.spyOn(inner, 'get').mockImplementation(async function (...args: Parameters<MemoryStore['get']>) {
        if (locked) throw new Error('vault is locked');
        return MemoryStore.prototype.get.apply(inner, args);
      });
      const w = writer();
      await w.ready;
      expect(reports).toEqual([
        'AUDIT FAILURE: could not read the audit anchor from the credential store: vault is locked. Requests are still served and logged. It is tried again in 60 seconds. Run: aquaman doctor',
      ]);

      // An entry arrives; the write needs the anchor first, and the store is still locked.
      await fill(1);
      await pass();
      expect(store.sets).toBe(0);
      expect(reports).toHaveLength(2);

      // Unlocked: the stored anchor is ahead of the log, so it is left alone.
      locked = false;
      await fill(1);
      await pass();
      expect(store.sets).toBe(0);
      expect(w.isPaused()).toBe(true);
      expect(await stored()).toMatchObject({ seq: 9 });
      expect(reports[2]).toMatch(/^AUDIT FAILURE: the audit log is behind its anchor/);
      await w.stop();
    });

    it.each([
      ['truncated', async () => { await fill(3); }, 'the audit log is behind its anchor: the log is truncated: it ends at sequence 3'],
      ['missing', async () => {}, 'the audit log is behind its anchor: the log is missing or empty'],
    ])('a log that is behind its anchor at start (%s) is reported, served, and never anchored lower', async (_name, prepare, lead) => {
      await prepare();
      const anchor = await writeAuditAnchor(inner, { seq: 8, hash: 'ab'.repeat(32) });
      const w = writer();
      await w.ready;
      expect(w.isPaused()).toBe(true);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toContain(`AUDIT FAILURE: ${lead}`);
      expect(reports[0]).toContain('Requests are still served and logged. The anchor is left as it is and no new one is written. Run: aquaman audit verify.');
      expect(reports[0]).toContain('stop the proxy and run: aquaman audit accept');

      // It keeps logging, past the anchored sequence too, and the anchor does not move.
      await fill(10);
      await pass(INTERVAL * 3);
      await w.stop();
      expect(store.sets).toBe(0);
      expect(await stored()).toEqual(anchor);
      expect(reports).toHaveLength(1);
    });

    it('a log that holds a different entry at the anchored sequence is reported as not matching, and not anchored', async () => {
      await fill(5);
      await writeAuditAnchor(inner, { seq: 4, hash: 'ab'.repeat(32) });
      const w = writer();
      await w.ready;
      expect(w.isPaused()).toBe(true);
      expect(reports[0]).toContain('AUDIT FAILURE: the audit log does not match its anchor: the log was rebuilt');
      await fill(1);
      await w.stop();
      expect(store.sets).toBe(0);
    });

    it('a stored value that is not an anchor is reported and not overwritten', async () => {
      await inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, 'tampered');
      const w = writer();
      await w.ready;
      expect(w.isPaused()).toBe(true);
      expect(reports).toEqual([
        'AUDIT FAILURE: the value stored at aquaman_internal/audit_anchor is not an audit anchor, so the audit log cannot be checked against it. No new anchor is written. Run: aquaman audit verify',
      ]);
      await fill(2);
      await w.stop();
      expect(await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY)).toBe('tampered');
    });

    it('never replaces an anchor with one for an earlier sequence, even when its own log reads lower', async () => {
      await fill(3);
      const w = writer();
      await w.flush();
      expect(await stored()).toMatchObject({ seq: 3 });
      // A second logger on a fresh directory stands in for a log that went backwards under the writer.
      const lower = new AuditLogger({ logDir: path.join(dir, 'lower') });
      await fill(1, lower);
      vi.spyOn(logger, 'getPosition').mockReturnValue(lower.getPosition());
      await fill(1);
      await pass();
      await w.stop();
      expect(await stored()).toMatchObject({ seq: 3 });
      expect(store.sets).toBe(1);
    });

    it('an entry that arrives while a write is in progress gets its own write at the next interval', async () => {
      const w = writer();
      await w.ready;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const realSet = MemoryStore.prototype.set;
      const spy = vi.spyOn(inner, 'set').mockImplementationOnce(async (...args) => {
        await gate;
        return realSet.apply(inner, args);
      });
      await fill(1);
      await pass();
      expect(spy).toHaveBeenCalledTimes(1);
      await fill(1);
      release();
      await pass();
      expect(await stored()).toMatchObject({ seq: 2 });
      expect(store.sets).toBe(2);
      await w.stop();
    });

    it('an interval of 0 turns it off: nothing is read, written or listened to', async () => {
      const w = writer({ intervalSeconds: 0 });
      await w.ready;
      await fill(3);
      await pass(600);
      await w.flush();
      await w.stop();
      expect(w.isPaused()).toBe(false);
      expect(store.gets).toBe(0);
      expect(store.sets).toBe(0);
    });

    it('a failure in the comparison itself is reported and does not reject', async () => {
      await fill(2);
      await writeAuditAnchor(inner, { seq: 2, hash: logger.getPosition().lastHash });
      vi.spyOn(logger, 'hashAt').mockRejectedValue(new Error('EIO'));
      const w = writer();
      await expect(w.ready).resolves.toBeUndefined();
      expect(reports).toEqual(['AUDIT FAILURE: the audit log could not be compared with its anchor: EIO. It is tried again in 60 seconds. Run: aquaman doctor']);
      await w.stop();
    });

    it('a failure inside a scheduled write is reported and does not reject', async () => {
      const w = writer();
      await w.ready;
      vi.spyOn(logger, 'getPosition').mockImplementation(() => { throw 'position unavailable'; });
      await fill(1);
      await expect(w.flush()).resolves.toBeUndefined();
      expect(reports).toEqual(['AUDIT FAILURE: the audit anchor could not be updated: position unavailable. It is tried again in 60 seconds. Run: aquaman doctor']);
      await w.stop();
    });

    it('prints to stderr when no reporter is given', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, 'tampered');
      const w = createAuditAnchorWriter({ logger, store, intervalSeconds: INTERVAL });
      await w.ready;
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0][0]).toMatch(/^AUDIT FAILURE: /);
      await w.stop();
    });
  });

  describe('startAuditAnchor', () => {
    it('anchors at the configured interval', async () => {
      const w = startAuditAnchor({ audit: { enabled: true, anchorIntervalSeconds: 5 } }, logger, store);
      await w.ready;
      await fill(1);
      await pass(4);
      expect(store.sets).toBe(0);
      await pass(1);
      expect(store.sets).toBe(1);
      await w.stop();
    });

    it('uses 60 seconds when the interval is not set', async () => {
      const w = startAuditAnchor({ audit: { enabled: true } }, logger, store);
      await w.ready;
      await fill(1);
      await pass(59);
      expect(store.sets).toBe(0);
      await pass(1);
      expect(store.sets).toBe(1);
      await w.stop();
    });

    it.each([
      ['audit logging is off', { audit: { enabled: false } }],
      ['the interval is 0', { audit: { enabled: true, anchorIntervalSeconds: 0 } }],
    ])('does nothing when %s', async (_name, config) => {
      const w = startAuditAnchor(config, logger, store);
      await w.ready;
      await fill(2);
      await pass(600);
      await w.stop();
      expect(store.gets).toBe(0);
      expect(store.sets).toBe(0);
    });
  });

  describe('verifyAuditLog', () => {
    const verify = (opts: { anchoring?: boolean; chainOnly?: boolean; openStore?: () => Promise<CredentialStore> } = {}) =>
      verifyAuditLog({ logger, openStore: opts.openStore ?? (async () => store), anchoring: opts.anchoring ?? true, chainOnly: opts.chainOnly });

    it('valid: the anchor matches, with the number of entries not yet anchored', async () => {
      await fill(3);
      const anchor = await writeAuditAnchor(inner, { seq: 3, hash: logger.getPosition().lastHash });
      await fill(2);
      const result = await verify();
      expect(result.valid).toBe(true);
      expect(result.fix).toBeUndefined();
      expect(result.anchor).toEqual({
        status: 'matches',
        seq: 3,
        at: anchor.at,
        unanchored: 2,
        message: `the anchor matches the entry at sequence 3 (written ${anchor.at}); 2 entries since the last anchor, not yet anchored`,
      });
      await fill(0);
      await writeAuditAnchor(inner, { seq: 4, hash: (await logger.hashAt(4))! });
      expect((await verify()).anchor.message).toContain('1 entry since the last anchor, not yet anchored');
    });

    it('invalid: a matching anchor does not excuse a broken chain', async () => {
      await fill(3);
      await writeAuditAnchor(inner, { seq: 3, hash: logger.getPosition().lastHash });
      const file = path.join(dir, 'current.jsonl');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('"github"', '"gitlab"'));
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.valid).toBe(false);
      expect(result.anchor.status).toBe('matches');
    });

    it.each([
      ['truncated', 2, 'the log is truncated'],
      ['missing', 0, 'the log is missing or empty'],
    ])('invalid: %s', async (status, entries, text) => {
      await fill(entries);
      await writeAuditAnchor(inner, { seq: 6, hash: 'ab'.repeat(32) });
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.valid).toBe(true);
      expect(result.anchor.status).toBe(status);
      expect(result.anchor.seq).toBe(6);
      expect(result.anchor.unanchored).toBeUndefined();
      expect(result.anchor.message).toContain(text);
      expect(result.fix).toContain('stop the proxy and run: aquaman audit accept');
    });

    it('invalid: rebuilt', async () => {
      await fill(3);
      await writeAuditAnchor(inner, { seq: 2, hash: 'ab'.repeat(32) });
      expect(await verify()).toMatchObject({ valid: false, anchor: { status: 'rebuilt', seq: 2 } });
    });

    it('passes with "not anchored yet" when the store holds no anchor, with or without entries', async () => {
      const empty = await verify();
      expect(empty.valid).toBe(true);
      expect(empty.anchor.status).toBe('not_anchored');
      await fill(2);
      const result = await verify();
      expect(result.valid).toBe(true);
      expect(result.anchor).toEqual({
        status: 'not_anchored',
        message: 'not anchored yet: the credential store holds no anchor for this log. The process that writes the log stores one after it starts',
      });
    });

    it('says anchoring is off when it is and there is no anchor, and still compares when there is one', async () => {
      await fill(2);
      const off = await verify({ anchoring: false });
      expect(off.valid).toBe(true);
      expect(off.anchor.status).toBe('off');
      expect(off.anchor.message).toContain('anchoring is off');

      await writeAuditAnchor(inner, { seq: 5, hash: 'ab'.repeat(32) });
      expect((await verify({ anchoring: false })).anchor.status).toBe('truncated');
    });

    it.each([
      ['the store cannot be opened', async () => { throw new Error('AQUAMAN_ENCRYPTION_PASSWORD is not set'); }, 'AQUAMAN_ENCRYPTION_PASSWORD is not set'],
      ['the store cannot be read', async () => ({ get: async () => { throw 'bw: vault is locked'; } }) as unknown as CredentialStore, 'bw: vault is locked'],
    ])('fails with the reason and the fix when %s', async (_name, openStore, text) => {
      await fill(2);
      const result = await verify({ openStore });
      expect(result.valid).toBe(false);
      expect(result.chain.valid).toBe(true);
      expect(result.anchor).toEqual({ status: 'unreadable', message: `the credential store could not be read, so the anchor was not checked: ${text}` });
      expect(result.fix).toContain('aquaman audit verify --chain-only');
      expect(result.fix).toContain('aquaman doctor');
    });

    it('fails when the stored value is not an anchor', async () => {
      await inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, '{}');
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.anchor.status).toBe('malformed');
      expect(result.fix).toContain('aquaman audit accept');
    });

    it('--chain-only never opens the store, and says the anchor was not checked', async () => {
      await fill(2);
      await writeAuditAnchor(inner, { seq: 9, hash: 'ab'.repeat(32) });
      store.resetCounts();
      const openStore = vi.fn(async () => store);
      const result = await verify({ chainOnly: true, openStore });
      expect(openStore).not.toHaveBeenCalled();
      expect(store.gets).toBe(0);
      expect(result.valid).toBe(true);
      expect(result.anchor.status).toBe('not_checked');
      expect(result.anchor.message).toContain('the anchor was not checked (--chain-only)');
    });
  });

  describe('acceptAuditLog', () => {
    it('records the reset in the log and sets the anchor to the log as it is, also to a lower sequence', async () => {
      await fill(2);
      await writeAuditAnchor(inner, { seq: 40, hash: 'ab'.repeat(32) });
      const result = await acceptAuditLog({ logger, store });
      expect(result).toEqual({ accepted: true, previousSeq: 40, seq: 3 });

      const entries = await logger.getEntries();
      expect(entries).toHaveLength(3);
      expect(entries[2]).toMatchObject({
        seq: 3,
        type: 'credential_access',
        data: { service: 'aquaman_internal', operation: 'rotate', success: true, note: 'audit anchor reset by a person: was sequence 40, now sequence 3' },
      });
      expect(await stored()).toMatchObject({ v: 1, seq: 3, hash: entries[2].hash });
      expect(await verifyAuditLog({ logger, openStore: async () => store, anchoring: true })).toMatchObject({ valid: true, anchor: { status: 'matches', unanchored: 0 } });
    });

    it('starts a log when there is none, and replaces a stored value that is not an anchor', async () => {
      await inner.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, 'tampered');
      const result = await acceptAuditLog({ logger, store });
      expect(result).toEqual({ accepted: true, previousSeq: null, seq: 1 });
      expect((await logger.getEntries())[0].data).toMatchObject({ note: 'audit anchor reset by a person: was sequence none, now sequence 1' });
      expect(await stored()).toMatchObject({ seq: 1 });
    });

    it('refuses a broken chain, writes nothing, and says how to start a new log', async () => {
      await fill(3);
      await writeAuditAnchor(inner, { seq: 9, hash: 'ab'.repeat(32) });
      const file = path.join(dir, 'current.jsonl');
      const before = fs.readFileSync(file, 'utf-8').replace('"github"', '"gitlab"');
      fs.writeFileSync(file, before);
      store.resetCounts();
      const result = await acceptAuditLog({ logger, store });
      expect(result.accepted).toBe(false);
      expect(result).toMatchObject({
        reason: expect.stringMatching(/^the chain itself is broken \(Entry 0: hash mismatch.*\), and accepting an anchor does not repair it$/),
        fix: expect.stringContaining('mv ~/.aquaman/audit ~/.aquaman/audit.broken'),
      });
      expect(fs.readFileSync(file, 'utf-8')).toBe(before);
      expect(store.sets).toBe(0);
    });

    it('a store that cannot be read stops it before anything is written', async () => {
      await fill(1);
      vi.spyOn(inner, 'get').mockRejectedValue(new Error('vault is locked'));
      await expect(acceptAuditLog({ logger, store })).rejects.toThrow('vault is locked');
      expect(await logger.getEntries()).toHaveLength(1);
      expect(store.sets).toBe(0);
    });

    it('does not move the anchor when the reset cannot be recorded', async () => {
      const disabled = new AuditLogger({ logDir: path.join(dir, 'off'), enabled: false });
      const result = await acceptAuditLog({ logger: disabled, store });
      expect(result).toEqual({
        accepted: false,
        reason: 'the reset could not be recorded in the audit log',
        fix: 'Check that the audit directory is writable. Run: aquaman doctor',
      });
      expect(store.sets).toBe(0);
    });
  });
});
