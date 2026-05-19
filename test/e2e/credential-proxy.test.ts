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

  describe('broker endpoint (v0.12.0+)', () => {
    it('resolves a stored credential and returns value + expires_at', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key', ttl_seconds: 30 }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.value).toBe('sk-ant-test-key');
      expect(typeof body.expires_at).toBe('string');
      const expiry = Date.parse(body.expires_at);
      expect(expiry).toBeGreaterThan(Date.now());
      expect(expiry).toBeLessThan(Date.now() + 60_000);
    });

    it('uses default 60s TTL when ttl_seconds omitted', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'openai', key: 'api_key' }),
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.value).toBe('sk-openai-test-key');
      const expiry = Date.parse(body.expires_at);
      const delta = expiry - Date.now();
      expect(delta).toBeGreaterThan(50_000);
      expect(delta).toBeLessThan(70_000);
    });

    it('returns 404 when credential not found (with actionable fix)', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'nonexistent_key' }),
      });
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/No credential found/);
      expect(body.fix).toMatch(/aquaman credentials add/);
    });

    it('returns 400 when body is not valid JSON', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not valid JSON/);
    });

    it('returns 400 when service field is missing', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'api_key' }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/service/);
    });

    it('returns 400 when key field is missing', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic' }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/key/);
    });

    it('rejects path-traversal-shaped service names', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: '../escape', key: 'api_key' }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/Invalid service name/);
    });

    it('rejects oversized request body (>4 KB)', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key', filler: 'x'.repeat(5000) }),
      });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/too large/);
    });

    it('rejects ttl_seconds out of range', async () => {
      const tooBig = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key', ttl_seconds: 99999 }),
      });
      expect(tooBig.status).toBe(400);
      expect(JSON.parse(tooBig.body).error).toMatch(/Invalid ttl_seconds/);

      const tooSmall = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key', ttl_seconds: 0 }),
      });
      expect(tooSmall.status).toBe(400);
    });

    it('emits an audit request event on successful resolve', async () => {
      requestLog.length = 0;
      await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key' }),
      });
      expect(requestLog.length).toBe(1);
      const event = requestLog[0];
      expect(event.method).toBe('BROKER');
      expect(event.path).toBe('/broker/resolve');
      expect(event.service).toBe('anthropic');
      expect(event.statusCode).toBe(200);
      expect(event.authenticated).toBe(true);
    });

    it('GET /broker/resolve falls through to service-routing 404 (POST-only)', async () => {
      const res = await udsFetch(socketPath, '/broker/resolve', { method: 'GET' });
      expect(res.status).toBe(404);
      expect(res.body).toBe('Not found');
    });

    it('emits an audit request event on 404 (not found)', async () => {
      requestLog.length = 0;
      await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'missing_key' }),
      });
      expect(requestLog.length).toBe(1);
      expect(requestLog[0].statusCode).toBe(404);
      expect(requestLog[0].authenticated).toBe(false);
    });
  });
});
