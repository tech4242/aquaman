/**
 * Unit tests for the OpenShell credential driver core (v0.17.0).
 *
 * Behavior pinned here was measured against OpenShell 0.1.2 on 2026-10-02:
 * reference handles are aquaman refs (nothing stored), copies live under the
 * gateway-owned `openshell` service, and a handle's meaning comes from its
 * namespace, never from gateway-supplied metadata.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from 'aquaman-core';
import { createBrokerScope } from 'aquaman-proxy';
import {
  createOpenShellDriverCore,
  DriverError,
  CREDENTIALS_CONTRACT,
  type DriverAccessEvent,
} from '../../../packages/proxy/src/openshell/credential-driver.js';

const SECRET = 'sk-ant-openshell-driver-test-0123456789';

describe('OpenShell credential driver core', () => {
  let store: MemoryStore;
  let events: DriverAccessEvent[];
  const scope = createBrokerScope({
    projectsPath: '/nonexistent/projects.yaml',
    allowedRefs: ['aquaman://anthropic/api_key', 'aquaman://github/missing'],
  });
  const core = () => createOpenShellDriverCore({ store, scope, version: '0.17.0-test', onAccess: (e) => events.push(e) });

  beforeEach(async () => {
    store = new MemoryStore();
    await store.set('anthropic', 'api_key', SECRET);
    await store.set('github', 'token', 'ghp_undeclared_0000000000000000000000000000');
    events = [];
  });

  describe('capabilities handshake', () => {
    it('answers protocol 1.0 with the credentials contract', () => {
      const res = core().getCapabilities({ protocol_version: { major: 1, minor: 0 }, required_capabilities: [CREDENTIALS_CONTRACT] }) as any;
      expect(res.extension.protocol_version).toEqual({ major: 1, minor: 0 });
      expect(res.extension.supported_capabilities).toEqual([CREDENTIALS_CONTRACT]);
      expect(res.supports_list).toBe(true);
    });

    it('rejects an incompatible major version or unknown required capabilities', () => {
      expect(() => core().getCapabilities({ protocol_version: { major: 2, minor: 0 } })).toThrow(/protocol 2\.x/);
      expect(() => core().getCapabilities({ protocol_version: { major: 1, minor: 0 }, required_capabilities: [CREDENTIALS_CONTRACT, 'openshell.credentials.rotation'] }))
        .toThrow(/unsupported capabilities: openshell\.credentials\.rotation/);
    });
  });

  describe('reference mode', () => {
    it('stores nothing and returns the ref as the handle, then resolves from the vault', async () => {
      const keysBefore = (await store.list()).length;
      const { handle } = await core().store({ provider: 'claude', credential_key: 'ANTHROPIC_API_KEY', value: 'aquaman://anthropic/api_key', provider_id: 'p1' });
      expect(handle).toEqual({ driver: 'aquaman', handle: 'aquaman://anthropic/api_key', metadata: { mode: 'reference' } });
      expect((await store.list()).length).toBe(keysBefore);

      const [resolved] = await core().resolve([{ request_id: 'r1', provider: 'claude', handle }]);
      expect(resolved).toEqual({ request_id: 'r1', value: SECRET });
    });

    it('refuses an undeclared ref at create time with the allow fix', async () => {
      await expect(core().store({ provider: 'gh', credential_key: 'GITHUB_TOKEN', value: 'aquaman://github/token' }))
        .rejects.toThrow(/aquaman broker allow aquaman:\/\/github\/token/);
      expect(events.at(-1)).toMatchObject({ op: 'store', mode: 'reference', success: false });
    });

    it('refuses a declared ref that is missing from the vault', async () => {
      await expect(core().store({ provider: 'gh', credential_key: 'GITHUB_TOKEN', value: 'aquaman://github/missing' }))
        .rejects.toMatchObject({ code: 'not_found' });
    });

    it('stops resolving once the declaration is revoked', async () => {
      const revoked = createBrokerScope({ projectsPath: '/nonexistent/projects.yaml', allowedRefs: [] });
      const driver = createOpenShellDriverCore({ store, scope: revoked, version: 't' });
      await expect(driver.resolve([{ request_id: 'r', handle: { handle: 'aquaman://anthropic/api_key' } }]))
        .rejects.toMatchObject({ code: 'failed_precondition' });
    });

    it('refuses references when the broker is disabled', async () => {
      const driver = createOpenShellDriverCore({ store, version: 't' });
      await expect(driver.store({ value: 'aquaman://anthropic/api_key' })).rejects.toThrow(/broker is disabled/);
    });

    it('delete is a no-op that never touches the user vault item', async () => {
      await core().delete({ provider: 'claude', handle: { handle: 'aquaman://anthropic/api_key', metadata: { mode: 'reference' } } });
      expect(await store.get('anthropic', 'api_key')).toBe(SECRET);
    });
  });

  describe('copy mode', () => {
    it('writes the submitted value under the openshell service and resolves it', async () => {
      const { handle } = await core().store({ provider: 'echo', credential_key: 'ECHO_KEY', value: 'copied-value-1', provider_id: 'pid-1', object_id: 'obj-1' });
      expect(handle.handle).toBe('aquaman://openshell/obj-1.ECHO_KEY');
      expect(await store.get('openshell', 'obj-1.ECHO_KEY')).toBe('copied-value-1');
      const [r] = await core().resolve([{ request_id: 'x', handle }]);
      expect(r.value).toBe('copied-value-1');
    });

    it('falls back to provider_id when object_id is empty, and delete removes the copy', async () => {
      const { handle } = await core().store({ credential_key: 'K', value: 'v', provider_id: 'pid-2' });
      expect(handle.handle).toBe('aquaman://openshell/pid-2.K');
      await core().delete({ handle });
      expect(await store.get('openshell', 'pid-2.K')).toBeNull();
    });
  });

  describe('handle namespace is authoritative', () => {
    it('a "copy" label on a non-openshell handle does not bypass the scope', async () => {
      await expect(core().resolve([{ request_id: 'r', handle: { handle: 'aquaman://github/token', metadata: { mode: 'copy' } } }]))
        .rejects.toMatchObject({ code: 'failed_precondition' });
    });

    it('a "copy" label on a delete does not delete the user vault item', async () => {
      await core().delete({ handle: { handle: 'aquaman://anthropic/api_key', metadata: { mode: 'copy' } } });
      expect(await store.get('anthropic', 'api_key')).toBe(SECRET);
    });

    it('references into the openshell copy namespace are rejected at create time', async () => {
      await expect(core().store({ value: 'aquaman://openshell/obj-1.ECHO_KEY' })).rejects.toBeInstanceOf(DriverError);
    });

    it('rejects handles that are not aquaman refs', async () => {
      await expect(core().resolve([{ request_id: 'r', handle: { handle: 'vault:secret/x' } }])).rejects.toMatchObject({ code: 'invalid_argument' });
    });
  });

  it('lists declared refs (for when the gateway starts calling ListCredentials)', () => {
    expect(core().list()).toEqual([
      { handle: 'aquaman://anthropic/api_key', keys: ['api_key'], metadata: { source: 'config.yaml', mode: 'reference' } },
      { handle: 'aquaman://github/missing', keys: ['missing'], metadata: { source: 'config.yaml', mode: 'reference' } },
    ]);
  });

  it('audit events never carry a credential value', async () => {
    const d = core();
    const { handle } = await d.store({ provider: 'claude', credential_key: 'K', value: 'aquaman://anthropic/api_key' });
    await d.resolve([{ request_id: 'r', provider: 'claude', handle }]);
    await d.store({ provider: 'echo', credential_key: 'K', value: 'copied-secret-value', provider_id: 'p' });
    await expect(d.store({ value: 'aquaman://github/token' })).rejects.toThrow();
    expect(events.map((e) => e.op)).toEqual(['store', 'resolve', 'store', 'store']);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('copied-secret-value');
  });
});
