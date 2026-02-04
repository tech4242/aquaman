/**
 * Hash-chained audit logger with tamper-evident storage
 *
 * Provides cryptographic integrity verification for audit logs.
 * Note: Credential redaction is handled by OpenClaw's built-in redaction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeChainedHash, generateId } from '../utils/hash.js';
import { expandPath } from '../utils/config.js';
import type {
  AuditEntry,
  ToolCall,
  ToolResult,
  CredentialAccess
} from '../types.js';

const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export interface AuditLoggerOptions {
  logDir: string;
  enabled?: boolean;
  walEnabled?: boolean;
}

export class AuditLogger {
  private logDir: string;
  private currentLogPath: string;
  private walPath: string;
  private enabled: boolean;
  private walEnabled: boolean;
  private lastHash: string = GENESIS_HASH;
  private entryCount: number = 0;
  private initialized: boolean = false;

  constructor(options: AuditLoggerOptions) {
    this.logDir = expandPath(options.logDir);
    this.currentLogPath = path.join(this.logDir, 'current.jsonl');
    this.walPath = path.join(this.logDir, 'current.wal');
    this.enabled = options.enabled ?? true;
    this.walEnabled = options.walEnabled ?? true;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (!this.enabled) {
      this.initialized = true;
      return;
    }

    // Ensure directories exist
    const archiveDir = path.join(this.logDir, 'archive');
    const integrityDir = path.join(this.logDir, 'integrity');

    fs.mkdirSync(this.logDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(integrityDir, { recursive: true });

    // Recover state from existing log
    await this.recoverState();

    // Recover from WAL if present
    if (this.walEnabled) {
      await this.recoverFromWal();
    }

    this.initialized = true;
  }

  private async recoverState(): Promise<void> {
    if (!fs.existsSync(this.currentLogPath)) {
      return;
    }

    const content = fs.readFileSync(this.currentLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);

    if (lines.length === 0) {
      return;
    }

    this.entryCount = lines.length;

    // Get the hash of the last entry
    const lastLine = lines[lines.length - 1];
    try {
      const lastEntry = JSON.parse(lastLine) as AuditEntry;
      this.lastHash = lastEntry.hash;
    } catch {
      // If we can't parse the last line, start fresh with integrity warning
      console.error('Warning: Could not parse last audit entry, integrity may be compromised');
    }
  }

  private async recoverFromWal(): Promise<void> {
    if (!fs.existsSync(this.walPath)) {
      return;
    }

    const walContent = fs.readFileSync(this.walPath, 'utf-8');
    const lines = walContent.trim().split('\n').filter(line => line.length > 0);

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        // Write to main log
        fs.appendFileSync(this.currentLogPath, JSON.stringify(entry) + '\n');
        this.lastHash = entry.hash;
        this.entryCount++;
      } catch {
        console.error('Warning: Could not recover WAL entry');
      }
    }

    // Clear WAL after recovery
    fs.writeFileSync(this.walPath, '');
  }

  async logToolCall(
    sessionId: string,
    agentId: string,
    tool: string,
    params: Record<string, unknown>
  ): Promise<AuditEntry | null> {
    if (!this.enabled) return null;

    const toolCall: ToolCall = {
      id: generateId(),
      sessionId,
      agentId,
      tool,
      params,
      timestamp: new Date()
    };

    return this.writeEntry('tool_call', sessionId, agentId, toolCall);
  }

  async logToolResult(
    sessionId: string,
    agentId: string,
    toolCallId: string,
    result: unknown,
    error?: string
  ): Promise<AuditEntry | null> {
    if (!this.enabled) return null;

    const toolResult: ToolResult = {
      id: generateId(),
      toolCallId,
      result,
      error,
      timestamp: new Date()
    };

    return this.writeEntry('tool_result', sessionId, agentId, toolResult);
  }

  async logCredentialAccess(
    sessionId: string,
    agentId: string,
    access: CredentialAccess
  ): Promise<AuditEntry | null> {
    if (!this.enabled) return null;
    return this.writeEntry('credential_access', sessionId, agentId, access);
  }

  private async writeEntry(
    type: AuditEntry['type'],
    sessionId: string,
    agentId: string,
    data: AuditEntry['data']
  ): Promise<AuditEntry> {
    if (!this.initialized) {
      await this.initialize();
    }

    const entry: AuditEntry = {
      id: generateId(),
      timestamp: new Date(),
      type,
      sessionId,
      agentId,
      data,
      previousHash: this.lastHash,
      hash: '' // Will be computed below
    };

    // Compute hash including previous hash for chain integrity
    const entryData = JSON.stringify({
      ...entry,
      hash: undefined
    });
    entry.hash = computeChainedHash(entryData, this.lastHash);

    const line = JSON.stringify(entry) + '\n';

    // Write to WAL first (for crash recovery)
    if (this.walEnabled) {
      fs.appendFileSync(this.walPath, line);
    }

    // Write to main log
    fs.appendFileSync(this.currentLogPath, line);

    // Clear WAL entry after successful write
    if (this.walEnabled) {
      fs.writeFileSync(this.walPath, '');
    }

    this.lastHash = entry.hash;
    this.entryCount++;

    return entry;
  }

  async verifyIntegrity(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!fs.existsSync(this.currentLogPath)) {
      return { valid: true, errors: [] };
    }

    const content = fs.readFileSync(this.currentLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);

    let previousHash = GENESIS_HASH;

    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]) as AuditEntry;

        // Verify previous hash reference
        if (entry.previousHash !== previousHash) {
          errors.push(`Entry ${i}: previousHash mismatch (expected ${previousHash}, got ${entry.previousHash})`);
        }

        // Verify entry hash
        const entryData = JSON.stringify({
          ...entry,
          hash: undefined
        });
        const expectedHash = computeChainedHash(entryData, entry.previousHash);

        if (entry.hash !== expectedHash) {
          errors.push(`Entry ${i}: hash mismatch (expected ${expectedHash}, got ${entry.hash})`);
        }

        previousHash = entry.hash;
      } catch (parseError) {
        errors.push(`Entry ${i}: failed to parse JSON`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  async getEntries(options?: {
    limit?: number;
    offset?: number;
    type?: AuditEntry['type'];
    sessionId?: string;
  }): Promise<AuditEntry[]> {
    if (!fs.existsSync(this.currentLogPath)) {
      return [];
    }

    const content = fs.readFileSync(this.currentLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);

    let entries: AuditEntry[] = lines.map(line => JSON.parse(line) as AuditEntry);

    // Apply filters
    if (options?.type) {
      entries = entries.filter(e => e.type === options.type);
    }
    if (options?.sessionId) {
      entries = entries.filter(e => e.sessionId === options.sessionId);
    }

    // Apply pagination
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? entries.length;

    return entries.slice(offset, offset + limit);
  }

  async tail(count: number = 10): Promise<AuditEntry[]> {
    const entries = await this.getEntries();
    return entries.slice(-count);
  }

  getStats(): { entryCount: number; lastHash: string } {
    return {
      entryCount: this.entryCount,
      lastHash: this.lastHash
    };
  }

  async rotateLog(): Promise<string> {
    if (!fs.existsSync(this.currentLogPath)) {
      throw new Error('No log file to rotate');
    }

    const archiveDir = path.join(this.logDir, 'archive');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(archiveDir, `audit-${timestamp}.jsonl`);

    fs.renameSync(this.currentLogPath, archivePath);

    // Reset state for new log
    this.lastHash = GENESIS_HASH;
    this.entryCount = 0;

    return archivePath;
  }
}

export function createAuditLogger(options: AuditLoggerOptions): AuditLogger {
  return new AuditLogger(options);
}
