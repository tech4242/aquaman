/**
 * Unit tests for actionable error messages in the proxy daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCredentialProxy, createServiceRegistry, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

describe('Actionable error responses', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;

  beforeEach(async () => {
    store = new MemoryStore();
    socketPath = tmpSocketPath();

    const registry = createServiceRegistry();

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic', 'openai'],
    });

    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    store.clear();
    cleanupSocket(socketPath);
  });

  it('401 body includes fix command when credential missing', async () => {
    const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    expect(response.status).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('anthropic');
    expect(body.error).toContain('api_key');
    expect(body.fix).toBe('Run: aquaman credentials add anthropic api_key');
  });

  it('401 body includes correct service and key for openai', async () => {
    const response = await udsFetch(socketPath, '/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toContain('openai');
    expect(body.fix).toContain('aquaman credentials add openai');
  });

  it('401 response has application/json content type', async () => {
    const response = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
    });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toBe('application/json');
  });
});

describe('Service name validation', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;

  beforeEach(async () => {
    store = new MemoryStore();
    socketPath = tmpSocketPath();

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: createServiceRegistry(),
      allowedServices: ['anthropic'],
    });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    store.clear();
    cleanupSocket(socketPath);
  });

  it('rejects path traversal in service name', async () => {
    const res = await udsFetch(socketPath, '/../etc/passwd');
    expect(res.status).toBe(404);
  });

  it('rejects service names with special characters', async () => {
    const res = await udsFetch(socketPath, '/sl@ck/api');
    expect(res.status).toBe(404);
  });

  it('rejects service names with null bytes', async () => {
    const res = await udsFetch(socketPath, '/slack%00evil/api');
    expect(res.status).toBe(404);
  });
});
