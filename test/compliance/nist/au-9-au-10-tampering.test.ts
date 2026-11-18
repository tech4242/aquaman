/**
 * Compliance test: NIST SP 800-53 AU-9 (protection of audit information) and
 * AU-10 (non-repudiation), from the side of someone trying to defeat them.
 *
 * A real log is written by `AuditLogger` and anchored the way a serving
 * process anchors it, then changed on disk the way a process running as the
 * user could change it. Each row asserts that the change is detected by the
 * check `aquaman audit verify` runs: a new `AuditLogger` opened for reading
 * on the directory, its chain walked, and the log compared with the anchor
 * in the credential store.
 *
 * Two things detect a change. The chain links each entry to the one before
 * it and numbers them, so a change inside the retained files breaks it. The
 * anchor records the sequence and hash the log had reached and the sequence
 * it is supposed to begin at (`from`), so a log that is shorter than that at
 * either end, gone, or holds a different entry there is caught even when its
 * chain is valid on its own terms.
 *
 * What is left is stated as `it.fails` rows: entries written after the last
 * anchor, software that can write to the credential store, and an anchor
 * written without `from`. Each asserts what should hold and turns into a
 * failure the day it does.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, MemoryStore, computeChainedHash } from 'aquaman-core';
import {
  AUDIT_ANCHOR_KEY,
  RESERVED_SERVICE,
  createAuditAnchorWriter,
  readAuditAnchor,
  verifyAuditLog,
  type AuditVerification,
} from 'aquaman-proxy';

const GENESIS = '0'.repeat(64);
const ENTRIES = 12;

interface Entry {
  seq?: number;
  data: { service: string; operation: string; success: boolean; error?: string };
  previousHash: string;
  hash: string;
  [k: string]: unknown;
}

/**
 * Re-link entries into a chain that is valid on its own terms, as the logger
 * would have written it: numbered from `firstSeq`, starting from `previous`.
 */
function rechain(entries: Entry[], firstSeq = 1, previous = GENESIS): Entry[] {
  return entries.map((entry, i) => {
    const relinked: Entry = { ...entry, seq: firstSeq + i, previousHash: previous };
    relinked.hash = computeChainedHash(JSON.stringify({ ...relinked, hash: undefined }), previous);
    previous = relinked.hash;
    return relinked;
  });
}

/** The same entries as a release without sequence numbers wrote them. */
function unnumbered(entries: Entry[]): Entry[] {
  let previous = GENESIS;
  return entries.map((entry) => {
    const { seq: _seq, ...rest } = entry;
    const legacy = { ...rest, previousHash: previous } as Entry;
    legacy.hash = computeChainedHash(JSON.stringify({ ...legacy, hash: undefined }), previous);
    previous = legacy.hash;
    return legacy;
  });
}

const write = (file: string, entries: Entry[]) =>
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));

const read = (file: string): Entry[] =>
  fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Entry);

interface Scene {
  logDir: string;
  /** `current.jsonl`. */
  file: string;
  /** What `current.jsonl` held when the anchor was written. */
  entries: Entry[];
  /** The credential store that holds the anchor. */
  store: MemoryStore;
}

interface Attack {
  name: string;
  tamper(scene: Scene): void | Promise<void>;
  /** What `audit verify` must report about the anchor; absent when the chain alone catches it. */
  anchor?: AuditVerification['anchor']['status'];
}

