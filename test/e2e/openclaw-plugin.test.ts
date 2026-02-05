/**
 * E2E tests for OpenClaw plugin integration
 *
 * Self-contained: creates a temporary OPENCLAW_STATE_DIR with the plugin
 * copied in, so no global install or manual setup is needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const PLUGIN_SRC = path.resolve(__dirname, '../../packages/openclaw');

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

// Run openclaw with the temp state dir
function runOpenClaw(args: string): string {
  return execSync(`npx openclaw ${args} 2>&1`, {
    encoding: 'utf-8',
    env: { ...process.env, OPENCLAW_STATE_DIR: testStateDir }
  });
}

const OPENCLAW_AVAILABLE = isOpenClawInstalled();

describe.skipIf(!OPENCLAW_AVAILABLE)('OpenClaw Plugin E2E', () => {
  beforeAll(() => {
    // Create temp OPENCLAW_STATE_DIR
    testStateDir = mkdtempSync(path.join(tmpdir(), 'aquaman-e2e-'));

    // Copy plugin into extensions dir
    const installPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
    mkdirSync(path.join(testStateDir, 'extensions'), { recursive: true });
    cpSync(PLUGIN_SRC, installPath, { recursive: true });

    // Write openclaw.json with both entries and installs (OpenClaw validates installs)
    writeFileSync(
      path.join(testStateDir, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          entries: {
            'aquaman-plugin': {
              enabled: true,
              config: {
                mode: 'proxy',
                backend: 'keychain',
                services: ['anthropic', 'openai'],
                proxyPort: 8081
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

    it('plugin shows as loaded', () => {
      const result = runOpenClaw('plugins list');

      // Should show loaded status
      expect(result).toContain('loaded');
      // Should show our description
      expect(result).toContain('credential isolation');
    });

    it('plugin doctor reports no issues', () => {
      const result = runOpenClaw('plugins doctor');

      expect(result).toContain('No plugin issues detected');
    });
  });

  describe('Plugin Initialization', () => {
    it('detects aquaman CLI when installed', () => {
      const result = runOpenClaw('plugins list');

      // Should find the CLI (we linked it earlier)
      expect(result).toContain('aquaman CLI found');
    });

    it('sets ANTHROPIC_BASE_URL environment variable', () => {
      const result = runOpenClaw('plugins list');

      expect(result).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic');
    });

    it('sets OPENAI_BASE_URL environment variable', () => {
      const result = runOpenClaw('plugins list');

      expect(result).toContain('OPENAI_BASE_URL=http://127.0.0.1:8081/openai');
    });

    it('registers successfully', () => {
      const result = runOpenClaw('plugins list');

      expect(result).toContain('Aquaman plugin registered successfully');
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
      expect(manifest.name).toBe('Aquaman Vault');
    });

    it('has index.ts entry point', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      const indexPath = path.join(pluginPath, 'index.ts');
      expect(existsSync(indexPath)).toBe(true);
    });

    it('entry point exports register function', () => {
      const pluginPath = path.join(testStateDir, 'extensions', 'aquaman-plugin');
      const indexPath = path.join(pluginPath, 'index.ts');
      const content = readFileSync(indexPath, 'utf-8');

      expect(content).toContain('export default function register');
    });
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
    expect(pkg.openclaw.extensions).toContain('./index.ts');
  });
});
