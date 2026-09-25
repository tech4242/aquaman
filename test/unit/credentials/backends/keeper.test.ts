/**
 * Tests for the Keeper backend (Keeper Commander), v0.16.0.
 *
 * Runs the real spawn path against test/helpers/fake-keeper.mjs, which
 * emulates the Commander behavior the backend relies on (read from Commander
 * v18.1.5 source). What this proves: secret values never reach argv, values
 * with Commander macro prefixes survive, lookups stay inside the configured
 * folder, and a lapsed login never receives a secret on stdin.
 * What it cannot prove: behavior against a live Keeper account.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { KeeperStore, keeperTitle } from '../../../../packages/proxy/src/core/credentials/backends/keeper.js';

const FAKE = path.resolve('test/helpers/fake-keeper.mjs');
const FOLDER = 'FolderUid0000000000000';
const OTHER = 'OtherFolder00000000000';

describe('KeeperStore', () => {
  let dir: string;
  let state: string;
  let argvLog: string;
  let leakLog: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-keeper-'));
    state = path.join(dir, 'state.json');
    argvLog = path.join(dir, 'argv.log');
    leakLog = path.join(dir, 'leak.log');
    fs.writeFileSync(state, JSON.stringify({
      folders: { [FOLDER]: {}, [OTHER]: {} },
      records: {
        // Same title as an aquaman record, but outside the configured folder.
        foreign00000000000000: { title: keeperTitle('github', 'token'), password: 'NOT-OURS', folder: OTHER },
      },
    }));
    fs.chmodSync(FAKE, 0o755);
    saved = {
      FAKE_KEEPER_STATE: process.env['FAKE_KEEPER_STATE'],
      FAKE_KEEPER_ARGV_LOG: process.env['FAKE_KEEPER_ARGV_LOG'],
      FAKE_KEEPER_LEAK_LOG: process.env['FAKE_KEEPER_LEAK_LOG'],
      FAKE_KEEPER_LOGGED_OUT: process.env['FAKE_KEEPER_LOGGED_OUT'],
    };
    process.env['FAKE_KEEPER_STATE'] = state;
    process.env['FAKE_KEEPER_ARGV_LOG'] = argvLog;
    process.env['FAKE_KEEPER_LEAK_LOG'] = leakLog;
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

  it('requires a well-formed folder UID', () => {
    expect(() => new KeeperStore({ folderUid: '', command: FAKE })).toThrow(/folder/);
    expect(() => new KeeperStore({ folderUid: 'abc; rm -rf /', command: FAKE })).toThrow(/folder/);
  });

  it('round-trips set, get, list, exists and delete inside the folder', async () => {
    const s = store();
    expect(await s.get('github', 'token')).toBeNull(); // the foreign record is ignored
    await s.set('github', 'token', 'ghp_first_value');
    await s.set('github', 'token', 'ghp_second_value'); // update path
    await s.set('openai', 'api_key', 'sk-openai');
    expect(await s.get('github', 'token')).toBe('ghp_second_value');
    expect(await s.exists('openai', 'api_key')).toBe(true);
    expect((await s.list()).sort((a, b) => a.service.localeCompare(b.service))).toEqual([
      { service: 'github', key: 'token' },
      { service: 'openai', key: 'api_key' },
    ]);
    expect(await s.list('openai')).toEqual([{ service: 'openai', key: 'api_key' }]);
    expect(await s.delete('github', 'token')).toBe(true);
    expect(await s.delete('github', 'token')).toBe(false);
    expect(await s.get('github', 'token')).toBeNull();
  });

  it('never puts a secret value on argv', async () => {
    const secret = 'sk-very-secret-value-123';
    await store().set('anthropic', 'api_key', secret);
    const argv = fs.readFileSync(argvLog, 'utf-8');
    expect(argv).not.toContain(secret);
    expect(argv).not.toContain(Buffer.from(secret).toString('base64'));
  });

  it('stores values that look like Commander macros or start with "=" verbatim', async () => {
    const s = store();
    for (const v of ['$GEN:rand,16', '$JSON:{"a":1}', '=starts-with-equals', "it's \"quoted\" \\ and spaced"]) {
      await s.set('svc', 'k', v);
      expect(await s.get('svc', 'k')).toBe(v);
    }
  });

  it('refuses an ambiguous title instead of guessing', async () => {
    const st = JSON.parse(fs.readFileSync(state, 'utf-8'));
    st.records.dup1000000000000000000 = { title: keeperTitle('x', 'y'), password: 'a', folder: FOLDER };
    st.records.dup2000000000000000000 = { title: keeperTitle('x', 'y'), password: 'b', folder: FOLDER };
    fs.writeFileSync(state, JSON.stringify(st));
    await expect(store().get('x', 'y')).rejects.toThrow(/2 records titled/);
  });

  it('with a lapsed login, fails before any secret is piped to stdin', async () => {
    process.env['FAKE_KEEPER_LOGGED_OUT'] = '1';
    await expect(store().set('github', 'token', 'ghp_must_not_leak')).rejects.toThrow(/persistent-login/);
    expect(fs.existsSync(leakLog)).toBe(false);
  });
});
