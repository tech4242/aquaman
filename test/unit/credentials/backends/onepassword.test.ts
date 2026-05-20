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

describe('writeTemplateAndRun', () => {
  it('writes the template to a 0o600 file in a fresh dir, then unlinks on success', async () => {
    const { existsSync, statSync } = await import('node:fs');
    const { writeTemplateAndRun } = await import('aquaman-core');
    let observedPath: string | undefined;
    let observedContent: string | undefined;
    let observedMode: number | undefined;

    const result = writeTemplateAndRun('{"hello":"world"}', (path) => {
      observedPath = path;
      observedContent = (require('node:fs') as typeof import('node:fs')).readFileSync(path, 'utf-8');
      observedMode = statSync(path).mode & 0o777;
      return 'fn-return';
    });

    expect(result).toBe('fn-return');
    expect(observedContent).toBe('{"hello":"world"}');
    expect(observedMode).toBe(0o600);
    expect(observedPath).toMatch(/aquaman-op-/);
    // File AND its parent dir must be gone after.
    expect(existsSync(observedPath!)).toBe(false);
  });

  it('unlinks the file even if the callback throws', async () => {
    const { existsSync } = await import('node:fs');
    const { writeTemplateAndRun } = await import('aquaman-core');
    let observedPath: string | undefined;

    expect(() => writeTemplateAndRun('{}', (path) => {
      observedPath = path;
      throw new Error('boom');
    })).toThrow(/boom/);

    expect(observedPath).toBeDefined();
    expect(existsSync(observedPath!)).toBe(false);
  });
});

