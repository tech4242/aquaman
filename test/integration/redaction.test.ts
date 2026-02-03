/**
 * Integration tests for credential redaction across the pipeline
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditLogger } from '../../src/audit/logger.js';

describe('Redaction Integration', () => {
  let tempDir: string;
  let auditLogger: AuditLogger;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-redaction-integration-'));
    auditLogger = new AuditLogger({
      logDir: tempDir,
      enabled: true,
      walEnabled: false
    });
    await auditLogger.initialize();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Full Pipeline: Tool Call -> Audit Log', () => {
    it('redacts all credential types in tool calls', async () => {
      const sensitiveParams = {
        // Anthropic API key
        anthropicKey: 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456',
        // OpenAI API key
        openaiKey: 'sk-proj1234567890abcdefghijklmnopqrstuv',
        // Slack token
        slackToken: 'xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx',
        // AWS keys
        awsAccessKey: 'AKIAIOSFODNN7EXAMPLE',
        // Database URL
        dbUrl: 'postgresql://admin:secretpass123@db.example.com:5432/production',
        // JWT
        jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
        // Bearer token
        auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
      };

      await auditLogger.logToolCall('session1', 'agent1', 'multi_auth', sensitiveParams);

      // Read log file
      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      // Verify all credentials are redacted
      const logJson = JSON.stringify(entry);

      // Original sensitive values should NOT appear
      expect(logJson).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
      expect(logJson).not.toContain('proj1234567890abcdefghijklmnopqrstuv');
      expect(logJson).not.toContain('abcdefghijklmnopqrstuvwx');
      expect(logJson).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(logJson).not.toContain('secretpass123');
      expect(logJson).not.toContain('dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');

      // Redaction markers should appear
      expect(logJson).toContain('****');
    });

    it('redacts credentials in tool results', async () => {
      const sensitiveResult = {
        message: 'API key is sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456',
        config: {
          database: 'mongodb://admin:password@mongo.example.com:27017/app'
        }
      };

      await auditLogger.logToolResult('session1', 'agent1', 'call-123', sensitiveResult);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.result.message).toContain('****');
      expect(entry.data.result.message).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
      expect(entry.data.result.config.database).toContain('****');
      expect(entry.data.result.config.database).not.toContain('password');
    });

    it('maintains audit log integrity with redacted values', async () => {
      // Write multiple entries with sensitive data
      for (let i = 0; i < 5; i++) {
        await auditLogger.logToolCall('session1', 'agent1', 'test', {
          apiKey: `sk-ant-api03-key${i}1234567890abcdefghijklmnopqrstuvwxyz`
        });

        await auditLogger.logToolResult('session1', 'agent1', `call-${i}`, {
          secret: `Bearer token${i}eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdef`
        });
      }

      // Verify integrity
      const result = await auditLogger.verifyIntegrity();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Redaction Across Log Rotation', () => {
    it('maintains redaction after log rotation', async () => {
      // Write entry with credentials
      await auditLogger.logToolCall('session1', 'agent1', 'api_call', {
        key: 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456'
      });

      // Rotate log
      const archivePath = await auditLogger.rotateLog();

      // Verify archived log has redacted values
      const archivedContent = fs.readFileSync(archivePath, 'utf-8');
      expect(archivedContent).toContain('****');
      expect(archivedContent).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');

      // Write new entry
      await auditLogger.logToolCall('session2', 'agent1', 'api_call', {
        key: 'sk-proj5678901234567890abcdefghijklmnopqrstuv'
      });

      // Verify new log also has redacted values
      const currentPath = path.join(tempDir, 'current.jsonl');
      const currentContent = fs.readFileSync(currentPath, 'utf-8');
      expect(currentContent).toContain('****');
      expect(currentContent).not.toContain('5678901234567890abcdefghijklmnopqrst');
    });
  });

  describe('Nested and Complex Data Structures', () => {
    it('redacts deeply nested credentials', async () => {
      const complexParams = {
        level1: {
          level2: {
            level3: {
              level4: {
                secret: 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456'
              }
            }
          }
        }
      };

      await auditLogger.logToolCall('session1', 'agent1', 'nested', complexParams);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');

      expect(content).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
      expect(content).toContain('****');
    });

    it('redacts credentials in arrays', async () => {
      const arrayParams = {
        keys: [
          'sk-ant-api03-first1234567890abcdefghijklmnopqrstuvwxyz',
          'sk-ant-api03-second234567890abcdefghijklmnopqrstuvwxyz'
        ],
        nested: [
          { token: 'xoxb-111111111111-1111111111111-aaaaaaaaaaaaaaaaaaaaaaa' },
          { token: 'xoxb-222222222222-2222222222222-bbbbbbbbbbbbbbbbbbbbbbb' }
        ]
      };

      await auditLogger.logToolCall('session1', 'agent1', 'multi', arrayParams);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');

      expect(content).not.toContain('first1234567890abcdefghijklmnopqrstuvwxy');
      expect(content).not.toContain('second234567890abcdefghijklmnopqrstuvwxy');
      expect(content).not.toContain('aaaaaaaaaaaaaaaaaaaaaaa');
      expect(content).not.toContain('bbbbbbbbbbbbbbbbbbbbbbb');
    });
  });

  describe('Private Key Redaction', () => {
    it('redacts RSA private keys', async () => {
      const params = {
        privateKey: `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MvDCmFgDqRkGMYc1
dummykeydataherethatislongenoughtobedetected123456789012345678901234
-----END RSA PRIVATE KEY-----`
      };

      await auditLogger.logToolCall('session1', 'agent1', 'ssh', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');

      expect(content).not.toContain('dummykeydataherethatislongenoughtobedetected');
      expect(content).toContain('****');
    });
  });
});
