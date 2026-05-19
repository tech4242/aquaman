/**
 * Compliance test — MITRE ATLAS AML.T0012 (Valid Accounts).
 *
 * Proves: even with valid credentials available, policy denials block
 * privileged paths *before* credentials are injected.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCredentialProxy, type CredentialProxy, type PolicyConfig } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../../../test/helpers/uds-proxy.js';

describe('ATLAS AML.T0012 — Valid Accounts', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;

  beforeEach(async () => {
    store = new MemoryStore();
    socketPath = tmpSocketPath();
    await store.set('anthropic', 'api_key', 'sk-ant-test-key');

    const policy: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }],
      },
    };

    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic'],
      policyConfig: policy,
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    store?.clear();
    if (socketPath) cleanupSocket(socketPath);
  });

  it('privileged admin path is denied 403 by policy', async () => {
    const res = await udsFetch(socketPath, '/anthropic/v1/organizations/org123/members');
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('denied by policy');
  });

  it('denied request never reaches upstream — error contains policy fix hint', async () => {
    const res = await udsFetch(socketPath, '/anthropic/v1/organizations/org123/api_keys');
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.fix).toBeDefined();
  });

  it('non-privileged path is still allowed (proves policy is targeted, not blanket)', async () => {
    const res = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', max_tokens: 1, messages: [] }),
    });
    expect(res.status).not.toBe(403);
  });
});
