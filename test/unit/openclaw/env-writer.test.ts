import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateOpenClawEnv,
  writeEnvFile,
  formatEnvForDisplay
} from '@aquaman/proxy';
import type { ServiceConfig } from '@aquaman/core';

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

      const env = generateOpenClawEnv({
        proxyHost: '127.0.0.1',
        proxyPort: 8081,
        tlsEnabled: false,
        services
      });

      expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8081/anthropic');
      expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:8081/openai');
    });

    it('should use HTTPS when TLS is enabled', () => {
      const services: ServiceConfig[] = [
        {
          name: 'anthropic',
          upstream: 'https://api.anthropic.com',
          authHeader: 'x-api-key',
          credentialKey: 'api_key'
        }
      ];

      const env = generateOpenClawEnv({
        proxyHost: '127.0.0.1',
        proxyPort: 8081,
        tlsEnabled: true,
        services
      });

      expect(env['ANTHROPIC_BASE_URL']).toBe('https://127.0.0.1:8081/anthropic');
    });

    it('should set NODE_EXTRA_CA_CERTS when provided', () => {
      const services: ServiceConfig[] = [
        {
          name: 'anthropic',
          upstream: 'https://api.anthropic.com',
          authHeader: 'x-api-key',
          credentialKey: 'api_key'
        }
      ];

      const env = generateOpenClawEnv({
        proxyHost: '127.0.0.1',
        proxyPort: 8081,
        tlsEnabled: true,
        services,
        nodeExtraCaCerts: '/path/to/cert.pem'
      });

      expect(env['NODE_EXTRA_CA_CERTS']).toBe('/path/to/cert.pem');
    });

    it('should set NODE_TLS_REJECT_UNAUTHORIZED when TLS enabled without CA certs', () => {
      const services: ServiceConfig[] = [
        {
          name: 'anthropic',
          upstream: 'https://api.anthropic.com',
          authHeader: 'x-api-key',
          credentialKey: 'api_key'
        }
      ];

      const env = generateOpenClawEnv({
        proxyHost: '127.0.0.1',
        proxyPort: 8081,
        tlsEnabled: true,
        services
      });

      expect(env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe('0');
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

      const env = generateOpenClawEnv({
        proxyHost: '127.0.0.1',
        proxyPort: 8081,
        tlsEnabled: false,
        services
      });

      expect(env['MY_CUSTOM_API_BASE_URL']).toBe('http://127.0.0.1:8081/my-custom-api');
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

      const env = generateOpenClawEnv({
        proxyHost: '127.0.0.1',
        proxyPort: 8081,
        tlsEnabled: false,
        services
      });

      expect(env['GITHUB_API_URL']).toBe('http://127.0.0.1:8081/github');
    });
  });

  describe('writeEnvFile', () => {
    it('should write environment variables to file', () => {
      const env = {
        'ANTHROPIC_BASE_URL': 'http://127.0.0.1:8081/anthropic',
        'OPENAI_BASE_URL': 'http://127.0.0.1:8081/openai'
      };

      const envPath = path.join(tempDir, '.env.test');
      writeEnvFile(env, envPath);

      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('ANTHROPIC_BASE_URL="http://127.0.0.1:8081/anthropic"');
      expect(content).toContain('OPENAI_BASE_URL="http://127.0.0.1:8081/openai"');
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
        'ANTHROPIC_BASE_URL': 'http://127.0.0.1:8081/anthropic',
        'OPENAI_BASE_URL': 'http://127.0.0.1:8081/openai'
      };

      const output = formatEnvForDisplay(env);

      expect(output).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic');
      expect(output).toContain('OPENAI_BASE_URL=http://127.0.0.1:8081/openai');
    });

    it('should indent each line', () => {
      const env = { 'TEST': 'value' };

      const output = formatEnvForDisplay(env);

      expect(output).toBe('  TEST=value');
    });
  });
});
