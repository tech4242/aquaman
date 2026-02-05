/**
 * End-to-end tests for credential proxy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';

describe('CredentialProxy E2E', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let proxyPort: number;

  beforeEach(async () => {
    store = new MemoryStore();
    requestLog = [];

    // Set up test credentials
    await store.set('anthropic', 'api_key', 'sk-ant-test-key');
    await store.set('openai', 'api_key', 'sk-openai-test-key');

    proxy = createCredentialProxy({
      port: 0, // Dynamic port allocation
      store,
      allowedServices: ['anthropic', 'openai'],
      onRequest: (info) => {
        requestLog.push(info);
      }
    });

    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
    store.clear();
  });

  describe('lifecycle', () => {
    it('should report running status', () => {
      expect(proxy.isRunning()).toBe(true);
    });

    it('should stop gracefully', async () => {
      await proxy.stop();
      expect(proxy.isRunning()).toBe(false);
    });
  });

  describe('getServiceConfigs', () => {
    it('should return service configurations', () => {
      const configs = proxy.getServiceConfigs();

      expect(configs.anthropic).toBeDefined();
      expect(configs.anthropic.upstream).toBe('https://api.anthropic.com');
      expect(configs.anthropic.authHeader).toBe('x-api-key');

      expect(configs.openai).toBeDefined();
      expect(configs.openai.upstream).toBe('https://api.openai.com');
      expect(configs.openai.authHeader).toBe('Authorization');
    });
  });

  describe('static helpers', () => {
    it('should generate correct base URL', () => {
      const url = CredentialProxy.getBaseUrl('anthropic', 8081);
      expect(url).toBe('http://127.0.0.1:8081/anthropic');
    });

    it('should generate correct base URL for different services', () => {
      expect(CredentialProxy.getBaseUrl('openai', 8082)).toBe('http://127.0.0.1:8082/openai');
      expect(CredentialProxy.getBaseUrl('slack', 9000)).toBe('http://127.0.0.1:9000/slack');
    });
  });
});
