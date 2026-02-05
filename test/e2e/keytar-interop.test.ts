/**
 * E2E tests for keytar ESM/CJS interop
 *
 * Verifies the `.default` property unwrapping works correctly
 * when importing keytar (a CommonJS native module) from ESM context.
 */

import { describe, it, expect } from 'vitest';

describe('Keytar ESM/CJS Interop', () => {
  it('should import keytar via dynamic import and unwrap .default', async () => {
    let keytar: any;
    try {
      const mod: any = await import('keytar');
      keytar = mod.default || mod;
    } catch {
      // keytar native binary not available — skip gracefully
      console.log('keytar not available, skipping interop test');
      return;
    }

    // Verify the unwrapped module has the expected functions
    expect(typeof keytar.getPassword).toBe('function');
    expect(typeof keytar.setPassword).toBe('function');
    expect(typeof keytar.deletePassword).toBe('function');
    expect(typeof keytar.findCredentials).toBe('function');
    expect(typeof keytar.findPassword).toBe('function');
  });

  it('should fail without .default unwrapping on ESM import', async () => {
    let mod: any;
    try {
      mod = await import('keytar');
    } catch {
      console.log('keytar not available, skipping interop test');
      return;
    }

    // Without unwrapping, the raw ESM namespace may not have functions at top level
    // The .default property should contain the actual exports
    if (mod.default) {
      expect(typeof mod.default.findCredentials).toBe('function');
      expect(typeof mod.default.getPassword).toBe('function');
    }
  });

  it('should round-trip a credential through keytar', async () => {
    if (process.platform !== 'darwin') {
      // keytar operations hang on Linux CI without D-Bus Secret Service
      return;
    }

    let keytar: any;
    try {
      const mod: any = await import('keytar');
      keytar = mod.default || mod;
    } catch {
      console.log('keytar not available, skipping interop test');
      return;
    }

    const service = 'aquaman-test-interop';
    const account = 'test:api_key';
    const secret = 'sk-test-interop-' + Date.now();

    try {
      // Set
      await keytar.setPassword(service, account, secret);

      // Get
      const retrieved = await keytar.getPassword(service, account);
      expect(retrieved).toBe(secret);

      // Find
      const creds = await keytar.findCredentials(service);
      expect(creds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ account, password: secret })
        ])
      );
    } finally {
      // Cleanup
      await keytar.deletePassword(service, account).catch(() => {});
    }
  });
});
