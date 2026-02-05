/**
 * Integration tests for TLS-enabled credential proxy
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore, generateSelfSignedCert } from 'aquaman-core';
import { createMockUpstream, MockUpstream } from '../helpers/mock-upstream.js';

describe('TLS Credential Proxy Integration', () => {
  let tempDir: string;
  let certPath: string;
  let keyPath: string;
  let proxy: CredentialProxy;
  let store: MemoryStore;

  beforeAll(() => {
    // Create temp directory for certs
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-tls-test-'));
    certPath = path.join(tempDir, 'proxy.crt');
    keyPath = path.join(tempDir, 'proxy.key');

    // Generate self-signed cert
    const { cert, key } = generateSelfSignedCert('localhost', 1);
    fs.writeFileSync(certPath, cert);
    fs.writeFileSync(keyPath, key);
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) {
      await proxy.stop();
    }
  });

  describe('HTTPS Server', () => {
    it('starts with TLS when certs provided', async () => {
      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();

      expect(proxy.isRunning()).toBe(true);
      expect(proxy.isTlsEnabled()).toBe(true);
    });

    it('responds to HTTPS requests', async () => {
      await store.set('anthropic', 'api_key', 'test-key');

      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        serviceRegistry: createServiceRegistry(),
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();

      // Make HTTPS request (accepting self-signed cert)
      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: proxy.getPort(),
          path: '/anthropic/v1/test',
          method: 'GET',
          rejectUnauthorized: false // Accept self-signed cert
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
        });

        req.on('error', reject);
        req.end();
      });

      // We expect some response (might be upstream error, but proves HTTPS works)
      expect(response.statusCode).toBeDefined();
    });

    it('getBaseUrl returns https:// when TLS enabled', async () => {
      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();

      const baseUrl = proxy.getBaseUrl('anthropic');
      expect(baseUrl).toMatch(/^https:\/\//);
      expect(baseUrl).toContain(`:${proxy.getPort()}`);
    });
  });

  describe('HTTP Fallback', () => {
    it('falls back to HTTP when TLS disabled', async () => {
      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        tls: {
          enabled: false
        }
      });

      await proxy.start();

      expect(proxy.isRunning()).toBe(true);
      expect(proxy.isTlsEnabled()).toBe(false);
    });

    it('falls back to HTTP when certs missing', async () => {
      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath: '/nonexistent/cert.pem',
          keyPath: '/nonexistent/key.pem'
        }
      });

      await proxy.start();

      expect(proxy.isRunning()).toBe(true);
      expect(proxy.isTlsEnabled()).toBe(false);
    });

    it('responds to HTTP requests when TLS disabled', async () => {
      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        serviceRegistry: createServiceRegistry()
      });

      await proxy.start();

      const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: proxy.getPort(),
          path: '/anthropic/v1/test',
          method: 'GET'
        }, (res) => {
          resolve({ statusCode: res.statusCode! });
          res.resume();
        });

        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBeDefined();
    });

    it('getBaseUrl returns http:// when TLS disabled', async () => {
      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic']
      });

      await proxy.start();

      const baseUrl = proxy.getBaseUrl('anthropic');
      expect(baseUrl).toMatch(/^http:\/\//);
    });
  });

  describe('Static getBaseUrl', () => {
    it('returns http:// by default', () => {
      const url = CredentialProxy.getBaseUrl('anthropic', 8081);
      expect(url).toBe('http://127.0.0.1:8081/anthropic');
    });

    it('returns https:// when useTls is true', () => {
      const url = CredentialProxy.getBaseUrl('anthropic', 8081, true);
      expect(url).toBe('https://127.0.0.1:8081/anthropic');
    });
  });

  describe('TLS + Credential Injection Combined', () => {
    let upstream: MockUpstream;
    const TEST_API_KEY = 'sk-ant-tls-test-key-123';

    beforeEach(async () => {
      upstream = createMockUpstream();
      await upstream.start(0);

      await store.set('anthropic', 'api_key', TEST_API_KEY);
    });

    afterEach(async () => {
      if (upstream) {
        await upstream.stop();
      }
    });

    it('injects credentials correctly when proxy uses TLS', async () => {
      // Create service registry pointing to mock upstream
      const registry = createServiceRegistry();
      registry.override('anthropic', {
        upstream: `http://127.0.0.1:${upstream.port}`
      });

      proxy = createCredentialProxy({
        port: 0, // Dynamic port
        bindAddress: '127.0.0.1',
        store,
        serviceRegistry: registry,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();
      expect(proxy.isTlsEnabled()).toBe(true);

      // Make HTTPS request through TLS-enabled proxy
      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: proxy.getPort(),
          path: '/anthropic/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          rejectUnauthorized: false
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode!, body }));
        });

        req.on('error', reject);
        req.write(JSON.stringify({ model: 'claude-3', messages: [] }));
        req.end();
      });

      expect(response.statusCode).toBe(200);

      // Verify credential was injected to upstream
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest).toBeDefined();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_API_KEY);
      expect(lastRequest!.path).toBe('/v1/messages');
    });

    it('strips client-provided auth header over TLS', async () => {
      const registry = createServiceRegistry();
      registry.override('anthropic', {
        upstream: `http://127.0.0.1:${upstream.port}`
      });

      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        serviceRegistry: registry,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();

      // Make request with fake auth header
      await new Promise<void>((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: proxy.getPort(),
          path: '/anthropic/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'fake-client-key'
          },
          rejectUnauthorized: false
        }, (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        });

        req.on('error', reject);
        req.write(JSON.stringify({}));
        req.end();
      });

      // Verify stored credential was used, not client-provided
      const lastRequest = upstream.getLastRequest();
      expect(lastRequest!.headers['x-api-key']).toBe(TEST_API_KEY);
      expect(lastRequest!.headers['x-api-key']).not.toBe('fake-client-key');
    });

    it('returns 401 when credential missing over TLS', async () => {
      await store.delete('anthropic', 'api_key');

      const registry = createServiceRegistry();
      registry.override('anthropic', {
        upstream: `http://127.0.0.1:${upstream.port}`
      });

      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        serviceRegistry: registry,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();

      const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: proxy.getPort(),
          path: '/anthropic/v1/messages',
          method: 'POST',
          rejectUnauthorized: false
        }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve({ statusCode: res.statusCode! }));
        });

        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('forwards streaming response over TLS', async () => {
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_delta\ndata: {"delta":{"text":"Hello TLS"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ];

      upstream.setStreamingResponse({
        statusCode: 200,
        chunks: sseChunks,
        delayMs: 10
      });

      const registry = createServiceRegistry();
      registry.override('anthropic', {
        upstream: `http://127.0.0.1:${upstream.port}`
      });

      proxy = createCredentialProxy({
        port: 0,
        bindAddress: '127.0.0.1',
        store,
        serviceRegistry: registry,
        allowedServices: ['anthropic'],
        tls: {
          enabled: true,
          certPath,
          keyPath
        }
      });

      await proxy.start();

      const response = await new Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = https.request({
          hostname: '127.0.0.1',
          port: proxy.getPort(),
          path: '/anthropic/v1/messages',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          rejectUnauthorized: false
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode!, body, headers: res.headers }));
        });

        req.on('error', reject);
        req.write(JSON.stringify({ stream: true }));
        req.end();
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.body).toContain('Hello TLS');
      expect(response.body).toContain('message_stop');

      // Verify credential was injected
      expect(upstream.getLastRequest()!.headers['x-api-key']).toBe(TEST_API_KEY);
    });
  });
});
