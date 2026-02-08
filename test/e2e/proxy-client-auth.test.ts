/**
 * E2E tests for proxy client authentication (X-Aquaman-Token).
 *
 * Validates that the proxy enforces shared-secret bearer token
 * authentication when clientToken is configured, and that the token
 * never leaks to upstream servers.
 *
 * Architecture:
 *   Test → Proxy (dynamic port, clientToken set) → Mock Upstream (dynamic port)
 *                ↓
 *        Credential Store (Memory)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from 'aquaman-proxy';

const TEST_API_KEY = 'sk-ant-test-key-for-auth';
const TEST_TOKEN = 'a'.repeat(64); // 64-char hex-like token
const WRONG_TOKEN = 'b'.repeat(64);

describe('Proxy Client Authentication E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let proxyPort: number;

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);

    store = new MemoryStore();
    await store.set('anthropic', 'api_key', TEST_API_KEY);

    requestLog = [];

    const registry = createServiceRegistry();
    registry.override('anthropic', {
      upstream: `http://127.0.0.1:${upstream.port}`
    });

    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic'],
      clientToken: TEST_TOKEN,
      onRequest: (info) => {
        requestLog.push(info);
      }
    });

    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    store.clear();
  });

  describe('Token enforcement', () => {
    it('rejects requests without token → 403', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toBe('Forbidden');
      // Token must not appear in error body
      expect(body).not.toContain(TEST_TOKEN);
    });

    it('rejects requests with wrong token → 403', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aquaman-Token': WRONG_TOKEN
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      expect(response.status).toBe(403);
    });

    it('rejects requests with empty token → 403', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aquaman-Token': ''
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      expect(response.status).toBe(403);
    });

    it('accepts correct X-Aquaman-Token header → credential injected', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aquaman-Token': TEST_TOKEN
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_API_KEY);
    });

    it('accepts correct Authorization: Bearer token', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_TOKEN}`
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_API_KEY);
    });

    it('/_health accessible without token', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/_health`);

      expect(response.ok).toBe(true);
      const data = await response.json() as any;
      expect(data.status).toBe('ok');
    });
  });

  describe('Token isolation', () => {
    it('token NOT forwarded to upstream', async () => {
      await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aquaman-Token': TEST_TOKEN
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['x-aquaman-token']).toBeUndefined();
    });

    it('Authorization: Bearer token NOT forwarded to upstream', async () => {
      await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TEST_TOKEN}`
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      // Authorization header should be the injected service auth, not the client token
      expect(lastRequest!.headers['authorization']).toBeUndefined();
      expect(lastRequest!.headers['x-aquaman-token']).toBeUndefined();
    });
  });

  describe('Backward compatibility', () => {
    it('no clientToken in options → all requests accepted without any token', async () => {
      // Create a proxy without clientToken
      const noAuthProxy = createCredentialProxy({
        port: 0,
        store,
        serviceRegistry: proxy.getServiceRegistry(),
        allowedServices: ['anthropic']
      });
      await noAuthProxy.start();
      const port = noAuthProxy.getPort();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
        });

        expect(response.ok).toBe(true);
      } finally {
        await noAuthProxy.stop();
      }
    });
  });

  describe('Auth modes with client token', () => {
    it('header auth (anthropic) works with client token', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aquaman-Token': TEST_TOKEN
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [] })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_API_KEY);
      expect(lastRequest!.headers['x-aquaman-token']).toBeUndefined();
    });

    it('url-path auth (telegram) works with client token', async () => {
      const telegramToken = '123456:ABC-TEST';
      await store.set('telegram', 'bot_token', telegramToken);

      const registry = createServiceRegistry();
      registry.override('telegram', {
        upstream: `http://127.0.0.1:${upstream.port}`
      });

      const telegramProxy = createCredentialProxy({
        port: 0,
        store,
        serviceRegistry: registry,
        allowedServices: ['telegram'],
        clientToken: TEST_TOKEN
      });
      await telegramProxy.start();
      const port = telegramProxy.getPort();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/telegram/getMe`, {
          headers: { 'X-Aquaman-Token': TEST_TOKEN }
        });

        expect(response.ok).toBe(true);

        const lastRequest = upstream.getLastRequest();
        expect(lastRequest!.path).toBe(`/bot${telegramToken}/getMe`);
        expect(lastRequest!.headers['x-aquaman-token']).toBeUndefined();
      } finally {
        await telegramProxy.stop();
      }
    });

    it('basic auth (twilio) works with client token', async () => {
      await store.set('twilio', 'account_sid', 'ACtest123');
      await store.set('twilio', 'auth_token', 'secret456');

      const registry = createServiceRegistry();
      registry.override('twilio', {
        upstream: `http://127.0.0.1:${upstream.port}`
      });

      const twilioProxy = createCredentialProxy({
        port: 0,
        store,
        serviceRegistry: registry,
        allowedServices: ['twilio'],
        clientToken: TEST_TOKEN
      });
      await twilioProxy.start();
      const port = twilioProxy.getPort();

      try {
        const response = await fetch(`http://127.0.0.1:${port}/twilio/2010-04-01/Accounts.json`, {
          headers: { 'X-Aquaman-Token': TEST_TOKEN }
        });

        expect(response.ok).toBe(true);

        const lastRequest = upstream.getLastRequest();
        const expectedAuth = 'Basic ' + Buffer.from('ACtest123:secret456').toString('base64');
        expect(lastRequest!.headers['authorization']).toBe(expectedAuth);
        expect(lastRequest!.headers['x-aquaman-token']).toBeUndefined();
      } finally {
        await twilioProxy.stop();
      }
    });
  });

  describe('Concurrent requests with token', () => {
    it('handles 20 parallel authenticated requests correctly', async () => {
      const requests = Array.from({ length: 20 }, (_, i) =>
        fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Aquaman-Token': TEST_TOKEN
          },
          body: JSON.stringify({ model: 'test', max_tokens: 5, messages: [{ role: 'user', content: `msg-${i}` }] })
        })
      );

      const responses = await Promise.all(requests);

      for (const response of responses) {
        expect(response.ok).toBe(true);
      }

      // All 20 requests should reach upstream with correct credentials
      expect(upstream.getRequestCount()).toBe(20);
      for (const req of upstream.requests) {
        expect(req.headers['x-api-key']).toBe(TEST_API_KEY);
        expect(req.headers['x-aquaman-token']).toBeUndefined();
      }
    });
  });

  describe('Streaming SSE with token', () => {
    it('streams chunks correctly when token is valid', async () => {
      upstream.setStreamingResponse({
        statusCode: 200,
        chunks: [
          'data: {"type":"content_block_start"}\n\n',
          'data: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n',
          'data: {"type":"message_stop"}\n\n',
          'data: [DONE]\n\n'
        ],
        delayMs: 10
      });

      const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Aquaman-Token': TEST_TOKEN
        },
        body: JSON.stringify({ model: 'test', max_tokens: 5, stream: true, messages: [] })
      });

      expect(response.ok).toBe(true);

      const body = await response.text();
      expect(body).toContain('content_block_start');
      expect(body).toContain('content_block_delta');
      expect(body).toContain('message_stop');
    });
  });
});
