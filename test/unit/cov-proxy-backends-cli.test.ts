/**
 * Credential backends that drive a vendor CLI (Bitwarden `bw`, 1Password
 * `op`, Keeper Commander, `systemd-creds`): branch and error paths.
 *
 * No vendor CLI is run. `node:child_process` is mocked and every call is
 * answered by a script the test supplies, so the exact commands and the
 * channel a secret travels on (stdin, never argv) can be asserted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const cp = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => cp);

import { BitwardenStore } from '../../packages/proxy/src/core/credentials/backends/bitwarden.js';
import { OnePasswordStore, createOnePasswordStore } from '../../packages/proxy/src/core/credentials/backends/onepassword.js';
import { KeeperStore, keeperTitle } from '../../packages/proxy/src/core/credentials/backends/keeper.js';
import {
  SystemdCredsStore,
  createSystemdCredsStore,
  isSystemdCredsAvailable,
} from '../../packages/proxy/src/core/credentials/backends/systemd-creds.js';
import { createCredentialStore } from '../../packages/proxy/src/core/credentials/store.js';

type Reply = { status?: number | null; stdout?: string; stderr?: string; error?: Error } | Error;
type Handler = (cmd: string, args: string[], opts: { input?: string; env?: Record<string, string> }) => Reply | undefined;

interface Call { cmd: string; args: string[]; input?: string; env?: Record<string, string> }
let calls: Call[] = [];

/** Answer every spawnSync through `handler`; an Error reply is thrown, as when the binary cannot be started. */
function script(handler: Handler): void {
  cp.spawnSync.mockImplementation((cmd: string, args: string[] = [], opts: { input?: string; env?: Record<string, string> } = {}) => {
    calls.push({ cmd, args, input: opts.input, env: opts.env });
    const reply = handler(cmd, args, opts) ?? { status: 0, stdout: '' };
    if (reply instanceof Error) throw reply;
    return { status: reply.status === undefined ? 0 : reply.status, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', error: reply.error, signal: null, pid: 1, output: [] };
  });
}

const ok = (stdout = ''): Reply => ({ status: 0, stdout });
const fail = (stderr: string, status = 1): Reply => ({ status, stderr });
const json = (value: unknown): Reply => ok(JSON.stringify(value));

beforeEach(() => {
  calls = [];
  cp.spawnSync.mockReset();
  cp.execFile.mockReset();
  cp.execFileSync.mockReset();
  delete process.env['BW_SESSION'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['BW_SESSION'];
});

// ---------------------------------------------------------------------------

describe('BitwardenStore: error and branch paths', () => {
  const FOLDER_ID = 'folder-1';

  /** A `bw` that is installed and unlocked; `over` answers first, the defaults after. */
  function bw(over: Handler = () => undefined): void {
    script((cmd, args, opts) => {
      if (cmd === 'which') return ok('/usr/local/bin/bw\n');
      const custom = over(cmd, args, opts);
      if (custom) return custom;
      if (args[0] === 'status') return json({ status: 'unlocked' });
      if (args[0] === 'list' && args[1] === 'folders') return json([{ id: FOLDER_ID, name: 'aquaman' }]);
      if (args[0] === 'list' && args[1] === 'items') return json([]);
      return ok('');
    });
  }
  const bwCalls = (...prefix: string[]) => calls.filter((c) => c.cmd === 'bw' && prefix.every((p, i) => c.args[i] === p));

  describe('construction', () => {
    it('reports an unreadable status as a broken CLI', () => {
      bw((_c, args) => (args[0] === 'status' ? ok('not json at all') : undefined));
      expect(() => new BitwardenStore()).toThrow('Failed to check Bitwarden status. Is the CLI installed correctly?');
    });

    it('surfaces a failing `bw status` with what the CLI printed', () => {
      bw((_c, args) => (args[0] === 'status' ? fail('mac failed.') : undefined));
      expect(() => new BitwardenStore()).toThrow('bw command failed: mac failed.');
    });

    it('falls back to stdout, then to "Unknown error", when the CLI prints nothing on stderr', () => {
      bw((_c, args) => (args[0] === 'status' ? { status: 1, stdout: 'from stdout' } : undefined));
      expect(() => new BitwardenStore()).toThrow('bw command failed: from stdout');
      bw((_c, args) => (args[0] === 'status' ? { status: 1 } : undefined));
      expect(() => new BitwardenStore()).toThrow('bw command failed: Unknown error');
    });

    it('reports a `bw` that cannot be started', () => {
      bw((cmd) => (cmd === 'bw' ? new Error('spawnSync bw EACCES') : undefined));
      expect(() => new BitwardenStore()).toThrow('Failed to run bw command: Error: spawnSync bw EACCES');
    });

    it('reports a missing CLI when `which` itself cannot run', () => {
      script(() => new Error('spawnSync which ENOENT'));
      expect(() => new BitwardenStore()).toThrow('Bitwarden CLI (bw) not found');
    });

    it('passes BW_SESSION to the CLI once the vault is unlocked', async () => {
      process.env['BW_SESSION'] = 'session-abc';
      bw();
      const store = new BitwardenStore();
      await store.list();
      expect(bwCalls('list', 'items')[0]!.env?.['BW_SESSION']).toBe('session-abc');
    });
  });

  describe('get', () => {
    it('returns null when the search result cannot be parsed', async () => {
      bw((_c, args) => (args[0] === 'list' && args[1] === 'items' ? ok('<html>') : undefined));
      expect(await new BitwardenStore().get('github', 'token')).toBeNull();
    });

    it('returns null when the item is found but cannot be read', async () => {
      bw((_c, args) => {
        if (args[0] === 'list' && args[1] === 'items') return json([{ id: 'i1', name: 'aquaman::github::token' }]);
        if (args[0] === 'get') return fail('Item could not be decrypted.');
        return undefined;
      });
      expect(await new BitwardenStore().get('github', 'token')).toBeNull();
    });

    it('returns null for an item with neither a password nor notes', async () => {
      bw((_c, args) => {
        if (args[0] === 'list' && args[1] === 'items') return json([{ id: 'i1', name: 'aquaman::github::token' }]);
        if (args[0] === 'get') return json({ login: {} });
        return undefined;
      });
      expect(await new BitwardenStore().get('github', 'token')).toBeNull();
    });

    it('a `bw` that cannot be started mid-session reads as "not found", not as a value', async () => {
      let started = false;
      bw((cmd, args) => {
        if (cmd === 'bw' && args[0] === 'status') { started = true; return undefined; }
        return started && cmd === 'bw' ? new Error('spawnSync bw ENOMEM') : undefined;
      });
      const store = new BitwardenStore();
      expect(await store.get('github', 'token')).toBeNull();
      expect(await store.exists('github', 'token')).toBe(false);
    });
  });

  describe('set', () => {
    it('looks the folder up once and reuses its id, and ignores a same-named item in another folder', async () => {
      bw((_c, args) => (args[0] === 'list' && args[1] === 'items'
        ? json([{ id: 'elsewhere', name: 'aquaman::github::token', folderId: 'other-folder' }])
        : undefined));
      const store = new BitwardenStore();
      await store.set('github', 'token', 'ghp_one');
      await store.set('github', 'other', 'ghp_two');
      expect(bwCalls('list', 'folders')).toHaveLength(1);
      // Created, not edited: the item in the other folder is not ours.
      expect(bwCalls('edit')).toHaveLength(0);
      const creates = bwCalls('create', 'item');
      expect(creates).toHaveLength(2);
      const item = JSON.parse(Buffer.from(creates[0]!.input!, 'base64').toString('utf-8'));
      expect(item).toMatchObject({ type: 1, name: 'aquaman::github::token', folderId: FOLDER_ID, login: { password: 'ghp_one' } });
      // The value travels on stdin, never on argv.
      expect(JSON.stringify(calls.map((c) => c.args))).not.toContain('ghp_one');
      expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(Buffer.from('ghp_one').toString('base64'));
    });

    it('fails with the folder name when the folder can be neither found nor created', async () => {
      bw((_c, args) => {
        if (args[0] === 'list' && args[1] === 'folders') return fail('network error');
        if (args[0] === 'create' && args[1] === 'folder') return fail('permission denied');
        return undefined;
      });
      await expect(new BitwardenStore({ folder: 'team' }).set('github', 'token', 'v'))
        .rejects.toThrow('Failed to create folder "team": Error: bw command failed: permission denied');
      expect(bwCalls('create', 'item')).toHaveLength(0);
    });

    it('updates an existing item that has no login section, writing metadata to notes', async () => {
      bw((_c, args) => {
        if (args[0] === 'list' && args[1] === 'items') return json([{ id: 'i1', name: 'aquaman::github::token', folderId: FOLDER_ID }]);
        if (args[0] === 'get') return json({ id: 'i1', name: 'aquaman::github::token', notes: 'old' });
        return undefined;
      });
      await new BitwardenStore().set('github', 'token', 'ghp_new', { owner: 'ci', env: 'prod' });
      const edits = bwCalls('edit', 'item');
      expect(edits).toHaveLength(1);
      expect(edits[0]!.args).toEqual(['edit', 'item', 'i1']);
      const edited = JSON.parse(Buffer.from(edits[0]!.input!, 'base64').toString('utf-8'));
      expect(edited.login).toEqual({ password: 'ghp_new' });
      expect(edited.notes).toBe('owner: ci\nenv: prod\n');
      expect(bwCalls('create', 'item')).toHaveLength(0);
    });

    it('keeps the existing notes when no metadata is given', async () => {
      bw((_c, args) => {
        if (args[0] === 'list' && args[1] === 'items') return json([{ id: 'i1', name: 'aquaman::github::token', folderId: FOLDER_ID }]);
        if (args[0] === 'get') return json({ id: 'i1', login: { password: 'old', username: 'u' }, notes: 'keep me' });
        return undefined;
      });
      await new BitwardenStore().set('github', 'token', 'ghp_new');
      const edited = JSON.parse(Buffer.from(bwCalls('edit', 'item')[0]!.input!, 'base64').toString('utf-8'));
      expect(edited.login).toEqual({ password: 'ghp_new', username: 'u' });
      expect(edited.notes).toBe('keep me');
    });

    it('reports a failed update, and a failed create, without the value', async () => {
      bw((_c, args) => {
        if (args[0] === 'list' && args[1] === 'items') return json([{ id: 'i1', name: 'aquaman::github::token', folderId: FOLDER_ID }]);
        if (args[0] === 'get') return json({ id: 'i1', login: {} });
        if (args[0] === 'edit') return fail('Item is read-only');
        return undefined;
      });
      const update = new BitwardenStore().set('github', 'token', 'ghp_secret_value');
      await expect(update).rejects.toThrow('Failed to update credential: Error: bw command failed: Item is read-only');
      await update.catch((e: Error) => expect(e.message).not.toContain('ghp_secret_value'));

      bw((_c, args) => (args[0] === 'create' && args[1] === 'item' ? fail('Organization quota') : undefined));
      const create = new BitwardenStore().set('github', 'token', 'ghp_secret_value');
      await expect(create).rejects.toThrow('Failed to create credential: Error: bw command failed: Organization quota');
      await create.catch((e: Error) => expect(e.message).not.toContain('ghp_secret_value'));
    });

    it('a failed sync after a write is not an error', async () => {
      bw((_c, args) => (args[0] === 'sync' ? fail('offline') : undefined));
      await expect(new BitwardenStore().set('github', 'token', 'v')).resolves.toBeUndefined();
      expect(bwCalls('create', 'item')).toHaveLength(1);
    });
  });

  describe('delete', () => {
    const found: Handler = (_c, args) => (args[0] === 'list' && args[1] === 'items' ? json([{ id: 'i1', name: 'aquaman::github::token' }]) : undefined);

    it('returns false when the item vanished between the search and the delete', async () => {
      bw((c, args, o) => (args[0] === 'delete' ? fail('Item not found.') : found(c, args, o)));
      expect(await new BitwardenStore().delete('github', 'token')).toBe(false);
    });

    it('rethrows any other failure', async () => {
      bw((c, args, o) => (args[0] === 'delete' ? fail('Request failed.') : found(c, args, o)));
      await expect(new BitwardenStore().delete('github', 'token')).rejects.toThrow('bw command failed: Request failed.');
    });

    it('a failed sync after a delete is not an error', async () => {
      bw((c, args, o) => (args[0] === 'sync' ? fail('offline') : found(c, args, o)));
      expect(await new BitwardenStore().delete('github', 'token')).toBe(true);
      expect(bwCalls('delete', 'item')[0]!.args).toEqual(['delete', 'item', 'i1']);
    });
  });

  describe('list', () => {
    it('limits the listing to the folder once its id is known, and skips items that are not aquaman\'s', async () => {
      bw((_c, args) => (args[0] === 'list' && args[1] === 'items' && args.includes('--folderid')
        ? json([
            { name: 'aquaman::github::token' },
            { name: 'aquaman::onlyservice' },
            { name: 'someone-else' },
            { name: 'aquaman::slack::bot::token' },
          ])
        : undefined));
      const store = new BitwardenStore();
      await store.set('seed', 'key', 'v'); // resolves the folder id
      const listed = await store.list();
      expect(listed).toEqual([
        { service: 'github', key: 'token' },
        { service: 'slack', key: 'bot::token' },
      ]);
      const listCall = calls.filter((c) => c.args[0] === 'list' && c.args[1] === 'items').pop()!;
      expect(listCall.args).toEqual(['list', 'items', '--folderid', FOLDER_ID]);
    });

    it('returns an empty list for "not found" and rethrows anything else', async () => {
      bw((_c, args) => (args[0] === 'list' && args[1] === 'items' ? fail('Folder not found.') : undefined));
      expect(await new BitwardenStore().list()).toEqual([]);
      bw((_c, args) => (args[0] === 'list' && args[1] === 'items' ? fail('Request failed.') : undefined));
      await expect(new BitwardenStore().list()).rejects.toThrow('bw command failed: Request failed.');
    });
  });

  describe('isAvailable / isUnlocked', () => {
    it('isAvailable is false when `bw status` fails or the CLI cannot be started', () => {
      bw((_c, args) => (args[0] === 'status' ? fail('boom') : undefined));
      expect(BitwardenStore.isAvailable()).toBe(false);
      script(() => new Error('spawnSync ENOENT'));
      expect(BitwardenStore.isAvailable()).toBe(false);
      bw((_c, args) => (args[0] === 'status' ? ok('not json') : undefined));
      expect(BitwardenStore.isAvailable()).toBe(false);
    });

    it('isUnlocked is false when the CLI cannot be started or prints something unreadable', () => {
      script(() => new Error('spawnSync ENOENT'));
      expect(BitwardenStore.isUnlocked()).toBe(false);
      bw((_c, args) => (args[0] === 'status' ? ok('not json') : undefined));
      expect(BitwardenStore.isUnlocked()).toBe(false);
      bw((_c, args) => (args[0] === 'status' ? json({ status: 'unauthenticated' }) : undefined));
      expect(BitwardenStore.isUnlocked()).toBe(false);
    });
  });

  it('createCredentialStore builds it with the configured folder, organization and collection', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    bw((_c, args) => (args[0] === 'create' && args[1] === 'folder' ? json({ id: 'folder-team' }) : undefined));
    const store = await createCredentialStore({
      backend: 'bitwarden',
      bitwardenFolder: 'team',
      bitwardenOrganizationId: 'org-1',
      bitwardenCollectionId: 'col-1',
    });
    expect(store).toBeInstanceOf(BitwardenStore);
    expect((store as BitwardenStore).getFolder()).toBe('team');
    await store.set('github', 'token', 'v');
    // The folder did not exist under that name, so it was created.
    expect(bwCalls('create', 'folder')).toHaveLength(1);
    const created = JSON.parse(Buffer.from(bwCalls('create', 'item')[0]!.input!, 'base64').toString('utf-8'));
    expect(created.folderId).toBe('folder-team');
    expect(created.organizationId).toBe('org-1');
    expect(created.collectionIds).toEqual(['col-1']);
  });
});

// ---------------------------------------------------------------------------

describe('OnePasswordStore: error and branch paths', () => {
  function op(over: Handler = () => undefined): void {
    script((cmd, args, opts) => {
      if (cmd === 'which') return ok('/usr/local/bin/op\n');
      return over(cmd, args, opts) ?? ok('');
    });
  }
  const opCalls = (...prefix: string[]) => calls.filter((c) => c.cmd === 'op' && prefix.every((p, i) => c.args[i] === p));
  const notFound = fail('[ERROR] "aquaman-github-token" isn\'t an item in the "aquaman" vault.');

  it('reports a missing CLI when `which` cannot run, and "not signed in" when `op` cannot be started', () => {
    script(() => new Error('spawnSync which ENOENT'));
    expect(() => new OnePasswordStore()).toThrow('1Password CLI (op) not found');
    op((cmd) => (cmd === 'op' ? new Error('spawnSync op EACCES') : undefined));
    expect(() => new OnePasswordStore()).toThrow('Not signed in to 1Password. Run: op signin');
  });

  it('adds --account to every command when an account is configured', async () => {
    op((_c, args) => (args[0] === 'item' && args[1] === 'get' ? json({ value: 'sk-123' }) : undefined));
    const store = createOnePasswordStore({ vault: 'work', account: 'team.1password.com' });
    expect(store.getVault()).toBe('work');
    expect(await store.get('anthropic', 'api_key')).toBe('sk-123');
    for (const c of calls.filter((x) => x.cmd === 'op')) {
      expect(c.args.slice(-2)).toEqual(['--account', 'team.1password.com']);
    }
    expect(opCalls('item', 'get')[0]!.args).toEqual([
      'item', 'get', 'aquaman-anthropic-api_key', '--vault', 'work', '--fields', 'credential', '--format', 'json',
      '--account', 'team.1password.com',
    ]);
  });

  it('get returns null for an item with an empty value, and rethrows a failure to start `op`', async () => {
    op((_c, args) => (args[0] === 'item' ? json({ value: '' }) : undefined));
    expect(await new OnePasswordStore().get('github', 'token')).toBeNull();
    expect(await new OnePasswordStore().exists('github', 'token')).toBe(false);

    let ready = false;
    op((cmd, args) => {
      if (cmd === 'op' && args[0] === 'account') { ready = true; return undefined; }
      return ready && cmd === 'op' ? new Error('spawnSync op ETIMEDOUT') : undefined;
    });
    await expect(new OnePasswordStore().get('github', 'token')).rejects.toThrow('Failed to run op command: Error: spawnSync op ETIMEDOUT');
  });

  it('exists is true only when the item has a value', async () => {
    op((_c, args) => (args[0] === 'item' ? json({ value: 'v' }) : undefined));
    expect(await new OnePasswordStore().exists('github', 'token')).toBe(true);
    op((_c, args) => (args[0] === 'item' ? notFound : undefined));
    expect(await new OnePasswordStore().exists('github', 'token')).toBe(false);
  });

  it('creates the vault when it does not exist, then the item', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    op((_c, args) => {
      if (args[0] === 'vault' && args[1] === 'get') return fail('"aquaman" isn\'t a vault in this account.');
      if (args[0] === 'item' && args[1] === 'get') return notFound;
      return undefined;
    });
    await new OnePasswordStore().set('github', 'token', 'ghp_value');
    expect(opCalls('vault', 'create')[0]!.args).toEqual(['vault', 'create', 'aquaman']);
    expect(log).toHaveBeenCalledWith('Created 1Password vault: aquaman');
    expect(opCalls('item', 'create')).toHaveLength(1);
    // The value is in the template file, never on argv.
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain('ghp_value');
  });

  it('fails with the vault name when the vault can be neither found nor created, and writes nothing', async () => {
    op((_c, args) => (args[0] === 'vault' ? fail('You do not have permission') : undefined));
    await expect(new OnePasswordStore({ vault: 'locked' }).set('github', 'token', 'v'))
      .rejects.toThrow('Failed to create vault "locked": Error: op command failed: You do not have permission');
    expect(opCalls('item')).toHaveLength(0);
  });

  it('writes metadata as extra STRING fields beside the concealed credential', async () => {
    let template: any;
    op((_c, args) => {
      if (args[0] === 'item' && args[1] === 'get') return notFound;
      if (args[0] === 'item' && args[1] === 'create') {
        template = JSON.parse(fs.readFileSync(args[args.indexOf('--template') + 1]!, 'utf-8'));
      }
      return undefined;
    });
    await new OnePasswordStore().set('github', 'token', 'ghp_value', { owner: 'ci', env: 'prod' });
    expect(template).toEqual({
      title: 'aquaman-github-token',
      category: 'API_CREDENTIAL',
      tags: ['aquaman', 'github'],
      fields: [
        { id: 'credential', type: 'CONCEALED', value: 'ghp_value' },
        { id: 'owner', type: 'STRING', value: 'ci' },
        { id: 'env', type: 'STRING', value: 'prod' },
      ],
    });
  });

  it('delete returns false for a missing item and rethrows anything else', async () => {
    op((_c, args) => (args[0] === 'item' && args[1] === 'delete' ? notFound : undefined));
    expect(await new OnePasswordStore().delete('github', 'token')).toBe(false);
    op((_c, args) => (args[0] === 'item' && args[1] === 'delete' ? fail('authorization timeout') : undefined));
    await expect(new OnePasswordStore().delete('github', 'token')).rejects.toThrow('op command failed: authorization timeout');
  });

  it('list skips items that are not aquaman\'s, filters by service, and tags the query', async () => {
    op((_c, args) => (args[0] === 'item' && args[1] === 'list'
      ? json([
          { title: 'aquaman-github-token' },
          { title: 'aquaman-slack-bot-token' },
          { title: 'aquaman-lonely' },
          { title: 'Personal login' },
        ])
      : undefined));
    const store = new OnePasswordStore();
    expect(await store.list()).toEqual([
      { service: 'github', key: 'token' },
      { service: 'slack', key: 'bot-token' },
    ]);
    expect(await store.list('slack')).toEqual([{ service: 'slack', key: 'bot-token' }]);
    const tagArgs = opCalls('item', 'list').map((c) => c.args[c.args.indexOf('--tags') + 1]);
    expect(tagArgs).toEqual(['aquaman', 'aquaman,slack']);
  });

  it('list returns an empty list when the vault has no matching items, and rethrows anything else', async () => {
    op((_c, args) => (args[0] === 'item' && args[1] === 'list' ? fail('vault "aquaman" not found') : undefined));
    expect(await new OnePasswordStore().list()).toEqual([]);
    op((_c, args) => (args[0] === 'item' && args[1] === 'list' ? fail('session expired') : undefined));
    await expect(new OnePasswordStore().list()).rejects.toThrow('op command failed: session expired');
  });

  it('isAvailable is false when the CLI cannot be started', () => {
    script(() => new Error('spawnSync ENOENT'));
    expect(OnePasswordStore.isAvailable()).toBe(false);
  });

  it('createCredentialStore builds it with the configured vault and account', async () => {
    op();
    const store = await createCredentialStore({ backend: '1password', onePasswordVault: 'team-vault', onePasswordAccount: 'acme' });
    expect(store).toBeInstanceOf(OnePasswordStore);
    expect((store as OnePasswordStore).getVault()).toBe('team-vault');
    expect(opCalls('account', 'get')[0]!.args).toEqual(['account', 'get', '--account', 'acme']);
  });
});

