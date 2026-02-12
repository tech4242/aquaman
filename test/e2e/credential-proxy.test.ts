/**
 * End-to-end tests for credential proxy
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

describe('CredentialProxy E2E', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;

  beforeEach(async () => {
    store = new MemoryStore();
    requestLog = [];
    socketPath = tmpSocketPath();

    // Set up test credentials
    await store.set('anthropic', 'api_key', 'sk-ant-test-key');
    await store.set('openai', 'api_key', 'sk-openai-test-key');

    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic', 'openai'],
      onRequest: (info) => {
        requestLog.push(info);
      }
    });

    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    store.clear();
    cleanupSocket(socketPath);
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

  describe('health endpoint', () => {
    it('should respond to /_health with status ok', async () => {
      const res = await udsFetch(socketPath, '/_health');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
      expect(typeof body.uptime).toBe('number');
      expect(body.services).toEqual(['anthropic', 'openai']);
    });

    it('should respond to /_health/ with trailing slash', async () => {
      const res = await udsFetch(socketPath, '/_health/');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('ok');
    });
  });

  describe('socket path', () => {
    it('should return correct socket path', () => {
      expect(proxy.getSocketPath()).toBe(socketPath);
    });
  });
});
