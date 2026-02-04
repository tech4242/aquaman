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
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isRunning: vi.fn().mockReturnValue(true),
    getPort: vi.fn().mockReturnValue(8081),
    getBaseUrl: vi.fn().mockReturnValue('http://127.0.0.1:8081'),
    waitForReady: vi.fn().mockResolvedValue(undefined)
  }))
}));

// Mock the embedded client
vi.mock('../src/embedded.js', () => ({
  EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getCredential: vi.fn().mockResolvedValue('test-credential'),
    setCredential: vi.fn().mockResolvedValue(undefined),
    listCredentials: vi.fn().mockResolvedValue([]),
    getConfiguredServices: vi.fn().mockReturnValue(['anthropic', 'openai'])
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
      expect(plugin.name).toBe('aquaman');
    });

    it('onLoad returns void or Promise<void>', async () => {
      const config: PluginConfig = { mode: 'embedded', backend: 'keychain' };
      const result = plugin.onLoad(config);

      // Should be a promise
      expect(result).toBeInstanceOf(Promise);

      // Should resolve without error
      await expect(result).resolves.toBeUndefined();
    });

    it('onUnload returns void or Promise<void>', async () => {
      // First load
      await plugin.onLoad({ mode: 'embedded', backend: 'keychain' });

      const result = plugin.onUnload();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('Embedded Mode', () => {
    it('initializes embedded client on load', async () => {
      const config: PluginConfig = {
        mode: 'embedded',
        backend: 'keychain',
        services: ['anthropic', 'openai']
      };

      await plugin.onLoad(config);

      expect(plugin.getMode()).toBe('embedded');
      expect(plugin.isReady()).toBe(true);
    });

    it('sets environment variables for configured services', async () => {
      const config: PluginConfig = {
        mode: 'embedded',
        backend: 'keychain',
        services: ['anthropic', 'openai']
      };

      await plugin.onLoad(config);

      // Plugin should set these for OpenClaw to use
      // In embedded mode, these point to the proxy URLs
      expect(plugin.getEnvironmentVariables()).toHaveProperty('ANTHROPIC_BASE_URL');
      expect(plugin.getEnvironmentVariables()).toHaveProperty('OPENAI_BASE_URL');
    });

    it('cleans up embedded client on unload', async () => {
      await plugin.onLoad({ mode: 'embedded', backend: 'keychain' });
      await plugin.onUnload();

      expect(plugin.isReady()).toBe(false);
    });
  });

  describe('Proxy Mode', () => {
    it('starts proxy manager on load', async () => {
      const config: PluginConfig = {
        mode: 'proxy',
        backend: 'keychain',
        proxyPort: 8081
      };

      await plugin.onLoad(config);

      expect(plugin.getMode()).toBe('proxy');
      expect(plugin.isReady()).toBe(true);
    });

    it('sets correct base URLs for proxy mode', async () => {
      const config: PluginConfig = {
        mode: 'proxy',
        backend: 'keychain',
        proxyPort: 8081,
        services: ['anthropic']
      };

      await plugin.onLoad(config);

      const envVars = plugin.getEnvironmentVariables();
      expect(envVars['ANTHROPIC_BASE_URL']).toContain('8081');
      expect(envVars['ANTHROPIC_BASE_URL']).toContain('/anthropic');
    });

    it('stops proxy manager on unload', async () => {
      await plugin.onLoad({ mode: 'proxy', backend: 'keychain' });
      await plugin.onUnload();

      expect(plugin.isReady()).toBe(false);
    });
  });

  describe('Configuration Validation', () => {
    it('defaults to embedded mode when not specified', async () => {
      await plugin.onLoad({ backend: 'keychain' });
      expect(plugin.getMode()).toBe('embedded');
    });

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
      const { ProxyManager } = await import('../src/proxy-manager.js');
      vi.mocked(ProxyManager).mockImplementationOnce(() => ({
        start: vi.fn().mockRejectedValue(new Error('Port in use')),
        stop: vi.fn(),
        isRunning: vi.fn().mockReturnValue(false),
        getPort: vi.fn(),
        getBaseUrl: vi.fn(),
        waitForReady: vi.fn()
      }));

      const p = new AquamanPlugin();

      await expect(p.onLoad({ mode: 'proxy' })).rejects.toThrow('Port in use');
      expect(p.isReady()).toBe(false);
    });

    it('can be reloaded after failure', async () => {
      // First load fails
      const { ProxyManager } = await import('../src/proxy-manager.js');
      vi.mocked(ProxyManager)
        .mockImplementationOnce(() => ({
          start: vi.fn().mockRejectedValue(new Error('Port in use')),
          stop: vi.fn(),
          isRunning: vi.fn().mockReturnValue(false),
          getPort: vi.fn(),
          getBaseUrl: vi.fn(),
          waitForReady: vi.fn()
        }))
        .mockImplementationOnce(() => ({
          start: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
          isRunning: vi.fn().mockReturnValue(true),
          getPort: vi.fn().mockReturnValue(8081),
          getBaseUrl: vi.fn().mockReturnValue('http://127.0.0.1:8081'),
          waitForReady: vi.fn().mockResolvedValue(undefined)
        }));

      const p = new AquamanPlugin();

      // First attempt fails
      await expect(p.onLoad({ mode: 'proxy' })).rejects.toThrow();

      // Second attempt succeeds
      await expect(p.onLoad({ mode: 'proxy' })).resolves.toBeUndefined();
      expect(p.isReady()).toBe(true);
    });

    it('unload is idempotent', async () => {
      await plugin.onLoad({ mode: 'embedded' });

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
