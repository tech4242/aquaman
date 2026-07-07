/**
 * Compliance test — the daemon's TTL'd credential cache (v0.13.1+).
 *
 * The CachingStore extends how LONG a credential resides in the proxy's
 * memory (per-request transit → TTL-bounded residency) without moving the
 * isolation boundary. This file pins the control claims that extension must
 * not disturb:
 *
 *   - NIST AU-2 (Audit Events): audit is emitted per REQUEST, not per backend
 *     fetch — a cache hit still produces an audit event, so the cache is not
 *     an audit bypass. (Hash-chain integrity: nist/au-10-tamper-evident.)
 *   - NIST AC-3 (Access Enforcement): policy denial happens BEFORE credential
 *     work — a denied request neither hits the backend nor populates the
 *     cache, cached or not.
 *   - NIST SC-28 (Protection at Rest): the cache is memory-only. The module
 *     performs no filesystem or process I/O at all (static assertion), and
 *     serving from cache creates no files.
 *   - MITRE ATLAS AML.T0055/T0090: the real key is injected only on the
 *     upstream leg and never reaches the client — identically on cold and
 *     cached paths. IA-5: writes go through to the vault backend and
 *     invalidate, so rotation via aquaman is visible immediately.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore, CachingStore, wrapWithCache } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';
import { CountingStore } from '../helpers/counting-store.js';

const REAL_KEY = 'sk-ant-real-vault-key-cache-compliance';

describe('Credential cache — compliance (v0.13.1+)', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let memory: MemoryStore;
  let counting: CountingStore;
  let cached: CachingStore;
  let requestLog: RequestInfo[];
  let socketPath: string;

  async function startProxy(store: CachingStore | CountingStore, policyConfig?: any) {
    const registry = createServiceRegistry();
    registry.override('anthropic', { upstream: `http://127.0.0.1:${upstream.port}` });

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic'],
      policyConfig,
      onRequest: (info) => { requestLog.push(info); },
    });
    await proxy.start();
  }

  const proxiedRequest = () => udsFetch(socketPath, '/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-3', messages: [] }),
  });

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);

    memory = new MemoryStore();
    await memory.set('anthropic', 'api_key', REAL_KEY);
    counting = new CountingStore(memory);
    cached = new CachingStore(counting, 900);

    requestLog = [];
    socketPath = tmpSocketPath();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    memory.clear();
    if (socketPath) cleanupSocket(socketPath);
  });

  describe('NIST AU-2 — cache hits stay on the audited path', () => {
    it('N proxied requests produce N audit events but one backend fetch', async () => {
      await startProxy(cached);
      for (let i = 0; i < 3; i++) {
        expect((await proxiedRequest()).status).toBe(200);
      }
      expect(requestLog).toHaveLength(3);
      expect(requestLog.every(r => r.service === 'anthropic' && r.authenticated)).toBe(true);
      expect(counting.gets).toBe(1);
      expect(upstream.getRequestCount()).toBe(3); // every request still forwarded + audited
    });

    it('broker resolves are audited per call while sharing the cache', async () => {
      await startProxy(cached);
      const resolveOnce = () => udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key' }),
      });
      const first = await resolveOnce();
      const second = await resolveOnce();
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body).value).toBe(REAL_KEY);
      expect(counting.gets).toBe(1); // second resolve served from cache
      expect(requestLog.filter(r => r.method === 'BROKER')).toHaveLength(2);
    });

    it('proxied requests and broker resolves share one cache entry (one prompt per TTL, total)', async () => {
      await startProxy(cached);
      await proxiedRequest();
      const res = await udsFetch(socketPath, '/broker/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: 'anthropic', key: 'api_key' }),
      });
      expect(res.status).toBe(200);
      expect(counting.gets).toBe(1);
    });
  });

  describe('NIST AC-3 — policy denial precedes the cache', () => {
    it('a denied request neither hits the backend nor populates the cache', async () => {
      await startProxy(cached, { anthropic: { defaultAction: 'deny', rules: [] } });
      const res = await proxiedRequest();
      expect(res.status).toBe(403);
      expect(counting.gets).toBe(0);
      expect(upstream.getRequestCount()).toBe(0);
    });
  });

  describe('NIST SC-28 — the cache is memory-only', () => {
    it('the CachingStore module performs no filesystem or process I/O', () => {
      const testDir = path.dirname(fileURLToPath(import.meta.url));
      const src = fs.readFileSync(
        path.resolve(testDir, '../../packages/proxy/src/core/credentials/caching-store.ts'),
        'utf-8'
      );
      // The module may only import the CredentialStore type — no node builtins
      // (fs, child_process, net, http, ...), so it cannot persist or transmit.
      const imports = src.split('\n').filter(l => /^\s*import\b/.test(l));
      expect(imports).toHaveLength(1);
      expect(imports[0]).toContain("from './store.js'");
      expect(src).not.toMatch(/\brequire\s*\(/);
      expect(src).not.toContain('writeFile');
    });

    it('serving cached requests creates no files', async () => {
      await startProxy(cached);
      const dir = path.dirname(socketPath);
      const before = fs.readdirSync(dir).sort();
      for (let i = 0; i < 3; i++) await proxiedRequest();
      expect(fs.readdirSync(dir).sort()).toEqual(before);
    });
  });

  describe('ATLAS AML.T0055 / T0090 — isolation is unchanged on the cached path', () => {
    it('injects the real key upstream on both cold and cached requests', async () => {
      await startProxy(cached);
      await proxiedRequest(); // cold
      await proxiedRequest(); // cached
      const reqs = upstream.requests;
      expect(reqs).toHaveLength(2);
      for (const r of reqs) {
        expect(r.headers['x-api-key']).toBe(REAL_KEY);
      }
      expect(counting.gets).toBe(1);
    });

    it('never returns the real key to the client, cached or not', async () => {
      await startProxy(cached);
      for (let i = 0; i < 2; i++) {
        const res = await proxiedRequest();
        expect(res.headers['x-api-key']).toBeUndefined();
        expect(res.body).not.toContain(REAL_KEY);
      }
    });
  });

  describe('IA-5 — rotation through aquaman is visible immediately', () => {
    it('set() through the cached store invalidates — the next request injects the NEW key without waiting for the TTL', async () => {
      await startProxy(cached);
      await proxiedRequest();
      expect(upstream.getLastRequest()!.headers['x-api-key']).toBe(REAL_KEY);

      await cached.set('anthropic', 'api_key', 'sk-ant-rotated');
      await proxiedRequest();
      expect(upstream.getLastRequest()!.headers['x-api-key']).toBe('sk-ant-rotated');
    });
  });

  describe('disabled cache (ttl=0) behaves identically minus the caching', () => {
    it('wrapWithCache(store, 0) hits the backend on every request', async () => {
      const passthrough = wrapWithCache(counting, 0);
      expect(passthrough).toBe(counting);
      await startProxy(counting);
      await proxiedRequest();
      await proxiedRequest();
      expect(counting.gets).toBe(2);
      expect(upstream.getRequestCount()).toBe(2);
      expect(requestLog).toHaveLength(2);
    });
  });
});