describe('isItemNotFoundError', () => {
  it.each([
    'item "foo" not found in vault',
    "[ERROR] \"aquaman-svc-key\" isn't an item in the \"aquaman_claude_code\" vault.",
    '[ERROR] no item with that name',
  ])('returns true for: %s', async (msg) => {
    const { isItemNotFoundError } = await import('aquaman-core');
    expect(isItemNotFoundError(msg)).toBe(true);
  });

  it.each([
    'connection refused',
    'unauthorized',
    'invalid vault',
    'biometric prompt timed out',
  ])('returns false for: %s', async (msg) => {
    const { isItemNotFoundError } = await import('aquaman-core');
    expect(isItemNotFoundError(msg)).toBe(false);
  });
});

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
      const { OnePasswordStore } = await import('aquaman-core');

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

      const { OnePasswordStore } = await import('aquaman-core');

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
      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      expect(store.getVault()).toBe('aquaman');
    });

    it('creates store with custom vault', async () => {
      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore({ vault: 'custom-vault' });

      expect(store.getVault()).toBe('custom-vault');
    });

    it('stores credential with correct item title (in template JSON)', async () => {
      const { readFileSync, existsSync } = await import('node:fs');
      let templateContent: string | undefined;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        if (args?.[0] === 'account') return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        if (args?.[0] === 'vault' && args?.[1] === 'get') return { status: 0, stdout: '{}', stderr: '', pid: 3, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'get') return { status: 1, stdout: '', stderr: 'not found', pid: 4, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'create') {
          const tmplIdx = (args as string[]).indexOf('--template');
          const tmplPath = (args as string[])[tmplIdx + 1];
          if (existsSync(tmplPath)) templateContent = readFileSync(tmplPath, 'utf-8');
          return { status: 0, stdout: '{}', stderr: '', pid: 5, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 6, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      await store.set('anthropic', 'api_key', 'test-value');

      expect(templateContent).toBeDefined();
      const parsed = JSON.parse(templateContent!);
      expect(parsed.title).toBe('aquaman-anthropic-api_key');
    });

    it('writes credential to a temp template file and passes --template to op (create)', async () => {
      const { readFileSync, existsSync, statSync } = await import('node:fs');
      let capturedArgs: string[] = [];
      let templateContent: string | undefined;
      let templateMode: number | undefined;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        if (args?.[0] === 'account') return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        if (args?.[0] === 'vault' && args?.[1] === 'get') return { status: 0, stdout: '{}', stderr: '', pid: 3, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'get') return { status: 1, stdout: '', stderr: "isn't an item in the", pid: 4, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'create') {
          capturedArgs = args as string[];
          // The real `op` reads the template file at this point — so do we,
          // before the OnePasswordStore unlinks it after we return.
          const tmplIdx = (args as string[]).indexOf('--template');
          const tmplPath = (args as string[])[tmplIdx + 1];
          if (existsSync(tmplPath)) {
            templateContent = readFileSync(tmplPath, 'utf-8');
            templateMode = statSync(tmplPath).mode & 0o777;
          }
          return { status: 0, stdout: '{}', stderr: '', pid: 5, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 6, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();
      const secretValue = 'sk-ant-super-secret-key';

      await store.set('anthropic', 'api_key', secretValue);

      expect(capturedArgs).toContain('--template');
      expect(capturedArgs).not.toContain('--category');  // category lives in JSON
      expect(capturedArgs.join(' ')).not.toContain(secretValue);  // never in argv
      expect(templateContent).toBeDefined();
      expect(templateMode).toBe(0o600);

      const parsed = JSON.parse(templateContent!);
      expect(parsed.category).toBe('API_CREDENTIAL');
      expect(parsed.title).toBe('aquaman-anthropic-api_key');
      const credField = parsed.fields.find((f: any) => f.id === 'credential');
      expect(credField.type).toBe('CONCEALED');
      expect(credField.value).toBe(secretValue);

      // File must be cleaned up after the call returns.
      const tmplIdx = capturedArgs.indexOf('--template');
      const tmplPath = capturedArgs[tmplIdx + 1];
      expect(existsSync(tmplPath)).toBe(false);
    });

    it('writes credential to a temp template file and passes --template to op (edit)', async () => {
      const { readFileSync, existsSync } = await import('node:fs');
      let capturedEditArgs: string[] = [];
      let templateContent: string | undefined;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        if (args?.[0] === 'account') return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        if (args?.[0] === 'vault' && args?.[1] === 'get') return { status: 0, stdout: '{}', stderr: '', pid: 3, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'get') {
          return { status: 0, stdout: JSON.stringify({ value: 'old-value' }), stderr: '', pid: 4, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'edit') {
          capturedEditArgs = args as string[];
          const tmplIdx = (args as string[]).indexOf('--template');
          const tmplPath = (args as string[])[tmplIdx + 1];
          if (existsSync(tmplPath)) templateContent = readFileSync(tmplPath, 'utf-8');
          return { status: 0, stdout: '{}', stderr: '', pid: 5, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 6, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();
      const secretValue = 'sk-ant-updated-secret-key';

      await store.set('anthropic', 'api_key', secretValue);

      expect(capturedEditArgs).toContain('--template');
      expect(capturedEditArgs.join(' ')).not.toContain(secretValue);
      expect(templateContent).toBeDefined();

      const parsed = JSON.parse(templateContent!);
      const credField = parsed.fields.find((f: any) => f.id === 'credential');
      expect(credField.value).toBe(secretValue);

      // edit JSON omits title/category — they're already set on the item.
      expect(parsed.title).toBeUndefined();
      expect(parsed.category).toBeUndefined();
    });

    it('unlinks the temp template file even when op fails', async () => {
      const { existsSync } = await import('node:fs');
      let observedTmplPath: string | undefined;

      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        if (args?.[0] === 'account') return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        if (args?.[0] === 'vault' && args?.[1] === 'get') return { status: 0, stdout: '{}', stderr: '', pid: 3, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'get') return { status: 1, stdout: '', stderr: 'no item', pid: 4, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'create') {
          const tmplIdx = (args as string[]).indexOf('--template');
          observedTmplPath = (args as string[])[tmplIdx + 1];
          return { status: 1, stdout: '', stderr: 'op exploded', pid: 5, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 6, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      await expect(store.set('anthropic', 'api_key', 'val')).rejects.toThrow(/op exploded/);

      expect(observedTmplPath).toBeDefined();
      expect(existsSync(observedTmplPath!)).toBe(false);
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

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      const value = await store.get('anthropic', 'api_key');
      expect(value).toBe('retrieved-secret');
    });

    it.each([
      ['not found', 'old phrasing'],
      ["isn't an item in the \"vault\" vault", 'modern phrasing'],
      ['no item with that name', 'short-form phrasing']
    ])('returns null when op says %s (%s)', async (stderr) => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        if (args?.[0] === 'account') return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'get') {
          return { status: 1, stdout: '', stderr, pid: 3, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 4, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      const value = await store.get('nonexistent', 'key');
      expect(value).toBeNull();
    });

    it('still throws on unrelated op errors', async () => {
      mockSpawnSync.mockImplementation((command, args) => {
        if (command === 'which') return { status: 0, stdout: '/usr/local/bin/op\n', stderr: '', pid: 1, signal: null, output: [] };
        if (args?.[0] === 'account') return { status: 0, stdout: '{}', stderr: '', pid: 2, signal: null, output: [] };
        if (args?.[0] === 'item' && args?.[1] === 'get') {
          return { status: 1, stdout: '', stderr: 'connection refused', pid: 3, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 4, signal: null, output: [] };
      });

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      await expect(store.get('whatever', 'key')).rejects.toThrow(/connection refused/);
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

      const { OnePasswordStore } = await import('aquaman-core');
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

      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();

      const result = await store.delete('anthropic', 'api_key');

      expect(deleteCalled).toBe(true);
      expect(result).toBe(true);
    });
  });

  describe('metadata key sanitization', () => {
    beforeEach(() => {
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
          return { status: 1, stdout: '', stderr: 'not found', pid: 4, signal: null, output: [] };
        }
        if (args?.[0] === 'item' && args?.[1] === 'create') {
          return { status: 0, stdout: '{}', stderr: '', pid: 5, signal: null, output: [] };
        }
        return { status: 0, stdout: '{}', stderr: '', pid: 6, signal: null, output: [] };
      });
    });

    it('rejects metadata keys with = sign', async () => {
      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();
      await expect(store.set('svc', 'key', 'val', { 'evil=inject': 'x' }))
        .rejects.toThrow('Invalid metadata key');
    });

    it('rejects metadata keys starting with -', async () => {
      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();
      await expect(store.set('svc', 'key', 'val', { '--vault': 'x' }))
        .rejects.toThrow('Invalid metadata key');
    });

    it('rejects metadata keys with op:// prefix', async () => {
      const { OnePasswordStore } = await import('aquaman-core');
      const store = new OnePasswordStore();
      await expect(store.set('svc', 'key', 'val', { 'op://vault': 'x' }))
        .rejects.toThrow('Invalid metadata key');
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

      const { OnePasswordStore } = await import('aquaman-core');
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

      const { OnePasswordStore } = await import('aquaman-core');
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

      const { OnePasswordStore } = await import('aquaman-core');
      expect(OnePasswordStore.isAvailable()).toBe(true);
    });
  });
});
