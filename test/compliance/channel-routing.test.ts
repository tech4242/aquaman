/**
 * Compliance test — channel egress routing (OpenClaw path, v0.15.0+).
 *
 * Until v0.15.0 a channel token lived in the vault but was USED from
 * openclaw.json: OpenClaw builds a per-channel undici dispatcher, so the
 * plugin's `globalThis.fetch` interceptor never saw the traffic. Storage was
 * covered, egress was not, and nothing was audited. Routing Telegram through
 * the loopback listener closes that, and this file pins the properties the
 * fix has to keep:
 *
 *   - MITRE ATLAS AML.T0055 (Unsecured Credentials): the agent-readable
 *     config holds the loopback token, never the bot token. Reading
 *     openclaw.json yields nothing that works against Telegram.
 *   - MITRE ATLAS AML.T0090 (OS Credential Dumping): the real token appears
 *     only on the upstream leg and is never echoed back to the caller.
 *   - NIST AC-3 (Access Enforcement): the Bot API sends no auth header, so the
 *     token gate has to read the path segment. A wrong one is rejected before
 *     the vault is touched.
 *   - NIST AU-2 (Event Logging): channel egress produces an audit event. This
 *     is the control that was silently unmet before routing existed.
 *   - NIST SI-10 (Information Input Validation): a stored token that would
 *     inject extra path segments is refused rather than redirecting the
 *     request somewhere the service definition never named.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry, wireChannelRouting } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import { tmpSocketPath, cleanupSocket } from '../helpers/uds-proxy.js';

const TOKEN = 'aqm_lb_channel_compliance_token_0123456789';
const REAL_BOT_TOKEN = '555666:REAL-vault-bot-token';

describe('Channel egress routing — compliance (OpenClaw path)', () => {
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
    await store.set('telegram', 'bot_token', REAL_BOT_TOKEN);

    requestLog = [];
    socketPath = tmpSocketPath();

    const registry = createServiceRegistry();
    registry.override('telegram', { upstream: `http://127.0.0.1:${upstream.port}` });

    proxy = createCredentialProxy({
      socketPath,
      store,
      serviceRegistry: registry,
      allowedServices: ['telegram'],
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

  describe('ATLAS AML.T0055 — the host config holds no usable credential', () => {
    it('writes the loopback token, not the bot token, into openclaw.json', () => {
      const openclawConfig: Record<string, any> = {
        channels: { telegram: { enabled: true, botToken: REAL_BOT_TOKEN } }
      };

      wireChannelRouting(openclawConfig, {
        loopbackOrigin: `http://${proxy.getLoopbackAddress()}`,
        loopbackToken: TOKEN,
        hasVaultCredential: () => true
      });

      const serialized = JSON.stringify(openclawConfig);
      expect(serialized).not.toContain(REAL_BOT_TOKEN);
      expect(openclawConfig.channels.telegram.botToken).toBe(TOKEN);
    });

    it('leaves a token that reaches the vendor only through the proxy', async () => {
      // The loopback token read out of openclaw.json is useless against the
      // real Bot API: it is not a bot token, only a capability to reach us.
      const response = await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);
      expect(response.status).toBe(200);

      const forwarded = upstream.getLastRequest()!;
      expect(forwarded.path).toContain(REAL_BOT_TOKEN);
      expect(forwarded.path).not.toContain(TOKEN);
    });
  });

  describe('ATLAS AML.T0090 — the real token is never returned to the caller', () => {
    it('keeps the bot token out of the response body and headers', async () => {
      const response = await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);
      const body = await response.text();

      expect(body).not.toContain(REAL_BOT_TOKEN);
      expect(JSON.stringify([...response.headers])).not.toContain(REAL_BOT_TOKEN);
    });

    it('keeps the bot token out of the observable request log', async () => {
      await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);

      const logged = JSON.stringify(requestLog);
      expect(logged).not.toContain(REAL_BOT_TOKEN);
      expect(logged).not.toContain(TOKEN);
    });
  });

  describe('NIST AC-3 — the path segment is the token gate', () => {
    it('rejects a wrong path-borne token without consulting the vault', async () => {
      const response = await fetch(`${baseUrl}/telegram/botnot-the-token/getMe`);

      expect(response.status).toBe(401);
      expect(upstream.getLastRequest()).toBeUndefined();
      // Rejected at the gate: no credential work, so nothing to audit as use.
      expect(requestLog).toHaveLength(0);
    });

    it('does not accept a path segment in place of a header on header services', async () => {
      const registry = createServiceRegistry();
      registry.override('slack', { upstream: `http://127.0.0.1:${upstream.port}` });
      await store.set('slack', 'bot_token', 'xoxb-real');

      // slack is header-auth: the segment is not a credential position, so the
      // same trick must not authenticate.
      const response = await fetch(`${baseUrl}/slack/bot${TOKEN}/api/auth.test`);
      expect(response.status).toBe(401);
    });
  });

  describe('NIST AU-2 — channel egress is audited', () => {
    it('emits one audit event per channel request', async () => {
      await fetch(`${baseUrl}/telegram/bot${TOKEN}/sendMessage`, { method: 'POST' });
      await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);

      const telegramEvents = requestLog.filter(r => r.service === 'telegram');
      expect(telegramEvents).toHaveLength(2);
      expect(telegramEvents.every(e => e.authenticated)).toBe(true);
      expect(telegramEvents.map(e => e.path)).toEqual(['/telegram/sendMessage', '/telegram/getMe']);
    });

    it('records a missing channel credential as a failure', async () => {
      store.clear();

      const response = await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);

      expect(response.status).toBe(401);
      expect(requestLog.at(-1)!.error).toBeTruthy();
      expect(requestLog.at(-1)!.authenticated).toBe(false);
    });
  });

  describe('NIST SI-10 — stored credentials are validated before use', () => {
    it('refuses a token that would inject extra path segments', async () => {
      await store.set('telegram', 'bot_token', '555666:tok/../anthropic');

      const response = await fetch(`${baseUrl}/telegram/bot${TOKEN}/getMe`);

      expect(response.status).toBe(500);
      expect(upstream.getLastRequest()).toBeUndefined();
      expect(requestLog.at(-1)!.error).toContain('slash');
    });
  });
});
