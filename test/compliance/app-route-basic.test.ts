/**
 * Conformance: a program can be routed through the proxy to a service that
 * takes HTTP basic auth. The program sends basic auth with the route token in
 * place of the secret; the proxy recognises the token as either half of the
 * pair, discards the header and injects the stored user name and password.
 *
 * Each row attacks one part of that: reading a value with the token, widening
 * what the agent hosts' token can reach, getting a malformed Basic value
 * accepted, getting the token sent upstream, and getting a credential read
 * for a request policy denies.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials); NIST SP 800-53 AC-3 (access
 * enforcement), AC-6 (least privilege), IA-5 (authenticator management),
 * SI-10 (input validation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, createBrokerScope, createServiceRegistry, type CredentialProxy, type RequestInfo } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { CountingStore } from '../helpers/counting-store.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

/** The agent hosts' token. A routed program is never given this one. */
const LOOPBACK_TOKEN = 'aqm_lb_basic_route_test_token_0123456789';
const REAL_USER = 'agent@example.com/token';
const REAL_PASSWORD = 'zd_real_api_token_0123456789abcdef';
const REAL_BASIC = `Basic ${Buffer.from(`${REAL_USER}:${REAL_PASSWORD}`).toString('base64')}`;

const b64 = (text: string) => Buffer.from(text, 'latin1').toString('base64');
const basic = (user: string, password: string) => `Basic ${b64(`${user}:${password}`)}`;
/** Four bytes whose base64 uses `+` and `/`, so the URL-safe alphabet spells them differently. */
const HIGH_BYTES = String.fromCharCode(0xfb, 0xff, 0xfb, 0xff);
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/**
 * The same bytes in base64 that a strict decoder refuses: the last character
 * before the padding carries bits canonical base64 leaves clear.
 */
const nonCanonical = (text: string) => {
  const encoded = b64(text);
  const at = encoded.indexOf('=') - 1;
  return `${encoded.slice(0, at)}${ALPHABET[ALPHABET.indexOf(encoded[at]) + 1]}${encoded.slice(at + 1)}`;
};

