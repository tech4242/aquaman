/**
 * What the setup commands write to config.yaml, and what they leave alone.
 *
 * Two rules:
 *   - a value that exists only as an environment override (the encryption
 *     password, a Vault token, a loopback token, ...) is never written to the
 *     file by a setup command;
 *   - re-running a setup command on an existing config changes what that
 *     command decides and keeps the rest (loopback token and port, declared
 *     broker refs, policies, proxied services).
 *
 * Everything runs in the sandbox of test/helpers/cov-cli-hosts.ts: private
 * HOME, config dir, OpenClaw state dir and Hermes home, the encrypted-file
 * backend, and a PATH with no real vendor program on it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createSandbox, baseConfig, runCli, TEST_PASSWORD, type Sandbox } from '../helpers/cov-cli-hosts.js';

const T = 120_000;

/** Every override loadConfig() applies from the environment, each with a value that is easy to find in a file. */
const ENV_ONLY: Record<string, string> = {
  AQUAMAN_ENCRYPTION_PASSWORD: TEST_PASSWORD,
  AQUAMAN_SERVICES: 'envonly-service-a,envonly-service-b',
  AQUAMAN_AUDIT_ENABLED: 'false',
  VAULT_ADDR: 'http://127.0.0.1:1/envonly-vault-addr',
  VAULT_TOKEN: 'hvs.envonly-vault-token',
  VAULT_NAMESPACE: 'envonly-namespace',
  AQUAMAN_BITWARDEN_FOLDER: 'envonly-bw-folder',
  AQUAMAN_BITWARDEN_ORGANIZATION_ID: 'envonly-bw-org',
  AQUAMAN_BITWARDEN_COLLECTION_ID: 'envonly-bw-collection',
  AQUAMAN_KEEPER_FOLDER_UID: 'envonly-keeper-folder',
  AQUAMAN_KEEPER_CONFIG: '/envonly/keeper-config.json',
  AQUAMAN_CACHE_TTL: '4242',
  AQUAMAN_LOOPBACK_ENABLED: 'true',
  AQUAMAN_LOOPBACK_PORT: '45999',
  AQUAMAN_LOOPBACK_TOKEN: 'aqm_lb_envonly-loopback-token',
  AQUAMAN_BROKER_ENABLED: 'false',
  AQUAMAN_OPENSHELL_DRIVER: 'true',
};

/** Text that must not be in the file if no override was written. */
const ENV_ONLY_MARKERS = [TEST_PASSWORD, 'envonly', '4242', '45999', 'encryptionPassword', 'vaultToken', 'cacheTtlSeconds'];

