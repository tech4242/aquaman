/**
 * Tests for config utilities
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getDefaultConfig,
  expandPath,
  applyEnvOverrides,
  ensureConfigDir,
  saveConfig,
  generateLoopbackToken,
  DEFAULT_LOOPBACK_PORT
} from 'aquaman-core';

describe('config utilities', () => {
  describe('getDefaultConfig', () => {
    it('should return valid default config', () => {
      const config = getDefaultConfig();

      expect(config.credentials.backend).toBe('keychain');
      expect(config.audit.enabled).toBe(true);
      expect(config.openclaw.autoLaunch).toBe(true);
    });

    it('should include default proxied services', () => {
      const config = getDefaultConfig();

      expect(config.credentials.proxiedServices).toContain('anthropic');
      expect(config.credentials.proxiedServices).toContain('openai');
      expect(config.credentials.proxiedServices.length).toBeGreaterThan(0);
    });

    it('should include OpenClaw config', () => {
      const config = getDefaultConfig();

      expect(config.openclaw.autoLaunch).toBe(true);
      expect(config.openclaw.configMethod).toBe('env');
    });

    it('should default the loopback listener to disabled', () => {
      const config = getDefaultConfig();

      expect(config.loopback?.enabled).toBe(false);
      expect(config.loopback?.port).toBe(DEFAULT_LOOPBACK_PORT);
      expect(config.loopback?.host).toBe('127.0.0.1');
      expect(config.loopback?.token).toBeUndefined();
    });

    it('should include default Hermes config', () => {
      const config = getDefaultConfig();

      expect(config.hermes?.configMethod).toBe('dotenv');
    });
  });

  describe('generateLoopbackToken', () => {
    it('generates a prefixed, unguessable token', () => {
      const token = generateLoopbackToken();
      expect(token).toMatch(/^aqm_lb_[0-9a-f]{48}$/);
    });

    it('generates a different token each call', () => {
      expect(generateLoopbackToken()).not.toBe(generateLoopbackToken());
    });
  });

  describe('applyEnvOverrides', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      // Restore original env
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, originalEnv);
    });

    it('should override backend from AQUAMAN_BACKEND', () => {
      process.env['AQUAMAN_BACKEND'] = 'vault';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.backend).toBe('vault');
    });

    it('should ignore invalid backend values', () => {
      process.env['AQUAMAN_BACKEND'] = 'invalid';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.backend).toBe('keychain');
    });

    it('should override services from AQUAMAN_SERVICES', () => {
      process.env['AQUAMAN_SERVICES'] = 'anthropic,slack';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.proxiedServices).toEqual(['anthropic', 'slack']);
    });

    it('should override audit enabled from AQUAMAN_AUDIT_ENABLED', () => {
      process.env['AQUAMAN_AUDIT_ENABLED'] = 'false';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.audit.enabled).toBe(false);
    });

    it('should set vault config from VAULT_ADDR and VAULT_TOKEN', () => {
      process.env['VAULT_ADDR'] = 'https://vault.example.com';
      process.env['VAULT_TOKEN'] = 'hvs.test';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.vaultAddress).toBe('https://vault.example.com');
      expect(config.credentials.vaultToken).toBe('hvs.test');
    });

    it('should set encryption password from AQUAMAN_ENCRYPTION_PASSWORD', () => {
      process.env['AQUAMAN_ENCRYPTION_PASSWORD'] = 'secret123';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.encryptionPassword).toBe('secret123');
    });

    it('should enable + configure the loopback listener from AQUAMAN_LOOPBACK_* vars', () => {
      process.env['AQUAMAN_LOOPBACK_ENABLED'] = 'true';
      process.env['AQUAMAN_LOOPBACK_PORT'] = '9911';
      process.env['AQUAMAN_LOOPBACK_TOKEN'] = 'aqm_lb_envtoken';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.loopback?.enabled).toBe(true);
      expect(config.loopback?.port).toBe(9911);
      expect(config.loopback?.token).toBe('aqm_lb_envtoken');
    });

    it('should ignore an out-of-range AQUAMAN_LOOPBACK_PORT', () => {
      process.env['AQUAMAN_LOOPBACK_PORT'] = '70000';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.loopback?.port).toBe(DEFAULT_LOOPBACK_PORT);
    });
  });

  describe('expandPath', () => {
    it('should expand ~ to home directory', () => {
      const result = expandPath('~/test/path');
      expect(result).toBe(`${os.homedir()}/test/path`);
    });

    it('should expand ${HOME}', () => {
      const result = expandPath('${HOME}/test/path');
      expect(result).toBe(`${os.homedir()}/test/path`);
    });

    it('should leave absolute paths unchanged', () => {
      const result = expandPath('/absolute/path');
      expect(result).toBe('/absolute/path');
    });

    it('should leave relative paths unchanged', () => {
      const result = expandPath('relative/path');
      expect(result).toBe('relative/path');
    });
  });

  describe('file permissions', () => {
    let tmpDir: string;
    const originalEnv = process.env['AQUAMAN_CONFIG_DIR'];

    afterEach(() => {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
      if (originalEnv === undefined) {
        delete process.env['AQUAMAN_CONFIG_DIR'];
      } else {
        process.env['AQUAMAN_CONFIG_DIR'] = originalEnv;
      }
    });

    it('ensureConfigDir creates directory with mode 0o700', () => {
      tmpDir = path.join(os.tmpdir(), `aquaman-perm-test-${Date.now()}`);
      process.env['AQUAMAN_CONFIG_DIR'] = tmpDir;
      ensureConfigDir();
      const stat = fs.statSync(tmpDir);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it('saveConfig writes file with mode 0o600', () => {
      tmpDir = path.join(os.tmpdir(), `aquaman-perm-test-${Date.now()}`);
      process.env['AQUAMAN_CONFIG_DIR'] = tmpDir;
      saveConfig(getDefaultConfig());
      const configFile = path.join(tmpDir, 'config.yaml');
      const stat = fs.statSync(configFile);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });
});
