/**
 * Conformance: the credential only ever goes to the service's own upstream,
 * and a deny rule cannot be dodged by respelling the path or the method.
 *
 * Runs a real proxy with two local upstreams: the service's own, and one
 * standing in for a host the client would like the credential sent to. Every
 * request is written to the socket byte for byte, because HTTP clients tidy
 * up exactly the paths that matter here.
 *
 * MITRE ATLAS AML.T0055 (unsecured credentials), AML.T0012 (valid accounts);
 * NIST SP 800-53 AC-3 (access enforcement), SI-10 (input validation).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { createCredentialProxy, createServiceRegistry, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket } from '../helpers/uds-proxy.js';

const REAL_KEY = 'REAL-VAULT-KEY-0042';

interface Seen { who: string; method: string; url: string; key: string }

describe('request target integrity', () => {
  const seen: Seen[] = [];
  const servers: http.Server[] = [];
  let proxy: CredentialProxy;
  let socketPath: string;
  let otherPort: number;

  function upstream(who: string): Promise<number> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        seen.push({ who, method: req.method ?? '', url: req.url ?? '', key: String(req.headers['x-api-key'] ?? '') });
        if (req.url?.startsWith('/v1/redirect')) {
          res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/steal` });
          res.end();
          return;
        }
        res.end('ok');
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  /** Send one request exactly as written; resolve with the status code and what the upstreams saw because of it. */
  function send(target: string, method = 'GET', headers: Record<string, string> = {}): Promise<{ status: number; reached: Seen[] }> {
    const before = seen.length;
    return new Promise((resolve) => {
      const socket = net.connect(socketPath);
      let raw = '';
      const finish = () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), reached: seen.slice(before) });
      socket.on('data', (chunk) => { raw += chunk; });
      socket.on('close', finish);
      socket.on('error', finish);
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      socket.write(`${method} ${target} HTTP/1.1\r\nHost: aquaman.local\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`);
    });
  }

  beforeAll(async () => {
    const ownPort = await upstream('own');
    otherPort = await upstream('other');
    const registry = createServiceRegistry();
    registry.override('anthropic', { upstream: `http://127.0.0.1:${ownPort}` });
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL_KEY);
    socketPath = tmpSocketPath();
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic'],
      serviceRegistry: registry,
      policyConfig: {
        anthropic: {
          defaultAction: 'allow',
          rules: [
            { method: '*', path: '/v1/organizations/**', action: 'deny' },
            { method: 'DELETE', path: '/v1/**', action: 'deny' },
          ],
        },
      },
    });
    await proxy.start();
  });

  afterAll(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    cleanupSocket(socketPath);
    for (const s of servers) s.close();
  });

  it('forwards an ordinary request to the service upstream with the credential', async () => {
    const { status, reached } = await send('/anthropic/v1/messages?beta=true', 'POST');
    expect(status).toBe(200);
    expect(reached).toEqual([{ who: 'own', method: 'POST', url: '/v1/messages?beta=true', key: REAL_KEY }]);
  });

  describe('the credential never goes to a host the client names', () => {
    const targets = (port: number) => [
      `/anthropic/\\127.0.0.1:${port}/steal`,
      `/anthropic/\\\\127.0.0.1:${port}/steal`,
      `/anthropic/%5C127.0.0.1:${port}/steal`,
      `/anthropic//127.0.0.1:${port}/steal`,
      `/anthropic/%2F%2F127.0.0.1:${port}/steal`,
      `/anthropic/\t/127.0.0.1:${port}/steal`,
      `/anthropic/v1/..//127.0.0.1:${port}/steal`,
      `/anthropic/@127.0.0.1:${port}/steal`,
      `http://127.0.0.1:${port}/anthropic/steal`,
      `//127.0.0.1:${port}/anthropic/steal`,
    ];

    it('whatever the path looks like', async () => {
      for (const target of targets(otherPort)) {
        const { reached } = await send(target);
        expect(reached.filter((r) => r.who === 'other'), target).toEqual([]);
        // Anything that did go out went to the service's own upstream.
        for (const r of reached) expect(r.who, target).toBe('own');
      }
    });

    it('and refuses the ambiguous ones outright', async () => {
      for (const target of targets(otherPort).slice(0, 3)) {
        const { status, reached } = await send(target);
        expect(status, target).toBe(400);
        expect(reached, target).toEqual([]);
      }
    });
  });

  it('does not follow an upstream redirect: the client gets the 3xx, the other host gets nothing', async () => {
    const { status, reached } = await send('/anthropic/v1/redirect');
    expect(status).toBe(302);
    expect(reached.map((r) => r.who)).toEqual(['own']);
  });

  describe('a deny rule holds however the path is spelled', () => {
    it.each([
      '/anthropic/v1/organizations/x',
      '/anthropic/v1/organizations',
      '/anthropic/v1/organizations?x=1',
      '/anthropic/v1/organizations/x?y=1',
      '/anthropic/v1/organizations/',
      '/anthropic//v1//organizations//x',
      '/anthropic/v1/%6Frganizations/x',
      '/anthropic/v1/%6f%72ganizations',
      '/anthropic/v1/organizations;x/y',
      '/anthropic/v1/organizations;jsessionid=1',
      '/anthropic/v1%2Forganizations/x',
      '/anthropic/v1%2forganizations%2fx',
      '/anthropic/v1/x/../organizations/y',
      '/anthropic/v1/%2e%2e/v1/organizations/y',
      '/anthropic/v1/./organizations/y',
      '/anthropic/v1/x%2F..%2Forganizations',
      '/anthropic/v1/%252e%252e/v1/organizations',
    ])('%s does not reach the upstream', async (target) => {
      const { status, reached } = await send(target);
      expect([400, 403]).toContain(status);
      expect(reached).toEqual([]);
    });
  });

  describe('a method rule holds however the method is named', () => {
    it('denies DELETE', async () => {
      const { status, reached } = await send('/anthropic/v1/files/f1', 'DELETE');
      expect(status).toBe(403);
      expect(reached).toEqual([]);
    });

    it.each(['X-HTTP-Method-Override', 'X-Method-Override', 'X-HTTP-Method'])('denies POST with %s: DELETE', async (header) => {
      const { status, reached } = await send('/anthropic/v1/files/f1', 'POST', { [header]: 'DELETE' });
      expect(status).toBe(403);
      expect(reached).toEqual([]);
    });

    it('still allows a POST that overrides to an allowed method', async () => {
      const { status, reached } = await send('/anthropic/v1/files/f1', 'POST', { 'X-HTTP-Method-Override': 'PATCH' });
      expect(status).toBe(200);
      expect(reached).toHaveLength(1);
    });
  });
});
