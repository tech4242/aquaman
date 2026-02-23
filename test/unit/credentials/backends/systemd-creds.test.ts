/**
 * Tests for systemd-creds credential backend
 *
 * These tests require systemd >= 256 with --user support.
 * They will be skipped on systems without systemd-creds.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SystemdCredsStore, isSystemdCredsAvailable } from 'aquaman-core';

import { execFileSync } from 'node:child_process';

// Synchronous check at module load time so skipIf() works
let available = false;
try {
  const out = execFileSync('systemd-creds', ['--version'], { encoding: 'utf-8' });
  const match = out.match(/systemd\s+(\d+)/);
  available = match ? parseInt(match[1], 10) >= 256 : false;
} catch {
  available = false;
}

describe('SystemdCredsStore', () => {
  let store: SystemdCredsStore;
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(
      os.tmpdir(),
      `aquaman-systemd-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    store = new SystemdCredsStore({ credsDir: testDir });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('constructor', () => {
    it('should create the creds directory if it does not exist', () => {
      const newDir = path.join(testDir, 'nested', 'creds');
      new SystemdCredsStore({ credsDir: newDir });
      expect(fs.existsSync(newDir)).toBe(true);
    });
  });

  describe('set and get', () => {
    it.skipIf(!available)(
      'should store and retrieve a credential',
      async () => {
        await store.set('anthropic', 'api_key', 'sk-ant-12345');
        const value = await store.get('anthropic', 'api_key');
        expect(value).toBe('sk-ant-12345');
      }
    );

    it.skipIf(!available)(
      'should return null for non-existent credential',
      async () => {
        const value = await store.get('nonexistent', 'key');
        expect(value).toBeNull();
      }
    );

    it.skipIf(!available)(
      'should overwrite existing credential',
      async () => {
        await store.set('openai', 'api_key', 'sk-old');
        await store.set('openai', 'api_key', 'sk-new');
        const value = await store.get('openai', 'api_key');
        expect(value).toBe('sk-new');
      }
    );

    it.skipIf(!available)(
      'should handle special characters in values',
      async () => {
        const specialValue = 'p@$$w0rd!#%&*(){}[]|\\:";\'<>?,./~`';
        await store.set('test', 'special', specialValue);
        const value = await store.get('test', 'special');
        expect(value).toBe(specialValue);
      }
    );

    it.skipIf(!available)(
      'should use in-memory cache on second read',
      async () => {
        await store.set('cached', 'key', 'value');

        // First read populates cache
        const v1 = await store.get('cached', 'key');
        expect(v1).toBe('value');

        // Delete the file — cached read should still work
        const credFile = path.join(testDir, 'cached--key.cred');
        fs.unlinkSync(credFile);

        const v2 = await store.get('cached', 'key');
        expect(v2).toBe('value');
      }
    );
  });

  describe('delete', () => {
    it.skipIf(!available)(
      'should delete a credential and return true',
      async () => {
        await store.set('deleteme', 'api_key', 'gone');
        const deleted = await store.delete('deleteme', 'api_key');
        expect(deleted).toBe(true);

        const value = await store.get('deleteme', 'api_key');
        expect(value).toBeNull();
      }
    );

    it('should return false for non-existent credential', async () => {
      const deleted = await store.delete('nonexistent', 'key');
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it.skipIf(!available)(
      'should list all stored credentials',
      async () => {
        await store.set('svc-a', 'key1', 'val1');
        await store.set('svc-b', 'key2', 'val2');

        const all = await store.list();
        expect(all).toHaveLength(2);
        expect(all).toContainEqual({ service: 'svc-a', key: 'key1' });
        expect(all).toContainEqual({ service: 'svc-b', key: 'key2' });
      }
    );

    it.skipIf(!available)(
      'should filter by service',
      async () => {
        await store.set('alpha', 'key1', 'val1');
        await store.set('beta', 'key2', 'val2');

        const filtered = await store.list('alpha');
        expect(filtered).toHaveLength(1);
        expect(filtered[0]).toEqual({ service: 'alpha', key: 'key1' });
      }
    );
  });

  describe('exists', () => {
    it.skipIf(!available)(
      'should return true for existing credential',
      async () => {
        await store.set('exists-test', 'key', 'val');
        expect(await store.exists('exists-test', 'key')).toBe(true);
      }
    );

    it('should return false for non-existent credential', async () => {
      expect(await store.exists('nope', 'key')).toBe(false);
    });
  });
});

describe('isSystemdCredsAvailable', () => {
  it('should return a boolean', async () => {
    const result = await isSystemdCredsAvailable();
    expect(typeof result).toBe('boolean');
  });
});
