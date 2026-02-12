/**
 * Tests for KeePassXC credential backend
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { KeePassXCStore } from 'aquaman-core';

const TEST_PASSWORD = 'test-password-for-keepass';

describe('KeePassXCStore', () => {
  let store: KeePassXCStore;
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `aquaman-keepassxc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    dbPath = path.join(testDir, 'test.kdbx');
  });

  afterEach(() => {
    if (store) {
      store.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('constructor', () => {
    it('should throw without password and key file', () => {
      expect(() => new KeePassXCStore({ dbPath })).toThrow(
        'KeePassXC backend requires a master password'
      );
    });

    it('should accept password-only auth', () => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
      expect(store).toBeInstanceOf(KeePassXCStore);
    });
  });

  describe('auto-create database', () => {
    it('should create a new .kdbx file if it does not exist', async () => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });

      expect(fs.existsSync(dbPath)).toBe(false);

      // Trigger database creation by calling list
      const list = await store.list();
      expect(list).toHaveLength(0);
      expect(fs.existsSync(dbPath)).toBe(true);
    });
  });

  describe('set and get', () => {
    beforeEach(() => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
    });

    it('should store and retrieve credentials', async () => {
      await store.set('anthropic', 'api_key', 'sk-ant-test123');

      const value = await store.get('anthropic', 'api_key');
      expect(value).toBe('sk-ant-test123');
    });

    it('should return null for non-existent credentials', async () => {
      const value = await store.get('unknown', 'key');
      expect(value).toBeNull();
    });

    it('should overwrite existing credentials', async () => {
      await store.set('service', 'key', 'value1');
      await store.set('service', 'key', 'value2');

      const value = await store.get('service', 'key');
      expect(value).toBe('value2');
    });

    it('should handle special characters in values', async () => {
      const specialValue = 'sk-ant-api03-foo/bar+baz=end!@#$%';
      await store.set('service', 'key', specialValue);

      const value = await store.get('service', 'key');
      expect(value).toBe(specialValue);
    });
  });

  describe('delete', () => {
    beforeEach(() => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
    });

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
    beforeEach(() => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
    });

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
    beforeEach(() => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
    });

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

  describe('persistence', () => {
    it('should persist data across store instances', async () => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
      await store.set('service', 'key', 'persistent-value');
      store.close();

      // Create a new store instance pointing to the same file
      const store2 = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
      const value = await store2.get('service', 'key');
      store2.close();

      expect(value).toBe('persistent-value');
    });

    it('should fail with wrong password on existing database', async () => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
      await store.set('service', 'key', 'value');
      store.close();

      const wrongStore = new KeePassXCStore({ dbPath, password: 'wrong-password' });
      await expect(wrongStore.get('service', 'key')).rejects.toThrow();
      wrongStore.close();
    });
  });

  describe('custom group', () => {
    it('should use custom group name', async () => {
      store = new KeePassXCStore({
        dbPath,
        password: TEST_PASSWORD,
        group: 'my-custom-group'
      });

      await store.set('service', 'key', 'value');
      const value = await store.get('service', 'key');
      expect(value).toBe('value');
    });
  });

  describe('file permissions', () => {
    it('should create file with restricted permissions', async () => {
      store = new KeePassXCStore({ dbPath, password: TEST_PASSWORD });
      await store.set('service', 'key', 'value');

      const stats = fs.statSync(dbPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });
});
