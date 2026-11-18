/**
 * `aquaman audit accept`, in process: the log is damaged between the moment
 * the person is asked and the moment they answer. The command checked the
 * chain before asking; it must not move the anchor on the strength of that
 * earlier check.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const answers: Array<() => string> = [];
vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (answer: string) => void) => cb(answers.shift()!()),
    close: () => {},
  }),
}));

import { AuditLogger, MemoryStore } from 'aquaman-core';
import { readAuditAnchor, writeAuditAnchor } from 'aquaman-proxy';
import { auditAcceptCommand } from '../../packages/proxy/src/cli/audit-commands.js';

describe('audit accept: the log changes while the person is being asked', () => {
  let dir: string;
  let tty: { stdin: boolean | undefined; stdout: boolean | undefined };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-accept-'));
    tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.stdin.isTTY = tty.stdin as boolean;
    process.stdout.isTTY = tty.stdout as boolean;
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses after a yes when the chain was broken in the meantime, and leaves the anchor where it was', async () => {
    const logger = new AuditLogger({ logDir: dir });
    for (let i = 0; i < 2; i++) await logger.logCredentialAccess('s', 'agent', { service: 'github', operation: 'use', success: true });
    const store = new MemoryStore();
    const anchor = await writeAuditAnchor(store, { seq: 9, hash: 'ab'.repeat(32) });
    const file = path.join(dir, 'current.jsonl');
    answers.push(() => {
      fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('"github"', '"gitlab"'));
      return 'yes';
    });
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => { errors.push(line); });

    const code = await auditAcceptCommand({
      config: { audit: { enabled: true, logDir: dir } },
      openStore: async () => store,
      proxyRunning: async () => false,
    });

    expect(code).toBe(1);
    expect(errors[0]).toMatch(/^Not accepted: the chain itself is broken \(Entry 0: hash mismatch.*\), and accepting an anchor does not repair it\.$/);
    expect(errors[1]).toContain('mv ~/.aquaman/audit ~/.aquaman/audit.broken');
    expect(await readAuditAnchor(store)).toEqual(anchor);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2);
  });
});
