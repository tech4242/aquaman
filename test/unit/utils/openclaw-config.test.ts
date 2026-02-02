/**
 * Tests for OpenClaw config utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateProxyModelsConfig,
  getOpenClawDir
} from '../../../src/utils/openclaw-config.js';

describe('openclaw-config utilities', () => {
  describe('getOpenClawDir', () => {
    it('should return path in home directory', () => {
      const dir = getOpenClawDir();
      expect(dir).toBe(path.join(os.homedir(), '.openclaw'));
    });
  });

  describe('generateProxyModelsConfig', () => {
    it('should generate config with proxy URLs', () => {
      const config = generateProxyModelsConfig(8081);

      expect(config.providers).toBeDefined();
      expect(config.providers?.anthropic?.baseUrl).toBe('http://127.0.0.1:8081/anthropic/v1');
      expect(config.providers?.openai?.baseUrl).toBe('http://127.0.0.1:8081/openai/v1');
    });

    it('should use custom port', () => {
      const config = generateProxyModelsConfig(9999);

      expect(config.providers?.anthropic?.baseUrl).toContain(':9999/');
      expect(config.providers?.openai?.baseUrl).toContain(':9999/');
    });
  });
});
