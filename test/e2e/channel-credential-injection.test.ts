/**
 * E2E tests for channel credential injection (new auth modes).
 *
 * Tests the new auth modes added to support OpenClaw channel credentials:
 * - URL-path auth (Telegram: /bot<TOKEN>/method)
 * - HTTP Basic auth (Twilio: base64(sid:token))
 * - Additional headers (Twitch: Authorization + Client-Id)
 *
 * Architecture:
 *   Test → Proxy (dynamic port) → Mock Upstream (dynamic port)
 *                ↓
 *        Credential Store (Memory)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from '@aquaman/proxy';
import { MemoryStore } from '@aquaman/core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from '@aquaman/proxy';

describe('Channel Credential Injection E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let proxyPort: number;
  let upstreamPort: number;

  // Test credentials
  const TEST_TELEGRAM_TOKEN = '123456:ABC-DEF-test-token';
  const TEST_TWILIO_SID = 'AC1234567890abcdef';
  const TEST_TWILIO_TOKEN = 'auth-token-test-789';
  const TEST_TWITCH_TOKEN = 'twitch-oauth-token-abc';
  const TEST_TWITCH_CLIENT_ID = 'twitch-client-id-xyz';
  const TEST_ELEVENLABS_KEY = 'el-api-key-test-456';
  const TEST_SLACK_TOKEN = 'xoxb-slack-bot-token-test';
  const TEST_DISCORD_TOKEN = 'discord-bot-token-test-123';
  const TEST_MATRIX_TOKEN = 'syt_matrix_access_token_test';
  const TEST_LINE_TOKEN = 'line-channel-access-token-test';
  const TEST_ZALO_TOKEN = 'zalo-bot-token-test-456';

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);
    upstreamPort = upstream.port;

    store = new MemoryStore();
    await store.set('telegram', 'bot_token', TEST_TELEGRAM_TOKEN);
    await store.set('twilio', 'account_sid', TEST_TWILIO_SID);
    await store.set('twilio', 'auth_token', TEST_TWILIO_TOKEN);
    await store.set('twitch', 'access_token', TEST_TWITCH_TOKEN);
    await store.set('twitch', 'client_id', TEST_TWITCH_CLIENT_ID);
    await store.set('elevenlabs', 'api_key', TEST_ELEVENLABS_KEY);
    await store.set('slack', 'bot_token', TEST_SLACK_TOKEN);
    await store.set('discord', 'bot_token', TEST_DISCORD_TOKEN);
    await store.set('matrix', 'access_token', TEST_MATRIX_TOKEN);
    await store.set('line', 'channel_access_token', TEST_LINE_TOKEN);
    await store.set('zalo', 'bot_token', TEST_ZALO_TOKEN);

    requestLog = [];

    const registry = createServiceRegistry();

    // Override upstreams to point to mock
    registry.override('telegram', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('twilio', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('twitch', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('elevenlabs', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('slack', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('discord', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('matrix', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('line', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('zalo', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });

    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['telegram', 'twilio', 'twitch', 'elevenlabs', 'slack', 'discord', 'matrix', 'line', 'zalo'],
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

  describe('Telegram URL-path auth', () => {
    it('injects bot token into URL path for Telegram requests', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/telegram/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: 0, timeout: 10 })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      // Token should be in the URL path: /bot<TOKEN>/getUpdates
      expect(lastRequest!.path).toBe(`/bot${TEST_TELEGRAM_TOKEN}/getUpdates`);
      // No Authorization header should be set
      expect(lastRequest!.headers['authorization']).toBeUndefined();
    });

    it('handles nested paths for Telegram file downloads', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/telegram/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: 123, text: 'test' })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.path).toBe(`/bot${TEST_TELEGRAM_TOKEN}/sendMessage`);
    });

    it('returns 401 when telegram bot_token is missing', async () => {
      store.clear();

      const response = await fetch(`http://127.0.0.1:${proxyPort}/telegram/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Twilio HTTP Basic auth', () => {
    it('injects Basic auth header with encoded credentials', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/twilio/2010-04-01/Accounts`, {
        method: 'GET'
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();

      // Verify Basic auth header
      const expectedBasic = Buffer.from(`${TEST_TWILIO_SID}:${TEST_TWILIO_TOKEN}`).toString('base64');
      expect(lastRequest!.headers['authorization']).toBe(`Basic ${expectedBasic}`);

      // Verify path was correctly forwarded
      expect(lastRequest!.path).toBe('/2010-04-01/Accounts');
    });
  });

  describe('Twitch additional headers', () => {
    it('injects both Authorization and Client-Id headers', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/twitch/helix/users`, {
        method: 'GET'
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();

      // Verify Bearer token
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_TWITCH_TOKEN}`);

      // Verify Client-Id header
      expect(lastRequest!.headers['client-id']).toBe(TEST_TWITCH_CLIENT_ID);
    });
  });

  describe('ElevenLabs custom header auth', () => {
    it('injects xi-api-key header', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/elevenlabs/v1/text-to-speech/voice-id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', model_id: 'eleven_monolingual_v1' })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['xi-api-key']).toBe(TEST_ELEVENLABS_KEY);
    });
  });

  describe('Slack header auth', () => {
    it('injects Bearer token for Slack requests', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/slack/chat.postMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: '#test', text: 'hello' })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_SLACK_TOKEN}`);
    });
  });

  describe('Discord header auth', () => {
    it('injects Bot-prefixed token for Discord requests', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/discord/channels/123/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hello' })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      // Discord uses "Bot " prefix, not "Bearer "
      expect(lastRequest!.headers['authorization']).toBe(`Bot ${TEST_DISCORD_TOKEN}`);
    });
  });

  describe('Matrix header auth', () => {
    it('injects Bearer token for Matrix requests', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/matrix/_matrix/client/v3/rooms/!abc:matrix.org/send/m.room.message`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'm.text', body: 'hello' })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_MATRIX_TOKEN}`);
    });
  });

  describe('LINE header auth', () => {
    it('injects Bearer token for LINE requests', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/line/v2/bot/message/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: 'U123', messages: [{ type: 'text', text: 'hello' }] })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_LINE_TOKEN}`);
    });
  });

  describe('Zalo custom header auth', () => {
    it('injects access_token header without prefix for Zalo requests', async () => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/zalo/v3.0/oa/message/cs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { user_id: '123' }, message: { text: 'hello' } })
      });

      expect(response.ok).toBe(true);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      // Zalo uses custom header 'access_token' with no prefix
      expect(lastRequest!.headers['access_token']).toBe(TEST_ZALO_TOKEN);
    });
  });

  describe('Auth mode: none', () => {
    it('returns 400 for at-rest-only services', async () => {
      // nostr is authMode: 'none', but we need to add it to allowedServices
      // Create a new proxy that allows nostr
      await proxy.stop();

      const registry2 = createServiceRegistry();
      const proxy2 = createCredentialProxy({
        port: 0,
        store,
        serviceRegistry: registry2,
        allowedServices: ['nostr'],
      });
      await proxy2.start();

      const response = await fetch(`http://127.0.0.1:${proxy2.getPort()}/nostr/relay`, {
        method: 'GET'
      });

      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).toContain('at-rest storage only');

      await proxy2.stop();
    });
  });

  describe('Request logging', () => {
    it('logs channel requests in audit trail', async () => {
      await fetch(`http://127.0.0.1:${proxyPort}/telegram/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      expect(requestLog.length).toBeGreaterThan(0);
      const lastLog = requestLog[requestLog.length - 1];
      expect(lastLog.service).toBe('telegram');
      expect(lastLog.authenticated).toBe(true);
    });
  });
});
