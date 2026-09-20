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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  loopbackProviderBaseUrl,
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
    // 2026.6.33/.34 were the June extended-stable line; 2026.7.33 is the July
    // extended-stable CI pin and 2026.9.1 the OpenClaw 2.0 CI lane (v0.15.0).
    // The SecretRef path must activate on all of them, not fall back to
    // auth-profiles.
    ['2026.6.33', true],
    ['2026.6.34', true],
    ['2026.7.1', true],
    ['2026.7.33', true],
    ['2026.9.1', true],
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

  // v0.15.0: the apiKey ref alone does not put the proxy in the path —
  // OpenClaw's model transport ignores the sentinel and calls the upstream
  // directly, so each provider also needs a loopback baseUrl.
  describe('loopback routing (loopbackOrigin)', () => {
    const ORIGIN = 'http://127.0.0.1:8585';

    it('points each provider at the listener with the path its client expects', () => {
      const config: Record<string, any> = {};
      const result = wireSecretRefProviders(config, ['anthropic', 'openai'], { loopbackOrigin: ORIGIN });
      expect(result.baseUrlProviders).toEqual(['anthropic', 'openai']);
      // The Anthropic client appends /v1/messages; the OpenAI-compatible one
      // appends /chat/completions to a /v1 base.
      expect(config.models.providers.anthropic.baseUrl).toBe('http://127.0.0.1:8585/anthropic');
      expect(config.models.providers.openai.baseUrl).toBe('http://127.0.0.1:8585/openai/v1');
      expect(loopbackProviderBaseUrl('anthropic', ORIGIN)).toBe('http://127.0.0.1:8585/anthropic');
      expect(loopbackProviderBaseUrl('telegram', ORIGIN)).toBeNull();
    });

    it('writes no baseUrl when no origin is given (legacy sentinel path)', () => {
      const config: Record<string, any> = {};
      const result = wireSecretRefProviders(config, ['anthropic']);
      expect(result.baseUrlProviders).toEqual([]);
      expect(config.models.providers.anthropic.baseUrl).toBeUndefined();
    });

    it('is idempotent and re-points a stale aquaman baseUrl (port change)', () => {
      const config: Record<string, any> = {};
      wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: ORIGIN });
      expect(wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: ORIGIN }).changed).toBe(false);

      const moved = wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: 'http://127.0.0.1:9999' });
      expect(moved.changed).toBe(true);
      expect(config.models.providers.anthropic.baseUrl).toBe('http://127.0.0.1:9999/anthropic');
    });

    it('replaces the retired aquaman.local sentinel', () => {
      const config: Record<string, any> = {
        models: { providers: { anthropic: { baseUrl: 'http://aquaman.local/anthropic' } } },
      };
      wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: ORIGIN });
      expect(config.models.providers.anthropic.baseUrl).toBe('http://127.0.0.1:8585/anthropic');
    });

    it('never clobbers a user-set baseUrl, and says so', () => {
      const config: Record<string, any> = {
        models: { providers: { anthropic: { baseUrl: 'https://my-gateway.internal/anthropic' } } },
      };
      const result = wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: ORIGIN });
      expect(config.models.providers.anthropic.baseUrl).toBe('https://my-gateway.internal/anthropic');
      expect(result.keptUserBaseUrl).toEqual(['anthropic']);
      expect(result.baseUrlProviders).toEqual([]);
      // The apiKey ref is still wired — only the route is the user's.
      expect(result.wiredProviders).toEqual(['anthropic']);
    });
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

describe('secretRefWiringStatus — model routing', () => {
  it('separates wired-but-unrouted providers from routed ones', () => {
    const config: Record<string, any> = {};
    wireSecretRefProviders(config, ['anthropic', 'openai']);   // apiKey refs only
    const before = secretRefWiringStatus(config, ['anthropic', 'openai']);
    expect(before.wiredProviders).toEqual(['anthropic', 'openai']);
    expect(before.missingBaseUrl).toEqual(['anthropic', 'openai']);
    expect(before.baseUrlProviders).toEqual([]);

    wireSecretRefProviders(config, ['anthropic', 'openai'], { loopbackOrigin: 'http://127.0.0.1:8585' });
    const after = secretRefWiringStatus(config, ['anthropic', 'openai']);
    expect(after.baseUrlProviders).toEqual(['anthropic', 'openai']);
    expect(after.missingBaseUrl).toEqual([]);
  });

  it('counts a user-set baseUrl as unrouted (the proxy is not in that path)', () => {
    const config: Record<string, any> = {
      models: { providers: { anthropic: { baseUrl: 'https://my-gateway.internal/anthropic' } } },
    };
    wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: 'http://127.0.0.1:8585' });
    expect(secretRefWiringStatus(config, ['anthropic']).missingBaseUrl).toEqual(['anthropic']);
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
  let cfgDir: string;
  beforeEach(() => { cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-resolver-')); });
  afterEach(() => { fs.rmSync(cfgDir, { recursive: true, force: true }); });

  const writeConfig = (body: string) => fs.writeFileSync(path.join(cfgDir, 'config.yaml'), body);

  function runResolver(
    input: string,
    env: Record<string, string> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [RESOLVER], {
        cwd: path.dirname(RESOLVER),
        // The gateway passes ONLY manifest env + passEnv; the manifest
        // declares HOME + AQUAMAN_CONFIG_DIR so the resolver can find
        // aquaman's config. Point it at a temp dir so these tests never read
        // the developer's real ~/.aquaman/config.yaml.
        env: { AQUAMAN_CONFIG_DIR: cfgDir, ...env },
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

  it('works with an empty child env (no vault, no proxy, no network)', async () => {
    // Isolation property (ATLAS T0055): the resolver never contacts the vault
    // or the proxy, so it must still succeed with nothing in its environment.
    // Whatever it returns is a marker the proxy strips, never a real key.
    const { code, stdout } = await runResolver(
      JSON.stringify({ protocolVersion: 1, provider: 'aquaman', ids: ['anthropic/api_key'] }),
      { AQUAMAN_CONFIG_DIR: '' },
    );
    expect(code).toBe(0);
    const value = JSON.parse(stdout).values['anthropic/api_key'];
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toMatch(/^sk-/);
  });

  // v0.15.0: OpenClaw's model transport calls the proxy's token-gated
  // loopback listener, so the api key it presents must BE that token.
  it('returns the loopback token when the listener is configured', async () => {
    writeConfig([
      'credentials:',
      '  backend: keychain',
      'loopback:',
      '  enabled: true',
      '  port: 8585',
      '  token: aqm_lb_resolver_unit_token',
      '',
    ].join('\n'));
    const { code, stdout } = await runResolver(JSON.stringify({
      protocolVersion: 1, provider: 'aquaman', ids: ['anthropic/api_key', 'openai/api_key'],
    }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout).values).toEqual({
      'anthropic/api_key': 'aqm_lb_resolver_unit_token',
      'openai/api_key': 'aqm_lb_resolver_unit_token',
    });
  });

  it.each([
    ['listener disabled', 'loopback:\n  enabled: false\n  token: aqm_lb_disabled\n'],
    ['no loopback block', 'credentials:\n  backend: keychain\n'],
    ['token in an unrelated block', 'hermes:\n  token: aqm_lb_elsewhere\n'],
    ['malformed yaml', 'loopback: [\n'],
  ])('falls back to the placeholder: %s', async (_label, body) => {
    writeConfig(body);
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
