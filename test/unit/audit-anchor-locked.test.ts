/**
 * The audit anchor while the vault is locked (the `bitwarden` backend before
 * `aquaman unlock`, or after its session ended).
 *
 * A locked vault is a state a person ends, not a failure of the audit log
 * and not a sign of tampering: it must not print `AUDIT FAILURE:` on every
 * interval. The comparison of the log with its anchor is put off until the
 * vault is open, not skipped.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, MemoryStore, VaultLockedError, type CredentialStore } from 'aquaman-core';
import { AUDIT_ANCHOR_KEY, RESERVED_SERVICE, createAuditAnchorWriter, writeAuditAnchor, type AuditAnchor } from 'aquaman-proxy';

const access = { service: 'github', operation: 'use' as const, success: true };
const INTERVAL = 900;

/** A store that refuses every read and write while `locked`, the way the Bitwarden backend does. */
class LockableStore implements CredentialStore {
  locked = true;
  touched = 0;
  constructor(readonly inner: MemoryStore) {}
  private gate(): void {
    this.touched++;
    if (this.locked) throw new VaultLockedError('The Bitwarden vault is locked, so the proxy cannot read credentials. Run: aquaman unlock');
  }
  async get(service: string, key: string) { this.gate(); return this.inner.get(service, key); }
  async set(service: string, key: string, value: string) { this.gate(); return this.inner.set(service, key, value); }
  async delete(service: string, key: string) { this.gate(); return this.inner.delete(service, key); }
  async list(service?: string) { this.gate(); return this.inner.list(service); }
  async exists(service: string, key: string) { this.gate(); return this.inner.exists(service, key); }
}

describe('audit anchor on a locked vault', () => {
  let dir: string;
  let logger: AuditLogger;
  let inner: MemoryStore;
  let store: LockableStore;
  let reports: string[];

  const fill = async (count: number) => {
    for (let i = 0; i < count; i++) await logger.logCredentialAccess('s', 'agent', access);
  };
  const stored = async (): Promise<AuditAnchor | null> => {
    const raw = await inner.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
    return raw === null ? null : JSON.parse(raw);
  };
  const writer = () => createAuditAnchorWriter({ logger, store, intervalSeconds: INTERVAL, report: (line) => reports.push(line) });
  const pass = (seconds = INTERVAL) => vi.advanceTimersByTimeAsync(seconds * 1000);
  const failures = () => reports.filter((line) => line.includes('AUDIT FAILURE'));

  beforeEach(async () => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-anchor-locked-'));
    logger = new AuditLogger({ logDir: dir });
    await logger.initialize();
    inner = new MemoryStore();
    store = new LockableStore(inner);
    reports = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a daemon that starts locked says so once, in plain words, and reports no audit failure', async () => {
    const w = writer();
    await w.ready;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('the vault is locked');
    expect(reports[0]).toContain('aquaman unlock');
    expect(failures()).toEqual([]);
    expect(w.isPaused()).toBe(false);
    await w.stop();
  });

  it('entries written while locked are logged, and interval after interval brings no further line and no failure', async () => {
    const w = writer();
    await w.ready;
    await fill(3);
    for (let i = 0; i < 5; i++) {
      await pass();
      await fill(1);
    }
    expect(reports).toHaveLength(1);
    expect(failures()).toEqual([]);
    expect(await stored()).toBeNull();
    expect(logger.getPosition().lastSeq).toBe(8);
    await w.stop();
  });

  it('once the vault is open the anchor catches up with everything written while it was locked', async () => {
    const w = writer();
    await w.ready;
    await fill(4);
    await pass();
    store.locked = false;
    await w.recheck();
    expect(await stored()).toMatchObject({ seq: 4, hash: logger.getPosition().lastHash, from: 1 });
    expect(failures()).toEqual([]);
    await w.stop();
  });

  it('the comparison with the anchor is put off, not skipped: a log cut short while the daemon was down is reported at unlock', async () => {
    await fill(5);
    await writeAuditAnchor(inner, { seq: 9, hash: 'a'.repeat(64), from: 1 });
    const w = writer();
    await w.ready;
    expect(failures()).toEqual([]);
    store.locked = false;
    await w.recheck();
    expect(failures()).toHaveLength(1);
    expect(failures()[0]).toContain('the audit log is behind its anchor');
    expect(w.isPaused()).toBe(true);
    // The finding is not overwritten.
    expect((await stored())!.seq).toBe(9);
    await w.stop();
  });

  it('a vault that locks again later is said once more, and the anchor is written after the next unlock', async () => {
    store.locked = false;
    const w = writer();
    await w.ready;
    await fill(2);
    await pass();
    expect((await stored())!.seq).toBe(2);
    expect(reports).toEqual([]);

    store.locked = true;
    await fill(2);
    await pass();
    await pass();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('the vault is locked');
    expect((await stored())!.seq).toBe(2);

    store.locked = false;
    await w.recheck();
    expect((await stored())!.seq).toBe(4);
    expect(failures()).toEqual([]);
    await w.stop();
  });

  it('stopping while locked writes nothing, reports no failure and does not wait', async () => {
    const w = writer();
    await w.ready;
    await fill(2);
    await w.stop();
    expect(failures()).toEqual([]);
    expect(await stored()).toBeNull();
  });

  it('recheck with nothing new and an anchor that matches reads the store and writes nothing', async () => {
    store.locked = false;
    const w = writer();
    await w.ready;
    const before = store.touched;
    await w.recheck();
    expect(store.touched).toBe(before);
    expect(await stored()).toBeNull();
    await w.stop();
  });

  it.fails('LIMIT: entries written while the vault is locked are not anchored until it is unlocked, so their removal in that time is not detected', async () => {
    const w = writer();
    await w.ready;
    await fill(3);
    await pass();
    expect((await stored())?.seq).toBe(3);
    await w.stop();
  });
});
