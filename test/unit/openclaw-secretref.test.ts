/**
 * Unit tests for the OpenClaw SecretRef provider integration (v0.14.0+).
 *
 * Covers:
 *   - the version gate (SecretRef available >= 2026.6.5)
 *   - openclaw.json wiring: idempotent merge, user-value preservation,
 *     legacy-placeholder upgrade, status reporting
 *   - the exec resolver script's protocol (spawned the way the gateway
 *     spawns it: `${node} ./dist/secrets-resolver.mjs`, EMPTY child env,
 *     request on stdin, protocolVersion 1)
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  supportsSecretRefIntegrations,
  buildProviderRef,
  wireSecretRefProviders,
  secretRefWiringStatus,
} from 'aquaman-proxy';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const RESOLVER = path.resolve(__dirname, '../../packages/plugin/secrets-resolver.mjs');

describe('supportsSecretRefIntegrations (version gate)', () => {
  it.each([
    ['2026.6.5', true],
    ['2026.6.10', true],
    ['2026.7.1', true],
    ['2027.1.1', true],
    ['2026.6.4', false],
    ['2026.5.12', false],
    ['2025.12.31', false],
  ])('%s → %s', (version, expected) => {
    expect(supportsSecretRefIntegrations(version)).toBe(expected);
  });

  it('is conservative on unknown/unparseable versions', () => {
    expect(supportsSecretRefIntegrations(undefined)).toBe(false);
    expect(supportsSecretRefIntegrations(null)).toBe(false);
    expect(supportsSecretRefIntegrations('not-a-version')).toBe(false);
    expect(supportsSecretRefIntegrations('')).toBe(false);
  });
});

describe('wireSecretRefProviders', () => {
  it('writes the provider integration and per-service refs into an empty config', () => {
    const config: Record<string, any> = {};
    const result = wireSecretRefProviders(config, ['anthropic', 'openai']);

    expect(result.changed).toBe(true);
    expect(result.wiredProviders).toEqual(['anthropic', 'openai']);
    expect(config.secrets.providers.aquaman).toEqual({
      source: 'exec',
      pluginIntegration: { pluginId: 'aquaman-plugin', integrationId: 'aquaman' },
    });
    expect(config.models.providers.anthropic.apiKey).toEqual({
      source: 'exec', provider: 'aquaman', id: 'anthropic/api_key',
    });
    expect(config.models.providers.openai.apiKey).toEqual({
      source: 'exec', provider: 'aquaman', id: 'openai/api_key',
    });
  });

  it('is idempotent — second run reports no change', () => {
    const config: Record<string, any> = {};
    wireSecretRefProviders(config, ['anthropic']);
    const second = wireSecretRefProviders(config, ['anthropic']);
    expect(second.changed).toBe(false);
    expect(second.wiredProviders).toEqual(['anthropic']);
  });

  it('never clobbers a user-set plaintext apiKey', () => {
    const config: Record<string, any> = {
      models: { providers: { anthropic: { apiKey: 'sk-ant-users-own-key' } } },
    };
    const result = wireSecretRefProviders(config, ['anthropic']);
    expect(config.models.providers.anthropic.apiKey).toBe('sk-ant-users-own-key');
    expect(result.wiredProviders).toEqual([]);
    expect(result.skippedProviders).toContain('anthropic');
  });

  it('never clobbers a user-set foreign SecretRef', () => {
    const foreignRef = { source: 'env', provider: 'default', id: 'MY_ANTHROPIC_KEY' };
    const config: Record<string, any> = {
      models: { providers: { anthropic: { apiKey: foreignRef } } },
    };
    wireSecretRefProviders(config, ['anthropic']);
    expect(config.models.providers.anthropic.apiKey).toEqual(foreignRef);
  });

  it('upgrades the legacy literal placeholder to a SecretRef', () => {
    const config: Record<string, any> = {
      models: { providers: { anthropic: { apiKey: 'aquaman-proxy-managed' } } },
    };
    const result = wireSecretRefProviders(config, ['anthropic']);
    expect(result.wiredProviders).toEqual(['anthropic']);
    expect(config.models.providers.anthropic.apiKey).toEqual(buildProviderRef('anthropic'));
  });

  it('skips services the resolver does not serve, preserving other config', () => {
    const config: Record<string, any> = { channels: { telegram: { enabled: true } } };
    const result = wireSecretRefProviders(config, ['anthropic', 'telegram', 'slack']);
    expect(result.wiredProviders).toEqual(['anthropic']);
    expect(result.skippedProviders).toEqual(expect.arrayContaining(['telegram', 'slack']));
    expect(config.channels).toEqual({ telegram: { enabled: true } });
    expect(config.models.providers.telegram).toBeUndefined();
  });
});

describe('secretRefWiringStatus', () => {
  it('reports fully wired config', () => {
    const config: Record<string, any> = {};
    wireSecretRefProviders(config, ['anthropic', 'openai']);
    const status = secretRefWiringStatus(config, ['anthropic', 'openai']);
    expect(status.providerConfigured).toBe(true);
    expect(status.wiredProviders).toEqual(['anthropic', 'openai']);
    expect(status.missingProviders).toEqual([]);
  });

  it('reports missing provider block and unwired services', () => {
    const status = secretRefWiringStatus({}, ['anthropic', 'openai']);
    expect(status.providerConfigured).toBe(false);
    expect(status.missingProviders).toEqual(['anthropic', 'openai']);
  });

  it('ignores non-provider services in the requested list', () => {
    const config: Record<string, any> = {};
    wireSecretRefProviders(config, ['anthropic']);
    const status = secretRefWiringStatus(config, ['anthropic', 'telegram']);
    expect(status.wiredProviders).toEqual(['anthropic']);
    expect(status.missingProviders).toEqual([]);
  });
});

/**
 * Exec resolver protocol tests. Spawn conditions mirror the gateway's
 * `runExecResolver` (openclaw 2026.6.10): request JSON on stdin, stdin
 * closed, response JSON on stdout, empty child env (the manifest declares
 * no passEnv), cwd = script dir.
 */
