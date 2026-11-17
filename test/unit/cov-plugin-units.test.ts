/**
 * Unit: the small plugin modules. proxy-health against an HTTP server on a
 * Unix socket in a temp directory, the config schema's defaults and merge, and
 * the interceptor's handling of the fetch argument shapes the existing tests
 * do not pass (Request objects, Headers, header tuples, non-URL input).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { loadHostMap, isProxyRunning, getProxyVersion } from '../../packages/plugin/src/proxy-health.js';
import { ConfigSchema, CredentialBackend, ProxiedServices, defaultConfig, mergeConfig } from '../../packages/plugin/src/config-schema.js';
import { createHttpInterceptor, type HttpInterceptor } from '../../packages/plugin/src/http-interceptor.js';

describe('proxy-health over a Unix socket', () => {
  let dir: string;
  let socketPath: string;
  let server: http.Server;
  let routes: Record<string, { status: number; body: string }>;
  let seen: string[];

  beforeEach(async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqh-')));
    socketPath = path.join(dir, 'proxy.sock');
    routes = {};
    seen = [];
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const route = routes[req.url ?? ''];
      if (!route) return; // never answers
      res.writeHead(route.status, { 'Content-Type': 'application/json' });
      res.end(route.body);
    });
    await new Promise<void>((r) => server.listen(socketPath, () => r()));
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the version and the host map from a running proxy', async () => {
    routes['/_health'] = { status: 200, body: JSON.stringify({ status: 'ok', version: '1.2.3' }) };
    routes['/_hostmap'] = { status: 200, body: JSON.stringify({ 'api.anthropic.com': 'anthropic', '*.slack.com': 'slack' }) };

    expect(await isProxyRunning(socketPath)).toBe(true);
    expect(await getProxyVersion(socketPath)).toBe('1.2.3');
    const map = await loadHostMap(socketPath);
    expect(map).toBeInstanceOf(Map);
    expect([...map]).toEqual([['api.anthropic.com', 'anthropic'], ['*.slack.com', 'slack']]);
    expect(seen).toEqual(['GET /_health', 'GET /_health', 'GET /_hostmap']);
  });

  it('a proxy that is up but reports no version has no version', async () => {
    routes['/_health'] = { status: 200, body: JSON.stringify({ status: 'ok' }) };
    expect(await isProxyRunning(socketPath)).toBe(true);
    expect(await getProxyVersion(socketPath)).toBeNull();
  });

  it('an error status or a body that is not JSON counts as not running, with an empty host map', async () => {
    routes['/_health'] = { status: 503, body: JSON.stringify({ status: 'starting', version: '1.2.3' }) };
    routes['/_hostmap'] = { status: 404, body: JSON.stringify({ error: 'no such endpoint' }) };
    expect(await isProxyRunning(socketPath)).toBe(false);
    expect(await getProxyVersion(socketPath)).toBeNull();
    expect((await loadHostMap(socketPath)).size).toBe(0);

    routes['/_health'] = { status: 200, body: '<html>not the proxy</html>' };
    routes['/_hostmap'] = { status: 200, body: 'null' };
    expect(await isProxyRunning(socketPath)).toBe(false);
    expect(await getProxyVersion(socketPath)).toBeNull();
    expect((await loadHostMap(socketPath)).size).toBe(0);
  });

  it('no socket, or something on the socket that hangs up, is not running', async () => {
    const missing = path.join(dir, 'none.sock');
    expect(await isProxyRunning(missing)).toBe(false);
    expect(await getProxyVersion(missing)).toBeNull();
    expect((await loadHostMap(missing)).size).toBe(0);

    const rawPath = path.join(dir, 'raw.sock');
    const raw = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => raw.listen(rawPath, () => r()));
    try {
      expect(await isProxyRunning(rawPath)).toBe(false);
    } finally {
      await new Promise<void>((r) => raw.close(() => r()));
    }
  });

  it('gives up on a proxy that accepts and never answers', async () => {
    const started = Date.now();
    // No route registered: the server holds the request open. The module's own limit is 3 s.
    expect(await isProxyRunning(socketPath)).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(10_000);
  }, 20_000);
});

describe('plugin config schema', () => {
  it('defaults to the keychain and the two LLM providers', () => {
    expect(defaultConfig).toEqual({ backend: 'keychain', services: ['anthropic', 'openai'], vaultMountPath: 'secret' });
    expect(CredentialBackend.default).toBe('keychain');
    expect(ProxiedServices.default).toEqual(['anthropic', 'openai']);
    expect(Value.Check(ConfigSchema, defaultConfig)).toBe(true);
    expect(Value.Check(ConfigSchema, {})).toBe(true);
  });

  it('accepts the listed backends and refuses anything else', () => {
    for (const backend of ['keychain', '1password', 'vault', 'encrypted-file', 'keepassxc']) {
      expect(Value.Check(ConfigSchema, { backend })).toBe(true);
    }
    expect(Value.Check(ConfigSchema, { backend: 'plaintext-env' })).toBe(false);
    expect(Value.Check(ConfigSchema, { services: 'anthropic' })).toBe(false);
    expect(Value.Check(ConfigSchema, { services: ['anthropic', 7] })).toBe(false);
  });

  it('mergeConfig: user values win, and missing or empty services fall back to the default', () => {
    expect(mergeConfig({})).toEqual(defaultConfig);
    expect(mergeConfig({ backend: 'vault', vaultAddress: 'https://vault.test:8200', services: ['github'] })).toEqual({
      backend: 'vault',
      services: ['github'],
      vaultMountPath: 'secret',
      vaultAddress: 'https://vault.test:8200',
    });
    expect(mergeConfig({ services: undefined, vaultMountPath: 'kv' })).toEqual({ backend: 'keychain', services: ['anthropic', 'openai'], vaultMountPath: 'kv' });
    // The default object is not handed out for mutation.
    const merged = mergeConfig({});
    merged.backend = 'vault';
    expect(defaultConfig.backend).toBe('keychain');
  });
});

describe('HttpInterceptor: fetch argument shapes', () => {
  let interceptor: HttpInterceptor;
  let originalFetch: typeof globalThis.fetch;
  let calls: Array<{ input: unknown; init?: any }>;

  beforeEach(() => {
    calls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      calls.push({ input, init });
      return new Response('ok');
    }) as typeof globalThis.fetch;
    interceptor = createHttpInterceptor({
      socketPath: '/tmp/aquaman-test/proxy.sock',
      hostMap: new Map([['api.telegram.org', 'telegram'], ['*.slack.com', 'slack']]),
    });
    interceptor.activate();
  });

  afterEach(() => {
    interceptor.deactivate();
    globalThis.fetch = originalFetch;
  });

  it('passes through, untouched, input it cannot read as a URL', async () => {
    const init = { method: 'POST' };
    await globalThis.fetch('/relative/path', init);
    await globalThis.fetch('not a url at all');
    await globalThis.fetch(42 as any);
    expect(calls.map((c) => c.input)).toEqual(['/relative/path', 'not a url at all', 42]);
    expect(calls[0].init).toBe(init);
    expect(calls[1].init).toBeUndefined();
  });

  it('redirects a Request object for a mapped host', async () => {
    await globalThis.fetch(new Request('https://api.telegram.org/bot123/getMe?x=1'));
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('http://aquaman.local/telegram/bot123/getMe?x=1');
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.dispatcher).toBeDefined();
  });

  it('leaves a Request object for an unmapped host alone', async () => {
    const request = new Request('https://example.com/data');
    await globalThis.fetch(request);
    expect(calls[0].input).toBe(request);
    expect(calls[0].init).toBeUndefined();
  });

  it('strips authorization and x-api-key from a Headers object, leaving the caller’s copy intact', async () => {
    const headers = new Headers({ Authorization: 'Bearer caller-token', 'X-Api-Key': 'caller-key', 'Content-Type': 'application/json' });
    await globalThis.fetch('https://hooks.slack.com/services/T/B/x', { method: 'POST', headers });
    const sent = calls[0].init.headers as Headers;
    expect(sent).toBeInstanceOf(Headers);
    expect(sent.has('authorization')).toBe(false);
    expect(sent.has('x-api-key')).toBe(false);
    expect(sent.get('content-type')).toBe('application/json');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].input).toBe('http://aquaman.local/slack/services/T/B/x');
    // The proxy adds the real credential; the caller's object is not modified.
    expect(headers.get('authorization')).toBe('Bearer caller-token');
  });

  it('strips authorization and x-api-key from header tuples, whatever their case', async () => {
    await globalThis.fetch('https://api.telegram.org/bot123/sendMessage', {
      headers: [['AUTHORIZATION', 'Bearer caller-token'], ['x-API-key', 'caller-key'], ['Accept', 'application/json']],
    });
    expect(calls[0].init.headers).toEqual([['Accept', 'application/json']]);
  });
});
