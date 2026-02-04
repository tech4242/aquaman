/**
 * Tests for config utilities
 */

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import {
  getDefaultConfig,
  expandPath
} from '../../../src/utils/config.js';

describe('config utilities', () => {
  describe('getDefaultConfig', () => {
    it('should return valid default config', () => {
      const config = getDefaultConfig();

      expect(config.credentials.proxyPort).toBe(8081);
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

    it('should enable TLS by default', () => {
      const config = getDefaultConfig();

      expect(config.credentials.tls?.enabled).toBe(true);
      expect(config.credentials.tls?.autoGenerate).toBe(true);
    });

    it('should include OpenClaw config', () => {
      const config = getDefaultConfig();

      expect(config.openclaw.autoLaunch).toBe(true);
      expect(config.openclaw.configMethod).toBe('env');
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
});
