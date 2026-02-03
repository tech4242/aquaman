/**
 * Integration tests for TLS-enabled credential proxy
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import { CredentialProxy, createCredentialProxy } from '../../src/credentials/proxy-daemon.js';
import { MemoryStore } from '../../src/credentials/store.js';
import { generateSelfSignedCert } from '../../src/utils/hash.js';
import { createServiceRegistry } from '../../src/credentials/service-registry.js';

describe('TLS Credential Proxy Integration', () => {
  let tempDir: string;
  let certPath: string;
  let keyPath: string;
  let proxy: CredentialProxy;
  let store: MemoryStore;
  const PORT = 18999;

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
        port: PORT,
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
        port: PORT,
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
          port: PORT,
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
        port: PORT,
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
      expect(baseUrl).toContain(`:${PORT}`);
    });
  });

  describe('HTTP Fallback', () => {
    it('falls back to HTTP when TLS disabled', async () => {
      proxy = createCredentialProxy({
        port: PORT,
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
        port: PORT,
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
        port: PORT,
        bindAddress: '127.0.0.1',
        store,
        allowedServices: ['anthropic'],
        serviceRegistry: createServiceRegistry()
      });

      await proxy.start();

      const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
        const req = http.request({
          hostname: '127.0.0.1',
          port: PORT,
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
        port: PORT,
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
});
