/**
 * Conformance: one deny rule, attacked with every spelling of the request it
 * denies.
 *
 * The rule is `deny DELETE /v1/admin/**`. Each row is a request an upstream
 * could take to be `DELETE /v1/admin/users` although its request line says
 * something else: a different case, an encoded separator, a method named in
 * an override header or a `_method` parameter, a path named in
 * `X-Original-URL`. The claim under test is that the upstream never receives
 * any of them, so no credential is attached to one.
 *
 * A real proxy on a temporary socket, a local upstream, and requests written
 * to the socket byte for byte (HTTP clients tidy up exactly these paths and
 * cannot send one header twice).
 *
 * A spelling the proxy does not cover is an `it.fails` row that states the
 * limit; it turns into a failure the day the proxy covers it.
 *
 * NIST SP 800-53 AC-3 (access enforcement); MITRE ATLAS AML.T0012 (valid
 * accounts); OWASP API5:2023 (broken function level authorization).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { createCredentialProxy, createServiceRegistry, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket } from '../helpers/uds-proxy.js';

const REAL_KEY = 'REAL-VAULT-KEY-POLICY-0042';

interface Seen { method: string; url: string; key: string }
type Header = [name: string, value: string];

interface Attack {
  name: string;
  method: string;
  target: string;
  headers?: Header[];
  body?: string;
  /** The status the proxy answers: 403 from policy, 400 where the request target itself is refused. */
  status: 403 | 400;
  /** Why this spelling gets through today; absent for one that is stopped. */
  limit?: string;
}

const ADMIN = '/anthropic/v1/admin/users';
const OTHER = '/anthropic/v1/models';

