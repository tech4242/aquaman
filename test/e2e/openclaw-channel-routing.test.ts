/**
 * E2E tests for channel egress routing over the loopback listener (v0.15.0+).
 *
 * OpenClaw 2026.7.33+ builds a per-channel undici dispatcher, so the plugin's
 * `globalThis.fetch` interceptor never sees channel traffic. Telegram is the
 * one channel with a user-settable endpoint override (`channels.telegram.apiRoot`),
 * so it is pointed at the loopback listener instead.
 *
 * That shape has no auth header at all: the Bot API carries the token as the
 * `/bot<TOKEN>` path segment. So the loopback token arrives in that segment,
 * and the proxy has to accept it there, strip it, and put the real bot token
 * back in the same position.
 *
 * Architecture:
 *   Test -> Proxy (loopback TCP, token-gated) -> Mock Upstream
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_channel_e2e_token_0123456789';
const REAL_BOT_TOKEN = '987654:REAL-telegram-bot-token';
const REAL_SLACK_TOKEN = 'xoxb-real-slack-token';

describe('OpenClaw channel routing over loopback E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;
  let baseUrl: string;

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);

    store = new MemoryStore();
    await store.set('telegram', 'bot_token', REAL_BOT_TOKEN);
    await store.set('slack', 'bot_token', REAL_SLACK_TOKEN);

    requestLog = [];
    socketPath = tmpSocketPath();

    const registry = createServiceRegistry();
    registry.override('telegram', { upstream: `http://127.0.0.1:${upstream.port}` });
    registry.override('slack', { upstream: `http://127.0.0.1:${upstream.port}` });

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['telegram', 'slack'],
      loopback: { port: 0, token: TOKEN, host: '127.0.0.1' },
      onRequest: info => requestLog.push(info)
    });

    await proxy.start();
    baseUrl = `http://${proxy.getLoopbackAddress()}`;
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    store.clear();
    cleanupSocket(socketPath);
  });

  describe('token gating for url-path services', () => {
    it('accepts the loopback token from the bot path segment', async () => {
      const response = await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);

      expect(response.status).toBe(200);
      expect(upstream.getLastRequest()!.path).toBe(`/bot${REAL_BOT_TOKEN}/getMe`);
    });

    it('rejects a wrong token in the bot path segment (401)', async () => {
      const response = await fetch(`${baseUrl}/telegram/botwrong-token/getMe`);

      expect(response.status).toBe(401);
      expect(upstream.getLastRequest()).toBeUndefined();
    });

    it('rejects a request with no bot segment and no header (401)', async () => {
      const response = await fetch(`${baseUrl}/telegram/getMe`);

      expect(response.status).toBe(401);
      expect(upstream.getLastRequest()).toBeUndefined();
    });

    it('accepts the token in the file-download segment position', async () => {
      const response = await fetch(`${baseUrl}/telegram/file/bot${TOKEN}/photos/f.jpg`);

      expect(response.status).toBe(200);
      expect(upstream.getLastRequest()!.path).toBe(
        `/file/bot${REAL_BOT_TOKEN}/photos/f.jpg`
      );
    });

    it('does not let a path segment stand in for a header token on other services', async () => {
      const response = await fetch(`${baseUrl}/slack/bot${TOKEN}/api/chat.postMessage`, {
        method: 'POST'
      });

      expect(response.status).toBe(401);
      expect(upstream.getLastRequest()).toBeUndefined();
    });
  });

  describe('credential isolation', () => {
    it('never sends the loopback token upstream', async () => {
      await fetch(`${baseUrl}/telegram/bot${TOKEN}/sendMessage`, { method: 'POST' });

      const forwarded = upstream.getLastRequest()!;
      expect(forwarded.path).not.toContain(TOKEN);
      expect(JSON.stringify(forwarded.headers)).not.toContain(TOKEN);
    });

    it('never returns the real bot token to the caller', async () => {
      const response = await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);
      const body = await response.text();

      expect(body).not.toContain(REAL_BOT_TOKEN);
    });

    it('keeps the presented token out of the request log', async () => {
      await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);

      const logged = requestLog.at(-1)!;
      expect(logged.path).toBe('/telegram/getMe');
      expect(logged.service).toBe('telegram');
      expect(logged.authenticated).toBe(true);
    });
  });

  describe('long-poll timeout floor', () => {
    it('declares a floor above the Bot API long-poll window', () => {
      // getUpdates holds a poll for 30s and the client aborts at 45s; media
      // downloads allow 120s to first byte. The proxy's 30s default idle
      // timeout would cut polls short, so telegram raises the floor.
      const def = createServiceRegistry().get('telegram')!;
      expect(def.minRequestTimeout).toBeGreaterThan(45_000);
    });

    it('keeps a slow upstream alive when the floor exceeds the global timeout', async () => {
      await proxy.stop();

      const registry = createServiceRegistry();
      registry.override('telegram', {
        upstream: `http://127.0.0.1:${upstream.port}`,
        minRequestTimeout: 2_000
      });
      const slowSocket = tmpSocketPath();
      const slowProxy = createCredentialProxy({
        socketPath: slowSocket,
        store,
        serviceRegistry: registry,
        allowedServices: ['telegram'],
        requestTimeout: 100
      });
      await slowProxy.start();
      upstream.setResponseDelay(400);

      const response = await udsFetch(slowSocket, '/telegram/getUpdates', { method: 'POST' });

      // Without the floor the 100ms global timeout would make this a 504.
      expect(response.status).toBe(200);

      upstream.setResponseDelay(0);
      await slowProxy.stop();
      cleanupSocket(slowSocket);
    });
  });

  describe('UDS path is unchanged', () => {
    it('still serves telegram over the socket without any token', async () => {
      const response = await udsFetch(socketPath, '/telegram/getMe', { method: 'GET' });

      expect(response.status).toBe(200);
      expect(upstream.getLastRequest()!.path).toBe(`/bot${REAL_BOT_TOKEN}/getMe`);
    });
  });
});