describe('setup commands and config.yaml', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); });
  afterEach(() => { sb.cleanup(); });

  const config = () => parseYaml(sb.readConfig());
  const expectNoEnvOnlyValue = (text: string) => {
    for (const marker of ENV_ONLY_MARKERS) expect(text).not.toContain(marker);
  };
  /** Settings a user made by hand, none of which a setup command decides. */
  const userConfig = () => [
    'credentials:',
    '  backend: encrypted-file',
    '  proxiedServices:',
    '    - anthropic',
    '    - openai',
    '    - my-internal-api',
    'audit:',
    '  enabled: true',
    `  logDir: ${path.join(sb.configDir, 'audit')}`,
    'loopback:',
    '  enabled: true',
    '  port: 9931',
    '  host: 127.0.0.1',
    '  token: aqm_lb_existing-token-kept',
    'broker:',
    '  enabled: true',
    '  allowedRefs:',
    '    - aquaman://github/token',
    'policy:',
    '  anthropic:',
    '    defaultAction: deny',
    '    rules:',
    '      - method: POST',
    '        path: /v1/messages',
    '        action: allow',
    '  my-internal-api:',
    '    defaultAction: allow',
    '    rules:',
    '      - method: DELETE',
    '        path: /**',
    '        action: deny',
  ];
  const expectUserSettingsKept = () => {
    const c = config();
    expect(c.loopback).toEqual({ enabled: true, port: 9931, host: '127.0.0.1', token: 'aqm_lb_existing-token-kept' });
    expect(c.broker).toEqual({ enabled: true, allowedRefs: ['aquaman://github/token'] });
    expect(c.credentials.proxiedServices).toEqual(['anthropic', 'openai', 'my-internal-api']);
    expect(c.policy['my-internal-api']).toEqual({ defaultAction: 'allow', rules: [{ method: 'DELETE', path: '/**', action: 'deny' }] });
    // The user's own policy for a service wins over the preset for it.
    expect(c.policy.anthropic).toEqual({ defaultAction: 'deny', rules: [{ method: 'POST', path: '/v1/messages', action: 'allow' }] });
    return c;
  };

  describe('environment-only overrides are never written', () => {
    it('aquaman setup: not on the first run, and not when run again on the config it made', async () => {
      const env = { ...ENV_ONLY, ANTHROPIC_API_KEY: 'sk-ant-setup-key' };
      const first = await runCli(sb, ['setup', '--backend', 'encrypted-file', '--non-interactive'], { env });
      expect(first.code).toBe(0);
      expectNoEnvOnlyValue(sb.readConfig());

      const second = await runCli(sb, ['setup', '--backend', 'encrypted-file', '--non-interactive'], { env });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Stored anthropic/api_key');
      const text = sb.readConfig();
      expectNoEnvOnlyValue(text);

      const c = config();
      expect(c.credentials.backend).toBe('encrypted-file');
      expect(c.credentials.proxiedServices).toEqual(['anthropic', 'openai', 'slack', 'discord', 'github']);
      expect(c.audit.enabled).toBe(true);
      expect(c.loopback).toEqual({ enabled: false, port: 8585, host: '127.0.0.1' });
      expect(c.broker).toEqual({ enabled: true, allowedRefs: [] });
      expect(c.openshell).toBeUndefined();
      expect(Object.keys(c.policy)).toEqual(['anthropic']);
      expect(fs.statSync(path.join(sb.configDir, 'config.yaml')).mode & 0o777).toBe(0o600);
    }, T);

    it('aquaman setup --no-policy on an existing config: the password in the environment stays out of the file', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['setup', '--backend', 'encrypted-file', '--non-interactive', '--no-policy'], { env: ENV_ONLY });
      expect(r.code).toBe(0);
      expectNoEnvOnlyValue(sb.readConfig());
    }, T);

    it('aquaman openclaw setup: neither on the first run nor on a second', async () => {
      const env = { ...ENV_ONLY, OPENAI_API_KEY: 'sk-oai-setup-key' };
      for (const run of [1, 2]) {
        const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'encrypted-file', '--non-interactive', '--no-openclaw'], { env });
        expect(r.code, `run ${run}`).toBe(0);
        expectNoEnvOnlyValue(sb.readConfig());
      }
      expect(config().loopback).toEqual({ enabled: false, port: 8585, host: '127.0.0.1' });
    }, T);

    it('aquaman hermes setup: writes the listener it enables, and nothing else from the environment', async () => {
      sb.writeConfig(baseConfig(sb));
      const { AQUAMAN_LOOPBACK_ENABLED: _e, AQUAMAN_LOOPBACK_PORT: _p, AQUAMAN_LOOPBACK_TOKEN: _t, AQUAMAN_SERVICES: _s, ...others } = ENV_ONLY;
      const r = await runCli(sb, ['hermes', 'setup', '--port', '9932'], { env: others });
      expect(r.code).toBe(0);
      const c = config();
      expect(c.loopback).toMatchObject({ enabled: true, port: 9932, host: '127.0.0.1' });
      expect(c.loopback.token).toMatch(/^aqm_lb_/);
      expect(c.broker.enabled).toBe(true);
      expect(c.audit.enabled).toBe(true);
      for (const marker of [TEST_PASSWORD, 'envonly', '4242', 'encryptionPassword', 'vaultToken', 'cacheTtlSeconds']) {
        expect(sb.readConfig()).not.toContain(marker);
      }
    }, T);
  });

  describe('re-running setup keeps what the user configured', () => {
    it('aquaman openclaw setup keeps the loopback token and port, broker refs, policies and proxied services', async () => {
      sb.writeConfig(userConfig());
      sb.writeOpenClawJson({});
      const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'encrypted-file', '--non-interactive'], {
        env: { ANTHROPIC_API_KEY: 'sk-ant-setup-key', OPENAI_API_KEY: 'sk-oai-setup-key', AQUAMAN_OPENCLAW_VERSION: '2026.9.37' },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Loopback listener enabled on http://127.0.0.1:9931');

      const c = expectUserSettingsKept();
      // What setup does decide: the backend, and a preset for a newly stored service that had no policy.
      expect(c.credentials.backend).toBe('encrypted-file');
      expect(c.policy.openai).toBeDefined();

      // OpenClaw is pointed at the listener the user already had, not a new one.
      const oc = sb.readOpenClawJson();
      expect(oc.models.providers.anthropic.baseUrl).toBe('http://127.0.0.1:9931/anthropic');
      expect(JSON.stringify(oc)).not.toContain('8585');
    }, T);

    it('aquaman setup keeps them too', async () => {
      sb.writeConfig(userConfig());
      const r = await runCli(sb, ['setup', '--backend', 'encrypted-file', '--non-interactive'], {
        env: { ANTHROPIC_API_KEY: 'sk-ant-setup-key', OPENAI_API_KEY: 'sk-oai-setup-key' },
      });
      expect(r.code).toBe(0);
      const c = expectUserSettingsKept();
      expect(c.policy.openai).toBeDefined();
    }, T);

    it('a first run on a machine with no config writes the defaults plus the backend', async () => {
      sb.writeOpenClawJson({});
      const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'encrypted-file', '--non-interactive'], {
        env: { ANTHROPIC_API_KEY: 'sk-ant-setup-key', AQUAMAN_OPENCLAW_VERSION: '2026.9.37' },
      });
      expect(r.code).toBe(0);
      const c = config();
      expect(c.credentials).toEqual({
        backend: 'encrypted-file',
        proxiedServices: ['anthropic', 'openai', 'slack', 'discord', 'github'],
        vaultMountPath: 'secret',
      });
      expect(c.audit).toEqual({ enabled: true, logDir: path.join(sb.configDir, 'audit') });
      expect(c.broker).toEqual({ enabled: true, allowedRefs: [] });
      expect(c.loopback).toMatchObject({ enabled: true, port: 8585, host: '127.0.0.1' });
      expect(c.loopback.token).toMatch(/^aqm_lb_[0-9a-f]{48}$/);
      expect(Object.keys(c.policy)).toEqual(['anthropic']);
      expect(sb.readOpenClawJson().models.providers.anthropic.baseUrl).toBe('http://127.0.0.1:8585/anthropic');
    }, T);
  });

  describe('files that hold the loopback token', () => {
    it('hermes setup leaves an existing .env readable by its owner only', async () => {
      sb.writeConfig(baseConfig(sb));
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      const envFile = path.join(sb.hermesHome, '.env');
      fs.writeFileSync(envFile, 'MY_OWN_VAR=keep-me\n', { mode: 0o644 });
      fs.chmodSync(envFile, 0o644);

      const r = await runCli(sb, ['hermes', 'setup', '--port', '9933']);
      expect(r.code).toBe(0);
      expect(fs.readFileSync(envFile, 'utf-8')).toContain('AQUAMAN_LOOPBACK_TOKEN=aqm_lb_');
      expect(fs.readFileSync(envFile, 'utf-8')).toContain('MY_OWN_VAR=keep-me');
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    }, T);
  });

  describe('doctor', () => {
    it('the fix printed for a missing audit directory creates it, at the configured place', async () => {
      const auditDir = path.join(sb.root, 'custom-audit');
      sb.writeConfig(['credentials:', '  backend: encrypted-file', 'audit:', '  enabled: true', `  logDir: ${auditDir}`]);

      const before = await runCli(sb, ['openclaw', 'doctor']);
      expect(before.stdout).toContain(`Audit directory missing (${auditDir})`);
      const fix = /Audit directory missing[^\n]*\n\s*→ Run: aquaman (.+)/.exec(before.stdout)?.[1];
      expect(fix).toBeTruthy();

      const applied = await runCli(sb, fix!.trim().split(/\s+/));
      expect(applied.code).toBe(0);
      expect(fs.statSync(auditDir).isDirectory()).toBe(true);
      // The fix heals the directory and leaves the configuration as it was.
      expect(config().audit.logDir).toBe(auditDir);

      const after = await runCli(sb, ['openclaw', 'doctor']);
      expect(after.stdout).not.toContain('Audit directory missing');
      expect(after.stdout).toContain('Audit directory writable');
    }, T);
  });
});
