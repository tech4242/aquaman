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
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_route_test_token_0123456789abcdef';
const REAL_KEY = 'sk_live_real_vault_key_0123456789';

describe('routing a program through the proxy', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let socketPath: string;
  let declared: Set<string>;
  let log: RequestInfo[];

  async function start(opts: { loopback?: boolean; withScope?: boolean } = {}) {
    const registry = createServiceRegistry();
    registry.override('stripe', { upstream: `http://127.0.0.1:${upstream.port}` });
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['stripe', 'twilio', 'github'],
      broker: opts.withScope === false
        ? undefined
        : { ...scope, check: (service, key, caller) => (declared.has(`${service}/${key}`) ? ({ allowed: true } as const) : scope.check(service, key, caller)) },
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
    declared = new Set(['stripe/secret_key']);
    log = [];
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    if (socketPath) cleanupSocket(socketPath);
  });

  it('returns the proxy URL and token for a declared, stored reference, and never the credential', async () => {
    await start();
    const res = await route('stripe', 'secret_key');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ url: `http://${proxy.getLoopbackAddress()}/stripe`, token: TOKEN });
    expect(res.body).not.toContain(REAL_KEY);
  });

  it('a program using that URL and token reaches the upstream with the real credential, which it never held', async () => {
    await start();
    const { url, token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const res = await fetch(`${url}/v1/charges`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const seen = upstream.getLastRequest()!;
    expect(seen.headers['authorization']).toBe(`Bearer ${REAL_KEY}`);
    expect(JSON.stringify(seen.headers)).not.toContain(TOKEN);
  });

  it('request policy applies to what the program sends, and a denied request gets no credential', async () => {
    await start();
    const { url, token } = JSON.parse((await route('stripe', 'secret_key')).body);
    const before = upstream.getRequestCount();
    const res = await fetch(`${url}/v1/customers/cus_123`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
    expect(upstream.getRequestCount()).toBe(before);
  });

  it('accepts the token in the `token <value>` form GitHub clients send', async () => {
    await start();
    await store.set('github', 'token', 'ghp_real');
    const res = await fetch(`http://${proxy.getLoopbackAddress()}/_health`);
    expect(res.status).toBe(200);
    const wrong = await fetch(`http://${proxy.getLoopbackAddress()}/stripe/v1/charges`, { headers: { Authorization: 'token not-the-token' } });
    expect(wrong.status).toBe(401);
    const right = await fetch(`http://${proxy.getLoopbackAddress()}/stripe/v1/charges`, { headers: { Authorization: `token ${TOKEN}` } });
    expect(right.status).toBe(200);
  });

  it.each([
    ['an undeclared reference', 'stripe', 'restricted_key', 'broker_ref_not_declared'],
  ])('refuses %s before looking at anything else', async (_what, service, key, code) => {
    await start();
    const res = await route(service, key);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe(code);
    expect(res.body).not.toContain(TOKEN);
  });

  it('refuses when the reference is not the key the proxy injects for the service', async () => {
    await start();
    declared.add('stripe/restricted_key');
    await store.set('stripe', 'restricted_key', 'rk_live_x');
    const res = await route('stripe', 'restricted_key');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'route_key_mismatch', fix: 'Use aquaman://stripe/secret_key' });
  });

  it('refuses a service the proxy has no definition for, and one it does not inject a header for', async () => {
    await start();
    declared.add('acme/api_key');
    declared.add('twilio/account_sid');
    expect(JSON.parse((await route('acme', 'api_key')).body).code).toBe('route_service_unknown');
    expect(JSON.parse((await route('twilio', 'account_sid')).body).code).toBe('route_unsupported');
  });

  it('refuses when the credential is not stored, with the same code a resolve gives', async () => {
    await start();
    store.clear();
    const res = await route('stripe', 'secret_key');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).code).toBe('credential_not_found');
    expect(res.body).not.toContain(TOKEN);
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
    const call = () => fetch(`http://${proxy.getLoopbackAddress()}/stripe/v1/charges`, { headers: { Authorization: `Bearer ${TOKEN}` } });

    fs.writeFileSync(projectsPath, 'projects:\n  app:\n    paths: ["/tmp/x"]\n    env:\n      STRIPE_SECRET_KEY: aquaman://stripe/secret_key\n');
    expect((await call()).status).toBe(404);
    expect(JSON.parse((await route('stripe', 'secret_key')).body).code).toBe('route_not_recorded');

    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(projectsPath, 'projects:\n  app:\n    paths: ["/tmp/x"]\n    env:\n      STRIPE_SECRET_KEY: aquaman://stripe/secret_key\n    routes:\n      STRIPE_SECRET_KEY:\n        url_env: STRIPE_API_BASE\n');
    expect((await route('stripe', 'secret_key')).status).toBe(200);
    expect((await call()).status).toBe(200);
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
    expect(res.body).not.toContain(TOKEN);
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
