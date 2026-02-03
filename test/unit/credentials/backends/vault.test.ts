/**
 * Tests for HashiCorp Vault credential backend
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fetch for Vault API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('VaultStore', () => {
  const VAULT_ADDR = 'https://vault.example.com:8200';
  const VAULT_TOKEN = 'hvs.test-token-123456';

  beforeEach(() => {
    vi.resetAllMocks();
    // Clear env vars
    delete process.env['VAULT_TOKEN'];
    delete process.env['VAULT_ADDR'];
    delete process.env['VAULT_NAMESPACE'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws if no token provided', async () => {
      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');

      expect(() => new VaultStore({ address: VAULT_ADDR })).toThrow('Vault token required');
    });

    it('uses VAULT_TOKEN env var if not provided in options', async () => {
      process.env['VAULT_TOKEN'] = VAULT_TOKEN;

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR });

      expect(store.getAddress()).toBe(VAULT_ADDR);
    });

    it('removes trailing slash from address', async () => {
      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({
        address: 'https://vault.example.com:8200/',
        token: VAULT_TOKEN
      });

      expect(store.getAddress()).toBe('https://vault.example.com:8200');
    });

    it('uses default mount path of "secret"', async () => {
      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({
        address: VAULT_ADDR,
        token: VAULT_TOKEN
      });

      expect(store.getMountPath()).toBe('secret');
    });

    it('accepts custom mount path', async () => {
      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({
        address: VAULT_ADDR,
        token: VAULT_TOKEN,
        mountPath: 'kv'
      });

      expect(store.getMountPath()).toBe('kv');
    });
  });

  describe('get', () => {
    it('retrieves secret from KV v2', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            data: {
              credential: 'my-secret-value'
            }
          }
        })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const value = await store.get('anthropic', 'api_key');

      expect(value).toBe('my-secret-value');
      expect(mockFetch).toHaveBeenCalledWith(
        `${VAULT_ADDR}/v1/secret/data/aquaman/anthropic/api_key`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            'X-Vault-Token': VAULT_TOKEN
          })
        })
      );
    });

    it('returns null for 404 (missing secrets)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const value = await store.get('nonexistent', 'key');
      expect(value).toBeNull();
    });

    it('includes namespace header when configured', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { data: { credential: 'value' } }
        })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({
        address: VAULT_ADDR,
        token: VAULT_TOKEN,
        namespace: 'my-namespace'
      });

      await store.get('service', 'key');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Vault-Namespace': 'my-namespace'
          })
        })
      );
    });
  });

  describe('set', () => {
    it('stores secret at correct path', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: {} })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      await store.set('anthropic', 'api_key', 'sk-ant-secret');

      expect(mockFetch).toHaveBeenCalledWith(
        `${VAULT_ADDR}/v1/secret/data/aquaman/anthropic/api_key`,
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sk-ant-secret')
        })
      );
    });

    it('stores credential with correct structure', async () => {
      let capturedBody: string = '';

      mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
        capturedBody = options.body as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: {} })
        };
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      await store.set('service', 'key', 'my-value');

      const parsed = JSON.parse(capturedBody);
      expect(parsed.data.credential).toBe('my-value');
    });

    it('includes metadata in stored data', async () => {
      let capturedBody: string = '';

      mockFetch.mockImplementation(async (url: string, options: RequestInit) => {
        capturedBody = options.body as string;
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: {} })
        };
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      await store.set('service', 'key', 'value', { env: 'prod', team: 'platform' });

      const parsed = JSON.parse(capturedBody);
      expect(parsed.data.meta_env).toBe('prod');
      expect(parsed.data.meta_team).toBe('platform');
    });
  });

  describe('delete', () => {
    it('deletes secret metadata', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const result = await store.delete('anthropic', 'api_key');

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        `${VAULT_ADDR}/v1/secret/metadata/aquaman/anthropic/api_key`,
        expect.objectContaining({
          method: 'DELETE'
        })
      );
    });

    it('returns false for non-existent secret', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const result = await store.delete('nonexistent', 'key');
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('lists keys for a specific service', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            keys: ['api_key', 'secret_key']
          }
        })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const creds = await store.list('anthropic');

      expect(creds).toHaveLength(2);
      expect(creds).toContainEqual({ service: 'anthropic', key: 'api_key' });
      expect(creds).toContainEqual({ service: 'anthropic', key: 'secret_key' });
    });

    it('lists all credentials across services', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: { keys: ['anthropic/', 'openai/'] }
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: { keys: ['api_key'] }
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: { keys: ['api_key', 'org_id'] }
          })
        });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const creds = await store.list();

      expect(creds).toHaveLength(3);
      expect(creds).toContainEqual({ service: 'anthropic', key: 'api_key' });
      expect(creds).toContainEqual({ service: 'openai', key: 'api_key' });
      expect(creds).toContainEqual({ service: 'openai', key: 'org_id' });
    });

    it('returns empty array for 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const creds = await store.list();
      expect(creds).toEqual([]);
    });
  });

  describe('exists', () => {
    it('returns true when secret exists', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { data: { credential: 'value' } }
        })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const exists = await store.exists('service', 'key');
      expect(exists).toBe(true);
    });

    it('returns false when secret does not exist', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const exists = await store.exists('service', 'key');
      expect(exists).toBe(false);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when token is valid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: 'token-id' }
        })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const health = await store.healthCheck();

      expect(health.healthy).toBe(true);
      expect(health.error).toBeUndefined();
    });

    it('returns unhealthy when token is invalid', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const health = await store.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.error).toContain('403');
    });

    it('returns unhealthy when connection fails', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');
      const store = new VaultStore({ address: VAULT_ADDR, token: VAULT_TOKEN });

      const health = await store.healthCheck();

      expect(health.healthy).toBe(false);
      expect(health.error).toContain('Connection');
    });
  });

  describe('isAvailable', () => {
    it('returns true when Vault is reachable', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: {} })
      });

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');

      const available = await VaultStore.isAvailable({
        address: VAULT_ADDR,
        token: VAULT_TOKEN
      });

      expect(available).toBe(true);
    });

    it('returns false when Vault is not reachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const { VaultStore } = await import('../../../../src/credentials/backends/vault.js');

      const available = await VaultStore.isAvailable({
        address: VAULT_ADDR,
        token: VAULT_TOKEN
      });

      expect(available).toBe(false);
    });
  });
});
