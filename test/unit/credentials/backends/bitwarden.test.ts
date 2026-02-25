/**
 * Tests for Bitwarden credential backend
 * Note: Tests are mocked since actual Bitwarden requires CLI and auth
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn()
}));

// Helper to create a mock SpawnSyncReturns object
function mockSpawnResult(
  status: number,
  stdout: string,
  stderr: string = ''
): ReturnType<typeof spawnSync> {
  return {
    status,
    stdout,
    stderr,
    pid: Math.floor(Math.random() * 10000),
    signal: null,
    output: [null, stdout, stderr]
  };
}

describe('BitwardenStore', () => {
  const mockSpawnSync = vi.mocked(spawnSync);

  beforeEach(() => {
    vi.resetAllMocks();
    // Clear BW_SESSION env var between tests
    delete process.env['BW_SESSION'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CLI availability check', () => {
    it('throws if bw CLI not installed', async () => {
      mockSpawnSync.mockReturnValue(mockSpawnResult(1, '', 'command not found'));

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );

      expect(() => new BitwardenStore()).toThrow('Bitwarden CLI (bw) not found');
    });

    it('throws if not logged in', async () => {
      // First call: which bw - success
      // Second call: bw status - unauthenticated
      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'unauthenticated' }))
        );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );

      expect(() => new BitwardenStore()).toThrow('Not logged in to Bitwarden');
    });

    it('throws if vault is locked and no BW_SESSION', async () => {
      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'locked' }))
        );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );

      expect(() => new BitwardenStore()).toThrow('Bitwarden vault is locked');
    });

    it('throws if vault is locked and BW_SESSION is invalid', async () => {
      process.env['BW_SESSION'] = 'invalid-session-token';

      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'locked' }))
        )
        // Sync fails with invalid session
        .mockReturnValueOnce(mockSpawnResult(1, '', 'Session key is invalid'));

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );

      expect(() => new BitwardenStore()).toThrow('BW_SESSION is invalid');
    });

    it('succeeds when vault is locked but BW_SESSION is valid', async () => {
      process.env['BW_SESSION'] = 'valid-session-token';

      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'locked' }))
        )
        // Sync succeeds with valid session
        .mockReturnValueOnce(mockSpawnResult(0, 'Syncing complete.'));

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );

      const store = new BitwardenStore();
      expect(store).toBeDefined();
      expect(store.getFolder()).toBe('aquaman');
    });

    it('succeeds when vault is already unlocked', async () => {
      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }))
        );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );

      const store = new BitwardenStore();
      expect(store).toBeDefined();
    });
  });

  describe('with mocked bw CLI', () => {
    beforeEach(() => {
      // Default: bw is installed and unlocked
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        return mockSpawnResult(0, '{}');
      });
    });

    it('creates store with default folder', async () => {
      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      expect(store.getFolder()).toBe('aquaman');
    });

    it('creates store with custom folder', async () => {
      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore({ folder: 'custom-folder' });

      expect(store.getFolder()).toBe('custom-folder');
    });

    it('retrieves credential by service/key', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([
              { id: 'item-123', name: 'aquaman::anthropic::api_key', folderId: null }
            ])
          );
        }
        if (args?.[0] === 'get' && args?.[1] === 'item') {
          return mockSpawnResult(
            0,
            JSON.stringify({
              id: 'item-123',
              name: 'aquaman::anthropic::api_key',
              login: { password: 'sk-ant-secret-key' }
            })
          );
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const value = await store.get('anthropic', 'api_key');
      expect(value).toBe('sk-ant-secret-key');
    });

    it('returns null for missing credentials', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const value = await store.get('nonexistent', 'key');
      expect(value).toBeNull();
    });

    it('falls back to notes field if login.password is missing', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'item-456', name: 'aquaman::service::key', folderId: null }])
          );
        }
        if (args?.[0] === 'get' && args?.[1] === 'item') {
          return mockSpawnResult(
            0,
            JSON.stringify({
              id: 'item-456',
              name: 'aquaman::service::key',
              notes: 'secret-in-notes'
            })
          );
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const value = await store.get('service', 'key');
      expect(value).toBe('secret-in-notes');
    });

    it('stores new credential with correct item name', async () => {
      let capturedCreateArgs: string[] = [];
      let capturedEncodedData: string | null = null;

      mockSpawnSync.mockImplementation((command, args, options) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'folder-abc', name: 'aquaman' }])
          );
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          // Item doesn't exist yet
          return mockSpawnResult(0, JSON.stringify([]));
        }
        if (args?.[0] === 'create' && args?.[1] === 'item') {
          capturedCreateArgs = args as string[];
          // Capture from stdin (options.input) instead of args
          capturedEncodedData = options?.input as string || null;
          return mockSpawnResult(0, JSON.stringify({ id: 'new-item-id' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      await store.set('anthropic', 'api_key', 'sk-ant-new-key');

      expect(capturedCreateArgs[0]).toBe('create');
      expect(capturedCreateArgs[1]).toBe('item');
      expect(capturedEncodedData).toBeTruthy();

      // Decode the base64 to verify item structure
      const decoded = JSON.parse(Buffer.from(capturedEncodedData!, 'base64').toString('utf-8'));
      expect(decoded.name).toBe('aquaman::anthropic::api_key');
      expect(decoded.login.password).toBe('sk-ant-new-key');
      expect(decoded.type).toBe(1); // Login type
    });

    it('updates existing credential', async () => {
      let capturedEditArgs: string[] = [];
      let capturedEditInput: string | null = null;

      mockSpawnSync.mockImplementation((command, args, options) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'folder-abc', name: 'aquaman' }])
          );
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([
              { id: 'existing-item', name: 'aquaman::anthropic::api_key', folderId: 'folder-abc' }
            ])
          );
        }
        if (args?.[0] === 'get' && args?.[1] === 'item') {
          return mockSpawnResult(
            0,
            JSON.stringify({
              id: 'existing-item',
              name: 'aquaman::anthropic::api_key',
              login: { password: 'old-value' }
            })
          );
        }
        if (args?.[0] === 'edit' && args?.[1] === 'item') {
          capturedEditArgs = args as string[];
          capturedEditInput = options?.input as string || null;
          return mockSpawnResult(0, JSON.stringify({ id: 'existing-item' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      await store.set('anthropic', 'api_key', 'sk-ant-updated-key');

      expect(capturedEditArgs[0]).toBe('edit');
      expect(capturedEditArgs[1]).toBe('item');
      expect(capturedEditArgs[2]).toBe('existing-item');

      // Decode from stdin to verify updated password
      const decoded = JSON.parse(Buffer.from(capturedEditInput!, 'base64').toString('utf-8'));
      expect(decoded.login.password).toBe('sk-ant-updated-key');
    });

    it('stores credential with metadata in notes', async () => {
      let capturedEncodedData: string | null = null;

      mockSpawnSync.mockImplementation((command, args, options) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'folder-abc', name: 'aquaman' }])
          );
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        if (args?.[0] === 'create' && args?.[1] === 'item') {
          capturedEncodedData = options?.input as string || null;
          return mockSpawnResult(0, JSON.stringify({ id: 'new-item-id' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      await store.set('service', 'key', 'secret', {
        source: 'manual',
        addedBy: 'user123'
      });

      const decoded = JSON.parse(Buffer.from(capturedEncodedData!, 'base64').toString('utf-8'));
      expect(decoded.notes).toContain('source: manual');
      expect(decoded.notes).toContain('addedBy: user123');
    });

    it('deletes credential and returns true', async () => {
      let deleteCalled = false;
      let deletedItemId: string | null = null;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([
              { id: 'item-to-delete', name: 'aquaman::anthropic::api_key', folderId: null }
            ])
          );
        }
        if (args?.[0] === 'delete' && args?.[1] === 'item') {
          deleteCalled = true;
          deletedItemId = args[2] as string;
          return mockSpawnResult(0, '');
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const result = await store.delete('anthropic', 'api_key');

      expect(deleteCalled).toBe(true);
      expect(deletedItemId).toBe('item-to-delete');
      expect(result).toBe(true);
    });

    it('returns false when deleting non-existent credential', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const result = await store.delete('nonexistent', 'key');
      expect(result).toBe(false);
    });

    it('lists credentials with parsed service/key', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([
              { name: 'aquaman::anthropic::api_key' },
              { name: 'aquaman::openai::api_key' },
              { name: 'aquaman::slack::bot_token' },
              { name: 'unrelated-item' } // Should be filtered out
            ])
          );
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const creds = await store.list();

      expect(creds).toHaveLength(3);
      expect(creds.some(c => c.service === 'anthropic' && c.key === 'api_key')).toBe(true);
      expect(creds.some(c => c.service === 'openai' && c.key === 'api_key')).toBe(true);
      expect(creds.some(c => c.service === 'slack' && c.key === 'bot_token')).toBe(true);
    });

    it('filters list by service', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([
              { name: 'aquaman::anthropic::api_key' },
              { name: 'aquaman::anthropic::org_id' },
              { name: 'aquaman::openai::api_key' }
            ])
          );
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const creds = await store.list('anthropic');

      expect(creds).toHaveLength(2);
      expect(creds.every(c => c.service === 'anthropic')).toBe(true);
    });

    it('exists returns true for existing credential', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([
              { id: 'item-123', name: 'aquaman::anthropic::api_key', folderId: null }
            ])
          );
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const exists = await store.exists('anthropic', 'api_key');
      expect(exists).toBe(true);
    });

    it('exists returns false for non-existent credential', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const exists = await store.exists('nonexistent', 'key');
      expect(exists).toBe(false);
    });

    it('creates folder if it does not exist', async () => {
      let folderCreated = false;
      let folderName: string | null = null;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(0, JSON.stringify([])); // No folders exist
        }
        if (args?.[0] === 'create' && args?.[1] === 'folder') {
          folderCreated = true;
          const decoded = JSON.parse(Buffer.from(args[2] as string, 'base64').toString('utf-8'));
          folderName = decoded.name;
          return mockSpawnResult(0, JSON.stringify({ id: 'new-folder-id' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        if (args?.[0] === 'create' && args?.[1] === 'item') {
          return mockSpawnResult(0, JSON.stringify({ id: 'new-item-id' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      await store.set('service', 'key', 'value');

      expect(folderCreated).toBe(true);
      expect(folderName).toBe('aquaman');
    });

    it('handles keys with hyphens correctly', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ name: 'aquaman::service::complex-key-name' }])
          );
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      const creds = await store.list();

      expect(creds).toHaveLength(1);
      expect(creds[0].service).toBe('service');
      expect(creds[0].key).toBe('complex-key-name');
    });
  });

  describe('metadata key sanitization', () => {
    beforeEach(() => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'folder-abc', name: 'aquaman' }])
          );
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        if (args?.[0] === 'create' && args?.[1] === 'item') {
          return mockSpawnResult(0, JSON.stringify({ id: 'new-item-id' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });
    });

    it('rejects metadata keys starting with number', async () => {
      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      await expect(store.set('svc', 'key', 'val', { '123key': 'x' })).rejects.toThrow(
        'Invalid metadata key'
      );
    });

    it('rejects metadata keys with special characters', async () => {
      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      await expect(store.set('svc', 'key', 'val', { 'key@value': 'x' })).rejects.toThrow(
        'Invalid metadata key'
      );
    });

    it('accepts valid metadata keys', async () => {
      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore();

      // Should not throw
      await store.set('svc', 'key', 'val', {
        validKey: 'x',
        anotherKey123: 'y',
        'key-with-hyphen': 'z',
        key_with_underscore: 'w'
      });
    });
  });

  describe('isAvailable', () => {
    it('returns false when bw not installed', async () => {
      mockSpawnSync.mockReturnValue(mockSpawnResult(1, '', 'command not found'));

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isAvailable()).toBe(false);
    });

    it('returns false when not logged in (unauthenticated)', async () => {
      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'unauthenticated' }))
        );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isAvailable()).toBe(false);
    });

    it('returns true when logged in (locked)', async () => {
      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'locked' }))
        );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isAvailable()).toBe(true);
    });

    it('returns true when logged in (unlocked)', async () => {
      mockSpawnSync
        .mockReturnValueOnce(mockSpawnResult(0, '/usr/local/bin/bw\n'))
        .mockReturnValueOnce(
          mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }))
        );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isAvailable()).toBe(true);
    });
  });

  describe('isUnlocked', () => {
    it('returns false when bw not installed', async () => {
      mockSpawnSync.mockReturnValue(mockSpawnResult(1, '', 'command not found'));

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isUnlocked()).toBe(false);
    });

    it('returns false when vault is locked without valid session', async () => {
      mockSpawnSync.mockReturnValue(
        mockSpawnResult(0, JSON.stringify({ status: 'locked' }))
      );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isUnlocked()).toBe(false);
    });

    it('returns true when vault is unlocked', async () => {
      mockSpawnSync.mockReturnValue(
        mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }))
      );

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isUnlocked()).toBe(true);
    });

    it('returns true when locked but BW_SESSION is valid', async () => {
      process.env['BW_SESSION'] = 'valid-session';

      mockSpawnSync.mockImplementation((command, args) => {
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'locked' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isUnlocked()).toBe(true);
    });

    it('returns false when locked and BW_SESSION sync fails', async () => {
      process.env['BW_SESSION'] = 'invalid-session';

      mockSpawnSync.mockImplementation((command, args) => {
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'locked' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(1, '', 'Session key is invalid');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      expect(BitwardenStore.isUnlocked()).toBe(false);
    });
  });

  describe('organization and collection support', () => {
    beforeEach(() => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'folder-abc', name: 'aquaman' }])
          );
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        if (args?.[0] === 'create' && args?.[1] === 'item') {
          return mockSpawnResult(0, JSON.stringify({ id: 'new-item-id' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });
    });

    it('includes organizationId in new items when configured', async () => {
      let capturedEncodedData: string | null = null;

      mockSpawnSync.mockImplementation((command, args, options) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        if (args?.[0] === 'list' && args?.[1] === 'folders') {
          return mockSpawnResult(
            0,
            JSON.stringify([{ id: 'folder-abc', name: 'aquaman' }])
          );
        }
        if (args?.[0] === 'list' && args?.[1] === 'items') {
          return mockSpawnResult(0, JSON.stringify([]));
        }
        if (args?.[0] === 'create' && args?.[1] === 'item') {
          capturedEncodedData = options?.input as string || null;
          return mockSpawnResult(0, JSON.stringify({ id: 'new-item-id' }));
        }
        if (args?.[0] === 'sync') {
          return mockSpawnResult(0, 'Syncing complete.');
        }
        return mockSpawnResult(0, '{}');
      });

      const { BitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = new BitwardenStore({
        organizationId: 'org-12345',
        collectionId: 'col-67890'
      });

      await store.set('service', 'key', 'value');

      const decoded = JSON.parse(Buffer.from(capturedEncodedData!, 'base64').toString('utf-8'));
      expect(decoded.organizationId).toBe('org-12345');
      expect(decoded.collectionIds).toEqual(['col-67890']);
    });
  });

  describe('createBitwardenStore factory', () => {
    beforeEach(() => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return mockSpawnResult(0, '/usr/local/bin/bw\n');
        }
        if (args?.[0] === 'status') {
          return mockSpawnResult(0, JSON.stringify({ status: 'unlocked' }));
        }
        return mockSpawnResult(0, '{}');
      });
    });

    it('creates store with default options', async () => {
      const { createBitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = createBitwardenStore();

      expect(store).toBeDefined();
      expect(store.getFolder()).toBe('aquaman');
    });

    it('creates store with custom options', async () => {
      const { createBitwardenStore } = await import(
        '../../../../packages/proxy/src/core/credentials/backends/bitwarden.js'
      );
      const store = createBitwardenStore({ folder: 'my-folder' });

      expect(store.getFolder()).toBe('my-folder');
    });
  });
});
