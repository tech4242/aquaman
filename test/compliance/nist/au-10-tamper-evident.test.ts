/**
 * Compliance test — NIST SP 800-53 AU-2/AU-9/AU-10 (Audit Events,
 * Protection of Audit Information, Non-Repudiation).
 *
 * Proves: every audit entry is hash-chained; any mutation invalidates
 * the chain and is detectable via AuditLogger.verifyIntegrity().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditLogger } from 'aquaman-core';

describe('NIST AU-2 / AU-9 / AU-10 — Tamper-evident audit log', () => {
  let logDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-audit-test-'));
    logger = new AuditLogger({ logDir, walEnabled: false });
    await logger.initialize();
  });

  afterEach(() => {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch { /* best effort */ }
  });

  it('AU-2: every credential access produces an audit entry', async () => {
    await logger.logCredentialAccess('s1', 'a1', {
      service: 'anthropic',
      operation: 'use',
      success: true,
    });
    const log = fs.readFileSync(path.join(logDir, 'current.jsonl'), 'utf-8');
    const lines = log.trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe('credential_access');
    expect(entry.data.service).toBe('anthropic');
  });

  it('AU-10: verifyIntegrity returns valid:true for an untampered chain', async () => {
    for (let i = 0; i < 5; i++) {
      await logger.logCredentialAccess('s1', 'a1', {
        service: 'anthropic',
        operation: 'use',
        success: true,
      });
    }
    const { valid, errors } = await logger.verifyIntegrity();
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it('AU-9: tampering with any entry breaks the chain (detectable)', async () => {
    for (let i = 0; i < 3; i++) {
      await logger.logCredentialAccess('s1', 'a1', {
        service: 'anthropic',
        operation: 'use',
        success: true,
      });
    }

    const logPath = path.join(logDir, 'current.jsonl');
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.trim().split('\n');

    // Mutate the middle entry's data field — should invalidate the chain
    const entry = JSON.parse(lines[1]);
    entry.data.service = 'tampered-service';
    lines[1] = JSON.stringify(entry);
    fs.writeFileSync(logPath, lines.join('\n') + '\n');

    const fresh = new AuditLogger({ logDir, walEnabled: false });
    await fresh.initialize();
    const { valid, errors } = await fresh.verifyIntegrity();
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });
});
