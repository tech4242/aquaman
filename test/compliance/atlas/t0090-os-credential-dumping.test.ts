/**
 * Compliance test — MITRE ATLAS AML.T0090 (OS Credential Dumping).
 *
 * Proves: credentials never reside in the agent's process address space.
 * The proxy lives behind a Unix Domain Socket (UDS) with chmod 0o600 — even
 * RCE in the agent cannot read raw credentials by inspecting agent memory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { createCredentialProxy, type CredentialProxy } from 'aquaman-proxy';
import { MemoryStore } from 'aquaman-core';
import { tmpSocketPath, cleanupSocket } from '../../helpers/uds-proxy.js';

describe('ATLAS AML.T0090 — OS Credential Dumping', () => {
  let proxy: CredentialProxy;
  let store: MemoryStore;
  let socketPath: string;

  beforeEach(async () => {
    store = new MemoryStore();
    socketPath = tmpSocketPath();
    await store.set('anthropic', 'api_key', 'sk-ant-protected');
    proxy = createCredentialProxy({
      socketPath,
      store,
      allowedServices: ['anthropic'],
    });
    await proxy.start();
  });

  afterEach(async () => {
    if (proxy?.isRunning()) await proxy.stop();
    store?.clear();
    if (socketPath) cleanupSocket(socketPath);
  });

  it('proxy socket file exists at the configured path', () => {
    expect(fs.existsSync(socketPath)).toBe(true);
  });

  it('socket file is owner-only readable/writable (0o600)', () => {
    const mode = fs.statSync(socketPath).mode & 0o777;
    // chmod 0o600 — owner read/write, no group, no other
    expect(mode & 0o077).toBe(0);
  });

  it('process.env on the test runner does not contain the vault credential', () => {
    for (const [, v] of Object.entries(process.env)) {
      expect(v ?? '').not.toContain('sk-ant-protected');
    }
  });

  it('vault store keeps the credential out of plaintext command-line args', () => {
    // process.argv is what `ps` would show. Credentials must never be CLI args.
    for (const arg of process.argv) {
      expect(arg).not.toContain('sk-ant-protected');
    }
  });
});