// ---------------------------------------------------------------------------

describe('KeeperStore: error paths', () => {
  const FOLDER = 'FolderUid0000000000000';
  const saved = { uid: process.env['AQUAMAN_KEEPER_FOLDER_UID'], cfg: process.env['AQUAMAN_KEEPER_CONFIG'] };

  afterEach(() => {
    for (const [name, v] of [['AQUAMAN_KEEPER_FOLDER_UID', saved.uid], ['AQUAMAN_KEEPER_CONFIG', saved.cfg]] as const) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
  });

  function keeper(over: Handler = () => undefined): void {
    script((cmd, args, opts) => {
      if (cmd === 'which') return ok('/usr/local/bin/keeper\n');
      return over(cmd, args, opts) ?? ok('');
    });
  }
  const folderJson = (records: Array<{ record_uid: string; record_name: string }>) => json({ records });

  it('refuses to construct when Commander is not installed', () => {
    script((cmd) => (cmd === 'which' ? fail('', 1) : undefined));
    expect(() => new KeeperStore({ folderUid: FOLDER })).toThrow('Keeper Commander (keeper) not found. Install: pip install keepercommander');
    expect(calls[0]).toMatchObject({ cmd: 'which', args: ['keeper'] });
  });

  it('isAvailable is false when `which` itself cannot run', () => {
    script(() => new Error('spawnSync which ENOENT'));
    expect(KeeperStore.isAvailable()).toBe(false);
    expect(KeeperStore.isAvailable('keeper-custom')).toBe(false);
  });

  it('reports a Commander that cannot be started, and one that times out', async () => {
    keeper((cmd) => (cmd === 'keeper' ? { status: null, error: new Error('spawnSync keeper ETIMEDOUT') } : undefined));
    await expect(new KeeperStore({ folderUid: FOLDER }).get('github', 'token')).rejects.toThrow('keeper failed to run: spawnSync keeper ETIMEDOUT');
  });

  it('says what the folder UID should be when Commander does not print folder JSON', async () => {
    keeper((cmd) => (cmd === 'keeper' ? ok('Record UID: abc\nTitle: not a folder\n') : undefined));
    await expect(new KeeperStore({ folderUid: FOLDER }).list())
      .rejects.toThrow(`keeper get ${FOLDER}: expected folder JSON. Is keeperFolderUid a folder UID?`);
  });

  it('a failed write reports the exit code only, never what Commander printed', async () => {
    const value = 'ghp_keeper_secret_value';
    const encoded = Buffer.from(value).toString('base64');
    keeper((cmd, args) => {
      if (cmd !== 'keeper') return undefined;
      if (args.includes('-')) return { status: 3, stdout: `record-add ... password=$BASE64:${encoded}`, stderr: `bad line: ${encoded}` };
      return folderJson([]);
    });
    const attempt = new KeeperStore({ folderUid: FOLDER }).set('github', 'token', value);
    await expect(attempt).rejects.toThrow('keeper write failed (exit 3). Run `aquaman doctor` to check the Keeper session.');
    await attempt.catch((e: Error) => {
      expect(e.message).not.toContain(encoded);
      expect(e.message).not.toContain(value);
    });
    // The value went over stdin, base64-encoded, and never on argv.
    const write = calls.find((c) => c.cmd === 'keeper' && c.args.includes('-'))!;
    expect(write.input).toContain(`password=$BASE64:${encoded}`);
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(encoded);
  });

  it('reports a Commander that cannot be started for the write', async () => {
    keeper((cmd, args) => {
      if (cmd !== 'keeper') return undefined;
      if (args.includes('-')) return { status: null, error: new Error('spawnSync keeper ENOENT') };
      return folderJson([]);
    });
    await expect(new KeeperStore({ folderUid: FOLDER }).set('github', 'token', 'v')).rejects.toThrow('keeper failed to run: spawnSync keeper ENOENT');
  });

  it('fails when the value read back is not the value written', async () => {
    let written = false;
    keeper((cmd, args) => {
      if (cmd !== 'keeper') return undefined;
      if (args.includes('-')) { written = true; return ok(''); }
      if (args.includes('password')) return ok('something-else\n');
      return folderJson(written ? [{ record_uid: 'RecordUid000000000000', record_name: keeperTitle('github', 'token') }] : []);
    });
    await expect(new KeeperStore({ folderUid: FOLDER }).set('github', 'token', 'ghp_expected'))
      .rejects.toThrow('Keeper did not store github/token as written; check the record in Keeper');
  });

  it('refuses an empty value before running anything', async () => {
    keeper();
    const store = new KeeperStore({ folderUid: FOLDER });
    calls = [];
    await expect(store.set('github', 'token', '')).rejects.toThrow('Keeper backend cannot store an empty value');
    expect(calls).toEqual([]);
  });

  it('createCredentialStore takes the folder UID and config path from the environment', async () => {
    process.env['AQUAMAN_KEEPER_FOLDER_UID'] = FOLDER;
    process.env['AQUAMAN_KEEPER_CONFIG'] = '/tmp/keeper-config.json';
    keeper((cmd) => (cmd === 'keeper' ? folderJson([]) : undefined));
    const store = await createCredentialStore({ backend: 'keeper' });
    expect(store).toBeInstanceOf(KeeperStore);
    expect(await store.list()).toEqual([]);
    const get = calls.find((c) => c.cmd === 'keeper')!;
    expect(get.args).toEqual(['--batch-mode', '--config', '/tmp/keeper-config.json', 'get', FOLDER, '--format', 'json']);
  });

  it('createCredentialStore refuses the keeper backend with no folder UID', async () => {
    delete process.env['AQUAMAN_KEEPER_FOLDER_UID'];
    keeper();
    await expect(createCredentialStore({ backend: 'keeper' })).rejects.toThrow('Keeper backend needs the UID of the folder');
  });
});

