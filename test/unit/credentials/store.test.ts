/**
 * Tests for credential store
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  MemoryStore,
  EncryptedFileStore,
  createCredentialStore
} from 'aquaman-core';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  afterEach(() => {
    store.clear();
  });

  describe('set and get', () => {
    it('should store and retrieve credentials', async () => {
      await store.set('anthropic', 'api_key', 'sk-ant-test123');

      const value = await store.get('anthropic', 'api_key');
      expect(value).toBe('sk-ant-test123');
    });

    it('should return null for non-existent credentials', async () => {
      const value = await store.get('unknown', 'key');
      expect(value).toBeNull();
    });

    it('should store metadata', async () => {
      await store.set('service', 'key', 'value', { note: 'test' });

      const value = await store.get('service', 'key');
      expect(value).toBe('value');
    });
  });

  describe('delete', () => {
    it('should delete existing credential', async () => {
      await store.set('service', 'key', 'value');

      const deleted = await store.delete('service', 'key');
      expect(deleted).toBe(true);

      const value = await store.get('service', 'key');
      expect(value).toBeNull();
    });

    it('should return false for non-existent credential', async () => {
      const deleted = await store.delete('unknown', 'key');
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all credentials', async () => {
      await store.set('service1', 'key1', 'value1');
      await store.set('service1', 'key2', 'value2');
      await store.set('service2', 'key1', 'value3');

      const list = await store.list();

      expect(list).toHaveLength(3);
      expect(list).toContainEqual({ service: 'service1', key: 'key1' });
      expect(list).toContainEqual({ service: 'service1', key: 'key2' });
      expect(list).toContainEqual({ service: 'service2', key: 'key1' });
    });

    it('should filter by service', async () => {
      await store.set('service1', 'key1', 'value1');
      await store.set('service1', 'key2', 'value2');
      await store.set('service2', 'key1', 'value3');

      const list = await store.list('service1');

      expect(list).toHaveLength(2);
      expect(list.every(c => c.service === 'service1')).toBe(true);
    });
  });

  describe('exists', () => {
    it('should return true for existing credential', async () => {
      await store.set('service', 'key', 'value');

      const exists = await store.exists('service', 'key');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent credential', async () => {
      const exists = await store.exists('unknown', 'key');
      expect(exists).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all credentials', async () => {
      await store.set('service1', 'key1', 'value1');
      await store.set('service2', 'key2', 'value2');

      store.clear();

      const list = await store.list();
      expect(list).toHaveLength(0);
    });
  });
});

describe('EncryptedFileStore', () => {
  let store: EncryptedFileStore;
  let testDir: string;
  let testFile: string;
  const password = 'test-password-123';

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `aquaman-cred-test-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    testFile = path.join(testDir, 'credentials.enc');
    store = new EncryptedFileStore(password, testFile);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('set and get', () => {
    it('should store and retrieve credentials', async () => {
      await store.set('anthropic', 'api_key', 'sk-ant-test123');

      const value = await store.get('anthropic', 'api_key');
      expect(value).toBe('sk-ant-test123');
    });

    it('should persist to encrypted file', async () => {
      await store.set('service', 'key', 'secret-value');

      // Verify file exists and is encrypted (not readable as JSON)
      expect(fs.existsSync(testFile)).toBe(true);
      const content = fs.readFileSync(testFile, 'utf-8');
      expect(() => JSON.parse(content)).toThrow();
    });

    it('should recover from file on new instance', async () => {
      await store.set('service', 'key', 'secret-value');

      // Create new store instance with same password
      const store2 = new EncryptedFileStore(password, testFile);
      const value = await store2.get('service', 'key');

      expect(value).toBe('secret-value');
    });

    it('should fail with wrong password', async () => {
      await store.set('service', 'key', 'secret-value');

      const wrongStore = new EncryptedFileStore('wrong-password', testFile);

      await expect(wrongStore.get('service', 'key')).rejects.toThrow();
    });
  });

  describe('delete', () => {
    it('should delete and persist', async () => {
      await store.set('service', 'key', 'value');
      await store.delete('service', 'key');

      // Verify in new instance
      const store2 = new EncryptedFileStore(password, testFile);
      const value = await store2.get('service', 'key');

      expect(value).toBeNull();
    });
  });

  describe('list', () => {
    it('should list all credentials', async () => {
      await store.set('service1', 'key1', 'value1');
      await store.set('service2', 'key2', 'value2');

      const list = await store.list();

      expect(list).toHaveLength(2);
    });
  });

  describe('file permissions', () => {
    it('should create file with restricted permissions', async () => {
      await store.set('service', 'key', 'value');

      const stats = fs.statSync(testFile);
      // On Unix, 0o600 = owner read/write only
      // We check the lower bits (permissions)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});

describe('createCredentialStore', () => {
  it('should create encrypted-file store', () => {
    const store = createCredentialStore({
      backend: 'encrypted-file',
      encryptionPassword: 'test123'
    });

    expect(store).toBeInstanceOf(EncryptedFileStore);
  });

  it('should throw for encrypted-file without password', () => {
    expect(() =>
      createCredentialStore({ backend: 'encrypted-file' })
    ).toThrow('encryptionPassword required');
  });

  it('should throw for vault backend without address', () => {
    // Clear VAULT_ADDR env var if set
    const originalAddr = process.env['VAULT_ADDR'];
    delete process.env['VAULT_ADDR'];

    try {
      expect(() =>
        createCredentialStore({ backend: 'vault' })
      ).toThrow('vaultAddress required');
    } finally {
      if (originalAddr) {
        process.env['VAULT_ADDR'] = originalAddr;
      }
    }
  });
});
