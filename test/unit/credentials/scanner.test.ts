/**
 * Tests for credential scanner
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CredentialScanner,
  createCredentialScanner,
  quickScan,
  redactCredentials
} from '../../../src/credentials/scanner.js';
import { TEST_SENSITIVE_CONTENT } from '../../fixtures/test-credentials.js';

describe('CredentialScanner', () => {
  let scanner: CredentialScanner;

  beforeEach(() => {
    scanner = createCredentialScanner();
  });

  describe('API key detection', () => {
    it('should detect Anthropic API keys', () => {
      const text = 'My key is sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456';
      const result = scanner.scan(text);

      expect(result.found).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
      expect(result.matches.some(m => m.type === 'anthropic_api_key')).toBe(true);
    });

    it('should detect OpenAI API keys', () => {
      const text = 'API_KEY=sk-proj1234567890abcdefghijklmnopqrstuv';
      const result = scanner.scan(text);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'openai_api_key' || m.type === 'generic_api_key')).toBe(true);
    });

    it('should detect generic API key patterns', () => {
      // Test the generic api_key pattern that many services use
      const text = 'api_key="sk-verysecretkey1234567890abcdef"';
      const result = scanner.scan(text);

      expect(result.found).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(1);
    });

    it('should detect Slack tokens', () => {
      const text = 'token: xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx';
      const result = scanner.scan(text);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'slack_token')).toBe(true);
    });
  });

  describe('webhook detection', () => {
    it('should detect Slack webhooks', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.slackWebhook);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'slack_webhook')).toBe(true);
    });

    it('should detect Discord webhooks', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.discordWebhook);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'discord_webhook')).toBe(true);
    });
  });

  describe('AWS credential detection', () => {
    it('should detect AWS access keys', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.awsKeys);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'aws_access_key')).toBe(true);
    });
  });

  describe('database URL detection', () => {
    it('should detect PostgreSQL URLs', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.postgresUrl);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'postgres_url')).toBe(true);
    });

    it('should detect MongoDB URLs', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.mongoUrl);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'mongodb_url')).toBe(true);
    });
  });

  describe('bearer token detection', () => {
    it('should detect bearer tokens', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.bearerToken);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'bearer_token')).toBe(true);
    });
  });

  describe('private key detection', () => {
    it('should detect RSA private keys', () => {
      const result = scanner.scan(TEST_SENSITIVE_CONTENT.privateKey);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'private_key')).toBe(true);
    });
  });

  describe('JWT detection', () => {
    it('should detect JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      const result = scanner.scan(jwt);

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'jwt')).toBe(true);
    });
  });

  describe('redaction', () => {
    it('should redact credentials in text', () => {
      const text = 'API key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456 is mine';
      const result = scanner.scan(text);

      expect(result.redacted).toContain('sk-a');
      expect(result.redacted).toContain('****');
      expect(result.redacted).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz12345');
    });

    it('should redact multiple credentials', () => {
      const text = `
        Anthropic: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456
        OpenAI: sk-test1234567890abcdefghijklmnopqr
      `;
      const result = scanner.scan(text);

      expect(result.matches.length).toBeGreaterThanOrEqual(2);
      expect(result.redacted).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
    });

    it('should preserve non-credential text', () => {
      const text = 'Hello world! Key: sk-test1234567890abcdefghijklmnopqrstuv Goodbye!';
      const result = scanner.scan(text);

      expect(result.redacted).toContain('Hello world!');
      expect(result.redacted).toContain('Goodbye!');
    });
  });

  describe('addPattern', () => {
    it('should add custom pattern', () => {
      scanner.addPattern('custom_key', /CUSTOM-[A-Z0-9]{20}/g);

      const result = scanner.scan('Key: CUSTOM-ABCDEFGHIJ1234567890');

      expect(result.found).toBe(true);
      expect(result.matches.some(m => m.type === 'custom_key')).toBe(true);
    });
  });

  describe('removePattern', () => {
    it('should remove custom pattern', () => {
      scanner.addPattern('custom_key', /CUSTOM-[A-Z0-9]{20}/g);
      const removed = scanner.removePattern('custom_key');

      expect(removed).toBe(true);
      expect(scanner.getPatternTypes()).not.toContain('custom_key');
    });

    it('should return false for non-existent pattern', () => {
      const removed = scanner.removePattern('nonexistent');
      expect(removed).toBe(false);
    });
  });

  describe('getPatternTypes', () => {
    it('should return all pattern types', () => {
      const types = scanner.getPatternTypes();

      expect(types).toContain('anthropic_api_key');
      expect(types).toContain('openai_api_key');
      expect(types).toContain('github_token');
      expect(types).toContain('slack_token');
      expect(types).toContain('jwt');
    });
  });

  describe('no credentials', () => {
    it('should return found=false for clean text', () => {
      const result = scanner.scan('This is just normal text without any secrets.');

      expect(result.found).toBe(false);
      expect(result.matches).toHaveLength(0);
      expect(result.redacted).toBe('This is just normal text without any secrets.');
    });
  });
});

describe('quickScan', () => {
  it('should return true when credentials found', () => {
    expect(quickScan('sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456')).toBe(true);
  });

  it('should return false when no credentials', () => {
    expect(quickScan('just normal text')).toBe(false);
  });
});

describe('redactCredentials', () => {
  it('should return redacted text', () => {
    const text = 'Key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz123456';
    const redacted = redactCredentials(text);

    expect(redacted).toContain('Key:');
    expect(redacted).toContain('****');
    expect(redacted).not.toContain('1234567890abcdefghijklmnopqrstuvwxyz');
  });
});