// ---------------------------------------------------------------------------

describe('SystemdCredsStore: error and branch paths', () => {
  let dir: string;
  let stdinSeen: string[];
  let execCalls: Array<{ cmd: string; args: string[] }>;
  let failDecrypt: string | null;
  let appendNewline: boolean;

  /** A reversible stand-in for systemd-creds: "encrypts" by base64, reads the plaintext from stdin. */
  function installSystemdCreds(): void {
    cp.execFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      execCalls.push({ cmd, args });
      const op = args[1];
      const name = args.find((a) => a.startsWith('--name='))!.slice('--name='.length);
      let input = '';
      const stdin = {
        write: (chunk: string) => { input += chunk; stdinSeen.push(chunk); },
        end: () => {
          cb(null, `ENC:${name}:${Buffer.from(input).toString('base64')}`, '');
        },
      };
      if (op === 'decrypt') {
        setImmediate(() => {
          if (failDecrypt) { cb(new Error(failDecrypt), '', failDecrypt); return; }
          const [, storedName, b64] = fs.readFileSync(args[3]!, 'utf-8').split(':');
          if (storedName !== name) { cb(new Error('name mismatch'), '', 'name mismatch'); return; }
          cb(null, Buffer.from(b64!, 'base64').toString('utf-8') + (appendNewline ? '\n' : ''), '');
        });
      }
      return { stdin };
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-sd-'));
    stdinSeen = [];
    execCalls = [];
    failDecrypt = null;
    appendNewline = true;
    installSystemdCreds();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the credentials directory, owner-only, when it does not exist', () => {
    const credsDir = path.join(dir, 'nested', 'creds.d');
    createSystemdCredsStore({ credsDir });
    expect(fs.statSync(credsDir).isDirectory()).toBe(true);
    expect(fs.statSync(credsDir).mode & 0o777).toBe(0o700);
  });

  it('a second store reads what the first wrote, by decrypting the file with the credential\'s name', async () => {
    const first = new SystemdCredsStore({ credsDir: dir });
    await first.set('github', 'token', 'ghp_systemd_value');
    expect(fs.statSync(path.join(dir, 'github--token.cred')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(dir, 'github--token.cred'), 'utf-8')).not.toContain('ghp_systemd_value');

    execCalls = [];
    const second = new SystemdCredsStore({ credsDir: dir });
    expect(await second.get('github', 'token')).toBe('ghp_systemd_value');
    expect(execCalls).toEqual([{
      cmd: 'systemd-creds',
      args: ['--user', 'decrypt', '--name=github--token', path.join(dir, 'github--token.cred'), '-'],
    }]);
    // Served from memory the second time.
    expect(await second.get('github', 'token')).toBe('ghp_systemd_value');
    expect(execCalls).toHaveLength(1);
  });

  it('strips exactly one trailing newline from the decrypted value', async () => {
    const first = new SystemdCredsStore({ credsDir: dir });
    await first.set('github', 'token', 'line-one\n');
    appendNewline = true;
    expect(await new SystemdCredsStore({ credsDir: dir }).get('github', 'token')).toBe('line-one\n');
    appendNewline = false;
    expect(await new SystemdCredsStore({ credsDir: dir }).get('github', 'token')).toBe('line-one');
  });

  it('returns null for a credential with no file, without running systemd-creds', async () => {
    const store = new SystemdCredsStore({ credsDir: dir });
    expect(await store.get('github', 'missing')).toBeNull();
    expect(await store.exists('github', 'missing')).toBe(false);
    expect(await store.delete('github', 'missing')).toBe(false);
    expect(execCalls).toEqual([]);
  });

  it('names the credential when its file cannot be decrypted', async () => {
    await new SystemdCredsStore({ credsDir: dir }).set('github', 'token', 'v');
    failDecrypt = 'Failed to decrypt: Bad message';
    await expect(new SystemdCredsStore({ credsDir: dir }).get('github', 'token'))
      .rejects.toThrow('Failed to decrypt credential github/token: Failed to decrypt: Bad message');
  });

  it('a second store loads the encrypted index, and lists by service', async () => {
    const first = new SystemdCredsStore({ credsDir: dir });
    await first.set('github', 'token', 'a');
    await first.set('github', 'app_key', 'b');
    await first.set('slack', 'bot_token', 'c');
    // Setting an existing credential again does not add a second index entry.
    await first.set('slack', 'bot_token', 'c2');

    const second = new SystemdCredsStore({ credsDir: dir });
    expect(await second.list()).toEqual([
      { service: 'github', key: 'token' },
      { service: 'github', key: 'app_key' },
      { service: 'slack', key: 'bot_token' },
    ]);
    expect(await second.list('github')).toEqual([
      { service: 'github', key: 'token' },
      { service: 'github', key: 'app_key' },
    ]);
    expect(await second.list('nothing')).toEqual([]);
    // The returned list is a copy: changing it does not change the index.
    (await second.list()).pop();
    expect(await second.list()).toHaveLength(3);
  });

  it('starts from an empty index when the index cannot be decrypted', async () => {
    await new SystemdCredsStore({ credsDir: dir }).set('github', 'token', 'a');
    failDecrypt = 'TPM unavailable';
    const store = new SystemdCredsStore({ credsDir: dir });
    expect(await store.list()).toEqual([]);
  });

  it('deleting removes the file and the index entry, for later stores too', async () => {
    const store = new SystemdCredsStore({ credsDir: dir });
    await store.set('github', 'token', 'a');
    await store.set('slack', 'bot_token', 'b');
    expect(await store.delete('github', 'token')).toBe(true);
    expect(fs.existsSync(path.join(dir, 'github--token.cred'))).toBe(false);
    expect(await store.get('github', 'token')).toBeNull();
    expect(await new SystemdCredsStore({ credsDir: dir }).list()).toEqual([{ service: 'slack', key: 'bot_token' }]);
  });

  it('the value goes to systemd-creds on stdin, never on argv', async () => {
    await new SystemdCredsStore({ credsDir: dir }).set('github', 'token', 'ghp_never_on_argv');
    expect(stdinSeen).toContain('ghp_never_on_argv');
    expect(JSON.stringify(execCalls)).not.toContain('ghp_never_on_argv');
    expect(execCalls[0]).toEqual({ cmd: 'systemd-creds', args: ['--user', 'encrypt', '--name=github--token', '-', '-'] });
  });

  it('isSystemdCredsAvailable is false when the binary is missing or prints no version', () => {
    cp.execFileSync.mockImplementation(() => { throw new Error('spawnSync systemd-creds ENOENT'); });
    expect(isSystemdCredsAvailable()).toBe(false);
    cp.execFileSync.mockReturnValue('unexpected output\n');
    expect(isSystemdCredsAvailable()).toBe(false);
    cp.execFileSync.mockReturnValue('systemd 256 (256.4)\n');
    expect(isSystemdCredsAvailable()).toBe(true);
    expect(cp.execFileSync).toHaveBeenLastCalledWith('systemd-creds', ['--version'], { encoding: 'utf-8' });
  });
});

