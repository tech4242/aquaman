/**
 * register() side effects across host versions and registration modes
 * (v0.15.0). Drives the real plugin entry with a fake OpenClaw API.
 *
 * - OpenClaw calls register() with registrationMode "discovery" /
 *   "tool-discovery" for `plugins inspect|doctor|install`. Those calls must
 *   only collect registrations, never write files or process env (verified on
 *   2026.7.33 and 2026.9.1: they were writing auth-profiles.json).
 * - On OpenClaw >= 2026.6.5 the legacy auth-profiles.json is never written.
 *   On the 2.0 line (2026.8.1+) it locks anthropic/openai out with
 *   AUTH_PROFILE_MIGRATION_REQUIRED and came back after every
 *   `openclaw doctor --fix`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const binary = vi.hoisted(() => ({ path: '/usr/local/bin/aquaman' as string | null }));

vi.mock('../../../packages/plugin/src/proxy-manager.js', () => ({
  createProxyManager: vi.fn(),
  findAquamanProxyBinary: () => binary.path,
  execAquamanProxyCli: vi.fn(),
  execAquamanProxyInteractive: vi.fn(),
}));

import plugin from '../../../packages/plugin/index.ts';

const pluginPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../packages/plugin/package.json'), 'utf-8'),
);

function fakeApi(opts: { registrationMode?: string; version?: string; config?: unknown }) {
  const calls = { services: [] as string[], commands: [] as string[], tools: [] as string[][], cli: 0, warns: [] as string[] };
  const api: any = {
    logger: { info: () => {}, warn: (m: string) => calls.warns.push(m), error: () => {} },
    pluginConfig: opts.config ?? { services: ['anthropic', 'openai'] },
    registrationMode: opts.registrationMode,
    runtime: opts.version ? { version: opts.version } : undefined,
    registerService: (d: { id: string }) => calls.services.push(d.id),
    registerCommand: (d: { name: string }) => calls.commands.push(d.name),
    registerCli: () => { calls.cli++; },
    registerTool: (_f: unknown, o: { names: string[] }) => calls.tools.push(o.names),
  };
  return { api, calls };
}

describe('aquaman-plugin register()', () => {
  let stateDir: string;
  const envKeys = ['OPENCLAW_STATE_DIR', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL'];
  const saved: Record<string, string | undefined> = {};
  const profilesPath = () => path.join(stateDir, 'agents', 'main', 'agent', 'auth-profiles.json');

  beforeEach(() => {
    for (const k of envKeys) saved[k] = process.env[k];
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-plugin-register-'));
    process.env['OPENCLAW_STATE_DIR'] = stateDir;
    delete process.env['ANTHROPIC_BASE_URL'];
    delete process.env['OPENAI_BASE_URL'];
    binary.path = '/usr/local/bin/aquaman';
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('reports the package.json version (not "unknown")', () => {
    expect(plugin.version).toBe(pluginPkg.version);
  });

  for (const mode of ['discovery', 'tool-discovery']) {
    it(`registrationMode "${mode}": registers everything, writes nothing`, () => {
      const { api, calls } = fakeApi({ registrationMode: mode, version: '2026.5.12' });
      plugin.register!(api);
      expect(calls.tools).toEqual([['aquaman_status']]);
      expect(calls.commands).toContain('aquaman-status');
      expect(calls.services).toEqual(['aquaman-proxy']);
      expect(fs.existsSync(profilesPath())).toBe(false);
      expect(process.env['ANTHROPIC_BASE_URL']).toBeUndefined();
    });
  }

  it('full load on a pre-2026.6.5 gateway writes the legacy placeholder and sentinel env', () => {
    const { api } = fakeApi({ registrationMode: 'full', version: '2026.5.12' });
    plugin.register!(api);
    const profiles = JSON.parse(fs.readFileSync(profilesPath(), 'utf-8'));
    expect(profiles.profiles['anthropic:default'].key).toBe('aquaman-proxy-managed');
    expect(process.env['ANTHROPIC_BASE_URL']).toBe('http://aquaman.local/anthropic');
  });

  it('full load on a host that reports no mode or version keeps the legacy behavior', () => {
    const { api } = fakeApi({});
    plugin.register!(api);
    expect(fs.existsSync(profilesPath())).toBe(true);
  });

  for (const version of ['2026.6.5', '2026.7.33', '2026.9.1', '2026.9.4-beta.2']) {
    it(`full load on OpenClaw ${version} never writes auth-profiles.json and points at SecretRef setup`, () => {
      const { api, calls } = fakeApi({ registrationMode: 'full', version });
      plugin.register!(api);
      expect(fs.existsSync(profilesPath())).toBe(false);
      expect(calls.warns.join('\n')).toContain('aquaman openclaw setup');
      // The proxy path itself is unaffected.
      expect(process.env['ANTHROPIC_BASE_URL']).toBe('http://aquaman.local/anthropic');
    });
  }

  it('stays quiet about SecretRef when the wiring is already present', () => {
    fs.writeFileSync(path.join(stateDir, 'openclaw.json'), JSON.stringify({
      secrets: { providers: { aquaman: { source: 'exec', pluginIntegration: { pluginId: 'aquaman-plugin', integrationId: 'aquaman' } } } },
    }));
    const { api, calls } = fakeApi({ registrationMode: 'full', version: '2026.9.1' });
    plugin.register!(api);
    expect(fs.existsSync(profilesPath())).toBe(false);
    expect(calls.warns.join('\n')).not.toContain('aquaman openclaw setup');
  });
});
