/**
 * Tests for audit log redaction
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AuditLogger } from '../../../src/audit/logger.js';
import { CredentialScanner } from '../../../src/credentials/scanner.js';
import { computeChainedHash } from '../../../src/utils/hash.js';

describe('Audit Log Redaction', () => {
  let tempDir: string;
  let logger: AuditLogger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-redaction-test-'));
    logger = new AuditLogger({
      logDir: tempDir,
      enabled: true,
      walEnabled: false
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Tool Call Redaction', () => {
    it('redacts Anthropic API keys (sk-ant-...)', async () => {
      await logger.initialize();

      const params = {
        command: 'curl -H "x-api-key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456" https://api.anthropic.com'
      };

      await logger.logToolCall('session1', 'agent1', 'bash', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      // Verify the key is redacted
      expect(entry.data.params.command).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
      expect(entry.data.params.command).toContain('sk-a');
      expect(entry.data.params.command).toContain('****');
    });

    it('redacts OpenAI API keys (sk-...)', async () => {
      await logger.initialize();

      const params = {
        apiKey: 'sk-proj1234567890abcdefghijklmnopqrstuv'
      };

      await logger.logToolCall('session1', 'agent1', 'api_call', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.params.apiKey).toContain('****');
      expect(entry.data.params.apiKey).not.toContain('proj1234567890abcdefghijklmnopqrst');
    });

    it('redacts AWS secret keys', async () => {
      await logger.initialize();

      const params = {
        awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        awsSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
      };

      await logger.logToolCall('session1', 'agent1', 'aws_call', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      // Access key ID should be redacted (contains AKIA...)
      expect(entry.data.params.awsAccessKeyId).toContain('****');
    });

    it('redacts database connection strings', async () => {
      await logger.initialize();

      const params = {
        databaseUrl: 'postgresql://user:password123@localhost:5432/mydb'
      };

      await logger.logToolCall('session1', 'agent1', 'db_connect', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.params.databaseUrl).toContain('****');
      expect(entry.data.params.databaseUrl).not.toContain('password123');
    });

    it('redacts nested objects in params', async () => {
      await logger.initialize();

      const params = {
        config: {
          auth: {
            token: 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456'
          },
          nested: {
            deep: {
              secret: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
            }
          }
        }
      };

      await logger.logToolCall('session1', 'agent1', 'config_update', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.params.config.auth.token).toContain('****');
      expect(entry.data.params.config.nested.deep.secret).toContain('****');
    });

    it('redacts arrays containing credentials', async () => {
      await logger.initialize();

      const params = {
        tokens: [
          'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456',
          'sk-proj1234567890abcdefghijklmnopqrstuv'
        ]
      };

      await logger.logToolCall('session1', 'agent1', 'multi_auth', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      for (const token of entry.data.params.tokens) {
        expect(token).toContain('****');
      }
    });
  });

  describe('Tool Result Redaction', () => {
    it('redacts credentials in results', async () => {
      await logger.initialize();

      const result = {
        output: 'API Key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456'
      };

      await logger.logToolResult('session1', 'agent1', 'call-123', result);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.result.output).toContain('****');
      expect(entry.data.result.output).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
    });

    it('redacts error messages containing credentials', async () => {
      await logger.initialize();

      const error = 'Authentication failed for token: xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx';

      await logger.logToolResult('session1', 'agent1', 'call-123', null, error);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.error).toContain('****');
      expect(entry.data.error).not.toContain('abcdefghijklmnopqrstuvwx');
    });
  });

  describe('Hash Chain Integrity', () => {
    it('preserves hash chain integrity after redaction', async () => {
      await logger.initialize();

      // Log several entries with credentials
      await logger.logToolCall('session1', 'agent1', 'bash', {
        command: 'export API_KEY=sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456'
      });

      await logger.logToolResult('session1', 'agent1', 'call-1', {
        output: 'Key set'
      });

      await logger.logToolCall('session1', 'agent1', 'curl', {
        url: 'https://api.anthropic.com',
        headers: { 'x-api-key': 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456' }
      });

      // Verify integrity
      const result = await logger.verifyIntegrity();
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('hash chain includes redacted (not original) values', async () => {
      await logger.initialize();

      const originalKey = 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456';

      await logger.logToolCall('session1', 'agent1', 'test', {
        key: originalKey
      });

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      // The hash is computed from the redacted entry data
      // If we manually compute the hash with original value, it should NOT match
      const originalEntry = {
        ...entry,
        data: {
          ...entry.data,
          params: { key: originalKey }
        },
        hash: undefined
      };

      const originalHash = computeChainedHash(JSON.stringify(originalEntry), entry.previousHash);

      // The stored hash should be different (it's based on redacted value)
      expect(entry.hash).not.toBe(originalHash);
    });
  });

  describe('Non-Credential Text Preservation', () => {
    it('preserves non-credential content', async () => {
      await logger.initialize();

      const params = {
        message: 'Hello, world!',
        command: 'ls -la /tmp',
        count: 42,
        flag: true
      };

      await logger.logToolCall('session1', 'agent1', 'test', params);

      const logPath = path.join(tempDir, 'current.jsonl');
      const content = fs.readFileSync(logPath, 'utf-8');
      const entry = JSON.parse(content);

      expect(entry.data.params.message).toBe('Hello, world!');
      expect(entry.data.params.command).toBe('ls -la /tmp');
      expect(entry.data.params.count).toBe(42);
      expect(entry.data.params.flag).toBe(true);
    });
  });
});

describe('CredentialScanner.redactObject', () => {
  let scanner: CredentialScanner;

  beforeEach(() => {
    scanner = new CredentialScanner();
  });

  it('handles null values', () => {
    expect(scanner.redactObject(null)).toBeNull();
  });

  it('handles undefined values', () => {
    expect(scanner.redactObject(undefined)).toBeUndefined();
  });

  it('handles primitive numbers', () => {
    expect(scanner.redactObject(42)).toBe(42);
  });

  it('handles primitive booleans', () => {
    expect(scanner.redactObject(true)).toBe(true);
    expect(scanner.redactObject(false)).toBe(false);
  });

  it('redacts strings', () => {
    const input = 'key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456';
    const result = scanner.redactObject(input);

    expect(result).toContain('****');
    expect(result).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
  });

  it('creates deep copy (does not mutate original)', () => {
    const original = {
      nested: {
        key: 'sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456'
      }
    };

    const originalCopy = JSON.parse(JSON.stringify(original));
    scanner.redactObject(original);

    expect(original).toEqual(originalCopy);
  });
});
