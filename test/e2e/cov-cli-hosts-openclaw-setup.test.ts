/**
 * `aquaman openclaw setup`: the backend prerequisite checks, the prompts when
 * stdin is a pipe, and the openclaw.json wiring branches the existing
 * cli-setup tests leave out.
 *
 * No real vendor program runs. PATH holds one private directory
 * (test/helpers/cov-cli-hosts.ts) with fake `op`, `bw` or `keeper` scripts
 * and the stand-in `openclaw` (test/helpers/fake-openclaw.ts) where a test
 * needs one. Vault is a local HTTP server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSandbox, baseConfig, runCli, addCredential, type Sandbox, type RunOptions } from '../helpers/cov-cli-hosts.js';
import { installFakeOpenClaw, fakeOpenClawCalls, fakeOpenClawPatches } from '../helpers/fake-openclaw.js';

const T = 120_000;
const FAKE_KEEPER = path.resolve('test/helpers/fake-keeper.mjs');

const FAKE_BW = [
  'case "$1" in',
  '  status) echo "{\\"status\\":\\"$FAKE_BW_STATUS\\"}" ;;',
  '  sync) exit "${FAKE_BW_SYNC_EXIT:-0}" ;;',
  '  *) exit 1 ;;',
  'esac',
].join('\n');

async function localServer(status: number): Promise<{ url: string; paths: string[]; close(): Promise<void> }> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    res.statusCode = status;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    paths,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

describe('aquaman openclaw setup (cli-hosts coverage)', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); });
  afterEach(() => { sb.cleanup(); });

  const configPath = () => path.join(sb.configDir, 'config.yaml');
  const setup = (args: string[], opts: RunOptions = {}) =>
    runCli(sb, ['openclaw', 'setup', '--non-interactive', ...args], opts);
  /** A failed prerequisite stops before anything is written. */
  const expectRefused = (r: { code: number | null }) => {
    expect(r.code).toBe(1);
    expect(fs.existsSync(configPath())).toBe(false);
  };

  describe('backend prerequisites', () => {
    it('1password: refuses without the op CLI', async () => {
      const r = await setup(['--backend', '1password']);
      expectRefused(r);
      expect(r.stderr).toContain('1Password CLI not found.');
      expect(r.stderr).toContain('Install: brew install 1password-cli');
      expect(r.stderr).toContain('Then: eval $(op signin)');
    }, T);

    it('1password: refuses when op is installed but not signed in', async () => {
      sb.fakeBin('op', 'exit 1');
      const r = await setup(['--backend', '1password']);
      expectRefused(r);
      expect(r.stderr).toContain('1Password CLI is installed but not signed in.');
      expect(r.stderr).toContain('Run: eval $(op signin)');
      expect(r.stderr).not.toContain('not found');
    }, T);

    it('vault: refuses non-interactively without VAULT_ADDR and VAULT_TOKEN', async () => {
      const r = await setup(['--backend', 'vault']);
      expectRefused(r);
      expect(r.stderr).toContain('Vault backend requires VAULT_ADDR and VAULT_TOKEN environment variables.');
    }, T);

    it('vault: refuses when the health endpoint answers an error', async () => {
      const vault = await localServer(503);
      try {
        const r = await setup(['--backend', 'vault'], { env: { VAULT_ADDR: vault.url, VAULT_TOKEN: 'hvs.test' } });
        expectRefused(r);
        expect(r.stderr).toContain('Vault health check failed (HTTP 503).');
        expect(r.stderr).toContain(`Check VAULT_ADDR (${vault.url}) and VAULT_TOKEN.`);
        expect(vault.paths).toEqual(['/v1/sys/health']);
      } finally {
        await vault.close();
      }
    }, T);

    it('vault: refuses when nothing answers at VAULT_ADDR', async () => {
      const vault = await localServer(200);
      await vault.close();
      const r = await setup(['--backend', 'vault'], { env: { VAULT_ADDR: vault.url, VAULT_TOKEN: 'hvs.test' } });
      expectRefused(r);
      expect(r.stderr).toContain(`Cannot reach Vault at ${vault.url}.`);
    }, T);

    it('vault: a healthy server passes the check and the backend is written to config.yaml', async () => {
      const vault = await localServer(200);
      try {
        const r = await setup(['--backend', 'vault', '--no-openclaw'], { env: { VAULT_ADDR: vault.url, VAULT_TOKEN: 'hvs.test' } });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Backend:  vault');
        expect(r.stdout).toContain('Setup complete!');
        const cfg = fs.readFileSync(configPath(), 'utf-8');
        expect(cfg).toContain('backend: vault');
        // The token comes from the environment and is not persisted.
        expect(cfg).not.toContain('hvs.test');
      } finally {
        await vault.close();
      }
    }, T);

    it('keepassxc: refuses non-interactively without AQUAMAN_KEEPASS_PASSWORD', async () => {
      const r = await setup(['--backend', 'keepassxc']);
      expectRefused(r);
      expect(r.stderr).toContain('KeePassXC backend requires AQUAMAN_KEEPASS_PASSWORD environment variable.');
    }, T);

    it('keepassxc: asks for the master password on a pipe and refuses an empty one', async () => {
      const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'keepassxc'], {
        answers: [['? KeePassXC master password: ', '   ']],
      });
      expectRefused(r);
      expect(r.stdout).toContain('? KeePassXC master password: ');
      expect(r.stderr).toContain('KeePassXC backend requires a master password.');
    }, T);

    it('systemd-creds: refuses where systemd-creds is not available', async () => {
      const r = await setup(['--backend', 'systemd-creds']);
      expectRefused(r);
      expect(r.stderr).toContain('systemd-creds backend requires systemd-creds with --user support (systemd >= 256).');
      expect(r.stderr).toContain('Try: systemd-creds --version');
    }, T);

    it('bitwarden: refuses without the bw CLI', async () => {
      const r = await setup(['--backend', 'bitwarden']);
      expectRefused(r);
      expect(r.stderr).toContain('Bitwarden CLI not found.');
      expect(r.stderr).toContain('Install: https://bitwarden.com/help/cli/');
    }, T);

    it('bitwarden: refuses when logged out', async () => {
      sb.fakeBin('bw', FAKE_BW);
      const r = await setup(['--backend', 'bitwarden'], { env: { FAKE_BW_STATUS: 'unauthenticated' } });
      expectRefused(r);
      expect(r.stderr).toContain('Bitwarden CLI is installed but not logged in.');
      expect(r.stderr).toContain('Run: bw login');
    }, T);

    it('bitwarden: refuses a locked vault without BW_SESSION', async () => {
      sb.fakeBin('bw', FAKE_BW);
      const r = await setup(['--backend', 'bitwarden'], { env: { FAKE_BW_STATUS: 'locked' } });
      expectRefused(r);
      expect(r.stderr).toContain('Bitwarden vault is locked.');
      expect(r.stderr).toContain('Run: export BW_SESSION=$(bw unlock --raw)');
    }, T);

    it('bitwarden: refuses a locked vault whose BW_SESSION does not work', async () => {
      sb.fakeBin('bw', FAKE_BW);
      const r = await setup(['--backend', 'bitwarden'], {
        env: { FAKE_BW_STATUS: 'locked', BW_SESSION: 'stale-session', FAKE_BW_SYNC_EXIT: '1' },
      });
      expectRefused(r);
      expect(r.stderr).toContain('BW_SESSION is invalid or expired.');
      expect(r.stderr).not.toContain('Bitwarden vault is locked.');
    }, T);

    it('keeper: refuses without Keeper Commander', async () => {
      const r = await setup(['--backend', 'keeper']);
      expectRefused(r);
      expect(r.stderr).toContain('Keeper Commander (keeper) not found.');
      expect(r.stderr).toContain('Install: pip install keepercommander');
    }, T);

    it('keeper: refuses without a folder UID', async () => {
      fs.symlinkSync(FAKE_KEEPER, path.join(sb.bin, 'keeper'));
      const r = await setup(['--backend', 'keeper']);
      expectRefused(r);
      expect(r.stderr).toContain('Keeper backend needs the folder that will hold aquaman records.');
      expect(r.stderr).toContain('export AQUAMAN_KEEPER_FOLDER_UID=<folder UID>');
    }, T);

    it('keeper: stores the key through Commander and records folder and config path in config.yaml', async () => {
      fs.chmodSync(FAKE_KEEPER, 0o755);
      fs.symlinkSync(FAKE_KEEPER, path.join(sb.bin, 'keeper'));
      const FOLDER = 'AquamanFolder000000000';
      const state = path.join(sb.root, 'keeper-state.json');
      const argvLog = path.join(sb.root, 'keeper-argv.log');
      const keeperConfig = path.join(sb.root, 'keeper-config.json');
      fs.writeFileSync(state, JSON.stringify({ folders: { [FOLDER]: {} }, records: {} }));

      const r = await setup(['--backend', 'keeper', '--no-openclaw'], {
        env: {
          AQUAMAN_KEEPER_FOLDER_UID: FOLDER,
          AQUAMAN_KEEPER_CONFIG: keeperConfig,
          FAKE_KEEPER_STATE: state,
          FAKE_KEEPER_ARGV_LOG: argvLog,
          ANTHROPIC_API_KEY: 'sk-ant-keeper-value',
        },
      });
      expect(r.all).toContain('✓ Stored anthropic/api_key');
      expect(r.code).toBe(0);

      const cfg = fs.readFileSync(configPath(), 'utf-8');
      expect(cfg).toContain('backend: keeper');
      expect(cfg).toContain(`keeperFolderUid: ${FOLDER}`);
      expect(cfg).toContain(`keeperConfigPath: ${keeperConfig}`);

      const records = Object.values(JSON.parse(fs.readFileSync(state, 'utf-8')).records) as any[];
      expect(records).toEqual([{ title: 'aquaman::anthropic::api_key', password: 'sk-ant-keeper-value', folder: FOLDER }]);
      // The value went over stdin, never argv.
      expect(fs.readFileSync(argvLog, 'utf-8')).not.toContain('sk-ant-keeper-value');
      expect(r.all).not.toContain('sk-ant-keeper-value');
    }, T);

    it('stops when the credential store cannot be created (weak encrypted-file password)', async () => {
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_ENCRYPTION_PASSWORD: 'short' } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Failed to initialize encrypted-file credential store: Weak encryption password');
      expect(r.stdout).not.toContain('Setup complete');
    }, T);
  });

  describe('prompts on a pipe', () => {
    it('leaves an existing configuration alone unless the answer is y', async () => {
      sb.writeConfig(baseConfig(sb, ['loopback:', '  enabled: true', '  port: 9001', '  token: aqm_lb_keepme']));
      const before = sb.readConfig();
      const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'encrypted-file'], {
        answers: [['Re-run setup? (y/N): ', 'n']],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Already configured. Run `aquaman doctor` to check status.');
      expect(r.stdout).not.toContain('Backend:');
      expect(sb.readConfig()).toBe(before);
    }, T);

    it('re-runs on y: stores the typed key, skips the empty one, applies policy, and does not install on n', async () => {
      sb.writeConfig(baseConfig(sb));
      fs.mkdirSync(sb.openclawDir);
      const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'encrypted-file'], {
        answers: [
          ['Re-run setup? (y/N): ', 'y'],
          ['? Enter your Anthropic API key: ', '  sk-ant-typed-value  '],
          ['? Enter your OpenAI API key (or press Enter to skip): ', ''],
          ['? Enable API request policies? (Y/n): ', ''],
          ['? OpenClaw detected. Install plugin? (Y/n): ', 'n'],
        ],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Stored anthropic/api_key');
      expect(r.stdout).toContain('Skipped');
      expect(r.stdout).toContain('Policies restrict which API endpoints agents can call.');
      expect(r.stdout).toContain('Applying default policy presets:');
      expect(r.stdout).toContain('Setup complete!');
      expect(r.stdout).toContain('Next: install the OpenClaw plugin');
      // The typed key is not echoed back by aquaman.
      expect(r.stdout).not.toContain('sk-ant-typed-value');

      const cfg = sb.readConfig();
      expect(cfg).toMatch(/policy:\n\s+anthropic:/);
      expect(cfg).toContain('/v1/organizations/**');
      expect(cfg).not.toMatch(/\n\s+openai:\n\s+defaultAction/);
      expect(fs.existsSync(path.join(sb.openclawDir, 'extensions', 'aquaman-plugin'))).toBe(false);
      expect(fs.existsSync(path.join(sb.openclawDir, 'openclaw.json'))).toBe(false);

      // Stored trimmed, and readable by the next process.
      const doctor = await runCli(sb, ['openclaw', 'doctor']);
      expect(doctor.stdout).toContain('✓ Stored securely: anthropic/api_key (1 in encrypted-file)');
    }, T);

    it('declining policies writes none; accepting the plugin installs and configures it', async () => {
      fs.mkdirSync(sb.openclawDir);
      installFakeOpenClaw(sb.bin, { version: '2026.5.12' });
      const r = await runCli(sb, ['openclaw', 'setup', '--backend', 'encrypted-file'], {
        env: { AQUAMAN_OPENCLAW_VERSION: '2026.5.12' },
        answers: [
          ['? Enter your Anthropic API key: ', ''],
          ['? Enter your OpenAI API key (or press Enter to skip): ', 'sk-openai-typed-value'],
          ['? Enable API request policies? (Y/n): ', 'N'],
          ['? OpenClaw detected. Install plugin? (Y/n): ', 'y'],
        ],
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Stored openai/api_key');
      expect(r.stdout).not.toContain('Policies restrict');
      expect(r.stdout).not.toContain('Applying default policy presets');
      expect(sb.readConfig()).not.toContain('policy:');

      expect(r.stdout).toContain(`✓ Plugin installed to ${path.join(sb.openclawDir, 'extensions', 'aquaman-plugin')}`);
      expect(fs.existsSync(path.join(sb.openclawDir, 'extensions', 'aquaman-plugin', 'openclaw.plugin.json'))).toBe(true);
      const oc = sb.readOpenClawJson();
      expect(oc.plugins.entries['aquaman-plugin']).toEqual({ enabled: true, config: { backend: 'encrypted-file', services: ['openai'] } });
      expect(oc.plugins.allow).toBeUndefined();
      expect(r.stdout).toContain('Next: start OpenClaw (proxy starts automatically via plugin)');
    }, T);
  });

  describe('OpenClaw detection', () => {
    it('skips the plugin when there is neither a state dir nor an openclaw program', async () => {
      const r = await setup(['--backend', 'encrypted-file']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('OpenClaw not detected — skipping plugin install');
      expect(r.stdout).toContain('Next: add credentials');
      expect(r.stdout).toContain('Next: install the OpenClaw plugin');
      expect(fs.existsSync(sb.openclawDir)).toBe(false);
      expect(sb.readConfig()).toMatch(/loopback:\n\s+enabled: false/);
    }, T);

    it('takes the gateway version from `openclaw --version` and wires SecretRef for it', async () => {
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file'], { env: { ANTHROPIC_API_KEY: 'sk-ant-env-value' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Loopback listener enabled on http://127.0.0.1:8585 (token-gated, loopback-bound)');
      expect(r.stdout).toContain('✓ SecretRef wiring for anthropic (canonical credential surface)');
      expect(r.stdout).toContain('✓ Model traffic routed through the proxy for anthropic');
      expect(r.stdout).toContain('Legacy auth-profiles.json placeholder skipped (SecretRef wiring replaces it)');
      expect(r.stdout).toContain('No plugins.allow list in openclaw.json; left it unset');

      const oc = sb.readOpenClawJson();
      expect(oc.models.providers.anthropic).toEqual({
        apiKey: { source: 'exec', provider: 'aquaman', id: 'anthropic/api_key' },
        baseUrl: 'http://127.0.0.1:8585/anthropic',
      });
      expect(oc.secrets.providers.aquaman.pluginIntegration).toEqual({ pluginId: 'aquaman-plugin', integrationId: 'aquaman' });
      expect(fs.existsSync(path.join(sb.openclawDir, 'agents', 'main', 'agent', 'auth-profiles.json'))).toBe(false);
      const cfg = sb.readConfig();
      expect(cfg).toMatch(/loopback:\n\s+enabled: true/);
      expect(cfg).toMatch(/token: aqm_lb_/);
      expect(JSON.stringify(oc)).not.toContain('sk-ant-env-value');

      // OpenClaw wrote the file: aquaman handed it one patch on stdin, with no token in it.
      expect(r.stdout).toContain(`✓ OpenClaw config changed through \`openclaw config patch\` (${path.join(sb.openclawDir, 'openclaw.json')})`);
      const patches = fakeOpenClawCalls(sb.bin).filter((c) => c.stdin !== undefined);
      expect(patches).toHaveLength(1);
      expect(patches[0]!.argv).toEqual(['config', 'patch', '--stdin']);
      expect(patches[0]!.stdin).not.toMatch(/aqm_lb_/);
      expect(fs.statSync(path.join(sb.openclawDir, 'openclaw.json')).mode & 0o777).toBe(0o600);
    }, T);
  });

  describe('openclaw.json wiring', () => {
    it.each([
      ['comments', '{\n  // my gateway\n  "gateway": { "port": 18789 },\n  "channels": { "telegram": { "botToken": "123:abc" } }\n}\n'],
      ['a trailing comma', '{ "gateway": { "port": 18789 }, }\n'],
      ['an array', '[1, 2, 3]\n'],
    ])('an openclaw.json with %s is left exactly as it was, and setup stops with the reason and what to do', async (_name, text) => {
      fs.mkdirSync(sb.openclawDir, { recursive: true });
      const file = path.join(sb.openclawDir, 'openclaw.json');
      fs.writeFileSync(file, text);
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('openclaw.json');
      expect(r.stderr).toContain('aquaman left it unchanged');
      expect(r.stderr).toContain('aquaman openclaw setup');
      expect(fs.readFileSync(file, 'utf-8')).toBe(text);
    }, T);

    it('an empty openclaw.json is a fresh one: setup writes the plugin entry', async () => {
      fs.mkdirSync(sb.openclawDir, { recursive: true });
      const file = path.join(sb.openclawDir, 'openclaw.json');
      fs.writeFileSync(file, '\n');
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(0);
      expect(sb.readOpenClawJson().plugins.entries['aquaman-plugin']).toBeTruthy();
    }, T);

    it('never replaces a user-set baseUrl or apiKey, and writes no key reference beside a baseUrl that is not the proxy', async () => {
      const mine = {
        anthropic: { baseUrl: 'https://llm-gateway.corp.example/anthropic' },
        openai: { apiKey: 'sk-user-own-openai-key' },
      };
      sb.writeOpenClawJson({ models: { providers: mine } });
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('→ Left anthropic as configured: the baseUrl there is your own, so the proxy is not in the path and no key reference is written');
      expect(r.stdout).toContain('→ Left existing user-set apiKey untouched for: openai');
      expect(r.stdout).not.toContain('SecretRef wiring for');
      expect(r.stdout).not.toContain('Model traffic routed through the proxy');
      expect(sb.readOpenClawJson().models.providers).toEqual(mine);
      expect(JSON.stringify(fakeOpenClawPatches(sb.bin))).not.toContain('anthropic/api_key');
    }, T);

    it('takes back a key reference an earlier setup left beside a user-set baseUrl', async () => {
      sb.writeOpenClawJson({
        models: { providers: { anthropic: {
          baseUrl: 'https://llm-gateway.corp.example/anthropic',
          apiKey: { source: 'exec', provider: 'aquaman', id: 'anthropic/api_key' },
        } } },
      });
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Key reference removed from anthropic: the baseUrl there is not the proxy, and the local token was being sent to it');
      expect(sb.readOpenClawJson().models.providers.anthropic).toEqual({ baseUrl: 'https://llm-gateway.corp.example/anthropic' });
      expect(fakeOpenClawPatches(sb.bin)[0]!.models.providers.anthropic).toEqual({ apiKey: null });
    }, T);

    it('routes telegram with the token as a reference: no token is written into openclaw.json', async () => {
      sb.writeConfig(baseConfig(sb));
      await addCredential(sb, 'telegram', 'bot_token', '123456:REAL-BOT-TOKEN');
      sb.writeOpenClawJson({ channels: { telegram: { enabled: true, botToken: 'aquaman-proxy-managed' } } });
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Channel traffic routed through the proxy for telegram (token by reference, not in the file)');
      expect(sb.readOpenClawJson().channels.telegram).toEqual({
        enabled: true,
        apiRoot: 'http://127.0.0.1:8585/telegram',
        botToken: { source: 'exec', provider: 'aquaman', id: 'telegram/bot_token' },
      });
      expect(fs.readFileSync(path.join(sb.openclawDir, 'openclaw.json'), 'utf-8')).not.toMatch(/aqm_lb_/);

      // A file an earlier version wrote, with the token in it, is moved to the reference.
      const token = /token: (aqm_lb_[A-Za-z0-9_-]+)/.exec(sb.readConfig())![1];
      const withToken = sb.readOpenClawJson();
      withToken.channels.telegram.botToken = token;
      sb.writeOpenClawJson(withToken);
      expect((await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } })).code).toBe(0);
      expect(fs.readFileSync(path.join(sb.openclawDir, 'openclaw.json'), 'utf-8')).not.toMatch(/aqm_lb_/);
    }, T);

    it('a second run hands OpenClaw nothing and says the settings are there', async () => {
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const env = { AQUAMAN_OPENCLAW_VERSION: '2026.9.37', ANTHROPIC_API_KEY: 'sk-ant-env-value' };
      expect((await setup(['--backend', 'encrypted-file'], { env })).code).toBe(0);
      const once = fs.readFileSync(path.join(sb.openclawDir, 'openclaw.json'), 'utf-8');
      const second = await setup(['--backend', 'encrypted-file'], { env });
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('✓ OpenClaw config already holds these settings');
      expect(fakeOpenClawCalls(sb.bin).filter((c) => c.stdin !== undefined)).toHaveLength(1);
      expect(fs.readFileSync(path.join(sb.openclawDir, 'openclaw.json'), 'utf-8')).toBe(once);
    }, T);
  });

  describe('aquaman does not write openclaw.json itself', () => {
    const patchFile = () => path.join(sb.configDir, 'openclaw-setup.patch.json');
    const env = { AQUAMAN_OPENCLAW_VERSION: '2026.9.37', ANTHROPIC_API_KEY: 'sk-ant-env-value' };

    it('without an openclaw program: saves the patch, says how to apply it, and leaves the config alone', async () => {
      fs.mkdirSync(sb.openclawDir, { recursive: true });
      const file = path.join(sb.openclawDir, 'openclaw.json');
      fs.writeFileSync(file, '{"gateway":{"port":18789}}');
      const r = await setup(['--backend', 'encrypted-file'], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✗ OpenClaw config not changed: the `openclaw` program is not on PATH, and aquaman does not edit openclaw.json itself.');
      expect(r.stdout).toContain(`The change is saved as a patch, with no secret in it: ${patchFile()}`);
      expect(r.stdout).toContain('• SecretRef wiring for anthropic (canonical credential surface)');
      expect(r.stdout).toContain(`openclaw config patch --file ${patchFile()}`);
      expect(r.stdout).not.toContain('✓ SecretRef wiring');
      expect(fs.readFileSync(file, 'utf-8')).toBe('{"gateway":{"port":18789}}');

      const patch = JSON.parse(fs.readFileSync(patchFile(), 'utf-8'));
      expect(patch.models.providers.anthropic).toEqual({
        apiKey: { source: 'exec', provider: 'aquaman', id: 'anthropic/api_key' },
        baseUrl: 'http://127.0.0.1:8585/anthropic',
      });
      expect(patch.gateway).toBeUndefined();
      expect(fs.readFileSync(patchFile(), 'utf-8')).not.toMatch(/aqm_lb_|sk-ant/);
      expect(fs.statSync(patchFile()).mode & 0o777).toBe(0o600);
    }, T);

    it.each([
      ['OPENCLAW_CONFIG_READONLY', 'OPENCLAW_CONFIG_READONLY=1 marks the config as managed elsewhere'],
      ['OPENCLAW_NIX_MODE', 'OPENCLAW_NIX_MODE=1 marks the config as managed elsewhere'],
    ])('with %s=1: runs no config command and saves the patch', async (variable, reason) => {
      installFakeOpenClaw(sb.bin, { version: '2026.6.10' });
      const r = await setup(['--backend', 'encrypted-file'], { env: { ...env, [variable]: '1' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`✗ OpenClaw config not changed: ${reason}.`);
      expect(r.stdout).toContain('Put its contents into the source your deployment builds the config from.');
      expect(fakeOpenClawCalls(sb.bin).filter((c) => c.argv.includes('patch'))).toEqual([]);
      expect(fs.existsSync(path.join(sb.openclawDir, 'openclaw.json'))).toBe(false);
      expect(fs.existsSync(patchFile())).toBe(true);
    }, T);

    it('with $include in the config: saves the patch and applies nothing, because included settings are not visible', async () => {
      const original = { models: { $include: './models.json5' }, gateway: { port: 18789 } };
      sb.writeOpenClawJson(original);
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file'], { env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✗ OpenClaw config not changed: the config uses $include, and aquaman sees only the root file.');
      expect(r.stdout).toContain('Check it against the included files, then apply it:');
      expect(sb.readOpenClawJson()).toEqual(original);
      expect(fakeOpenClawCalls(sb.bin).filter((c) => c.argv.includes('patch'))).toEqual([]);
    }, T);

    it('when OpenClaw refuses the patch: exits 1 with what it said, and the config is as it was', async () => {
      sb.writeOpenClawJson({ gateway: { port: 18789 } });
      installFakeOpenClaw(sb.bin, { version: '2026.9.37', refusePatch: 'Config validation failed: models.providers.anthropic: nope' });
      const r = await setup(['--backend', 'encrypted-file'], { env });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ OpenClaw config not changed: Config change declined. No settings were saved. Config validation failed: models.providers.anthropic: nope');
      expect(r.stdout).toContain(`openclaw config patch --file ${patchFile()}`);
      expect(r.stdout).not.toContain('✓ SecretRef wiring');
      expect(sb.readOpenClawJson()).toEqual({ gateway: { port: 18789 } });
    }, T);

    it('does not take OpenClaw at its word: success without the settings in the file is a failure', async () => {
      // A program that answers every command with success and writes nothing.
      sb.fakeBin('openclaw', 'cat > /dev/null 2>&1 || true; echo "OpenClaw 2026.9.37 (abc1234)"');
      const r = await setup(['--backend', 'encrypted-file'], { env });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`✗ OpenClaw config not changed: OpenClaw reported success, but ${path.join(sb.openclawDir, 'openclaw.json')} does not hold the change`);
    }, T);

    it('--profile sets up that profile: its state directory, and `openclaw --profile` for the patch', async () => {
      installFakeOpenClaw(sb.bin, { version: '2026.9.37' });
      const r = await setup(['--backend', 'encrypted-file', '--profile', 'work'], { env });
      const state = path.join(sb.home, '.openclaw-work');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`✓ Plugin installed to ${path.join(state, 'extensions', 'aquaman-plugin')}`);
      expect(r.stdout).toContain(`(${path.join(state, 'openclaw.json')})`);
      expect(fakeOpenClawCalls(sb.bin).find((c) => c.stdin !== undefined)!.argv).toEqual(['--profile', 'work', 'config', 'patch', '--stdin']);
      expect(JSON.parse(fs.readFileSync(path.join(state, 'openclaw.json'), 'utf-8')).plugins.entries['aquaman-plugin'].enabled).toBe(true);
      // The default profile, which the environment points at, is not touched.
      expect(fs.existsSync(path.join(sb.openclawDir, 'openclaw.json'))).toBe(false);

      const bad = await setup(['--backend', 'encrypted-file', '--profile', '../x'], { env });
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('Invalid --profile: ../x');
    }, T);
  });

  describe('openclaw.json wiring, older installs', () => {
    it('2026.8.1+: flags a legacy auth-profiles.json that locks providers out, and leaves it in place', async () => {
      const profiles = path.join(sb.openclawDir, 'agents', 'main', 'agent', 'auth-profiles.json');
      fs.mkdirSync(path.dirname(profiles), { recursive: true });
      fs.writeFileSync(profiles, '{"version":1,"profiles":{}}');
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✗ A legacy auth-profiles.json from an older aquaman-plugin blocks providers on this OpenClaw');
      expect(r.stdout).toContain('Run once: openclaw doctor --fix');
      expect(fs.readFileSync(profiles, 'utf-8')).toBe('{"version":1,"profiles":{}}');

      // The same file on 2026.7.x is inert, so nothing is said about it.
      const older = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.7.33' } });
      expect(older.stdout).not.toContain('blocks providers');
    }, T);

    it.each([
      ['a tokenFile', { tokenFile: '/run/secrets/telegram' }, 'its token comes from tokenFile, whose precedence over a config token we will not guess at'],
      ['several accounts', { accounts: { a: { botToken: 'aquaman-proxy-managed' }, b: { botToken: 'aquaman-proxy-managed' } } }, 'multi-account channels need one vault entry per account'],
    ])('leaves a telegram channel with %s untouched and says why', async (_label, entry, reason) => {
      sb.writeConfig(baseConfig(sb));
      await addCredential(sb, 'telegram', 'bot_token', '123456:REAL-BOT-TOKEN');
      const original = { enabled: true, ...entry };
      sb.writeOpenClawJson({ channels: { telegram: original } });
      const r = await setup(['--backend', 'encrypted-file'], { env: { AQUAMAN_OPENCLAW_VERSION: '2026.9.37' } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`→ telegram left as-is: ${reason}`);
      expect(r.stdout).not.toContain('Channel traffic routed');
      expect(sb.readOpenClawJson().channels.telegram).toEqual(original);
      expect(sb.readConfig()).not.toContain('- telegram');
    }, T);
  });
});
