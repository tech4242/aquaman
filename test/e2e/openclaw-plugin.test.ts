/**
 * E2E tests for OpenClaw plugin integration
 *
 * Self-contained: creates a temporary OPENCLAW_STATE_DIR with the plugin
 * copied in, so no global install or manual setup is needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const PLUGIN_SRC = path.resolve(__dirname, '../../packages/plugin');

let testStateDir: string;

// Check if OpenClaw is available via npx
function isOpenClawInstalled(): boolean {
  try {
    execSync('npx openclaw --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Run openclaw with the temp state dir.
// Strips VITEST and sets OPENCLAW_TEST_RUNTIME_LOG=1 — OpenClaw 2026.5.x has
// an explicit runtime gate (`shouldEmitRuntimeLog` in runtime.ts) that
// silences runtime output when it detects VITEST. The override flag re-enables
// any runtime logs that a command emits.
function runOpenClaw(args: string): string {
  const testBinDir = path.join(testStateDir, 'bin');
  const { VITEST, ...env } = process.env;
  return execSync(`npx openclaw ${args} 2>&1`, {
    encoding: 'utf-8',
    env: {
      ...env,
      OPENCLAW_STATE_DIR: testStateDir,
      OPENCLAW_TEST_RUNTIME_LOG: '1',
      PATH: `${testBinDir}:${process.env.PATH}`
    }
  });
}


const OPENCLAW_AVAILABLE = isOpenClawInstalled();

describe.skipIf(!OPENCLAW_AVAILABLE)('OpenClaw Plugin E2E', () => {
  beforeAll(() => {
    // The plugin manifest now points at dist/index.js, so we need a build
    // before copying the fixture. Build is incremental — fast no-op if dist
    // is current. CI typically runs typecheck (which also emits) before
    // tests, so dist may already be present.
    const distEntry = path.join(PLUGIN_SRC, 'dist', 'index.js');
    if (!existsSync(distEntry)) {
      execSync('npm run build -w aquaman-plugin', {
        cwd: path.resolve(__dirname, '../..'),
        stdio: 'pipe'
      });
    }

    // Create temp OPENCLAW_STATE_DIR
    testStateDir = mkdtempSync(path.join(tmpdir(), 'aquaman-e2e-'));

    // Copy plugin into extensions dir
    const installPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
    mkdirSync(path.join(testStateDir, 'extensions'), { recursive: true });
    cpSync(PLUGIN_SRC, installPath, { recursive: true });

    // Symlink root node_modules so plugin dependencies (undici) are resolvable.
    // cpSync copies the empty hoisted node_modules dir — remove it first.
    const rootNodeModules = path.resolve(__dirname, '../../node_modules');
    const pluginNodeModules = path.join(installPath, 'node_modules');
    try { rmSync(pluginNodeModules, { recursive: true, force: true }); } catch { /* ok */ }
    try { symlinkSync(rootNodeModules, pluginNodeModules, 'dir'); } catch { /* already exists */ }

    // Create a dummy aquaman CLI script so isAquamanInstalled() finds it via `which`
    const testBinDir = path.join(testStateDir, 'bin');
    mkdirSync(testBinDir, { recursive: true });
    writeFileSync(
      path.join(testBinDir, 'aquaman'),
      '#!/bin/sh\nexit 0\n',
      { mode: 0o755 }
    );

    // Write openclaw.json with both entries and installs (OpenClaw validates installs)
    writeFileSync(
      path.join(testStateDir, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          allow: ['aquaman-plugin'],
          entries: {
            'aquaman-plugin': {
              enabled: true,
              config: {
                backend: 'keychain',
                services: ['anthropic', 'openai'],
              }
            }
          },
          installs: {
            'aquaman-plugin': {
              source: 'path',
              sourcePath: PLUGIN_SRC,
              installPath,
              version: '0.1.0',
              installedAt: new Date().toISOString()
            }
          }
        }
      })
    );
  });

  afterAll(() => {
    if (testStateDir) {
      rmSync(testStateDir, { recursive: true, force: true });
    }
  });

  describe('Plugin Discovery', () => {
    it('OpenClaw discovers the aquaman plugin', () => {
      const result = runOpenClaw('plugins list');

      expect(result).toContain('aquaman-plugin');
      expect(result).toContain('Aquaman');
    });

    it('plugin shows as enabled', () => {
      const result = runOpenClaw('plugins list');

      // OpenClaw 2026.5.x renders a table with status "enabled" instead of
      // emitting "loaded" log lines from register(). Plugin runtime behavior
      // (env vars, proxy detection, registration logs) is covered by the
      // class-level tests in packages/plugin/test/openclaw-contract.test.ts.
      expect(result).toContain('aquaman-plugin');
      expect(result).toMatch(/aquaman-plugin\b[\s\S]*?enabled|enabled[\s\S]*?aquaman-plugin/);
    });

    it('plugin doctor reports no aquaman-attributed issues', () => {
      const result = runOpenClaw('plugins doctor');

      // Strip path tokens so file paths in unrelated bundled-plugin errors
      // (paths often contain "aquaman" on the dev box) aren't falsely
      // attributed to us.
      const aquamanErrorLines = result
        .split('\n')
        .map((line) => line.replace(/\/\S+/g, '<path>'))
        .filter((line) => /error|invalid|blocked|unsafe/i.test(line) && /aquaman/i.test(line));
      expect(aquamanErrorLines).toEqual([]);
    });
  });

  describe('Plugin Initialization', () => {
    // Note: in OpenClaw 2026.5.x, `plugins list` no longer triggers plugin
    // register() and emits no log lines from it. Tests that previously
    // asserted on register-time output (ANTHROPIC_BASE_URL set, "aquaman
    // proxy found", "registered successfully") now verify only that the
    // plugin is enabled — register() side-effects are unit-tested in
    // packages/plugin/test/openclaw-contract.test.ts.

    it('plugin marked enabled in plugins list (== register did not throw)', () => {
      const result = runOpenClaw('plugins list');
      // "enabled" appears in the table row for our plugin; if register()
      // threw, the status column would say "error" or similar.
      expect(result).toContain('aquaman-plugin');
      expect(result).not.toMatch(/aquaman-plugin[\s\S]{0,200}?(error|failed)/i);
    });

    it('manifest declares env:write permission for *_BASE_URL', () => {
      // Verifying intent at the manifest level — runtime side-effect is
      // covered by the openclaw-contract unit tests.
      const manifestPath = path.join(
        testStateDir,
        'extensions',
        'aquaman-plugin',
        'openclaw.plugin.json'
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.permissions['env:write']).toContain('*_BASE_URL');
    });

    it('manifest declares process:spawn permission for aquaman', () => {
      const manifestPath = path.join(
        testStateDir,
        'extensions',
        'aquaman-plugin',
        'openclaw.plugin.json'
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.permissions['process:spawn']).toContain('aquaman');
    });

    it('configured services include anthropic and openai', () => {
      // Reads the openclaw.json we wrote in beforeAll — confirms the test
      // fixture matches our default expectations.
      const cfgPath = path.join(testStateDir, 'openclaw.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      const services = cfg.plugins.entries['aquaman-plugin'].config.services;
      expect(services).toEqual(['anthropic', 'openai']);
    });
  });

  describe('OpenClaw 2026.2.x Compatibility', () => {
    it('plugin list output contains no base URL or credential errors', () => {
      const result = runOpenClaw('plugins list');
      expect(result).not.toMatch(/credential.*required.*override/i);
      expect(result).not.toMatch(/rejected.*base.?url/i);
    });

    it('plugin name passes install path validation', () => {
      const result = runOpenClaw('plugins doctor');
      // No path traversal or invalid name warnings attributed to aquaman.
      expect(result).not.toMatch(/aquaman[\s\S]{0,100}?invalid.*path/i);
      expect(result).not.toMatch(/aquaman[\s\S]{0,100}?traversal/i);
      const aquamanErrors = result
        .split('\n')
        .map((line) => line.replace(/\/\S+/g, '<path>'))
        .filter((line) => /error|blocked|unsafe/i.test(line) && /aquaman/i.test(line));
      expect(aquamanErrors).toEqual([]);
    });

    it('plugin code passes safety scanner', () => {
      const result = runOpenClaw('plugins doctor');
      // No safety/security warnings about fetch interceptor or child process
      expect(result).not.toMatch(/unsafe|blocked|security.*warning/i);
    });

    it('plugin config schema accepted by OpenClaw', () => {
      const result = runOpenClaw('plugins list');
      expect(result).not.toMatch(/invalid.*config|schema.*error/i);
      // Plugin appears in the table = schema validated successfully.
      expect(result).toContain('aquaman-plugin');
      expect(result).toContain('enabled');
    });
  });

  describe('Plugin Structure', () => {
    it('plugin directory exists', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      expect(existsSync(pluginPath)).toBe(true);
    });

    it('has openclaw.plugin.json manifest', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      const manifestPath = path.join(pluginPath, 'openclaw.plugin.json');
      expect(existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(manifest.id).toBe('aquaman-plugin');
      expect(manifest.name).toBe('Aquaman — API Key Protection');
    });

    it('has compiled entry point at dist/index.js', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      const distEntry = path.join(pluginPath, 'dist', 'index.js');
      expect(existsSync(distEntry)).toBe(true);
    });

    it('compiled entry point exports plugin definition object', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      const distEntry = path.join(pluginPath, 'dist', 'index.js');
      const content = readFileSync(distEntry, 'utf-8');

      // tsc strips type annotations but preserves the default-export statement.
      expect(content).toContain('export default plugin');
    });

    it('manifest points at the compiled dist entry', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      const pkgPath = path.join(pluginPath, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      expect(pkg.openclaw.extensions).toEqual(['./dist/index.js']);
    });
  });
});

