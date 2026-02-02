/**
 * Tests for audit logger
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditLogger, createAuditLogger } from '../../../src/audit/logger.js';

describe('AuditLogger', () => {
  let testDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `aquaman-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    logger = createAuditLogger({
      logDir: testDir,
      enabled: true
    });
    await logger.initialize();
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('initialization', () => {
    it('should create log directory', async () => {
      expect(fs.existsSync(testDir)).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'archive'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'integrity'))).toBe(true);
    });

    it('should recover state from existing log', async () => {
      // Write some entries
      await logger.logToolCall('session1', 'agent1', 'bash', { command: 'ls' });
      await logger.logToolCall('session1', 'agent1', 'bash', { command: 'pwd' });

      // Create new logger instance
      const logger2 = createAuditLogger({ logDir: testDir, enabled: true });
      await logger2.initialize();

      const stats = logger2.getStats();
      expect(stats.entryCount).toBe(2);
    });
  });

  describe('logToolCall', () => {
    it('should log tool calls', async () => {
      const entry = await logger.logToolCall('session1', 'agent1', 'bash', {
        command: 'ls -la'
      });

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('tool_call');
      expect(entry!.sessionId).toBe('session1');
      expect(entry!.agentId).toBe('agent1');
      expect((entry!.data as any).tool).toBe('bash');
    });

    it('should return null when disabled', async () => {
      const disabledLogger = createAuditLogger({
        logDir: testDir,
        enabled: false
      });
      await disabledLogger.initialize();

      const entry = await disabledLogger.logToolCall('s', 'a', 'bash', {});
      expect(entry).toBeNull();
    });
  });

  describe('logToolResult', () => {
    it('should log tool results', async () => {
      const entry = await logger.logToolResult(
        'session1',
        'agent1',
        'call-123',
        { output: 'success' }
      );

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('tool_result');
      expect((entry!.data as any).toolCallId).toBe('call-123');
    });

    it('should log errors', async () => {
      const entry = await logger.logToolResult(
        'session1',
        'agent1',
        'call-123',
        null,
        'Command failed'
      );

      expect(entry).not.toBeNull();
      expect((entry!.data as any).error).toBe('Command failed');
    });
  });

  describe('logPolicyViolation', () => {
    it('should log policy violations', async () => {
      const entry = await logger.logPolicyViolation('session1', 'agent1', {
        rule: 'dangerous-command',
        action: 'block',
        severity: 'critical',
        toolCall: {
          id: 'call-123',
          sessionId: 'session1',
          agentId: 'agent1',
          tool: 'bash',
          params: { command: 'rm -rf /' },
          timestamp: new Date()
        },
        reason: 'Dangerous command blocked'
      });

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('policy_violation');
      expect((entry!.data as any).severity).toBe('critical');
    });
  });

  describe('hash chain integrity', () => {
    it('should chain hashes correctly', async () => {
      await logger.logToolCall('s1', 'a1', 'tool1', {});
      await logger.logToolCall('s1', 'a1', 'tool2', {});
      await logger.logToolCall('s1', 'a1', 'tool3', {});

      const entries = await logger.getEntries();

      expect(entries.length).toBe(3);

      // First entry references genesis hash
      expect(entries[0].previousHash).toBe(
        '0000000000000000000000000000000000000000000000000000000000000000'
      );

      // Each subsequent entry references previous hash
      expect(entries[1].previousHash).toBe(entries[0].hash);
      expect(entries[2].previousHash).toBe(entries[1].hash);
    });

    it('should verify integrity of valid log', async () => {
      await logger.logToolCall('s1', 'a1', 'tool1', {});
      await logger.logToolCall('s1', 'a1', 'tool2', {});

      const result = await logger.verifyIntegrity();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect tampering', async () => {
      await logger.logToolCall('s1', 'a1', 'tool1', {});
      await logger.logToolCall('s1', 'a1', 'tool2', {});

      // Tamper with log file
      const logPath = path.join(testDir, 'current.jsonl');
      let content = fs.readFileSync(logPath, 'utf-8');
      content = content.replace('"tool1"', '"tampered"');
      fs.writeFileSync(logPath, content);

      // Create new logger to re-read
      const logger2 = createAuditLogger({ logDir: testDir, enabled: true });
      await logger2.initialize();

      const result = await logger2.verifyIntegrity();
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('getEntries', () => {
    it('should filter by type', async () => {
      await logger.logToolCall('s1', 'a1', 'bash', {});
      await logger.logToolResult('s1', 'a1', 'call-1', {});
      await logger.logToolCall('s1', 'a1', 'file_read', {});

      const toolCalls = await logger.getEntries({ type: 'tool_call' });
      expect(toolCalls.length).toBe(2);

      const toolResults = await logger.getEntries({ type: 'tool_result' });
      expect(toolResults.length).toBe(1);
    });

    it('should filter by sessionId', async () => {
      await logger.logToolCall('session-a', 'a1', 'bash', {});
      await logger.logToolCall('session-b', 'a1', 'bash', {});
      await logger.logToolCall('session-a', 'a1', 'bash', {});

      const entries = await logger.getEntries({ sessionId: 'session-a' });
      expect(entries.length).toBe(2);
    });

    it('should support pagination', async () => {
      for (let i = 0; i < 10; i++) {
        await logger.logToolCall('s1', 'a1', `tool-${i}`, {});
      }

      const page1 = await logger.getEntries({ offset: 0, limit: 3 });
      expect(page1.length).toBe(3);
      expect((page1[0].data as any).tool).toBe('tool-0');

      const page2 = await logger.getEntries({ offset: 3, limit: 3 });
      expect(page2.length).toBe(3);
      expect((page2[0].data as any).tool).toBe('tool-3');
    });
  });

  describe('tail', () => {
    it('should return last N entries', async () => {
      for (let i = 0; i < 20; i++) {
        await logger.logToolCall('s1', 'a1', `tool-${i}`, {});
      }

      const entries = await logger.tail(5);
      expect(entries.length).toBe(5);
      expect((entries[0].data as any).tool).toBe('tool-15');
      expect((entries[4].data as any).tool).toBe('tool-19');
    });
  });

  describe('rotateLog', () => {
    it('should move current log to archive', async () => {
      await logger.logToolCall('s1', 'a1', 'tool1', {});
      await logger.logToolCall('s1', 'a1', 'tool2', {});

      const archivePath = await logger.rotateLog();

      expect(fs.existsSync(archivePath)).toBe(true);
      expect(archivePath).toContain('archive');

      // Current log should be reset
      const stats = logger.getStats();
      expect(stats.entryCount).toBe(0);
    });
  });
});
