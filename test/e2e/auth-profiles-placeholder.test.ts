/**
 * E2E tests for the auth-profiles placeholder key pattern
 *
 * Verifies that the proxy correctly strips a placeholder key sent by OpenClaw
 * and replaces it with the real credential from the vault backend.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

describe('Auth Profiles Placeholder Pattern', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let socketPath: string;
  let upstreamPort: number;

  const REAL_KEY = 'sk-ant-real-secret-key-12345';
  const PLACEHOLDER_KEY = 'aquaman-proxy-managed';

  beforeEach(async () => {
    // Start mock upstream
    upstream = createMockUpstream();
    await upstream.start(0);
    upstreamPort = upstream.port;

    // Set up credential store with the REAL key
    store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL_KEY);

    // Create service registry pointing to mock upstream
    const registry = createServiceRegistry();
    registry.override('anthropic', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });

    socketPath = tmpSocketPath();

    // Start proxy
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic'],
      onRequest: () => {}
    });

    await proxy.start();
  });

  afterEach(async () => {
    await proxy?.stop();
    await upstream?.stop();
    cleanupSocket(socketPath);
  });

  it('should strip the placeholder key and inject the real key', async () => {
    // Simulate what OpenClaw does: sends request with the placeholder key
    const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PLACEHOLDER_KEY  // OpenClaw sends this from auth-profiles.json
      },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    });

    expect(response.status).toBe(200);

    // Verify upstream got the REAL key, not the placeholder
    const lastReq = upstream.getLastRequest();
    expect(lastReq).toBeDefined();
    expect(lastReq!.headers['x-api-key']).toBe(REAL_KEY);
    expect(lastReq!.headers['x-api-key']).not.toBe(PLACEHOLDER_KEY);
  });

  it('should inject the real key even when no auth header is sent', async () => {
    // Request without any auth header
    const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] })
    });

    expect(response.status).toBe(200);

    const lastReq = upstream.getLastRequest();
    expect(lastReq!.headers['x-api-key']).toBe(REAL_KEY);
  });

  it('should strip any client-provided auth header to prevent override', async () => {
    // Client tries to inject their own key (malicious or accidental)
    const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'sk-ant-attacker-key-trying-to-override'
      },
      body: JSON.stringify({ model: 'test', messages: [] })
    });

    expect(response.status).toBe(200);

    // Upstream should have the vault key, NOT the attacker's key
    const lastReq = upstream.getLastRequest();
    expect(lastReq!.headers['x-api-key']).toBe(REAL_KEY);
    expect(lastReq!.headers['x-api-key']).not.toBe('sk-ant-attacker-key-trying-to-override');
  });

  it('should handle OpenAI-style Bearer token placeholder', async () => {
    const REAL_OPENAI_KEY = 'sk-openai-real-key';
    await store.set('openai', 'api_key', REAL_OPENAI_KEY);

    const registry = createServiceRegistry();
    registry.override('openai', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });

    const openaiSocketPath = tmpSocketPath();

    // Create a separate proxy for OpenAI
    const openaiProxy = createCredentialProxy({
      socketPath: openaiSocketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['openai'],
      onRequest: () => {}
    });
    await openaiProxy.start();

    try {
      const response = await udsFetch(openaiSocketPath, '/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${PLACEHOLDER_KEY}`  // OpenClaw placeholder
        },
        body: JSON.stringify({ model: 'gpt-4', messages: [] })
      });

      expect(response.status).toBe(200);

      const lastReq = upstream.getLastRequest();
      expect(lastReq!.headers['authorization']).toBe(`Bearer ${REAL_OPENAI_KEY}`);
      expect(lastReq!.headers['authorization']).not.toContain(PLACEHOLDER_KEY);
    } finally {
      await openaiProxy.stop();
      cleanupSocket(openaiSocketPath);
    }
  });
});