/** Changes inside the log. The chain catches each one, with or without an anchor. */
const CHAIN_ATTACKS: Attack[] = [
  {
    name: 'alter an entry (a failed read rewritten as a success)',
    tamper({ file, entries }) {
      const forged = entries.map((e) => ({ ...e }));
      forged[4] = { ...forged[4], data: { ...forged[4].data, success: true, error: undefined } };
      write(file, forged);
    },
  },
  {
    name: 'alter an entry (a different service named)',
    tamper({ file, entries }) {
      const forged = entries.map((e) => ({ ...e }));
      forged[7] = { ...forged[7], data: { ...forged[7].data, service: 'something-else' } };
      write(file, forged);
    },
  },
  {
    name: 'alter a sequence number',
    tamper({ file, entries }) {
      const forged = entries.map((e) => ({ ...e }));
      forged[9] = { ...forged[9], seq: 99 };
      write(file, forged);
    },
  },
  {
    name: 'insert an entry in the middle',
    tamper({ file, entries }) {
      const forged = [...entries];
      forged.splice(5, 0, { ...entries[5], id: 'inserted' });
      write(file, forged);
    },
  },
  {
    name: 'append a forged entry that does not link to the last one',
    tamper({ file, entries }) {
      write(file, [...entries, { ...entries[0], id: 'appended' }]);
    },
  },
  {
    name: 'delete an entry in the middle',
    tamper({ file, entries }) {
      write(file, entries.filter((_, i) => i !== 6));
    },
  },
  {
    name: 'delete an entry in the middle and re-link the hashes around the gap (the sequence numbers no longer run on)',
    tamper({ file, entries }) {
      const kept = entries.filter((_, i) => i !== 6);
      let previous = GENESIS;
      write(file, kept.map((entry) => {
        const relinked: Entry = { ...entry, previousHash: previous };
        relinked.hash = computeChainedHash(JSON.stringify({ ...relinked, hash: undefined }), previous);
        previous = relinked.hash;
        return relinked;
      }));
    },
  },
  {
    name: 'delete the first entry',
    tamper({ file, entries }) {
      write(file, entries.slice(1));
    },
  },
  {
    name: 'delete the first four entries and rebuild the rest as a file that starts at sequence 5, with no archive before it',
    tamper({ file, entries }) {
      write(file, rechain(entries.slice(4), 5));
    },
  },
  {
    name: 'swap two entries',
    tamper({ file, entries }) {
      const forged = [...entries];
      [forged[2], forged[3]] = [forged[3], forged[2]];
      write(file, forged);
    },
  },
  {
    name: 'replace a line with text that is not an entry',
    tamper({ file, entries }) {
      const lines = entries.map((e) => JSON.stringify(e));
      lines[8] = 'not json';
      fs.writeFileSync(file, lines.join('\n') + '\n');
    },
  },
  {
    name: 'strip the sequence number from one entry and recompute its hash',
    tamper({ file, entries }) {
      const forged = entries.map((e) => ({ ...e }));
      const { seq: _seq, ...rest } = forged[11];
      const stripped = rest as Entry;
      stripped.hash = computeChainedHash(JSON.stringify({ ...stripped, hash: undefined }), stripped.previousHash);
      forged[11] = stripped;
      write(file, forged);
    },
  },
];

/**
 * Changes that leave a chain valid on its own terms. Nothing in the log
 * shows them; the anchor does.
 */
