/**
 * Compliance test: NIST SP 800-53 AU-9 (protection of audit information) and
 * AU-10 (non-repudiation), from the side of someone trying to defeat them.
 *
 * A real log is written by `AuditLogger`, then changed on disk the way a
 * process running as the user could change it. Each row asserts that the
 * change is detected by the check `aquaman audit verify` runs: a new
 * `AuditLogger` on the directory, `initialize()`, `verifyIntegrity()`.
 *
 * The chain links each entry to the one before it, and nothing outside the
 * file records how many entries there should be or what the last hash was.
 * So changes inside the chain are detected, and changes that leave a shorter
 * but self-consistent chain are not. Those rows are `it.fails`: they state
 * what should be detected, and turn into failures the day it is.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger, computeChainedHash } from 'aquaman-core';

const GENESIS = '0'.repeat(64);
const ENTRIES = 12;

interface Entry {
  data: { service: string; operation: string; success: boolean; error?: string };
  previousHash: string;
  hash: string;
  [k: string]: unknown;
}

/** Re-link entries into a chain that is valid on its own terms, as the logger would have written it. */
function rechain(entries: Entry[]): Entry[] {
  let previous = GENESIS;
  return entries.map((entry) => {
    const relinked: Entry = { ...entry, previousHash: previous };
    relinked.hash = computeChainedHash(JSON.stringify({ ...relinked, hash: undefined }), previous);
    previous = relinked.hash;
    return relinked;
  });
}

interface Attack {
  name: string;
  /** Change the log. `file` is `current.jsonl`; `entries` is what it held. */
  tamper(file: string, entries: Entry[]): void;
  /** Why this is not detected today; absent for an attack that is. */
  limit?: string;
}

const write = (file: string, entries: Entry[]) =>
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));

const ATTACKS: Attack[] = [
  {
    name: 'alter an entry (a failed read rewritten as a success)',
    tamper(file, entries) {
      const forged = entries.map((e) => ({ ...e }));
      forged[4] = { ...forged[4], data: { ...forged[4].data, success: true, error: undefined } };
      write(file, forged);
    },
  },
  {
    name: 'alter an entry (a different service named)',
    tamper(file, entries) {
      const forged = entries.map((e) => ({ ...e }));
      forged[7] = { ...forged[7], data: { ...forged[7].data, service: 'something-else' } };
      write(file, forged);
    },
  },
  {
    name: 'insert an entry in the middle',
    tamper(file, entries) {
      const forged = [...entries];
      forged.splice(5, 0, { ...entries[5], id: 'inserted' });
      write(file, forged);
    },
  },
  {
    name: 'append a forged entry that does not link to the last one',
    tamper(file, entries) {
      write(file, [...entries, { ...entries[0], id: 'appended' }]);
    },
  },
  {
    name: 'delete an entry in the middle',
    tamper(file, entries) {
      write(file, entries.filter((_, i) => i !== 6));
    },
  },
  {
    name: 'delete the first entry',
    tamper(file, entries) {
      write(file, entries.slice(1));
    },
  },
  {
    name: 'swap two entries',
    tamper(file, entries) {
      const forged = [...entries];
      [forged[2], forged[3]] = [forged[3], forged[2]];
      write(file, forged);
    },
  },
  {
    name: 'replace a line with text that is not an entry',
    tamper(file, entries) {
      const lines = entries.map((e) => JSON.stringify(e));
      lines[8] = 'not json';
      fs.writeFileSync(file, lines.join('\n') + '\n');
    },
  },
  {
    name: 'truncate the tail (the last four entries removed)',
    limit: 'nothing outside the file records the entry count or the last hash, so a shorter chain verifies',
    tamper(file, entries) {
      write(file, entries.slice(0, -4));
    },
  },
  {
    name: 'empty the file',
    limit: 'an empty log is a valid chain of zero entries',
    tamper(file) {
      fs.writeFileSync(file, '');
    },
  },
  {
    name: 'delete the file',
    limit: 'a missing log is reported as valid',
    tamper(file) {
      fs.rmSync(file);
    },
  },
  {
    name: 'remove every read, turn failures into successes, and rebuild the chain',
    limit: 'the chain is an unkeyed SHA-256, so anyone who can write the file can recompute it',
    tamper(file, entries) {
      const kept = entries
        .filter((e) => e.data.operation !== 'read')
        .map((e) => ({ ...e, data: { service: e.data.service, operation: e.data.operation, success: true } }));
      write(file, rechain(kept));
    },
  },
];

describe('NIST AU-9 / AU-10: tampering with the audit log', () => {
  let logDir: string;
  let file: string;
  let original: Entry[];

  beforeEach(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-au9-'));
    file = path.join(logDir, 'current.jsonl');
    const logger = new AuditLogger({ logDir });
    await logger.initialize();
    for (let i = 0; i < ENTRIES; i++) {
      await logger.logCredentialAccess('system', 'system', {
        service: i % 2 ? 'github' : 'anthropic',
        operation: i % 3 === 0 ? 'read' : 'use',
        success: i !== 4,
        error: i === 4 ? 'Policy denied: DELETE /v1/x' : undefined,
      });
    }
    original = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Entry);
  });

  afterEach(() => {
    fs.rmSync(logDir, { recursive: true, force: true });
  });

  /** What `aquaman audit verify` does: a fresh logger on the directory. */
  async function verify(): Promise<{ valid: boolean; errors: string[] }> {
    const logger = new AuditLogger({ logDir });
    await logger.initialize();
    return logger.verifyIntegrity();
  }

  it('the untouched log verifies, and holds every entry that was written', async () => {
    expect(original).toHaveLength(ENTRIES);
    expect(await verify()).toEqual({ valid: true, errors: [] });
  });

  it('the rebuilt-chain helper produces what the logger would: re-linking the untouched log changes nothing', () => {
    expect(rechain(original)).toEqual(original);
  });

  for (const attack of ATTACKS.filter((a) => !a.limit)) {
    it(`detected: ${attack.name}`, async () => {
      attack.tamper(file, original);
      const result = await verify();
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  for (const attack of ATTACKS.filter((a) => a.limit)) {
    // Current limit: see `attack.limit` in the row; the assertion is what should hold.
    it.fails(`should be detected, is not yet: ${attack.name} (${attack.limit})`, async () => {
      attack.tamper(file, original);
      const result = await verify();
      expect(result.valid).toBe(false);
    });
  }

  it('a running logger notices a truncated tail at its next write: the entry it adds no longer links', async () => {
    const running = new AuditLogger({ logDir });
    await running.initialize();
    write(file, original.slice(0, -4));
    await running.logCredentialAccess('system', 'system', { service: 'github', operation: 'read', success: true });
    expect((await verify()).valid).toBe(false);
  });
});