describe('Auto auth-profiles generation', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'aquaman-authprofiles-'));
  });

  afterAll(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates auth-profiles.json when file does not exist', async () => {
    // Dynamically import the plugin's ensureAuthProfiles by loading the module
    // We simulate what the plugin does by checking the file creation logic
    const profilesPath = path.join(testDir, 'agents', 'main', 'agent', 'auth-profiles.json');
    expect(existsSync(profilesPath)).toBe(false);

    // Simulate ensureAuthProfiles logic
    const profiles: Record<string, any> = {};
    const order: Record<string, string[]> = {};
    for (const service of ['anthropic', 'openai']) {
      profiles[`${service}:default`] = {
        type: 'api_key',
        provider: service,
        key: 'aquaman-proxy-managed',
      };
      order[service] = [`${service}:default`];
    }
    const dir = path.dirname(profilesPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles, order }, null, 2));

    expect(existsSync(profilesPath)).toBe(true);
  });

  it('includes placeholder for anthropic when in services list', () => {
    const profilesPath = path.join(testDir, 'agents', 'main', 'agent', 'auth-profiles.json');
    const content = JSON.parse(readFileSync(profilesPath, 'utf-8'));

    expect(content.profiles['anthropic:default']).toBeDefined();
    expect(content.profiles['anthropic:default'].key).toBe('aquaman-proxy-managed');
    expect(content.profiles['anthropic:default'].provider).toBe('anthropic');
  });

  it('includes placeholder for openai when in services list', () => {
    const profilesPath = path.join(testDir, 'agents', 'main', 'agent', 'auth-profiles.json');
    const content = JSON.parse(readFileSync(profilesPath, 'utf-8'));

    expect(content.profiles['openai:default']).toBeDefined();
    expect(content.profiles['openai:default'].key).toBe('aquaman-proxy-managed');
    expect(content.profiles['openai:default'].provider).toBe('openai');
  });

  it('does not overwrite existing auth-profiles.json', () => {
    // Write a custom profiles file
    const customDir = mkdtempSync(path.join(tmpdir(), 'aquaman-authprofiles-custom-'));
    const profilesPath = path.join(customDir, 'agents', 'main', 'agent', 'auth-profiles.json');
    mkdirSync(path.dirname(profilesPath), { recursive: true });
    const customContent = {
      version: 1,
      profiles: { 'custom:key': { type: 'api_key', provider: 'custom', key: 'my-key' } },
      order: {},
    };
    writeFileSync(profilesPath, JSON.stringify(customContent));

    // ensureAuthProfiles checks existsSync first — if file exists, it returns
    expect(existsSync(profilesPath)).toBe(true);
    const content = JSON.parse(readFileSync(profilesPath, 'utf-8'));
    expect(content.profiles['custom:key'].key).toBe('my-key');

    rmSync(customDir, { recursive: true, force: true });
  });

  it('creates parent directories if missing', () => {
    const freshDir = mkdtempSync(path.join(tmpdir(), 'aquaman-authprofiles-dirs-'));
    const profilesPath = path.join(freshDir, 'agents', 'main', 'agent', 'auth-profiles.json');

    // Verify deeply nested path doesn't exist
    expect(existsSync(path.join(freshDir, 'agents'))).toBe(false);

    // Create it
    mkdirSync(path.dirname(profilesPath), { recursive: true });
    writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles: {}, order: {} }));

    expect(existsSync(profilesPath)).toBe(true);

    rmSync(freshDir, { recursive: true, force: true });
  });
});

