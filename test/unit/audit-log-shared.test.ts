/**
 * One audit log, several loggers: what a reader may do to it (nothing), how
 * two writers keep one chain, what a writer follows and what it refuses to
 * follow, and the lock every write takes.
 *
 * Two `AuditLogger` objects on one directory stand in for two processes; the
 * same thing with real processes is test/e2e/audit-log-processes.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodeFs, * as fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, computeChainedHash } from 'aquaman-core';

const GENESIS = '0'.repeat(64);
const access = { service: 'github', operation: 'use' as const, success: true };

describe('one audit log, several loggers', () => {
  let dir: string;
  let errors: ReturnType<typeof vi.spyOn>;
  const current = () => path.join(dir, 'current.jsonl');
  const wal = () => path.join(dir, 'current.wal');
  const lock = () => path.join(dir, 'write.lock');
  const read = (file: string): any[] => fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seqs = () => read(current()).map((e) => e.seq);
  const write = (file: string, entries: any[]) => fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));
  const log = (logger: AuditLogger) => logger.logCredentialAccess('s', 'agent', access);
  const reported = () => errors.mock.calls.map((c) => String(c[0]));

  async function fill(logger: AuditLogger, count: number): Promise<void> {
    for (let i = 0; i < count; i++) await log(logger);
  }

  /** A chain valid on its own terms, as a logger would have written it. */
  function rechain(entries: any[], firstSeq = 1, previous = GENESIS): any[] {
    return entries.map((entry, i) => {
      const relinked = { ...entry, seq: firstSeq + i, previousHash: previous };
      relinked.hash = computeChainedHash(JSON.stringify({ ...relinked, hash: undefined }), previous);
      previous = relinked.hash;
      return relinked;
    });
  }

  /** Every file and directory under the audit directory, with its bytes. */
  function snapshot(root = dir): Record<string, string> {
    const out: Record<string, string> = {};
    if (!fs.existsSync(root)) return out;
    const walk = (at: string) => {
      for (const name of fs.readdirSync(at).sort()) {
        const full = path.join(at, name);
        const rel = path.relative(root, full);
        if (fs.statSync(full).isDirectory()) {
          out[rel + '/'] = '';
          walk(full);
        } else {
          out[rel] = fs.readFileSync(full).toString('base64');
        }
      }
    };
    walk(root);
    return out;
  }

  const verify = () => new AuditLogger({ logDir: dir, readOnly: true }).verifyChain();

  /** The pid of a process that has exited. */
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    return child.pid;
  }

  const holdLock = (pid: number, ageMs = 0) => {
    fs.writeFileSync(lock(), JSON.stringify({ pid, at: new Date().toISOString(), id: 'someone-else' }));
    if (ageMs) {
      const then = new Date(Date.now() - ageMs);
      fs.utimesSync(lock(), then, then);
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-shared-'));
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('a reader changes nothing', () => {
    it('opened on a directory that does not exist, it creates none and reports an empty log', async () => {
      const missing = path.join(dir, 'not-there');
      const reader = new AuditLogger({ logDir: missing, readOnly: true });
      await reader.initialize();
      expect(await reader.verifyChain()).toMatchObject({ valid: true, entries: 0, lastSeq: 0, verifiedFrom: null });
      expect(await reader.tail(5)).toEqual([]);
      expect(await reader.hashAt(1)).toBeNull();
      expect(reader.getPosition()).toEqual({ lastSeq: 0, lastHash: GENESIS });
      expect(fs.existsSync(missing)).toBe(false);
    });

    it('beside a log with archives, initialize, verifyChain, hashAt, tail and getEntries leave every byte and name as they were', async () => {
      const writer = new AuditLogger({ logDir: dir });
      await fill(writer, 4);
      await writer.rotateLog();
      await fill(writer, 3);
      const before = snapshot();

      const reader = new AuditLogger({ logDir: dir, readOnly: true });
      await reader.initialize();
      expect(reader.getPosition().lastSeq).toBe(7);
      expect(await reader.verifyChain()).toMatchObject({ valid: true, entries: 3, lastSeq: 7, verifiedFrom: 1 });
      expect(await reader.hashAt(2)).toBe(read(path.join(dir, 'archive', fs.readdirSync(path.join(dir, 'archive'))[0]))[1].hash);
      expect(await reader.tail(2)).toHaveLength(2);
      expect(await reader.getEntries()).toHaveLength(3);
      expect(snapshot()).toEqual(before);
    });

    it('beside a writer in the middle of an append, it does not put the write-ahead entry into the log, and the writer\'s own append is the only one', async () => {
      const writer = new AuditLogger({ logDir: dir });
      await fill(writer, 2);

      // The line the writer is about to append as entry 3, made by a copy of the log.
      const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-shared-copy-'));
      fs.cpSync(dir, copy, { recursive: true });
      await log(new AuditLogger({ logDir: copy }));
      const line3 = fs.readFileSync(path.join(copy, 'current.jsonl'), 'utf-8').trim().split('\n')[2] + '\n';
      fs.rmSync(copy, { recursive: true, force: true });

      // The writer has appended entry 3 to the write-ahead file and not yet to the log.
      fs.appendFileSync(wal(), line3);
      const before = snapshot();

      // `aquaman audit verify` and `aquaman audit tail` start now.
      const reader = new AuditLogger({ logDir: dir, readOnly: true });
      await reader.initialize();
      expect(await reader.verifyChain()).toMatchObject({ valid: true, lastSeq: 2 });
      expect(await reader.tail()).toHaveLength(2);
      expect(snapshot()).toEqual(before);

      // The writer goes on: its append to the log, then it empties the write-ahead file.
      fs.appendFileSync(current(), line3);
      fs.writeFileSync(wal(), '');

      expect(seqs()).toEqual([1, 2, 3]);
      expect(await verify()).toMatchObject({ valid: true, lastSeq: 3 });
    });

    it('refuses to write or rotate, and says which logger it is', async () => {
      await fill(new AuditLogger({ logDir: dir }), 1);
      const before = snapshot();
      const reader = new AuditLogger({ logDir: dir, readOnly: true });
      await expect(log(reader)).rejects.toThrow('opened for reading only');
      await expect(reader.logToolCall('s', 'a', 'tool', {})).rejects.toThrow('opened for reading only');
      await expect(reader.logToolResult('s', 'a', 'id', {})).rejects.toThrow('opened for reading only');
      await expect(reader.rotateLog()).rejects.toThrow('opened for reading only');
      expect(snapshot()).toEqual(before);
    });

    it('verifyChain on a writer that was never initialized reads only', async () => {
      await fill(new AuditLogger({ logDir: dir }), 2);
      fs.appendFileSync(wal(), '{"left":"by a writer in mid-append"}\n');
      const before = snapshot();
      expect((await new AuditLogger({ logDir: dir }).verifyChain()).valid).toBe(true);
      expect(snapshot()).toEqual(before);
    });

    it('a result with errors is read again when the files changed during the read, and taken when they did not', async () => {
      const writer = new AuditLogger({ logDir: dir });
      await fill(writer, 3);
      const reader = new AuditLogger({ logDir: dir, readOnly: true });
      const walk = vi.spyOn(reader as any, 'walkChain');
      const broken = { valid: false, errors: ['read while the log was being rotated'], entries: 0, lastSeq: 0, lastHash: GENESIS, verifiedFrom: null };

      // The writer rotates and appends while the first read is under way.
      walk.mockImplementationOnce(() => {
        fs.renameSync(current(), path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'));
        return broken;
      });
      expect(await reader.verifyChain()).toMatchObject({ valid: true, lastSeq: 3, entries: 0 });
      expect(walk).toHaveBeenCalledTimes(2);

      // Nothing changed during the read: the errors are the log's own.
      walk.mockClear();
      walk.mockImplementationOnce(() => broken);
      expect((await reader.verifyChain()).errors).toEqual(['read while the log was being rotated']);
      expect(walk).toHaveBeenCalledTimes(1);

      // A log that changes during every read is reported after the third.
      walk.mockClear();
      let n = 0;
      walk.mockImplementation(() => {
        fs.appendFileSync(current(), `not an entry ${n++}\n`);
        return broken;
      });
      expect((await reader.verifyChain()).valid).toBe(false);
      expect(walk).toHaveBeenCalledTimes(3);
    });
  });

  describe('two writers keep one chain', () => {
    it('writes that interleave get consecutive sequence numbers and link to each other', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await a.initialize();
      await fill(a, 2);
      await b.initialize();
      await log(a);
      await log(b);
      for (let i = 0; i < 10; i++) {
        await log(i % 3 ? a : b);
        await log(i % 2 ? a : b);
      }
      expect(seqs()).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
      expect(await verify()).toMatchObject({ valid: true, errors: [], entries: 24, lastSeq: 24, verifiedFrom: 1 });
      // a wrote last. b knows the log as of its own last write, and follows at its next one.
      expect(a.getPosition().lastSeq).toBe(24);
      expect(a.getStats().entryCount).toBe(24);
      expect(b.getPosition().lastSeq).toBe(23);
      expect(b.getStats().entryCount).toBe(23);
      expect(reported()).toEqual([]);
    });

    it('writes started at the same moment by both are each written once, in one chain', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await Promise.all(Array.from({ length: 40 }, (_, i) => log(i % 2 ? a : b)));
      expect(seqs()).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect((await verify()).valid).toBe(true);
      expect(fs.existsSync(lock())).toBe(false);
    });

    it('a writer that opened an empty log follows the first entries another wrote', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await a.initialize();
      await b.initialize();
      await fill(a, 3);
      await log(b);
      expect(seqs()).toEqual([1, 2, 3, 4]);
      expect((await verify()).valid).toBe(true);
    });

    it('a rotation by one while the other writes keeps the chain, whichever writes next', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await fill(a, 2);
      await fill(b, 2);

      // a rotates; b, which last saw the old file, writes first into the new one.
      const first = await a.rotateLog();
      await log(b);
      expect(read(current())[0]).toMatchObject({ seq: 5, previousHash: read(first)[3].hash });
      await log(a);
      expect(seqs()).toEqual([5, 6]);

      // b rotates; a writes two, b writes one.
      await b.rotateLog();
      await fill(a, 2);
      await log(b);
      expect(seqs()).toEqual([7, 8, 9]);
      expect(b.getStats().entryCount).toBe(3);

      // a writes and rotates twice in a row while b sits idle; b then follows through both archives.
      await log(a);
      await a.rotateLog();
      await log(a);
      await a.rotateLog();
      await log(b);
      expect(seqs()).toEqual([12]);

      expect(await verify()).toMatchObject({ valid: true, errors: [], lastSeq: 12, verifiedFrom: 1 });
      expect(fs.readdirSync(path.join(dir, 'archive'))).toHaveLength(4);
      expect(reported()).toEqual([]);
    });

    it('a writer that saw no current file notices a write and a second rotation by another', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await fill(a, 2);
      await a.rotateLog();
      // b opens the log now: no current file, position from the archive.
      await b.initialize();
      expect(b.getPosition().lastSeq).toBe(2);
      await log(a);
      await a.rotateLog();
      // Again no current file, but not the same log b saw.
      await log(b);
      expect(seqs()).toEqual([4]);
      expect(await verify()).toMatchObject({ valid: true, lastSeq: 4, verifiedFrom: 1 });
    });

    it('automatic rotation by one writer is followed by the other', async () => {
      const a = new AuditLogger({ logDir: dir, maxLogSizeBytes: 600 });
      const b = new AuditLogger({ logDir: dir, maxLogSizeBytes: 600 });
      for (let i = 0; i < 12; i++) await log(i % 2 ? a : b);
      expect(fs.readdirSync(path.join(dir, 'archive')).length).toBeGreaterThan(1);
      expect(await verify()).toMatchObject({ valid: true, lastSeq: 12, verifiedFrom: 1 });
    });

    it('an entry a stopped writer left in the write-ahead file is put into the log once, by whichever writer comes next', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await fill(a, 2);
      await b.initialize();

      // a stops between its two appends: entry 3 is in the write-ahead file only.
      const lines = fs.readFileSync(current(), 'utf-8');
      await log(a);
      const line3 = fs.readFileSync(current(), 'utf-8').slice(lines.length);
      fs.writeFileSync(current(), lines);
      fs.writeFileSync(wal(), line3);

      await log(b);
      expect(seqs()).toEqual([1, 2, 3, 4]);
      expect(fs.readFileSync(wal(), 'utf-8')).toBe('');

      // a stops after its second append and before it emptied the file: entry 5 is in both.
      await log(b);
      fs.writeFileSync(wal(), fs.readFileSync(current(), 'utf-8').trim().split('\n')[4] + '\n');
      const c = new AuditLogger({ logDir: dir });
      await c.initialize();
      expect(fs.readFileSync(wal(), 'utf-8')).toBe('');
      await log(c);
      expect(seqs()).toEqual([1, 2, 3, 4, 5, 6]);
      expect((await verify()).valid).toBe(true);
    });
  });

  describe('what a writer does not follow', () => {
    const tampering: Array<{ name: string; tamper(entries: any[]): void }> = [
      {
        name: 'a log cut short (the same file, shorter)',
        tamper: (entries) => write(current(), entries.slice(0, 2)),
      },
      {
        name: 'a log replaced by a rebuilt one that reaches further (another file under the name)',
        tamper: (entries) => {
          const rebuilt = rechain([...entries.slice(0, 2), ...entries, ...entries].map((e) => ({ ...e, data: { ...e.data, success: true } })));
          fs.rmSync(current());
          write(path.join(dir, 'new'), rebuilt);
          fs.renameSync(path.join(dir, 'new'), current());
        },
      },
      {
        name: 'an appended entry that does not link to the last one',
        tamper: (entries) => fs.appendFileSync(current(), JSON.stringify({ ...entries[0], seq: 5 }) + '\n'),
      },
      {
        name: 'an appended entry with the next number and the right link, whose hash is not its own',
        tamper: (entries) => fs.appendFileSync(current(), JSON.stringify({ ...entries[3], id: 'forged', seq: 5, previousHash: entries[3].hash }) + '\n'),
      },
      {
        name: 'an appended line that is not an entry',
        tamper: () => fs.appendFileSync(current(), 'not json\n'),
      },
      {
        name: 'the current file rotated away by hand and cut short in the archive',
        tamper: (entries) => {
          const archive = path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl');
          fs.renameSync(current(), archive);
          write(archive, entries.slice(0, 3));
        },
      },
    ];

    for (const { name, tamper } of tampering) {
      it(`${name}: it goes on from its own last entry, the chain shows the break, and it says so once`, async () => {
        const running = new AuditLogger({ logDir: dir });
        await fill(running, 4);
        const own = running.getPosition();
        tamper(read(current()));

        const entry = await log(running);
        expect(entry).toMatchObject({ seq: 5, previousHash: own.lastHash });
        expect((await verify()).valid).toBe(false);

        await log(running);
        expect(reported().filter((l) => l.startsWith('AUDIT FAILURE:'))).toEqual([
          'AUDIT FAILURE: the audit log on disk does not continue from the last entry this process wrote (sequence 4): ' +
          'something other than an aquaman writer changed it. This process goes on from its own last entry, so the change shows as a break in the chain. ' +
          'Run: aquaman audit verify',
        ]);
      });
    }

    // Current limit: following starts from the file that holds this writer's
    // last entry. When other writers have rotated and pruned that file away
    // between two writes of this one (ten rotations with the defaults), there
    // is nothing left to show that the log on disk descends from that entry,
    // and it is treated like a replaced log.
    it.fails('should follow, does not: a writer that sat idle while another rotated and pruned the archive holding its last entry breaks the chain at its next write', async () => {
      const idle = new AuditLogger({ logDir: dir });
      await fill(idle, 2);
      const busy = new AuditLogger({ logDir: dir, maxLogSizeBytes: 1, maxArchives: 1 });
      await fill(busy, 3);
      expect((await verify()).valid).toBe(true);

      await log(idle);
      expect((await verify()).valid).toBe(true);
    });

    it('a file under an archive name that cannot be read is not a reason to stop: the writer goes on', async () => {
      const running = new AuditLogger({ logDir: dir });
      await fill(running, 2);
      await running.rotateLog();
      fs.mkdirSync(path.join(dir, 'archive', 'audit-9999-01-01T00-00-00-000Z.jsonl'));
      const other = new AuditLogger({ logDir: dir });
      await log(other);
      await log(running);
      expect(seqs()).toEqual([3, 4]);
    });
  });

  describe('the lock', () => {
    it('is gone after a write, after a rotation, and after a write that failed', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await log(logger);
      expect(fs.existsSync(lock())).toBe(false);
      await logger.rotateLog();
      expect(fs.existsSync(lock())).toBe(false);

      await log(logger);
      fs.chmodSync(current(), 0o400);
      try {
        await expect(log(logger)).rejects.toThrow(/EACCES/);
      } finally {
        fs.chmodSync(current(), 0o600);
      }
      expect(fs.existsSync(lock())).toBe(false);
    });

    it.each([
      ['left by a process that is no longer running', () => holdLock(deadPid())],
      ['older than the stale age, whoever holds it', () => holdLock(process.ppid, 60_000)],
      ['dated in the future by more than the stale age', () => holdLock(process.ppid, -60_000)],
      ['left by an earlier process with this process\'s pid', () => holdLock(process.pid)],
      ['old and not a lock of ours at all', () => {
        fs.writeFileSync(lock(), 'junk');
        const then = new Date(Date.now() - 60_000);
        fs.utimesSync(lock(), then, then);
      }],
    ] as Array<[string, () => void]>)('a lock %s is taken over', async (_name, leave) => {
      const logger = new AuditLogger({ logDir: dir, lockWaitMs: 50 });
      await log(logger);
      leave();
      await log(logger);
      expect(seqs()).toEqual([1, 2]);
      expect(fs.existsSync(lock())).toBe(false);
      expect((await verify()).valid).toBe(true);
    });

    it.each([
      ['a running process', () => holdLock(process.ppid), `"pid":${process.ppid}`],
      ['a running process this user may not signal', () => holdLock(1), '"pid":1'],
      ['something that wrote no pid', () => fs.writeFileSync(lock(), '{"pid":"x"}'), '{"pid":"x"}'],
      ['a writer that has created the file and not yet written into it', () => fs.writeFileSync(lock(), ''), 'another process ()'],
      ['something that cannot be read as a lock file', () => fs.mkdirSync(lock()), 'another process (its lock file could not be read)'],
    ] as Array<[string, () => void, string]>)('a lock held by %s past the wait fails the write, and nothing is written', async (_name, hold, holder) => {
      const logger = new AuditLogger({ logDir: dir, lockWaitMs: 60 });
      await fill(logger, 2);
      hold();
      const before = snapshot();

      const started = Date.now();
      const attempt = log(logger);
      await expect(attempt).rejects.toThrow(/^The audit log is locked by another process \(.*\) and did not become free within 60 ms\. If that process is not running aquaman, remove .*write\.lock$/);
      await expect(attempt).rejects.toThrow(holder);
      expect(Date.now() - started).toBeGreaterThanOrEqual(55);
      expect(snapshot()).toEqual(before);
      await expect(logger.rotateLog()).rejects.toThrow('locked by another process');
      expect(snapshot()).toEqual(before);

      // The holder lets go: the next write is entry 3 of the same chain.
      fs.rmSync(lock(), { recursive: true });
      await log(logger);
      expect(seqs()).toEqual([1, 2, 3]);
      expect((await verify()).valid).toBe(true);
    });

    it('by default a write waits two seconds for the lock, and a lock is stale after five', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await log(logger);
      // Held by a running process and not five seconds old when the wait ends: the write waits and fails.
      holdLock(process.ppid, 2000);
      const started = Date.now();
      await expect(log(logger)).rejects.toThrow('did not become free within 2000 ms');
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(1900);
      expect(waited).toBeLessThan(4000);
      // By now it is more than five seconds old.
      const aged = new Date(Date.now() - 5500);
      fs.utimesSync(lock(), aged, aged);
      await log(logger);
      expect(seqs()).toEqual([1, 2]);
    });

    it('a write waits for a holder that lets go within the wait', async () => {
      const logger = new AuditLogger({ logDir: dir, lockWaitMs: 2000 });
      await log(logger);
      holdLock(process.ppid);
      setTimeout(() => fs.rmSync(lock()), 40);
      await log(logger);
      expect(seqs()).toEqual([1, 2]);
    });

    it('a lock another writer took while this one was judging the old one is left alone', async () => {
      const logger = new AuditLogger({ logDir: dir, lockWaitMs: 60 });
      await log(logger);
      // The lock that was judged abandoned is not the one on disk any more: another writer removed it and holds a new one.
      holdLock(process.ppid);
      vi.spyOn(logger as any, 'abandonedLock').mockReturnValue('{"pid":0,"id":"the lock that was there before"}');
      await expect(log(logger)).rejects.toThrow('locked by another process');
      expect(JSON.parse(fs.readFileSync(lock(), 'utf-8')).pid).toBe(process.ppid);
    });

    it('a writer whose lock was taken while it was stopped does not remove the new holder\'s', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await log(logger);
      // Inside the append, the lock changes hands.
      const catchUp = vi.spyOn(logger as any, 'catchUp').mockImplementationOnce(() => {
        fs.rmSync(lock());
        holdLock(process.ppid);
      });
      await log(logger);
      expect(catchUp).toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(lock(), 'utf-8')).pid).toBe(process.ppid);
    });

    it('an audit directory that is gone fails the write at once, not after the wait', async () => {
      const logger = new AuditLogger({ logDir: dir, lockWaitMs: 5000 });
      await log(logger);
      fs.rmSync(dir, { recursive: true });
      const started = Date.now();
      await expect(log(logger)).rejects.toThrow(/ENOENT/);
      expect(Date.now() - started).toBeLessThan(1000);
      fs.mkdirSync(dir);
    });

    it('opening a log whose write-ahead entry cannot be dealt with yet leaves it for the first write', async () => {
      const first = new AuditLogger({ logDir: dir });
      await fill(first, 2);
      const lines = fs.readFileSync(current(), 'utf-8');
      await log(first);
      const line3 = fs.readFileSync(current(), 'utf-8').slice(lines.length);
      fs.writeFileSync(current(), lines);
      fs.writeFileSync(wal(), line3);
      holdLock(process.ppid);

      const logger = new AuditLogger({ logDir: dir, lockWaitMs: 30 });
      await logger.initialize();
      expect(fs.readFileSync(wal(), 'utf-8')).toBe(line3);
      expect(seqs()).toEqual([1, 2]);

      fs.rmSync(lock());
      await log(logger);
      expect(seqs()).toEqual([1, 2, 3, 4]);
      expect(fs.readFileSync(wal(), 'utf-8')).toBe('');
      expect((await verify()).valid).toBe(true);
    });
  });

  describe('where the log is supposed to begin', () => {
    it('is 1 for a new log and for one found whole, and the first entry present for one that already begins later', async () => {
      const fresh = new AuditLogger({ logDir: dir });
      expect(fresh.getRetainedFrom()).toBe(1);
      await fill(fresh, 6);
      expect(fresh.getRetainedFrom()).toBe(1);

      const whole = new AuditLogger({ logDir: dir });
      await whole.initialize();
      expect(whole.getRetainedFrom()).toBe(1);

      // The head is gone when the next logger opens the log: entries 5 and 6 in an archive, nothing in the current file.
      const entries = read(current());
      write(path.join(dir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries.slice(4));
      fs.rmSync(current());
      const late = new AuditLogger({ logDir: dir });
      await late.initialize();
      expect(late.getRetainedFrom()).toBe(5);

      // It is where the log began when this logger opened it: putting the head back does not lower it.
      write(path.join(dir, 'archive', 'audit-2025-01-01T00-00-00-000Z.jsonl'), entries.slice(0, 4));
      await log(late);
      expect(late.getRetainedFrom()).toBe(5);
    });

    it('is 1 for a log whose first entry has no sequence number, and for one whose first line is not an entry', async () => {
      const { seq: _seq, ...unnumbered } = { id: 'old', seq: 0, timestamp: new Date(0).toISOString(), type: 'credential_access', sessionId: 's', agentId: 'a', data: access, previousHash: GENESIS, hash: '' };
      const legacy: any = { ...unnumbered };
      legacy.hash = computeChainedHash(JSON.stringify({ ...legacy, hash: undefined }), GENESIS);
      write(current(), [legacy]);
      const a = new AuditLogger({ logDir: dir, readOnly: true });
      await a.initialize();
      expect(a.getRetainedFrom()).toBe(1);

      fs.writeFileSync(current(), 'null\n');
      const b = new AuditLogger({ logDir: dir, readOnly: true });
      await b.initialize();
      expect(b.getRetainedFrom()).toBe(1);
    });

    it('goes up when this logger prunes, to the first entry of the oldest archive it kept, and the listener hears it once per move', async () => {
      const logger = new AuditLogger({ logDir: dir, maxLogSizeBytes: 600, maxArchives: 2 });
      const moved: number[] = [];
      logger.onPruned(() => moved.push(logger.getRetainedFrom()));
      await fill(logger, 20);

      const kept = fs.readdirSync(path.join(dir, 'archive')).sort();
      expect(kept).toHaveLength(2);
      const firstKept = read(path.join(dir, 'archive', kept[0]))[0].seq;
      expect(firstKept).toBeGreaterThan(1);
      expect(logger.getRetainedFrom()).toBe(firstKept);
      expect(moved.length).toBeGreaterThan(1);
      expect(moved).toEqual([...moved].sort((x, y) => x - y));
      expect(new Set(moved).size).toBe(moved.length);
      expect(moved[moved.length - 1]).toBe(firstKept);
      expect(await verify()).toMatchObject({ valid: true, verifiedFrom: firstKept });

      // Removed: further pruning is not announced.
      logger.onPruned(null);
      const heard = moved.length;
      await fill(logger, 10);
      expect(moved).toHaveLength(heard);
      expect(logger.getRetainedFrom()).toBeGreaterThan(firstKept);
    });

    it('does not move for a rotation that prunes nothing, nor when the oldest archive kept cannot be read as entries', async () => {
      const roomy = new AuditLogger({ logDir: dir, maxLogSizeBytes: 600, maxArchives: 50 });
      let heard = 0;
      roomy.onPruned(() => heard++);
      await fill(roomy, 12);
      expect(fs.readdirSync(path.join(dir, 'archive')).length).toBeGreaterThan(2);
      expect(roomy.getRetainedFrom()).toBe(1);
      expect(heard).toBe(0);

      // The archive that will be the oldest one kept starts with a line that is not an entry.
      const names = fs.readdirSync(path.join(dir, 'archive')).sort();
      const tight = new AuditLogger({ logDir: dir, maxLogSizeBytes: 600, maxArchives: names.length });
      tight.onPruned(() => heard++);
      fs.writeFileSync(path.join(dir, 'archive', names[1]), 'not an entry\n');
      while (fs.readdirSync(path.join(dir, 'archive')).sort()[0] === names[0]) await log(tight);
      expect(tight.getRetainedFrom()).toBe(1);
      expect(heard).toBe(0);
    });

    it('a prune listener that throws does not fail the write', async () => {
      const logger = new AuditLogger({ logDir: dir, maxLogSizeBytes: 600, maxArchives: 1 });
      logger.onPruned(() => { throw new Error('listener'); });
      await fill(logger, 12);
      expect(logger.getRetainedFrom()).toBeGreaterThan(1);
      expect((await verify()).valid).toBe(true);
    });
  });

  describe('the cost of a write', () => {
    it('1,000 entries from one writer never read the log back: only the appends touch it', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await logger.initialize();
      await fill(logger, 5);

      const opened: string[] = [];
      const openSync = nodeFs.openSync;
      const readFileSync = nodeFs.readFileSync;
      vi.spyOn(nodeFs, 'openSync').mockImplementation(((file: fs.PathLike, flags?: fs.OpenMode, mode?: fs.Mode) => {
        if (flags === 'r') opened.push(String(file));
        return openSync(file, flags, mode);
      }) as typeof fs.openSync);
      vi.spyOn(nodeFs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, options?: any) => {
        opened.push(String(file));
        return readFileSync(file, options);
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();

      await fill(logger, 1000);

      vi.restoreAllMocks();
      syncBuiltinESMExports();
      // Nothing is opened for reading: not the log, not the archives, not the lock.
      expect(opened).toEqual([]);
      expect(seqs()).toHaveLength(1005);
      expect((await verify()).valid).toBe(true);
    }, 120_000);

    it('following another writer reads what was added, not the whole file', async () => {
      const a = new AuditLogger({ logDir: dir });
      const b = new AuditLogger({ logDir: dir });
      await fill(a, 300);
      await log(b);
      const size = fs.statSync(current()).size;

      const lengths: number[] = [];
      const readSync = nodeFs.readSync;
      vi.spyOn(nodeFs, 'readSync').mockImplementation(((fd: number, buffer: NodeJS.ArrayBufferView, ...rest: any[]) => {
        lengths.push(buffer.byteLength);
        return (readSync as any)(fd, buffer, ...rest);
      }) as typeof fs.readSync);
      syncBuiltinESMExports();

      await fill(a, 2);
      await log(b);

      vi.restoreAllMocks();
      syncBuiltinESMExports();
      // a read b's one entry, twice nothing; b read a's two entries.
      const oneEntry = Math.ceil(size / 301);
      expect(lengths.length).toBeGreaterThan(0);
      expect(Math.max(...lengths)).toBeLessThan(oneEntry * 4);
      expect(seqs()).toHaveLength(304);
    });
  });
});
