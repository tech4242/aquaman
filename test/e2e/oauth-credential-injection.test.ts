/**
 * E2E tests for OAuth client credentials injection.
 *
 * Tests the oauth auth mode used by MS Teams, Feishu, and Google Chat.
 * The proxy exchanges stored client credentials for a short-lived access
 * token via a mock token server, then injects the Bearer token into the
 * upstream request.
 *
 * Architecture:
 *   Test → Proxy (port 0) → Mock Upstream (port 0)
 *                ↓
 *         MemoryStore
 *                ↓
 *         Mock Token Server (port 0)
 *
 * Safety: MemoryStore + mock upstream + mock token server. All localhost,
 * no real APIs are contacted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from 'aquaman-proxy';

// Test credentials (all fake, never leave localhost)
const TEST_CLIENT_ID = 'test-client-id-abc';
const TEST_CLIENT_SECRET = 'test-client-secret-xyz';
const TEST_TENANT_ID = 'test-tenant-id-12345';
const MOCK_ACCESS_TOKEN = 'mock-oauth-token-abc';

interface TokenRequest {
  path: string;
  body: string;
}

/**
 * Creates a mock OAuth token server that returns configurable responses.
 */
function createMockTokenServer() {
  const requests: TokenRequest[] = [];
  let responseBody: object = { access_token: MOCK_ACCESS_TOKEN, expires_in: 3600 };
  let responseStatus = 200;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        path: req.url || '/',
        body: Buffer.concat(chunks).toString('utf-8'),
      });

      res.statusCode = responseStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(responseBody));
    });
  });

  return {
    server,
    requests,
    setResponse(status: number, body: object) {
      responseStatus = status;
      responseBody = body;
    },
    async start(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

describe('OAuth Credential Injection E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let tokenServer: ReturnType<typeof createMockTokenServer>;
  let requestLog: RequestInfo[];
  let proxyPort: number;
  let tokenPort: number;

  beforeEach(async () => {
    // Start mock upstream
    upstream = createMockUpstream();
    await upstream.start(0);

    // Start mock token server
    tokenServer = createMockTokenServer();
    tokenPort = await tokenServer.start();

    // Seed credential store
    store = new MemoryStore();
    await store.set('ms-teams', 'client_id', TEST_CLIENT_ID);
    await store.set('ms-teams', 'client_secret', TEST_CLIENT_SECRET);
    await store.set('ms-teams', 'tenant_id', TEST_TENANT_ID);

    requestLog = [];

    // Build registry with overrides pointing to local mocks
    const registry = createServiceRegistry();
    registry.override('ms-teams', {
      upstream: `http://127.0.0.1:${upstream.port}`,
      oauthConfig: {
        tokenUrl: `http://127.0.0.1:${tokenPort}/{tenant_id}/oauth2/v2.0/token`,
        clientIdKey: 'client_id',
        clientSecretKey: 'client_secret',
        scope: 'https://graph.microsoft.com/.default',
      },
    });

    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['ms-teams'],
      onRequest: (info) => requestLog.push(info),
    });

    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    await tokenServer.stop();
    store.clear();
  });

  it('exchanges client credentials and injects Bearer token', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/ms-teams/v1.0/teams/123/channels`, {
      method: 'GET',
    });

    expect(response.ok).toBe(true);

    // Verify upstream received Bearer token
    const lastUpstream = upstream.getLastRequest();
    expect(lastUpstream).toBeDefined();
    expect(lastUpstream!.headers['authorization']).toBe(`Bearer ${MOCK_ACCESS_TOKEN}`);

    // Verify token server received correct POST body
    expect(tokenServer.requests.length).toBe(1);
    const tokenBody = new URLSearchParams(tokenServer.requests[0].body);
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('client_id')).toBe(TEST_CLIENT_ID);
    expect(tokenBody.get('client_secret')).toBe(TEST_CLIENT_SECRET);
    expect(tokenBody.get('scope')).toBe('https://graph.microsoft.com/.default');
  });

  it('resolves {tenant_id} template in token URL', async () => {
    await fetch(`http://127.0.0.1:${proxyPort}/ms-teams/v1.0/me`, {
      method: 'GET',
    });

    expect(tokenServer.requests.length).toBe(1);
    // The token URL should have the tenant_id resolved from the store
    expect(tokenServer.requests[0].path).toBe(`/${TEST_TENANT_ID}/oauth2/v2.0/token`);
  });

  it('caches token across multiple requests', async () => {
    // Make 3 requests through the proxy
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/ms-teams/v1.0/me`, {
        method: 'GET',
      });
      expect(response.ok).toBe(true);
    }

    // Token server should only be called once (token cached)
    expect(tokenServer.requests.length).toBe(1);

    // All 3 upstream requests should have the Bearer token
    expect(upstream.getRequestCount()).toBe(3);
  });

  it('returns 500 when token exchange fails', async () => {
    tokenServer.setResponse(400, { error: 'invalid_client', error_description: 'Bad credentials' });

    // Need a fresh proxy to clear the token cache from prior tests
    await proxy.stop();
    const registry = createServiceRegistry();
    registry.override('ms-teams', {
      upstream: `http://127.0.0.1:${upstream.port}`,
      oauthConfig: {
        tokenUrl: `http://127.0.0.1:${tokenPort}/{tenant_id}/oauth2/v2.0/token`,
        clientIdKey: 'client_id',
        clientSecretKey: 'client_secret',
        scope: 'https://graph.microsoft.com/.default',
      },
    });
    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['ms-teams'],
      onRequest: (info) => requestLog.push(info),
    });
    await proxy.start();
    proxyPort = proxy.getPort();

    const response = await fetch(`http://127.0.0.1:${proxyPort}/ms-teams/v1.0/me`, {
      method: 'GET',
    });

    expect(response.status).toBe(500);
  });

  it('returns 401 when client credentials are missing', async () => {
    store.clear();

    const response = await fetch(`http://127.0.0.1:${proxyPort}/ms-teams/v1.0/me`, {
      method: 'GET',
    });

    // Proxy returns 401 when primary credential (client_id) is not found
    expect(response.status).toBe(401);
  });
});
