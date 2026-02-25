/**
 * Tests for systemd-creds credential backend
 *
 * Primary tests are mocked so they run on any CI environment.
 * Optional integration tests can run on Linux with systemd >= 256.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn()
}));

describe('SystemdCredsStore (mocked)', () => {
  let testDir: string;
  const mockExecFile = vi.mocked(execFile);
  const mockExecFileSync = vi.mocked(execFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();

    testDir = path.join(
      os.tmpdir(),
      `aquaman-systemd-creds-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.mkdirSync(testDir, { recursive: true });

    mockExecFileSync.mockReturnValue('systemd 258 (258.1)\n' as any);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  function installDefaultExecFileMock() {
    const encryptedByName = new Map<string, string>();

    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
      if (typeof opts === 'function') {
        cb = opts;
        opts = {};
      }

      const argv = args as string[];
      const hasUser = argv[0] === '--user';
      const op = argv[1];
      const nameArg = argv.find((a) => a.startsWith('--name='));
      const name = nameArg ? nameArg.slice('--name='.length) : '';

      if (!hasUser) {
        cb(new Error('missing --user'), '', 'missing --user');
        return {} as any;
      }

      if (cmd !== 'systemd-creds') {
        cb(new Error('wrong command'), '', 'wrong command');
        return {} as any;
      }

      if (op === 'encrypt') {
        const input = (opts?.input ?? '').toString();
        encryptedByName.set(name, input);
        cb(null, `ENC:${name}:${Buffer.from(input).toString('base64')}` , '');
        return {} as any;
      }

      if (op === 'decrypt') {
        const filePath = argv[3];
        if (!fs.existsSync(filePath)) {
          cb(new Error('missing file'), '', 'missing file');
          return {} as any;
        }
        const fallback = encryptedByName.get(name) ?? '';
        cb(null, fallback, '');
        return {} as any;
      }

      cb(new Error(`unexpected op ${op}`), '', 'unexpected');
      return {} as any;
    });
  }

  it('reports availability when systemd >= 256', async () => {
    const { isSystemdCredsAvailable } = await import('aquaman-core');
    expect(isSystemdCredsAvailable()).toBe(true);
  });

  it('reports unavailable when version < 256', async () => {
    mockExecFileSync.mockReturnValueOnce('systemd 255\n' as any);
    const { isSystemdCredsAvailable } = await import('aquaman-core');
    expect(isSystemdCredsAvailable()).toBe(false);
  });

  it('stores and retrieves a credential', async () => {
    installDefaultExecFileMock();
    const { SystemdCredsStore } = await import('aquaman-core');
    const store = new SystemdCredsStore({ credsDir: testDir });

    await store.set('anthropic', 'api_key', 'sk-ant-123');
    const value = await store.get('anthropic', 'api_key');

    expect(value).toBe('sk-ant-123');
    expect(mockExecFile).toHaveBeenCalled();
  });

  it('passes secret via stdin and not argv', async () => {
    let seenInput = '';
    let seenArgs: string[] = [];

    mockExecFile.mockImplementation((cmd: any, args: any, opts: any, cb: any) => {
      if (typeof opts === 'function') {
        cb = opts;
        opts = {};
      }
      seenArgs = args;

      const stdin = {
        write: (chunk: string) => { seenInput += chunk; },
        end: () => { /* noop */ }
      };

      cb(null, 'ENC', '');
      return { stdin } as any;
    });

    const { SystemdCredsStore } = await import('aquaman-core');
    const store = new SystemdCredsStore({ credsDir: testDir });
    const secret = 'very-secret-value';

    await store.set('anthropic', 'api_key', secret);

    expect(seenArgs.join(' ')).not.toContain(secret);
    expect(seenInput).toContain(secret);
  });

  it('uses createCredentialStore factory', async () => {
    installDefaultExecFileMock();
    const { createCredentialStore } = await import('aquaman-core');
    const store = await createCredentialStore({ backend: 'systemd-creds', systemdCredsDir: testDir });

    await store.set('openai', 'api_key', 'sk-openai-123');
    expect(await store.get('openai', 'api_key')).toBe('sk-openai-123');
  });

  it('rejects invalid names (path traversal defense)', async () => {
    installDefaultExecFileMock();
    const { SystemdCredsStore } = await import('aquaman-core');
    const store = new SystemdCredsStore({ credsDir: testDir });

    await expect(store.set('../evil', 'api_key', 'x')).rejects.toThrow('Invalid service name');
    await expect(store.set('anthropic', '../key', 'x')).rejects.toThrow('Invalid key name');
  });

  it('surfaces encrypt failures clearly', async () => {
    mockExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb(new Error('command not found'), '', 'command not found');
      return {} as any;
    });

    const { SystemdCredsStore } = await import('aquaman-core');
    const store = new SystemdCredsStore({ credsDir: testDir });

    await expect(store.set('anthropic', 'api_key', 'x')).rejects.toThrow('Failed to encrypt credential anthropic/api_key');
  });

  it('supports list/delete/exists', async () => {
    installDefaultExecFileMock();
    const { SystemdCredsStore } = await import('aquaman-core');
    const store = new SystemdCredsStore({ credsDir: testDir });

    await store.set('svc-a', 'k1', 'v1');
    await store.set('svc-b', 'k2', 'v2');

    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(await store.exists('svc-a', 'k1')).toBe(true);

    expect(await store.delete('svc-a', 'k1')).toBe(true);
    expect(await store.exists('svc-a', 'k1')).toBe(false);
  });
});