// ---------------------------------------------------------------------------

describe('createCredentialStore: refusals', () => {
  const savedAddr = process.env['VAULT_ADDR'];
  const savedPw = process.env['AQUAMAN_KEEPASS_PASSWORD'];
  afterEach(() => {
    if (savedAddr === undefined) delete process.env['VAULT_ADDR']; else process.env['VAULT_ADDR'] = savedAddr;
    if (savedPw === undefined) delete process.env['AQUAMAN_KEEPASS_PASSWORD']; else process.env['AQUAMAN_KEEPASS_PASSWORD'] = savedPw;
  });

  it('refuses a backend it does not know', async () => {
    await expect(createCredentialStore({ backend: 'sticky-note' as never })).rejects.toThrow('Unknown credential backend: sticky-note');
  });

  it('refuses encrypted-file without a password, and with a weak one', async () => {
    await expect(createCredentialStore({ backend: 'encrypted-file' })).rejects.toThrow('encryptionPassword required for encrypted-file backend');
    await expect(createCredentialStore({ backend: 'encrypted-file', encryptionPassword: 'short' }))
      .rejects.toThrow('Weak encryption password: Password must be at least 12 characters (got 5)');
  });

  it('refuses vault without an address, and takes the address from VAULT_ADDR', async () => {
    delete process.env['VAULT_ADDR'];
    await expect(createCredentialStore({ backend: 'vault', vaultToken: 'hvs.t' }))
      .rejects.toThrow('vaultAddress required for vault backend. Set via config or VAULT_ADDR env var.');
    process.env['VAULT_ADDR'] = 'http://127.0.0.1:8200/';
    const store = await createCredentialStore({ backend: 'vault', vaultToken: 'hvs.t', vaultMountPath: 'kv' });
    expect((store as unknown as { getAddress(): string }).getAddress()).toBe('http://127.0.0.1:8200');
    expect((store as unknown as { getMountPath(): string }).getMountPath()).toBe('kv');
  });

  it('refuses keepassxc with neither a password nor a key file', async () => {
    delete process.env['AQUAMAN_KEEPASS_PASSWORD'];
    await expect(createCredentialStore({ backend: 'keepassxc', keepassxcDatabasePath: '/nonexistent/x.kdbx' }))
      .rejects.toThrow('KeePassXC backend requires a master password (AQUAMAN_KEEPASS_PASSWORD) or key file (keepassxcKeyFilePath)');
  });
});
