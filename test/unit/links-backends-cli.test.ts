/**
 * The 1Password and Bitwarden reads of an item aquaman did not write
 * (`readLinked`), and the Keychain one.
 *
 * `node:child_process` and `keytar` are mocked: no `op`, no `bw`, no real
 * keychain. What is checked is the exact argv each CLI would be run with
 * (every locator part is its own argument, none is an option) and how the
 * output is read. Behaviour against the real tools is not covered here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

const keytarMock = {
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
};
vi.mock('keytar', () => ({ default: keytarMock }));

import { OnePasswordStore } from '../../packages/proxy/src/core/credentials/backends/onepassword.js';
import { BitwardenStore } from '../../packages/proxy/src/core/credentials/backends/bitwarden.js';
import { KeychainStore } from '../../packages/proxy/src/core/credentials/store.js';
import { parseLocatorFor, type ParsedLocator } from '../../packages/proxy/src/core/credentials/links.js';

const mockSpawnSync = vi.mocked(spawnSync);

function locator(backend: Parameters<typeof parseLocatorFor>[0], text: string): ParsedLocator {
  const parsed = parseLocatorFor(backend, text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.locator;
}

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '', pid: 1, signal: null, output: [] }) as any;
const fail = (stderr: string) => ({ status: 1, stdout: '', stderr, pid: 1, signal: null, output: [] }) as any;

/** Calls made after the store was constructed, as [command, argv]. */
function callsAfter(n: number): Array<[string, string[]]> {
  return mockSpawnSync.mock.calls.slice(n).map((c) => [c[0] as string, c[1] as string[]]);
}

describe('OnePasswordStore.readLinked', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Constructor: `which op`, then `op account get`.
    mockSpawnSync.mockReturnValueOnce(ok('/usr/local/bin/op\n')).mockReturnValueOnce(ok('{}'));
  });

  it('runs `op read` with the reference as one argument and returns what it prints', () => {
    const store = new OnePasswordStore();
    mockSpawnSync.mockReturnValueOnce(ok('ghp_from_1password'));
    return expect(store.readLinked(locator('1password', 'op://Private/GitHub Token/API/credential'))).resolves.toBe('ghp_from_1password').then(() => {
      expect(callsAfter(2)).toEqual([['op', ['read', '--no-newline', 'op://Private/GitHub Token/API/credential']]]);
    });
  });

  it('passes the configured account after the reference', async () => {
    const store = new OnePasswordStore({ account: 'work' });
    mockSpawnSync.mockReturnValueOnce(ok('v'));
    await store.readLinked(locator('1password', 'op://Private/GitHub/token'));
    expect(callsAfter(2)).toEqual([['op', ['read', '--no-newline', 'op://Private/GitHub/token', '--account', 'work']]]);
  });

  it.each([
    '[ERROR] could not read secret: "GitHub" isn\'t an item in the "Private" vault',
    '[ERROR] item not found',
  ])('an item that is not there reads as null: %s', async (stderr) => {
    const store = new OnePasswordStore();
    mockSpawnSync.mockReturnValueOnce(fail(stderr));
    expect(await store.readLinked(locator('1password', 'op://Private/GitHub/token'))).toBeNull();
  });

  it('an empty field reads as null', async () => {
    const store = new OnePasswordStore();
    mockSpawnSync.mockReturnValueOnce(ok(''));
    expect(await store.readLinked(locator('1password', 'op://Private/GitHub/token'))).toBeNull();
  });

  it('any other failure is an error, never "not there"', async () => {
    const store = new OnePasswordStore();
    mockSpawnSync.mockReturnValueOnce(fail('[ERROR] authorization prompt dismissed'));
    await expect(store.readLinked(locator('1password', 'op://Private/GitHub/token'))).rejects.toThrow(/authorization prompt dismissed/);
  });

  it('an item aquaman wrote is not read under a second name, and `op` is not run', async () => {
    const store = new OnePasswordStore({ vault: 'aquaman' });
    await expect(store.readLinked(locator('1password', 'op://aquaman/aquaman-anthropic-api_key/credential'))).rejects.toThrow(/aquaman itself wrote/);
    expect(callsAfter(2)).toEqual([]);
    // The same item name in another vault is the user's own.
    mockSpawnSync.mockReturnValueOnce(ok('theirs'));
    expect(await store.readLinked(locator('1password', 'op://Private/aquaman-anthropic-api_key/credential'))).toBe('theirs');
  });
});

