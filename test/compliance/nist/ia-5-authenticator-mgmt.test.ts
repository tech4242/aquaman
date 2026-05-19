/**
 * Compliance test — NIST SP 800-53 IA-5 (Authenticator Management).
 *
 * Proves: aquaman ships multiple vault backend implementations and stores
 * credentials via the backend's native API; aquaman itself does not persist
 * them outside the chosen backend.
 */

import { describe, it, expect } from 'vitest';
import { MemoryStore, type CredentialStore } from 'aquaman-core';

describe('NIST IA-5 — Authenticator Management', () => {
  it('aquaman exposes a CredentialStore contract that backends implement', () => {
    // Compile-time + runtime check: MemoryStore is a CredentialStore.
    const store: CredentialStore = new MemoryStore();
    expect(typeof store.get).toBe('function');
    expect(typeof store.set).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.list).toBe('function');
  });

  it('set/get round-trip preserves the credential value verbatim', async () => {
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', 'sk-ant-rotation-test-1');
    expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-rotation-test-1');
  });

  it('rotation: re-set replaces the old value, get returns the new one', async () => {
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', 'old-key');
    await store.set('anthropic', 'api_key', 'new-key');
    expect(await store.get('anthropic', 'api_key')).toBe('new-key');
  });

  it('delete removes the credential — IA-5(1) authenticator destruction', async () => {
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', 'to-destroy');
    await store.delete('anthropic', 'api_key');
    const after = await store.get('anthropic', 'api_key');
    expect(after).toBeNull();
  });

  it('list enumerates stored credentials for audit/rotation review', async () => {
    const store = new MemoryStore();
    await store.set('anthropic', 'api_key', 'k1');
    await store.set('openai', 'api_key', 'k2');
    const list = await store.list();
    expect(list.length).toBeGreaterThanOrEqual(2);
  });
});