describe('secrets-resolver.mjs (exec protocol v1)', () => {
  function runResolver(input: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [RESOLVER], {
        cwd: path.dirname(RESOLVER),
        env: {},           // the gateway passes ONLY manifest env + passEnv — we declare neither
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('error', reject);
      proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      proc.stdin.write(input);
      proc.stdin.end();
    });
  }

  it('resolves every requested id to the static placeholder', async () => {
    const { code, stdout } = await runResolver(JSON.stringify({
      protocolVersion: 1,
      provider: 'aquaman',
      ids: ['anthropic/api_key', 'openai/api_key'],
    }));
    expect(code).toBe(0);
    const response = JSON.parse(stdout);
    expect(response).toEqual({
      protocolVersion: 1,
      values: {
        'anthropic/api_key': 'aquaman-proxy-managed',
        'openai/api_key': 'aquaman-proxy-managed',
      },
    });
  });

  it('works with an empty child env (no vault, no proxy, no env reads)', async () => {
    // Isolation property (ATLAS T0055): the resolver is static — even spawned
    // with nothing in its environment it must succeed, proving it cannot be
    // exfiltrating real credentials into the gateway process.
    const { code, stdout } = await runResolver(JSON.stringify({
      protocolVersion: 1, provider: 'aquaman', ids: ['anthropic/api_key'],
    }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout).values['anthropic/api_key']).toBe('aquaman-proxy-managed');
  });

  it('rejects an unsupported protocolVersion (nonzero exit, stderr)', async () => {
    const { code, stderr } = await runResolver(JSON.stringify({ protocolVersion: 2, ids: [] }));
    expect(code).not.toBe(0);
    expect(stderr).toContain('unsupported protocolVersion');
  });

  it('rejects malformed JSON on stdin', async () => {
    const { code, stderr } = await runResolver('{not json');
    expect(code).not.toBe(0);
    expect(stderr).toContain('not valid JSON');
  });

  it('maps invalid ids into the errors object without failing the batch', async () => {
    const { code, stdout } = await runResolver(JSON.stringify({
      protocolVersion: 1, provider: 'aquaman', ids: ['anthropic/api_key', '', 42],
    }));
    expect(code).toBe(0);
    const response = JSON.parse(stdout);
    expect(response.values['anthropic/api_key']).toBe('aquaman-proxy-managed');
    expect(Object.keys(response.errors).sort()).toEqual(['', '42']);
  });

  it('handles an empty ids array', async () => {
    const { code, stdout } = await runResolver(JSON.stringify({
      protocolVersion: 1, provider: 'aquaman', ids: [],
    }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ protocolVersion: 1, values: {} });
  });
});
