/**
 * Refusal and failure paths of the proxy daemon that the conformance suites
 * do not reach: a backend that throws, oversized and malformed broker bodies,
 * a listener that cannot bind, and a route token presented to a broker path.
 *
 * Real proxy instances on temp sockets; the vault is an in-memory store that
 * can be told to fail.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCredentialProxy,
  createBrokerScope,
  createServiceRegistry,
  type CredentialProxy,
  type CredentialPrompter,
  type PromptResult,
  type RequestInfo,
} from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_cov_daemon_token_0123456789abcdef';
const SECRET = 'ghp_cov_daemon_secret_value_0123456789';

/** A vault whose reads, existence checks or writes can be made to fail. */
class FailingStore extends MemoryStore {
  failGet = false;
  failExists = false;
  failSet = false;
  gets = 0;
  override async get(service: string, key: string): Promise<string | null> {
    this.gets++;
    if (this.failGet) throw new Error('backend locked');
    return super.get(service, key);
  }
  override async exists(service: string, key: string): Promise<boolean> {
    if (this.failExists) throw new Error('backend unreachable');
    return super.exists(service, key);
  }
  override async set(service: string, key: string, value: string): Promise<void> {
    if (this.failSet) throw new Error('vault is read-only');
    return super.set(service, key, value);
  }
}

