/**
 * E2E: the top-level overview commands of the proxy CLI: `doctor`, `status`,
 * `init` (without --agent), `setup --non-interactive`, the `coder` delegation
 * and the bare `aquaman` help screen.
 *
 * Where a command asks "is the proxy running", a server the test owns sits on
 * the socket, so the answer is exact and no daemon is involved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { EncryptedFileStore } from '../../packages/proxy/src/core/credentials/store.js';
import { createSandbox, fakeProxy, json, PASSWORD, T, type FakeProxy, type Sandbox } from './cov-cli-core-helpers.js';

const BASE_CONFIG = 'credentials:\n  backend: encrypted-file\n  proxiedServices: [anthropic, github]\n';

describe('cli-core: doctor, status, init, setup and the coder shim', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  beforeEach(() => { sb = createSandbox(); proxy = undefined; });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  describe('doctor', () => {
    it('with nothing set up: one issue, the fix for it, and integrations reported as absent rather than broken', async () => {
      const r = await sb.run(['doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toMatch(/aquaman \d+\.\d+\.\d+ — health check/);
      expect(r.stdout).toContain(`✗ Config missing (${path.join(sb.config, 'config.yaml')})`);
      expect(r.stdout).toContain('→ Run: aquaman setup');
      expect(r.stdout).toMatch(/OpenClaw integration\n\s+• not detected/);
      expect(r.stdout).toMatch(/Coder integration\n\s+• not configured/);
      expect(r.stdout).toContain('npm install -g aquaman-coder');
      expect(r.stdout).toMatch(/Hermes integration\n\s+• not detected/);
      expect(r.stdout).toContain('1 issue found in baseline.');
      // No config means the backend and the proxy were not probed at all.
      expect(r.stdout).not.toContain('Proxy not running');
    }, T);

    it('counts an unusable backend and a stopped proxy as two issues, each with its fix', async () => {
      sb.writeConfig(BASE_CONFIG);
      const r = await sb.run(['doctor'], { env: { AQUAMAN_BACKEND: 'vault' } });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Backend not accessible: vaultAddress required');
      expect(r.stdout).toContain('✗ Proxy not running');
      expect(r.stdout).toContain('→ Run: aquaman daemon &');
      expect(r.stdout).toContain('2 issues found in baseline.');
    }, T);

    it('detects OpenClaw without the plugin as an issue and points at the namespaced setup', async () => {
      sb.writeConfig(BASE_CONFIG);
      fs.mkdirSync(path.join(sb.home, '.openclaw'));
      const r = await sb.run(['doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✓ encrypted-file backend (0 credentials)');
      expect(r.stdout).toContain('✗ plugin not installed');
      expect(r.stdout).toContain('→ Run: aquaman openclaw setup');
    }, T);

    it('passes when the vault opens, the proxy answers and every detected integration is wired', async () => {
      sb.writeConfig(`${BASE_CONFIG}loopback:\n  enabled: true\n  port: 8585\n  token: aqm_lb_cov_cli_core_token\n`);
      await new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc')).set('github', 'token', 'ghp_cov_cli_core_doctor');
      // `openclaw` is only looked up on PATH here, never run.
      sb.installBin('openclaw', '#!/bin/sh\nexit 99\n');
      fs.mkdirSync(path.join(sb.home, '.openclaw', 'extensions', 'aquaman-plugin'), { recursive: true });
      fs.mkdirSync(path.join(sb.home, '.hermes'));
      fs.writeFileSync(path.join(sb.config, 'projects.yaml'), 'projects: {}\n');
      proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 200, { status: 'ok' }));

      const r = await sb.run(['doctor']);
      expect(r.stdout).toContain('✓ encrypted-file backend (1 credential)');
      expect(r.stdout).toContain('✓ Proxy running on socket');
      expect(r.stdout).toContain('✓ plugin installed   (deep: aquaman openclaw doctor)');
      expect(r.stdout).toContain('✓ configured   (deep: aquaman coder doctor)');
      expect(r.stdout).toContain('✓ loopback listener enabled   (deep: aquaman hermes doctor)');
      expect(r.stdout).toContain('All baseline checks passed.');
      expect(r.stdout).not.toContain('✗');
      expect(r.code).toBe(0);
      expect(proxy.requests.map((q) => `${q.method} ${q.url}`)).toEqual(['GET /_health']);
    }, T);

    it('with 1Password in desktop-app mode it explains the prompts and the service-account way out, and stays quiet once one is set', async () => {
      sb.writeConfig(`${BASE_CONFIG}  onePasswordVault: team-vault\n`);
      // Stands in for the 1Password CLI: signed in, one aquaman item.
      sb.installBin('op', [
        '#!/bin/sh',
        'if [ "$1" = "account" ]; then echo "{}"; exit 0; fi',
        'if [ "$1" = "item" ] && [ "$2" = "list" ]; then echo \'[{"title":"aquaman-github-token"}]\'; exit 0; fi',
        'exit 1',
        '',
      ].join('\n'));

      const biometric = await sb.run(['doctor'], { env: { AQUAMAN_BACKEND: '1password' } });
      expect(biometric.stdout).toContain('✓ 1password backend (1 credential)');
      expect(biometric.stdout).toContain('• 1Password is in biometric/desktop-app mode — each vault read prompts (the daemon cache bounds this to one per 15 min per credential).');
      expect(biometric.stdout).toContain('create a service account scoped to the "team-vault" vault');
      expect(biometric.stdout).toContain('OP_SERVICE_ACCOUNT_TOKEN');

      const uncached = await sb.run(['doctor'], { env: { AQUAMAN_BACKEND: '1password', AQUAMAN_CACHE_TTL: '0' } });
      expect(uncached.stdout).toContain('each vault read prompts (and the credential cache is disabled (cacheTtlSeconds: 0)).');

      const serviceAccount = await sb.run(['doctor'], { env: { AQUAMAN_BACKEND: '1password', OP_SERVICE_ACCOUNT_TOKEN: 'ops_cov_cli_core_fake' } });
      expect(serviceAccount.stdout).toContain('✓ 1password backend (1 credential)');
      expect(serviceAccount.stdout).not.toContain('biometric');
    }, T * 2);

    it('treats a socket that answers anything but 200 as a proxy that is not running', async () => {
      sb.writeConfig(BASE_CONFIG);
      proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 503, { status: 'starting' }));
      const r = await sb.run(['doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Proxy not running');
      expect(r.stdout).not.toContain('✓ Proxy running on socket');
    }, T);
  });

  describe('status', () => {
    it('without a proxy: says not running and prints the configuration it would use', async () => {
      sb.writeConfig(`${BASE_CONFIG}audit:\n  enabled: false\n`);
      const r = await sb.run(['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Proxy: not running');
      expect(r.stdout).toContain(`Config dir:  ${sb.config}`);
      expect(r.stdout).toContain('Backend:     encrypted-file');
      expect(r.stdout).toContain(`Socket:      ${sb.socket}`);
      expect(r.stdout).toContain('Audit:       disabled');
      expect(r.stdout).toContain('Proxied services  (2)\n    - anthropic\n    - github');
      expect(r.stdout).toContain('aquaman openclaw status');
    }, T);

    it('with a proxy on the socket: reports its version and whole seconds of uptime', async () => {
      sb.writeConfig(BASE_CONFIG);
      proxy = await fakeProxy(sb.socket, (_req, res) => json(res, 200, { status: 'ok', version: '9.8.7', uptime: 12.9 }));
      const r = await sb.run(['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Proxy: running  (v9.8.7, uptime 12s)');
      expect(r.stdout).toContain('Audit:       enabled');
    }, T);

    it('reads a proxy that answers with something other than JSON as not running', async () => {
      sb.writeConfig(BASE_CONFIG);
      proxy = await fakeProxy(sb.socket, (_req, res) => { res.writeHead(200); res.end('<html>'); });
      const r = await sb.run(['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Proxy: not running');
    }, T);
  });

  describe('init (without --agent)', () => {
    const configFile = () => path.join(sb.config, 'config.yaml');

    it('creates a 0600 config and the audit directory, and says what to do next', async () => {
      const r = await sb.run(['init']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Created ${configFile()}`);
      expect(r.stdout).toContain(`Created ${path.join(sb.config, 'audit')}`);
      expect(r.stdout).toContain('1. Add your API keys: aquaman credentials add anthropic api_key');
      expect(r.stdout).toContain('2. Start the proxy:   aquaman start');
      expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(sb.config, 'audit')).isDirectory()).toBe(true);
      const written = parseYaml(fs.readFileSync(configFile(), 'utf-8'));
      expect(written.credentials.proxiedServices).toContain('anthropic');
      expect(written.loopback.enabled).toBe(false);
    }, T);

    it('leaves an existing config alone unless --force, and re-creates a missing custom audit directory', async () => {
      const customAudit = path.join(sb.root, 'custom-audit');
      const mine = `${BASE_CONFIG}audit:\n  enabled: true\n  logDir: ${customAudit}\n`;
      sb.writeConfig(mine);

      const kept = await sb.run(['init']);
      expect(kept.code).toBe(0);
      expect(kept.stdout).toContain(`Configuration already exists at ${configFile()}`);
      expect(kept.stdout).toContain('Use --force to overwrite.');
      expect(kept.stdout).toContain(`Created ${customAudit}`);
      expect(kept.stdout).not.toContain('Next steps');
      expect(fs.readFileSync(configFile(), 'utf-8')).toBe(mine);
      expect(fs.statSync(customAudit).isDirectory()).toBe(true);

      // Nothing left to heal: a second run reports no directory.
      const again = await sb.run(['init']);
      expect(again.stdout).not.toContain('Created');

      const forced = await sb.run(['init', '--force']);
      expect(forced.code).toBe(0);
      expect(forced.stdout).toContain(`Created ${configFile()}`);
      expect(forced.stdout).toContain('Next steps');
      expect(fs.readFileSync(configFile(), 'utf-8')).not.toContain(customAudit);
    }, T * 2);
  });

  describe('setup --non-interactive', () => {
    it('stores the keys found in the environment, applies policy presets and points at the two full setups', async () => {
      const r = await sb.run(['setup', '--non-interactive', '--backend', 'encrypted-file'], {
        env: { ANTHROPIC_API_KEY: 'sk-ant-cov-cli-core-0123456789', OPENAI_API_KEY: 'sk-cov-cli-core-0123456789' },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Backend:  encrypted-file');
      expect(r.stdout).toContain('✓ Stored anthropic/api_key');
      expect(r.stdout).toContain('✓ Stored openai/api_key');
      expect(r.stdout).toContain('Default policy presets applied.');
      expect(r.stdout).toContain('OpenClaw Gateway user?   aquaman openclaw setup');
      expect(r.stdout).toContain('aquaman coder setup claude-code (requires aquaman-coder)');
      expect(r.stdout).not.toContain('sk-ant-cov-cli-core');

      const store = new EncryptedFileStore(PASSWORD, path.join(sb.config, 'credentials.enc'));
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-cov-cli-core-0123456789');
      expect(await store.get('openai', 'api_key')).toBe('sk-cov-cli-core-0123456789');
      const written = parseYaml(fs.readFileSync(path.join(sb.config, 'config.yaml'), 'utf-8'));
      expect(written.credentials.backend).toBe('encrypted-file');
      expect(Object.keys(written.policy)).toEqual(expect.arrayContaining(['anthropic', 'openai']));
    }, T);

    it('--no-policy writes no policy, and an unknown backend is refused before anything is written', async () => {
      const r = await sb.run(['setup', '--non-interactive', '--backend', 'encrypted-file', '--no-policy'], {
        env: { ANTHROPIC_API_KEY: 'sk-ant-cov-cli-core-0123456789' },
      });
      expect(r.code).toBe(0);
      expect(r.stdout).not.toContain('policy presets applied');
      expect(parseYaml(fs.readFileSync(path.join(sb.config, 'config.yaml'), 'utf-8')).policy).toBeUndefined();

      const other = createSandbox();
      try {
        const bad = await other.run(['setup', '--non-interactive', '--backend', 'sticky-note']);
        expect(bad.code).toBe(1);
        expect(bad.stderr).toContain('Invalid backend: sticky-note. Valid: keychain, encrypted-file');
        expect(fs.existsSync(path.join(other.config, 'config.yaml'))).toBe(false);
      } finally {
        await other.cleanup();
      }
    }, T * 2);
  });

  describe('coder delegation and help', () => {
    it('passes every argument after `coder` through untouched and returns the exit status', async () => {
      sb.installFakeCoder('echo "coder saw $# args"\nexit 7');
      const r = await sb.run(['coder', 'project', 'add', '--name', 'x y', '--unknown-flag', '--help']);
      expect(r.code).toBe(7);
      expect(r.stdout).toContain('coder saw 6 args');
      expect(sb.coderCalls()).toEqual([['project', 'add', '--name', 'x y', '--unknown-flag', '--help']]);
    }, T);

    it('exits 127 with the install command when aquaman-coder is not on PATH', async () => {
      const r = await sb.run(['coder', 'status']);
      expect(r.code).toBe(127);
      expect(r.stderr).toContain('aquaman-coder is not installed.');
      expect(r.stderr).toContain('Install it with: npm install -g aquaman-coder');
    }, T);

    it('exits 1 and names the failure when aquaman-coder is there but cannot be run', async () => {
      sb.installBin('aquaman-coder', '#!/bin/sh\nexit 0\n', 0o644);
      const r = await sb.run(['coder', 'status']);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/Failed to run aquaman-coder: .*EACCES/);
    }, T);

    it('`coder` is only a delegation when it is the command, not when it is an argument', async () => {
      sb.installFakeCoder('echo should-not-run');
      const r = await sb.run(['policy', 'test', 'coder', 'GET', '/v1/x']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('ALLOWED (no policy for service "coder")');
      expect(sb.coderCalls()).toEqual([]);
    }, T);

    it('run with no arguments prints the help screen', async () => {
      const r = await sb.run([]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: aquaman [options] [command]');
      expect(r.stdout).toContain('Vault & core (agent-agnostic)');
      expect(r.stdout).toMatch(/request\s+Ask for a credential by reference/);
      expect(r.stdout).toContain('(delegates to the aquaman-coder binary; install: npm install -g aquaman-coder)');
    }, T);
  });
});
