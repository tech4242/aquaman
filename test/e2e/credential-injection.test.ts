/**
 * E2E tests for credential injection
 *
 * These tests verify the core claim: credentials are actually injected into upstream requests.
 *
 * Architecture:
 *   Test → Proxy (:18081) → Mock Upstream (:19000)
 *                ↓
 *        Credential Store (Memory)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy } from '../../src/credentials/proxy-daemon.js';
import { MemoryStore } from '../../src/credentials/store.js';
import { createServiceRegistry } from '../../src/credentials/service-registry.js';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from '../../src/credentials/proxy-daemon.js';

describe('Credential Injection E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];

  const PROXY_PORT = 18081;
  const UPSTREAM_PORT = 19000;

  // Test credentials
  const TEST_ANTHROPIC_KEY = 'sk-ant-test-123';
  const TEST_OPENAI_KEY = 'sk-openai-test-456';
  const TEST_GITHUB_TOKEN = 'ghp-token-789';

  beforeEach(async () => {
    // Start mock upstream server
    upstream = createMockUpstream();
    await upstream.start(UPSTREAM_PORT);

    // Configure credential store with test credentials
    store = new MemoryStore();
    await store.set('anthropic', 'api_key', TEST_ANTHROPIC_KEY);
    await store.set('openai', 'api_key', TEST_OPENAI_KEY);
    await store.set('github', 'token', TEST_GITHUB_TOKEN);

    requestLog = [];

    // Create service registry and override upstreams to point to mock
    const registry = createServiceRegistry();
    registry.override('anthropic', {
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`
    });
    registry.override('openai', {
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`
    });
    registry.override('github', {
      upstream: `http://127.0.0.1:${UPSTREAM_PORT}`
    });

    // Start proxy with custom registry
    proxy = createCredentialProxy({
      port: PROXY_PORT,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic', 'openai', 'github'],
      onRequest: (info) => {
        requestLog.push(info);
      }
    });

    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    store.clear();
  });

  describe('Anthropic credential injection', () => {
    it('injects x-api-key header for Anthropic requests', async () => {
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      expect(response.ok).toBe(true);

      // Verify upstream received the correct auth header
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);

      // Verify path was correctly forwarded (service prefix stripped)
      expect(lastRequest!.path).toBe('/v1/messages');
    });

    it('does not leak x-api-key header in response to client', async () => {
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      // Response should not contain the auth header
      expect(response.headers.get('x-api-key')).toBeNull();
    });
  });

  describe('OpenAI credential injection', () => {
    it('injects Authorization header with Bearer prefix for OpenAI requests', async () => {
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }]
        })
      });

      expect(response.ok).toBe(true);

      // Verify upstream received Authorization with Bearer prefix
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_OPENAI_KEY}`);
    });
  });

  describe('GitHub credential injection', () => {
    it('injects Authorization header with Bearer prefix for GitHub requests', async () => {
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/github/repos/test/test`, {
        method: 'GET',
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      expect(response.ok).toBe(true);

      // Verify upstream received Authorization with Bearer prefix
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_GITHUB_TOKEN}`);
    });
  });

  describe('Missing credential handling', () => {
    it('returns 401 when credential is not configured', async () => {
      // Remove the anthropic credential
      await store.delete('anthropic', 'api_key');

      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      expect(response.status).toBe(401);

      // Verify no request was made to upstream
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('logs authentication failure in request log', async () => {
      await store.delete('anthropic', 'api_key');

      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST'
      });

      const lastLog = requestLog[requestLog.length - 1];
      expect(lastLog).toBeDefined();
      expect(lastLog.authenticated).toBe(false);
      expect(lastLog.error).toContain('Credential not found');
    });
  });

  describe('Request body forwarding', () => {
    it('forwards request body to upstream unchanged', async () => {
      const testBody = {
        model: 'claude-3-opus',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello, world!' }
        ]
      };

      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testBody)
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(JSON.parse(lastRequest!.body)).toEqual(testBody);
    });

    it('forwards request headers to upstream (except host and auth)', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Custom-Header': 'custom-value',
          'anthropic-version': '2024-01-01'
        },
        body: JSON.stringify({})
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['content-type']).toBe('application/json');
      expect(lastRequest!.headers['x-custom-header']).toBe('custom-value');
      expect(lastRequest!.headers['anthropic-version']).toBe('2024-01-01');
    });

    it('strips client-provided auth header (prevents override)', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'sk-client-provided-fake-key'
        },
        body: JSON.stringify({})
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      // Should use the stored credential, not the client-provided one
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);
    });
  });

  describe('Response forwarding', () => {
    it('forwards response body from upstream to client', async () => {
      const mockResponseBody = {
        id: 'msg_123',
        type: 'message',
        content: [{ type: 'text', text: 'Hello from Claude!' }]
      };

      upstream.setMockResponse({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: mockResponseBody
      });

      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      const responseBody = await response.json();
      expect(responseBody).toEqual(mockResponseBody);
    });

    it('forwards response status codes from upstream', async () => {
      upstream.setMockResponse({
        statusCode: 429,
        body: { error: { type: 'rate_limit_error', message: 'Rate limited' } }
      });

      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(429);
    });

    it('forwards response headers from upstream (except transfer-encoding)', async () => {
      upstream.setMockResponse({
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-Id': 'req_abc123',
          'X-RateLimit-Remaining': '99'
        },
        body: { success: true }
      });

      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.headers.get('x-request-id')).toBe('req_abc123');
      expect(response.headers.get('x-ratelimit-remaining')).toBe('99');
    });
  });

  describe('Service routing', () => {
    it('routes requests to correct service based on path prefix', async () => {
      // Make requests to different services
      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const anthropicRequest = upstream.getLastRequest();
      expect(anthropicRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);

      upstream.clearRequests();

      await fetch(`http://127.0.0.1:${PROXY_PORT}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const openaiRequest = upstream.getLastRequest();
      expect(openaiRequest!.headers['authorization']).toBe(`Bearer ${TEST_OPENAI_KEY}`);
    });

    it('returns 404 for unknown service', async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/unknown-service/api`, {
          method: 'GET'
        });

        expect(response.status).toBe(404);
      } catch (error) {
        // Connection may be reset for invalid services, which is acceptable behavior
        expect((error as Error).message).toMatch(/fetch failed|ECONNRESET/);
      }

      // Regardless of how the request failed, no request should reach upstream
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('returns 404 for service not in allowedServices', async () => {
      // slack is a builtin service but not in our allowedServices list
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/slack/api/chat.postMessage`, {
        method: 'POST'
      });

      expect(response.status).toBe(404);
      expect(upstream.getRequestCount()).toBe(0);
    });
  });

  describe('HTTP methods', () => {
    it('forwards GET requests', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/github/user`, {
        method: 'GET'
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.method).toBe('GET');
      expect(lastRequest!.path).toBe('/user');
    });

    it('forwards POST requests', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('POST');
    });

    it('forwards PUT requests', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/github/repos/owner/repo`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-name' })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('PUT');
    });

    it('forwards DELETE requests', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/github/repos/owner/repo`, {
        method: 'DELETE'
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('DELETE');
    });

    it('forwards PATCH requests', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/github/repos/owner/repo`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Updated' })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('PATCH');
    });
  });

  describe('Request logging', () => {
    it('logs successful authenticated requests', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(requestLog.length).toBe(1);
      expect(requestLog[0].service).toBe('anthropic');
      expect(requestLog[0].authenticated).toBe(true);
      expect(requestLog[0].statusCode).toBe(200);
      expect(requestLog[0].path).toBe('/anthropic/v1/messages');
    });

    it('logs each request with unique ID', async () => {
      await fetch(`http://127.0.0.1:${PROXY_PORT}/anthropic/v1/messages`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      await fetch(`http://127.0.0.1:${PROXY_PORT}/openai/v1/chat/completions`, {
        method: 'POST',
        body: JSON.stringify({})
      });

      expect(requestLog.length).toBe(2);
      expect(requestLog[0].id).not.toBe(requestLog[1].id);
    });
  });
});
