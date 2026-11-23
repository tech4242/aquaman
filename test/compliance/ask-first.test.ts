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
 * The dialog is raised for a request on the Unix socket, by the OpenShell
 * driver, and for a request to be forwarded to a service that services.yaml
 * defines. A request on the loopback listener never raises one. A yes does
 * not outlast the vault being locked, and is not a yes for a reference that
 * was revoked while the dialog was up.
 *
 * A real proxy on a temporary socket and a loopback port, the real broker
 * scope over a config.yaml and a projects.yaml in a temp directory, and the
 * real OpenShell driver core. The person is a scripted prompter that records
 * the exact text the real dialog would have shown (`promptMessage` of the
 * request it was handed); no dialog is opened. Time is a clock the test owns.
 *
 * Limits, as `it.fails` rows: the mark is an item in the vault, so software
 * that can write to the vault itself can delete it; the daemon cannot tell
 * programs apart, so inside the window any program running as the user reads
 * the value without a dialog; marking asks nobody, so a program can fill the
 * record; two processes that each change the record with their own access to
 * the vault can lose one change; a daemon is not told about a change another
 * process made in the vault; and on a record that cannot be read, a reference
 * that is in no declaring file when one mark is removed loses its mark.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), AC-6 (least privilege), AU-2 (audit events); OWASP Agentic
 * ASI09 (human-agent trust exploitation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCredentialProxy,
  createBrokerScope,
  createServiceRegistry,
  AskFirstMarks,
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
  let servicesPath: string;
  /** Set to keep the next dialog up: `answer` is then called to close it. */
  let holdNext = false;
  let answer: ((r: PromptResult) => void) | undefined;

  /** The person: answers from `answers` in order, then says no. */
  const prompter: CredentialPrompter = {
    async askValue(request) {
      shown.push({ text: promptMessage(request, 'value'), request });
      return { outcome: 'declined' };
    },
    askApproval(request) {
      shown.push({ text: promptMessage(request, 'approval'), request });
      if (holdNext) {
        holdNext = false;
        return new Promise((r) => { answer = r; });
      }
      return Promise.resolve(answers.shift() ?? { outcome: 'declined' });
    },
    async askLoginItem() {
      return { outcome: 'declined' };
    },
  };

  const writeConfig = (allowed: string[], extra = '') =>
    fs.writeFileSync(configPath, `broker:\n  allowedRefs: [${allowed.map((r) => `"${r}"`).join(', ')}]\n${extra}`);
  const writeProjects = (env: Record<string, string>) =>
    fs.writeFileSync(projectsPath, `projects:\n  app:\n    paths: ["${dir}"]\n    env:\n${Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`).join('\n')}\n`);

  async function startProxy(opts: { store?: CredentialStore; prompter?: CredentialPrompter | null; allowedServices?: string[]; broker?: false } = {}): Promise<void> {
    socketPath = tmpSocketPath();
    port = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    });
    scope = createBrokerScope({ configPath, projectsPath });
    proxy = createCredentialProxy({
      socketPath,
      store: opts.store ?? store,
      allowedServices: opts.allowedServices ?? [],
      serviceRegistry: createServiceRegistry({ configPath: servicesPath }),
      broker: opts.broker === false ? undefined : scope,
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
    servicesPath = path.join(dir, 'services.yaml');
    holdNext = false;
    answer = undefined;
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
        'aquaman cannot tell which program is asking. Allow hands it the value, and for the next 1 hour (or until aquaman is restarted or its vault is locked) any program running as you can read this value from aquaman without another dialog. Deny if you did not expect this.',
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

    it('the dialog names the way the request came in, which is all aquaman knows about the caller', async () => {
      await resolve();
      await openshellResolve({ driver: 'aquaman', handle: 'aquaman://slack/bot_token' });
      expect(shown[0].text.split('\n')[0]).toBe('A program running as you is asking aquaman for the value of a credential that is marked "ask first".');
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
        expect(JSON.parse(res.body).code).toBe('ask_first_required');
        expect(shown).toEqual([]);
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

    it('a person removing one mark writes the record again with every declared reference still marked, and the dialog names them', async () => {
      await store.set(...RECORD, '{broken');
      await restartDaemon();
      answers = [{ outcome: 'approved' }];
      const res = await post('/broker/ask-first', { service: 'plain', key: 'key', ask: false });
      expect(JSON.parse(res.body).status).toBe('unmarked');
      expect(shown[0].text.split('\n').at(-1)).toBe('The record of marks cannot be read, so every credential counts as marked. After Allow only these 2 stay marked: github/token, slack/bot_token');
      expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://slack/bot_token']);
      expect(JSON.parse((await resolve({}, 'plain', 'key')).body).value).toBe('plain-value-not-marked');
      expect((await resolve()).body).not.toContain(SECRET);
    });

    it('the list that is written is the list the person was shown: a reference taken out of the declaring file while the dialog is up keeps its mark', async () => {
      await store.set(...RECORD, '{broken');
      await restartDaemon();
      holdNext = true;
      const pending = post('/broker/ask-first', { service: 'plain', key: 'key', ask: false });
      await until(() => answer !== undefined);
      expect(shown[0].text).toContain('After Allow only these 2 stay marked: github/token, slack/bot_token');
      // A program takes github/token out of config.yaml while the person reads the dialog.
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://slack/bot_token', 'aquaman://plain/key']);
      answer!({ outcome: 'approved' });
      expect(JSON.parse((await pending).body).status).toBe('unmarked');
      expect(await store.get(...RECORD)).toBe('{"v":1,"refs":["github/token","slack/bot_token"]}');
      // It writes the declaration back and asks for the value.
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://github/token', 'aquaman://slack/bot_token', 'aquaman://plain/key']);
      expect((await resolve()).body).not.toContain(SECRET);
    });

    it('a reference that is in no declaring file when the person is asked is not in the list, and the dialog says how many stay marked', async () => {
      await store.set(...RECORD, '{broken');
      await restartDaemon();
      // Out of config.yaml before the command is run: only what is declared now can be kept.
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://plain/key']);
      // The person reads the dialog, sees that nothing would stay marked, and says no.
      const res = await post('/broker/ask-first', { service: 'plain', key: 'key', ask: false });
      expect(JSON.parse(res.body).status).toBe('declined');
      expect(shown[0].text.split('\n').at(-1)).toBe('The record of marks cannot be read, so every credential counts as marked. After Allow none is marked.');
      expect(await store.get(...RECORD)).toBe('{broken');
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://github/token', 'aquaman://plain/key']);
      expect((await resolve()).body).not.toContain(SECRET);
    });

    it('a list too long to show in full is counted, and the names in it cannot add lines to the dialog', async () => {
      await store.set(...RECORD, '{broken');
      const many = Array.from({ length: 20 }, (_, i) => `aquaman://svc${String(i).padStart(2, '0')}/key`);
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://plain/key', ...many]);
      await restartDaemon();
      await post('/broker/ask-first', { service: 'plain', key: 'key', ask: false });
      const lines = shown[0].text.split('\n');
      expect(lines.at(-1)).toBe(`The record of marks cannot be read, so every credential counts as marked. After Allow only these 20 stay marked: ${many.slice(0, 8).map((r) => r.slice('aquaman://'.length)).join(', ')} and 12 more`);
      // aquaman's own sentences come first, as in every dialog.
      expect(lines.indexOf(UNMARK_CONSEQUENCE)).toBeLessThan(lines.length - 1);
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

  describe('two changes to the record at once', () => {
    /** A vault that takes a few milliseconds per call, as every backend but the in-memory one does. */
    class SlowStore extends MemoryStore {
      private wait = () => new Promise((r) => setTimeout(r, 5));
      override async get(service: string, key: string): Promise<string | null> {
        await this.wait();
        return super.get(service, key);
      }
      override async set(service: string, key: string, value: string, metadata?: Record<string, string>): Promise<void> {
        await this.wait();
        return super.set(service, key, value, metadata);
      }
    }
    const markRef = (service: string, key: string) => post('/broker/ask-first', { service, key, ask: true });

    beforeEach(async () => {
      const slow = new SlowStore();
      await slow.set('github', 'token', SECRET);
      await proxy.stop();
      cleanupSocket(socketPath);
      store = slow;
      await startProxy();
    });

    it('two marks set at the same moment are both kept, and both references are asked about', async () => {
      const [mine, theirs] = await Promise.all([markRef('github', 'token'), markRef('junk', 'a')]);
      expect(JSON.parse(mine.body).status).toBe('marked');
      expect(JSON.parse(theirs.body).status).toBe('marked');
      expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://junk/a']);
      const res = await resolve();
      expect(res.body).not.toContain(SECRET);
      expect(shown).toHaveLength(1);
    });

    it('a mark set while another program floods the endpoint with marks of its own is kept', async () => {
      let n = 0;
      let flooding = true;
      const flood = (async () => { while (flooding) await markRef('junk', `n${n++}`); })();
      const flood2 = (async () => { while (flooding) await markRef('junk', `m${n++}`); })();
      await new Promise((r) => setTimeout(r, 30));
      const mine: string[] = [];
      for (let i = 0; i < 10; i++) {
        expect(JSON.parse((await markRef('mine', `ref${i}`)).body)).toMatchObject({ status: 'marked' });
        mine.push(`aquaman://mine/ref${i}`);
        await new Promise((r) => setTimeout(r, 7));
      }
      flooding = false;
      await Promise.all([flood, flood2]);
      const list = (await marked()) as string[];
      expect(mine.filter((r) => !list.includes(r))).toEqual([]);
    });

    it('a mark set and another removed at the same moment: the record has the one and not the other', async () => {
      await markRef('github', 'token');
      await markRef('slack', 'bot_token');
      answers = [{ outcome: 'approved' }];
      const [off, on] = await Promise.all([
        post('/broker/ask-first', { service: 'slack', key: 'bot_token', ask: false }),
        markRef('late', 'key'),
      ]);
      expect(JSON.parse(off.body).status).toBe('unmarked');
      expect(JSON.parse(on.body).status).toBe('marked');
      expect(await marked()).toEqual(['aquaman://github/token', 'aquaman://late/key']);
    });
  });

  describe('the record is bounded', () => {
    it('256 names are kept, the next is refused with a code and a fix, and a name already marked still answers', async () => {
      // github/token and slack/bot_token are marked already.
      for (let i = 0; i < 254; i++) await mark('junk', `k${i}`);
      const res = await post('/broker/ask-first', { service: 'junk', key: 'one-more', ask: true });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'ask_first_full' });
      expect(JSON.parse(res.body).fix).toContain('aquaman broker ask <ref> --off');
      expect(JSON.parse((await store.get(...RECORD))!).refs).toHaveLength(256);
      expect(JSON.parse((await post('/broker/ask-first', { service: 'github', key: 'token', ask: true })).body).status).toBe('ready');
      // The marks that were there hold.
      expect((await resolve()).body).not.toContain(SECRET);
    });
  });

  describe('the loopback listener never raises a dialog', () => {
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['a plain request', {}],
      ['ask: true', { ask: true }],
      ['a long wait and a project', { ask_timeout_seconds: 600, project: '/code/app' }],
      ['ask as text', { ask: 'yes' }],
    ];
    for (const [name, extra] of attempts) {
      it(`${name}: ask_first_required, with the command a person runs to be asked, and nobody is asked`, async () => {
        const res = await loopback('/broker/resolve', { service: 'github', key: 'token', ...extra });
        expect(res.status).toBe(404);
        const body = JSON.parse(res.body);
        expect(body.code).toBe('ask_first_required');
        expect(body.fix).toContain('aquaman get aquaman://github/token > /dev/null');
        expect(res.body).not.toContain(SECRET);
        expect(shown).toEqual([]);
      });
    }

    it('it does not use up the dialogs a person on the socket has, and after their yes the value is served there too', async () => {
      for (let i = 0; i < 20; i++) await loopback('/broker/resolve', { service: 'github', key: 'token' });
      answers = [{ outcome: 'approved' }];
      expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
      expect(shown).toHaveLength(1);
      expect(JSON.parse((await loopback('/broker/resolve', { service: 'github', key: 'token' })).body).value).toBe(SECRET);
    });
  });

  describe('a reference revoked while its dialog is up', () => {
    it('/broker/resolve: the yes does not hand it out', async () => {
      holdNext = true;
      const pending = resolve();
      await until(() => answer !== undefined);
      // `aquaman broker revoke aquaman://github/token`, while the dialog waits.
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://slack/bot_token', 'aquaman://plain/key']);
      answer!({ outcome: 'approved' });
      const res = await pending;
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('broker_ref_not_declared');
      expect(res.body).not.toContain(SECRET);
      expect(log.at(-1)).toMatchObject({ statusCode: 404, error: 'broker_ref_not_declared: github/token' });
    });

    it('the OpenShell driver: the yes does not resolve it', async () => {
      holdNext = true;
      const pending = openshellResolve({ driver: 'aquaman', handle: 'aquaman://github/token' });
      await until(() => answer !== undefined);
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://slack/bot_token', 'aquaman://plain/key']);
      answer!({ outcome: 'approved' });
      const out = await pending;
      expect(out).not.toContain(SECRET);
      expect(out).toContain('failed_precondition');
    });
  });

  describe('forwarding for a service that services.yaml defines', () => {
    const ACME_SECRET = 'acme-ask-first-secret-0123456789';
    let upstream: http.Server;
    let got: http.IncomingHttpHeaders[];
    let upstreamPort = 0;

    /** What a program running as the user can write: a service definition with an upstream of its choosing. */
    async function defineAcme(definition: string, allowedServices = ['acme']): Promise<void> {
      fs.writeFileSync(servicesPath, `services:\n  - name: acme\n    upstream: http://127.0.0.1:${upstreamPort}\n${definition}`);
      await proxy.stop();
      cleanupSocket(socketPath);
      await startProxy({ allowedServices });
    }

    beforeEach(async () => {
      got = [];
      upstream = http.createServer((req, res) => { got.push(req.headers); res.end('ok'); });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
      upstreamPort = (upstream.address() as net.AddressInfo).port;
      await store.set('acme', 'api_key', ACME_SECRET);
      await store.set('acme', 'second', 'acme-second-value');
    });

    afterEach(async () => {
      await new Promise((r) => upstream.close(r));
    });

    const sent = () => JSON.stringify(got);

    it('the marked credential is not sent to the upstream the file names: the person is asked, told where it would go, and says no', async () => {
      await mark('acme', 'api_key');
      await defineAcme('    authHeader: x-acme-key\n    credentialKey: api_key\n');
      const res = await udsFetch(socketPath, '/acme/anything');
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('ask_first_declined');
      expect(JSON.parse(res.body).fix).toBeUndefined();
      expect(sent()).not.toContain(ACME_SECRET);
      expect(got).toEqual([]);
      expect(shown[0].text).toBe([
        'A program running as you is asking aquaman to send a request that carries a credential marked "ask first" to a service that is not built into aquaman.',
        '',
        'Credential: acme/api_key',
        '',
        'aquaman cannot tell which program is asking. Allow sends the value to the address this service is defined with in services.yaml, shown below, and for the next 1 hour (or until aquaman is restarted or its vault is locked) any program running as you can have it sent there, or read it from aquaman, without another dialog. Deny if you did not expect this, or if the address below is not one this value should go to.',
        '',
        'aquaman never asks for your login, Apple ID or password-manager password.',
        '',
        `Sent to (as services.yaml says): http://127.0.0.1:${upstreamPort}`,
      ].join('\n'));
      expect(log.at(-1)).toMatchObject({ service: 'acme', statusCode: 403, error: 'ask_first_declined: acme/api_key' });
    });

    it('with a yes the request goes on, and the yes is the one a resolve would have needed', async () => {
      await mark('acme', 'api_key');
      await defineAcme('    authHeader: x-acme-key\n    credentialKey: api_key\n');
      answers = [{ outcome: 'approved' }];
      expect((await udsFetch(socketPath, '/acme/anything')).status).toBe(200);
      expect(got[0]['x-acme-key']).toBe(ACME_SECRET);
      expect((await udsFetch(socketPath, '/acme/again')).status).toBe(200);
      expect(shown).toHaveLength(1);
    });

    it('on the loopback listener nobody is asked: ask_first_required, and nothing is sent', async () => {
      await mark('acme', 'api_key');
      await defineAcme('    authHeader: x-acme-key\n    credentialKey: api_key\n');
      const res = await fetch(`http://127.0.0.1:${port}/acme/anything`, { headers: { 'x-aquaman-token': TOKEN } });
      expect(res.status).toBe(403);
      expect(JSON.parse(await res.text()).code).toBe('ask_first_required');
      expect(got).toEqual([]);
      expect(shown).toEqual([]);
    });

    /** The other keys a definition can make the proxy read: each is sent somewhere the definition names. */
    const otherKeys: Array<[string, () => Record<string, unknown>]> = [
      ['the password half of a basic pair', () => ({ authHeader: 'Authorization', authMode: 'basic', credentialKey: 'second', additionalCredentialKeys: ['api_key'] })],
      ['a credential sent in an additional header', () => ({ authHeader: 'x-acme-key', authMode: 'header', credentialKey: 'second', additionalHeaders: { 'x-extra': { credentialKey: 'api_key' } } })],
      ['the client secret of a token exchange', () => ({ authHeader: 'Authorization', authMode: 'oauth', credentialKey: 'second', oauthConfig: { tokenUrl: `http://127.0.0.1:${upstreamPort}/token`, clientIdKey: 'second', clientSecretKey: 'api_key' } })],
      ['a credential named in braces in the token URL', () => ({ authHeader: 'Authorization', authMode: 'oauth', credentialKey: 'second', oauthConfig: { tokenUrl: `http://127.0.0.1:${upstreamPort}/{api_key}/token`, clientIdKey: 'second', clientSecretKey: 'second' } })],
    ];
    for (const [name, definition] of otherKeys) {
      it(`the marked credential as ${name}: not sent`, async () => {
        await mark('acme', 'api_key');
        await proxy.stop();
        cleanupSocket(socketPath);
        await startProxy({ allowedServices: ['acme'] });
        proxy.getServiceRegistry().register({ name: 'acme', upstream: `http://127.0.0.1:${upstreamPort}`, ...definition() } as never);
        const res = await udsFetch(socketPath, '/acme/anything');
        expect(res.status).toBe(403);
        expect(JSON.parse(res.body).code).toBe('ask_first_declined');
        expect(shown.map((d) => `${d.request.service}/${d.request.key}`)).toEqual(['acme/api_key']);
        expect(got).toEqual([]);
      });
    }

    it('a proxy without a broker (as OpenClaw hosts one) has nobody to ask, and refuses', async () => {
      await mark('acme', 'api_key');
      fs.writeFileSync(servicesPath, `services:\n  - name: acme\n    upstream: http://127.0.0.1:${upstreamPort}\n    authHeader: x-acme-key\n    credentialKey: api_key\n`);
      await proxy.stop();
      cleanupSocket(socketPath);
      await startProxy({ allowedServices: ['acme'], broker: false });
      const res = await udsFetch(socketPath, '/acme/anything');
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('prompt_unavailable');
      expect(got).toEqual([]);
      expect(shown).toEqual([]);
    });

    it('a credential that is not marked is forwarded as before, with no dialog', async () => {
      await defineAcme('    authHeader: x-acme-key\n    credentialKey: api_key\n');
      expect((await udsFetch(socketPath, '/acme/anything')).status).toBe(200);
      expect(got[0]['x-acme-key']).toBe(ACME_SECRET);
      expect(shown).toEqual([]);
    });

    it('a builtin service is not gated: a definition for its name in services.yaml is not used, so its upstream is the one aquaman ships', async () => {
      // github is a builtin and github/token is marked. The file names another upstream for it.
      fs.writeFileSync(servicesPath, `services:\n  - name: github\n    upstream: http://127.0.0.1:${upstreamPort}\n    authHeader: x-acme-key\n    credentialKey: token\n`);
      await proxy.stop();
      cleanupSocket(socketPath);
      await startProxy({ allowedServices: ['github'] });
      const registry = proxy.getServiceRegistry();
      expect(registry.get('github')!.upstream).toBe('https://api.github.com');
      expect(() => registry.register({ name: 'github', upstream: `http://127.0.0.1:${upstreamPort}`, authHeader: 'x-acme-key', credentialKey: 'token' })).toThrow();
      // With the shipped upstream replaced by a stand-in (which only a test
      // can do), the marked credential is forwarded and nobody is asked.
      registry.override('github', { upstream: `http://127.0.0.1:${upstreamPort}` });
      expect((await udsFetch(socketPath, '/github/user')).status).toBe(200);
      expect(String(got[0].authorization)).toContain(SECRET);
      expect(shown).toEqual([]);
    });
  });

  describe('a vault that is locked', () => {
    /** A store a person's session opens, as far as the proxy can see one. */
    class SessionStore extends MemoryStore {
      state: 'locked' | 'unlocked' = 'unlocked';
      vaultState(): 'locked' | 'unlocked' { return this.state; }
      forgetSession(): void { this.state = 'locked'; }
      async adoptSession(): Promise<{ ok: true }> { this.state = 'unlocked'; return { ok: true }; }
      async checkSession(): Promise<'locked' | 'unlocked'> { return this.state; }
      override async get(service: string, key: string): Promise<string | null> {
        if (this.state === 'locked') throw Object.assign(new Error('The vault is locked'), { code: 'vault_locked' });
        return super.get(service, key);
      }
    }
    let session: SessionStore;
    const SESSION = Buffer.from('a session only the stand-in store looks at, long enough to pass as one').toString('base64');

    beforeEach(async () => {
      session = new SessionStore();
      await session.set('github', 'token', SECRET);
      await session.set('acme', 'api_key', 'acme-locked-value');
      await session.set(...RECORD, '{"v":1,"refs":["acme/api_key","github/token"]}');
      fs.writeFileSync(servicesPath, 'services:\n  - name: acme\n    upstream: http://127.0.0.1:9\n    authHeader: x-acme-key\n    credentialKey: api_key\n');
      await proxy.stop();
      cleanupSocket(socketPath);
      store = session;
      await startProxy({ allowedServices: ['acme'] });
    });

    it('nobody is asked about a value that cannot be read: resolve, forwarding and the OpenShell driver answer vault_locked', async () => {
      // The marks are in the daemon's memory from a read while the vault was open.
      expect(await marked()).toEqual(['aquaman://acme/api_key', 'aquaman://github/token']);
      session.state = 'locked';
      const res = await resolve();
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'vault_locked', fix: 'Run: aquaman unlock' });
      const forwarded = await udsFetch(socketPath, '/acme/anything');
      expect(forwarded.status).toBe(503);
      expect(JSON.parse(forwarded.body).code).toBe('vault_locked');
      const driven = await openshellResolve({ driver: 'aquaman', handle: 'aquaman://github/token' });
      expect(driven).toContain('aquaman unlock');
      expect(driven).not.toContain(SECRET);
      expect(shown).toEqual([]);
    });

    it('aquaman lock takes back every yes: after the vault is opened again the person is asked again', async () => {
      answers = [{ outcome: 'approved' }];
      expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
      expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
      expect(shown).toHaveLength(1);

      expect(JSON.parse((await post('/_vault/lock', {})).body).status).toBe('locked');
      expect((await resolve()).status).toBe(503);
      expect((await post('/_vault/unlock', { session: SESSION })).status).toBe(200);

      const after = await resolve();
      expect(after.body).not.toContain(SECRET);
      expect(shown).toHaveLength(2);
    });

    it('a vault that was locked from outside and opened again without the daemon seeing it locked: the next unlock still takes back every yes', async () => {
      answers = [{ outcome: 'approved' }];
      expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
      // The session ended outside (`bw lock`); no request reached the gate meanwhile.
      session.state = 'locked';
      expect((await post('/_vault/unlock', { session: SESSION })).status).toBe(200);
      expect((await resolve()).body).not.toContain(SECRET);
      expect(shown).toHaveLength(2);
    });

    it('a vault found locked by a request drops the yes too: asked again once it is open', async () => {
      answers = [{ outcome: 'approved' }];
      expect(JSON.parse((await resolve()).body).value).toBe(SECRET);
      session.state = 'locked';
      expect((await resolve()).status).toBe(503);
      // Opened again by something that is not the daemon's own unlock.
      session.state = 'unlocked';
      expect((await resolve()).body).not.toContain(SECRET);
      expect(shown).toHaveLength(2);
    });

    it('a vault locked while the dialog is up: the yes hands nothing out and is not kept', async () => {
      holdNext = true;
      const pending = resolve();
      await until(() => answer !== undefined);
      session.state = 'locked';
      answer!({ outcome: 'approved' });
      const res = await pending;
      expect(res.status).toBe(503);
      expect(res.body).not.toContain(SECRET);
      session.state = 'unlocked';
      expect((await resolve()).body).not.toContain(SECRET);
      expect(shown).toHaveLength(2);
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

    it.fails('LIMIT: marking asks nobody, so a program can fill the record, and the person\'s own mark is then refused until marks are removed, one dialog each', async () => {
      for (let i = 0; i < 254; i++) await mark('junk', `k${i}`);
      const res = await post('/broker/ask-first', { service: 'plain', key: 'key', ask: true });
      // What a record that told a person's marks from a program's would do.
      expect(JSON.parse(res.body).status).toBe('marked');
    });

    it.fails('LIMIT: two processes that each change the record with their own access to the vault (a command with no daemon, twice) can lose one of the two changes', async () => {
      class SlowStore extends MemoryStore {
        override async get(service: string, key: string): Promise<string | null> {
          const value = await super.get(service, key);
          await new Promise((r) => setTimeout(r, 5));
          return value;
        }
      }
      const vault = new SlowStore();
      // Each `aquaman broker ask` with no daemon running is its own process, with its own queue.
      await Promise.all([new AskFirstMarks(vault).mark('github/token'), new AskFirstMarks(vault).mark('slack/bot_token')]);
      // What a record changed under a lock every process takes would hold.
      expect(await new AskFirstMarks(vault).list()).toEqual(['github/token', 'slack/bot_token']);
    });

    it.fails('LIMIT: a daemon that is not on the socket (an OpenClaw-hosted proxy took it) is not told when a command writes a mark into the vault itself, and goes on answering from the record it read', async () => {
      // The daemon has read the record: plain/key is not marked.
      expect(JSON.parse((await resolve({}, 'plain', 'key')).body).value).toBe('plain-value-not-marked');
      // `aquaman broker ask aquaman://plain/key` finds no broker on the socket and writes the vault itself.
      await new AskFirstMarks(store).mark('plain/key');
      // The daemon still serves its other listeners (the loopback port, the OpenShell driver).
      const res = await loopback('/broker/resolve', { service: 'plain', key: 'key' });
      // What a daemon that saw every change to the record would do.
      expect(res.body).not.toContain('plain-value-not-marked');
    });

    it.fails('LIMIT: on a record that cannot be read, a reference that is in no declaring file when a person agrees to remove another mark loses its own; the dialog lists what stays marked, not what does not', async () => {
      await store.set(...RECORD, 'not a record');
      await restartDaemon();
      // A program takes slack/bot_token out of config.yaml; the person removes the mark from github/token.
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://github/token']);
      answers = [{ outcome: 'approved' }];
      const off = await post('/broker/ask-first', { service: 'github', key: 'token', ask: false });
      expect(JSON.parse(off.body).status).toBe('unmarked');
      // The dialog did say that nothing else stays marked.
      expect(shown[0].text).toContain('After Allow none is marked.');
      // The program writes the declaration back and reads the value.
      await new Promise((r) => setTimeout(r, 20));
      writeConfig(['aquaman://github/token', 'aquaman://slack/bot_token']);
      const res = await resolve({}, 'slack', 'bot_token');
      // What a record that could still be read would do: slack/bot_token was marked.
      expect(res.body).not.toContain(OTHER_SECRET);
    });
  });
});
