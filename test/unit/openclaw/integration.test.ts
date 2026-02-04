import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OpenClawIntegration, createOpenClawIntegration } from '@aquaman/proxy';
import type { WrapperConfig, ServiceConfig } from '@aquaman/core';

describe('OpenClawIntegration', () => {
  let tempDir: string;

  const defaultConfig: WrapperConfig = {
    credentials: {
      backend: 'keychain',
      proxyPort: 8081,
      proxiedServices: ['anthropic', 'openai'],
      tls: {
        enabled: true,
        autoGenerate: true
      }
    },
    audit: {
      enabled: true,
      logDir: '/tmp/audit'
    },
    services: {
      configPath: '/tmp/services.yaml'
    },
    openclaw: {
      autoLaunch: true,
      configMethod: 'env'
    }
  };

  const defaultServices: ServiceConfig[] = [
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

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('createOpenClawIntegration', () => {
    it('should create an integration instance', () => {
      const integration = createOpenClawIntegration(defaultConfig, defaultServices);
      expect(integration).toBeInstanceOf(OpenClawIntegration);
    });
  });

  describe('detectOpenClaw', () => {
    it('should return installed: false when openclaw is not found', async () => {
      const config: WrapperConfig = {
        ...defaultConfig,
        openclaw: {
          ...defaultConfig.openclaw,
          binaryPath: '/nonexistent/path/openclaw'
        }
      };

      const integration = new OpenClawIntegration(config, defaultServices);
      const info = await integration.detectOpenClaw();

      expect(info.installed).toBe(false);
      expect(info.version).toBeUndefined();
    });
  });

  describe('configureOpenClaw', () => {
    it('should generate environment variables for proxy integration', async () => {
      const integration = new OpenClawIntegration(defaultConfig, defaultServices);

      const env = await integration.configureOpenClaw(8081, false);

      expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8081/anthropic');
      expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:8081/openai');
    });

    it('should use HTTPS when TLS is enabled', async () => {
      const integration = new OpenClawIntegration(defaultConfig, defaultServices);

      const env = await integration.configureOpenClaw(8081, true);

      expect(env['ANTHROPIC_BASE_URL']).toBe('https://127.0.0.1:8081/anthropic');
      expect(env['OPENAI_BASE_URL']).toBe('https://127.0.0.1:8081/openai');
    });
  });

  describe('writeConfiguration', () => {
    it('should write dotenv file when configMethod is dotenv', async () => {
      const config: WrapperConfig = {
        ...defaultConfig,
        openclaw: {
          ...defaultConfig.openclaw,
          configMethod: 'dotenv'
        }
      };

      const integration = new OpenClawIntegration(config, defaultServices);
      const env = { 'TEST_VAR': 'test_value' };

      // Mock process.cwd to return tempDir without actually changing directory
      const originalCwd = process.cwd;
      vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

      try {
        const result = await integration.writeConfiguration(env);
        expect(result).toBe(path.join(tempDir, '.env.aquaman'));
        expect(fs.existsSync(result)).toBe(true);

        const content = fs.readFileSync(result, 'utf-8');
        expect(content).toContain('TEST_VAR="test_value"');
      } finally {
        vi.mocked(process.cwd).mockRestore();
      }
    });

    it('should return formatted string when configMethod is env', async () => {
      const integration = new OpenClawIntegration(defaultConfig, defaultServices);
      const env = { 'TEST_VAR': 'test_value' };

      const result = await integration.writeConfiguration(env);

      expect(result).toContain('TEST_VAR=test_value');
    });
  });

  describe('getEnvForDisplay', () => {
    it('should return formatted environment variables', async () => {
      const integration = new OpenClawIntegration(defaultConfig, defaultServices);

      const display = await integration.getEnvForDisplay();

      expect(display).toContain('ANTHROPIC_BASE_URL=');
      expect(display).toContain('OPENAI_BASE_URL=');
    });
  });
});
