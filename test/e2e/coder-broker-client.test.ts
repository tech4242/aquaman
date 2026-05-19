/**
 * E2E test — aquaman-coder's BrokerClient against a live aquaman proxy.
 *
 * Boots a real proxy on a temp UDS, runs a real handlePreToolUse
 * dispatch, and asserts the resolved credential matches the vault value.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCredentialProxy, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { BrokerClient, handlePreToolUse } from 'aquaman-coder';
import { tmpSocketPath, cleanupSocket } from '../helpers/uds-proxy.js';

describe('aquaman-coder broker-client E2E', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;
  let tmpDir: string;

  beforeEach(async () => {
    store = new MemoryStore();
    socketPath = tmpSocketPath();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-coder-e2e-'));
    await store.set('anthropic', 'api_key', 'sk-ant-coder-e2e');
    await store.set('github', 'token', 'ghp_coder_e2e_token');
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic', 'github'],
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    store?.clear();
    if (socketPath) cleanupSocket(socketPath);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('health endpoint responds via BrokerClient', async () => {
    const client = new BrokerClient({ socketPath });
    const result = await client.health();
    expect(result.status).toBe('ok');
  });

  it('resolve materializes a credential from the vault', async () => {
    const client = new BrokerClient({ socketPath });
    const result = await client.resolve({ service: 'anthropic', key: 'api_key' });
    expect(result.value).toBe('sk-ant-coder-e2e');
    expect(result.expiresAt).toBeDefined();
  });

  it('resolve throws on missing credential', async () => {
    const client = new BrokerClient({ socketPath });
    await expect(
      client.resolve({ service: 'anthropic', key: 'missing_key' })
    ).rejects.toThrow();
  });

  it('handlePreToolUse end-to-end: rewrites Bash to wrap with aquaman-coder exec', async () => {
    const projectDir = fs.mkdtempSync(path.join(tmpDir, 'app-'));
    const projectsPath = path.join(tmpDir, 'projects.yaml');
    fs.writeFileSync(projectsPath, `projects:
  app:
    paths: ["${projectDir}"]
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
`);
    const client = new BrokerClient({ socketPath });
    const result = await handlePreToolUse(
      { tool_name: 'Bash', tool_input: { command: 'curl https://api.github.com' }, cwd: projectDir },
      { broker: client, projectsPath }
    );
    const out = result?.hookSpecificOutput as any;
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput.command).toContain('aquaman-coder exec --');
    expect(out.updatedInput.command).toContain('curl https://api.github.com');
    expect(out.additionalContext).toContain('ANTHROPIC_API_KEY');
  });

  it('broker error surfaces as a clean message when proxy is down', async () => {
    await proxy.stop();
    const client = new BrokerClient({ socketPath });
    await expect(client.resolve({ service: 'anthropic', key: 'api_key' }))
      .rejects.toThrow(/Cannot reach aquaman proxy/);
  });
});