/** Sends header values exactly as given, which `fetch` does not allow for every row. */
function rawGet(address: string, urlPath: string, headers: Record<string, string | string[]>): Promise<{ status: number; body: string }> {
  const [host, port] = address.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path: urlPath, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('routing a program through the proxy to a basic-auth service', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: CountingStore;
  let socketPath: string;
  let declared: Set<string>;
  let routed: Set<string>;
  let log: RequestInfo[];
  let dir: string;

  async function start() {
    // The definition comes from a services.yaml file, as a tenant host does.
    fs.writeFileSync(path.join(dir, 'services.yaml'), [
      'services:',
      '  - name: zendesk',
      `    upstream: http://127.0.0.1:${upstream.port}`,
      '    authMode: basic',
      '    authHeader: Authorization',
      '    credentialKey: email',
      '    additionalCredentialKeys: [api_token]',
      '',
    ].join('\n'));
    const registry = createServiceRegistry({ configPath: path.join(dir, 'services.yaml') });
    for (const name of ['stripe', 'twilio', 'bluebubbles', 'telegram', 'ms-teams']) {
      registry.override(name, { upstream: `http://127.0.0.1:${upstream.port}` });
    }
    const scope = createBrokerScope({ configPath: '/nonexistent/config.yaml', projectsPath: '/nonexistent/projects.yaml' });
    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['github'],
      broker: {
        ...scope,
        check: (service, key, caller) => (declared.has(`${service}/${key}`) ? ({ allowed: true } as const) : scope.check(service, key, caller)),
        routedRefs: () => new Set([...routed].map((r) => `aquaman://${r}`)),
      },
      loopback: { port: 0, token: LOOPBACK_TOKEN, host: '127.0.0.1' },
      policyConfig: {
        zendesk: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/api/v2/tickets/**', action: 'deny' }] },
      },
      onRequest: (info) => { log.push(info); },
    });
    await proxy.start();
  }

  const route = (service: string, key: string) =>
    udsFetch(socketPath, '/broker/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service, key }) });
  const routeToken = async (service = 'zendesk', key = 'api_token'): Promise<string> => JSON.parse((await route(service, key)).body).token;
  const address = () => proxy.getLoopbackAddress()!;

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);
    const inner = new MemoryStore();
    await inner.set('zendesk', 'email', REAL_USER);
    await inner.set('zendesk', 'api_token', REAL_PASSWORD);
    store = new CountingStore(inner);
    declared = new Set();
    routed = new Set(['zendesk/api_token']);
    log = [];
    socketPath = tmpSocketPath();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-rb-'));
    await start();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    cleanupSocket(socketPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('POST /broker/route', () => {
    it('answers with the proxy URL and the route token for the password key, and never with a stored value', async () => {
      const res = await route('zendesk', 'api_token');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ url: `http://${address()}/zendesk`, token: expect.stringMatching(/^aqm_rt_[0-9a-f]{48}$/) });
      expect(res.body).not.toContain(REAL_PASSWORD);
      expect(res.body).not.toContain(REAL_USER);
      expect(log.some((r) => r.method === 'BROKER_ROUTE' && r.statusCode === 200)).toBe(true);
    });

    it('answers for the user-name key when that is the one a project routed', async () => {
      routed = new Set(['zendesk/email']);
      expect((await route('zendesk', 'email')).status).toBe(200);
      // The other half of the pair was not routed, so it is not handed a route.
      expect(JSON.parse((await route('zendesk', 'api_token')).body).code).toBe('route_not_recorded');
    });

    it.each([
      ['the routed key', 'api_token', 'zendesk/api_token'],
      ['the other key of the pair', 'email', 'zendesk/email'],
    ])('refuses when %s is not stored, and names the one to add', async (_name, missing, named) => {
      await store.delete('zendesk', missing);
      const res = await route('zendesk', 'api_token');
      expect(res.status).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ code: 'credential_not_found', error: `Credential not found: ${named}`, fix: `Run: aquaman credentials add ${named.replace('/', ' ')}` });
      expect(res.body).not.toMatch(/aqm_/);
    });

    it('checks the routed reference before the vault, the registry and the auth mode', async () => {
      const before = store.gets;
      for (const [service, key] of [['zendesk', 'email'], ['twilio', 'auth_token'], ['telegram', 'bot_token'], ['acme', 'password']]) {
        const res = await route(service, key);
        expect(JSON.parse(res.body).code, `${service}/${key}`).toBe('route_not_recorded');
      }
      expect(store.gets).toBe(before);
    });

    it('refuses a key that is neither the user name nor the password of the service', async () => {
      routed.add('zendesk/subdomain');
      routed.add('twilio/phone_number');
      const before = store.gets;
      expect(JSON.parse((await route('zendesk', 'subdomain')).body)).toMatchObject({
        code: 'route_key_mismatch',
        error: 'The proxy injects zendesk/email and zendesk/api_token for this service, not zendesk/subdomain',
        fix: 'Use aquaman://zendesk/email or aquaman://zendesk/api_token',
      });
      expect(JSON.parse((await route('twilio', 'phone_number')).body).code).toBe('route_key_mismatch');
      expect(store.gets).toBe(before);
    });

    it('a basic service with one key is routed by that key alone', async () => {
      routed.add('bluebubbles/password');
      await store.set('bluebubbles', 'password', 'bb_real_password');
      const { url, token } = JSON.parse((await route('bluebubbles', 'password')).body);
      const res = await fetch(`${url}/api/v1/ping`, { headers: { Authorization: basic(token, '') } });
      expect(res.status).toBe(200);
      expect(upstream.getLastRequest()!.headers['authorization']).toBe(`Basic ${b64('bb_real_password:')}`);
    });
  });

  describe('what the route token can reach', () => {
    it.each([
      ['Bearer', (t: string) => ({ Authorization: `Bearer ${t}` })],
      ['x-aquaman-token', (t: string) => ({ 'x-aquaman-token': t })],
      ['x-api-key', (t: string) => ({ 'x-api-key': t })],
      ['Basic, as the password', (t: string) => ({ Authorization: basic('anyone', t) })],
      ['Basic, as the user name', (t: string) => ({ Authorization: basic(t, 'x') })],
    ])('cannot read either key of the pair through /broker/resolve when sent as %s', async (_name, headers) => {
      const token = await routeToken();
      declared.add('zendesk/email');
      const before = store.gets;
      for (const key of ['api_token', 'email']) {
        for (const endpoint of ['/broker/resolve', '/broker/available', '/broker/route', '/broker/request']) {
          const res = await fetch(`http://${address()}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers(token) },
            body: JSON.stringify({ service: 'zendesk', key, refs: [{ service: 'zendesk', key }] }),
          });
          const text = await res.text();
          expect(res.status, `${endpoint} ${key}`).toBe(401);
          expect(text).not.toContain(REAL_PASSWORD);
          expect(text).not.toContain(REAL_USER);
        }
      }
      expect(store.gets).toBe(before);
    });

    it('the routed key is not materializable on either listener, and the other key of the pair is unaffected', async () => {
      const resolve = (key: string) => udsFetch(socketPath, '/broker/resolve', { method: 'POST', body: JSON.stringify({ service: 'zendesk', key }) });
      const routedKey = await resolve('api_token');
      expect(routedKey.status).toBe(404);
      expect(JSON.parse(routedKey.body).code).toBe('broker_ref_not_declared');
      expect(routedKey.body).not.toContain(REAL_PASSWORD);
      const overLoopback = await fetch(`http://${address()}/broker/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aquaman-token': LOOPBACK_TOKEN },
        body: JSON.stringify({ service: 'zendesk', key: 'api_token' }),
      });
      expect(overLoopback.status).toBe(404);
      expect(await overLoopback.text()).not.toContain(REAL_PASSWORD);

      // The user name is only handed out when the person binds it as a value.
      expect((await resolve('email')).status).toBe(404);
      declared.add('zendesk/email');
      const user = await resolve('email');
      expect(user.status).toBe(200);
      expect(JSON.parse(user.body).value).toBe(REAL_USER);
    });

    it.each([
      ['Bearer', { Authorization: `Bearer ${LOOPBACK_TOKEN}` }, 404],
      ['x-aquaman-token', { 'x-aquaman-token': LOOPBACK_TOKEN }, 404],
      ['Basic, as the password', { Authorization: basic('agent@example.com/token', LOOPBACK_TOKEN) }, 401],
      ['Basic, as the user name', { Authorization: basic(LOOPBACK_TOKEN, 'x') }, 401],
    ])('the agent hosts\' token sent as %s does not forward to a service that is only routed', async (_name, headers, status) => {
      const res = await fetch(`http://${address()}/zendesk/api/v2/tickets.json`, { headers: headers as Record<string, string> });
      expect(res.status).toBe(status);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('the Unix socket does not forward to a service that is only routed', async () => {
      expect((await udsFetch(socketPath, '/zendesk/api/v2/tickets.json')).status).toBe(404);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('does not forward to a basic service nobody routed, or one routed by a key the proxy does not inject', async () => {
      const token = await routeToken();
      routed.add('twilio/phone_number');
      await store.set('twilio', 'account_sid', 'AC_real');
      await store.set('twilio', 'auth_token', 'twilio_real_auth_token');
      for (const service of ['twilio', 'bluebubbles']) {
        const res = await fetch(`http://${address()}/${service}/x`, { headers: { Authorization: basic('u', token) } });
        expect(res.status, service).toBe(401);
      }
      expect(upstream.getRequestCount()).toBe(0);
    });

    it.each([
      ['telegram', 'bot_token', 'url-path'],
      ['ms-teams', 'client_id', 'oauth'],
      ['nostr', 'private_key', 'none'],
    ])('%s (%s auth) stays unroutable: no route is handed out and the token forwards nothing', async (service, key) => {
      const token = await routeToken();
      routed.add(`${service}/${key}`);
      await store.set(service, key, 'stored-value');
      const refusal = await route(service, key);
      expect(refusal.status).toBe(404);
      expect(JSON.parse(refusal.body)).toMatchObject({ code: 'route_unsupported', fix: 'Bind the reference without --via-proxy' });
      for (const headers of [{ Authorization: `Bearer ${token}` }, { Authorization: basic('u', token) }, { 'x-aquaman-token': token }]) {
        expect((await fetch(`http://${address()}/${service}/anything`, { headers })).status).toBe(401);
      }
      expect((await fetch(`http://${address()}/${service}/bot${token}/getMe`)).status).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('a Basic value carrying the token is not accepted for a header service', async () => {
      routed.add('stripe/secret_key');
      await store.set('stripe', 'secret_key', 'sk_live_real');
      const token = await routeToken('stripe', 'secret_key');
      expect((await fetch(`http://${address()}/stripe/v1/charges`, { headers: { Authorization: basic(token, '') } })).status).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
      expect((await fetch(`http://${address()}/stripe/v1/charges`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    });
  });

  describe('the inbound Basic value', () => {
    it.each([
      ['as the password, the way a client sends an API token', (t: string) => basic('agent@example.com/token', t)],
      ['as the user name', (t: string) => basic(t, 'ignored')],
      ['as the password with an empty user name', (t: string) => basic('', t)],
      ['as the user name with an empty password', (t: string) => basic(t, '')],
      ['with a lower-case scheme', (t: string) => basic('u', t).replace('Basic', 'basic')],
      ['next to a user name that is not ASCII', (t: string) => basic(`j${String.fromCharCode(0xfc)}rgen@example.com`, t)],
    ])('is accepted with the token %s, and the stored pair is what goes upstream', async (_name, header) => {
      const token = await routeToken();
      const res = await rawGet(address(), '/zendesk/api/v2/tickets.json', { Authorization: header(token) });
      expect(res.status).toBe(200);
      const seen = upstream.getLastRequest()!;
      expect(seen.path).toBe('/api/v2/tickets.json');
      expect(seen.headers['authorization']).toBe(REAL_BASIC);
    });

    it.each([
      ['no colon in the decoded value', (t: string) => `Basic ${b64(t)}`],
      ['the token in a third field', (t: string) => basic('user', `password:${t}`)],
      ['the token with a character before it', (t: string) => basic('user', `x${t}`)],
      ['the token with a character after it', (t: string) => basic('user', `${t}x`)],
      ['the token cut short', (t: string) => basic('user', t.slice(0, -1))],
      ['a character outside the base64 alphabet', (t: string) => `${basic('user', t).slice(0, -4)}!${basic('user', t).slice(-3)}`],
      ['the URL-safe base64 alphabet', (t: string) => `Basic ${Buffer.from(`${HIGH_BYTES}:${t}`, 'latin1').toString('base64url')}`],
      ['padding removed', (t: string) => basic('abc', t).replace(/=+$/, '')],
      ['padding added', (t: string) => `${basic('u', t)}=`],
      ['bits set that canonical base64 leaves clear', (t: string) => `Basic ${nonCanonical(`usr:${t}`)}`],
      ['two spaces after the scheme', (t: string) => basic('user', t).replace('Basic ', 'Basic  ')],
      ['a tab after the scheme', (t: string) => basic('user', t).replace('Basic ', 'Basic\t')],
      ['no space after the scheme', (t: string) => basic('user', t).replace('Basic ', 'Basic')],
      ['text after the value', (t: string) => `${basic('user', t)} extra`],
      ['two values in one header', (t: string) => `${basic('user', 'x')}, ${basic('user', t)}`],
      ['another scheme around the same bytes', (t: string) => basic('user', t).replace('Basic', 'Digest')],
      ['base64 applied twice', (t: string) => `Basic ${b64(b64(`user:${t}`))}`],
      ['a value past the length cap', (t: string) => basic('u'.repeat(1024), t)],
      ['an empty value', () => 'Basic '],
      ['a wrong token', () => basic('user', `aqm_rt_${'0'.repeat(48)}`)],
    ])('is refused with %s', async (_name, header) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await rawGet(address(), '/zendesk/api/v2/tickets.json', { Authorization: header(token) });
      expect(res.status).toBe(401);
      expect(res.body).not.toContain(REAL_PASSWORD);
      expect(upstream.getRequestCount()).toBe(0);
      expect(store.gets).toBe(before);
    });

    it('the rows above alter what they say they alter', async () => {
      // A row whose mutation is a no-op would pass for the wrong reason.
      const token = await routeToken();
      const altered = nonCanonical(`usr:${token}`);
      expect(altered).not.toBe(b64(`usr:${token}`));
      expect(Buffer.from(altered, 'base64').toString('latin1')).toBe(`usr:${token}`);
      const urlSafe = Buffer.from(`${HIGH_BYTES}:${token}`, 'latin1').toString('base64url');
      expect(urlSafe).toMatch(/^-__7_/);
      expect(urlSafe.length % 4).toBe(0);
      expect(basic('u', token).endsWith('=')).toBe(false);
      expect(basic('abc', token).endsWith('=')).toBe(true);
    });
  });

  describe('what goes upstream', () => {
    /** Every header value the upstream received, with anything that decodes as base64 decoded as well. */
    const upstreamText = () => {
      const headers = upstream.getLastRequest()!.headers;
      const values = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
      const decoded = values.flatMap((v) => (v.match(/[A-Za-z0-9+/_-]{8,}={0,2}/g) ?? []).map((m) => Buffer.from(m, 'base64').toString('latin1')));
      return [...values, ...decoded].join('\n');
    };

    it.each([
      ['Authorization itself', (t: string) => ({ Authorization: basic('agent@example.com/token', t) })],
      ['the bare token in another header', (t: string) => ({ Authorization: basic('u', t), 'X-Debug-Key': t })],
      ['the token wrapped in another header', (t: string) => ({ Authorization: basic('u', t), 'X-Debug': `key=${t};` })],
      ['a second Basic value in Proxy-Authorization', (t: string) => ({ Authorization: basic('u', t), 'Proxy-Authorization': basic('u', t) })],
      ['a Basic value in a forwarding header', (t: string) => ({ Authorization: basic('u', t), 'X-Forwarded-Authorization': basic(t, 'x') })],
      ['a Basic value with a lower-case scheme and extra spaces', (t: string) => ({ Authorization: basic('u', t), 'X-Auth': `basic   ${b64(`u:${t}`)}` })],
      ['a Basic value in the URL-safe alphabet without padding', (t: string) => ({ Authorization: basic('u', t), 'X-Auth': `Basic ${Buffer.from(`${HIGH_BYTES}:${t}`, 'latin1').toString('base64url')}` })],
      ['a Basic value in the middle of a header', (t: string) => ({ Authorization: basic('u', t), 'X-Trace': `auth="Basic ${b64(`u:${t}`)}"; hop=1` })],
      ['a Basic value in a cookie', (t: string) => ({ Authorization: basic('u', t), Cookie: `session=Basic ${b64(`u:${t}`)}` })],
      ['the token in x-aquaman-token and x-api-key', (t: string) => ({ 'x-aquaman-token': t, 'x-api-key': t })],
      ['the agent hosts\' token inside a Basic value in another header', (t: string) => ({ Authorization: basic('u', t), 'X-Auth': basic('host', LOOPBACK_TOKEN) })],
    ])('the route token is not forwarded in %s', async (_name, headers) => {
      const token = await routeToken();
      const res = await rawGet(address(), '/zendesk/api/v2/tickets.json', { ...headers(token), 'X-Kept': 'kept-value' });
      expect(res.status).toBe(200);
      const seen = upstream.getLastRequest()!;
      expect(seen.headers['authorization']).toBe(REAL_BASIC);
      expect(seen.headers['x-kept']).toBe('kept-value');
      const text = upstreamText();
      expect(text).not.toContain(token);
      expect(text).not.toContain(LOOPBACK_TOKEN);
    });

    it('a header that only looks like Basic auth is forwarded unchanged', async () => {
      const token = await routeToken();
      const res = await rawGet(address(), '/zendesk/api/v2/tickets.json', {
        Authorization: basic('u', token),
        'X-Note': 'basic information about the ticket',
        'X-Other-Auth': basic('someone', 'unrelated-password'),
      });
      expect(res.status).toBe(200);
      const seen = upstream.getLastRequest()!;
      expect(seen.headers['x-note']).toBe('basic information about the ticket');
      expect(seen.headers['x-other-auth']).toBe(basic('someone', 'unrelated-password'));
    });

    // The proxy reads its token out of a Basic value because that is the one
    // encoding a routed client is expected to produce. It does not search
    // header values for the token under other transformations.
    it.fails('limit: the route token base64-encoded in a header without the Basic scheme is forwarded', async () => {
      const token = await routeToken();
      await rawGet(address(), '/zendesk/api/v2/tickets.json', { Authorization: basic('u', token), 'X-Blob': b64(`u:${token}`) });
      expect(upstreamText()).not.toContain(token);
    });

    it('the request log and the audit callback never hold the token or a stored value', async () => {
      const token = await routeToken();
      await rawGet(address(), '/zendesk/api/v2/tickets.json', { Authorization: basic('u', token) });
      const text = JSON.stringify(log);
      expect(text).not.toContain(token);
      expect(text).not.toContain(b64(`u:${token}`));
      expect(text).not.toContain(REAL_PASSWORD);
      expect(log.some((r) => r.service === 'zendesk' && r.statusCode === 200 && r.authenticated)).toBe(true);
    });
  });

  describe('request policy', () => {
    it.each([
      ['the plain path', 'DELETE', '/zendesk/api/v2/tickets/42', {}],
      ['an upper-case spelling of the path', 'DELETE', '/zendesk/API/v2/Tickets/42', {}],
      ['a method-override header on a GET', 'GET', '/zendesk/api/v2/tickets/42', { 'X-HTTP-Method-Override': 'DELETE' }],
      ['a path named by X-Original-URL', 'DELETE', '/zendesk/api/v2/users/me', { 'X-Original-URL': '/api/v2/tickets/42' }],
    ])('a routed basic request denied by %s is refused before any vault read', async (_name, method, urlPath, extra) => {
      const token = await routeToken();
      const before = store.gets;
      const res = await fetch(`http://${address()}${urlPath}`, { method, headers: { Authorization: basic('agent@example.com/token', token), ...extra } });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(REAL_PASSWORD);
      expect(store.gets).toBe(before);
      expect(upstream.getRequestCount()).toBe(0);
      expect(log.some((r) => r.statusCode === 403 && /Policy denied/.test(r.error ?? ''))).toBe(true);
    });

    it('a request the policy allows goes through with the stored pair', async () => {
      const token = await routeToken();
      const res = await fetch(`http://${address()}/zendesk/api/v2/tickets/42`, { headers: { Authorization: basic('agent@example.com/token', token) } });
      expect(res.status).toBe(200);
      expect(upstream.getLastRequest()!.headers['authorization']).toBe(REAL_BASIC);
    });
  });

  it('refuses a request whose Host header is not a loopback name, whatever its Basic value', async () => {
    const token = await routeToken();
    const res = await rawGet(address(), '/zendesk/api/v2/tickets.json', { Host: 'attacker.example', Authorization: basic('u', token) });
    expect(res.status).toBe(403);
    expect(upstream.getRequestCount()).toBe(0);
  });
});
