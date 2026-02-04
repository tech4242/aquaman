/**
 * Unit tests for the OAuth client credentials token cache.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OAuthTokenCache, createOAuthTokenCache } from '../../packages/proxy/src/oauth-token-cache.js';
import { MemoryStore } from '@aquaman/core';
import type { OAuthConfig } from '@aquaman/proxy';

describe('OAuthTokenCache', () => {
  let cache: OAuthTokenCache;
  let store: MemoryStore;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; body: string }>;

  const testOAuthConfig: OAuthConfig = {
    tokenUrl: 'https://auth.example.com/oauth2/token',
    clientIdKey: 'client_id',
    clientSecretKey: 'client_secret',
    scope: 'api.read',
  };

  beforeEach(async () => {
    cache = createOAuthTokenCache({ refreshBuffer: 1000 });
    store = new MemoryStore();
    await store.set('test-service', 'client_id', 'test-client-id');
    await store.set('test-service', 'client_secret', 'test-client-secret');

    fetchCalls = [];
    originalFetch = globalThis.fetch;

    // Mock fetch to simulate OAuth token endpoint
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const body = init?.body?.toString() || '';
      fetchCalls.push({ url, body });

      return new Response(JSON.stringify({
        access_token: 'mocked-access-token-' + fetchCalls.length,
        expires_in: 3600,
        token_type: 'Bearer',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cache.clear();
  });

  it('exchanges credentials for access token', async () => {
    const token = await cache.getToken('test-service', testOAuthConfig, store);

    expect(token).toBe('mocked-access-token-1');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://auth.example.com/oauth2/token');

    // Verify POST body contains correct parameters
    const params = new URLSearchParams(fetchCalls[0].body);
    expect(params.get('grant_type')).toBe('client_credentials');
    expect(params.get('client_id')).toBe('test-client-id');
    expect(params.get('client_secret')).toBe('test-client-secret');
    expect(params.get('scope')).toBe('api.read');
  });

  it('caches tokens and reuses them', async () => {
    const token1 = await cache.getToken('test-service', testOAuthConfig, store);
    const token2 = await cache.getToken('test-service', testOAuthConfig, store);

    expect(token1).toBe(token2);
    expect(fetchCalls).toHaveLength(1); // Only one fetch call
  });

  it('refreshes expired tokens', async () => {
    // Use a cache with 0 refresh buffer that gets expired tokens
    const shortCache = createOAuthTokenCache({ refreshBuffer: 99_999_000 });

    const token1 = await shortCache.getToken('test-service', testOAuthConfig, store);
    // Token will appear near-expiry due to large refresh buffer
    const token2 = await shortCache.getToken('test-service', testOAuthConfig, store);

    expect(token1).toBe('mocked-access-token-1');
    expect(token2).toBe('mocked-access-token-2');
    expect(fetchCalls).toHaveLength(2);
  });

  it('caches per-service independently', async () => {
    await store.set('other-service', 'client_id', 'other-id');
    await store.set('other-service', 'client_secret', 'other-secret');

    const token1 = await cache.getToken('test-service', testOAuthConfig, store);
    const token2 = await cache.getToken('other-service', testOAuthConfig, store);

    expect(token1).not.toBe(token2);
    expect(fetchCalls).toHaveLength(2);
  });

  it('throws when credentials are missing', async () => {
    const emptyStore = new MemoryStore();

    await expect(
      cache.getToken('test-service', testOAuthConfig, emptyStore)
    ).rejects.toThrow('OAuth credentials not found');
  });

  it('throws on failed token exchange', async () => {
    globalThis.fetch = async () => {
      return new Response('Unauthorized', { status: 401 });
    };

    await expect(
      cache.getToken('test-service', testOAuthConfig, store)
    ).rejects.toThrow('OAuth token exchange failed');
  });

  it('resolves template variables in token URL', async () => {
    await store.set('azure-service', 'client_id', 'azure-id');
    await store.set('azure-service', 'client_secret', 'azure-secret');
    await store.set('azure-service', 'tenant_id', 'my-tenant-123');

    const azureConfig: OAuthConfig = {
      tokenUrl: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      clientIdKey: 'client_id',
      clientSecretKey: 'client_secret',
    };

    await cache.getToken('azure-service', azureConfig, store);

    expect(fetchCalls[0].url).toBe(
      'https://login.microsoftonline.com/my-tenant-123/oauth2/v2.0/token'
    );
  });

  it('invalidate forces re-exchange', async () => {
    await cache.getToken('test-service', testOAuthConfig, store);
    expect(fetchCalls).toHaveLength(1);

    cache.invalidate('test-service');

    await cache.getToken('test-service', testOAuthConfig, store);
    expect(fetchCalls).toHaveLength(2);
  });

  it('clear removes all cached tokens', async () => {
    await cache.getToken('test-service', testOAuthConfig, store);
    cache.clear();

    await cache.getToken('test-service', testOAuthConfig, store);
    expect(fetchCalls).toHaveLength(2);
  });
});
