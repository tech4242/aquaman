/**
 * Each backend's read of an item aquaman did not write (`readLinked`).
 *
 * No real tool or service: HashiCorp Vault is a server on 127.0.0.1 that the
 * test owns, KeePassXC is a database generated in a temp directory, and
 * Keeper is test/helpers/fake-keeper.mjs. What these prove is what each
 * backend sends and how it reads the answer. They do not prove behaviour
 * against a live vault.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { VaultStore } from '../../packages/proxy/src/core/credentials/backends/vault.js';
import { KeePassXCStore } from '../../packages/proxy/src/core/credentials/backends/keepassxc.js';
import { KeeperStore } from '../../packages/proxy/src/core/credentials/backends/keeper.js';
import { parseLocatorFor, type ParsedLocator } from '../../packages/proxy/src/core/credentials/links.js';

function locator(backend: Parameters<typeof parseLocatorFor>[0], text: string): ParsedLocator {
  const parsed = parseLocatorFor(backend, text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.locator;
}

describe('VaultStore.readLinked (KV v2)', () => {
  let server: http.Server;
  let address: string;
  const seen: Array<{ method: string; url: string; token: string | undefined }> = [];
  const secrets: Record<string, unknown> = {
    '/v1/secret/data/apps/github': { data: { data: { token: 'ghp_from_vault', empty: '', count: 3, nested: { a: 1 } } } },
    '/v1/team/kv/data/db': { data: { data: { password: 'pg_from_nested_mount' } } },
    '/v1/secret/data/my%20app/key%3Fone': { data: { data: { 'api key': 'spaced' } } },
    '/v1/secret/data/nodata': { data: {} },
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url!, token: req.headers['x-vault-token'] as string | undefined });
      if (req.url === '/v1/secret/data/forbidden') {
        res.statusCode = 403;
        res.end('{"errors":["permission denied"]}');
        return;
      }
      const body = secrets[req.url!];
      if (body === undefined) {
        res.statusCode = 404;
        res.end('{"errors":[]}');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => { seen.length = 0; });

  const store = () => new VaultStore({ address, token: 'hvs.links-test' });

  it('reads one string field of a secret outside aquaman\'s own prefix', async () => {
    expect(await store().readLinked(locator('vault', 'vault://secret/apps/github#token'))).toBe('ghp_from_vault');
    expect(seen).toEqual([{ method: 'GET', url: '/v1/secret/data/apps/github', token: 'hvs.links-test' }]);
  });

  it('a mount written with %2F is requested as its own path segments', async () => {
    expect(await store().readLinked(locator('vault', 'vault://team%2Fkv/db#password'))).toBe('pg_from_nested_mount');
    expect(seen[0].url).toBe('/v1/team/kv/data/db');
  });

  it('each part is sent as one encoded URL segment', async () => {
    expect(await store().readLinked(locator('vault', 'vault://secret/my app/key%3Fone#api key'))).toBe('spaced');
    expect(seen[0].url).toBe('/v1/secret/data/my%20app/key%3Fone');
  });

  it.each([
    ['a secret that does not exist', 'vault://secret/apps/missing#token'],
    ['a field the secret does not have', 'vault://secret/apps/github#password'],
    ['a field that only exists on the prototype', 'vault://secret/apps/github#constructor'],
    ['an empty field', 'vault://secret/apps/github#empty'],
    ['a secret with no data', 'vault://secret/nodata#token'],
  ])('%s reads as null', async (_name, text) => {
    expect(await store().readLinked(locator('vault', text))).toBeNull();
  });

  it.each([
    ['a number', 'vault://secret/apps/github#count'],
    ['an object', 'vault://secret/apps/github#nested'],
  ])('a field that is %s is an error, not a value', async (_name, text) => {
    await expect(store().readLinked(locator('vault', text))).rejects.toThrow(/is not a string/);
  });

  it('a refusal by Vault is an error, never "not there"', async () => {
    await expect(store().readLinked(locator('vault', 'vault://secret/forbidden#token'))).rejects.toThrow(/Vault API error \(403\)/);
  });

  it('a secret under aquaman\'s own prefix is not read under a second name, and nothing is requested', async () => {
    await expect(store().readLinked(locator('vault', 'vault://secret/aquaman/anthropic/api_key#credential'))).rejects.toThrow(/aquaman itself wrote/);
    expect(seen).toEqual([]);
    // The same path on another mount, or deeper on this one, is the user's own.
    expect(await store().readLinked(locator('vault', 'vault://other/aquaman/anthropic#credential'))).toBeNull();
    expect(await store().readLinked(locator('vault', 'vault://secret/apps/aquaman#credential'))).toBeNull();
    const nested = new VaultStore({ address, token: 'hvs.links-test', mountPath: 'team/kv' });
    await expect(nested.readLinked(locator('vault', 'vault://team%2Fkv/aquaman/x/y#credential'))).rejects.toThrow(/aquaman itself wrote/);
    expect(await nested.readLinked(locator('vault', 'vault://team/kv/aquaman/x#credential'))).toBeNull();
  });

  it('never writes: only GET requests are made', async () => {
    const s = store();
    await s.readLinked(locator('vault', 'vault://secret/apps/github#token'));
    await s.readLinked(locator('vault', 'vault://secret/apps/missing#token'));
    expect(seen.map((r) => r.method)).toEqual(['GET', 'GET']);
  });
});

describe('KeePassXCStore.readLinked', () => {
  const PASSWORD = 'links-keepass-test-password';
  let dir: string;
  let dbPath: string;
  let store: KeePassXCStore;
  let before: Buffer;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-links-kdbx-'));
    dbPath = path.join(dir, 'vault.kdbx');
    // The store creates the database; entries of the user's own are then
    // added with the library, the way KeePassXC itself would have.
    const seed = new KeePassXCStore({ dbPath, password: PASSWORD });
    await seed.set('own', 'key', 'written-by-aquaman');
    seed.close();

    const mod: any = await import('kdbxweb');
    const kdbxweb = mod.default || mod;
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD), null);
    const db = await kdbxweb.Kdbx.load(new Uint8Array(fs.readFileSync(dbPath)).buffer, credentials);
    const root = db.getDefaultGroup();
    const add = (group: any, title: string, fields: Record<string, unknown>) => {
      const entry = db.createEntry(group);
      entry.fields.set('Title', title);
      for (const [k, v] of Object.entries(fields)) entry.fields.set(k, v);
    };
    const work = db.createGroup(root, 'Work');
    const apis = db.createGroup(work, 'APIs');
    add(root, 'Top', { Password: kdbxweb.ProtectedValue.fromString('top-secret') });
    add(apis, 'GitHub', { Password: kdbxweb.ProtectedValue.fromString('ghp_from_keepass'), UserName: 'octocat', 'API Key': kdbxweb.ProtectedValue.fromString('custom-field-value') });
    add(apis, 'CI/CD token', { Password: kdbxweb.ProtectedValue.fromString('slash-title') });
    add(apis, 'Empty', { Password: kdbxweb.ProtectedValue.fromString('') });
    add(work, 'Twin', { Password: kdbxweb.ProtectedValue.fromString('one') });
    add(work, 'Twin', { Password: kdbxweb.ProtectedValue.fromString('two') });
    db.setVersion(3);
    fs.writeFileSync(dbPath, Buffer.from(await db.save()));
    before = fs.readFileSync(dbPath);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  beforeEach(() => { store = new KeePassXCStore({ dbPath, password: PASSWORD }); });
  afterEach(() => store.close());

  it.each([
    ['an entry in the root group', 'keepassxc://Top', 'top-secret'],
    ['an entry in a nested group, default field', 'keepassxc://Work/APIs/GitHub', 'ghp_from_keepass'],
    ['a plain-text field', 'keepassxc://Work/APIs/GitHub#UserName', 'octocat'],
    ['a protected custom field', 'keepassxc://Work/APIs/GitHub#API Key', 'custom-field-value'],
    ['a title with a slash, written %2F', 'keepassxc://Work/APIs/CI%2FCD token', 'slash-title'],
  ])('%s', async (_name, text, value) => {
    expect(await store.readLinked(locator('keepassxc', text))).toBe(value);
  });

  it.each([
    ['a group that does not exist', 'keepassxc://Nope/GitHub'],
    ['an entry that does not exist', 'keepassxc://Work/APIs/GitLab'],
    ['a field the entry does not have', 'keepassxc://Work/APIs/GitHub#Token'],
    ['an empty field', 'keepassxc://Work/APIs/Empty'],
  ])('%s reads as null', async (_name, text) => {
    expect(await store.readLinked(locator('keepassxc', text))).toBeNull();
  });

  it('two entries with the same title in one group are refused, not guessed between', async () => {
    await expect(store.readLinked(locator('keepassxc', 'keepassxc://Work/Twin'))).rejects.toThrow(/2 entries are titled "Twin"/);
  });

  it('an entry aquaman wrote is not read under a second name', async () => {
    await expect(store.readLinked(locator('keepassxc', 'keepassxc://own%2Fkey'))).rejects.toThrow(/aquaman itself wrote/);
    // The same title somewhere else is the user's own entry.
    expect(await store.readLinked(locator('keepassxc', 'keepassxc://Work/own%2Fkey'))).toBeNull();
  });

  it('reading never rewrites the database file', async () => {
    await store.readLinked(locator('keepassxc', 'keepassxc://Work/APIs/GitHub'));
    await store.readLinked(locator('keepassxc', 'keepassxc://Nope/GitHub'));
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});

describe('KeeperStore.readLinked (Keeper Commander stand-in)', () => {
  const FAKE = path.resolve('test/helpers/fake-keeper.mjs');
  const FOLDER = 'FolderUid0000000000000';
  const RECORD = 'userRecord000000000001';
  const NOPASS = 'userRecord000000000002';
  let dir: string;
  let state: string;
  let argvLog: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-links-keeper-'));
    state = path.join(dir, 'state.json');
    argvLog = path.join(dir, 'argv.log');
    fs.writeFileSync(state, JSON.stringify({
      folders: { [FOLDER]: {} },
      records: {
        // The user's own records: not in aquaman's folder, not titled by aquaman.
        [RECORD]: { title: 'GitHub', password: 'ghp_from_keeper', login: 'octocat', custom: { 'API Key': 'custom-from-keeper', text: 'by-label-first' }, folder: 'elsewhere' },
        [NOPASS]: { title: 'Empty', password: '', folder: 'elsewhere' },
      },
    }));
    fs.chmodSync(FAKE, 0o755);
    saved = { FAKE_KEEPER_STATE: process.env['FAKE_KEEPER_STATE'], FAKE_KEEPER_ARGV_LOG: process.env['FAKE_KEEPER_ARGV_LOG'], FAKE_KEEPER_LOGGED_OUT: process.env['FAKE_KEEPER_LOGGED_OUT'] };
    process.env['FAKE_KEEPER_STATE'] = state;
    process.env['FAKE_KEEPER_ARGV_LOG'] = argvLog;
    delete process.env['FAKE_KEEPER_LOGGED_OUT'];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const store = () => new KeeperStore({ folderUid: FOLDER, command: FAKE });
  const argv = () => fs.readFileSync(argvLog, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as string[]);

  it('reads the password of a record by UID, with only the UID and flags on argv', async () => {
    expect(await store().readLinked(locator('keeper', `keeper://${RECORD}`))).toBe('ghp_from_keeper');
    expect(argv()).toEqual([['--batch-mode', 'get', RECORD, '--format', 'password']]);
  });

  it.each([
    ['a custom field by its label', 'API Key', 'custom-from-keeper'],
    ['a standard field by its type', 'login', 'octocat'],
    ['a label before a type of the same name', 'text', 'by-label-first'],
  ])('reads %s from the record JSON', async (_name, field, value) => {
    expect(await store().readLinked(locator('keeper', `keeper://${RECORD}/${field}`))).toBe(value);
    expect(argv()).toEqual([['--batch-mode', 'get', RECORD, '--format', 'json']]);
  });

  it('a field the record does not have, an empty field and an empty password read as null', async () => {
    expect(await store().readLinked(locator('keeper', `keeper://${RECORD}/nope`))).toBeNull();
    expect(await store().readLinked(locator('keeper', `keeper://${NOPASS}/login`))).toBeNull();
    expect(await store().readLinked(locator('keeper', `keeper://${NOPASS}`))).toBeNull();
  });

  it('a record that does not exist, or a lapsed login, is an error', async () => {
    await expect(store().readLinked(locator('keeper', 'keeper://noSuchRecord0000000000'))).rejects.toThrow(/keeper get failed/);
    await expect(store().readLinked(locator('keeper', 'keeper://noSuchRecord0000000000/login'))).rejects.toThrow(/keeper get failed/);
    process.env['FAKE_KEEPER_LOGGED_OUT'] = '1';
    await expect(store().readLinked(locator('keeper', `keeper://${RECORD}`))).rejects.toThrow(/session lapsed/);
  });

  it('output that is not record JSON is an error', async () => {
    const notJson = path.join(dir, 'keeper-not-json');
    fs.writeFileSync(notJson, '#!/bin/sh\necho "Record not available"\n', { mode: 0o755 });
    const s = new KeeperStore({ folderUid: FOLDER, command: notJson });
    await expect(s.readLinked(locator('keeper', `keeper://${RECORD}/login`))).rejects.toThrow(/expected record JSON/);
  });

  it('reading leaves the record as it was', async () => {
    const before = fs.readFileSync(state, 'utf-8');
    await store().readLinked(locator('keeper', `keeper://${RECORD}`));
    await store().readLinked(locator('keeper', `keeper://${RECORD}/API Key`));
    expect(fs.readFileSync(state, 'utf-8')).toBe(before);
  });
});