describe('proxy daemon: failure and refusal paths', () => {
  let proxy: CredentialProxy | undefined;
  let store: FailingStore;
  let socketPath = '';
  let declared: Set<string>;
  let routed: Set<string>;
  let log: RequestInfo[];
  let asked: string[];
  const extraDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    if (proxy?.isRunning()) await proxy.stop();
    proxy = undefined;
    if (socketPath) cleanupSocket(socketPath);
    for (const d of extraDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function start(opts: {
    loopback?: boolean;
    withScope?: boolean;
    allowedServices?: string[];
    registry?: ReturnType<typeof createServiceRegistry>;
    prompter?: Partial<CredentialPrompter>;
    declare?: (service: string, key: string) => void;
    onRequest?: (info: RequestInfo) => void;
    policyConfig?: Parameters<typeof createCredentialProxy>[0]['policyConfig'];
  } = {}) {
    store = new FailingStore();
    declared = new Set();
    routed = new Set();
    log = [];
    asked = [];
    socketPath = tmpSocketPath();
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    const prompter: CredentialPrompter = {
      async askValue(r): Promise<PromptResult> { asked.push(`value:${r.service}/${r.key}`); return { outcome: 'entered', value: SECRET }; },
      async askApproval(r): Promise<PromptResult> { asked.push(`approval:${r.service}/${r.key}`); return { outcome: 'approved' }; },
      ...opts.prompter,
    };
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: opts.registry,
      allowedServices: opts.allowedServices ?? ['github'],
      broker: opts.withScope === false
        ? undefined
        : {
            ...scope,
            check: (service, key, caller) => (declared.has(`${service}/${key}`) ? ({ allowed: true } as const) : scope.check(service, key, caller)),
            routedRefs: () => new Set([...routed].map((r) => `aquaman://${r}`)),
          },
      credentialRequests: { prompter, declare: opts.declare ?? ((service, key) => { declared.add(`${service}/${key}`); }) },
      loopback: opts.loopback ? { port: 0, token: TOKEN, host: '127.0.0.1' } : undefined,
      policyConfig: opts.policyConfig,
      onRequest: opts.onRequest ?? ((info) => { log.push(info); }),
    });
    await proxy.start();
  }

  const post = (urlPath: string, body: string) =>
    udsFetch(socketPath, urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const postJson = (urlPath: string, body: unknown) => post(urlPath, JSON.stringify(body));

  describe('starting and stopping', () => {
    it('refuses to start twice', async () => {
      await start();
      await expect(proxy!.start()).rejects.toThrow('Credential proxy already running');
      expect(proxy!.isRunning()).toBe(true);
      // The first listener is untouched.
      expect((await udsFetch(socketPath, '/_health')).status).toBe(200);
    });

    it('creates the socket directory when it does not exist, and the socket is owner-only', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-cov-'));
      extraDirs.push(base);
      const nested = path.join(base, 'a', 'b', 'proxy.sock');
      const p = createCredentialProxy({ socketPath: nested, store: new MemoryStore(), allowedServices: [] });
      await p.start();
      try {
        expect(fs.statSync(nested).isSocket()).toBe(true);
        expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
        expect(p.getSocketPath()).toBe(nested);
      } finally {
        await p.stop();
      }
      expect(fs.existsSync(nested)).toBe(false);
      expect(p.isRunning()).toBe(false);
    });

    it('rejects when the socket cannot be bound, and is not running afterwards', async () => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-cov-'));
      extraDirs.push(base);
      // Longer than any Unix socket path can be.
      const tooLong = path.join(base, 'x'.repeat(200), 'proxy.sock');
      const p = createCredentialProxy({ socketPath: tooLong, store: new MemoryStore(), allowedServices: [] });
      await expect(p.start()).rejects.toThrow();
      expect(p.isRunning()).toBe(false);
      expect(fs.existsSync(tooLong)).toBe(false);
    });

    it('tears the socket listener down again when the loopback listener cannot bind', async () => {
      const blocker = net.createServer();
      const port = await new Promise<number>((resolve) => {
        blocker.listen(0, '127.0.0.1', () => resolve((blocker.address() as net.AddressInfo).port));
      });
      socketPath = tmpSocketPath();
      const p = createCredentialProxy({
        socketPath,
        store: new MemoryStore(),
        allowedServices: [],
        loopback: { port, token: TOKEN, host: '127.0.0.1' },
      });
      try {
        await expect(p.start()).rejects.toMatchObject({ code: 'EADDRINUSE' });
        // No half-started proxy: the socket is gone and nothing answers on it.
        expect(p.isRunning()).toBe(false);
        expect(p.getLoopbackAddress()).toBeNull();
        expect(fs.existsSync(socketPath)).toBe(false);
        await expect(udsFetch(socketPath, '/_health')).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });

    it('stop is a no-op on a proxy that never started', async () => {
      const p = createCredentialProxy({ socketPath: tmpSocketPath(), store: new MemoryStore(), allowedServices: [] });
      await expect(p.stop()).resolves.toBeUndefined();
      expect(p.isRunning()).toBe(false);
      cleanupSocket(p.getSocketPath());
    });
  });

  describe('request handling', () => {
    it('answers 500 rather than hanging when handling a request throws', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await start({
        policyConfig: { github: { defaultAction: 'deny', rules: [] } },
        onRequest: () => { throw new Error('audit sink is down'); },
      });
      const res = await udsFetch(socketPath, '/github/user');
      expect(res.status).toBe(500);
      expect(res.body).toBe('Internal proxy error');
      expect(res.body).not.toContain('audit sink');
      expect(errors).toHaveBeenCalledWith('Proxy error:', expect.objectContaining({ message: 'audit sink is down' }));
      // The proxy keeps serving.
      expect((await udsFetch(socketPath, '/_health')).status).toBe(200);
    });

    it('answers 404 for a configured service the registry has no definition for, without a vault lookup', async () => {
      await start({ allowedServices: ['ghost'] });
      await store.set('ghost', 'api_key', SECRET);
      store.gets = 0;
      const res = await udsFetch(socketPath, '/ghost/v1/anything');
      expect(res.status).toBe(404);
      expect(res.body).toBe('Not found');
      expect(store.gets).toBe(0);
    });

    it('a route token presented to a broker path is refused even when a service named "broker" is routed', async () => {
      const registry = createServiceRegistry();
      registry.register({
        name: 'broker',
        upstream: 'http://127.0.0.1:9',
        authHeader: 'Authorization',
        authPrefix: 'Bearer ',
        credentialKey: 'api_key',
      });
      await start({ loopback: true, registry });
      await store.set('broker', 'api_key', SECRET);
      routed.add('broker/api_key');
      declared.add('broker/api_key');

      const routeRes = await postJson('/broker/route', { service: 'broker', key: 'api_key' });
      expect(routeRes.status).toBe(200);
      const { token } = JSON.parse(routeRes.body);
      expect(token).toMatch(/^aqm_rt_/);

      const origin = `http://${proxy!.getLoopbackAddress()}`;
      store.gets = 0;
      for (const endpoint of ['/broker/resolve', '/broker/available', '/broker/route', '/broker/request']) {
        const res = await fetch(`${origin}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ service: 'broker', key: 'api_key', refs: [{ service: 'broker', key: 'api_key' }] }),
        });
        const text = await res.text();
        expect(res.status, endpoint).toBe(404);
        expect(JSON.parse(text).code, endpoint).toBe('route_token_forward_only');
        expect(text).not.toContain(SECRET);
      }
      expect(store.gets).toBe(0);
      expect(asked).toEqual([]);
    });
  });

  describe('POST /broker/route', () => {
    it('rejects a body over 4 KB and a body that is not JSON', async () => {
      await start({ loopback: true });
      const big = await post('/broker/route', JSON.stringify({ service: 'github', key: 'token', pad: 'x'.repeat(5000) }));
      expect(big.status).toBe(400);
      expect(JSON.parse(big.body)).toEqual({ error: 'Request body too large', fix: 'POST { service, key }' });

      const bad = await post('/broker/route', '{not json');
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body).error).toBe('Expected { service, key }');
    });

    it('treats a backend that fails as "not stored" and hands out no route', async () => {
      await start({ loopback: true });
      await store.set('github', 'token', SECRET);
      routed.add('github/token');
      store.failGet = true;
      const res = await postJson('/broker/route', { service: 'github', key: 'token' });
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.code).toBe('credential_not_found');
      expect(body.token).toBeUndefined();
      expect(body.url).toBeUndefined();
      expect(res.body).not.toContain('backend locked');
      expect(log.some((r) => r.path === '/broker/route' && r.statusCode === 404 && r.error === 'credential_not_found: github/token')).toBe(true);
    });
  });

  describe('POST /broker/available', () => {
    it('rejects a body over 16 KB and a body that is not JSON', async () => {
      await start();
      const big = await post('/broker/available', JSON.stringify({ refs: [], pad: 'x'.repeat(17000) }));
      expect(big.status).toBe(400);
      expect(JSON.parse(big.body)).toEqual({ error: 'Request body too large', fix: 'Ask about at most 64 references' });

      const bad = await post('/broker/available', 'refs=1');
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body).error).toBe('Expected { refs: [{ service, key }] } with at most 64 entries');
    });

    it('reports a declared reference as unavailable when the backend fails, without an error', async () => {
      await start();
      await store.set('github', 'token', SECRET);
      declared.add('github/token');
      expect(JSON.parse((await postJson('/broker/available', { refs: [{ service: 'github', key: 'token' }] })).body)).toEqual({ available: [true] });
      store.failGet = true;
      const res = await postJson('/broker/available', { refs: [{ service: 'github', key: 'token' }, { service: 'github', key: 'other' }] });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ available: [false, false] });
      expect(res.body).not.toContain('backend locked');
    });
  });

  describe('POST /broker/request', () => {
    it('rejects a body over 4 KB and a body that is not JSON, before asking anyone', async () => {
      await start();
      const big = await post('/broker/request', JSON.stringify({ service: 'github', key: 'token', project: 'p'.repeat(5000) }));
      expect(big.status).toBe(400);
      expect(JSON.parse(big.body)).toEqual({ error: 'Request body too large', fix: 'Keep broker requests under 4 KB' });

      const bad = await post('/broker/request', 'service=github');
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body)).toEqual({ error: 'Request body is not valid JSON', fix: 'POST a JSON body with { service, key }' });
      expect(asked).toEqual([]);
    });

    it('answers 500 and shows no dialog when the backend cannot say whether the credential exists', async () => {
      await start();
      store.failExists = true;
      const res = await postJson('/broker/request', { service: 'github', key: 'token' });
      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Vault backend error checking github/token: backend unreachable');
      expect(body.fix).toBe('Check that the configured backend is accessible. Run: aquaman doctor');
      expect(asked).toEqual([]);
      expect(declared.size).toBe(0);
    });

    it('reports pending, with the reason, when the prompter itself throws, and can ask again afterwards', async () => {
      let calls = 0;
      await start({
        prompter: {
          async askValue() {
            calls++;
            if (calls === 1) throw new Error('dialog helper crashed');
            return { outcome: 'entered', value: SECRET };
          },
        },
      });
      const res = await postJson('/broker/request', { service: 'github', key: 'token' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        status: 'pending',
        ref: 'aquaman://github/token',
        reason: 'dialog helper crashed',
        fix: 'aquaman credentials add github token && aquaman broker allow aquaman://github/token',
      });
      expect(await store.get('github', 'token')).toBeNull();
      expect(declared.size).toBe(0);
      expect(log.some((r) => r.method === 'BROKER_REQUEST' && r.error === 'pending: github/token')).toBe(true);

      // The "a dialog is open" flag was released: the next request reaches the prompter.
      const again = await postJson('/broker/request', { service: 'github', key: 'token' });
      expect(JSON.parse(again.body)).toEqual({ status: 'stored', ref: 'aquaman://github/token' });
      expect(calls).toBe(2);
    });

    it('answers 500 and declares nothing when the typed value cannot be stored, and the reply does not carry the value', async () => {
      await start();
      store.failSet = true;
      const res = await postJson('/broker/request', { service: 'github', key: 'token' });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'Could not store github/token: vault is read-only', fix: 'Run: aquaman doctor' });
      expect(res.body).not.toContain(SECRET);
      expect(declared.size).toBe(0);
      expect(asked).toEqual(['value:github/token']);
      const entry = log.find((r) => r.method === 'BROKER_REQUEST');
      expect(entry?.error).toBe('vault is read-only');
      expect(JSON.stringify(log)).not.toContain(SECRET);
    });

    it('answers 500 when the ref cannot be declared after an approval', async () => {
      await start({ declare: () => { throw 'config.yaml is not writable'; } });
      await store.set('github', 'token', SECRET);
      const res = await postJson('/broker/request', { service: 'github', key: 'token' });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).error).toBe('Could not store github/token: config.yaml is not writable');
      expect(asked).toEqual(['approval:github/token']);
    });
  });

  describe('POST /broker/resolve', () => {
    it('rejects a key name with characters outside the allowed set, before the scope or the vault', async () => {
      await start();
      store.gets = 0;
      for (const key of ['../token', 'to ken', '-token', 'tok/en']) {
        const res = await postJson('/broker/resolve', { service: 'github', key });
        expect(res.status, key).toBe(400);
        const body = JSON.parse(res.body);
        expect(body.error).toBe(`Invalid key name: ${JSON.stringify(key)}`);
        expect(body.fix).toBe('Key names must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/');
      }
      expect(store.gets).toBe(0);
      expect(log).toEqual([]);
    });

    it('answers 500 with the backend error, never a value, when the vault fails, and audits it', async () => {
      await start();
      await store.set('github', 'token', SECRET);
      declared.add('github/token');
      store.failGet = true;
      const res = await postJson('/broker/resolve', { service: 'github', key: 'token' });
      expect(res.status).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Vault backend error resolving github/token: backend locked');
      expect(body.fix).toContain('aquaman doctor');
      expect(body.value).toBeUndefined();
      expect(res.body).not.toContain(SECRET);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({
        service: 'github',
        method: 'BROKER',
        path: '/broker/resolve',
        authenticated: false,
        statusCode: 500,
        error: 'backend locked',
      });
    });
  });
});