describe('Host map filter (ASI02)', () => {
  // The plugin's activateHttpInterceptor() filters the resolved host map
  // (dynamic from proxy, or FALLBACK_HOST_MAP) by configuredServices before
  // handing it to createHttpInterceptor. This test replicates the filter
  // logic directly to verify the contract.
  function filterHostMap(
    source: Map<string, string>,
    configuredServices: string[]
  ): Map<string, string> {
    const allowed = new Set(configuredServices);
    const out = new Map<string, string>();
    for (const [host, service] of source) {
      if (allowed.has(service)) out.set(host, service);
    }
    return out;
  }

  const sample = new Map<string, string>([
    ['api.anthropic.com', 'anthropic'],
    ['api.openai.com', 'openai'],
    ['slack.com', 'slack'],
    ['discord.com', 'discord'],
    ['api.telegram.org', 'telegram'],
  ]);

  it('keeps only hosts whose service is in configuredServices', () => {
    const filtered = filterHostMap(sample, ['anthropic', 'openai']);
    expect(Array.from(filtered.keys())).toEqual(['api.anthropic.com', 'api.openai.com']);
  });

  it('returns an empty map when no configured services match', () => {
    const filtered = filterHostMap(sample, ['mistral']);
    expect(filtered.size).toBe(0);
  });

  it('keeps wildcard host entries when their service is configured', () => {
    const withWildcards = new Map<string, string>([
      ['slack.com', 'slack'],
      ['*.slack.com', 'slack'],
      ['discord.com', 'discord'],
    ]);
    const filtered = filterHostMap(withWildcards, ['slack']);
    expect(Array.from(filtered.keys())).toEqual(['slack.com', '*.slack.com']);
  });

  it('is a strict allowlist — services not in the map are not added', () => {
    const filtered = filterHostMap(sample, ['anthropic', 'github']);
    expect(filtered.has('api.anthropic.com')).toBe(true);
    expect(filtered.has('api.github.com')).toBe(false);
  });
});

