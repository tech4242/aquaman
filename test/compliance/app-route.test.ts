/**
 * Conformance: `POST /broker/route` lets a program be sent through the proxy
 * instead of being given a credential. The program holds the local proxy's
 * token and URL; the proxy adds the credential on the way out and request
 * policy applies to what the program sends.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), AC-6 (least privilege), IA-5 (authenticator management).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

/** The agent hosts' token. A routed program is never given this one. */
const TOKEN = 'aqm_lb_route_test_token_0123456789abcdef';
const REAL_KEY = 'sk_live_real_vault_key_0123456789';

describe('routing a program through the proxy', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let socketPath: string;
  let declared: Set<string>;
  let routed: Set<string>;
  let log: RequestInfo[];

  async function start(opts: { loopback?: boolean; withScope?: boolean } = {}) {
    const registry = createServiceRegistry();
    registry.override('stripe', { upstream: `http://127.0.0.1:${upstream.port}` });
    registry.override('github', { upstream: `http://127.0.0.1:${upstream.port}` });
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['github'],
      broker: opts.withScope === false
        ? undefined
        : {
            ...scope,
            check: (service, key, caller) => (declared.has(`${service}/${key}`) ? ({ allowed: true } as const) : scope.check(service, key, caller)),
            routedRefs: () => new Set([...routed].map((r) => `aquaman://${r}`)),
          },
      loopback: opts.loopback === false ? undefined : { port: 0, token: TOKEN, host: '127.0.0.1' },
      policyConfig: { stripe: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/v1/customers/**', action: 'deny' }] } },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const route = (service: string, key: string) =>
    udsFetch(socketPath, '/broker/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service, key }) });

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);
    store = new MemoryStore();
    await store.set('stripe', 'secret_key', REAL_KEY);
    declared = new Set();
    routed = new Set(['stripe/secret_key']);
    log = [];
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    if (socketPath) cleanupSocket(socketPath);
  });

  it('returns the proxy URL and a token of its own for a routed, stored reference, and never the credential', async () => {
    await start();
    const res = await route('stripe', 'secret_key');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.url).toBe(`http://${proxy.getLoopbackAddress()}/stripe`);
    expect(body.token).toMatch(/^aqm_rt_[0-9a-f]{48}$/);
    expect(body.token).not.toBe(TOKEN);
    expect(res.body).not.toContain(REAL_KEY);
    expect(log.some((r) => r.path === '/broker/route' && r.statusCode === 200)).toBe(true);
  });

  it('the token a routed program holds cannot be used to fetch a credential value, its own or anyone else\'s', async () => {
    await start();
    await store.set('github', 'token', 'ghp_another_projects_token');
    declared.add('github/token');
    const { token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const origin = `http://${proxy.getLoopbackAddress()}`;
    for (const [service, key] of [['stripe', 'secret_key'], ['github', 'token']]) {
      for (const endpoint of ['/broker/resolve', '/broker/available', '/broker/route', '/broker/request']) {
        const res = await fetch(`${origin}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-aquaman-token': token },
          body: JSON.stringify({ service, key, refs: [{ service, key }] }),
        });
        const text = await res.text();
        expect(res.status, `${endpoint} ${service}`).toBe(401);
        expect(text).not.toContain(REAL_KEY);
        expect(text).not.toContain('ghp_another_projects_token');
      }
    }
  });

  it('a routed reference is not declared for materialization: resolve refuses it on both listeners, even for the agent hosts\' token', async () => {
    await start();
    const body = JSON.stringify({ service: 'stripe', key: 'secret_key' });
    const overSocket = await udsFetch(socketPath, '/broker/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(overSocket.status).toBe(404);
    expect(JSON.parse(overSocket.body).code).toBe('broker_ref_not_declared');
    const overLoopback = await fetch(`http://${proxy.getLoopbackAddress()}/broker/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN },
      body,
    });
    expect(overLoopback.status).toBe(404);
    expect(await overLoopback.text()).not.toContain(REAL_KEY);
    // The hook still learns that the project has something usable.
    const available = await udsFetch(socketPath, '/broker/available', { method: 'POST', body: JSON.stringify({ refs: [{ service: 'stripe', key: 'secret_key' }] }) });
    expect(JSON.parse(available.body)).toEqual({ available: [true] });
  });

  it('the route token forwards only to routed services, and the agent hosts\' token does not gain them', async () => {
    await start();
    await store.set('github', 'token', 'ghp_real');
    const { token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const origin = `http://${proxy.getLoopbackAddress()}`;
    // github is in the configured list but nobody routed it: not for this token.
    expect((await fetch(`${origin}/github/user`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
    // stripe is routed but not in the configured list: not for the agent hosts' token, nor over the socket.
    expect((await fetch(`${origin}/stripe/v1/charges`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await udsFetch(socketPath, '/stripe/v1/charges')).status).toBe(404);
    expect((await fetch(`${origin}/stripe/v1/charges`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('a route to a service that takes neither a header nor basic auth, or to a key the proxy does not inject, opens nothing', async () => {
    await start();
    routed.add('telegram/bot_token');
    routed.add('twilio/anything');
    routed.add('stripe/restricted_key');
    routed.delete('stripe/secret_key');
    await store.set('twilio', 'account_sid', 'AC_real');
    await store.set('telegram', 'bot_token', '123:real');
    for (const [service, key] of [['twilio', 'anything'], ['telegram', 'bot_token']]) {
      const { token } = JSON.parse((await route(service, key)).body);
      expect(token, service).toBeUndefined();
    }
    const origin = `http://${proxy.getLoopbackAddress()}`;
    expect((await fetch(`${origin}/telegram/bot${TOKEN}/getMe`)).status).toBe(401);
    expect((await fetch(`${origin}/twilio/2010-04-01/Accounts`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect((await fetch(`${origin}/stripe/v1/charges`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(404);
    expect(upstream.getRequestCount()).toBe(0);
  });

  it('accepts the token in the service\'s own auth header, and never forwards either local token upstream', async () => {
    await start();
    const { url, token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const res = await fetch(`${url}/v1/charges`, { headers: { Authorization: `Bearer ${token}`, 'x-api-key': token, 'x-other': `prefix-${TOKEN}` } });
    expect(res.status).toBe(200);
    const sent = JSON.stringify(upstream.getLastRequest()!.headers);
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(TOKEN);
    expect(upstream.getLastRequest()!.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
  });

  it('refuses a request whose Host header is not a loopback name', async () => {
    await start();
    const { token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const [host, port] = proxy.getLoopbackAddress()!.split(':');
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host, port: Number(port), path: '/stripe/v1/charges', headers: { Host: 'attacker.example', Authorization: `Bearer ${token}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(upstream.getRequestCount()).toBe(0);
  });

  it('a program using that URL and token reaches the upstream with the real credential, which it never held', async () => {
    await start();
    const { url, token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const res = await fetch(`${url}/v1/charges`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const seen = upstream.getLastRequest()!;
    expect(seen.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
    expect(JSON.stringify(seen.headers)).not.toContain(token);
  });

  it('request policy applies to what the program sends, and a denied request gets no credential', async () => {
    await start();
    const { url, token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const before = upstream.getRequestCount();
    const res = await fetch(`${url}/v1/customers/cus_123`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect(upstream.getRequestCount()).toBe(before);
  });

  it('accepts either token in the `token <value>` form GitHub clients send', async () => {
    await start();
    routed.add('github/token');
    await store.set('github', 'token', 'ghp_real');
    const registryUpstream = `http://${proxy.getLoopbackAddress()}`;
    const { token } = JSON.parse((await route('github', 'token')).body);
    expect((await fetch(`${registryUpstream}/github/user`, { headers: { Authorization: 'token not-the-token' } })).status).toBe(401);
    for (const value of [token, TOKEN]) {
      const res = await fetch(`${registryUpstream}/github/user`, { headers: { Authorization: `token ${value}` } });
      expect(res.status).toBe(200);
      expect(upstream.getLastRequest()!.headers['authorization']).toBe('Bearer ghp_real');
    }
  });

  it('refuses a reference nobody routed before looking at anything else, whatever the vault holds', async () => {
    await start();
    declared.add('stripe/restricted_key');
    await store.set('stripe', 'restricted_key', 'rk_live_x');
    for (const [service, key] of [['stripe', 'restricted_key'], ['stripe', 'missing'], ['acme', 'api_key']]) {
      const res = await route(service, key);
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body).code).toBe('route_not_recorded');
      expect(res.body).not.toMatch(/aqm_/);
    }
  });

  it('refuses when the reference is not the key the proxy injects for the service', async () => {
    await start();
    routed.add('stripe/restricted_key');
    await store.set('stripe', 'restricted_key', 'rk_live_x');
    const res = await route('stripe', 'restricted_key');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'route_key_mismatch', fix: 'Use aquaman://stripe/secret_key' });
  });

  it('refuses a service the proxy has no definition for, and one it injects neither a header nor basic auth for', async () => {
    await start();
    routed.add('acme/api_key');
    routed.add('telegram/bot_token');
    routed.add('ms-teams/client_id');
    routed.add('nostr/private_key');
    expect(JSON.parse((await route('acme', 'api_key')).body).code).toBe('route_service_unknown');
    for (const [service, key] of [['telegram', 'bot_token'], ['ms-teams', 'client_id'], ['nostr', 'private_key']]) {
      expect(JSON.parse((await route(service, key)).body).code, service).toBe('route_unsupported');
    }
  });

  it('refuses when the credential is not stored, with the same code a resolve gives', async () => {
    await start();
    store.clear();
    const res = await route('stripe', 'secret_key');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('credential_not_found');
    expect(res.body).not.toMatch(/aqm_/);
  });

  it('a route recorded in projects.yaml is what makes the daemon forward for a service outside its configured list', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-route-'));
    const projectsPath = path.join(dir, 'projects.yaml');
    const registry = createServiceRegistry();
    registry.override('stripe', { upstream: `http://127.0.0.1:${upstream.port}` });
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic'],
      broker: createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath }),
      loopback: { port: 0, token: TOKEN, host: '127.0.0.1' },
    });
    await proxy.start();
    const call = (token: string) => fetch(`http://${proxy.getLoopbackAddress()}/stripe/v1/charges`, { headers: { Authorization: `Bearer ${token}` } });

    // Bound without a route: declared for resolve, not forwarded.
    fs.writeFileSync(projectsPath, 'projects:\n  app:\n    paths: ["/tmp/x"]\n    env:\n      STRIPE_SECRET_KEY: aquaman://stripe/secret_key\n');
    expect((await call(TOKEN)).status).toBe(404);
    expect(JSON.parse((await route('stripe', 'secret_key')).body).code).toBe('route_not_recorded');
    const resolve = () => udsFetch(socketPath, '/broker/resolve', { method: 'POST', body: JSON.stringify({ service: 'stripe', key: 'secret_key' }) });
    expect((await resolve()).status).toBe(200);

    // Bound with a route: forwarded for the route token, no longer resolvable.
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(projectsPath, 'projects:\n  app:\n    paths: ["/tmp/x"]\n    env:\n      STRIPE_SECRET_KEY: aquaman://stripe/secret_key\n    routes:\n      STRIPE_SECRET_KEY:\n        url_env: STRIPE_API_BASE\n');
    const routedReply = await route('stripe', 'secret_key');
    expect(routedReply.status).toBe(200);
    expect((await resolve()).status).toBe(404);
    expect((await call(JSON.parse(routedReply.body).token)).status).toBe(200);
    expect(upstream.getLastRequest()!.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when the listener is off, and names the command that turns it on', async () => {
    await start({ loopback: false });
    const res = await route('stripe', 'secret_key');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'route_listener_off', fix: expect.stringContaining('--loopback') });
  });

  it('is off without a broker scope, as on an OpenClaw-hosted proxy', async () => {
    await start({ withScope: false });
    const res = await route('stripe', 'secret_key');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('broker_disabled');
    expect(res.body).not.toMatch(/aqm_/);
  });

  it('is not served over the loopback listener itself, even with the token', async () => {
    await start();
    const res = await fetch(`http://${proxy.getLoopbackAddress()}/broker/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-aquaman-token': TOKEN },
      body: JSON.stringify({ service: 'stripe', key: 'secret_key' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('route_socket_only');
  });

  it('rejects malformed bodies and records refusals', async () => {
    await start();
    const bad = await udsFetch(socketPath, '/broker/route', { method: 'POST', body: '[1,2]' });
    expect(bad.status).toBe(400);
    await route('stripe', 'other');
    expect(log.some((r) => r.path === '/broker/route' && r.statusCode === 404)).toBe(true);
  });
});