const ANCHOR_ATTACKS: Attack[] = [
  {
    name: 'truncate the tail (the last four entries removed)',
    anchor: 'truncated',
    tamper({ file, entries }) {
      write(file, entries.slice(0, -4));
    },
  },
  {
    name: 'empty the file',
    anchor: 'missing',
    tamper({ file }) {
      fs.writeFileSync(file, '');
    },
  },
  {
    name: 'delete the file',
    anchor: 'missing',
    tamper({ file }) {
      fs.rmSync(file);
    },
  },
  {
    name: 'delete the whole audit directory',
    anchor: 'missing',
    tamper({ logDir }) {
      fs.rmSync(logDir, { recursive: true });
    },
  },
  {
    name: 'remove every read, turn failures into successes, and rebuild the chain',
    anchor: 'truncated',
    tamper({ file, entries }) {
      const kept = entries
        .filter((e) => e.data.operation !== 'read')
        .map((e) => ({ ...e, data: { service: e.data.service, operation: e.data.operation, success: true } }));
      write(file, rechain(kept));
    },
  },
  {
    name: 'rewrite one entry and rebuild the chain at the same length',
    anchor: 'rebuilt',
    tamper({ file, entries }) {
      const forged = entries.map((e) => ({ ...e }));
      forged[4] = { ...forged[4], data: { service: forged[4].data.service, operation: 'use', success: true } };
      write(file, rechain(forged));
    },
  },
  {
    name: 'rebuild the chain and pad it with invented entries past the anchored sequence',
    anchor: 'rebuilt',
    tamper({ file, entries }) {
      const kept = entries.filter((e) => e.data.operation !== 'read');
      const padding = Array.from({ length: 8 }, (_, i) => ({ ...entries[1], id: `invented-${i}` }));
      write(file, rechain([...kept, ...padding]));
    },
  },
  {
    name: 'put back an older copy of the log (roll the log back, leave the anchor)',
    anchor: 'truncated',
    tamper({ file, entries }) {
      // The first eight entries are exactly what the file held four entries ago.
      write(file, entries.slice(0, 8));
    },
  },
  {
    name: 'rotate everything away and start a fresh log from sequence 1',
    anchor: 'truncated',
    tamper({ file, entries }) {
      write(file, rechain([{ ...entries[1], id: 'fresh' }]));
    },
  },
  {
    name: 'rebuild the log as a file that starts past the anchored sequence, with a matching invented archive',
    anchor: 'rebuilt',
    tamper({ logDir, file, entries }) {
      const archive = rechain(entries.slice(0, 6).map((e) => ({ ...e, data: { ...e.data, success: true, error: undefined } })), 8);
      const current = rechain(entries.slice(6), 14, archive[archive.length - 1].hash);
      write(path.join(logDir, 'archive', 'audit-2020-01-01T00-00-00-000Z.jsonl'), archive);
      write(file, current);
    },
  },
  {
    // The log never rotated, so nothing was ever pruned. A first line above
    // sequence 1 in an archive, with nothing before it, is what pruning leaves.
    name: 'delete every entry before the anchored one and move the anchored entry, untouched, into an archive file (made to look like pruning)',
    anchor: 'head_missing',
    tamper({ logDir, file, entries }) {
      write(path.join(logDir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries.slice(-1));
      fs.rmSync(file);
    },
  },
  {
    name: 'delete the first seven entries, leave the eighth as "the newest archive" and the rest in the current file',
    anchor: 'head_missing',
    tamper({ logDir, file, entries }) {
      write(path.join(logDir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), entries.slice(7, 8));
      write(file, entries.slice(8));
    },
  },
];

describe('NIST AU-9 / AU-10: tampering with the audit log', () => {
  let scene: Scene;

  /** Entries the way the proxies write them. */
  async function log(logger: AuditLogger, count: number, from = 0): Promise<void> {
    for (let i = from; i < from + count; i++) {
      await logger.logCredentialAccess('system', 'system', {
        service: i % 2 ? 'github' : 'anthropic',
        operation: i % 3 === 0 ? 'read' : 'use',
        success: i !== 4,
        error: i === 4 ? 'Policy denied: DELETE /v1/x' : undefined,
      });
    }
  }

  /** What a serving process does at shutdown, or once per interval: anchor the log where it ends. */
  async function anchor(logger: AuditLogger, store = scene.store): Promise<void> {
    const writer = createAuditAnchorWriter({ logger, store, intervalSeconds: 60, report: () => {} });
    await writer.ready;
    await writer.stop();
  }

  beforeEach(async () => {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-au9-'));
    const file = path.join(logDir, 'current.jsonl');
    const store = new MemoryStore();
    scene = { logDir, file, entries: [], store };
    const logger = new AuditLogger({ logDir });
    await logger.initialize();
    await log(logger, ENTRIES);
    await anchor(logger);
    scene.entries = read(file);
  });

  afterEach(() => {
    fs.rmSync(scene.logDir, { recursive: true, force: true });
  });

  /** What `aquaman audit verify` does: a fresh logger opened for reading on the directory, and the anchor from the store. */
  async function verify(store = scene.store): Promise<AuditVerification> {
    const logger = new AuditLogger({ logDir: scene.logDir, readOnly: true });
    await logger.initialize();
    return verifyAuditLog({ logger, openStore: async () => store, anchoring: true });
  }

  it('the untouched log verifies against its anchor, and holds every entry that was written', async () => {
    expect(scene.entries).toHaveLength(ENTRIES);
    expect(scene.entries.map((e) => e.seq)).toEqual(Array.from({ length: ENTRIES }, (_, i) => i + 1));
    const result = await verify();
    expect(result.valid).toBe(true);
    expect(result.chain).toMatchObject({ valid: true, errors: [], entries: ENTRIES, lastSeq: ENTRIES, verifiedFrom: 1 });
    expect(result.anchor).toMatchObject({ status: 'matches', seq: ENTRIES, unanchored: 0 });
    expect(await readAuditAnchor(scene.store)).toMatchObject({ v: 1, seq: ENTRIES, hash: scene.entries[ENTRIES - 1].hash, from: 1 });
  });

  it('the rebuilt-chain helper produces what the logger would: re-linking the untouched log changes nothing', () => {
    expect(rechain(scene.entries)).toEqual(scene.entries);
  });

  describe('changes inside the log break the chain', () => {
    for (const attack of CHAIN_ATTACKS) {
      it(`detected: ${attack.name}`, async () => {
        await attack.tamper(scene);
        const result = await verify();
        expect(result.valid).toBe(false);
        expect(result.chain.valid).toBe(false);
        expect(result.chain.errors.length).toBeGreaterThan(0);
        // The chain says so on its own, with no anchor to consult.
        expect((await verify(new MemoryStore())).valid).toBe(false);
      });
    }
  });

  describe('changes that leave a valid chain are caught by the anchor', () => {
    for (const attack of ANCHOR_ATTACKS) {
      it(`detected: ${attack.name}`, async () => {
        await attack.tamper(scene);
        const result = await verify();
        expect(result.valid).toBe(false);
        expect(result.anchor.status).toBe(attack.anchor);
        expect(result.anchor.seq).toBe(ENTRIES);
        expect(result.fix).toContain('aquaman audit accept');
      });

      it(`the same change with no anchor to compare against passes, which is why the anchor exists: ${attack.name}`, async () => {
        await attack.tamper(scene);
        const result = await verify(new MemoryStore());
        expect(result.chain.valid).toBe(true);
        expect(result.anchor.status).toBe('not_anchored');
        expect(result.valid).toBe(true);
      });
    }

    it('detected: an anchor for a sequence beyond the end of an otherwise untouched log', async () => {
      await scene.store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify({ v: 1, seq: ENTRIES + 5, hash: 'ab'.repeat(32), at: new Date().toISOString() }));
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.anchor).toMatchObject({ status: 'truncated', seq: ENTRIES + 5 });
    });

    it('detected: an old log put back together with entries appended to it afterwards (the anchored entry is no longer there)', async () => {
      // Roll back to eight entries, then let a logger carry on from there past the anchored sequence.
      write(scene.file, scene.entries.slice(0, 8));
      const resumed = new AuditLogger({ logDir: scene.logDir });
      await log(resumed, 6, 100);
      const result = await verify();
      expect(result.chain.valid).toBe(true);
      expect(result.chain.lastSeq).toBe(14);
      expect(result.valid).toBe(false);
      expect(result.anchor.status).toBe('rebuilt');
    });

    it('detected: the anchor replaced with something that is not an anchor', async () => {
      await scene.store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, '{"v":1,"seq":"12"}');
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.anchor.status).toBe('malformed');
    });
  });

  describe('rotation', () => {
    /** Twelve entries in an archive, six more in the current file, anchored at 18. */
    async function rotated(): Promise<{ archive: string; logger: AuditLogger }> {
      const logger = new AuditLogger({ logDir: scene.logDir });
      await logger.initialize();
      const archive = await logger.rotateLog();
      await log(logger, 6, 20);
      await anchor(logger);
      return { archive, logger };
    }

    it('keeps the chain and the anchor valid: the new file goes on from the archive', async () => {
      const { archive } = await rotated();
      const current = read(scene.file);
      expect(current[0].seq).toBe(ENTRIES + 1);
      expect(current[0].previousHash).toBe(read(archive)[ENTRIES - 1].hash);
      const result = await verify();
      expect(result.valid).toBe(true);
      expect(result.chain).toMatchObject({ entries: 6, lastSeq: 18, verifiedFrom: 1 });
      expect(result.anchor).toMatchObject({ status: 'matches', seq: 18 });
    });

    it('an anchor that points into an archive still matches, and a rotated log with an empty current file verifies', async () => {
      const { logger } = await rotated();
      await logger.rotateLog();
      const result = await verify();
      expect(result.valid).toBe(true);
      expect(result.chain).toMatchObject({ entries: 0, lastSeq: 18, verifiedFrom: 1 });
      expect(result.anchor).toMatchObject({ status: 'matches', seq: 18, unanchored: 0 });
    });

    it('detected: the newest archive deleted', async () => {
      const { archive } = await rotated();
      fs.rmSync(archive);
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.errors).toEqual([`The log starts at sequence 13, and the archive that holds sequence 12 is missing`]);
    });

    it('detected: the newest archive cut short', async () => {
      const { archive } = await rotated();
      write(archive, read(archive).slice(0, -3));
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.errors[0]).toMatch(/^The log starts at sequence 13, but archive audit-.*\.jsonl ends at sequence 9$/);
    });

    it('detected: the newest archive replaced by a rebuilt one of the same length', async () => {
      const { archive } = await rotated();
      write(archive, rechain(read(archive).map((e) => ({ ...e, data: { ...e.data, success: true, error: undefined } }))));
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.errors[0]).toMatch(/^The log does not link to archive audit-.*\.jsonl: previousHash mismatch at sequence 13/);
    });

    it('detected: an entry altered inside an archive', async () => {
      const { archive } = await rotated();
      const forged = read(archive);
      forged[3] = { ...forged[3], data: { ...forged[3].data, service: 'something-else' } };
      write(archive, forged);
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.errors[0]).toMatch(/^Archive audit-.*\.jsonl entry 3: hash mismatch/);
    });

    it('detected: an archive in the middle deleted', async () => {
      const { logger } = await rotated();
      const middle = await logger.rotateLog();
      await log(logger, 3, 40);
      await anchor(logger);
      expect((await verify()).valid).toBe(true);
      fs.rmSync(middle);
      // The current file now starts at 19 and the newest archive left ends at 12.
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain.errors[0]).toMatch(/^The log starts at sequence 19, but archive audit-.*\.jsonl ends at sequence 12$/);
    });

    /**
     * A logger that rotates after every entry and keeps two archives, with an
     * anchor writer beside it as in a serving process. Six entries: archives
     * 1-13, 14 ... 18, of which the last two are kept.
     */
    async function pruned(store = scene.store): Promise<{ logger: AuditLogger; stop(): Promise<void> }> {
      const logger = new AuditLogger({ logDir: scene.logDir, maxArchives: 2, maxLogSizeBytes: 1 });
      await logger.initialize();
      const writer = createAuditAnchorWriter({ logger, store, intervalSeconds: 3600, report: () => {} });
      await writer.ready;
      await log(logger, 6, 50);
      return { logger, stop: () => writer.stop() };
    }
    const archiveNames = () => fs.readdirSync(path.join(scene.logDir, 'archive')).sort();

    it('pruned archives are named, not hidden: the anchor records where the log begins now, and the result says which sequence it was verified from', async () => {
      const { stop } = await pruned();
      await stop();
      expect(archiveNames()).toHaveLength(2);
      const result = await verify();
      expect(result.valid).toBe(true);
      expect(result.chain).toMatchObject({ lastSeq: 18, verifiedFrom: 17 });
      expect(result.anchor).toMatchObject({ status: 'matches', seq: 18, from: 17 });
    });

    it('the anchor follows pruning at once, not at the next interval: a process killed right after it pruned leaves a log that verifies', async () => {
      // An hour between anchor writes, and the process is never stopped cleanly.
      await pruned();
      await new Promise((resolve) => setImmediate(resolve));
      expect(await readAuditAnchor(scene.store)).toMatchObject({ seq: 18, from: 17 });
      expect((await verify()).valid).toBe(true);
    });

    it('detected: the oldest archive deleted (it looks like pruning, and the anchor says nothing was pruned)', async () => {
      const logger = new AuditLogger({ logDir: scene.logDir });
      await logger.initialize();
      const oldest = await logger.rotateLog();
      await log(logger, 4, 90);
      await logger.rotateLog();
      await log(logger, 2, 95);
      await anchor(logger);
      fs.rmSync(oldest);
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.chain).toMatchObject({ valid: true, verifiedFrom: 13 });
      expect(result.anchor).toMatchObject({ status: 'head_missing', seq: 18, from: 1 });
      expect(result.anchor.message).toMatch(/^entries 1 to 12 are missing: they were on disk when the anchor was written \(.*\), and the log now begins at sequence 13$/);
      expect(result.fix).toContain('aquaman audit accept');
    });

    it('detected: after pruning, the oldest archive that was kept deleted', async () => {
      const { stop } = await pruned();
      await stop();
      fs.rmSync(path.join(scene.logDir, 'archive', archiveNames()[0]));
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.anchor).toMatchObject({ status: 'head_missing', from: 17 });
      expect(result.anchor.message).toContain('entries 17 to 17 are missing');
    });

    it('detected: an archive deleted between a prune and the anchor write that follows it', async () => {
      // The store stands in for the moment between the two: it deletes the
      // oldest archive pruning kept just before it takes the anchor.
      const store = new MemoryStore();
      const set = store.set.bind(store);
      store.set = async (service, key, value) => {
        if (archiveNames().length === 2) fs.rmSync(path.join(scene.logDir, 'archive', archiveNames()[0]));
        return set(service, key, value);
      };
      const logger = new AuditLogger({ logDir: scene.logDir, maxArchives: 2, maxLogSizeBytes: 1 });
      await logger.initialize();
      const writer = createAuditAnchorWriter({ logger, store, intervalSeconds: 3600, report: () => {} });
      await writer.ready;
      // Archives 1-13, 14 and 15; the first is pruned, so the log is supposed to begin at 14.
      await log(logger, 3, 50);
      await writer.flush();
      const result = await verify(store);
      expect(result.valid).toBe(false);
      expect(result.anchor).toMatchObject({ status: 'head_missing', seq: 15, from: 14 });
      expect(result.anchor.message).toContain('entries 14 to 14 are missing');
    });

    it('a process that starts on a log whose head was removed reports it and leaves the anchor alone', async () => {
      const logger = new AuditLogger({ logDir: scene.logDir });
      await logger.initialize();
      const oldest = await logger.rotateLog();
      await log(logger, 4, 90);
      await anchor(logger);
      const anchored = await scene.store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
      fs.rmSync(oldest);

      const restarted = new AuditLogger({ logDir: scene.logDir });
      await restarted.initialize();
      const reports: string[] = [];
      const writer = createAuditAnchorWriter({ logger: restarted, store: scene.store, intervalSeconds: 60, report: (l) => reports.push(l) });
      await writer.ready;
      await log(restarted, 3, 96);
      await writer.stop();

      expect(writer.isPaused()).toBe(true);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatch(/^AUDIT FAILURE: the audit log does not match its anchor: entries 1 to 12 are missing: they were on disk when the anchor was written/);
      expect(reports[0]).toContain('aquaman audit accept');
      expect(await scene.store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY)).toBe(anchored);
      expect((await verify()).anchor.status).toBe('head_missing');
    });
  });

  describe('a log from before sequence numbers', () => {
    it('verifies, and the logger goes on from it with sequence numbers', async () => {
      const legacy = unnumbered(scene.entries);
      expect(legacy.every((e) => e.seq === undefined)).toBe(true);
      write(scene.file, legacy);
      const empty = new MemoryStore();

      // No anchor yet: the bootstrap case passes on the chain.
      const before = await verify(empty);
      expect(before.valid).toBe(true);
      expect(before.chain).toMatchObject({ entries: ENTRIES, lastSeq: ENTRIES, verifiedFrom: 1 });
      expect(before.anchor.status).toBe('not_anchored');

      const logger = new AuditLogger({ logDir: scene.logDir });
      await log(logger, 3, 70);
      const lines = read(scene.file);
      expect(lines.slice(0, ENTRIES)).toEqual(legacy);
      expect(lines.slice(ENTRIES).map((e) => e.seq)).toEqual([13, 14, 15]);
      expect(lines[ENTRIES].previousHash).toBe(legacy[ENTRIES - 1].hash);

      await anchor(logger, empty);
      const after = await verify(empty);
      expect(after.valid).toBe(true);
      expect(after.anchor).toMatchObject({ status: 'matches', seq: 15 });

      // Once anchored, the same attacks are caught on a log that began unnumbered.
      write(scene.file, lines.slice(0, 10));
      expect((await verify(empty)).anchor.status).toBe('truncated');
    });

    it('detected: an unnumbered entry removed from the middle, and one appended after numbered entries', async () => {
      const legacy = unnumbered(scene.entries);
      write(scene.file, legacy.filter((_, i) => i !== 5));
      expect((await verify(new MemoryStore())).chain.valid).toBe(false);

      write(scene.file, [...scene.entries, unnumbered(scene.entries)[0]]);
      const result = await verify(new MemoryStore());
      expect(result.chain.errors).toContain('Entry 12: sequence number missing (expected 13)');
    });
  });

  it('a running logger notices a truncated tail at its next write: the entry it adds no longer links', async () => {
    const running = new AuditLogger({ logDir: scene.logDir });
    await running.initialize();
    write(scene.file, scene.entries.slice(0, -4));
    await running.logCredentialAccess('system', 'system', { service: 'github', operation: 'read', success: true });
    expect((await verify()).chain.valid).toBe(false);
  });

  describe('what the anchor does not cover', () => {
    // Current limit: the anchor is written at most once per interval, so the
    // newest entries have no anchor until the next write.
    it.fails('should be detected, is not: the entries written since the last anchor cut off (they are not anchored until the next interval)', async () => {
      const logger = new AuditLogger({ logDir: scene.logDir });
      await log(logger, 3, 80);
      expect((await verify()).anchor).toMatchObject({ status: 'matches', unanchored: 3 });
      write(scene.file, read(scene.file).slice(0, ENTRIES));
      expect((await verify()).valid).toBe(false);
    });

    // Current limit: the anchor is a value in the credential store, and the
    // store's own access control is all that guards it.
    it.fails('should be detected, is not: the log truncated and the anchor moved back by software that can write to the credential store', async () => {
      const kept = scene.entries.slice(0, 8);
      write(scene.file, kept);
      await scene.store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify({ v: 1, seq: 8, hash: kept[7].hash, at: new Date().toISOString() }));
      expect((await verify()).valid).toBe(false);
    });

    // Current limit: the same store write, with the anchor removed instead of moved.
    it.fails('should be detected, is not: the log rebuilt and the anchor deleted from the credential store (reported as not anchored yet)', async () => {
      write(scene.file, rechain(scene.entries.filter((e) => e.data.operation !== 'read')));
      await scene.store.delete(RESERVED_SERVICE, AUDIT_ANCHOR_KEY);
      expect((await verify()).valid).toBe(false);
    });

    /** The head of the log removed so that what is left looks pruned: entries 1 to 8 gone, 9 in an archive, the rest current. */
    function removeHead(): void {
      write(path.join(scene.logDir, 'archive', 'audit-2026-01-01T00-00-00-000Z.jsonl'), scene.entries.slice(8, 9));
      write(scene.file, scene.entries.slice(9));
    }

    // Current limit: the same store write, on the other end of the log.
    it.fails('should be detected, is not: the early entries removed and the anchor\'s `from` raised by software that can write to the credential store', async () => {
      removeHead();
      const stored = JSON.parse((await scene.store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY))!);
      await scene.store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify({ ...stored, from: 9 }));
      expect((await verify()).valid).toBe(false);
    });

    // Current limit: an anchor without `from` says where the log ended and
    // nothing about where it began. No release wrote one; a store that holds
    // one gets `from` at the next anchor write, taken from the log as it is then.
    it.fails('should be detected, is not: the early entries removed from a log whose anchor was written without `from` (reported as "not checked for missing early entries")', async () => {
      const { from: _from, ...withoutFrom } = JSON.parse((await scene.store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY))!);
      await scene.store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify(withoutFrom));
      removeHead();
      expect((await verify()).valid).toBe(false);
    });

    it('an anchor without `from` on a log that begins later than sequence 1 passes, and the result says the early entries were not checked for', async () => {
      const { from: _from, ...withoutFrom } = JSON.parse((await scene.store.get(RESERVED_SERVICE, AUDIT_ANCHOR_KEY))!);
      await scene.store.set(RESERVED_SERVICE, AUDIT_ANCHOR_KEY, JSON.stringify(withoutFrom));
      // On a log that begins at 1 there is nothing to say.
      const whole = await verify();
      expect(whole.anchor.message).not.toContain('not checked');
      expect(whole.anchor.from).toBeUndefined();

      removeHead();
      const result = await verify();
      expect(result.valid).toBe(true);
      expect(result.chain.verifiedFrom).toBe(9);
      expect(result.anchor.status).toBe('matches');
      expect(result.anchor.message).toMatch(/; the log begins at sequence 9 and this anchor does not record where it should begin, so it was not checked for missing early entries$/);

      // The next process to anchor the log records where it begins, as the log is by then.
      const logger = new AuditLogger({ logDir: scene.logDir });
      await logger.initialize();
      await log(logger, 1, 99);
      await anchor(logger);
      expect(await readAuditAnchor(scene.store)).toMatchObject({ seq: 13, from: 9 });
    });

    // Not a missed detection but a false one, and it stays until a person
    // looks: pruning deletes the files before the anchor can say so.
    it('a process that stops between pruning and the anchor write that follows leaves a log that fails verification until a person accepts it', async () => {
      const logger = new AuditLogger({ logDir: scene.logDir, maxArchives: 2, maxLogSizeBytes: 1 });
      await logger.initialize();
      const writer = createAuditAnchorWriter({ logger, store: scene.store, intervalSeconds: 3600, report: () => {} });
      await writer.ready;
      // Archives 1-13 and 14, nothing pruned yet, anchored at 14.
      await log(logger, 2, 50);
      await writer.flush();
      expect(await readAuditAnchor(scene.store)).toMatchObject({ seq: 14, from: 1 });

      // The next entry prunes the first archive, and the anchor write that follows never happens.
      scene.store.set = async () => { throw new Error('the process was killed here'); };
      await log(logger, 1, 60);
      await writer.flush();

      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.anchor).toMatchObject({ status: 'head_missing', seq: 14, from: 1 });
      expect(result.anchor.message).toContain('entries 1 to 13 are missing');
      expect(result.fix).toContain('aquaman audit accept');
    });
  });
});