describe('BitwardenStore.readLinked', () => {
  const ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
  const item = {
    id: ID,
    name: 'GitHub',
    login: { username: 'octocat', password: 'ghp_from_bitwarden' },
    notes: 'a note',
    fields: [{ name: 'API Key', value: 'custom-from-bitwarden' }, { name: 'blank', value: '' }, null],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    // Constructor: `which bw`, then `bw status`.
    mockSpawnSync.mockReturnValueOnce(ok('/usr/local/bin/bw\n')).mockReturnValueOnce(ok(JSON.stringify({ status: 'unlocked' })));
  });

  it('by id: one `bw get item` and nothing else', async () => {
    const store = new BitwardenStore();
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify(item)));
    expect(await store.readLinked(locator('bitwarden', `bw://${ID}/password`))).toBe('ghp_from_bitwarden');
    expect(callsAfter(2)).toEqual([['bw', ['get', 'item', ID]]]);
  });

  it('by name: the name is one argument after --search, and only an exact match is used', async () => {
    const store = new BitwardenStore();
    mockSpawnSync
      .mockReturnValueOnce(ok(JSON.stringify([{ id: 'other-id', name: 'GitHub Enterprise' }, { id: ID, name: 'GitHub' }])))
      .mockReturnValueOnce(ok(JSON.stringify(item)));
    expect(await store.readLinked(locator('bitwarden', 'bw://GitHub/password'))).toBe('ghp_from_bitwarden');
    expect(callsAfter(2)).toEqual([
      ['bw', ['list', 'items', '--search', 'GitHub']],
      ['bw', ['get', 'item', ID]],
    ]);
  });

  it.each([
    ['username', 'octocat'],
    ['notes', 'a note'],
    ['API Key', 'custom-from-bitwarden'],
  ])('field %s', async (field, value) => {
    const store = new BitwardenStore();
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify(item)));
    expect(await store.readLinked(locator('bitwarden', `bw://${ID}/${field}`))).toBe(value);
  });

  it.each([
    ['a custom field that does not exist', 'nope', item],
    ['an empty custom field', 'blank', item],
    ['a password on an item with no login', 'password', { id: ID, name: 'Note', notes: 'x' }],
    ['a custom field on an item with no fields', 'API Key', { id: ID, name: 'Note' }],
  ])('%s reads as null', async (_name, field, full) => {
    const store = new BitwardenStore();
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify(full)));
    expect(await store.readLinked(locator('bitwarden', `bw://${ID}/${field}`))).toBeNull();
  });

  it('no item of that name reads as null, without asking for any item', async () => {
    const store = new BitwardenStore();
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify([{ id: 'x', name: 'GitHub Enterprise' }])));
    expect(await store.readLinked(locator('bitwarden', 'bw://GitHub/password'))).toBeNull();
    expect(callsAfter(2)).toHaveLength(1);
  });

  it('two items of that name are refused, and the error says to link by id', async () => {
    const store = new BitwardenStore();
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify([{ id: 'a', name: 'GitHub' }, { id: 'b', name: 'GitHub' }])));
    await expect(store.readLinked(locator('bitwarden', 'bw://GitHub/password'))).rejects.toThrow(/2 Bitwarden items are named "GitHub".*bw:\/\/<item id>\/password/);
  });

  it('an id that is not in the vault reads as null; another failure is an error', async () => {
    const store = new BitwardenStore();
    mockSpawnSync.mockReturnValueOnce(fail('Not found.'));
    expect(await store.readLinked(locator('bitwarden', `bw://${ID}/password`))).toBeNull();
    mockSpawnSync.mockReturnValueOnce(fail('Vault is locked.'));
    await expect(store.readLinked(locator('bitwarden', `bw://${ID}/password`))).rejects.toThrow(/vault is locked/i);
  });

  it('an item aquaman wrote is not read under a second name, by name or by id', async () => {
    const store = new BitwardenStore();
    const own = { id: ID, name: 'aquaman::anthropic::api_key', login: { password: 'sk-ant-own' } };
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify(own)));
    await expect(store.readLinked(locator('bitwarden', `bw://${ID}/password`))).rejects.toThrow(/aquaman itself wrote/);
    mockSpawnSync.mockReturnValueOnce(ok(JSON.stringify([own]))).mockReturnValueOnce(ok(JSON.stringify(own)));
    await expect(store.readLinked(locator('bitwarden', 'bw://aquaman::anthropic::api_key/password'))).rejects.toThrow(/aquaman itself wrote/);
  });
});

describe('KeychainStore.readLinked', () => {
  beforeEach(() => vi.resetAllMocks());

  it('reads the generic password for the service and account, as written, and nothing else', async () => {
    keytarMock.getPassword.mockResolvedValueOnce('ghp_from_keychain');
    const store = new KeychainStore();
    expect(await store.readLinked(locator('keychain', 'keychain://com.example%2Fapi/alice@example.com'))).toBe('ghp_from_keychain');
    expect(keytarMock.getPassword.mock.calls).toEqual([['com.example/api', 'alice@example.com']]);
    expect(keytarMock.setPassword).not.toHaveBeenCalled();
    expect(keytarMock.deletePassword).not.toHaveBeenCalled();
    expect(keytarMock.findCredentials).not.toHaveBeenCalled();
  });

  it('an item that is not there reads as null', async () => {
    keytarMock.getPassword.mockResolvedValueOnce(null);
    expect(await new KeychainStore().readLinked(locator('keychain', 'keychain://github.com/alice'))).toBeNull();
  });
});
