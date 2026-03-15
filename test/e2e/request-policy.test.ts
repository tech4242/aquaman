/**
 * E2E tests for request-level policy enforcement through the full proxy stack.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCredentialProxy, type CredentialProxy, type PolicyConfig } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import type { RequestInfo } from 'aquaman-proxy';
import { tmpSocketPath, cleanupSocket, udsFetch } from '../helpers/uds-proxy.js';

describe('Request policy enforcement E2E', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let requestLog: RequestInfo[];
  let socketPath: string;

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    store?.clear();
    if (socketPath) cleanupSocket(socketPath);
  });

  async function startProxy(policyConfig?: PolicyConfig) {
    store = new MemoryStore();
    requestLog = [];
    socketPath = tmpSocketPath();

    await store.set('anthropic', 'api_key', 'sk-ant-test-key');
    await store.set('openai', 'api_key', 'sk-openai-test-key');
    await store.set('slack', 'bot_token', 'xoxb-test-token');

    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic', 'openai', 'slack'],
      policyConfig,
      onRequest: (info) => {
        requestLog.push(info);
      }
    });

    await proxy.start();
  }

  it('no policy configured allows all requests (backward compat)', async () => {
    await startProxy(undefined);

    const res = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    // Should reach upstream (will fail with connection error or timeout, not 403)
    expect(res.status).not.toBe(403);
  });

  it('denied request returns 403 with JSON error and fix', async () => {
    const policy: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
      }
    };
    await startProxy(policy);

    const res = await udsFetch(socketPath, '/anthropic/v1/organizations/org123/members', {
      method: 'GET',
    });

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/json');
    const body = JSON.parse(res.body);
    expect(body.error).toContain('denied by policy');
    expect(body.fix).toContain('anthropic');
    expect(body.fix).toContain('config.yaml');
  });

  it('denied request is logged via onRequest with error', async () => {
    const policy: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
      }
    };
    await startProxy(policy);

    await udsFetch(socketPath, '/anthropic/v1/organizations/org123', { method: 'GET' });

    expect(requestLog).toHaveLength(1);
    expect(requestLog[0].statusCode).toBe(403);
    expect(requestLog[0].authenticated).toBe(false);
    expect(requestLog[0].error).toContain('Policy denied');
  });

  it('allowed request proceeds normally', async () => {
    const policy: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
      }
    };
    await startProxy(policy);

    const res = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    // Should NOT be blocked by policy - may fail upstream but not with 403
    expect(res.status).not.toBe(403);
  });

  it('allowedServices 404 takes precedence over policy 403', async () => {
    const policy: PolicyConfig = {
      unknown: {
        defaultAction: 'deny',
        rules: []
      }
    };
    await startProxy(policy);

    // 'unknown' is not in allowedServices, should get 404 not 403
    const res = await udsFetch(socketPath, '/unknown/v1/test', { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('default-deny blocks unmatched requests', async () => {
    const policy: PolicyConfig = {
      anthropic: {
        defaultAction: 'deny',
        rules: [{ method: 'POST', path: '/v1/messages', action: 'allow' }]
      }
    };
    await startProxy(policy);

    // GET /v1/messages doesn't match the POST rule, falls to default deny
    const res = await udsFetch(socketPath, '/anthropic/v1/messages', { method: 'GET' });
    expect(res.status).toBe(403);
  });

  it('default-deny with matching allow rule permits request', async () => {
    const policy: PolicyConfig = {
      anthropic: {
        defaultAction: 'deny',
        rules: [{ method: 'POST', path: '/v1/messages', action: 'allow' }]
      }
    };
    await startProxy(policy);

    const res = await udsFetch(socketPath, '/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });

    // Should pass policy (may fail upstream but not 403)
    expect(res.status).not.toBe(403);
  });

  it('Slack admin methods denied by preset', async () => {
    const policy: PolicyConfig = {
      slack: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/admin.*', action: 'deny' }]
      }
    };
    await startProxy(policy);

    const res = await udsFetch(socketPath, '/slack/admin.users.list', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('Slack normal methods allowed by preset', async () => {
    const policy: PolicyConfig = {
      slack: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/admin.*', action: 'deny' }]
      }
    };
    await startProxy(policy);

    const res = await udsFetch(socketPath, '/slack/auth.test', { method: 'POST' });
    // Not blocked by policy
    expect(res.status).not.toBe(403);
  });

  it('DELETE denied by openai preset', async () => {
    const policy: PolicyConfig = {
      openai: {
        defaultAction: 'allow',
        rules: [
          { method: '*', path: '/v1/organization/**', action: 'deny' },
          { method: 'DELETE', path: '/v1/**', action: 'deny' },
        ]
      }
    };
    await startProxy(policy);

    const res = await udsFetch(socketPath, '/openai/v1/files/file-abc', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});
