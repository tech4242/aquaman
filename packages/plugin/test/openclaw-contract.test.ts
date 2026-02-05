/**
 * Contract tests for OpenClaw plugin compatibility
 *
 * These tests verify our plugin meets OpenClaw's ToolPlugin contract.
 * They simulate how OpenClaw loads and interacts with plugins.
 *
 * Reference: OpenClaw plugin documentation and interface definitions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('OpenClaw Plugin Contract', () => {
  describe('package.json manifest', () => {
    let packageJson: Record<string, unknown>;

    beforeEach(async () => {
      const pkgPath = path.join(__dirname, '..', 'package.json');
      packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    });

    it('has openclaw extension config', () => {
      expect(packageJson).toHaveProperty('openclaw');
      const openclawConfig = packageJson.openclaw as Record<string, unknown>;
      expect(openclawConfig).toHaveProperty('extensions');
    });

    it('extensions point to valid JS files', () => {
      const openclawConfig = packageJson.openclaw as Record<string, unknown>;
      const extensions = openclawConfig.extensions as string[];

      expect(Array.isArray(extensions)).toBe(true);
      expect(extensions.length).toBeGreaterThan(0);

      // Each extension should be a relative path to a JS file
      for (const ext of extensions) {
        expect(ext).toMatch(/\.js$/);
        expect(ext.startsWith('./')).toBe(true);
      }
    });

    it('declares tool slot', () => {
      const openclawConfig = packageJson.openclaw as Record<string, unknown>;
      const slots = openclawConfig.slots as string[];

      expect(Array.isArray(slots)).toBe(true);
      expect(slots).toContain('tool');
    });

    it('has configSchema if using TypeBox', () => {
      const openclawConfig = packageJson.openclaw as Record<string, unknown>;

      // configSchema is optional but recommended
      if (openclawConfig.configSchema) {
        expect(openclawConfig.configSchema).toMatch(/\.js$/);
      }
    });

    it('declares openclaw as peer dependency', () => {
      expect(packageJson).toHaveProperty('peerDependencies');
      const peerDeps = packageJson.peerDependencies as Record<string, string>;
      expect(peerDeps).toHaveProperty('openclaw');
    });
  });

  describe('Plugin Entry Point', () => {
    it('exports a class that can be instantiated', async () => {
      const module = await import('../src/index.js');

      // OpenClaw expects either:
      // 1. A default export that is a plugin class
      // 2. A named export matching the plugin name
      expect(module.default || module.AquamanPlugin).toBeDefined();

      const PluginClass = module.default || module.AquamanPlugin;
      const instance = new PluginClass();

      expect(instance).toBeDefined();
    });

    it('plugin instance has required lifecycle methods', async () => {
      const { AquamanPlugin } = await import('../src/index.js');
      const plugin = new AquamanPlugin();

      // Required by OpenClaw ToolPlugin interface
      expect(typeof plugin.onLoad).toBe('function');
      expect(typeof plugin.onUnload).toBe('function');
    });

    it('plugin has a name property', async () => {
      const { AquamanPlugin } = await import('../src/index.js');
      const plugin = new AquamanPlugin();

      expect(plugin.name).toBeDefined();
      expect(typeof plugin.name).toBe('string');
      expect(plugin.name.length).toBeGreaterThan(0);
    });
  });

  describe('Config Schema Contract', () => {
    it('exports a TypeBox schema', async () => {
      const { ConfigSchema } = await import('../src/config-schema.js');

      expect(ConfigSchema).toBeDefined();
      // TypeBox schemas have these properties
      expect(ConfigSchema).toHaveProperty('type');
      expect(ConfigSchema).toHaveProperty('properties');
    });

    it('schema type is object', async () => {
      const { ConfigSchema } = await import('../src/config-schema.js');
      expect(ConfigSchema.type).toBe('object');
    });

    it('schema properties are valid TypeBox types', async () => {
      const { ConfigSchema } = await import('../src/config-schema.js');
      const properties = ConfigSchema.properties;

      // Each property should have a type
      for (const [key, value] of Object.entries(properties)) {
        expect(value).toHaveProperty('type');
      }
    });
  });

  describe('OpenClaw Plugin Loader Simulation', () => {
    /**
     * This simulates how OpenClaw loads plugins:
     * 1. Read package.json to find extensions
     * 2. Import each extension
     * 3. Instantiate the plugin
     * 4. Call onLoad with config
     * 5. Register any commands/tools
     * 6. Call onUnload when shutting down
     */
    it('can be loaded like OpenClaw does', async () => {
      // Step 1: Read package.json
      const pkgPath = path.join(__dirname, '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const openclawConfig = packageJson.openclaw;

      expect(openclawConfig).toBeDefined();

      // Step 2: Import the extension (OpenClaw would resolve the path)
      const module = await import('../src/index.js');

      // Step 3: Instantiate
      const PluginClass = module.default || module.AquamanPlugin;
      const plugin = new PluginClass();

      // Step 4: Call onLoad with config
      // OpenClaw passes the config from openclaw.json
      const mockConfig = {
        mode: 'embedded',
        backend: 'keychain',
        services: ['anthropic']
      };

      // Mock dependencies to avoid real operations
      vi.mock('../src/embedded.js', () => ({
        EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
          initialize: vi.fn().mockResolvedValue(undefined),
          shutdown: vi.fn().mockResolvedValue(undefined),
          getConfiguredServices: vi.fn().mockReturnValue(['anthropic'])
        }))
      }));

      await expect(plugin.onLoad(mockConfig)).resolves.not.toThrow();

      // Step 5: Get commands (OpenClaw would register these)
      if (typeof plugin.getCommands === 'function') {
        const commands = plugin.getCommands();
        expect(Array.isArray(commands)).toBe(true);
      }

      // Step 6: Unload
      await expect(plugin.onUnload()).resolves.not.toThrow();
    });
  });
});

