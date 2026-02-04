/**
 * E2E tests for proxy + audit log integration
 *
 * Verifies that credential access through the proxy can drive
 * audit log entries with hash chain integrity.
 *
 * In production, the CLI's onRequest callback writes to the AuditLogger.
 * This test replicates that pattern.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CredentialProxy, createCredentialProxy, createServiceRegistry } from '@aquaman/proxy';
import { MemoryStore, AuditLogger, createAuditLogger } from '@aquaman/core';
import { MockUpstream, createMockUpstream } from '../helpers/mock-upstream.js';
import type { RequestInfo } from '@aquaman/proxy';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Proxy + Audit Log Integration', () => {
  let proxy: CredentialProxy;
  let upstream: MockUpstream;
  let store: MemoryStore;
  let auditLogger: AuditLogger;
  let proxyPort: number;
  let upstreamPort: number;
  let auditDir: string;

  const TEST_KEY = 'sk-ant-audit-test-key';

  beforeEach(async () => {
    // Create temp dir for audit logs
    auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-audit-test-'));

    // Start mock upstream
    upstream = createMockUpstream();
    await upstream.start(0);
    upstreamPort = upstream.port;

    // Set up credential store
    store = new MemoryStore();
    await store.set('anthropic', 'api_key', TEST_KEY);

    // Set up audit logger
    auditLogger = createAuditLogger({
      logDir: auditDir,
      enabled: true,
      walEnabled: true
    });
    await auditLogger.initialize();

    // Create service registry pointing to mock upstream
    const registry = createServiceRegistry();
    registry.override('anthropic', {
      upstream: `http://127.0.0.1:${upstreamPort}`
    });

    // Start proxy — onRequest callback writes to audit logger
    // This mirrors how the CLI daemon drives audit logging
    proxy = createCredentialProxy({
      port: 0,
      store,
      serviceRegistry: registry,
      allowedServices: ['anthropic'],
      onRequest: (info: RequestInfo) => {
        if (info.authenticated) {
          auditLogger.logCredentialAccess('test-session', 'test-agent', {
            service: info.service,
            operation: 'read',
            success: true
          });
        }
      }
    });

    await proxy.start();
    proxyPort = proxy.getPort();
  });

  afterEach(async () => {
    await proxy?.stop();
    await upstream?.stop();
    fs.rmSync(auditDir, { recursive: true, force: true });
  });

  it('should create a credential_access audit entry when proxy injects credentials', async () => {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] })
    });

    expect(response.ok).toBe(true);

    // Give async audit write a moment
    await new Promise(r => setTimeout(r, 100));

    // Read audit log
    const logPath = path.join(auditDir, 'current.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8');
    const entries = content.trim().split('\n').filter(l => l).map(l => JSON.parse(l));

    const credentialEntries = entries.filter((e: any) => e.type === 'credential_access');
    expect(credentialEntries.length).toBeGreaterThanOrEqual(1);

    const entry = credentialEntries[0];
    expect(entry.data.service).toBe('anthropic');
    expect(entry.data.operation).toBe('read');
    expect(entry.data.success).toBe(true);
  });

  it('should maintain hash chain integrity after multiple requests', async () => {
    for (let i = 0; i < 3; i++) {
      await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [] })
      });
    }

    await new Promise(r => setTimeout(r, 100));

    const result = await auditLogger.verifyIntegrity();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should not create audit entry for unauthenticated requests', async () => {
    // Request to non-existent service — should fail, no credential access
    await fetch(`http://127.0.0.1:${proxyPort}/unknown/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 100));

    const logPath = path.join(auditDir, 'current.jsonl');
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8').trim();
      if (content) {
        const entries = content.split('\n').map(l => JSON.parse(l));
        const credentialEntries = entries.filter((e: any) => e.type === 'credential_access');
        expect(credentialEntries).toHaveLength(0);
      }
    }
  });

  it('should verify upstream received the injected credential', async () => {
    upstream.setExpectedAuth({ header: 'x-api-key', value: TEST_KEY });

    const response = await fetch(`http://127.0.0.1:${proxyPort}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] })
    });

    expect(response.ok).toBe(true);

    const lastReq = upstream.getLastRequest();
    expect(lastReq).toBeDefined();
    expect(lastReq!.headers['x-api-key']).toBe(TEST_KEY);
  });
});