const ATTACKS: Attack[] = [
  // The request as the rule was written for it.
  { name: 'the denied request itself', method: 'DELETE', target: ADMIN, status: 403 },
  { name: 'a lower-case method token in an override header', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'delete']], status: 403 },

  // Path case: many routers ignore it.
  { name: 'path case: /v1/Admin', method: 'DELETE', target: '/anthropic/v1/Admin/users', status: 403 },
  { name: 'path case: /V1/ADMIN', method: 'DELETE', target: '/anthropic/V1/ADMIN/users', status: 403 },
  { name: 'path case inside an encoded segment: %41dmin', method: 'DELETE', target: '/anthropic/v1/%41dmin/users', status: 403 },

  // Encoded separators and matrix parameters.
  { name: 'encoded slash before the denied segment', method: 'DELETE', target: '/anthropic/v1%2Fadmin/users', status: 403 },
  { name: 'encoded slash after the denied segment', method: 'DELETE', target: '/anthropic/v1/admin%2Fusers', status: 403 },
  { name: 'lower-case encoded slash', method: 'DELETE', target: '/anthropic/v1%2fadmin%2fusers', status: 403 },
  { name: ';params on the denied segment', method: 'DELETE', target: '/anthropic/v1/admin;x=1/users', status: 403 },
  { name: ';params and case together', method: 'DELETE', target: '/anthropic/v1/ADMIN;jsessionid=1/users', status: 403 },
  { name: 'a doubled slash', method: 'DELETE', target: '/anthropic/v1//admin/users', status: 403 },
  { name: 'a query string', method: 'DELETE', target: `${ADMIN}?x=1`, status: 403 },

  // Dot segments: refused when the request target is parsed.
  { name: 'a dot segment that resolves to the denied path', method: 'DELETE', target: '/anthropic/v1/models/../admin/users', status: 400 },
  { name: 'an encoded dot segment', method: 'DELETE', target: '/anthropic/v1/models/%2e%2e/admin/users', status: 400 },
  { name: 'a double-encoded dot segment', method: 'DELETE', target: '/anthropic/v1/models/%252e%252e/admin/users', status: 400 },
  { name: 'a backslash', method: 'DELETE', target: '/anthropic/v1\\admin/users', status: 400 },

  // Method-override headers, one value.
  { name: 'X-HTTP-Method-Override: DELETE', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'DELETE']], status: 403 },
  { name: 'X-Method-Override: DELETE', method: 'POST', target: ADMIN, headers: [['X-Method-Override', 'DELETE']], status: 403 },
  { name: 'X-HTTP-Method: DELETE', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method', 'DELETE']], status: 403 },
  { name: 'an override header in another case', method: 'POST', target: ADMIN, headers: [['x-http-METHOD-override', 'DELETE']], status: 403 },

  // Method-override headers, a list or the header twice.
  { name: 'X-HTTP-Method-Override: DELETE, GET', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'DELETE, GET']], status: 403 },
  { name: 'X-HTTP-Method-Override: GET, DELETE', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'GET, DELETE']], status: 403 },
  { name: 'X-HTTP-Method-Override: DELETE,GET', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'DELETE,GET']], status: 403 },
  { name: 'X-HTTP-Method-Override: DELETE;', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'DELETE;']], status: 403 },
  { name: 'X-HTTP-Method-Override: GET DELETE', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'GET DELETE']], status: 403 },
  { name: 'X-HTTP-Method-Override sent twice (DELETE, then GET)', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'DELETE'], ['X-HTTP-Method-Override', 'GET']], status: 403 },
  { name: 'X-HTTP-Method-Override sent twice (GET, then DELETE)', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'GET'], ['X-HTTP-Method-Override', 'DELETE']], status: 403 },
  { name: 'X-Method-Override: GET, DELETE', method: 'POST', target: ADMIN, headers: [['X-Method-Override', 'GET, DELETE']], status: 403 },
  { name: 'X-Method-Override sent twice', method: 'POST', target: ADMIN, headers: [['X-Method-Override', 'GET'], ['X-Method-Override', 'DELETE']], status: 403 },
  { name: 'X-HTTP-Method: GET, DELETE', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method', 'GET, DELETE']], status: 403 },
  { name: 'X-HTTP-Method sent twice', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method', 'GET'], ['X-HTTP-Method', 'DELETE']], status: 403 },
  { name: 'two different override headers that disagree', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'GET'], ['X-Method-Override', 'DELETE']], status: 403 },

  // The `_method` query parameter.
  { name: '?_method=DELETE', method: 'POST', target: `${ADMIN}?_method=DELETE`, status: 403 },
  { name: '?_method=delete after another parameter', method: 'POST', target: `${ADMIN}?x=1&_method=delete`, status: 403 },
  { name: 'an encoded parameter name: %5Fmethod', method: 'POST', target: `${ADMIN}?%5Fmethod=DELETE`, status: 403 },
  { name: 'an encoded parameter value: %44ELETE', method: 'POST', target: `${ADMIN}?_method=%44ELETE`, status: 403 },
  { name: '?_method given twice', method: 'POST', target: `${ADMIN}?_method=GET&_method=DELETE`, status: 403 },
  { name: '?_METHOD=DELETE', method: 'POST', target: `${ADMIN}?_METHOD=DELETE`, status: 403 },
  { name: 'a semicolon-separated query: ?x=1;_method=DELETE', method: 'POST', target: `${ADMIN}?x=1;_method=DELETE`, status: 403 },

  // Path-override headers.
  { name: 'X-Original-URL names the denied path', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', '/v1/admin/users']], status: 403 },
  { name: 'X-Rewrite-URL names the denied path', method: 'DELETE', target: OTHER, headers: [['X-Rewrite-URL', '/v1/admin/users']], status: 403 },
  { name: 'X-Original-URL in another case, with a query', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', '/v1/ADMIN/users?x=1']], status: 403 },
  { name: 'X-Original-URL with an encoded slash', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', '/v1%2Fadmin/users']], status: 403 },
  { name: 'X-Original-URL as a full URL', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', 'https://api.example/v1/admin/users']], status: 403 },
  { name: 'X-Original-URL sent twice', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', '/v1/models'], ['X-Original-URL', '/v1/admin/users']], status: 403 },
  { name: 'X-Original-URL the proxy cannot read (a dot segment)', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', '/v1/models/../admin/users']], status: 403 },
  { name: 'method and path both overridden', method: 'POST', target: `${OTHER}?_method=DELETE`, headers: [['X-Rewrite-URL', '/v1/Admin/users']], status: 403 },
  { name: 'method by header, path by header', method: 'POST', target: OTHER, headers: [['X-HTTP-Method-Override', 'GET, DELETE'], ['X-Original-URL', '/v1/admin/users']], status: 403 },

  // Known limits.
  {
    name: 'a trailing dot on the denied segment (/v1/admin./users)',
    method: 'DELETE', target: '/anthropic/v1/admin./users', status: 403,
    limit: 'a segment is compared whole; an upstream that trims trailing dots (IIS does) reads it as /v1/admin',
  },
  {
    name: 'a trailing encoded space on the denied segment (/v1/admin%20/users)',
    method: 'DELETE', target: '/anthropic/v1/admin%20/users', status: 403,
    limit: 'a segment is compared whole; an upstream that trims trailing spaces reads it as /v1/admin',
  },
  {
    name: 'a full-width letter (/v1/%EF%BD%81dmin/users)',
    method: 'DELETE', target: '/anthropic/v1/%EF%BD%81dmin/users', status: 403,
    limit: 'no Unicode compatibility folding; an upstream that normalises to NFKC reads it as /v1/admin',
  },
  {
    name: '_method=DELETE in a form body',
    method: 'POST', target: ADMIN, headers: [['Content-Type', 'application/x-www-form-urlencoded']], body: '_method=DELETE', status: 403,
    limit: 'the proxy streams the request body and does not read it',
  },
];

describe('policy evasion: one deny rule against every spelling', () => {
  const seen: Seen[] = [];
  let server: http.Server;
  let proxy: CredentialProxy;
  let socketPath: string;

  /** Send one request exactly as written; resolve with the status and what the upstream saw because of it. */
  function send(a: Pick<Attack, 'method' | 'target' | 'headers' | 'body'>): Promise<{ status: number; reached: Seen[] }> {
    const before = seen.length;
    return new Promise((resolve) => {
      const socket = net.connect(socketPath);
      let raw = '';
      const finish = () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), reached: seen.slice(before) });
      socket.on('data', (chunk) => { raw += chunk; });
      socket.on('close', finish);
      socket.on('error', finish);
      const body = a.body ?? '';
      const extra = (a.headers ?? []).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(`${a.method} ${a.target} HTTP/1.1\r\nHost: aquaman.local\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}\r\n${body}`);
    });
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', key: String(req.headers['x-api-key'] ?? '') });
      req.resume();
      res.end('ok');
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
    const registry = createServiceRegistry();
    registry.override('anthropic', { upstream: `http://127.0.0.1:${port}` });
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL_KEY);
    socketPath = tmpSocketPath();
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic'],
      serviceRegistry: registry,
      policyConfig: {
        anthropic: { defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/v1/admin/**', action: 'deny' }] },
      },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    cleanupSocket(socketPath);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('controls: the rule denies one thing, and everything else still works', () => {
    const allowed: Array<Pick<Attack, 'name' | 'method' | 'target' | 'headers'> & { upstream: string }> = [
      { name: 'another method on the denied path', method: 'GET', target: ADMIN, upstream: '/v1/admin/users' },
      { name: 'the denied method on another path', method: 'DELETE', target: `${OTHER}/m1`, upstream: '/v1/models/m1' },
      { name: 'a path that only starts like the denied one', method: 'DELETE', target: '/anthropic/v1/administrators', upstream: '/v1/administrators' },
      { name: 'an override header naming an allowed method', method: 'POST', target: ADMIN, headers: [['X-HTTP-Method-Override', 'PATCH, PUT']], upstream: '/v1/admin/users' },
      { name: 'a path-override header naming an allowed path', method: 'DELETE', target: OTHER, headers: [['X-Original-URL', '/v1/models/m1']], upstream: '/v1/models' },
      { name: 'a query parameter that only resembles _method', method: 'POST', target: `${ADMIN}?my_method=DELETE`, upstream: '/v1/admin/users?my_method=DELETE' },
    ];
    for (const c of allowed) {
      it(`allowed: ${c.name}`, async () => {
        const { status, reached } = await send(c);
        expect(status).toBe(200);
        expect(reached).toEqual([{ method: c.method, url: c.upstream, key: REAL_KEY }]);
      });
    }
  });

  describe('attacks: the upstream never receives the denied request', () => {
    for (const attack of ATTACKS.filter((a) => !a.limit)) {
      it(`stopped (${attack.status}): ${attack.name}`, async () => {
        const { status, reached } = await send(attack);
        expect(reached).toEqual([]);
        expect(status).toBe(attack.status);
      });
    }

    for (const attack of ATTACKS.filter((a) => a.limit)) {
      // Current limit: see `attack.limit` in the row; the assertion is what should hold.
      it.fails(`should be stopped, is not yet: ${attack.name} (${attack.limit})`, async () => {
        const { status, reached } = await send(attack);
        expect(reached).toEqual([]);
        expect(status).toBe(attack.status);
      });
    }
  });

  it('a service with no rules is not affected by a path-override header the proxy cannot read', async () => {
    const other = tmpSocketPath();
    const registry = createServiceRegistry();
    registry.override('anthropic', { upstream: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}` });
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL_KEY);
    const unruled = createCredentialProxy({
      socketPath: other,
      store,
      allowedServices: ['anthropic'],
      serviceRegistry: registry,
      policyConfig: { openai: { defaultAction: 'deny', rules: [] } },
    });
    await unruled.start();
    const mine = socketPath;
    socketPath = other;
    try {
      const { status, reached } = await send({ method: 'GET', target: OTHER, headers: [['X-Original-URL', '/v1/../x']] });
      expect(status).toBe(200);
      expect(reached).toHaveLength(1);
    } finally {
      socketPath = mine;
      await unruled.stop();
      cleanupSocket(other);
    }
  });
});
