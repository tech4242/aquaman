/**
 * E2E tests for credential injection
 *
 * These tests verify the core claim: credentials are actually injected into upstream requests.
 *
 * Architecture:
 *   Test -> Proxy (UDS) -> Mock Upstream (dynamic port)
 *                |
 *        Credential Store (Memory)
 *
 * Tests cover:
 * - Credential injection for Anthropic, OpenAI, GitHub
 * - Missing credential handling (401)
 * - Request/response body forwarding
 * - Streaming SSE responses
 * - Concurrent request handling
 * - Upstream failure/timeout handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from 'aquaman-proxy';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

describe('Credential Injection E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;
  let upstreamPort: number;

  // Test credentials
  const TEST_ANTHROPIC_KEY = 'sk-ant-test-123';
  const TEST_OPENAI_KEY = 'sk-openai-test-456';
  const TEST_GITHUB_TOKEN = 'ghp-token-789';

  beforeEach(async () => {
    // Start mock upstream server with dynamic port allocation
    upstream = createMockUpstream();
    await upstream.start(0); // OS assigns available port
    upstreamPort = upstream.port;

    // Configure credential store with test credentials
    store = new MemoryStore();
    await store.set('anthropic', 'api_key', TEST_ANTHROPIC_KEY);
    await store.set('openai', 'api_key', TEST_OPENAI_KEY);
    await store.set('github', 'token', TEST_GITHUB_TOKEN);

    requestLog = [];
    socketPath = tmpSocketPath();

    // Create service registry and override upstreams to point to mock
    const registry = createServiceRegistry();
    registry.override('anthropic', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('openai', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('github', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });

    // Start proxy with UDS
    proxy = createCredentialProxy({
      socketPath,
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
    cleanupSocket(socketPath);
  });

  describe('Anthropic credential injection', () => {
    it('injects x-api-key header for Anthropic requests', async () => {
      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      expect(response.status).toBe(200);

      // Verify upstream received the correct auth header
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);

      // Verify path was correctly forwarded (service prefix stripped)
      expect(lastRequest!.path).toBe('/v1/messages');
    });

    it('does not leak x-api-key header in response to client', async () => {
      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      // Response should not contain the auth header
      expect(response.headers['x-api-key']).toBeUndefined();
    });
  });

  describe('OpenAI credential injection', () => {
    it('injects Authorization header with Bearer prefix for OpenAI requests', async () => {
      const response = await udsFetch(socketPath, '/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'Hello' }]
        })
      });

      expect(response.status).toBe(200);

      // Verify upstream received Authorization with Bearer prefix
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_OPENAI_KEY}`);
    });
  });

  describe('GitHub credential injection', () => {
    it('injects Authorization header with Bearer prefix for GitHub requests', async () => {
      const response = await udsFetch(socketPath, '/github/repos/test/test', {
        method: 'GET',
        headers: { 'Accept': 'application/vnd.github.v3+json' }
      });

      expect(response.status).toBe(200);

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

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      expect(response.status).toBe(401);

      // Verify no request was made to upstream
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('401 body includes fix command when credential missing', async () => {
      await store.delete('anthropic', 'api_key');

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] }),
      });

      expect(response.status).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('anthropic');
      expect(body.fix).toBe('Run: aquaman credentials add anthropic api_key');
    });

    it('401 body includes service and key name', async () => {
      await store.delete('openai', 'api_key');

      const response = await udsFetch(socketPath, '/openai/v1/chat/completions', {
        method: 'POST',
      });

      expect(response.status).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('openai');
      expect(body.error).toContain('api_key');
    });

    it('logs authentication failure in request log', async () => {
      await store.delete('anthropic', 'api_key');

      await udsFetch(socketPath, '/anthropic/v1/messages', {
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

      await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(testBody)
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(JSON.parse(lastRequest!.body)).toEqual(testBody);
    });

    it('forwards request headers to upstream (except host and auth)', async () => {
      await udsFetch(socketPath, '/anthropic/v1/messages', {
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
      await udsFetch(socketPath, '/anthropic/v1/messages', {
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

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] })
      });

      const responseBody = JSON.parse(response.body);
      expect(responseBody).toEqual(mockResponseBody);
    });

    it('forwards response status codes from upstream', async () => {
      upstream.setMockResponse({
        statusCode: 429,
        body: { error: { type: 'rate_limit_error', message: 'Rate limited' } }
      });

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
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

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.headers['x-request-id']).toBe('req_abc123');
      expect(response.headers['x-ratelimit-remaining']).toBe('99');
    });
  });

  describe('Service routing', () => {
    it('routes requests to correct service based on path prefix', async () => {
      // Make requests to different services
      await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const anthropicRequest = upstream.getLastRequest();
      expect(anthropicRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);

      upstream.clearRequests();

      await udsFetch(socketPath, '/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      const openaiRequest = upstream.getLastRequest();
      expect(openaiRequest!.headers['authorization']).toBe(`Bearer ${TEST_OPENAI_KEY}`);
    });

    it('returns 404 for unknown service', async () => {
      const response = await udsFetch(socketPath, '/unknown-service/api', {
        method: 'GET'
      });

      expect(response.status).toBe(404);

      // No request should reach upstream
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('returns 404 for service not in allowedServices', async () => {
      // slack is a builtin service but not in our allowedServices list
      const response = await udsFetch(socketPath, '/slack/api/chat.postMessage', {
        method: 'POST'
      });

      expect(response.status).toBe(404);
      expect(upstream.getRequestCount()).toBe(0);
    });
  });

  describe('HTTP methods', () => {
    it('forwards GET requests', async () => {
      await udsFetch(socketPath, '/github/user', {
        method: 'GET'
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.method).toBe('GET');
      expect(lastRequest!.path).toBe('/user');
    });

    it('forwards POST requests', async () => {
      await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('POST');
    });

    it('forwards PUT requests', async () => {
      await udsFetch(socketPath, '/github/repos/owner/repo', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-name' })
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('PUT');
    });

    it('forwards DELETE requests', async () => {
      await udsFetch(socketPath, '/github/repos/owner/repo', {
        method: 'DELETE'
      });

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.method).toBe('DELETE');
    });

    it('forwards PATCH requests', async () => {
      await udsFetch(socketPath, '/github/repos/owner/repo', {
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
      await udsFetch(socketPath, '/anthropic/v1/messages', {
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
      await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        body: JSON.stringify({})
      });

      await udsFetch(socketPath, '/openai/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({})
      });

      expect(requestLog.length).toBe(2);
      expect(requestLog[0].id).not.toBe(requestLog[1].id);
    });
  });

  describe('Streaming responses (SSE)', () => {
    it('forwards streaming SSE responses correctly', async () => {
      // Set up SSE streaming response like Anthropic's streaming API
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":" world"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ];

      upstream.setStreamingResponse({
        statusCode: 200,
        chunks: sseChunks,
        delayMs: 10
      });

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', stream: true, messages: [] })
      });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');

      // Verify all chunks were received
      expect(response.body).toContain('event: message_start');
      expect(response.body).toContain('event: content_block_delta');
      expect(response.body).toContain('Hello');
      expect(response.body).toContain(' world');
      expect(response.body).toContain('event: message_stop');

      // Verify credential was injected
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);
    });

    it('handles multiple SSE chunks with credentials', async () => {
      const chunks = Array.from({ length: 20 }, (_, i) =>
        `data: {"index":${i},"content":"chunk${i}"}\n\n`
      );

      upstream.setStreamingResponse({
        statusCode: 200,
        chunks,
        delayMs: 5
      });

      const response = await udsFetch(socketPath, '/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4', stream: true })
      });

      // Verify all 20 chunks received
      for (let i = 0; i < 20; i++) {
        expect(response.body).toContain(`"index":${i}`);
      }

      // Verify credential was injected
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_OPENAI_KEY}`);
    });
  });

  describe('Concurrent requests', () => {
    it('handles 10 parallel requests with correct credentials', async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        udsFetch(socketPath, '/anthropic/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: i })
        })
      );

      const responses = await Promise.all(requests);

      // All requests should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      // All upstream requests should have correct credentials
      const allRequests = upstream.requests;
      expect(allRequests.length).toBe(10);
      for (const req of allRequests) {
        expect(req.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);
      }
    });

    it('handles concurrent requests to different services', async () => {
      const anthropicRequests = Array.from({ length: 5 }, () =>
        udsFetch(socketPath, '/anthropic/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        })
      );

      const openaiRequests = Array.from({ length: 5 }, () =>
        udsFetch(socketPath, '/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        })
      );

      const responses = await Promise.all([...anthropicRequests, ...openaiRequests]);

      // All requests should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      // Verify credentials are not mixed between services
      const allRequests = upstream.requests;
      expect(allRequests.length).toBe(10);

      for (const req of allRequests) {
        // Each request should have exactly one auth header
        const hasAnthropic = req.headers['x-api-key'] === TEST_ANTHROPIC_KEY;
        const hasOpenai = req.headers['authorization'] === `Bearer ${TEST_OPENAI_KEY}`;
        expect(hasAnthropic || hasOpenai).toBe(true);
        expect(hasAnthropic && hasOpenai).toBe(false);
      }
    });

    it('does not leak credentials between concurrent requests', async () => {
      // Make interleaved requests to different services
      const requests: Promise<{ status: number; headers: any; body: string }>[] = [];
      for (let i = 0; i < 20; i++) {
        const service = i % 3 === 0 ? 'anthropic' : i % 3 === 1 ? 'openai' : 'github';
        const urlPath = service === 'anthropic' ? 'v1/messages' :
                     service === 'openai' ? 'v1/chat/completions' : 'user';
        requests.push(
          udsFetch(socketPath, `/${service}/${urlPath}`, {
            method: service === 'github' ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: service === 'github' ? undefined : JSON.stringify({ index: i })
          })
        );
      }

      await Promise.all(requests);

      // Verify each request has only its service's credential
      const allRequests = upstream.requests;
      expect(allRequests.length).toBe(20);

      for (const req of allRequests) {
        const reqPath = req.path;
        if (reqPath.includes('v1/messages')) {
          expect(req.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);
          expect(req.headers['authorization']).toBeUndefined();
        } else if (reqPath.includes('v1/chat')) {
          expect(req.headers['authorization']).toBe(`Bearer ${TEST_OPENAI_KEY}`);
          expect(req.headers['x-api-key']).toBeUndefined();
        } else if (reqPath.includes('user')) {
          expect(req.headers['authorization']).toBe(`Bearer ${TEST_GITHUB_TOKEN}`);
          expect(req.headers['x-api-key']).toBeUndefined();
        }
      }
    });
  });

  describe('Upstream failure handling', () => {
    it('returns 502 when upstream connection fails', async () => {
      // Point to a port that doesn't have a server
      const registry = proxy.getServiceRegistry();
      registry.override('anthropic', {
        upstream: 'http://127.0.0.1:59999'  // Non-existent server
      });

      const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(502);

      // Check request log shows error
      const lastLog = requestLog[requestLog.length - 1];
      expect(lastLog.statusCode).toBe(502);
      expect(lastLog.error).toBeDefined();
    });

    it('returns 504 on upstream timeout', async () => {
      // Create a new proxy with a very short timeout
      await proxy.stop();

      const timeoutSocketPath = tmpSocketPath();
      const timeoutProxy = createCredentialProxy({
        socketPath: timeoutSocketPath,
        store,
        serviceRegistry: proxy.getServiceRegistry(),
        allowedServices: ['anthropic'],
        requestTimeout: 100, // 100ms timeout
        onRequest: (info) => requestLog.push(info)
      });
      await timeoutProxy.start();

      // Set upstream to delay longer than timeout
      upstream.setResponseDelay(500);

      const response = await udsFetch(timeoutSocketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(504);

      await timeoutProxy.stop();
      cleanupSocket(timeoutSocketPath);
    });
  });
});
