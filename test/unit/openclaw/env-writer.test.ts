import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateOpenClawEnv,
  writeEnvFile,
  formatEnvForDisplay
} from 'aquaman-proxy';
import type { ServiceConfig } from 'aquaman-core';

describe('env-writer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('generateOpenClawEnv', () => {
    it('should generate environment variables for standard services', () => {
      const services: ServiceConfig[] = [
        {
          name: 'anthropic',
          upstream: 'https://api.anthropic.com',
          authHeader: 'x-api-key',
          credentialKey: 'api_key'
        },
        {
          name: 'openai',
          upstream: 'https://api.openai.com',
          authHeader: 'Authorization',
          authPrefix: 'Bearer ',
          credentialKey: 'api_key'
        }
      ];

      const env = generateOpenClawEnv({ services });

      expect(env['ANTHROPIC_BASE_URL']).toBe('http://aquaman.local/anthropic');
      expect(env['OPENAI_BASE_URL']).toBe('http://aquaman.local/openai');
    });

    it('should handle custom services with uppercase naming', () => {
      const services: ServiceConfig[] = [
        {
          name: 'my-custom-api',
          upstream: 'https://api.example.com',
          authHeader: 'Authorization',
          credentialKey: 'token'
        }
      ];

      const env = generateOpenClawEnv({ services });

      expect(env['MY_CUSTOM_API_BASE_URL']).toBe('http://aquaman.local/my-custom-api');
    });

    it('should handle GitHub service', () => {
      const services: ServiceConfig[] = [
        {
          name: 'github',
          upstream: 'https://api.github.com',
          authHeader: 'Authorization',
          authPrefix: 'Bearer ',
          credentialKey: 'token'
        }
      ];

      const env = generateOpenClawEnv({ services });

      expect(env['GITHUB_API_URL']).toBe('http://aquaman.local/github');
    });
  });

  describe('writeEnvFile', () => {
    it('should write environment variables to file', () => {
      const env = {
        'ANTHROPIC_BASE_URL': 'http://aquaman.local/anthropic',
        'OPENAI_BASE_URL': 'http://aquaman.local/openai'
      };

      const envPath = path.join(tempDir, '.env.test');
      writeEnvFile(env, envPath);

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"');
      expect(content).toContain('OPENAI_BASE_URL="http://aquaman.local/openai"');
    });

    it('should create parent directories if needed', () => {
      const env = { 'TEST': 'value' };
      const envPath = path.join(tempDir, 'nested', 'dir', '.env');

      writeEnvFile(env, envPath);

      expect(fs.existsSync(envPath)).toBe(true);
    });

    it('should set restrictive file permissions', () => {
      const env = { 'TEST': 'value' };
      const envPath = path.join(tempDir, '.env.test');

      writeEnvFile(env, envPath);

      const stats = fs.statSync(envPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe('formatEnvForDisplay', () => {
    it('should format environment variables for display', () => {
      const env = {
        'ANTHROPIC_BASE_URL': 'http://aquaman.local/anthropic',
        'OPENAI_BASE_URL': 'http://aquaman.local/openai'
      };

      const output = formatEnvForDisplay(env);

      expect(output).toContain('ANTHROPIC_BASE_URL=http://aquaman.local/anthropic');
      expect(output).toContain('OPENAI_BASE_URL=http://aquaman.local/openai');
    });

    it('should indent each line', () => {
      const env = { 'TEST': 'value' };

      const output = formatEnvForDisplay(env);

      expect(output).toBe('  TEST=value');
    });
  });
});
