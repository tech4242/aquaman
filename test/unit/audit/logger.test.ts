/**
 * Tests for audit logger
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditLogger, createAuditLogger, redactSensitiveParams } from 'aquaman-core';

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

    it('should create directories with mode 0o700', async () => {
      const freshDir = path.join(os.tmpdir(), `aquaman-perm-test-${Date.now()}`);
      try {
        const freshLogger = createAuditLogger({ logDir: freshDir, enabled: true });
        await freshLogger.initialize();
        expect(fs.statSync(freshDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(freshDir, 'archive')).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(freshDir, 'integrity')).mode & 0o777).toBe(0o700);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
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

  describe('logCredentialAccess', () => {
    it('should log credential access', async () => {
      const entry = await logger.logCredentialAccess('session1', 'agent1', {
        service: 'anthropic',
        operation: 'use',
        success: true
      });

      expect(entry).not.toBeNull();
      expect(entry!.type).toBe('credential_access');
      expect((entry!.data as any).service).toBe('anthropic');
      expect((entry!.data as any).operation).toBe('use');
      expect((entry!.data as any).success).toBe(true);
    });

    it('should log credential access errors', async () => {
      const entry = await logger.logCredentialAccess('session1', 'agent1', {
        service: 'anthropic',
        operation: 'use',
        success: false,
        error: 'Credential not found'
      });

      expect(entry).not.toBeNull();
      expect((entry!.data as any).success).toBe(false);
      expect((entry!.data as any).error).toBe('Credential not found');
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

  describe('param redaction', () => {
    it('should redact sensitive keys in logToolCall params', async () => {
      const entry = await logger.logToolCall('s1', 'a1', 'test', {
        api_key: 'sk-ant-secret',
        token: 'bearer-token',
        command: 'ls -la',
        model: 'claude-3',
      });

      const data = entry!.data as any;
      expect(data.params.api_key).toBe('[REDACTED]');
      expect(data.params.token).toBe('[REDACTED]');
      expect(data.params.command).toBe('ls -la');
      expect(data.params.model).toBe('claude-3');
    });

    it('should redact sensitive keys in logToolResult', async () => {
      const entry = await logger.logToolResult('s1', 'a1', 'call-1', {
        access_token: 'oauth-token',
        client_secret: 'secret-value',
        status: 'ok',
      });

      const data = entry!.data as any;
      expect(data.result.access_token).toBe('[REDACTED]');
      expect(data.result.client_secret).toBe('[REDACTED]');
      expect(data.result.status).toBe('ok');
    });

    it('should not redact non-object results', async () => {
      const entry = await logger.logToolResult('s1', 'a1', 'call-1', 'string result');

      const data = entry!.data as any;
      expect(data.result).toBe('string result');
    });
  });
});

describe('redactSensitiveParams', () => {
  it('redacts keys matching sensitive patterns', () => {
    const result = redactSensitiveParams({
      api_key: 'sk-ant-123',
      apiKey: 'sk-another',
      token: 'bearer-token',
      secret: 'my-secret',
      password: 'pass123',
      credential: 'cred',
      authorization: 'Bearer abc',
      access_token: 'at-123',
      refresh_token: 'rt-456',
      client_secret: 'cs-789',
    });

    for (const value of Object.values(result)) {
      expect(value).toBe('[REDACTED]');
    }
  });

  it('preserves non-sensitive keys', () => {
    const result = redactSensitiveParams({
      command: 'ls -la',
      model: 'claude-3',
      count: 5,
      enabled: true,
    });

    expect(result.command).toBe('ls -la');
    expect(result.model).toBe('claude-3');
    expect(result.count).toBe(5);
    expect(result.enabled).toBe(true);
  });

  it('is case-insensitive', () => {
    const result = redactSensitiveParams({
      API_KEY: 'value',
      Token: 'value',
      PASSWORD: 'value',
    });

    expect(result.API_KEY).toBe('[REDACTED]');
    expect(result.Token).toBe('[REDACTED]');
    expect(result.PASSWORD).toBe('[REDACTED]');
  });

  it('handles empty object', () => {
    const result = redactSensitiveParams({});
    expect(Object.keys(result)).toHaveLength(0);
  });
});