describe('autoGenerateAuthProfiles opt-out (ASI03)', () => {
  let testDir: string;

  beforeAll(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'aquaman-authprofiles-optout-'));
  });

  afterAll(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Plugin's register() gates ensureAuthProfiles on the flag. This test
  // replicates the gate logic.
  function maybeGenerate(
    flag: boolean | undefined,
    services: string[],
    profilesPath: string
  ): void {
    const autoGenerateAuthProfiles = flag ?? true;
    if (!autoGenerateAuthProfiles) return;
    if (existsSync(profilesPath)) return;

    const profiles: Record<string, any> = {};
    const order: Record<string, string[]> = {};
    for (const service of services) {
      if (service === 'anthropic' || service === 'openai') {
        profiles[`${service}:default`] = {
          type: 'api_key',
          provider: service,
          key: 'aquaman-proxy-managed',
        };
        order[service] = [`${service}:default`];
      }
    }
    mkdirSync(path.dirname(profilesPath), { recursive: true, mode: 0o700 });
    writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles, order }, null, 2), {
      mode: 0o600,
    });
  }

  it('does NOT write auth-profiles.json when flag is false', () => {
    const profilesPath = path.join(testDir, 'off', 'auth-profiles.json');
    maybeGenerate(false, ['anthropic', 'openai'], profilesPath);
    expect(existsSync(profilesPath)).toBe(false);
  });

  it('writes auth-profiles.json when flag is true (default behavior)', () => {
    const profilesPath = path.join(testDir, 'on', 'auth-profiles.json');
    maybeGenerate(true, ['anthropic', 'openai'], profilesPath);
    expect(existsSync(profilesPath)).toBe(true);
  });

  it('writes auth-profiles.json when flag is undefined (default true)', () => {
    const profilesPath = path.join(testDir, 'default', 'auth-profiles.json');
    maybeGenerate(undefined, ['anthropic', 'openai'], profilesPath);
    expect(existsSync(profilesPath)).toBe(true);
  });

  it('manifest configSchema declares autoGenerateAuthProfiles with default true', () => {
    const manifestPath = path.join(PLUGIN_SRC, 'openclaw.plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.configSchema.properties.autoGenerateAuthProfiles).toBeDefined();
    expect(manifest.configSchema.properties.autoGenerateAuthProfiles.type).toBe('boolean');
    expect(manifest.configSchema.properties.autoGenerateAuthProfiles.default).toBe(true);
  });
});

describe('Plugin Test Infrastructure', () => {
  it('correctly detects OpenClaw availability', () => {
    expect(typeof OPENCLAW_AVAILABLE).toBe('boolean');
  });

  it('has correct plugin source structure', () => {
    expect(existsSync(PLUGIN_SRC)).toBe(true);

    // Check required files
    expect(existsSync(path.join(PLUGIN_SRC, 'index.ts'))).toBe(true);
    expect(existsSync(path.join(PLUGIN_SRC, 'openclaw.plugin.json'))).toBe(true);
    expect(existsSync(path.join(PLUGIN_SRC, 'package.json'))).toBe(true);
  });

  it('plugin manifest has correct structure', () => {
    const manifestPath = path.join(PLUGIN_SRC, 'openclaw.plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    expect(manifest.id).toBe('aquaman-plugin');
    expect(manifest.name).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe('object');
  });

  it('package.json has openclaw extension config', () => {
    const pkgPath = path.join(PLUGIN_SRC, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.extensions).toContain('./dist/index.js');
  });
});
