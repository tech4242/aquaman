/**
 * E2E: links from the command line. `aquaman credentials link|unlink`, the
 * link-aware `list`, `add`, `delete` and `doctor`, `aquaman request --from`,
 * and a link reaching a daemon that is already running.
 *
 * The CLI is the real one, started as a child with its own HOME and config
 * directory. The vault is the HashiCorp Vault backend pointed at a server on
 * 127.0.0.1 that the test owns: it holds one item of "the user's" and
 * records every request, so a test can assert that nothing was written or
 * deleted there. No dialog is shown: where the daemon would ask a person, a
 * server the test owns sits on the proxy socket and plays the daemon.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { startFakeVault, type FakeVault } from '../helpers/fake-vault.js';
import { createSandbox, fakeProxy, json, startDaemon, PROXY_CLI, TSX, T, type FakeProxy, type Sandbox } from './cov-cli-core-helpers.js';

const ITEM = 'vault://secret/apps/github#token';
const ITEM_VALUE = 'ghp_value_of_the_users_own_vault_item_0123';
const REF = 'aquaman://github/token';

const SCRIPT = '/usr/bin/script';
// `script` wants a real pipe or a terminal on its stdin, so it is fed through `cat` by a shell.
const SCRIPT_CALL = process.platform === 'darwin'
  ? `cat | ${SCRIPT} -q /dev/null "$@"`
  : `cat | ${SCRIPT} -qec "$1" /dev/null`;
const hasScript = fs.existsSync(SCRIPT) && (process.platform === 'darwin' || process.platform === 'linux')
  && spawnSync('/bin/sh', ['-c', SCRIPT_CALL, 'sh', '/usr/bin/true'], { input: '', stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

describe('links: command line', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  let vault: FakeVault;
  let vaultAddr: string;
  /** Every request the stand-in Vault received. */
  let seen: FakeVault['requests'];

  beforeAll(async () => {
    vault = await startFakeVault();
    vaultAddr = vault.address;
    seen = vault.requests;
  });
  afterAll(async () => {
    await vault.close();
  });

  beforeEach(() => {
    sb = createSandbox();
    proxy = undefined;
    vault.reset();
    vault.secrets['/v1/secret/data/apps/github'] = { token: ITEM_VALUE };
  });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  const vaultEnv = () => ({ AQUAMAN_BACKEND: 'vault', VAULT_ADDR: vaultAddr, VAULT_TOKEN: 'hvs.links-cli-test' });
  const run = (args: string[], env: Record<string, string | undefined> = vaultEnv(), input?: string) => sb.run(args, { env, input });
  const configFile = () => path.join(sb.config, 'config.yaml');
  const linksInConfig = () => (fs.existsSync(configFile()) ? parseYaml(fs.readFileSync(configFile(), 'utf-8'))?.credentials?.links : undefined);
  const writes = () => vault.writes();

  /** Runs the CLI on a pseudo-terminal, so stdin and stdout are both terminals in the child. */
  function runAtTerminal(args: string[], env: Record<string, string | undefined> = vaultEnv()): Promise<{ code: number | null; output: string }> {
    const command = [TSX, PROXY_CLI, ...args];
    const scriptArgs = process.platform === 'darwin' ? command : [command.map(shellQuote).join(' ')];
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', SCRIPT_CALL, 'sh', ...scriptArgs], { cwd: sb.project, env: sb.env(env), stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      const onData = (d: Buffer) => { output += d.toString(); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
      child.stdin.end();
    });
  }

  describe('credentials link without a terminal', () => {
    it('is refused with the command an agent uses instead, and neither the config nor the vault is touched', async () => {
      const r = await run(['credentials', 'link', 'github/token', ITEM]);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('made by a person at a terminal');
      expect(r.stderr).toContain(`Fix: aquaman request ${REF} --from '${ITEM}'`);
      expect(linksInConfig()).toBeUndefined();
      expect(seen).toEqual([]);
    }, T);

    it('accepts the aquaman:// form of the reference and quotes a locator for the shell', async () => {
      const r = await run(['credentials', 'link', REF, "vault://secret/it's/x#y"], vaultEnv(), '');
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`Fix: aquaman request ${REF} --from 'vault://secret/it'\\''s/x#y'`);
    }, T);

    it('a reference that is not one is a wrong command, for link and for unlink', async () => {
      for (const args of [['credentials', 'link', 'GitHub Token', ITEM], ['credentials', 'unlink', '../x']]) {
        const r = await run(args);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain('Invalid reference');
        expect(r.stderr).toContain('Fix: Write it as <service>/<key>');
      }
    }, T * 2);
  });

  describe.skipIf(!hasScript)('credentials link at a terminal', () => {
    it('reads the item, writes the link at 0600 and never shows the value', async () => {
      const r = await runAtTerminal(['credentials', 'link', 'github/token', ITEM]);
      expect(r.output).toContain(`Linked github/token to ${ITEM}`);
      expect(r.output).toContain('never writes to it or deletes it');
      expect(r.output).toContain(`aquaman broker allow ${REF}`);
      expect(r.output).toContain('aquaman credentials unlink github/token');
      expect(r.output).not.toContain(ITEM_VALUE);
      expect(r.code).toBe(0);

      expect(linksInConfig()).toEqual({ 'github/token': ITEM });
      expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
      // Values that exist only in the environment were not written with it.
      const written = fs.readFileSync(configFile(), 'utf-8');
      expect(written).not.toContain('hvs.links-cli-test');
      expect(written).not.toContain(vaultAddr);
      // The item was read and nothing was sent that could change it.
      expect(seen).toContainEqual({ method: 'GET', url: '/v1/secret/data/apps/github' });
      expect(writes()).toEqual([]);
    }, T);

    it.each([
      ['a locator of another backend', 'op://Private/GitHub/token', /op:\/\/ locator belongs to the 1password backend, and the configured backend is vault/, /Fix: For the vault backend write it as vault:\/\//],
      ['a locator that does not parse', 'vault://secret/../sys#token', /Not a usable vault locator/, /Fix: For the vault backend/],
      ['an item that is not there', 'vault://secret/apps/gitlab#token', /Nothing could be read at vault:\/\/secret\/apps\/gitlab#token/, /Fix: Check the item and field names/],
      ['a field the item does not have', 'vault://secret/apps/github#password', /Nothing could be read/, /Fix: /],
    ])('%s is refused with a fix and no link is written', async (_name, locator, error, fix) => {
      const r = await runAtTerminal(['credentials', 'link', 'github/token', locator]);
      expect(r.code).toBe(1);
      expect(r.output).toMatch(error);
      expect(r.output).toMatch(fix);
      expect(linksInConfig()).toBeUndefined();
      expect(writes()).toEqual([]);
    }, T);

    it('a reference that already has a value stored by aquaman is not linked', async () => {
      vault.secrets['/v1/secret/data/aquaman/github/token'] = { credential: 'ghp_stored_by_aquaman' };
      const r = await runAtTerminal(['credentials', 'link', 'github/token', ITEM]);
      expect(r.code).toBe(1);
      expect(r.output).toContain('already has a value stored by aquaman');
      expect(r.output).toContain('Fix: To use the vault item instead, first run: aquaman credentials delete github token');
      expect(linksInConfig()).toBeUndefined();
      expect(seen.map((s) => s.url)).not.toContain('/v1/secret/data/apps/github');
    }, T);

    it('a backend that holds only what aquaman wrote takes no links, and says so', async () => {
      const r = await runAtTerminal(['credentials', 'link', 'github/token', ITEM], {});
      expect(r.code).toBe(1);
      expect(r.output).toContain('The encrypted-file backend holds only what aquaman wrote');
      expect(r.output).toContain('Fix: Store the value instead (aquaman credentials add <service> <key>)');
      expect(linksInConfig()).toBeUndefined();
    }, T);

    it('a vault that cannot be opened is reported with a fix', async () => {
      const r = await runAtTerminal(['credentials', 'link', 'github/token', ITEM], { AQUAMAN_BACKEND: 'vault', VAULT_ADDR: vaultAddr });
      expect(r.code).toBe(1);
      expect(r.output).toContain('Credential store not available: Vault token required');
      expect(r.output).toContain('Fix: aquaman doctor');
      expect(linksInConfig()).toBeUndefined();
    }, T);
  });

  describe('a linked reference', () => {
    beforeEach(() => {
      sb.writeConfig(`credentials:\n  backend: vault\n  links:\n    github/token: ${ITEM}\n`);
    });

    it('credentials list shows it with its locator, next to what aquaman stored', async () => {
      // One credential of aquaman's own, as the Vault backend lists it.
      vault.lists['/v1/secret/metadata/aquaman'] = ['openai/'];
      vault.lists['/v1/secret/metadata/aquaman/openai'] = ['api_key'];
      const r = await run(['credentials', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout.split('\n').map((l) => l.trimEnd())).toEqual([
        'Stored credentials:',
        '  openai/api_key',
        `  github/token  (linked to ${ITEM})`,
        '',
      ]);
      // Listing does not read the linked item.
      expect(seen.map((q) => q.url)).not.toContain('/v1/secret/data/apps/github');
    }, T);

    it('credentials add is refused before a value is read, and nothing is sent to the vault', async () => {
      const r = await run(['credentials', 'add', 'github', 'token'], vaultEnv(), 'ghp_would_overwrite\n');
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`github/token is linked to ${ITEM}, an item aquaman did not create`);
      expect(r.stderr).toContain('Fix: aquaman credentials unlink github/token');
      expect(seen).toEqual([]);
    }, T);

    it('credentials delete is refused, says to unlink, and nothing is sent to the vault', async () => {
      const r = await run(['credentials', 'delete', 'github', 'token']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('aquaman does not write to it or delete it');
      expect(r.stderr).toContain('Fix: aquaman credentials unlink github/token');
      expect(seen).toEqual([]);
      expect(linksInConfig()).toEqual({ 'github/token': ITEM });
    }, T);

    it('add and delete of another reference are not affected', async () => {
      const r = await run(['credentials', 'delete', 'openai', 'api_key']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Credential not found: openai/api_key');
    }, T);

    it('credentials unlink removes the link, keeps the rest of the config, and never contacts the vault', async () => {
      const r = await run(['credentials', 'unlink', REF]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('Unlinked github/token. The vault item is unchanged.');
      expect(parseYaml(fs.readFileSync(configFile(), 'utf-8'))).toEqual({ credentials: { backend: 'vault' } });
      expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
      expect(seen).toEqual([]);

      const again = await run(['credentials', 'unlink', 'github/token']);
      expect(again.code).toBe(0);
      expect(again.stdout.trim()).toBe('Not linked: github/token');
    }, T * 2);

    it('doctor counts links that fit the backend', async () => {
      const r = await run(['doctor']);
      expect(r.stdout).toContain('\u2713 vault backend (1 credential)');
      expect(r.stdout).toContain('\u2713 1 linked reference (read from existing vault items)');
      expect(r.stdout).not.toContain('is linked to');
    }, T);
  });

  describe('doctor', () => {
    it('reports each link whose scheme does not belong to the configured backend, with the fix, and fails', async () => {
      sb.writeConfig([
        'credentials:',
        '  backend: vault',
        '  links:',
        `    github/token: ${ITEM}`,
        '    openai/api_key: op://Private/OpenAI/credential',
        '    stripe/secret_key: bw://Stripe/password',
        '',
      ].join('\n'));
      const r = await run(['doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('\u2717 openai/api_key is linked to op://Private/OpenAI/credential: A op:// locator belongs to the 1password backend, and the configured backend is vault');
      expect(r.stdout).toContain('\u2192 Remove it with: aquaman credentials unlink openai/api_key');
      expect(r.stdout).toContain('\u2717 stripe/secret_key is linked to bw://Stripe/password');
      expect(r.stdout).not.toContain('\u2717 github/token');
      // Two links, plus the proxy that is not running.
      expect(r.stdout).toContain('3 issues found');
    }, T);

    it('says nothing about links when there are none', async () => {
      sb.writeConfig('credentials:\n  backend: encrypted-file\n');
      const r = await run(['doctor'], {});
      expect(r.stdout).toContain('encrypted-file backend');
      expect(r.stdout).not.toContain('linked');
    }, T);

    it('a backend that takes no links reports every link', async () => {
      sb.writeConfig(`credentials:\n  backend: encrypted-file\n  links:\n    github/token: ${ITEM}\n`);
      const r = await run(['doctor'], {});
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`\u2717 github/token is linked to ${ITEM}: The encrypted-file backend holds only what aquaman wrote`);
    }, T);
  });

  describe('aquaman request --from', () => {
    const answer = async (status: number, body: unknown) => {
      proxy = await fakeProxy(sb.socket, (_req, res) => json(res, status, body));
    };

    it('linked: sends the locator, exits 0 and prints the status and the reference only', async () => {
      await answer(200, { status: 'linked', ref: REF });
      const r = await run(['request', REF, '--from', ITEM]);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe(`linked: ${REF}`);
      expect(r.stderr).toBe('');
      expect(proxy!.requests).toEqual([{
        method: 'POST',
        url: '/broker/request',
        body: { service: 'github', key: 'token', project: sb.project, timeout_seconds: 90, from: ITEM },
      }]);
      // The command itself never talks to the vault.
      expect(seen).toEqual([]);

      const j = await run(['request', REF, '--from', ITEM, '--json', '--timeout', '30']);
      expect(j.code).toBe(0);
      expect(JSON.parse(j.stdout)).toEqual({ status: 'linked', ref: REF });
      expect(proxy!.requests[1].body.timeout_seconds).toBe(30);
    }, T * 2);

    it('linked with --env binds the variable like any usable status', async () => {
      sb.installRealCoder();
      const init = spawnSync(path.join(sb.bin, 'aquaman-coder'), ['init', '--agent', 'claude-code', '--no-hooks', '--json'], { cwd: sb.project, encoding: 'utf-8', env: sb.env() });
      expect(init.status, init.stderr).toBe(0);
      await answer(200, { status: 'linked', ref: REF });
      const r = await run(['request', REF, '--from', ITEM, '--env', 'GITHUB_TOKEN', '--json']);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ status: 'linked', ref: REF, env: 'GITHUB_TOKEN' });
      expect(parseYaml(fs.readFileSync(path.join(sb.config, 'projects.yaml'), 'utf-8')).projects.app.env).toEqual({ GITHUB_TOKEN: REF });
    }, T * 2);

    it.each([
      ['another backend\'s scheme', 'bw://GitHub/password', 'link_backend_mismatch', vaultEnv],
      ['a locator that does not parse', 'vault://secret/-x#y', 'link_invalid_locator', vaultEnv],
      ['a backend that takes no links', ITEM, 'link_unsupported_backend', () => ({})],
    ])('%s is a wrong command: exit 1 with the code and a fix, and the daemon is never asked', async (_name, locator, code, env) => {
      await answer(200, { status: 'linked', ref: REF });
      const r = await run(['request', REF, '--from', locator, '--json'], env());
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({ status: 'error', ref: REF, code });
      expect(out.fix).toBeTruthy();
      expect(proxy!.requests).toEqual([]);
    }, T);

    it.each([
      [404, { error: 'Nothing could be read at the locator', fix: 'Check the item and field names', code: 'link_unreadable' }],
      [404, { error: 'already has a value stored by aquaman', fix: 'aquaman credentials delete github token', code: 'link_value_stored' }],
      [409, { error: 'github/token is already linked to another item', fix: 'aquaman credentials unlink github/token', code: 'link_exists' }],
    ])('a refusal by the daemon (%i %o) is exit 4 with its code and fix', async (status, body) => {
      await answer(status, body);
      const r = await run(['request', REF, '--from', ITEM, '--json']);
      expect(r.code).toBe(4);
      expect(JSON.parse(r.stdout)).toEqual({ status: 'error', ref: REF, error: body.error, code: body.code, fix: body.fix });
    }, T);

    it('declined is exit 2 with no fix, pending is exit 3 with the by-hand command', async () => {
      await answer(200, { status: 'declined', ref: REF, reason: 'the person at the dialog said no' });
      const declined = await run(['request', REF, '--from', ITEM, '--json']);
      expect(declined.code).toBe(2);
      expect(JSON.parse(declined.stdout).fix).toBeUndefined();
      await proxy!.close();

      const manual = `aquaman credentials link github/token '${ITEM}' && aquaman broker allow ${REF}`;
      await answer(200, { status: 'pending', ref: REF, reason: 'nobody answered the dialog', fix: manual });
      const pending = await run(['request', REF, '--from', ITEM, '--json']);
      expect(pending.code).toBe(3);
      expect(JSON.parse(pending.stdout).fix).toBe(manual);
    }, T * 2);

    it('the help lists the option, the status and its exit code', async () => {
      const r = await run(['request', '--help']);
      expect(r.stdout).toContain('--from <locator>');
      expect(r.stdout).toMatch(/linked\s+0\s+--from named an existing vault item/);
      const link = await run(['credentials', 'link', '--help']);
      expect(link.stdout).toContain('vault://<mount>/<path>#<field>');
      expect(link.stdout).toContain('aquaman request <ref> --from <locator>');
    }, T * 2);
  });

  describe.skipIf(!hasScript)('a running daemon', () => {
    const get = () => run(['get', REF]);

    it('serves a link made after it started, stops when the link is removed, and never changes the item', async () => {
      // A cache TTL, so that a value read through the link would outlive it if nothing dropped it.
      sb.writeConfig('credentials:\n  backend: vault\n  cacheTtlSeconds: 900\n');
      await startDaemon(sb, { env: vaultEnv() });
      expect((await run(['broker', 'allow', REF])).code).toBe(0);

      const before = await get();
      expect(before.code).toBe(1);
      expect(before.stderr).toContain('No credential found for github/token');

      const linked = await runAtTerminal(['credentials', 'link', 'github/token', ITEM]);
      expect(linked.code, linked.output).toBe(0);
      const value = await get();
      expect(value.code, value.stderr).toBe(0);
      expect(value.stdout).toBe(ITEM_VALUE);
      // Read again: served from the daemon's cache this time.
      const reads = seen.filter((r) => r.url === '/v1/secret/data/apps/github').length;
      expect((await get()).stdout).toBe(ITEM_VALUE);
      expect(seen.filter((r) => r.url === '/v1/secret/data/apps/github').length).toBe(reads);

      expect((await run(['credentials', 'unlink', 'github/token'])).code).toBe(0);
      const after = await get();
      expect(after.code).toBe(1);
      expect(after.stdout).not.toContain(ITEM_VALUE);
      expect(after.stderr).toContain('No credential found for github/token');

      expect(writes()).toEqual([]);
    }, T * 4);

    it('does not hand out a linked reference that is not declared', async () => {
      sb.writeConfig(`credentials:\n  backend: vault\n  links:\n    github/token: ${ITEM}\n`);
      await startDaemon(sb, { env: vaultEnv() });
      const r = await get();
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('not declared');
      expect(r.stdout).toBe('');
      expect(seen.map((s) => s.url)).not.toContain('/v1/secret/data/apps/github');
    }, T * 2);
  });
});
