/**
 * End-to-end tests for the opt-in loopback TCP listener (Hermes path, v0.13.0+)
 *
 * Verifies the listener:
 *   - injects real credentials and forwards to upstream (just like UDS)
 *   - rejects requests that don't present the loopback token (401)
 *   - accepts the token via x-api-key / Authorization Bearer / x-aquaman-token
 *   - maps the Hermes base-URL conventions (/anthropic + /openai/v1) correctly
 *   - exempts /_health from token gating
 *   - leaves the UDS listener token-free (unchanged behavior)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_e2e_test_token_0123456789abcdef';
const REAL_ANTHROPIC_KEY = 'sk-ant-real-key';
const REAL_OPENAI_KEY = 'sk-openai-real-key';

describe('Loopback listener E2E (Hermes path)', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;
  let baseUrl: string;

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);
    const upstreamPort = upstream.port;

    store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL_ANTHROPIC_KEY);
    await store.set('openai', 'api_key', REAL_OPENAI_KEY);

    requestLog = [];
    socketPath = tmpSocketPath();

    const registry = createServiceRegistry();
    registry.override('anthropic', { upstream: `http://127.0.0.1:${upstreamPort}` });
    registry.override('openai', { upstream: `http://127.0.0.1:${upstreamPort}` });

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic', 'openai'],
      loopback: { port: 0, token: TOKEN, host: '127.0.0.1' },
      onRequest: (info) => { requestLog.push(info); },
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

  describe('lifecycle', () => {
    it('reports a loopback address when enabled', () => {
      expect(proxy.getLoopbackAddress()).toMatch(/^127\.0\.0\.1:\d+$/);
    });

    it('exempts /_health from token gating', async () => {
      const res = await fetch(`${baseUrl}/_health`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });
  });

  describe('token gating', () => {
    it('rejects a request with no token (401)', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('rejects a request with a wrong token (401)', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'not-the-token' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('accepts the token via x-api-key (Anthropic shape)', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(200);
      const last = upstream.getLastRequest();
      // Placeholder token stripped, real key injected:
      expect(last!.headers['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
      expect(last!.path).toBe('/v1/messages');
    });

    it('accepts the token via Authorization: Bearer (OpenAI shape)', async () => {
      const res = await fetch(`${baseUrl}/openai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
        body: JSON.stringify({ model: 'gpt-4', messages: [] }),
      });
      expect(res.status).toBe(200);
      const last = upstream.getLastRequest();
      // Real key injected with Bearer prefix; no double /v1:
      expect(last!.headers['authorization']).toBe(`Bearer ${REAL_OPENAI_KEY}`);
      expect(last!.path).toBe('/v1/chat/completions');
    });

    it('accepts the token via explicit x-aquaman-token header', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstream.getLastRequest()!.headers['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
    });
  });

  describe('credential isolation', () => {
    it('never leaks the real key back to the client', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.headers.get('x-api-key')).toBeNull();
      const text = await res.text();
      expect(text).not.toContain(REAL_ANTHROPIC_KEY);
    });
  });

  describe('UDS listener stays token-free', () => {
    it('serves UDS requests without a loopback token', async () => {
      const res = await udsFetch(socketPath, '/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstream.getLastRequest()!.headers['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
    });
  });
});

describe('Loopback listener disabled by default', () => {
  it('does not expose a loopback address when no loopback config is given', async () => {
    const store = new MemoryStore();
    const socketPath = tmpSocketPath();
    const proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic'],
    });
    await proxy.start();
    try {
      expect(proxy.getLoopbackAddress()).toBeNull();
    } finally {
      await proxy.stop();
      cleanupSocket(socketPath);
    }
  });
});
