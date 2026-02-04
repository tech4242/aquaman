/**
 * Unit tests for the HTTP fetch interceptor.
 *
 * Tests that globalThis.fetch is correctly overridden to redirect
 * channel API traffic through the aquaman credential proxy.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpInterceptor, createHttpInterceptor } from '../../packages/openclaw/src/http-interceptor.js';

describe('HttpInterceptor', () => {
  let interceptor: HttpInterceptor;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  const hostMap = new Map<string, string>([
    ['api.telegram.org', 'telegram'],
    ['slack.com', 'slack'],
    ['*.slack.com', 'slack'],
    ['api.twitch.tv', 'twitch'],
    ['discord.com', 'discord'],
    ['*.discord.com', 'discord'],
  ]);

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;

    // Mock fetch to capture calls without making real HTTP requests
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      fetchCalls.push({ url, init });
      return new Response('ok', { status: 200 });
    };
  });

  afterEach(() => {
    if (interceptor?.isActive()) {
      interceptor.deactivate();
    }
    globalThis.fetch = originalFetch;
  });

  describe('host matching', () => {
    it('matches exact hostnames', () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });

      expect(interceptor.matchHost('api.telegram.org')).toBe('telegram');
      expect(interceptor.matchHost('slack.com')).toBe('slack');
      expect(interceptor.matchHost('api.twitch.tv')).toBe('twitch');
    });

    it('matches wildcard patterns', () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });

      expect(interceptor.matchHost('files.slack.com')).toBe('slack');
      expect(interceptor.matchHost('cdn.discord.com')).toBe('discord');
      expect(interceptor.matchHost('gateway.discord.com')).toBe('discord');
    });

    it('returns null for unknown hosts', () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });

      expect(interceptor.matchHost('api.example.com')).toBeNull();
      expect(interceptor.matchHost('google.com')).toBeNull();
    });
  });

  describe('fetch interception', () => {
    it('redirects matching requests through the proxy', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.telegram.org/bot123/getUpdates');

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('http://127.0.0.1:8081/telegram/bot123/getUpdates');
    });

    it('passes through non-matching requests unchanged', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.example.com/data');

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('https://api.example.com/data');
    });

    it('does not intercept requests to the proxy itself', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('http://127.0.0.1:8081/anthropic/v1/messages');

      expect(fetchCalls).toHaveLength(1);
      // Should NOT be rewritten — proxy requests pass through as-is
      expect(fetchCalls[0].url).toBe('http://127.0.0.1:8081/anthropic/v1/messages');
    });

    it('preserves query parameters', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.telegram.org/bot123/getUpdates?offset=5&limit=10');

      expect(fetchCalls[0].url).toBe(
        'http://127.0.0.1:8081/telegram/bot123/getUpdates?offset=5&limit=10'
      );
    });

    it('handles wildcard host matching', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://files.slack.com/files-pri/T12345/file.png');

      expect(fetchCalls[0].url).toBe(
        'http://127.0.0.1:8081/slack/files-pri/T12345/file.png'
      );
    });

    it('strips authorization headers from intercepted requests', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.telegram.org/bot123/getUpdates', {
        headers: {
          'Authorization': 'Bearer old-token',
          'Content-Type': 'application/json',
        },
      });

      const passedHeaders = fetchCalls[0].init?.headers as Record<string, string>;
      expect(passedHeaders).toBeDefined();
      expect(passedHeaders['Authorization']).toBeUndefined();
      expect(passedHeaders['Content-Type']).toBe('application/json');
    });

    it('handles URL input types', async () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });
      interceptor.activate();

      // URL object
      await globalThis.fetch(new URL('https://api.telegram.org/bot123/test'));
      expect(fetchCalls[0].url).toBe('http://127.0.0.1:8081/telegram/bot123/test');
    });
  });

  describe('lifecycle', () => {
    it('activate and deactivate correctly', () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });

      expect(interceptor.isActive()).toBe(false);

      interceptor.activate();
      expect(interceptor.isActive()).toBe(true);

      interceptor.deactivate();
      expect(interceptor.isActive()).toBe(false);
    });

    it('restores original fetch on deactivate', async () => {
      const mockFetchBefore = globalThis.fetch;

      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });

      interceptor.activate();
      expect(globalThis.fetch).not.toBe(mockFetchBefore);

      interceptor.deactivate();
      expect(globalThis.fetch).toBe(mockFetchBefore);
    });

    it('is idempotent for activate/deactivate', () => {
      interceptor = createHttpInterceptor({
        proxyBaseUrl: 'http://127.0.0.1:8081',
        hostMap,
      });

      interceptor.activate();
      interceptor.activate(); // Should not throw
      expect(interceptor.isActive()).toBe(true);

      interceptor.deactivate();
      interceptor.deactivate(); // Should not throw
      expect(interceptor.isActive()).toBe(false);
    });
  });
});
