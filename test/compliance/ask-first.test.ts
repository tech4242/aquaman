/**
 * Conformance: a reference marked ask-first is handed out only after a
 * person allowed it in the daemon's dialog, and a yes covers that one
 * reference until the window ends or the daemon stops.
 *
 * One table row per way around the dialog. Each row starts from the same
 * place: `github/token` is stored, declared and marked, and the person at
 * the dialog says no. The row does something to get the value anyway, and
 * passes when the value did not leave the daemon.
 *
 * A real proxy on a temporary socket and a loopback port, the real broker
 * scope over a config.yaml and a projects.yaml in a temp directory, and the
 * real OpenShell driver core. The person is a scripted prompter that records
 * the exact text the real dialog would have shown (`promptMessage` of the
 * request it was handed); no dialog is opened. Time is a clock the test owns.
 *
 * Limits, as `it.fails` rows: the mark is an item in the vault, so software
 * that can write to the vault itself can delete it; and the daemon cannot
 * tell programs apart, so inside the window any program running as the user
 * reads the value without a dialog.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), AC-6 (least privilege), AU-2 (audit events); OWASP Agentic
 * ASI09 (human-agent trust exploitation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCredentialProxy,
  createBrokerScope,
  promptMessage,
  readConsequence,
  UNMARK_CONSEQUENCE,
  windowText,
  clampAskFirstWindow,
  ASK_FIRST_WINDOW_SECONDS,
  ASK_FIRST_WINDOW_MIN_SECONDS,
  ASK_FIRST_WINDOW_MAX_SECONDS,
  type BrokerScope,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptRequest,
  type PromptResult,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore, type CredentialStore } from 'aquaman-core';
import { createOpenShellDriverCore, DriverError, type OpenShellDriverCore } from '../../packages/proxy/src/openshell/credential-driver.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const SECRET = 'ghp_ask_first_value_0123456789abcdef';
const OTHER_SECRET = 'xoxb-ask-first-other-0123456789';
const TOKEN = 'aqm_lb_ask_first_test_token_0123456789';
const WINDOW = 3600;
const RECORD = ['aquaman_internal', 'ask_first'] as const;

describe('ask first: no value without a person\'s yes', () => {
  let dir: string;
  let configPath: string;
  let projectsPath: string;
  let store: MemoryStore;
  let scope: BrokerScope;
  let proxy: CredentialProxy;
  let driver: OpenShellDriverCore;
  let socketPath = '';
  let port = 0;
  let clock: number;
  let shown: Array<{ text: string; request: PromptRequest }>;
  let answers: PromptResult[];
  let log: RequestInfo[];

  /** The person: answers from `answers` in order, then says no. */
  const prompter: CredentialPrompter = {
    async askValue(request) {
      shown.push({ text: promptMessage(request, 'value'), request });
      return { outcome: 'declined' };
    },
    async askApproval(request) {
      shown.push({ text: promptMessage(request, 'approval'), request });
      return answers.shift() ?? { outcome: 'declined' };
    },
    async askLoginItem() {
      return { outcome: 'declined' };
    },
  };

  const writeConfig = (allowed: string[], extra = '') =>
    fs.writeFileSync(configPath, `broker:\n  allowedRefs: [${allowed.map((r) => `"${r}"`).join(', ')}]\n${extra}`);
  const writeProjects = (env: Record<string, string>) =>
    fs.writeFileSync(projectsPath, `projects:\n  app:\n    paths: ["${dir}"]\n    env:\n${Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`).join('\n')}\n`);

  async function startProxy(opts: { store?: CredentialStore; prompter?: CredentialPrompter | null } = {}): Promise<void> {
    socketPath = tmpSocketPath();
    port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    scope = createBrokerScope({ configPath, projectsPath });
    proxy = createCredentialProxy({
      socketPath,
      store: opts.store ?? store,
      allowedServices: [],
      broker: scope,
      credentialRequests: opts.prompter === null ? undefined : { prompter: opts.prompter ?? prompter, declare: () => {} },
      loopback: { port, token: TOKEN },
      askFirst: { windowSeconds: WINDOW, now: () => clock },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
    driver = createOpenShellDriverCore({ store: opts.store ?? store, scope, askFirst: proxy.askFirstGate, version: 'test' });
  }

  async function restartDaemon(): Promise<void> {
    await proxy.stop();
    cleanupSocket(socketPath);
    await startProxy();
  }

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aq-askfirst-')));
    configPath = path.join(dir, 'config.yaml');
    projectsPath = path.join(dir, 'projects.yaml');
    writeConfig(['aquaman://github/token', 'aquaman://slack/bot_token', 'aquaman://plain/key']);
    store = new MemoryStore();
    await store.set('github', 'token', SECRET);
    await store.set('slack', 'bot_token', OTHER_SECRET);
    await store.set('plain', 'key', 'plain-value-not-marked');
    clock = Date.parse('2026-11-23T09:00:00Z');
    shown = [];
    answers = [];
    log = [];
    await startProxy();
    await mark('github', 'token');
    await mark('slack', 'bot_token');
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    if (socketPath) cleanupSocket(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = (urlPath: string, body: unknown) =>
    udsFetch(socketPath, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const resolve = (extra: Record<string, unknown> = {}, service = 'github', key = 'token') =>
    post('/broker/resolve', { service, key, ...extra });
  const loopback = async (urlPath: string, body: unknown, headers: Record<string, string> = { 'x-aquaman-token': TOKEN }) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.text() };
  };
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(done()).toBe(true);
  };
  const mark = async (service: string, key: string) => {
    const res = await post('/broker/ask-first', { service, key, ask: true });
    expect(res.status).toBe(200);
  };
  const marked = async (): Promise<unknown> => JSON.parse((await post('/broker/ask-first', { list: true })).body).marked;
  const available = async (service = 'github', key = 'token'): Promise<boolean> =>
    JSON.parse((await post('/broker/available', { refs: [{ service, key }] })).body).available[0];
  const openshellResolve = async (handle: Record<string, unknown>): Promise<string> => {
    try {
      return JSON.stringify(await driver.resolve([{ request_id: 'r1', provider: 'github', credential_key: 'GITHUB_TOKEN', handle }]));
    } catch (err) {
      expect(err).toBeInstanceOf(DriverError);
      return `${(err as DriverError).code}: ${(err as Error).message}`;
    }
  };

  describe('what the mark does', () => {
    it('a reference that is not marked is handed out as before: no dialog', async () => {
      const res = await resolve({}, 'plain', 'key');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).value).toBe('plain-value-not-marked');
      expect(shown).toEqual([]);
    });

    it('a marked reference raises the dialog on the first read, and a yes hands the value out and is remembered', async () => {
      answers = [{ outcome: 'approved' }];
      const first = await resolve({ project: '/code/app' });
      expect(first.status).toBe(200);
      expect(JSON.parse(first.body).value).toBe(SECRET);
      expect(shown).toHaveLength(1);
      expect(shown[0].request.read).toEqual({ windowSeconds: WINDOW, via: 'socket' });

      clock += (WINDOW - 1) * 1000;
      const second = await resolve();
      expect(JSON.parse(second.body).value).toBe(SECRET);
      expect(shown).toHaveLength(1);
    });

    it('the dialog says what a yes means: which credential, that the program is not known, every program running as the user, and for how long', async () => {
      answers = [{ outcome: 'approved' }];
      await resolve({ project: '/code/app' });
      expect(shown[0].text).toBe([
        'A program running as you is asking aquaman for the value of a credential that is marked "ask first".',
        '',
        'Credential: github/token',
        '',
        'aquaman cannot tell which program is asking. Allow hands it the value, and for the next 1 hour (or until aquaman is restarted) any program running as you can read this value from aquaman without another dialog. Deny if you did not expect this.',
        '',
        'aquaman never asks for your login, Apple ID or password-manager password.',
        '',
        'Requested from (as the caller reports it): /code/app',
      ].join('\n'));
      expect(shown[0].text).toContain(readConsequence(WINDOW));
    });

    it('what the dialog promises is what happens: another program reads within the stated time, and none after it', async () => {
      answers = [{ outcome: 'approved' }];
      await resolve();
      expect(shown[0].text).toContain(`for the next ${windowText(WINDOW)}`);
      clock += WINDOW * 1000 - 1;
      expect((await loopback('/broker/resolve', { service: 'github', key: 'token' })).body).toContain(SECRET);
      clock += 1;
      expect((await loopback('/broker/resolve', { service: 'github', key: 'token' })).body).not.toContain(SECRET);
    });

    it('the dialog names the listener the request came in on, which is all aquaman knows about the caller', async () => {
      await loopback('/broker/resolve', { service: 'github', key: 'token' });
      await openshellResolve({ driver: 'aquaman', handle: 'aquaman://slack/bot_token' });
      expect(shown[0].text.split('\n')[0]).toBe('A program that holds aquaman\'s local token is asking aquaman for the value of a credential that is marked "ask first".');
      expect(shown[1].text.split('\n')[0]).toBe('A program connected to aquaman\'s OpenShell driver is asking aquaman for the value of a credential that is marked "ask first".');
      for (const s of shown) expect(s.text).toContain('aquaman cannot tell which program is asking.');
    });

    it('the wait for an answer is the caller\'s, inside fixed bounds, and 90 seconds when it says nothing', async () => {
      answers = Array.from({ length: 4 }, () => ({ outcome: 'timeout' }) as PromptResult);
      await resolve();
      await resolve({ ask_timeout_seconds: 30 });
      await resolve({ ask_timeout_seconds: 1 });
      await resolve({ ask_timeout_seconds: 86_400 });
      expect(shown.map((s) => s.request.timeoutSeconds)).toEqual([90, 30, 10, 600]);
    });

    it('refusals are 404 with a code, like the scope\'s: declined (no fix), unanswered, no dialog possible (with the command a person runs)', async () => {
      answers = [{ outcome: 'timeout' }, { outcome: 'unavailable', reason: 'no desktop session' }, { outcome: 'declined' }];
      const unanswered = await resolve();
      const unavailable = await resolve();
      const declined = await resolve();
      expect([unanswered.status, unavailable.status, declined.status]).toEqual([404, 404, 404]);
      expect(JSON.parse(unanswered.body)).toMatchObject({ code: 'ask_first_unanswered', fix: expect.stringContaining('answer the dialog') });
      expect(JSON.parse(unavailable.body)).toMatchObject({ code: 'prompt_unavailable', fix: 'A person can remove the mark at a terminal: aquaman broker ask aquaman://github/token --off' });
      expect(JSON.parse(declined.body).code).toBe('ask_first_declined');
      expect(JSON.parse(declined.body).fix).toBeUndefined();
      for (const res of [unanswered, unavailable, declined]) expect(res.body).not.toContain(SECRET);
    });

    it('a caller that asks not to raise a dialog gets an answer at once, and no value', async () => {
      const res = await resolve({ ask: false });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('ask_first_required');
      expect(res.body).not.toContain(SECRET);
      expect(shown).toEqual([]);
    });

    it('/broker/available counts a marked reference while a person could still say yes, and not after a no', async () => {
      expect(await available()).toBe(true);
      expect(shown).toEqual([]);
      await resolve();
      expect(await available()).toBe(false);
      clock += 10 * 60 * 1000 + 1;
      expect(await available()).toBe(true);
    });

    it('every dialog outcome is an audit entry, the read stays one, and none carries the value', async () => {
      answers = [{ outcome: 'timeout' }, { outcome: 'declined' }];
      await resolve();
      await resolve();
      clock += 10 * 60 * 1000 + 1;
      answers = [{ outcome: 'approved' }];
      await resolve();
      const dialogs = log.filter((e) => e.method === 'BROKER_ASK' && !e.note?.includes('marked'));
      expect(dialogs.map((e) => e.error ?? e.note)).toEqual([
        'ask_first_unanswered: github/token',
        'ask_first_declined: github/token',
        `ask-first: a person allowed github/token for ${WINDOW} seconds`,
      ]);
      const reads = log.filter((e) => e.method === 'BROKER');
      expect(reads.map((e) => e.error)).toEqual(['ask_first_unanswered: github/token', 'ask_first_declined: github/token', undefined]);
      expect(JSON.stringify(log)).not.toContain(SECRET);
    });

    it('setting a mark is recorded, and asks nobody', async () => {
      expect(log.filter((e) => e.method === 'BROKER_ASK').map((e) => e.note)).toEqual(['ask-first: github/token marked', 'ask-first: slack/bot_token marked']);
      expect(shown).toEqual([]);
      expect(await store.get(...RECORD)).toBe('{"v":1,"refs":["github/token","slack/bot_token"]}');
    });

    it('the window is held between a minute and a day, whatever config.yaml says', () => {
      expect(clampAskFirstWindow(undefined)).toBe(ASK_FIRST_WINDOW_SECONDS);
      expect(ASK_FIRST_WINDOW_SECONDS).toBe(8 * 60 * 60);
      expect(clampAskFirstWindow(1)).toBe(ASK_FIRST_WINDOW_MIN_SECONDS);
      expect(clampAskFirstWindow(10 ** 9)).toBe(ASK_FIRST_WINDOW_MAX_SECONDS);
      expect(ASK_FIRST_WINDOW_MAX_SECONDS).toBe(24 * 60 * 60);
      expect(clampAskFirstWindow('forever')).toBe(ASK_FIRST_WINDOW_SECONDS);
      expect(clampAskFirstWindow(Number.POSITIVE_INFINITY)).toBe(ASK_FIRST_WINDOW_SECONDS);
    });
  });

  describe('ways around the dialog', () => {
    /**
     * Each returns everything the attempt got back. The person says no to
     * every dialog unless the row scripts an answer.
     */
    const ways: Array<[string, () => Promise<string>]> = [
      ['asking again right after the no', async () => {
        const first = await resolve();
        const again = await resolve();
        // The person is not asked twice, and the caller is given nothing to run.
        expect(shown).toHaveLength(1);
        expect(JSON.parse(again.body).fix).toBeUndefined();
        return first.body + again.body;
      }],
      ['asking again after the no with other words: another project, a longer wait, ask: true, the loopback listener, the OpenShell driver', async () => {
        const first = await resolve();
        const out = [
          first.body,
          (await resolve({ project: '/somewhere/else' })).body,
          (await resolve({ ask_timeout_seconds: 600, ask: true })).body,
          (await loopback('/broker/resolve', { service: 'github', key: 'token' })).body,
          await openshellResolve({ driver: 'aquaman', handle: 'aquaman://github/token' }),
        ];
        expect(shown).toHaveLength(1);
        return out.join('\n');
      }],
      ['the mark removed from config.yaml: the file is rewritten without anything about asking, and with keys that say not to ask', async () => {
        writeConfig(['aquaman://github/token'], '  askFirst: false\n  askFirstRefs: []\n  ask_first: []\naskFirst: []\n');
        return (await resolve()).body;
      }],
      ['the reference revoked in config.yaml and allowed again', async () => {
        writeConfig([]);
        const revoked = await resolve();
        expect(JSON.parse(revoked.body).code).toBe('broker_ref_not_declared');
        writeConfig(['aquaman://github/token']);
        return revoked.body + (await resolve()).body;
      }],
      ['the declaration moved to projects.yaml: removed from config.yaml and bound in a project instead', async () => {
        writeConfig([]);
        writeProjects({ GITHUB_TOKEN: 'aquaman://github/token' });
        return (await resolve()).body;
      }],
      ['the binding deleted from projects.yaml and written back', async () => {
        writeConfig([]);
        writeProjects({ GITHUB_TOKEN: 'aquaman://github/token' });
        const first = await resolve();
        writeProjects({ OTHER: 'aquaman://plain/key' });
        const gone = await resolve();
        expect(JSON.parse(gone.body).code).toBe('broker_ref_not_declared');
        writeProjects({ GH: 'aquaman://github/token' });
        clock += 10 * 60 * 1000 + 1;
        return first.body + gone.body + (await resolve()).body;
      }],
      ['a window of a hundred years written into config.yaml while the daemon runs', async () => {
        writeConfig(['aquaman://github/token'], '  askFirstWindowSeconds: 3153600000\n');
        answers = [{ outcome: 'approved' }];
        await resolve({}, 'slack', 'bot_token');
        // The yes the person gave lasts what the dialog said, not what the file says now.
        clock += WINDOW * 1000;
        return (await resolve({}, 'slack', 'bot_token')).body.replace(OTHER_SECRET, SECRET);
      }],
      ['a second reference riding on the first one\'s yes', async () => {
        answers = [{ outcome: 'approved' }];
        const other = await resolve({}, 'slack', 'bot_token');
        expect(JSON.parse(other.body).value).toBe(OTHER_SECRET);
        const res = await resolve();
        expect(shown.map((s) => `${s.request.service}/${s.request.key}`)).toEqual(['slack/bot_token', 'github/token']);
        return res.body;
      }],
      ['the loopback listener, with the token agent hosts hold', async () => {
        const res = await loopback('/broker/resolve', { service: 'github', key: 'token' });
        expect(res.status).toBe(404);
        expect(shown).toHaveLength(1);
        return res.body;
      }],
      ['the loopback listener, with the token sent as a provider key', async () => {
        const asKey = await loopback('/broker/resolve', { service: 'github', key: 'token' }, { 'x-api-key': TOKEN });
        const asBearer = await loopback('/broker/resolve', { service: 'github', key: 'token' }, { authorization: `Bearer ${TOKEN}` });
        return asKey.body + asBearer.body;
      }],
      ['the OpenShell driver, resolving the reference as a handle', async () => {
        const out = await openshellResolve({ driver: 'aquaman', handle: 'aquaman://github/token', metadata: { mode: 'reference' } });
        expect(out).toMatch(/^failed_precondition: aquaman: The person at the dialog declined/);
        expect(shown).toHaveLength(1);
        return out;
      }],
      ['the OpenShell driver, with the handle labelled as the gateway\'s own copy', async () => {
        return openshellResolve({ driver: 'aquaman', handle: 'aquaman://github/token', metadata: { mode: 'copy' } });
      }],
      ['the OpenShell driver, storing the reference as a new provider credential and resolving that', async () => {
        const stored = await driver.store({ provider: 'github', credential_key: 'GITHUB_TOKEN', value: 'aquaman://github/token', object_id: 'obj1' });
        // Checking a reference hands nothing out, so nobody is asked for it.
        expect(shown).toEqual([]);
        return JSON.stringify(stored) + await openshellResolve(stored.handle as Record<string, unknown>);
      }],
      ['a window that has ended', async () => {
        answers = [{ outcome: 'approved' }];
        expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
        clock += WINDOW * 1000;
        const res = await resolve();
        expect(shown).toHaveLength(2);
        return res.body;
      }],
      ['a daemon restart inside the window', async () => {
        answers = [{ outcome: 'approved' }];
        expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
        await restartDaemon();
        const res = await resolve();
        expect(shown).toHaveLength(2);
        return res.body;
      }],
      ['a second request while the dialog is up: it waits for the same answer and gets the same no', async () => {
        let release!: (r: PromptResult) => void;
        const slow: CredentialPrompter = {
          ...prompter,
          askApproval: (request) => { shown.push({ text: promptMessage(request, 'approval'), request }); return new Promise((r) => { release = r; }); },
        };
        await proxy.stop();
        cleanupSocket(socketPath);
        await startProxy({ prompter: slow });
        const one = resolve();
        await until(() => shown.length === 1);
        const two = resolve();
        const other = await resolve({}, 'slack', 'bot_token');
        expect(JSON.parse(other.body).code).toBe('ask_first_unanswered');
        release({ outcome: 'declined' });
        const [a, b] = await Promise.all([one, two]);
        expect(shown).toHaveLength(1);
        return a.body + b.body + other.body.replace(OTHER_SECRET, SECRET);
      }],
      ['asking until the person gives in: after six dialogs in ten minutes no more are shown', async () => {
        answers = Array.from({ length: 20 }, () => ({ outcome: 'timeout' }) as PromptResult);
        const out: string[] = [];
        for (let i = 0; i < 9; i++) out.push((await resolve()).body);
        expect(shown).toHaveLength(6);
        return out.join('\n');
      }],
      ['a dialog that returns a typed value where a yes or no was asked for', async () => {
        answers = [{ outcome: 'entered', value: 'yes' }];
        const res = await resolve();
        expect(JSON.parse(res.body).code).toBe('ask_first_unanswered');
        return res.body;
      }],
      ['a daemon that has no dialog at all', async () => {
        await proxy.stop();
        cleanupSocket(socketPath);
        await startProxy({ prompter: null });
        const res = await resolve();
        expect(JSON.parse(res.body).code).toBe('prompt_unavailable');
        return res.body;
      }],
      ['a credential request for the same reference: it is stored and declared already, so nobody is asked and nothing is allowed', async () => {
        const requested = await post('/broker/request', { service: 'github', key: 'token' });
        expect(JSON.parse(requested.body).status).toBe('ready');
        return requested.body + (await resolve()).body;
      }],
      ['fields in the resolve body that claim an approval', async () => {
        const res = await resolve({ approved: true, ask_first: false, confirm: 'yes', force: true, window_seconds: 999999 });
        expect(shown).toHaveLength(1);
        return res.body;
      }],
      ['marking it again, which could start it afresh', async () => {
        const first = await resolve();
        await mark('github', 'token');
        return first.body + (await resolve()).body;
      }],
      ['removing the mark without a person: the request is made and the person says no', async () => {
        const res = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
        expect(JSON.parse(res.body)).toEqual({ status: 'declined', reason: 'the person at the dialog said no', ref: 'aquaman://github/token' });
        expect(shown[0].request.unmark).toBe(true);
        clock += 10 * 60 * 1000 + 1;
        return res.body + (await resolve()).body;
      }],
      ['removing the mark without a person: nobody answers, or no dialog can be shown', async () => {
        answers = [{ outcome: 'timeout' }, { outcome: 'unavailable', reason: 'no desktop session' }];
        const unanswered = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
        const unavailable = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
        expect(JSON.parse(unanswered.body)).toMatchObject({ status: 'pending', fix: 'Run in a terminal: aquaman broker ask aquaman://github/token --off' });
        expect(JSON.parse(unavailable.body)).toMatchObject({ status: 'pending', code: 'prompt_unavailable' });
        expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://slack/bot_token']);
        return unanswered.body + unavailable.body + (await resolve()).body;
      }],
      ['removing the mark without a person: fields that claim the person agreed', async () => {
        const res = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false, approved: true, confirm: 'yes', force: true, outcome: 'approved' });
        expect(shown).toHaveLength(1);
        expect(JSON.parse(res.body).status).toBe('declined');
        clock += 10 * 60 * 1000 + 1;
        return res.body + (await resolve()).body;
      }],
      ['removing the mark without a person: asking again right after the no', async () => {
        await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
        const again = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
        expect(shown).toHaveLength(1);
        expect(JSON.parse(again.body)).toMatchObject({ status: 'declined' });
        expect(JSON.parse(again.body).fix).toBeUndefined();
        clock += 10 * 60 * 1000 + 1;
        return again.body + (await resolve()).body;
      }],
      ['removing the mark without a person: over the loopback listener', async () => {
        const res = await loopback('/broker/ask-first', { service: 'github', key: 'token', ask: false });
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body).code).toBe('ask_first_local_only');
        expect(shown).toEqual([]);
        return res.body + (await resolve()).body;
      }],
      ['removing the mark without a person: a body that is not a plain true or false', async () => {
        const out: string[] = [];
        for (const ask of ['false', 0, null, 'off', []]) {
          const res = await post('/broker/ask-first', { service: 'github', key: 'token', ask });
          expect(res.status).toBe(400);
          out.push(res.body);
        }
        expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://slack/bot_token']);
        return out.join('') + (await resolve()).body;
      }],
      ['removing the mark without a person: telling the daemon to read the record again, when nothing changed it', async () => {
        const res = await post('/broker/ask-first', { reload: true });
        expect(JSON.parse(res.body)).toEqual({ status: 'reloaded' });
        return (await resolve()).body;
      }],
      ['removing another reference\'s mark, with the person agreeing to that one', async () => {
        answers = [{ outcome: 'approved' }];
        const res = await post('/broker/ask-first', { service: 'slack', key: 'bot_token', ask: false });
        expect(JSON.parse(res.body).status).toBe('unmarked');
        expect(await marked()).toEqual(['aquaman://github/token']);
        return (await resolve()).body;
      }],
    ];

    for (const [name, attempt] of ways) {
      it(`${name}: the value does not leave the daemon`, async () => {
        const got = await attempt();
        expect(got).not.toContain(SECRET);
        expect(JSON.stringify(log)).not.toContain(SECRET);
      });
    }
  });

  describe('a record that cannot be read as one', () => {
    const malformed: Array<[string, string]> = [
      ['not JSON', 'ask first: github/token'],
      ['an empty string', ''],
      ['JSON null', 'null'],
      ['a list where the record should be', '["github/token"]'],
      ['another version', '{"v":2,"refs":["github/token"]}'],
      ['no version', '{"refs":["github/token"]}'],
      ['refs that is not a list', '{"v":1,"refs":"github/token"}'],
      ['refs that is an object', '{"v":1,"refs":{"github/token":true}}'],
      ['no refs', '{"v":1}'],
      ['an entry that is not a reference name', '{"v":1,"refs":["github/token",7]}'],
      ['an entry written as a full reference', '{"v":1,"refs":["aquaman://github/token"]}'],
      ['cut short', '{"v":1,"refs":["github/tok'],
    ];

    for (const [name, raw] of malformed) {
      it(`${name}: every reference is asked about, the marked one and one that never was`, async () => {
        await store.set(...RECORD, raw);
        await restartDaemon();
        const wasMarked = await resolve();
        const neverMarked = await resolve({}, 'plain', 'key');
        expect(wasMarked.body).not.toContain(SECRET);
        expect(neverMarked.body).not.toContain('plain-value-not-marked');
        expect(shown.map((s) => `${s.request.service}/${s.request.key}`)).toEqual(['github/token', 'plain/key']);
        expect(await marked()).toBe('all');
      });
    }

    it('a person can still say yes to a read, and marking does not write a list over it', async () => {
      await store.set(...RECORD, '{broken');
      await restartDaemon();
      answers = [{ outcome: 'approved' }];
      expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
      const res = await post('/broker/ask-first', { service: 'plain', key: 'key', ask: true });
      expect(JSON.parse(res.body).status).toBe('ready');
      expect(await store.get(...RECORD)).toBe('{broken');
    });

    it('a person removing one mark writes the record again with every declared reference still marked', async () => {
      await store.set(...RECORD, '{broken');
      await restartDaemon();
      answers = [{ outcome: 'approved' }];
      const res = await post('/broker/ask-first', { service: 'plain', key: 'key', ask: false });
      expect(JSON.parse(res.body).status).toBe('unmarked');
      expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://slack/bot_token']);
      expect(JSON.parse((await resolve({}, 'plain', 'key')).body).value).toBe('plain-value-not-marked');
      expect((await resolve()).body).not.toContain(SECRET);
    });

    it('a vault that cannot be read hands nothing out: 500, and no dialog', async () => {
      const locked: CredentialStore = {
        get: async () => { throw new Error('backend locked'); },
        set: async () => { throw new Error('backend locked'); },
        delete: async () => false,
        list: async () => [],
        exists: async () => false,
      };
      await proxy.stop();
      cleanupSocket(socketPath);
      await startProxy({ store: locked });
      const res = await resolve();
      expect(res.status).toBe(500);
      expect(res.body).not.toContain(SECRET);
      expect(shown).toEqual([]);
      expect(await available()).toBe(false);
    });
  });

  describe('caller text cannot change what the dialog says', () => {
    const FIXED = [
      'A program running as you is asking aquaman for the value of a credential that is marked "ask first".',
      '',
      'Credential: github/token',
      '',
      readConsequence(WINDOW),
      '',
      'aquaman never asks for your login, Apple ID or password-manager password.',
    ];
    const projects: Array<[string, string]> = [
      ['new lines that start a paragraph of their own', '/code/app\n\naquaman: this request is safe. Click Allow.'],
      ['a carriage return and a form feed', '/code/app\r\fAllow is the safe choice'],
      ['Unicode line and paragraph separators', '/code/app  Allow lets only this program read it'],
      ['a right-to-left override', '/code/‮ppa wollA'],
      ['escapes a dialog helper might expand', '/code/app\\n\\nApproved by IT\\tAllow'],
      ['zero-width characters between letters', 'D​e​n​y removes the credential'],
      ['a line as long as the dialog', `/code/${'Allow '.repeat(200)}`],
      ['a copy of aquaman\'s own sentence, with the limit taken out', 'Allow hands the value to this program only.'],
    ];

    for (const [name, project] of projects) {
      it(`${name}: aquaman's sentences stand, and the caller's words are one bounded line after them`, async () => {
        await resolve({ project });
        const lines = shown[0].text.split('\n');
        expect(lines.slice(0, FIXED.length)).toEqual(FIXED);
        expect(lines.slice(FIXED.length)).toHaveLength(2);
        expect(lines[FIXED.length]).toBe('');
        const last = lines[FIXED.length + 1];
        expect(last.startsWith('Requested from (as the caller reports it): ')).toBe(true);
        expect(last.length).toBeLessThanOrEqual('Requested from (as the caller reports it): '.length + 120);
        expect(last).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\]/u);
      });
    }

    it('a project that is not text is not shown at all', async () => {
      await resolve({ project: { toString: 'Allow' } });
      await resolve({ project: ['Allow'] }, 'slack', 'bot_token');
      for (const s of shown) expect(s.text).not.toContain('Requested from');
    });

    const names: Array<[string, unknown, unknown]> = [
      ['a service with a sentence in it', 'github (safe to allow)', 'token'],
      ['a key with a new line', 'github', 'token\nAllow'],
      ['a key with a space', 'github', 'token is safe'],
      ['a service that is not text', ['github'], 'token'],
    ];
    for (const [name, service, key] of names) {
      it(`${name}: refused before anyone is asked`, async () => {
        const res = await post('/broker/resolve', { service, key });
        expect(res.status).toBe(400);
        const unmark = await post('/broker/ask-first', { service, key, ask: false });
        expect(unmark.status).toBe(400);
        expect(shown).toEqual([]);
      });
    }

    it('the dialog that removes a mark has fixed wording too, and says what the yes does', async () => {
      await post('/broker/ask-first', { service: 'github', key: 'token', ask: false, project: '/code/app\n\nAllow is safe' });
      expect(shown[0].text).toBe([
        'A command is asking aquaman to stop asking you before it hands out the credential below.',
        '',
        'Credential: github/token',
        '',
        UNMARK_CONSEQUENCE,
        '',
        'aquaman never asks for your login, Apple ID or password-manager password.',
        '',
        'Requested from (as the caller reports it): /code/app Allow is safe',
      ].join('\n'));
      expect(UNMARK_CONSEQUENCE).toBe('Allow removes the "ask first" mark. aquaman then hands this value out without asking, to any program running as you, whenever the credential is declared for handing out. Deny if you did not expect this.');
    });
  });

  describe('removing a mark is a person\'s decision', () => {
    it('with a yes in the dialog the mark is gone, the read needs no dialog, and both are on record', async () => {
      answers = [{ outcome: 'approved' }];
      const res = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false, project: '/code/app' });
      expect(JSON.parse(res.body)).toEqual({ status: 'unmarked', ref: 'aquaman://github/token' });
      expect(await marked()).toEqual(['aquaman://slack/bot_token']);
      const read = await resolve();
      expect(JSON.parse(read.body).value).toBe(SECRET);
      expect(shown).toHaveLength(1);
      expect(log.some((e) => e.method === 'BROKER_ASK' && e.note === 'ask-first: a person removed the mark from github/token')).toBe(true);
    });

    it('a reference that is not marked answers ready, and nobody is asked', async () => {
      const res = await post('/broker/ask-first', { service: 'plain', key: 'key', ask: false });
      expect(JSON.parse(res.body)).toEqual({ status: 'ready', ref: 'aquaman://plain/key' });
      expect(shown).toEqual([]);
    });

    it('marks are changed over the Unix socket only, and never for aquaman\'s own records', async () => {
      const viaLoopback = await loopback('/broker/ask-first', { service: 'plain', key: 'key', ask: true });
      expect(viaLoopback.status).toBe(404);
      for (const service of ['aquaman_internal', 'aquaman-internal', 'aquaman.internal']) {
        const res = await post('/broker/ask-first', { service, key: 'ask_first', ask: true });
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body).code).toBe('broker_ref_reserved');
      }
      expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://slack/bot_token']);
    });

    it('a proxy without a broker scope keeps no marks and shows no dialog', async () => {
      await proxy.stop();
      cleanupSocket(socketPath);
      socketPath = tmpSocketPath();
      proxy = createCredentialProxy({ socketPath, store, allowedServices: [], credentialRequests: { prompter, declare: () => {} } });
      await proxy.start();
      const res = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('broker_disabled');
      expect((await resolve()).body).not.toContain(SECRET);
      expect(shown).toEqual([]);
    });
  });

  describe('limits', () => {
    it.fails('LIMIT: software that can write to the vault itself (the vault\'s own CLI or API) can delete the ask-first record, and the value is then handed out with no dialog', async () => {
      // Not through aquaman: straight into the vault, as `op`, `bw`, `vault kv delete` or a keychain call would.
      await store.delete(...RECORD);
      await post('/broker/ask-first', { reload: true });
      const res = await resolve();
      // What a record only aquaman could change would do. The vault does not tell its writers apart.
      expect(res.body).not.toContain(SECRET);
    });

    it.fails('LIMIT: inside the window any program running as the user reads the value without a dialog; the daemon cannot tell which program is asking', async () => {
      answers = [{ outcome: 'approved' }];
      await resolve({ project: '/code/the-program-the-person-meant' });
      const other = await loopback('/broker/resolve', { service: 'github', key: 'token' });
      expect(other.status).toBe(200);
      // What an approval for one program would do: the second caller is a different one, and is asked about.
      expect(shown).toHaveLength(2);
    });
  });
});