describe('Environment Variable Contract', () => {
  /**
   * OpenClaw expects plugins that modify API routing to set
   * specific environment variables that SDK clients recognize.
   */

  it('sets ANTHROPIC_BASE_URL for Anthropic service', async () => {
    const { AquamanPlugin } = await import('../src/index.js');

    vi.mock('../src/embedded.js', () => ({
      EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getConfiguredServices: vi.fn().mockReturnValue(['anthropic'])
      }))
    }));

    const plugin = new AquamanPlugin();
    await plugin.onLoad({ mode: 'embedded', services: ['anthropic'] });

    const envVars = plugin.getEnvironmentVariables();
    expect(envVars).toHaveProperty('ANTHROPIC_BASE_URL');
    expect(envVars['ANTHROPIC_BASE_URL']).toMatch(/^https?:\/\//);
  });

  it('sets OPENAI_BASE_URL for OpenAI service', async () => {
    const { AquamanPlugin } = await import('../src/index.js');

    vi.mock('../src/embedded.js', () => ({
      EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getConfiguredServices: vi.fn().mockReturnValue(['openai'])
      }))
    }));

    const plugin = new AquamanPlugin();
    await plugin.onLoad({ mode: 'embedded', services: ['openai'] });

    const envVars = plugin.getEnvironmentVariables();
    expect(envVars).toHaveProperty('OPENAI_BASE_URL');
    expect(envVars['OPENAI_BASE_URL']).toMatch(/^https?:\/\//);
  });

  it('sets GITHUB_API_URL for GitHub service', async () => {
    const { AquamanPlugin } = await import('../src/index.js');

    vi.mock('../src/embedded.js', () => ({
      EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getConfiguredServices: vi.fn().mockReturnValue(['github'])
      }))
    }));

    const plugin = new AquamanPlugin();
    await plugin.onLoad({ mode: 'embedded', services: ['github'] });

    const envVars = plugin.getEnvironmentVariables();
    expect(envVars).toHaveProperty('GITHUB_API_URL');
  });
});

describe('Slash Command Contract', () => {
  /**
   * OpenClaw expects commands to have specific structure:
   * - name: string (the command trigger, e.g., "status")
   * - description: string (shown in help)
   * - execute: function (called when command is invoked)
   */

  it('commands have required structure', async () => {
    const { AquamanPlugin } = await import('../src/index.js');

    vi.mock('../src/embedded.js', () => ({
      EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getConfiguredServices: vi.fn().mockReturnValue([])
      }))
    }));

    const plugin = new AquamanPlugin();
    await plugin.onLoad({ mode: 'embedded' });

    const commands = plugin.getCommands();

    for (const cmd of commands) {
      expect(cmd).toHaveProperty('name');
      expect(typeof cmd.name).toBe('string');

      expect(cmd).toHaveProperty('description');
      expect(typeof cmd.description).toBe('string');

      expect(cmd).toHaveProperty('execute');
      expect(typeof cmd.execute).toBe('function');
    }
  });

  it('command execute returns string or object', async () => {
    const { AquamanPlugin } = await import('../src/index.js');

    vi.mock('../src/embedded.js', () => ({
      EmbeddedCredentialClient: vi.fn().mockImplementation(() => ({
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        listCredentials: vi.fn().mockResolvedValue([]),
        getConfiguredServices: vi.fn().mockReturnValue([])
      }))
    }));

    const plugin = new AquamanPlugin();
    await plugin.onLoad({ mode: 'embedded' });

    const commands = plugin.getCommands();
    const statusCmd = commands.find(c => c.name === 'status');

    if (statusCmd) {
      const result = await statusCmd.execute({});
      expect(['string', 'object']).toContain(typeof result);
    }
  });
});
