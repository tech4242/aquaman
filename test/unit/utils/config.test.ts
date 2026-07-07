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
  DEFAULT_LOOPBACK_PORT,
  DEFAULT_CACHE_TTL_SECONDS,
  CACHED_BY_DEFAULT_BACKENDS,
  resolveCacheTtl
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

    it('should set cacheTtlSeconds from AQUAMAN_CACHE_TTL', () => {
      process.env['AQUAMAN_CACHE_TTL'] = '300';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.cacheTtlSeconds).toBe(300);
    });

    it('should accept AQUAMAN_CACHE_TTL=0 (explicit disable)', () => {
      process.env['AQUAMAN_CACHE_TTL'] = '0';
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.cacheTtlSeconds).toBe(0);
    });

    it.each(['abc', '-5', '1.5', ''])('should ignore invalid AQUAMAN_CACHE_TTL %j', (raw) => {
      process.env['AQUAMAN_CACHE_TTL'] = raw;
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.cacheTtlSeconds).toBeUndefined();
    });

    it('should leave cacheTtlSeconds unset when AQUAMAN_CACHE_TTL is absent', () => {
      const config = applyEnvOverrides(getDefaultConfig());
      expect(config.credentials.cacheTtlSeconds).toBeUndefined();
    });
  });

  describe('resolveCacheTtl', () => {
    const withBackend = (backend: any, cacheTtlSeconds?: number) => {
      const config = getDefaultConfig();
      config.credentials.backend = backend;
      if (cacheTtlSeconds !== undefined) config.credentials.cacheTtlSeconds = cacheTtlSeconds;
      return config;
    };

    it.each(['1password', 'bitwarden', 'vault'])('defaults ON (%s → 900s) for per-access-cost backends', (backend) => {
      expect(resolveCacheTtl(withBackend(backend))).toBe(DEFAULT_CACHE_TTL_SECONDS);
    });

    it.each(['keychain', 'keepassxc', 'systemd-creds', 'encrypted-file'])('defaults OFF (%s → 0) for fast / internally-caching backends', (backend) => {
      expect(resolveCacheTtl(withBackend(backend))).toBe(0);
    });

    it('CACHED_BY_DEFAULT_BACKENDS matches the documented trio', () => {
      expect([...CACHED_BY_DEFAULT_BACKENDS].sort()).toEqual(['1password', 'bitwarden', 'vault']);
    });

    it('explicit cacheTtlSeconds: 0 disables even for a default-on backend', () => {
      expect(resolveCacheTtl(withBackend('1password', 0))).toBe(0);
    });

    it('explicit cacheTtlSeconds enables for a default-off backend', () => {
      expect(resolveCacheTtl(withBackend('keychain', 300))).toBe(300);
    });

    it('explicit cacheTtlSeconds overrides the default for a default-on backend', () => {
      expect(resolveCacheTtl(withBackend('vault', 60))).toBe(60);
    });

    it('floors a fractional explicit TTL', () => {
      expect(resolveCacheTtl(withBackend('keychain', 12.9))).toBe(12);
    });

    it('falls back to the backend default for a negative explicit TTL', () => {
      expect(resolveCacheTtl(withBackend('1password', -1))).toBe(DEFAULT_CACHE_TTL_SECONDS);
      expect(resolveCacheTtl(withBackend('keychain', -1))).toBe(0);
    });

    it('falls back to the backend default for a NaN explicit TTL', () => {
      expect(resolveCacheTtl(withBackend('bitwarden', Number.NaN))).toBe(DEFAULT_CACHE_TTL_SECONDS);
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

    it('saveConfig never persists the env-only encryptionPassword', () => {
      tmpDir = path.join(os.tmpdir(), `aquaman-perm-test-${Date.now()}`);
      process.env['AQUAMAN_CONFIG_DIR'] = tmpDir;
      const cfg = getDefaultConfig();
      cfg.credentials.encryptionPassword = 'super-secret-should-not-persist';
      saveConfig(cfg);
      const content = fs.readFileSync(path.join(tmpDir, 'config.yaml'), 'utf-8');
      expect(content).not.toContain('super-secret-should-not-persist');
      expect(content).not.toContain('encryptionPassword');
    });
  });
});
