/**
 * E2E tests for LLM/AI provider credential injection.
 *
 * Tests header auth injection for AI providers beyond the core three
 * (Anthropic, OpenAI, GitHub — tested in credential-injection.test.ts).
 *
 * Architecture:
 *   Test -> Proxy (UDS) -> Mock Upstream (dynamic port)
 *                |
 *        Credential Store (Memory)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from 'aquaman-proxy';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

describe('Provider Credential Injection E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;
  let upstreamPort: number;

  // Test credentials
  const TEST_XAI_KEY = 'xai-api-key-test-789';
  const TEST_CLOUDFLARE_AI_TOKEN = 'cf-ai-api-token-test-012';
  const TEST_MISTRAL_KEY = 'mistral-api-key-test-345';
  const TEST_HUGGINGFACE_KEY = 'hf-api-key-test-678';
  const TEST_ELEVENLABS_KEY = 'el-api-key-test-456';

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);
    upstreamPort = upstream.port;

    store = new MemoryStore();
    await store.set('xai', 'api_key', TEST_XAI_KEY);
    await store.set('cloudflare-ai', 'api_token', TEST_CLOUDFLARE_AI_TOKEN);
    await store.set('mistral', 'api_key', TEST_MISTRAL_KEY);
    await store.set('huggingface', 'api_key', TEST_HUGGINGFACE_KEY);
    await store.set('elevenlabs', 'api_key', TEST_ELEVENLABS_KEY);

    requestLog = [];
    socketPath = tmpSocketPath();

    const registry = createServiceRegistry();

    // Override upstreams to point to mock
    registry.override('xai', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('cloudflare-ai', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('mistral', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('huggingface', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });
    registry.override('elevenlabs', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['xai', 'cloudflare-ai', 'mistral', 'huggingface', 'elevenlabs'],
      onRequest: (info) => {
        requestLog.push(info);
      }
    });

    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    store.clear();
    cleanupSocket(socketPath);
  });

  describe('xAI header auth', () => {
    it('injects Bearer token for xAI Grok requests', async () => {
      const response = await udsFetch(socketPath, '/xai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'grok-3', messages: [{ role: 'user', content: 'hi' }] })
      });

      expect(response.status).toBe(200);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_XAI_KEY}`);
      expect(lastRequest!.path).toBe('/v1/chat/completions');
    });
  });

  describe('Cloudflare AI Gateway header auth', () => {
    it('injects cf-aig-authorization header for Cloudflare AI Gateway requests', async () => {
      const response = await udsFetch(socketPath, '/cloudflare-ai/v1/account-id/gateway-id/anthropic/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] })
      });

      expect(response.status).toBe(200);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['cf-aig-authorization']).toBe(`Bearer ${TEST_CLOUDFLARE_AI_TOKEN}`);
      expect(lastRequest!.path).toBe('/v1/account-id/gateway-id/anthropic/v1/messages');
    });
  });

  describe('Mistral header auth', () => {
    it('injects Bearer token for Mistral requests', async () => {
      const response = await udsFetch(socketPath, '/mistral/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mistral-large-latest', messages: [{ role: 'user', content: 'hi' }] })
      });

      expect(response.status).toBe(200);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_MISTRAL_KEY}`);
      expect(lastRequest!.path).toBe('/v1/chat/completions');
    });
  });

  describe('Hugging Face header auth', () => {
    it('injects Bearer token for Hugging Face Inference requests', async () => {
      const response = await udsFetch(socketPath, '/huggingface/models/meta-llama/Llama-3-8B/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
      });

      expect(response.status).toBe(200);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['authorization']).toBe(`Bearer ${TEST_HUGGINGFACE_KEY}`);
      expect(lastRequest!.path).toBe('/models/meta-llama/Llama-3-8B/v1/chat/completions');
    });
  });

  describe('ElevenLabs custom header auth', () => {
    it('injects xi-api-key header', async () => {
      const response = await udsFetch(socketPath, '/elevenlabs/v1/text-to-speech/voice-id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello', model_id: 'eleven_monolingual_v1' })
      });

      expect(response.status).toBe(200);

      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['xi-api-key']).toBe(TEST_ELEVENLABS_KEY);
    });
  });
});
