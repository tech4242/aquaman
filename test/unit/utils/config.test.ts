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

      expect(config.wrapper.proxyPort).toBe(18790);
      expect(config.wrapper.upstreamPort).toBe(18789);
      expect(config.audit.enabled).toBe(true);
      expect(config.credentials.backend).toBe('keychain');
      expect(config.approval.timeout).toBe(300);
    });

    it('should include default alert rules', () => {
      const config = getDefaultConfig();

      expect(config.audit.alertRules.length).toBeGreaterThan(0);
      expect(config.audit.alertRules.some(r => r.id === 'dangerous-command-pipe')).toBe(true);
    });

    it('should include default file permissions', () => {
      const config = getDefaultConfig();

      expect(config.permissions.files.allowedPaths.length).toBeGreaterThan(0);
      expect(config.permissions.files.deniedPaths.length).toBeGreaterThan(0);
    });

    it('should include default network permissions', () => {
      const config = getDefaultConfig();

      expect(config.permissions.network.defaultAction).toBe('deny');
      expect(config.permissions.network.allowedDomains).toContain('api.anthropic.com');
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
