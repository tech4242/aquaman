/**
 * E2E: the ask-first commands of both CLIs, as real child processes.
 *
 *   aquaman broker ask <ref> [--off]     aquaman broker allow <ref> --ask
 *   aquaman request <ref> --ask          aquaman get <ref>
 *   aquaman broker list                  aquaman-coder exec / doctor
 *
 * Every answer the daemon gives after a person used its dialog comes from a
 * server this test owns on the proxy socket (`fakeProxy`). A real daemon is
 * started for one thing only, what it does without asking anyone: it enforces
 * a mark the CLI set, for a request that says not to raise a dialog. No test
 * here sends a real daemon a request that would open one.
 *
 * Each child gets its own HOME and AQUAMAN_CONFIG_DIR and the encrypted-file
 * backend.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { findPython3 } from '../helpers/cov-cli-hosts.js';
import {
  createSandbox, fakeProxy, json, startDaemon, sleep, PASSWORD, PROXY_CLI, T,
  type FakeProxy, type Sandbox,
} from './cov-cli-core-helpers.js';

const REF = 'aquaman://github/token';
const VALUE = 'ghp_cli_ask_first_value_0123456789';
const TSX_CLI = path.resolve('node_modules/tsx/dist/cli.mjs');
const PTY_DRIVER = path.resolve('test/helpers/cov-cli-hosts-pty.py');
const python = findPython3();

describe('ask first: the commands', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;

  beforeEach(() => {
    sb = createSandbox();
    proxy = undefined;
    sb.writeConfig('credentials:\n  backend: encrypted-file\n');
  });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  const vault = () => new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc'));
  const record = async (): Promise<unknown> => {
    const raw = await vault().get('aquaman_internal', 'ask_first');
    return raw === null ? null : JSON.parse(raw);
  };
  const config = () => parseYaml(fs.readFileSync(path.join(sb.config, 'config.yaml'), 'utf-8'));
  /** The daemon's reply to every request, chosen by the test. */
  const answer = async (status: number, body: unknown) => {
    proxy = await fakeProxy(sb.socket, (_req, res) => json(res, status, body));
  };
  const udsPost = (urlPath: string, body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request({ socketPath: sb.socket, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  /** The proxy CLI on a pseudo-terminal, with answers typed when their prompts appear. */
  function runTty(args: string[], answers: Array<[string, string]>): Promise<{ output: string; code: number }> {
    const spec = path.join(sb.root, `pty-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(spec, JSON.stringify({ argv: [process.execPath, TSX_CLI, PROXY_CLI, ...args], answers, timeout: 60 }));
    return new Promise((resolve, reject) => {
      const proc = spawn(python!, [PTY_DRIVER, spec], { stdio: ['ignore', 'pipe', 'pipe'], env: sb.env({ TERM: 'dumb' }), cwd: sb.project });
      let out = '';
      let err = '';
      proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', () => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error(`pty driver failed: ${err || out}`)); }
      });
    });
  }

  describe('setting the mark asks nobody', () => {
    it('broker ask, with a daemon: the mark goes through it, so it is enforced at once', async () => {
      await answer(200, { status: 'marked', ref: REF });
      const r = await sb.run(['broker', 'ask', REF]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Ask first: ${REF}`);
      expect(r.stdout).toContain('A yes lasts 8 hours or until the daemon stops, and covers every program running as you.');
      expect(r.stdout).toContain(`Not declared yet, so not handed out at all: ${REF}`);
      expect(proxy!.requests).toEqual([{ method: 'POST', url: '/broker/ask-first', body: { service: 'github', key: 'token', ask: true } }]);
      expect(await record()).toBeNull();
    }, T);

    it('broker ask, with no daemon: the mark is written to the vault, where the next daemon reads it', async () => {
      const r = await sb.run(['broker', 'ask', REF, 'aquaman://slack/bot_token']);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain('No daemon is serving the broker right now; the mark is in the vault and applies when `aquaman daemon` starts.');
      expect(await record()).toEqual({ v: 1, refs: ['github/token', 'slack/bot_token'] });
      // Not in the files a program can edit without the vault.
      expect(JSON.stringify(config())).not.toMatch(/ask/i);
      expect(fs.existsSync(path.join(sb.config, 'projects.yaml'))).toBe(false);
    }, T);

    it('broker ask, with a proxy that hands nothing out on the socket: written to the vault', async () => {
      await answer(404, { error: 'The credential broker is disabled on this proxy', code: 'broker_disabled' });
      const r = await sb.run(['broker', 'ask', REF]);
      expect(r.code, r.stderr).toBe(0);
      expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
    }, T);

    it('broker ask says the window config.yaml sets, held inside its bounds', async () => {
      sb.writeConfig('credentials:\n  backend: encrypted-file\nbroker:\n  askFirstWindowSeconds: 1800\n');
      expect((await sb.run(['broker', 'ask', REF])).stdout).toContain('A yes lasts 30 minutes or until');
      sb.writeConfig('credentials:\n  backend: encrypted-file\nbroker:\n  askFirstWindowSeconds: 99999999\n');
      expect((await sb.run(['broker', 'ask', REF])).stdout).toContain('A yes lasts 24 hours or until');
    }, T);

    it('broker allow --ask marks first and then declares, so the ref is never declared without its mark', async () => {
      let declaredWhenMarked: unknown = 'not asked';
      proxy = await fakeProxy(sb.socket, (_req, res) => {
        declaredWhenMarked = config().broker?.allowedRefs;
        json(res, 200, { status: 'marked', ref: REF });
      });
      const r = await sb.run(['broker', 'allow', REF, '--ask']);
      expect(r.code, r.stderr).toBe(0);
      expect(declaredWhenMarked).toBeUndefined();
      expect(config().broker.allowedRefs).toEqual([REF]);
      expect(r.stdout).toContain('Marked ask-first: the daemon shows a dialog before it hands these values out.');
      expect(r.stdout).not.toContain('Any process running as you can now fetch these values');
    }, T);

    it('broker allow --ask declares nothing when the mark could not be set', async () => {
      await answer(500, { error: 'Vault backend error reading or writing the ask-first record: locked', fix: 'Run: aquaman doctor' });
      const r = await sb.run(['broker', 'allow', REF, '--ask']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('locked');
      expect(config().broker).toBeUndefined();
    }, T);

    it('broker allow without --ask is as it was, and names the command that marks', async () => {
      const r = await sb.run(['broker', 'allow', REF]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Any process running as you can now fetch these values from `aquaman daemon`.');
      expect(r.stdout).toContain('To be asked in a dialog first: aquaman broker ask <ref>');
      expect(await record()).toBeNull();
    }, T);

    it('a ref bound through the proxy only is refused: its value is never handed out, so a mark would gate nothing', async () => {
      fs.writeFileSync(path.join(sb.config, 'projects.yaml'), `projects:\n  app:\n    paths: ["${sb.project}"]\n    env:\n      OPENAI_API_KEY: "aquaman://openai/api_key"\n    routes:\n      OPENAI_API_KEY:\n        url_env: OPENAI_BASE_URL\n        base_path: /v1\n`);
      await answer(200, { status: 'marked' });
      const r = await sb.run(['broker', 'ask', 'aquaman://openai/api_key']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('bound through the proxy only, so the value is never handed to a program and there is no read to ask about');
      expect(proxy!.requests).toEqual([]);
      expect(await record()).toBeNull();
    }, T);

    for (const [name, ref, message] of [
      ['a ref that does not parse', 'github/token', 'Invalid ref: github/token'],
      ['aquaman\'s own records', 'aquaman://aquaman_internal/ask_first', 'is reserved for aquaman\'s own records'],
    ] as const) {
      it(`${name}: refused, nothing sent, nothing written`, async () => {
        await answer(200, { status: 'marked' });
        for (const args of [['broker', 'ask', ref], ['broker', 'allow', ref, '--ask'], ['broker', 'ask', ref, '--off']]) {
          const r = await sb.run(args);
          expect(r.code).toBe(1);
          expect(r.stderr).toContain(message);
        }
        expect(proxy!.requests).toEqual([]);
        expect(await record()).toBeNull();
      }, T);
    }

    it('request --ask marks before it asks for the credential, and reports it', async () => {
      await answer(200, { status: 'stored', ref: REF });
      const r = await sb.run(['request', REF, '--ask', '--json']);
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ status: 'stored', ref: REF, ask_first: true });
      expect(proxy!.requests.map((q) => [q.url, q.body.ask])).toEqual([['/broker/ask-first', true], ['/broker/request', undefined]]);
      const text = await sb.run(['request', REF, '--ask']);
      expect(text.stdout).toContain('Marked ask-first: the daemon shows a dialog before it hands the value out');
    }, T);

    it('request --ask asks for nothing when the mark could not be set: exit 4 with the daemon\'s code', async () => {
      await answer(404, { error: 'The credential broker is disabled on this proxy', fix: 'Run: aquaman daemon', code: 'broker_disabled' });
      const r = await sb.run(['request', REF, '--ask', '--json']);
      expect(r.code).toBe(4);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'error', code: 'broker_disabled' });
      expect(proxy!.requests.map((q) => q.url)).toEqual(['/broker/ask-first']);
    }, T);

    it('request --ask with --via-proxy is a wrong command: exit 1, nothing sent', async () => {
      await answer(200, { status: 'stored', ref: REF });
      const r = await sb.run(['request', REF, '--ask', '--env', 'GITHUB_TOKEN', '--via-proxy', 'GITHUB_API_URL', '--json']);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error).toContain('--ask does nothing with --via-proxy');
      expect(proxy!.requests).toEqual([]);
    }, T);
  });

  describe('removing the mark is decided in the daemon\'s dialog', () => {
    const replies: Array<[string, number, Record<string, unknown>, number, RegExp]> = [
      ['the person allows it', 200, { status: 'unmarked', ref: REF }, 0, /is no longer marked ask-first/],
      ['there was no mark', 200, { status: 'ready', ref: REF }, 0, /is not marked ask-first/],
      ['the person says no', 200, { status: 'declined', reason: 'the person at the dialog said no', ref: REF }, 2, /Still marked: the person at the dialog said no/],
      ['nobody answers', 200, { status: 'pending', reason: 'nobody answered the dialog', ref: REF, fix: 'x' }, 3, /Still marked: nobody answered the dialog\. Run the command again\./],
      ['too many dialogs were shown', 200, { status: 'pending', reason: 'too many dialogs in a short time', ref: REF, fix: 'x' }, 3, /Still marked: too many dialogs/],
      ['no dialog can be shown, and the command has no terminal', 200, { status: 'pending', code: 'prompt_unavailable', reason: 'no desktop session', ref: REF, fix: 'x' }, 1, /not at a terminal, so nobody can be asked[\s\S]*Run it yourself in a terminal: aquaman broker ask aquaman:\/\/github\/token --off/],
      ['the proxy on the socket keeps no marks', 404, { error: 'The credential broker is disabled on this proxy', fix: 'Run: aquaman daemon', code: 'broker_disabled' }, 1, /disabled on this proxy/],
      ['the vault cannot be read', 500, { error: 'Vault backend error reading or writing the ask-first record: locked', fix: 'Run: aquaman doctor' }, 1, /locked/],
    ];
    for (const [name, status, body, code, says] of replies) {
      it(`${name}: exit ${code}, and the vault is not touched by the command`, async () => {
        await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token"]}');
        await answer(status, body);
        const r = await sb.run(['broker', 'ask', REF, '--off'], { input: 'yes\n' });
        expect(r.code).toBe(code);
        expect(r.stdout + r.stderr).toMatch(says);
        expect(proxy!.requests).toEqual([{
          method: 'POST',
          url: '/broker/ask-first',
          body: { service: 'github', key: 'token', ask: false, project: sb.project, timeout_seconds: 90 },
        }]);
        expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
      }, T);
    }

    it('with no daemon there is no dialog, so nothing is removed: exit 1 and how to start it', async () => {
      await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token"]}');
      const r = await sb.run(['broker', 'ask', REF, '--off'], { input: 'yes\n' });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('The daemon shows the dialog a mark is removed in, and it is not running.');
      expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
    }, T);

    for (const flag of ['--yes', '-y', '--force', '--assume-yes', '--non-interactive', '--no-prompt', '--approve', '--confirm=yes']) {
      it(`no flag answers for the person: ${flag} is not an option, and nothing is asked or removed`, async () => {
        await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token"]}');
        await answer(200, { status: 'unmarked', ref: REF });
        const r = await sb.run(['broker', 'ask', REF, '--off', flag]);
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/unknown option/);
        expect(proxy!.requests).toEqual([]);
        expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
      }, T);
    }

    it('no environment variable answers for the person: with every likely one set, the daemon is still what is asked', async () => {
      await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token"]}');
      await answer(200, { status: 'declined', reason: 'the person at the dialog said no', ref: REF });
      const env = Object.fromEntries(['AQUAMAN_YES', 'AQUAMAN_ASSUME_YES', 'AQUAMAN_NON_INTERACTIVE', 'AQUAMAN_ASK_FIRST', 'AQUAMAN_ASK_FIRST_OFF', 'AQUAMAN_APPROVE', 'AQUAMAN_PROMPT', 'CI', 'YES'].map((k) => [k, '1']));
      const r = await sb.run(['broker', 'ask', REF, '--off'], { env, input: 'yes\n' });
      expect(r.code).toBe(2);
      expect(proxy!.requests).toHaveLength(1);
      expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
    }, T);

    it('--off takes one ref at a time, and a --timeout inside the daemon\'s bounds', async () => {
      await answer(200, { status: 'ready', ref: REF });
      const two = await sb.run(['broker', 'ask', REF, 'aquaman://slack/bot_token', '--off']);
      expect(two.code).toBe(1);
      expect(two.stderr).toContain('--off takes one ref at a time');
      expect((await sb.run(['broker', 'ask', REF, '--off', '--timeout', 'soon'])).code).toBe(1);
      expect(proxy!.requests).toEqual([]);
      await sb.run(['broker', 'ask', REF, '--off', '--timeout', '1']);
      await sb.run(['broker', 'ask', REF, '--off', '--timeout', '86400']);
      expect(proxy!.requests.map((q) => q.body.timeout_seconds)).toEqual([10, 600]);
    }, T);

    it.skipIf(!python)('where no dialog can be shown, anything but a typed yes at the terminal leaves the mark', async () => {
      await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token"]}');
      await answer(200, { status: 'pending', code: 'prompt_unavailable', reason: 'no desktop session', ref: REF });
      const r = await runTty(['broker', 'ask', REF, '--off'], [['Type yes to remove the mark: ', 'y\r']]);
      expect(r.code).toBe(2);
      expect(r.output).toContain('This removes the "ask first" mark from aquaman://github/token: aquaman then hands the value out without asking, to any program running as you, whenever it is declared.');
      expect(r.output).toContain('Still marked.');
      expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
    }, T);

    it.skipIf(!python)('where no dialog can be shown, a typed yes at the terminal removes the mark and tells the daemon to read the record again', async () => {
      await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token","slack/bot_token"]}');
      await answer(200, { status: 'pending', code: 'prompt_unavailable', reason: 'no desktop session', ref: REF });
      const r = await runTty(['broker', 'ask', REF, '--off'], [['Type yes to remove the mark: ', 'yes\r']]);
      expect(r.code, r.output).toBe(0);
      expect(await record()).toEqual({ v: 1, refs: ['slack/bot_token'] });
      expect(proxy!.requests.map((q) => q.body)).toEqual([
        { service: 'github', key: 'token', ask: false, project: sb.project, timeout_seconds: 90 },
        { reload: true },
      ]);
    }, T);

    (python ? it.fails : it.skip)('LIMIT: on a machine where no dialog can be shown, the typed yes at a terminal is the only check, and a program can give itself a terminal', async () => {
      await vault().set('aquaman_internal', 'ask_first', '{"v":1,"refs":["github/token"]}');
      await answer(200, { status: 'pending', code: 'prompt_unavailable', reason: 'no desktop session', ref: REF });
      // No person here: a program made the terminal and typed the word.
      await runTty(['broker', 'ask', REF, '--off'], [['Type yes to remove the mark: ', 'yes\r']]);
      // What a check that could tell a person from a program would leave behind.
      expect(await record()).toEqual({ v: 1, refs: ['github/token'] });
    }, T);
  });

  describe('aquaman get', () => {
    /** A daemon that answers a marked ref the way the real one does, with `outcome` as the person's answer. */
    const markedDaemon = async (outcome: { status: number; body: Record<string, unknown> }) => {
      proxy = await fakeProxy(sb.socket, (req, res) => {
        if (req.body.ask === false) {
          json(res, 404, { error: `${REF} is marked ask-first, and nobody has allowed it in the current window`, fix: 'x', code: 'ask_first_required' });
        } else {
          json(res, outcome.status, outcome.body);
        }
      });
    };

    it('a ref that needs no dialog is one request, which says not to raise one', async () => {
      await answer(200, { value: VALUE, expires_at: 'x' });
      const r = await sb.run(['get', REF]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(VALUE);
      expect(r.stderr).toBe('');
      expect(proxy!.requests.map((q) => q.body)).toEqual([{ service: 'github', key: 'token', ask: false }]);
    }, T);

    it('a marked ref: says it is waiting for the dialog, asks again with the wait and where it runs, and prints the value after a yes', async () => {
      await markedDaemon({ status: 200, body: { value: VALUE, expires_at: 'x' } });
      const r = await sb.run(['get', REF, '--ask-timeout', '20']);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(VALUE);
      expect(r.stderr).toContain(`${REF} is marked ask-first. Waiting up to 20 seconds for an answer in aquaman's dialog on this machine.`);
      expect(proxy!.requests.map((q) => q.body)).toEqual([
        { service: 'github', key: 'token', ask: false },
        { service: 'github', key: 'token', ask_timeout_seconds: 20, project: sb.project },
      ]);
    }, T);

    const refusals: Array<[string, Record<string, unknown>, number, RegExp, RegExp | null]> = [
      ['a person declined', { error: `The person at the dialog declined to hand out ${REF}`, code: 'ask_first_declined' }, 2, /Error: The person at the dialog declined to hand out/, /Fix:/],
      ['nobody answered', { error: `${REF} is marked ask-first, and nobody answered the dialog`, fix: 'Ask again and answer the dialog on this machine', code: 'ask_first_unanswered' }, 3, /Fix: Ask again and answer the dialog on this machine/, null],
      ['no dialog can be shown', { error: `${REF} is marked ask-first, and this daemon cannot show a dialog (no desktop session)`, fix: `A person can remove the mark at a terminal: aquaman broker ask ${REF} --off`, code: 'prompt_unavailable' }, 3, /Fix: A person can remove the mark at a terminal: aquaman broker ask aquaman:\/\/github\/token --off/, null],
    ];
    for (const [name, body, code, says, never] of refusals) {
      it(`${name}: exit ${code}, something a person can act on, and nothing on stdout`, async () => {
        await markedDaemon({ status: 404, body });
        const r = await sb.run(['get', REF]);
        expect(r.code).toBe(code);
        expect(r.stdout).toBe('');
        expect(r.stderr).toMatch(says);
        if (never) expect(r.stderr).not.toMatch(never);
      }, T);
    }

    it('--ask-timeout must be a whole number of seconds', async () => {
      await answer(200, { value: VALUE, expires_at: 'x' });
      const r = await sb.run(['get', REF, '--ask-timeout', 'long']);
      expect(r.code).toBe(1);
      expect(proxy!.requests).toEqual([]);
    }, T);
  });

  describe('aquaman broker list', () => {
    beforeEach(() => {
      sb.writeConfig(`credentials:\n  backend: encrypted-file\nbroker:\n  allowedRefs: ["${REF}", "aquaman://plain/key"]\n`);
    });

    it('shows which declared refs ask first, the window, and marks on refs that are not declared', async () => {
      await answer(200, { marked: [REF, 'aquaman://slack/bot_token'], window_seconds: 3600 });
      const r = await sb.run(['broker', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/aquaman:\/\/github\/token {2}\(config\.yaml\) {2}asks first/);
      expect(r.stdout).toMatch(/aquaman:\/\/plain\/key {2}\(config\.yaml\)\n/);
      expect(r.stdout).toContain('a yes lasts 1 hour or until the daemon stops');
      expect(r.stdout).toContain('Marked ask-first, not declared: aquaman://slack/bot_token');
      expect(proxy!.requests.map((q) => q.body)).toEqual([{ list: true }]);
    }, T);

    it('says so when the marks cannot be shown because no daemon serves the broker', async () => {
      const r = await sb.run(['broker', 'list']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Ask-first marks are not shown');
      expect(r.stdout).not.toContain('asks first');
    }, T);

    it('says that everything is asked about when the record cannot be read', async () => {
      await answer(200, { marked: 'all', window_seconds: 28800 });
      const r = await sb.run(['broker', 'list']);
      expect(r.stdout).toMatch(/plain\/key {2}\(config\.yaml\) {2}asks first/);
      expect(r.stdout).toContain('The ask-first record in the vault cannot be read, so the daemon asks before handing out every ref.');
    }, T);
  });

  describe('aquaman-coder', () => {
    // Not spawnSync: the daemon that answers is a server in this process.
    const coder = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(path.join(sb.bin, 'aquaman-coder'), args, { cwd: sb.project, env: sb.env(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    const bind = (env: Record<string, string>) =>
      fs.writeFileSync(path.join(sb.config, 'projects.yaml'), `projects:\n  app:\n    paths: ["${sb.project}"]\n    env:\n${Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`).join('\n')}\n`);
    /** `github/token` is marked and answers with `outcome` once a dialog is allowed; `plain/key` is not marked. */
    const daemon = async (outcome: { status: number; body: Record<string, unknown> }) => {
      proxy = await fakeProxy(sb.socket, (req, res) => {
        if (req.url !== '/broker/resolve') return json(res, 404, { error: 'not found' });
        if (req.body.service === 'plain') return json(res, 200, { value: 'plain-value-7731', expires_at: 'x' });
        if (req.body.ask === false) return json(res, 404, { error: `${REF} is marked ask-first, and nobody has allowed it in the current window`, fix: 'x', code: 'ask_first_required' });
        json(res, outcome.status, outcome.body);
      });
    };
    const SHOW = ['exec', '--', '/bin/sh', '-c', 'echo "gh=${#GITHUB_TOKEN} plain=${#PLAIN}"'];

    beforeEach(() => { sb.installRealCoder(); });

    it('exec waits for the dialog of a marked ref and runs the command with the value after a yes', async () => {
      bind({ GITHUB_TOKEN: REF });
      await daemon({ status: 200, body: { value: VALUE, expires_at: 'x' } });
      const r = await coder(SHOW);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(`gh=${VALUE.length} `);
      expect(r.stderr).toContain(`aquaman: ${REF} is marked ask-first. Waiting up to 90 seconds for an answer in aquaman's dialog on this machine.`);
      expect(proxy!.requests.map((q) => q.body)).toEqual([
        { service: 'github', key: 'token', ttl_seconds: 60, ask: false },
        { service: 'github', key: 'token', ttl_seconds: 60, ask_timeout_seconds: 90, project: sb.project },
      ]);
    }, T);

    const refusals: Array<[string, Record<string, unknown>, string]> = [
      ['a person declined', { error: `The person at the dialog declined to hand out ${REF}`, code: 'ask_first_declined' }, 'GITHUB_TOKEN is not set for this command: The person at the dialog declined to hand out'],
      ['nobody answered', { error: `${REF} is marked ask-first, and nobody answered the dialog`, fix: 'Ask again and answer the dialog on this machine', code: 'ask_first_unanswered' }, 'GITHUB_TOKEN is not set for this command: aquaman://github/token is marked ask-first, and nobody answered the dialog'],
      ['no dialog can be shown', { error: `${REF} is marked ask-first, and this daemon cannot show a dialog (no desktop session)`, fix: `A person can remove the mark at a terminal: aquaman broker ask ${REF} --off`, code: 'prompt_unavailable' }, `A person can remove the mark at a terminal: aquaman broker ask ${REF} --off`],
    ];
    for (const [name, body, says] of refusals) {
      it(`exec, ${name}: that variable is left unset and named, and the command runs with the project's other credentials`, async () => {
        bind({ GITHUB_TOKEN: REF, PLAIN: 'aquaman://plain/key' });
        await daemon({ status: 404, body });
        const r = await coder(SHOW);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain('gh=0 plain=16');
        expect(r.stderr).toContain(says);
      }, T);

      it(`exec, ${name}: a command for which nothing was handed out is not run`, async () => {
        bind({ GITHUB_TOKEN: REF });
        await daemon({ status: 404, body });
        const marker = path.join(sb.root, 'ran');
        const r = await coder(['exec', '--', '/usr/bin/touch', marker]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('none of this project\'s credentials were handed out (see above), so the command was not run.');
        expect(fs.existsSync(marker)).toBe(false);
      }, T);
    }

    it('doctor never raises the dialog: a marked ref is checked with ask: false and reported as marked', async () => {
      bind({ GITHUB_TOKEN: REF, PLAIN: 'aquaman://plain/key' });
      proxy = await fakeProxy(sb.socket, (req, res) => {
        if (req.url === '/_health') return json(res, 200, { status: 'ok', version: '9.9.9' });
        if (req.url !== '/broker/resolve') return json(res, 404, { error: 'not found' });
        if (req.body.service === 'plain') return json(res, 200, { value: 'plain-value-7731', expires_at: 'x' });
        json(res, 404, { error: 'marked', code: 'ask_first_required' });
      });
      const r = await coder(['doctor']);
      expect(r.stdout + r.stderr).toContain('marked ask-first: a person is asked in a dialog when a command needs it');
      const resolves = proxy!.requests.filter((q) => q.url === '/broker/resolve');
      expect(resolves.length).toBeGreaterThanOrEqual(2);
      for (const q of resolves) expect(q.body.ask).toBe(false);
    }, T);
  });

  describe('a real daemon, asked only what it answers without a dialog', () => {
    const NO_DIALOG = { ask: false } as const;

    it('enforces a mark the CLI set through it, shows it in broker list, and still hands out what is not marked', async () => {
      sb.writeConfig(`credentials:\n  backend: encrypted-file\nbroker:\n  allowedRefs: ["${REF}", "aquaman://plain/key"]\n`);
      await vault().set('github', 'token', VALUE);
      await vault().set('plain', 'key', 'plain-value-7731');
      await startDaemon(sb);

      const before = await udsPost('/broker/resolve', { service: 'github', key: 'token', ...NO_DIALOG });
      expect(before.json.value).toBe(VALUE);

      const marked = await sb.run(['broker', 'ask', REF]);
      expect(marked.code, marked.stderr).toBe(0);
      expect(marked.stdout).not.toContain('No daemon is serving');
      expect(await record()).toEqual({ v: 1, refs: ['github/token'] });

      const after = await udsPost('/broker/resolve', { service: 'github', key: 'token', ...NO_DIALOG });
      expect(after.status).toBe(404);
      expect(after.json.code).toBe('ask_first_required');
      expect(JSON.stringify(after.json)).not.toContain(VALUE);
      // The hook's question: a person could still say yes.
      expect((await udsPost('/broker/available', { refs: [{ service: 'github', key: 'token' }] })).json.available).toEqual([true]);

      const plain = await sb.run(['get', 'aquaman://plain/key']);
      expect(plain.stdout).toBe('plain-value-7731');

      const list = await sb.run(['broker', 'list']);
      expect(list.stdout).toMatch(/github\/token {2}\(config\.yaml\) {2}asks first/);
      expect(list.stdout).toContain('a yes lasts 8 hours or until the daemon stops');

      // Editing the file a program can edit does not remove it.
      sb.writeConfig(`credentials:\n  backend: encrypted-file\nbroker:\n  allowedRefs: ["${REF}"]\n  askFirst: false\n`);
      const edited = await udsPost('/broker/resolve', { service: 'github', key: 'token', ...NO_DIALOG });
      expect(edited.json.code).toBe('ask_first_required');
    }, T);

    it('a mark written to the vault while no daemon ran is enforced by the next one', async () => {
      sb.writeConfig(`credentials:\n  backend: encrypted-file\nbroker:\n  allowedRefs: ["${REF}"]\n`);
      await vault().set('github', 'token', VALUE);
      expect((await sb.run(['broker', 'ask', REF])).code).toBe(0);
      await startDaemon(sb);
      const res = await udsPost('/broker/resolve', { service: 'github', key: 'token', ...NO_DIALOG });
      expect(res.status).toBe(404);
      expect(res.json.code).toBe('ask_first_required');
      // The refusal is answered first and recorded right after.
      const logFile = path.join(sb.config, 'audit', 'current.jsonl');
      const read = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '');
      for (let i = 0; i < 50 && !read().includes('ask_first_required'); i++) await sleep(100);
      const audit = read();
      expect(audit).toContain('ask_first_required: github/token');
      expect(audit).not.toContain(VALUE);
    }, T);
  });
});
