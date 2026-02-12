/**
 * Unit tests for the OpenClaw plugin
 *
 * These tests verify the plugin implements the ToolPlugin interface correctly
 * and handles lifecycle events properly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AquamanPlugin } from '../src/plugin.js';
import type { PluginConfig } from '../src/config-schema.js';

// Mock the proxy manager to avoid starting real processes
vi.mock('../src/proxy-manager.js', () => ({
  ProxyManager: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue({
      ready: true,
      socketPath: '/tmp/aquaman-test/proxy.sock',
      services: ['anthropic', 'openai'],
      backend: 'keychain',
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    getSocketPath: vi.fn().mockReturnValue('/tmp/aquaman-test/proxy.sock'),
    getConnectionInfo: vi.fn().mockReturnValue({
      ready: true,
      socketPath: '/tmp/aquaman-test/proxy.sock',
      services: ['anthropic', 'openai'],
      backend: 'keychain',
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined)
  })),
  createProxyManager: vi.fn().mockImplementation((opts) => ({
    start: vi.fn().mockResolvedValue({
      ready: true,
      socketPath: '/tmp/aquaman-test/proxy.sock',
      services: ['anthropic', 'openai'],
      backend: 'keychain',
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    getSocketPath: vi.fn().mockReturnValue('/tmp/aquaman-test/proxy.sock'),
    getConnectionInfo: vi.fn().mockReturnValue({
      ready: true,
      socketPath: '/tmp/aquaman-test/proxy.sock',
      services: ['anthropic', 'openai'],
      backend: 'keychain',
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined)
  }))
}));

describe('AquamanPlugin', () => {
  let plugin: AquamanPlugin;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    plugin = new AquamanPlugin();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('Plugin Interface Compliance', () => {
    it('exports required ToolPlugin properties', () => {
      // OpenClaw expects these properties on a ToolPlugin
      expect(plugin).toHaveProperty('name');
      expect(plugin).toHaveProperty('onLoad');
      expect(plugin).toHaveProperty('onUnload');
      expect(typeof plugin.name).toBe('string');
      expect(typeof plugin.onLoad).toBe('function');
      expect(typeof plugin.onUnload).toBe('function');
    });

    it('has correct plugin name', () => {
      expect(plugin.name).toBe('aquaman-plugin');
    });

    it('onLoad returns void or Promise<void>', async () => {
      const config: PluginConfig = { backend: 'keychain' };
      const result = plugin.onLoad(config);

      // Should be a promise
      expect(result).toBeInstanceOf(Promise);

      // Should resolve without error
      await expect(result).resolves.toBeUndefined();
    });

    it('onUnload returns void or Promise<void>', async () => {
      // First load
      await plugin.onLoad({ backend: 'keychain' });

      const result = plugin.onUnload();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('Proxy Mode', () => {
    it('starts proxy manager on load', async () => {
      const config: PluginConfig = {
        backend: 'keychain',
      };

      await plugin.onLoad(config);

      expect(plugin.isReady()).toBe(true);
    });

    it('sets sentinel hostname base URLs', async () => {
      const config: PluginConfig = {
        backend: 'keychain',
        services: ['anthropic']
      };

      await plugin.onLoad(config);

      const envVars = plugin.getEnvironmentVariables();
      expect(envVars['ANTHROPIC_BASE_URL']).toContain('aquaman.local');
      expect(envVars['ANTHROPIC_BASE_URL']).toContain('/anthropic');
    });

    it('stops proxy manager on unload', async () => {
      await plugin.onLoad({ backend: 'keychain' });
      await plugin.onUnload();

      expect(plugin.isReady()).toBe(false);
    });
  });

  describe('Configuration Validation', () => {
    it('defaults to keychain backend when not specified', async () => {
      await plugin.onLoad({});
      expect(plugin.getBackend()).toBe('keychain');
    });

    it('accepts all valid backend types', async () => {
      const backends = ['keychain', '1password', 'vault', 'encrypted-file'] as const;

      for (const backend of backends) {
        const p = new AquamanPlugin();
        await p.onLoad({ backend });
        expect(p.getBackend()).toBe(backend);
        await p.onUnload();
      }
    });

    it('validates vault configuration requires address', async () => {
      const config: PluginConfig = {
        backend: 'vault'
        // Missing vaultAddress
      };

      // Should either use default or throw a helpful error
      // depending on implementation choice
      await expect(plugin.onLoad(config)).rejects.toThrow(/vault.*address/i);
    });
  });

  describe('Error Handling', () => {
    it('handles load failure gracefully', async () => {
      // Mock a failure scenario
      const { createProxyManager } = await import('../src/proxy-manager.js');
      vi.mocked(createProxyManager).mockImplementationOnce(() => ({
        start: vi.fn().mockRejectedValue(new Error('Socket in use')),
        stop: vi.fn(),
        isRunning: vi.fn().mockReturnValue(false),
        getSocketPath: vi.fn().mockReturnValue(null),
        getConnectionInfo: vi.fn().mockReturnValue(null),
        waitForReady: vi.fn()
      }) as any);

      const p = new AquamanPlugin();

      // Plugin catches the error and logs it, doesn't throw
      await p.onLoad({});
    });

    it('unload is idempotent', async () => {
      await plugin.onLoad({});

      // Multiple unloads should not throw
      await plugin.onUnload();
      await plugin.onUnload();
      await plugin.onUnload();

      expect(plugin.isReady()).toBe(false);
    });
  });

  describe('Slash Commands', () => {
    it('exposes /aquaman status command', () => {
      const commands = plugin.getCommands();
      expect(commands.some(c => c.name === 'status' || c.name === 'aquaman status')).toBe(true);
    });

    it('exposes /aquaman add command', () => {
      const commands = plugin.getCommands();
      expect(commands.some(c => c.name === 'add' || c.name === 'aquaman add')).toBe(true);
    });

    it('exposes /aquaman list command', () => {
      const commands = plugin.getCommands();
      expect(commands.some(c => c.name === 'list' || c.name === 'aquaman list')).toBe(true);
    });
  });
});

describe('Plugin Export Structure', () => {
  it('default export is the plugin class', async () => {
    const module = await import('../src/index.js');
    expect(module.default).toBeDefined();
    expect(module.AquamanPlugin).toBeDefined();
  });

  it('exports config schema for OpenClaw', async () => {
    const module = await import('../src/index.js');
    expect(module.ConfigSchema).toBeDefined();
  });
});
