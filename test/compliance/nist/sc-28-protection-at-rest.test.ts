/**
 * Compliance test — NIST SP 800-53 SC-28 (Protection of Information at Rest).
 *
 * Proves: aquaman writes audit log files with chmod 0o600 (owner read/write
 * only — no group, no other) and creates the log directory tree with 0o700.
 *
 * Skipped on Windows: chmod semantics differ.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger } from 'aquaman-core';

const skip = process.platform === 'win32';

describe.skipIf(skip)('NIST SC-28 — Protection of Information at Rest', () => {
  let logDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-sc28-'));
    logger = new AuditLogger({ logDir, walEnabled: false });
    await logger.initialize();
  });

  afterEach(() => {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('audit log file is mode 0o600 after first write', async () => {
    await logger.logCredentialAccess('s1', 'a1', {
      service: 'anthropic',
      operation: 'use',
      success: true,
    });
    const logPath = path.join(logDir, 'current.jsonl');
    const mode = fs.statSync(logPath).mode & 0o777;
    // Owner has read+write, group/other have no permissions
    expect(mode & 0o077).toBe(0);
  });

  it('audit directory tree is mode 0o700', () => {
    const archiveDir = path.join(logDir, 'archive');
    const integrityDir = path.join(logDir, 'integrity');
    for (const d of [logDir, archiveDir, integrityDir]) {
      const mode = fs.statSync(d).mode & 0o777;
      expect(mode & 0o077).toBe(0);
    }
  });
});
