/**
 * Unit tests for actionable error messages in the proxy daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCredentialProxy, createServiceRegistry, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';

describe('Actionable error responses', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let proxyPort: number;

  beforeEach(async () => {
    store = new MemoryStore();

    const registry = createServiceRegistry();

    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic', 'openai'],
    });

    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
    store.clear();
  });

  it('401 body includes fix command when credential missing', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain('anthropic');
    expect(body.error).toContain('api_key');
    expect(body.fix).toBe('Run: aquaman credentials add anthropic api_key');
  });

  it('401 body includes correct service and key for openai', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toContain('openai');
    expect(body.fix).toContain('aquaman credentials add openai');
  });

  it('401 response has application/json content type', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
  });
});
