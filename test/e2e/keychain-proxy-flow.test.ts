/**
 * E2E tests for keychain-backed credential proxy flow.
 *
 * Verifies that credentials stored in the macOS Keychain are correctly
 * retrieved and injected into upstream requests by the proxy.
 *
 * Safety:
 * - Uses service name 'aquaman-test-e2e' (NOT 'aquaman') so tests never
 *   read/write/delete production credentials.
 * - All upstream requests go to a mock localhost server, never real APIs.
 * - Tests are skipped when keytar is unavailable (Linux CI, missing binary).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from 'aquaman-proxy';
import type { CredentialStore } from 'aquaman-core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from 'aquaman-proxy';

// Check if keytar is available before defining tests
let keychainAvailable = false;
let keytar: any;
if (process.platform === 'darwin') {
  try {
    const mod: any = await import('keytar');
    keytar = mod.default || mod;
    keychainAvailable = typeof keytar.getPassword === 'function';
  } catch {
    keychainAvailable = false;
  }
}

/**
 * Thin CredentialStore wrapper around keytar using a test-only service name.
 * This ensures tests never touch the production 'aquaman' keychain entries.
 */
class TestKeychainStore implements CredentialStore {
  private kt: any;
  private readonly servicePrefix = 'aquaman-test-e2e';
  private readonly indexService = 'aquaman-test-e2e/_index';
  private readonly indexAccount = 'services';

  constructor(keytarModule: any) {
    this.kt = keytarModule;
  }

  private getServiceName(service: string): string {
    return `${this.servicePrefix}/${service}`;
  }

  private async getIndex(): Promise<string[]> {
    const raw = await this.kt.getPassword(this.indexService, this.indexAccount);
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
  }

  private async updateIndex(services: string[]): Promise<void> {
    await this.kt.setPassword(this.indexService, this.indexAccount, JSON.stringify(services));
  }

  async get(service: string, key: string): Promise<string | null> {
    return this.kt.getPassword(this.getServiceName(service), key);
  }

  async set(service: string, key: string, value: string): Promise<void> {
    await this.kt.setPassword(this.getServiceName(service), key, value);

    const index = await this.getIndex();
    if (!index.includes(service)) {
      index.push(service);
      await this.updateIndex(index);
    }
  }

  async delete(service: string, key: string): Promise<boolean> {
    const deleted = await this.kt.deletePassword(this.getServiceName(service), key);

    if (deleted) {
      const remaining = await this.kt.findCredentials(this.getServiceName(service));
      if (remaining.length === 0) {
        const index = await this.getIndex();
        const updated = index.filter((s: string) => s !== service);
        await this.updateIndex(updated);
      }
    }

    return deleted;
  }

  async list(): Promise<Array<{ service: string; key: string }>> {
    const index = await this.getIndex();
    const results: Array<{ service: string; key: string }> = [];

    for (const service of index) {
      const creds = await this.kt.findCredentials(this.getServiceName(service));
      for (const cred of creds) {
        results.push({ service, key: cred.account });
      }
    }

    return results;
  }

  async exists(service: string, key: string): Promise<boolean> {
    const val = await this.get(service, key);
    return val !== null;
  }

  /** Clean up all test entries from the keychain */
  async cleanup(): Promise<void> {
    const index = await this.getIndex();
    for (const service of index) {
      const creds = await this.kt.findCredentials(this.getServiceName(service));
      for (const c of creds) {
        await this.kt.deletePassword(this.getServiceName(service), c.account).catch(() => {});
      }
    }
    // Clean up the index entry itself
    await this.kt.deletePassword(this.indexService, this.indexAccount).catch(() => {});
  }
}

// Test credentials (fake values, never leave localhost)
const TEST_ANTHROPIC_KEY = 'sk-ant-keychain-test-' + Date.now();
const TEST_TWILIO_SID = 'AC-keychain-test-sid';
const TEST_TWILIO_TOKEN = 'keychain-test-auth-token';

describe.skipIf(!keychainAvailable)('Keychain Proxy Flow E2E', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: TestKeychainStore;
  let requestLog: RequestInfo[];
  let proxyPort: number;

  beforeEach(async () => {
    upstream = createMockUpstream();
    await upstream.start(0);

    store = new TestKeychainStore(keytar);

    // Store test credentials in keychain under 'aquaman-test-e2e'
    await store.set('anthropic', 'api_key', TEST_ANTHROPIC_KEY);

    requestLog = [];

    const registry = createServiceRegistry();
    registry.override('anthropic', {
      upstream: `http://127.0.0.1:${upstream.port}`,
    });
    registry.override('twilio', {
      upstream: `http://127.0.0.1:${upstream.port}`,
    });

    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic', 'twilio'],
      onRequest: (info) => requestLog.push(info),
    });

    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy.stop();
    await upstream.stop();
    // Always clean up test keychain entries
    await store.cleanup();
  });

  it('injects credential from macOS Keychain into upstream request', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
    });

    expect(response.ok).toBe(true);

    const lastRequest = upstream.getLastRequest();
    expect(lastRequest).toBeDefined();
    expect(lastRequest!.headers['x-api-key']).toBe(TEST_ANTHROPIC_KEY);
  });

  it('returns 401 when keychain credential is missing', async () => {
    // Delete the credential we stored in beforeEach
    await store.delete('anthropic', 'api_key');

    const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [] }),
    });

    expect(response.status).toBe(401);
  });

  it('handles basic auth through keychain (Twilio)', async () => {
    await store.set('twilio', 'account_sid', TEST_TWILIO_SID);
    await store.set('twilio', 'auth_token', TEST_TWILIO_TOKEN);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/twilio/2010-04-01/Accounts`, {
      method: 'GET',
    });

    expect(response.ok).toBe(true);

    const lastRequest = upstream.getLastRequest();
    expect(lastRequest).toBeDefined();

    const expectedBasic = Buffer.from(`${TEST_TWILIO_SID}:${TEST_TWILIO_TOKEN}`).toString('base64');
    expect(lastRequest!.headers['authorization']).toBe(`Basic ${expectedBasic}`);
  });
});
