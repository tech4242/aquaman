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
 *   - (v0.15.0) serves the broker only for declared refs, and never the
 *     LLM-provider tier over loopback
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry, createBrokerScope, HERMES_SUPPORTED_SERVICES } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_e2e_test_token_0123456789abcdef';
const REAL_ANTHROPIC_KEY = 'sk-ant-real-key';
const REAL_OPENAI_KEY = 'sk-openai-real-key';
const NPM_TOKEN = 'npm_hermes_e2e_project_secret';

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
    await store.set('npm', 'token', NPM_TOKEN);

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
      // The daemon's real scope shape: declared refs + the Hermes LLM tier
      // denied over loopback. anthropic/api_key is declared on purpose, to
      // prove the loopback denial wins over a declaration.
      broker: createBrokerScope({
        projectsPath: '/nonexistent/aquaman-test/projects.yaml',
        allowedRefs: ['aquaman://npm/token', 'aquaman://github/token', 'aquaman://anthropic/api_key'],
        loopbackDeniedServices: HERMES_SUPPORTED_SERVICES,
      }),
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
      const last = upstream.getLastRequest();
      expect(last!.headers['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
      // The loopback access token must never reach the upstream provider.
      expect(last!.headers['x-aquaman-token']).toBeUndefined();
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

  describe('broker over loopback (Hermes secret source, v0.14.0+; scoped v0.15.0+)', () => {
    const resolve = (body: object, headers: Record<string, string> = { 'x-aquaman-token': TOKEN }) =>
      fetch(`${baseUrl}/broker/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    it('resolves a declared project secret with the token', async () => {
      const res = await resolve({ service: 'npm', key: 'token' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.value).toBe(NPM_TOKEN);
      expect(body.expires_at).toBeDefined();
    });

    it('rejects broker resolution without the token (401)', async () => {
      const res = await resolve({ service: 'npm', key: 'token' }, {});
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toContain('token');
    });

    it('never materializes the LLM-provider tier over loopback, even when declared', async () => {
      for (const service of ['anthropic', 'openai']) {
        const res = await resolve({ service, key: 'api_key' });
        expect(res.status).toBe(404);
        const text = await res.text();
        expect(JSON.parse(text).code).toBe('broker_ref_isolated');
        expect(text).not.toContain(REAL_ANTHROPIC_KEY);
        expect(text).not.toContain(REAL_OPENAI_KEY);
      }
    });

    it('refuses undeclared refs without consulting the vault', async () => {
      const res = await resolve({ service: 'slack', key: 'bot_token' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe('broker_ref_not_declared');
      expect(body.fix).toContain('aquaman broker allow aquaman://slack/bot_token');
    });

    it('returns 404 with an actionable fix for a declared but missing credential', async () => {
      const res = await resolve({ service: 'github', key: 'token' });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.fix).toContain('aquaman credentials add github token');
    });

    it('audits loopback broker resolves — and refusals — like UDS ones', async () => {
      requestLog.length = 0;
      await resolve({ service: 'npm', key: 'token' });
      await resolve({ service: 'anthropic', key: 'api_key' });
      const brokerEvents = requestLog.filter((r) => r.method === 'BROKER');
      expect(brokerEvents).toHaveLength(2);
      expect(brokerEvents[0]).toMatchObject({ service: 'npm', statusCode: 200, authenticated: true });
      expect(brokerEvents[1]).toMatchObject({ service: 'anthropic', statusCode: 404, authenticated: false });
      expect(brokerEvents[1].error).toContain('broker_ref_isolated');
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
