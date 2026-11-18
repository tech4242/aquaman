/**
 * The audit logger's sequence numbers and the chain across rotation: what an
 * entry carries, where a new logger picks up, what `verifyChain()` walks and
 * what pruning may delete.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, computeChainedHash } from 'aquaman-core';

const GENESIS = '0'.repeat(64);
const access = { service: 'github', operation: 'use' as const, success: true };

describe('audit logger: sequence numbers and rotation', () => {
  let dir: string;
  const current = () => path.join(dir, 'current.jsonl');
  const archiveDir = () => path.join(dir, 'archive');
  const archives = () => fs.readdirSync(archiveDir()).filter((n) => n.endsWith('.jsonl')).sort();
  const read = (file: string): any[] => fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const write = (file: string, entries: any[]) => fs.writeFileSync(file, entries.map((e) => JSON.stringify(e) + '\n').join(''));

  async function fill(logger: AuditLogger, count: number): Promise<void> {
    for (let i = 0; i < count; i++) await logger.logCredentialAccess('s', 'agent', access);
  }

  /** Entries as a release without sequence numbers wrote them. */
  function legacy(count: number): any[] {
    let previous = GENESIS;
    return Array.from({ length: count }, (_, i) => {
      const entry: any = { id: `old-${i}`, timestamp: new Date(0).toISOString(), type: 'credential_access', sessionId: 's', agentId: 'agent', data: access, previousHash: previous };
      entry.hash = computeChainedHash(JSON.stringify({ ...entry, hash: undefined }), previous);
      previous = entry.hash;
      return entry;
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-seq-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('numbers entries from 1, and the hash covers the number', async () => {
    const logger = new AuditLogger({ logDir: dir });
    const a = await logger.logCredentialAccess('s', 'agent', access);
    const b = await logger.logToolCall('s', 'agent', 'bash', { command: 'ls' });
    const c = await logger.logToolResult('s', 'agent', 'call-1', { ok: true });
    expect([a!.seq, b!.seq, c!.seq]).toEqual([1, 2, 3]);
    expect(logger.getPosition()).toEqual({ lastSeq: 3, lastHash: c!.hash });

    const lines = read(current());
    expect(lines.map((e) => e.seq)).toEqual([1, 2, 3]);
    // Changing only the number invalidates the entry's own hash.
    const forged = lines.map((e) => ({ ...e }));
    forged[2].seq = 7;
    write(current(), forged);
    const result = await logger.verifyChain();
    expect(result.errors).toEqual([
      'Entry 2: sequence gap (expected 3, got 7)',
      expect.stringMatching(/^Entry 2: hash mismatch/),
    ]);
  });

  it('reports position 0 and the genesis hash before anything is written, and an empty result for no log', async () => {
    const logger = new AuditLogger({ logDir: dir });
    await logger.initialize();
    expect(logger.getPosition()).toEqual({ lastSeq: 0, lastHash: GENESIS });
    expect(await logger.verifyChain()).toEqual({ valid: true, errors: [], entries: 0, lastSeq: 0, lastHash: GENESIS, verifiedFrom: null });
    expect(await logger.hashAt(1)).toBeNull();
  });

  it('a new logger on an existing log goes on with the next number', async () => {
    await fill(new AuditLogger({ logDir: dir }), 3);
    const second = new AuditLogger({ logDir: dir });
    const next = await second.logCredentialAccess('s', 'agent', access);
    expect(next!.seq).toBe(4);
    expect(await second.verifyChain()).toMatchObject({ valid: true, entries: 4, lastSeq: 4, verifiedFrom: 1 });
  });

  it('rotation keeps the sequence and the chain: the new file links to the archive', async () => {
    const logger = new AuditLogger({ logDir: dir });
    await fill(logger, 3);
    const before = logger.getPosition();
    const archive = await logger.rotateLog();
    expect(logger.getStats()).toEqual({ entryCount: 0, lastHash: before.lastHash });
    expect(logger.getPosition()).toEqual(before);

    const next = await logger.logCredentialAccess('s', 'agent', access);
    expect(next!.seq).toBe(4);
    expect(next!.previousHash).toBe(read(archive)[2].hash);
    expect(await logger.verifyChain()).toMatchObject({ valid: true, errors: [], entries: 1, lastSeq: 4, verifiedFrom: 1 });
    expect(await logger.verifyIntegrity()).toEqual({ valid: true, errors: [] });
  });

  it('a logger started after a rotation, with no current file, picks up from the newest archive', async () => {
    const first = new AuditLogger({ logDir: dir });
    await fill(first, 2);
    await first.rotateLog();
    await fill(first, 3);
    const archive = await first.rotateLog();

    const second = new AuditLogger({ logDir: dir });
    await second.initialize();
    expect(second.getStats().entryCount).toBe(0);
    expect(second.getPosition()).toEqual({ lastSeq: 5, lastHash: read(archive)[2].hash });
    const next = await second.logCredentialAccess('s', 'agent', access);
    expect(next!.seq).toBe(6);
    expect(await second.verifyChain()).toMatchObject({ valid: true, entries: 1, lastSeq: 6, verifiedFrom: 1 });
  });

  it('skips empty archives when it looks for where the log ended', async () => {
    const first = new AuditLogger({ logDir: dir });
    await fill(first, 2);
    await first.rotateLog();
    fs.writeFileSync(path.join(archiveDir(), 'audit-9999-01-01T00-00-00-000Z.jsonl'), '\n');
    fs.writeFileSync(path.join(archiveDir(), 'notes.txt'), 'not an archive');

    const second = new AuditLogger({ logDir: dir });
    await second.initialize();
    expect(second.getPosition().lastSeq).toBe(2);
    expect(await second.verifyChain()).toMatchObject({ valid: true, entries: 0, lastSeq: 2, verifiedFrom: 1 });
    expect(await second.hashAt(2)).toBe(second.getPosition().lastHash);
  });

  it('two rotations in the same millisecond get different archive names, in rotation order', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    const logger = new AuditLogger({ logDir: dir });
    await fill(logger, 1);
    const a = await logger.rotateLog();
    await fill(logger, 1);
    const b = await logger.rotateLog();
    await fill(logger, 1);
    const c = await logger.rotateLog();
    expect(path.basename(a)).toBe('audit-2026-01-02T03-04-05-006Z.jsonl');
    expect(path.basename(b)).toBe('audit-2026-01-02T03-04-05-007Z.jsonl');
    expect(path.basename(c)).toBe('audit-2026-01-02T03-04-05-008Z.jsonl');
    expect(archives()).toEqual([a, b, c].map((p) => path.basename(p)));
    expect(read(a)[0].seq).toBe(1);
    expect(read(c)[0].seq).toBe(3);
  });

  it('an archive name with no time in it is followed by the same name with a suffix', async () => {
    fs.mkdirSync(archiveDir(), { recursive: true });
    fs.writeFileSync(path.join(archiveDir(), 'audit-zzz.jsonl'), '');
    const logger = new AuditLogger({ logDir: dir });
    await fill(logger, 1);
    expect(path.basename(await logger.rotateLog())).toBe('audit-zzz_1.jsonl');
    await fill(logger, 1);
    expect(path.basename(await logger.rotateLog())).toBe('audit-zzz_1_1.jsonl');
    expect(archives()).toEqual(['audit-zzz.jsonl', 'audit-zzz_1.jsonl', 'audit-zzz_1_1.jsonl']);
  });

  it('a clock that went backwards still gives the new archive a name after the newest one', async () => {
    const logger = new AuditLogger({ logDir: dir });
    await fill(logger, 1);
    const a = await logger.rotateLog();
    await fill(logger, 1);
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2001, 0, 1));
    const b = await logger.rotateLog();
    vi.restoreAllMocks();
    expect(path.basename(b) > path.basename(a)).toBe(true);
    await fill(logger, 1);
    expect(await logger.verifyChain()).toMatchObject({ valid: true, lastSeq: 3, verifiedFrom: 1 });
  });

  describe('pruning', () => {
    async function rotateMany(maxArchives: number, rotations: number): Promise<AuditLogger> {
      const logger = new AuditLogger({ logDir: dir, maxLogSizeBytes: 1, maxArchives });
      // Every entry crosses the one-byte threshold, so each write rotates and prunes.
      await fill(logger, rotations);
      return logger;
    }

    it('keeps the newest archives and removes the oldest', async () => {
      const logger = await rotateMany(3, 6);
      const kept = archives();
      expect(kept).toHaveLength(3);
      expect(kept.map((name) => read(path.join(archiveDir(), name))[0].seq)).toEqual([4, 5, 6]);
      expect(await logger.verifyChain()).toMatchObject({ valid: true, entries: 0, lastSeq: 6, verifiedFrom: 4 });
    });

    it.each([
      ['1', 1, 1],
      ['a fraction below 1', 0.5, 1],
      ['a fraction above 1', 2.9, 2],
    ])('never removes the newest archive: maxArchives %s', async (_name, maxArchives, expected) => {
      const logger = await rotateMany(maxArchives, 5);
      const kept = archives();
      expect(kept).toHaveLength(expected);
      expect(read(path.join(archiveDir(), kept[kept.length - 1]))[0].seq).toBe(5);
      // The next entry still finds the archive it links to.
      const quiet = new AuditLogger({ logDir: dir, maxLogSizeBytes: 0 });
      await fill(quiet, 1);
      expect(await logger.verifyChain()).toMatchObject({ valid: true, entries: 1, lastSeq: 6 });
    });

    it.each([
      ['0', 0],
      ['a negative number', -1],
      ['not a number', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY],
    ])('retains every archive: maxArchives %s', async (_name, maxArchives) => {
      await rotateMany(maxArchives, 4);
      expect(archives()).toHaveLength(4);
    });

    it('an archive it cannot delete is left, and logging goes on', async () => {
      // A directory with an archive's name: unlink refuses it.
      const stuck = path.join(archiveDir(), 'audit-2000-01-01T00-00-00-000Z.jsonl');
      fs.mkdirSync(stuck, { recursive: true });
      const logger = new AuditLogger({ logDir: dir, maxLogSizeBytes: 1, maxArchives: 1 });
      await fill(logger, 3);
      expect(fs.existsSync(stuck)).toBe(true);
      expect(archives()).toHaveLength(2);
      expect(logger.getPosition().lastSeq).toBe(3);
    });
  });

  describe('entries without a sequence number', () => {
    it('count by position, verify, and the logger continues from them with numbers', async () => {
      const old = legacy(4);
      write(current(), old);
      const logger = new AuditLogger({ logDir: dir });
      await logger.initialize();
      expect(logger.getPosition()).toEqual({ lastSeq: 4, lastHash: old[3].hash });
      expect(await logger.verifyChain()).toMatchObject({ valid: true, entries: 4, lastSeq: 4, verifiedFrom: 1 });
      expect(await logger.hashAt(3)).toBe(old[2].hash);

      const next = await logger.logCredentialAccess('s', 'agent', access);
      expect(next!.seq).toBe(5);
      expect(next!.previousHash).toBe(old[3].hash);
      // The old entries are not rewritten.
      expect(read(current()).slice(0, 4)).toEqual(old);
      expect(await logger.verifyChain()).toMatchObject({ valid: true, entries: 5, lastSeq: 5, verifiedFrom: 1 });
    });

    it('an archive of them is where a later file links to, and archives before it are separate chains', async () => {
      fs.mkdirSync(archiveDir(), { recursive: true });
      write(path.join(archiveDir(), 'audit-2025-01-01T00-00-00-000Z.jsonl'), legacy(2));
      const newest = legacy(3);
      write(path.join(archiveDir(), 'audit-2025-06-01T00-00-00-000Z.jsonl'), newest);

      const logger = new AuditLogger({ logDir: dir });
      const next = await logger.logCredentialAccess('s', 'agent', access);
      expect(next!.seq).toBe(4);
      expect(next!.previousHash).toBe(newest[2].hash);
      // The walk ends at the archive that starts at sequence 1.
      expect(await logger.verifyChain()).toMatchObject({ valid: true, entries: 1, lastSeq: 4, verifiedFrom: 1 });
    });

    it('one that follows a numbered entry is an error', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const lines = read(current());
      const { seq: _seq, ...rest } = lines[1];
      const stripped: any = rest;
      stripped.hash = computeChainedHash(JSON.stringify({ ...stripped, hash: undefined }), stripped.previousHash);
      write(current(), [lines[0], stripped]);
      expect((await logger.verifyChain()).errors).toEqual(['Entry 1: sequence number missing (expected 2)']);
    });
  });

  describe('verifyChain', () => {
    it.each([
      ['zero', 0],
      ['negative', -3],
      ['a fraction', 1.5],
      ['a string', '2'],
      ['null', null],
    ])('rejects a sequence number that is %s', async (_name, seq) => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const lines = read(current());
      lines[1].seq = seq;
      write(current(), lines);
      const { errors } = await logger.verifyChain();
      expect(errors[0]).toBe(`Entry 1: invalid sequence number ${JSON.stringify(seq)}`);
    });

    it('reports a line that is JSON but not an entry, and one that is not JSON, and counts both as positions', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 3);
      const lines = fs.readFileSync(current(), 'utf-8').trim().split('\n');
      fs.writeFileSync(current(), ['null', lines[1], '{"cut', ''].join('\n'));
      const result = await logger.verifyChain();
      expect(result.errors).toEqual(['Entry 0: failed to parse JSON', 'Entry 2: failed to parse JSON']);
      expect(result).toMatchObject({ valid: false, entries: 3, lastSeq: 3, lastHash: GENESIS, verifiedFrom: 1 });
      expect(await logger.hashAt(1)).toBeNull();
      expect(await logger.hashAt(2)).toBe(JSON.parse(lines[1]).hash);
    });

    it('a first entry at sequence 1 must start from the genesis hash, in the current file and in an archive', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const lines = read(current());
      const other = 'f'.repeat(64);
      const first: any = { ...lines[0], previousHash: other };
      first.hash = computeChainedHash(JSON.stringify({ ...first, hash: undefined }), other);
      const second: any = { ...lines[1], previousHash: first.hash };
      second.hash = computeChainedHash(JSON.stringify({ ...second, hash: undefined }), first.hash);
      write(current(), [first, second]);
      expect((await logger.verifyChain()).errors).toEqual([`Entry 0: previousHash mismatch (expected ${GENESIS}, got ${other})`]);

      const fresh = new AuditLogger({ logDir: dir });
      await fresh.initialize();
      const archive = await fresh.rotateLog();
      expect((await fresh.verifyChain()).errors).toEqual([
        `Archive ${path.basename(archive)} entry 0: previousHash mismatch (expected ${GENESIS}, got ${other})`,
      ]);
    });

    it('an archive that starts above sequence 1 with nothing before it is where the retained log begins', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const first = await logger.rotateLog();
      await fill(logger, 2);
      await logger.rotateLog();
      fs.rmSync(first);
      expect(await logger.verifyChain()).toMatchObject({ valid: true, errors: [], entries: 0, lastSeq: 4, verifiedFrom: 3 });
      expect(await logger.hashAt(2)).toBeNull();
      expect(await logger.hashAt(9)).toBeNull();
    });

    it('reports errors inside an archive it walks through, with the archive named', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const archive = await logger.rotateLog();
      await fill(logger, 1);
      const lines = fs.readFileSync(archive, 'utf-8').trim().split('\n');
      fs.writeFileSync(archive, `not json\n${lines[1]}\n`);
      const result = await logger.verifyChain();
      expect(result.errors).toEqual([`Archive ${path.basename(archive)} entry 0: failed to parse JSON`]);
      expect(result.verifiedFrom).toBe(1);
    });

    it('an archive whose last line is not an entry cannot be linked to by hash, and is reported once', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const archive = await logger.rotateLog();
      await fill(logger, 1);
      const lines = fs.readFileSync(archive, 'utf-8').trim().split('\n');
      fs.writeFileSync(archive, `${lines[0]}\nnot json\n`);
      const result = await logger.verifyChain();
      expect(result.errors).toEqual([`Archive ${path.basename(archive)} entry 1: failed to parse JSON`]);
    });
  });

  describe('write-ahead log', () => {
    it('an entry that reached the log before the crash is not written a second time', async () => {
      const logger = new AuditLogger({ logDir: dir });
      await fill(logger, 2);
      const lines = fs.readFileSync(current(), 'utf-8').trim().split('\n');
      // The crash came after the append and before the WAL was cleared.
      fs.writeFileSync(path.join(dir, 'current.wal'), lines[1] + '\n');

      const recovered = new AuditLogger({ logDir: dir });
      await recovered.initialize();
      expect(read(current())).toHaveLength(2);
      expect(recovered.getPosition().lastSeq).toBe(2);
      expect(await recovered.verifyChain()).toMatchObject({ valid: true, entries: 2 });
    });

    it('an entry that did not reach the log is replayed with its number, and one without a number counts on by one', async () => {
      const source = path.join(dir, 'source');
      const writer = new AuditLogger({ logDir: source });
      await fill(writer, 2);
      const lines = fs.readFileSync(path.join(source, 'current.jsonl'), 'utf-8').trim().split('\n');

      const crashed = path.join(dir, 'crashed');
      fs.mkdirSync(crashed);
      fs.writeFileSync(path.join(crashed, 'current.jsonl'), lines[0] + '\n');
      fs.writeFileSync(path.join(crashed, 'current.wal'), lines[1] + '\n');
      const recovered = new AuditLogger({ logDir: crashed });
      await recovered.initialize();
      expect(recovered.getPosition()).toEqual({ lastSeq: 2, lastHash: JSON.parse(lines[1]).hash });
      expect(await recovered.verifyChain()).toMatchObject({ valid: true, entries: 2, lastSeq: 2 });

      const old = legacy(2);
      const oldDir = path.join(dir, 'old');
      fs.mkdirSync(oldDir);
      fs.writeFileSync(path.join(oldDir, 'current.jsonl'), JSON.stringify(old[0]) + '\n');
      fs.writeFileSync(path.join(oldDir, 'current.wal'), JSON.stringify(old[1]) + '\n');
      const oldLogger = new AuditLogger({ logDir: oldDir });
      await oldLogger.initialize();
      expect(oldLogger.getPosition()).toEqual({ lastSeq: 2, lastHash: old[1].hash });
    });
  });

  describe('entry listener', () => {
    it('is called once per entry written, and not at all once removed', async () => {
      const logger = new AuditLogger({ logDir: dir });
      const seen: number[] = [];
      logger.onEntryWritten(() => seen.push(logger.getPosition().lastSeq));
      await fill(logger, 3);
      expect(seen).toEqual([1, 2, 3]);
      logger.onEntryWritten(null);
      await fill(logger, 1);
      expect(seen).toEqual([1, 2, 3]);
    });

    it('a listener that throws does not fail the write or lose the entry', async () => {
      const logger = new AuditLogger({ logDir: dir });
      logger.onEntryWritten(() => { throw new Error('listener broke'); });
      const entry = await logger.logCredentialAccess('s', 'agent', access);
      expect(entry!.seq).toBe(1);
      expect(read(current())).toHaveLength(1);
    });

    it('a disabled logger writes nothing and calls nothing', async () => {
      const logger = new AuditLogger({ logDir: path.join(dir, 'off'), enabled: false });
      let calls = 0;
      logger.onEntryWritten(() => { calls++; });
      expect(await logger.logCredentialAccess('s', 'agent', access)).toBeNull();
      expect(calls).toBe(0);
      expect(logger.getPosition()).toEqual({ lastSeq: 0, lastHash: GENESIS });
    });
  });
});
