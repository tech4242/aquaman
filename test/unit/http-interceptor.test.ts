/**
 * Unit tests for the HTTP interceptor.
 *
 * Tests that globalThis.fetch is correctly overridden to redirect
 * channel API traffic through the aquaman credential proxy via UDS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpInterceptor, createHttpInterceptor } from '../../packages/plugin/src/http-interceptor.js';

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

  const testSocketPath = '/tmp/aquaman-test/proxy.sock';

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
        socketPath: testSocketPath,
        hostMap,
      });

      expect(interceptor.matchHost('api.telegram.org')).toBe('telegram');
      expect(interceptor.matchHost('slack.com')).toBe('slack');
      expect(interceptor.matchHost('api.twitch.tv')).toBe('twitch');
    });

    it('matches wildcard patterns', () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });

      expect(interceptor.matchHost('files.slack.com')).toBe('slack');
      expect(interceptor.matchHost('cdn.discord.com')).toBe('discord');
      expect(interceptor.matchHost('gateway.discord.com')).toBe('discord');
    });

    it('returns null for unknown hosts', () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });

      expect(interceptor.matchHost('api.example.com')).toBeNull();
      expect(interceptor.matchHost('google.com')).toBeNull();
    });
  });

  describe('fetch interception', () => {
    it('redirects matching requests through the proxy via sentinel hostname', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.telegram.org/bot123/getUpdates');

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('http://aquaman.local/telegram/bot123/getUpdates');
    });

    it('passes through non-matching requests unchanged', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.example.com/data');

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('https://api.example.com/data');
    });

    it('routes SDK traffic (aquaman.local) through UDS dispatcher', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('http://aquaman.local/anthropic/v1/messages');

      expect(fetchCalls).toHaveLength(1);
      // Should pass through as-is (URL unchanged), dispatcher handles UDS routing
      expect(fetchCalls[0].url).toBe('http://aquaman.local/anthropic/v1/messages');
      // Should have dispatcher in init
      expect(fetchCalls[0].init).toHaveProperty('dispatcher');
    });

    it('preserves query parameters', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.telegram.org/bot123/getUpdates?offset=5&limit=10');

      expect(fetchCalls[0].url).toBe(
        'http://aquaman.local/telegram/bot123/getUpdates?offset=5&limit=10'
      );
    });

    it('handles wildcard host matching', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://files.slack.com/files-pri/T12345/file.png');

      expect(fetchCalls[0].url).toBe(
        'http://aquaman.local/slack/files-pri/T12345/file.png'
      );
    });

    it('strips authorization headers from intercepted requests', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
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
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      // URL object
      await globalThis.fetch(new URL('https://api.telegram.org/bot123/test'));
      expect(fetchCalls[0].url).toBe('http://aquaman.local/telegram/bot123/test');
    });
  });

  describe('redirect handling', () => {
    it('uses redirect: manual to prevent auto-following redirects on intercepted requests', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.telegram.org/bot123/getUpdates');

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].init?.redirect).toBe('manual');
    });

    it('does not set redirect: manual on non-intercepted requests', async () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
        hostMap,
      });
      interceptor.activate();

      await globalThis.fetch('https://api.example.com/data');

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].init?.redirect).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    it('activate and deactivate correctly', () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
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
        socketPath: testSocketPath,
        hostMap,
      });

      interceptor.activate();
      expect(globalThis.fetch).not.toBe(mockFetchBefore);

      interceptor.deactivate();
      expect(globalThis.fetch).toBe(mockFetchBefore);
    });

    it('is idempotent for activate/deactivate', () => {
      interceptor = createHttpInterceptor({
        socketPath: testSocketPath,
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
