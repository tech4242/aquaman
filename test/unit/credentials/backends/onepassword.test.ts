/**
 * Tests for 1Password credential backend
 * Note: Most tests are mocked since actual 1Password requires CLI and auth
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn()
}));

describe('OnePasswordStore', () => {
  const mockSpawnSync = vi.mocked(spawnSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('CLI availability check', () => {
    it('throws if op CLI not installed', async () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'command not found',
        pid: 123,
        signal: null,
        output: []
      });

      // Dynamically import to apply mocks
      const { OnePasswordStore } = await import('@aquaman/core');

      expect(() => new OnePasswordStore()).toThrow('1Password CLI (op) not found');
    });

    it('throws if not signed in', async () => {
      // First call: which op - success
      // Second call: op account get - failure
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: '/usr/local/bin/op\n',
          stderr: '',
          pid: 123,
          signal: null,
          output: []
        })
        .mockReturnValueOnce({
          status: 1,
          stdout: '',
          stderr: 'not signed in',
          pid: 124,
          signal: null,
          output: []
        });

      const { OnePasswordStore } = await import('@aquaman/core');

      expect(() => new OnePasswordStore()).toThrow('Not signed in to 1Password');
    });
  });

  describe('with mocked op CLI', () => {
    beforeEach(() => {
      // Default: op is installed and signed in
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return {
            status: 0,
            stdout: '/usr/local/bin/op\n',
            stderr: '',
            pid: 123,
            signal: null,
            output: []
          };
        }
        if (args?.[0] === 'account' && args?.[1] === 'get') {
          return {
            status: 0,
            stdout: '{"id": "ABC123"}',
            stderr: '',
            pid: 124,
            signal: null,
            output: []
          };
        }
        return {
          status: 0,
          stdout: '{}',
          stderr: '',
          pid: 125,
          signal: null,
          output: []
        };
      });
    });

    it('creates store with default vault', async () => {
      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore();

      expect(store.getVault()).toBe('aquaman');
    });

    it('creates store with custom vault', async () => {
      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore({ vault: 'custom-vault' });

      expect(store.getVault()).toBe('custom-vault');
    });

    it('stores credential with correct item name', async () => {
      let capturedArgs: string[] = [];

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        }
        if (args?.[0] === 'account') {
          return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        }
        if (args?.[0] === 'vault' && args?.[1] === 'get') {
          return { status: 0, stdout: '{}', stderr: '', pid: 3, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'get') {
          // Item not found - triggers create
          return { status: 1, stdout: '', stderr: 'not found', pid: 4, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'create') {
          capturedArgs = args as string[];
          return { status: 0, stdout: '{}', stderr: '', pid: 5, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 6, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore();

      await store.set('anthropic', 'api_key', 'test-value');

      expect(capturedArgs).toContain('--title');
      expect(capturedArgs).toContain('aquaman-anthropic-api_key');
    });

    it('retrieves credential by service/key', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        }
        if (args?.[0] === 'account') {
          return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'get') {
          return {
            status: 0,
            stdout: JSON.stringify({ value: 'retrieved-secret' }),
            stderr: '',
            pid: 3,
            signal: null,
            output: []
          };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 4, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore();

      const value = await store.get('anthropic', 'api_key');
      expect(value).toBe('retrieved-secret');
    });

    it('returns null for missing credentials', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        }
        if (args?.[0] === 'account') {
          return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'get') {
          return { status: 1, stdout: '', stderr: 'not found', pid: 3, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 4, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore();

      const value = await store.get('nonexistent', 'key');
      expect(value).toBeNull();
    });

    it('lists credentials with tag filter', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        }
        if (args?.[0] === 'account') {
          return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'list') {
          return {
            status: 0,
            stdout: JSON.stringify([
              { title: 'aquaman-anthropic-api_key' },
              { title: 'aquaman-openai-api_key' }
            ]),
            stderr: '',
            pid: 3,
            signal: null,
            output: []
          };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 4, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore();

      const creds = await store.list();

      expect(creds).toHaveLength(2);
      expect(creds.some(c => c.service === 'anthropic' && c.key === 'api_key')).toBe(true);
      expect(creds.some(c => c.service === 'openai' && c.key === 'api_key')).toBe(true);
    });

    it('deletes credential', async () => {
      let deleteCalled = false;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        }
        if (args?.[0] === 'account') {
          return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'delete') {
          deleteCalled = true;
          return { status: 0, stdout: '', stderr: '', pid: 3, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 4, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      const store = new OnePasswordStore();

      const result = await store.delete('anthropic', 'api_key');

      expect(deleteCalled).toBe(true);
      expect(result).toBe(true);
    });
  });

  describe('isAvailable', () => {
    it('returns false when op not installed', async () => {
      mockSpawnSync.mockReturnValue({
        status: 1,
        stdout: '',
        stderr: 'command not found',
        pid: 1,
        signal: null,
        output: []
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      expect(OnePasswordStore.isAvailable()).toBe(false);
    });

    it('returns false when not signed in', async () => {
      mockSpawnSync
        .mockReturnValueOnce({
          status: 0,
          stdout: '/usr/local/bin/op\n',
          stderr: '',
          pid: 1,
          signal: null,
          output: []
        })
        .mockReturnValueOnce({
          status: 1,
          stdout: '',
          stderr: 'not signed in',
          pid: 2,
          signal: null,
          output: []
        });

      const { OnePasswordStore } = await import('@aquaman/core');
      expect(OnePasswordStore.isAvailable()).toBe(false);
    });

    it('returns true when op is available and signed in', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') {
          return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        }
        if (args?.[0] === 'account') {
          return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 3, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('@aquaman/core');
      expect(OnePasswordStore.isAvailable()).toBe(true);
    });
  });
});
