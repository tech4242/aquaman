/**
 * Conformance: `POST /broker/request` lets a caller ask for a credential by
 * reference and never lets it hold, see or replace the value.
 *
 * The human is a scripted prompter here; the real dialogs live in
 * credential-prompt.ts.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), IA-5 (authenticator management), AU-2 (audit events).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import {
  createCredentialProxy,
  createBrokerScope,
  PROMPT_TIMEOUT_SECONDS,
  PROMPT_TIMEOUT_MIN_SECONDS,
  PROMPT_TIMEOUT_MAX_SECONDS,
  promptMessage,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptResult,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const SECRET = 'ghp_typed_by_the_human_0123456789';

describe('credential requests', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;
  let declared: Set<string>;
  let asked: string[];
  let waits: Array<number | undefined>;
  let log: RequestInfo[];
  let loopbackPort = 0;

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    if (socketPath) cleanupSocket(socketPath);
  });

  async function start(opts: {
    value?: PromptResult | (() => Promise<PromptResult>);
    approval?: PromptResult;
    withRequests?: boolean;
    withScope?: boolean;
    loopback?: boolean;
  } = {}) {
    store = new MemoryStore();
    declared = new Set();
    asked = [];
    waits = [];
    log = [];
    socketPath = tmpSocketPath();
    const prompter: CredentialPrompter = {
      async askValue(r) {
        asked.push(`value:${r.service}/${r.key}`);
        waits.push(r.timeoutSeconds);
        const v = opts.value ?? { outcome: 'entered', value: SECRET };
        return typeof v === 'function' ? v() : v;
      },
      async askApproval(r) {
        asked.push(`approval:${r.service}/${r.key}`);
        return opts.approval ?? { outcome: 'approved' };
      },
    };
    // A scope whose declared set this test controls.
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    const controlled = {
      ...scope,
      check: (service: string, key: string, caller: 'uds' | 'loopback') =>
        declared.has(`${service}/${key}`)
          ? ({ allowed: true } as const)
          : scope.check(service, key, caller),
    };
    if (opts.loopback) {
      loopbackPort = await new Promise<number>((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
      });
    }
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['github'],
      broker: opts.withScope === false ? undefined : controlled,
      credentialRequests: opts.withRequests === false
        ? undefined
        : { prompter, declare: (service, key) => { declared.add(`${service}/${key}`); } },
      loopback: opts.loopback ? { port: loopbackPort, token: 'aqm_lb_test_token_0123456789' } : undefined,
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const request = (body: Record<string, unknown>) =>
    udsFetch(socketPath, '/broker/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('stores what the human types, declares the ref, and returns no value', async () => {
    await start();
    const res = await request({ service: 'github', key: 'token', project: '/code/app' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'stored', ref: 'aquaman://github/token' });
    expect(res.body).not.toContain(SECRET);
    expect(JSON.stringify(res.headers)).not.toContain(SECRET);
    expect(await store.get('github', 'token')).toBe(SECRET);
    expect(declared.has('github/token')).toBe(true);
    expect(asked).toEqual(['value:github/token']);
  });

  it('keeps the wait the caller asks for inside fixed bounds', async () => {
    await start({ value: { outcome: 'timeout' } });
    await request({ service: 'github', key: 'a' });
    await request({ service: 'github', key: 'b', timeout_seconds: 30 });
    await request({ service: 'github', key: 'c', timeout_seconds: 1 });
    await request({ service: 'github', key: 'd', timeout_seconds: 86_400 });
    await request({ service: 'github', key: 'e', timeout_seconds: 'forever' });
    expect(waits).toEqual([
      PROMPT_TIMEOUT_SECONDS, 30, PROMPT_TIMEOUT_MIN_SECONDS, PROMPT_TIMEOUT_MAX_SECONDS, PROMPT_TIMEOUT_SECONDS,
    ]);
  });

  it('asks nobody when the credential is already stored and declared', async () => {
    await start();
    await store.set('github', 'token', 'existing');
    declared.add('github/token');
    const res = await request({ service: 'github', key: 'token' });
    expect(JSON.parse(res.body)).toEqual({ status: 'ready', ref: 'aquaman://github/token' });
    expect(asked).toEqual([]);
  });

  it('asks for approval, not a value, when the credential exists but is not declared', async () => {
    await start();
    await store.set('github', 'token', 'existing');
    const res = await request({ service: 'github', key: 'token' });
    expect(JSON.parse(res.body).status).toBe('approved');
    expect(asked).toEqual(['approval:github/token']);
    expect(await store.get('github', 'token')).toBe('existing');
    expect(declared.has('github/token')).toBe(true);
  });

  it('never replaces a stored value, even if one appears while the dialog is open', async () => {
    await start({ value: async () => { await store.set('github', 'token', 'stored-meanwhile'); return { outcome: 'entered', value: SECRET }; } });
    await request({ service: 'github', key: 'token' });
    expect(await store.get('github', 'token')).toBe('stored-meanwhile');
  });

  it('a decline stores and declares nothing, and is not asked again right away', async () => {
    await start({ value: { outcome: 'declined' } });
    const first = JSON.parse((await request({ service: 'github', key: 'token' })).body);
    expect(first.status).toBe('declined');
    // A decline never comes back with a command that would do it anyway.
    expect(first.fix).toBeUndefined();
    expect(await store.exists('github', 'token')).toBe(false);
    expect(declared.size).toBe(0);
    const again = JSON.parse((await request({ service: 'github', key: 'token' })).body);
    expect(again.status).toBe('declined');
    expect(again.fix).toBeUndefined();
    expect(asked).toEqual(['value:github/token']);
  });

  it('a declined approval of a stored credential carries no command either', async () => {
    await start({ approval: { outcome: 'declined' } });
    await store.set('github', 'token', 'existing');
    const res = await request({ service: 'github', key: 'token' });
    expect(JSON.parse(res.body)).toEqual({ status: 'declined', ref: 'aquaman://github/token', reason: 'the person at the dialog said no' });
    expect(res.body).not.toContain('broker allow');
    expect(declared.size).toBe(0);
  });

  it('refuses names too long to read in a dialog, and bodies that are not objects, before asking anyone', async () => {
    await start();
    expect((await request({ service: 'github', key: 'k'.repeat(65) })).status).toBe(400);
    expect((await request({ service: 'g'.repeat(65), key: 'token' })).status).toBe(400);
    for (const raw of ['null', '[]', '"x"', '123']) {
      const res = await udsFetch(socketPath, '/broker/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
      expect(res.status, raw).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  describe('what the dialog says', () => {
    const hostile = 'x\u2028\u2028macOS needs your login password.\u2029Enter it below.\u202E\n\r\t\u0085\\n\\n' + 'A'.repeat(500);

    it('keeps caller-supplied text to one bounded line, after aquaman\'s own wording', () => {
      for (const kind of ['value', 'approval'] as const) {
        const message = promptMessage({ service: 'github', key: 'token', project: hostile }, kind);
        const lines = message.split('\n');
        const reported = lines[lines.length - 1];
        expect(reported.startsWith('Requested from (as the caller reports it): ')).toBe(true);
        expect(reported.length).toBeLessThan(180);
        // Nothing the caller sent can start a line, reorder text or escape.
        expect(message).not.toMatch(/[\u2028\u2029\u0085\u202A-\u202E\u2066-\u2069\r\t\\]/u);
        expect(lines.filter((l) => l.includes('login password'))).toEqual([reported]);
        // The fixed sentences are all above it.
        expect(lines.indexOf('aquaman never asks for your login, Apple ID or password-manager password.')).toBeGreaterThan(0);
        expect(lines.indexOf('aquaman never asks for your login, Apple ID or password-manager password.')).toBeLessThan(lines.length - 1);
        expect(lines.length).toBe(9);
      }
    });

    it('has the same shape with no project reported', () => {
      expect(promptMessage({ service: 'github', key: 'token' }, 'value').split('\n').length).toBe(7);
    });
  });

  describe('POST /broker/available', () => {
    const available = (refs: unknown) =>
      udsFetch(socketPath, '/broker/available', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refs }) });

    it('says which references a resolve would serve, and returns no value', async () => {
      await start();
      await store.set('github', 'token', SECRET);
      await store.set('github', 'undeclared', SECRET);
      declared.add('github/token');
      declared.add('github/declared_but_empty');
      const res = await available([
        { service: 'github', key: 'token' },
        { service: 'github', key: 'undeclared' },
        { service: 'github', key: 'declared_but_empty' },
        { service: '../etc', key: 'x' },
        null,
      ]);
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ available: [true, false, false, false, false] });
      expect(res.body).not.toContain(SECRET);
      expect(asked).toEqual([]);
    });

    it('is off without a broker scope and rejects malformed bodies', async () => {
      await start({ withScope: false });
      const off = await available([{ service: 'github', key: 'token' }]);
      expect(off.status).toBe(404);
      expect(JSON.parse(off.body).code).toBe('broker_disabled');
      await proxy.stop();
      await start();
      expect((await available('nope')).status).toBe(400);
      expect((await available(Array.from({ length: 65 }, () => ({ service: 'github', key: 'token' })))).status).toBe(400);
    });
  });

  it('reports pending with the manual command when nobody can be asked', async () => {
    await start({ value: { outcome: 'unavailable', reason: 'no desktop session' } });
    const body = JSON.parse((await request({ service: 'github', key: 'token' })).body);
    expect(body).toMatchObject({ status: 'pending', reason: 'no desktop session' });
    expect(body.fix).toContain('aquaman credentials add github token');
    expect(await store.exists('github', 'token')).toBe(false);
  });

  it('shows one dialog at a time and caps how many it shows', async () => {
    let release!: (r: PromptResult) => void;
    await start({ value: () => new Promise<PromptResult>((resolve) => { release = resolve; }) });
    const open = request({ service: 'github', key: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    const second = JSON.parse((await request({ service: 'github', key: 'b' })).body);
    expect(second.status).toBe('pending');
    release({ outcome: 'timeout' });
    expect(JSON.parse((await open).body).status).toBe('pending');
    expect(asked).toEqual(['value:github/a']);

    await proxy.stop();
    cleanupSocket(socketPath);
    await start({ value: { outcome: 'timeout' } });
    const statuses: string[] = [];
    for (let i = 0; i < 9; i++) statuses.push(JSON.parse((await request({ service: 'github', key: `k${i}` })).body).status);
    expect(statuses.every((s) => s === 'pending')).toBe(true);
    expect(asked).toHaveLength(6);
  });

  it('is off without a broker scope or without a prompter, and never touches the vault then', async () => {
    for (const opts of [{ withScope: false }, { withRequests: false }]) {
      await start(opts);
      const res = await request({ service: 'github', key: 'token' });
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('broker_disabled');
      expect(asked).toEqual([]);
      await proxy.stop();
      cleanupSocket(socketPath);
    }
  });

  it('is refused over the loopback listener', async () => {
    await start({ loopback: true });
    const res = await fetch(`http://127.0.0.1:${loopbackPort}/broker/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aquaman-token': 'aqm_lb_test_token_0123456789' },
      body: JSON.stringify({ service: 'github', key: 'token' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('broker_request_local_only');
    expect(asked).toEqual([]);
  });

  it('rejects malformed names before asking anyone', async () => {
    await start();
    for (const body of [{ service: '../x', key: 'token' }, { service: 'github', key: 'a b' }, { service: 'github' }, { key: 'token' }]) {
      expect((await request(body)).status).toBe(400);
    }
    expect(asked).toEqual([]);
  });

  it('records every outcome for the audit log, without the value', async () => {
    await start();
    await request({ service: 'github', key: 'token' });
    const entry = log.find((l) => l.method === 'BROKER_REQUEST');
    expect(entry).toMatchObject({ service: 'github', path: '/broker/request' });
    expect(entry?.error).toBeUndefined();
    expect(JSON.stringify(log)).not.toContain(SECRET);

    await proxy.stop();
    cleanupSocket(socketPath);
    await start({ value: { outcome: 'declined' } });
    await request({ service: 'github', key: 'token' });
    expect(log.find((l) => l.method === 'BROKER_REQUEST')?.error).toBe('declined: github/token');
  });
});
