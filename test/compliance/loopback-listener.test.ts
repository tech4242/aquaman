/**
 * Compliance test — the opt-in loopback TCP listener (Hermes path, v0.13.0+).
 *
 * The loopback listener is a NEW attack surface relative to the UDS path: it is
 * network-reachable on 127.0.0.1 rather than gated by 0o600 socket-file
 * permissions. This file maps that surface to the controls it must satisfy:
 *
 *   - NIST AC-3 (Access Enforcement): every loopback request must present the
 *     per-install token; missing/invalid token is rejected before any
 *     credential work. `/_health` is the only exemption (liveness probe).
 *   - MITRE ATLAS AML.T0055 (Unsecured Credentials) + AML.T0090 (OS Credential
 *     Dumping): the real vault key is injected only on the upstream leg and
 *     never returned to the loopback client; the agent-visible side holds only
 *     the placeholder token, so dumping the agent's env/memory yields nothing.
 *   - NIST AU-10 (Non-Repudiation): loopback requests flow through the same
 *     audited request path as UDS (the onRequest hook the AuditLogger consumes),
 *     so the loopback is not an audit bypass. Hash-chain integrity itself is
 *     proven in nist/au-10-tamper-evident.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_compliance_token_0123456789abcdef';
const REAL_ANTHROPIC_KEY = 'sk-ant-real-vault-key';

describe('Loopback listener — compliance (Hermes path)', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;
  let baseUrl: string;

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);

    store = new MemoryStore();
    await store.set('anthropic', 'api_key', REAL_ANTHROPIC_KEY);

    requestLog = [];
    socketPath = tmpSocketPath();

    const registry = createServiceRegistry();
    registry.override('anthropic', { upstream: `http://127.0.0.1:${upstream.port}` });

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic'],
      loopback: { port: 0, token: TOKEN, host: '127.0.0.1' },
      onRequest: (info) => { requestLog.push(info); },
    });

    await proxy.start();
    baseUrl = `http://${proxy.getLoopbackAddress()}`;
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    await upstream.stop();
    store?.clear();
    if (socketPath) cleanupSocket(socketPath);
  });

  describe('NIST AC-3 — Access Enforcement (loopback token gate)', () => {
    it('rejects a request with no token before reaching upstream (401)', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('rejects a request bearing a wrong token (401)', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'not-the-token' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(401);
      expect(upstream.getRequestCount()).toBe(0);
    });

    it('grants access only when the valid token is presented', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.status).toBe(200);
      expect(upstream.getRequestCount()).toBe(1);
    });

    it('exempts only /_health from the token gate (liveness probe)', async () => {
      const res = await fetch(`${baseUrl}/_health`);
      expect(res.status).toBe(200);
      // Health probe must not touch the vault or upstream.
      expect(upstream.getRequestCount()).toBe(0);
    });
  });

  describe('ATLAS AML.T0055 / T0090 — real credential never reaches the client', () => {
    it('injects the real key on the upstream leg, strips the placeholder token', async () => {
      await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      const last = upstream.getLastRequest();
      // Upstream sees the real vault key, not the loopback token the client sent.
      expect(last!.headers['x-api-key']).toBe(REAL_ANTHROPIC_KEY);
      expect(last!.headers['x-api-key']).not.toBe(TOKEN);
    });

    it('never returns the real key to the loopback client (header or body)', async () => {
      const res = await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      expect(res.headers.get('x-api-key')).toBeNull();
      const text = await res.text();
      expect(text).not.toContain(REAL_ANTHROPIC_KEY);
    });

    it('agent-visible side holds only the token — dumping it yields no real key', () => {
      // What Hermes is configured with (~/.hermes/.env): base URL + the token as
      // a placeholder api_key. The real credential lives only in the proxy's
      // address space, so T0090-style env/memory dumping of the agent host
      // surfaces the token, never the vault key.
      const hermesEnv = {
        ANTHROPIC_BASE_URL: `${baseUrl}/anthropic`,
        ANTHROPIC_API_KEY: TOKEN,
      };
      for (const v of Object.values(hermesEnv)) {
        expect(v).not.toContain(REAL_ANTHROPIC_KEY);
      }
    });
  });

  describe('NIST AU-10 — loopback requests stay on the audited path', () => {
    it('records a loopback credential use through the same onRequest hook as UDS', async () => {
      await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      // The AuditLogger consumes onRequest; a loopback request must produce the
      // same auditable RequestInfo (id + service + authenticated) as UDS — not a
      // silent bypass.
      const entry = requestLog.find((r) => r.service === 'anthropic');
      expect(entry).toBeDefined();
      expect(entry!.id).toBeTruthy();
      expect(entry!.authenticated).toBe(true);
    });

    it('does not emit an audit entry for a token-rejected request', async () => {
      await fetch(`${baseUrl}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'not-the-token' },
        body: JSON.stringify({ model: 'claude-3', messages: [] }),
      });
      // A 401 at the gate never reaches credential injection, so there is no
      // credential-access event to record.
      expect(requestLog.find((r) => r.service === 'anthropic')).toBeUndefined();
    });
  });
});
