/**
 * The Vault backend refuses a link to an item aquaman wrote itself, whatever
 * way the mount path is spelled in the config.
 */
import { describe, it, expect } from 'vitest';
import { VaultStore } from '../../packages/proxy/src/core/credentials/backends/vault.js';
import { parseLocator } from '../../packages/proxy/src/core/credentials/links.js';

describe('VaultStore.readLinked: an item under aquaman\'s own prefix', () => {
  const locator = (text: string) => {
    const r = parseLocator(text);
    if (!r.ok) throw new Error(r.error);
    return r.locator;
  };

  it.each([
    ['secret'],
    ['secret/'],
    ['/secret'],
    ['/secret/'],
    ['secret//'],
  ])('mount path %j: a credential aquaman stored and the audit anchor are both refused', async (mountPath) => {
    const store = new VaultStore({ address: 'http://127.0.0.1:1', token: 't', mountPath });
    expect(store.getMountPath()).toBe('secret');
    for (const text of [
      'vault://secret/aquaman/anthropic/api_key#credential',
      'vault://secret/aquaman/aquaman_internal/audit_anchor#credential',
    ]) {
      await expect(store.readLinked(locator(text))).rejects.toThrow(/aquaman itself wrote/);
    }
  });

  it('a mount with two parts is compared part by part', async () => {
    const store = new VaultStore({ address: 'http://127.0.0.1:1', token: 't', mountPath: 'team/kv/' });
    expect(store.getMountPath()).toBe('team/kv');
    await expect(store.readLinked(locator('vault://team%2Fkv/aquaman/github/token#credential'))).rejects.toThrow(/aquaman itself wrote/);
  });
});
