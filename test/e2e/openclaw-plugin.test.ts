/**
 * E2E tests for OpenClaw plugin integration
 *
 * PREREQUISITES:
 * - OpenClaw CLI installed: npm install -g openclaw
 * - Aquaman proxy linked: npm link -w @aquaman/proxy
 * - Plugin installed: cp -r packages/openclaw ~/.openclaw/extensions/aquaman
 *
 * These tests verify the plugin works correctly when loaded by OpenClaw.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Check if OpenClaw is installed
function isOpenClawInstalled(): boolean {
  try {
    execSync('openclaw --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Check if aquaman plugin is loaded
function isPluginLoaded(): boolean {
  try {
    const result = execSync('openclaw plugins list 2>&1', { encoding: 'utf-8' });
    return result.includes('aquaman') && result.includes('loaded');
  } catch {
    return false;
  }
}

const OPENCLAW_AVAILABLE = isOpenClawInstalled();
const PLUGIN_LOADED = OPENCLAW_AVAILABLE && isPluginLoaded();

describe.skipIf(!OPENCLAW_AVAILABLE)('OpenClaw Plugin E2E', () => {
  describe('Plugin Discovery', () => {
    it('OpenClaw discovers the aquaman plugin', () => {
      const result = execSync('openclaw plugins list 2>&1', {
        encoding: 'utf-8'
      });

      expect(result).toContain('aquaman');
      expect(result).toContain('Aquaman');
    });

    it('plugin shows as loaded', () => {
      const result = execSync('openclaw plugins list 2>&1', {
        encoding: 'utf-8'
      });

      // Should show loaded status
      expect(result).toContain('loaded');
      // Should show our description
      expect(result).toContain('credential isolation');
    });

    it('plugin doctor reports no issues', () => {
      const result = execSync('openclaw plugins doctor 2>&1', {
        encoding: 'utf-8'
      });

      expect(result).toContain('No plugin issues detected');
    });
  });

  describe('Plugin Initialization', () => {
    it('detects aquaman CLI when installed', () => {
      const result = execSync('openclaw plugins list 2>&1', {
        encoding: 'utf-8'
      });

      // Should find the CLI (we linked it earlier)
      expect(result).toContain('aquaman CLI found');
    });

    it('sets ANTHROPIC_BASE_URL environment variable', () => {
      const result = execSync('openclaw plugins list 2>&1', {
        encoding: 'utf-8'
      });

      expect(result).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:8081/anthropic');
    });

    it('sets OPENAI_BASE_URL environment variable', () => {
      const result = execSync('openclaw plugins list 2>&1', {
        encoding: 'utf-8'
      });

      expect(result).toContain('OPENAI_BASE_URL=http://127.0.0.1:8081/openai');
    });

    it('registers successfully', () => {
      const result = execSync('openclaw plugins list 2>&1', {
        encoding: 'utf-8'
      });

      expect(result).toContain('Aquaman plugin registered successfully');
    });
  });

  describe('Plugin Structure', () => {
    const pluginPath = path.join(process.env.HOME || '', '.openclaw/extensions/aquaman');

    it('plugin directory exists', () => {
      expect(fs.existsSync(pluginPath)).toBe(true);
    });

    it('has openclaw.plugin.json manifest', () => {
      const manifestPath = path.join(pluginPath, 'openclaw.plugin.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(manifest.id).toBe('aquaman');
      expect(manifest.name).toBe('Aquaman Vault');
    });

    it('has index.ts entry point', () => {
      const indexPath = path.join(pluginPath, 'index.ts');
      expect(fs.existsSync(indexPath)).toBe(true);
    });

    it('entry point exports register function', () => {
      const indexPath = path.join(pluginPath, 'index.ts');
      const content = fs.readFileSync(indexPath, 'utf-8');

      expect(content).toContain('export default function register');
    });
  });
});

describe('Plugin Test Infrastructure', () => {
  it('correctly detects OpenClaw availability', () => {
    console.log(`OpenClaw installed: ${OPENCLAW_AVAILABLE}`);
    console.log(`Plugin loaded: ${PLUGIN_LOADED}`);
    expect(typeof OPENCLAW_AVAILABLE).toBe('boolean');
  });

  it('has correct plugin source structure', () => {
    const pluginSrcPath = path.join(__dirname, '../../packages/openclaw');
    expect(fs.existsSync(pluginSrcPath)).toBe(true);

    // Check required files
    expect(fs.existsSync(path.join(pluginSrcPath, 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(pluginSrcPath, 'openclaw.plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(pluginSrcPath, 'package.json'))).toBe(true);
  });

  it('plugin manifest has correct structure', () => {
    const manifestPath = path.join(__dirname, '../../packages/openclaw/openclaw.plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    expect(manifest.id).toBe('aquaman');
    expect(manifest.name).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(manifest.configSchema).toBeDefined();
    expect(manifest.configSchema.type).toBe('object');
  });

  it('package.json has openclaw extension config', () => {
    const pkgPath = path.join(__dirname, '../../packages/openclaw/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    expect(pkg.openclaw).toBeDefined();
    expect(pkg.openclaw.extensions).toContain('./index.ts');
  });
});
