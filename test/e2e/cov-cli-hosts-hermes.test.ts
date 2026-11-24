/**
 * `aquaman hermes setup|status|doctor|configure`, driven as a real process.
 *
 * The real `hermes` program never runs: PATH holds one private directory
 * (test/helpers/cov-cli-hosts.ts) and a stand-in `hermes`
 * (test/helpers/fake-hermes.ts) is put there when a test needs one to be
 * "installed". HERMES_HOME and HERMES_MANAGED_DIR point into the sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSandbox, baseConfig, runCli, addCredential, type Sandbox } from '../helpers/cov-cli-hosts.js';
import { installFakeHermes, fakeHermesCalls, type FakeHermesOptions } from '../helpers/fake-hermes.js';

const T = 120_000;
const TOKEN = 'aqm_lb_0123456789abcdef0123456789abcdef';

function fakeHermes(sb: Sandbox, version = '0.23.1', options: FakeHermesOptions = {}): void {
  installFakeHermes(sb.bin, { version, ...options });
}

/** The `config set` invocations of the stand-in, as `KEY` names in order. */
const setKeys = (sb: Sandbox): string[] => fakeHermesCalls(sb.bin).filter((c) => c.includes('set')).map((c) => c[c.length - 2]);

const ALL_KEYS = [
  'AQUAMAN_LOOPBACK_URL', 'AQUAMAN_LOOPBACK_TOKEN',
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY',
];

/** A stand-in for the loopback listener: answers /_health and nothing else. */
async function healthServer(status = 200): Promise<{ port: number; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === '/_health' ? status : 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const s = await healthServer();
  await s.close();
  return s.port;
}

const loopback = (port: number, token: string | null = TOKEN): string[] => [
  'loopback:',
  '  enabled: true',
  `  port: ${port}`,
  '  host: 127.0.0.1',
  ...(token ? [`  token: ${token}`] : []),
];

describe('aquaman hermes (cli-hosts coverage)', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); });
  afterEach(() => { sb.cleanup(); });

  const envFile = () => path.join(sb.hermesHome, '.env');

  describe('setup', () => {
    it('rejects a port outside 1-65535 and writes nothing', async () => {
      sb.writeConfig(baseConfig(sb));
      const before = sb.readConfig();
      for (const bad of ['99999', '0', 'abc']) {
        const r = await runCli(sb, ['hermes', 'setup', '--port', bad]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain(`Invalid --port: ${bad}`);
      }
      expect(sb.readConfig()).toBe(before);
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('--dry-run shows the plan with a masked token and changes no file', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9911)));
      const before = sb.readConfig();
      const r = await runCli(sb, ['hermes', 'setup', '--dry-run']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Dry run');
      expect(r.stdout).toContain('Loopback listener: http://127.0.0.1:9911  (enabled)');
      // prefix + last four, never the whole token
      expect(r.stdout).toContain('Token:             aqm_lb_…cdef');
      expect(r.stdout).toContain('Wired services:    anthropic, openai');
      expect(r.stdout).toContain(`Hermes .env:       ${envFile()}`);
      expect(r.stdout).toContain('Settings, stored with `hermes config set`:');
      expect(r.stdout).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:9911/anthropic');
      expect(r.stdout).toContain('OPENAI_BASE_URL=http://127.0.0.1:9911/openai/v1');
      expect(sb.readConfig()).toBe(before);
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('enables the listener, generates a token and stores the settings through `hermes config set`', async () => {
      sb.writeConfig(baseConfig(sb));
      fakeHermes(sb);
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      fs.writeFileSync(envFile(), 'MY_OWN_VAR=keep-me\n', { mode: 0o600 });

      const r = await runCli(sb, ['hermes', 'setup', '--port', '9912']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Loopback listener enabled on http://127.0.0.1:9912');
      expect(r.stdout).toContain(`✓ Stored 6 settings with \`hermes config set\` (${envFile()})`);
      expect(r.stdout).toContain('✓ Hermes detected (v0.23.1)');
      expect(r.stdout).toContain('aquaman hermes doctor');
      expect(r.stdout).not.toContain('can be read by other users');

      const cfg = sb.readConfig();
      expect(cfg).toMatch(/loopback:\n\s+enabled: true/);
      expect(cfg).toContain('port: 9912');
      const token = /token: (aqm_lb_[A-Za-z0-9_-]+)/.exec(cfg)?.[1];
      expect(token).toBeTruthy();

      // Hermes wrote the file: its own line is kept and nothing of aquaman's but the settings is added.
      expect(setKeys(sb)).toEqual(ALL_KEYS);
      expect(fs.readFileSync(envFile(), 'utf-8')).toBe([
        'MY_OWN_VAR=keep-me',
        'AQUAMAN_LOOPBACK_URL=http://127.0.0.1:9912',
        `AQUAMAN_LOOPBACK_TOKEN=${token}`,
        'ANTHROPIC_BASE_URL=http://127.0.0.1:9912/anthropic',
        `ANTHROPIC_API_KEY=${token}`,
        'OPENAI_BASE_URL=http://127.0.0.1:9912/openai/v1',
        `OPENAI_API_KEY=${token}`,
        '',
      ].join('\n'));
      // The token is shown masked only.
      expect(r.all).not.toContain(token!);
    }, T);

    it('sets up the named profile, and only that one', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9914)));
      fakeHermes(sb);
      const profileEnv = path.join(sb.hermesHome, 'profiles', 'work', '.env');
      fs.mkdirSync(path.dirname(profileEnv), { recursive: true });

      const r = await runCli(sb, ['hermes', 'setup', '--profile', 'Work']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`✓ Stored 6 settings with \`hermes config set\` (${profileEnv})`);
      expect(r.stdout).toContain('aquaman hermes doctor --profile work');
      expect(fakeHermesCalls(sb.bin).filter((c) => c.includes('set')).every((c) => c[0] === '-p' && c[1] === 'work')).toBe(true);
      expect(fs.readFileSync(profileEnv, 'utf-8')).toContain(`ANTHROPIC_API_KEY=${TOKEN}`);
      expect(fs.existsSync(envFile())).toBe(false);

      const status = await runCli(sb, ['hermes', 'status', '--profile', 'work']);
      expect(status.stdout).toContain(`Hermes .env:       wired  (${profileEnv})`);
      const other = await runCli(sb, ['hermes', 'status']);
      expect(other.stdout).toContain(`Hermes .env:       not wired  (${envFile()})`);
    }, T);

    it('refuses a profile name Hermes would not accept, before anything is written', async () => {
      sb.writeConfig(baseConfig(sb));
      fakeHermes(sb);
      const before = sb.readConfig();
      for (const bad of ['../x', 'a b', '-p', '']) {
        for (const command of ['setup', 'status', 'doctor', 'configure']) {
          const r = await runCli(sb, ['hermes', command, `--profile=${bad}`]);
          expect(r.code).toBe(1);
          expect(r.stderr).toContain(`Invalid --profile: ${bad}`);
        }
      }
      expect(sb.readConfig()).toBe(before);
      expect(fakeHermesCalls(sb.bin)).toEqual([]);
    }, T);

    it('fails with what Hermes said when the profile does not exist', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9915)));
      fakeHermes(sb);
      const r = await runCli(sb, ['hermes', 'setup', '--profile', 'nosuch']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("✗ `hermes config set AQUAMAN_LOOPBACK_URL` failed: Error: Profile 'nosuch' does not exist.");
      expect(r.stdout).toContain('aquaman hermes configure --profile nosuch');
      expect(r.all).not.toContain(TOKEN);
    }, T);

    it('stores nothing in Hermes without a Hermes program, and says how to finish', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9916)));
      const r = await runCli(sb, ['hermes', 'setup']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('• Hermes CLI not found on PATH, so nothing was stored in Hermes.');
      expect(r.stdout).toContain('print the commands with: aquaman hermes configure');
      expect(r.stdout).toContain('• Install Hermes: https://hermes-agent.nousresearch.com/docs/getting-started/installation');
      expect(fs.existsSync(sb.hermesHome)).toBe(false);
      expect(r.all).not.toContain(TOKEN);
    }, T);

    it('runs no `config set` on a Hermes that would put part of the settings in config.yaml', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9917)));
      fakeHermes(sb, '0.19.0');
      const r = await runCli(sb, ['hermes', 'setup']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('• Hermes 0.19.0: `hermes config set` stores every setting in .env from 0.21.4 on.');
      expect(r.stdout).toContain('so nothing was run');
      expect(r.stdout).toContain(`Add the lines that aquaman hermes configure prints to ${envFile()}`);
      expect(setKeys(sb)).toEqual([]);
      expect(fs.existsSync(path.join(sb.hermesHome, 'config.yaml'))).toBe(false);
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('does not replace a real provider key in the file unless --replace-keys is given', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9918)));
      fakeHermes(sb);
      const real = 'sk-ant-' + 'k'.repeat(24);
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      fs.writeFileSync(envFile(), `ANTHROPIC_API_KEY=${real}\n`, { mode: 0o600 });

      const refused = await runCli(sb, ['hermes', 'setup']);
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain(`✗ ${envFile()} holds a key in ANTHROPIC_API_KEY, and \`hermes config set\` would replace it.`);
      expect(refused.stdout).toContain('aquaman credentials add anthropic api_key');
      expect(refused.stdout).toContain('then run: aquaman hermes setup --replace-keys');
      expect(refused.all).not.toContain(real);
      expect(setKeys(sb)).toEqual([]);
      expect(fs.readFileSync(envFile(), 'utf-8')).toBe(`ANTHROPIC_API_KEY=${real}\n`);

      const replaced = await runCli(sb, ['hermes', 'setup', '--replace-keys']);
      expect(replaced.code).toBe(0);
      expect(fs.readFileSync(envFile(), 'utf-8')).toContain(`ANTHROPIC_API_KEY=${TOKEN}`);
      // A second run finds its own placeholder and needs no flag.
      expect((await runCli(sb, ['hermes', 'setup'])).code).toBe(0);
    }, T);

    it('stops at a setting Hermes refuses, names it, and prints no value', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9919)));
      fakeHermes(sb, '0.23.1', { refuseKey: 'ANTHROPIC_BASE_URL' });
      const r = await runCli(sb, ['hermes', 'setup']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ `hermes config set ANTHROPIC_BASE_URL` failed:');
      expect(r.stdout).toContain('it is managed by your administrator');
      expect(r.stdout).toContain('Stored before that: AQUAMAN_LOOPBACK_URL, AQUAMAN_LOOPBACK_TOKEN');
      expect(setKeys(sb)).toEqual(['AQUAMAN_LOOPBACK_URL', 'AQUAMAN_LOOPBACK_TOKEN', 'ANTHROPIC_BASE_URL']);
      expect(r.all).not.toContain(TOKEN);
      expect(r.all).not.toContain('http://127.0.0.1:9919/anthropic');
    }, T);

    it('fails when Hermes reports success and the settings are not in the file', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9922)));
      fakeHermes(sb, '0.23.1', { storeNothing: true });
      const r = await runCli(sb, ['hermes', 'setup']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Hermes reported success, but AQUAMAN_LOOPBACK_URL');
      expect(r.all).not.toContain(TOKEN);
    }, T);

    it('says when the file Hermes kept can be read by other users', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9923)));
      fakeHermes(sb);
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      fs.writeFileSync(envFile(), 'MY_OWN_VAR=1\n');
      fs.chmodSync(envFile(), 0o644);
      const r = await runCli(sb, ['hermes', 'setup']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`⚠ ${envFile()} can be read by other users of this machine, and it now holds the loopback token.`);
      expect(r.stdout).toContain(`chmod 600 ${envFile()}`);
      const doctor = await runCli(sb, ['hermes', 'doctor']);
      expect(doctor.code).toBe(1);
      expect(doctor.stdout).toContain(`✗ ${envFile()} can be read by other users of this machine and holds the loopback token — run: chmod 600 ${envFile()}`);
    }, T);

    it('--no-write keeps an existing token, prints the settings and the commands, and runs none', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9913)));
      fakeHermes(sb);
      const r = await runCli(sb, ['hermes', 'setup', '--no-write', '--profile', 'work']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Stored nothing in Hermes (--no-write). Settings:');
      expect(r.stdout).toContain(`AQUAMAN_LOOPBACK_TOKEN=${TOKEN}`);
      expect(r.stdout).toContain('  hermes -p work config set ANTHROPIC_BASE_URL http://127.0.0.1:9913/anthropic');
      expect(r.stdout).toContain('✓ Hermes detected (v0.23.1)');
      expect(sb.readConfig()).toContain(`token: ${TOKEN}`);
      expect(setKeys(sb)).toEqual([]);
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('says so when no Hermes-supported service is proxied', async () => {
      sb.writeConfig([
        'credentials:', '  backend: encrypted-file', '  proxiedServices:', '    - github',
      ]);
      const r = await runCli(sb, ['hermes', 'setup', '--dry-run']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('No Hermes-supported services (anthropic, openai) are in your proxiedServices list.');
      expect(r.stdout).toContain('aquaman credentials add anthropic api_key');
      expect(r.stdout).toContain('Wired services:    (none)');
      expect(r.stdout).not.toContain('ANTHROPIC_BASE_URL');
    }, T);
  });

  describe('status', () => {
    it('reports a disabled listener with the command that enables it', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['hermes', 'status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Loopback listener: disabled  (enable with: aquaman hermes setup)');
      expect(r.stdout).toContain('Wired services:    anthropic, openai');
      expect(r.stdout).toContain(`Hermes .env:       not wired  (${envFile()})`);
      expect(r.stdout).toContain('Hermes CLI:        not found');
      expect(r.stdout).not.toContain('Listener:');
      expect(r.stdout).not.toContain('Managed scope');
    }, T);

    it('reports an enabled listener without a token, and that nothing answers on its port', async () => {
      sb.writeConfig(baseConfig(sb, loopback(await deadPort(), null)));
      const r = await runCli(sb, ['hermes', 'status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Loopback listener: enabled');
      expect(r.stdout).toContain('Token:             MISSING — run: aquaman hermes setup');
      expect(r.stdout).toContain('Listener:          not responding (is the daemon running?)');
    }, T);

    it('reports wiring, a responding listener, the Hermes version and a managed-scope override', async () => {
      const srv = await healthServer();
      try {
        sb.writeConfig(baseConfig(sb, loopback(srv.port)));
        fakeHermes(sb, '0.19.0');
        fs.mkdirSync(sb.hermesHome, { recursive: true });
        // A file from an aquaman that wrote its own block: the settings in it still count.
        fs.writeFileSync(envFile(), [
          '# >>> aquaman managed >>>',
          `AQUAMAN_LOOPBACK_URL=http://127.0.0.1:${srv.port}`, `AQUAMAN_LOOPBACK_TOKEN=${TOKEN}`,
          `ANTHROPIC_BASE_URL=http://127.0.0.1:${srv.port}/anthropic`, `ANTHROPIC_API_KEY=${TOKEN}`,
          `OPENAI_BASE_URL=http://127.0.0.1:${srv.port}/openai/v1`, `OPENAI_API_KEY=${TOKEN}`,
          '# <<< aquaman managed <<<', '',
        ].join('\n'), { mode: 0o600 });
        fs.mkdirSync(sb.managedDir, { recursive: true });
        fs.writeFileSync(path.join(sb.managedDir, '.env'), 'export ANTHROPIC_API_KEY=sk-admin\nOTHER=1\n');

        const r = await runCli(sb, ['hermes', 'status']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(`Loopback listener: enabled  http://127.0.0.1:${srv.port}`);
        expect(r.stdout).toContain('Token:             aqm_lb_…cdef');
        expect(r.stdout).toContain(`Hermes .env:       wired  (${envFile()})`);
        expect(r.stdout).toContain(`Managed scope:     ⚠ ${path.join(sb.managedDir, '.env')} pins ANTHROPIC_API_KEY — proxy bypassed for these keys`);
        expect(r.stdout).toContain('Hermes CLI:        v0.19.0');
        expect(r.stdout).toContain('Listener:          responding');
        expect(r.stdout).not.toContain(TOKEN);
      } finally {
        await srv.close();
      }
    }, T);
  });

  describe('doctor', () => {
    it('fails every check on an unconfigured install, each with its fix, and exits 1', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['hermes', 'doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Loopback listener is disabled — run: aquaman hermes setup');
      expect(r.stdout).toContain(`✗ Hermes .env not wired (${envFile()}) — run: aquaman hermes setup`);
      expect(r.stdout).toContain('✓ No managed-scope override of aquaman env vars');
      expect(r.stdout).toContain('✗ No credential for anthropic/api_key — run: aquaman credentials add anthropic api_key');
      expect(r.stdout).toContain('✗ No credential for openai/api_key — run: aquaman credentials add openai api_key');
      expect(r.stdout).toContain(`• No aquaman secret-source bindings in ${path.join(sb.hermesHome, 'config.yaml')} (optional)`);
      expect(r.stdout).toContain('• Hermes CLI not found on PATH (install: https://hermes-agent.nousresearch.com/docs/getting-started/installation)');
      expect(r.stdout).toContain('Some checks failed — see above.');
      // The listener is off, so its reachability is not probed.
      expect(r.stdout).not.toContain('/_health');
    }, T);

    it('passes every check on a fully wired install and exits 0', async () => {
      const srv = await healthServer();
      try {
        sb.writeConfig(baseConfig(sb, [
          ...loopback(srv.port),
          'broker:', '  allowedRefs:', '    - aquaman://github/token',
        ]));
        await addCredential(sb, 'anthropic', 'api_key', 'sk-ant-test-value');
        await addCredential(sb, 'openai', 'api_key', 'sk-openai-test-value');
        fakeHermes(sb);
        const cfg = await runCli(sb, ['hermes', 'configure', '--method', 'dotenv']);
        expect(cfg.code).toBe(0);
        fs.writeFileSync(path.join(sb.hermesHome, 'config.yaml'), [
          'secrets:', '  aquaman:', '    env:',
          '      GITHUB_TOKEN: aquaman://github/token',
          // Provider keys are refused by the source, so they are not bindings to check.
          '      ANTHROPIC_API_KEY: aquaman://anthropic/api_key',
          '      NOT_A_REF: plain-value',
          '',
        ].join('\n'));

        const r = await runCli(sb, ['hermes', 'doctor']);
        expect(r.stdout).toContain(`✓ Loopback listener enabled (http://127.0.0.1:${srv.port})`);
        expect(r.stdout).toContain('✓ Loopback token configured');
        expect(r.stdout).toContain('✓ Loopback listener responding to /_health');
        expect(r.stdout).toContain(`✓ Hermes .env points at the proxy (${envFile()})`);
        expect(r.stdout).toContain('✓ Vault credential anthropic/api_key resolves');
        expect(r.stdout).toContain('✓ Vault credential openai/api_key resolves');
        expect(r.stdout).toContain('✓ All 1 secret-source binding(s) are declared to the broker');
        expect(r.stdout).toContain('✓ Hermes CLI installed (v0.23.1)');
        expect(r.stdout).toContain('All checks passed.');
        expect(r.stdout).not.toContain('✗');
        expect(r.code).toBe(0);
        // No credential value or token in a diagnostic.
        expect(r.all).not.toContain('sk-ant-test-value');
        expect(r.all).not.toContain(TOKEN);
      } finally {
        await srv.close();
      }
    }, T);

    it('fails on a missing token, a dead listener, a managed-scope override and undeclared bindings', async () => {
      sb.writeConfig(baseConfig(sb, loopback(await deadPort(), null)));
      fs.mkdirSync(sb.managedDir, { recursive: true });
      fs.writeFileSync(path.join(sb.managedDir, '.env'), 'OPENAI_BASE_URL=https://corp.example\nAQUAMAN_LOOPBACK_URL=x\n');
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      fs.writeFileSync(path.join(sb.hermesHome, 'config.yaml'), [
        'secrets:', '  aquaman:', '    env:',
        '      GITHUB_TOKEN: aquaman://github/token',
        '      STRIPE_KEY: aquaman://stripe/api_key',
        '',
      ].join('\n'));

      const r = await runCli(sb, ['hermes', 'doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Loopback token missing — run: aquaman hermes setup');
      expect(r.stdout).toContain('✗ Loopback listener not responding — start the daemon: aquaman daemon');
      expect(r.stdout).toContain(`✗ Hermes managed scope (${path.join(sb.managedDir, '.env')}) pins AQUAMAN_LOOPBACK_URL, OPENAI_BASE_URL`);
      expect(r.stdout).toContain('the proxy is BYPASSED for these keys');
      expect(r.stdout).toContain('✗ Secret-source binding(s) not declared to the broker, so the daemon refuses them: aquaman://github/token, aquaman://stripe/api_key');
      expect(r.stdout).toContain('→ aquaman broker allow aquaman://github/token aquaman://stripe/api_key');
    }, T);

    it('fails when bindings exist but the broker is switched off', async () => {
      sb.writeConfig(baseConfig(sb, ['broker:', '  enabled: false']));
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      const hermesConfig = path.join(sb.hermesHome, 'config.yaml');
      fs.writeFileSync(hermesConfig, 'secrets:\n  aquaman:\n    env:\n      GITHUB_TOKEN: aquaman://github/token\n');
      const r = await runCli(sb, ['hermes', 'doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`✗ 1 secret-source binding(s) in ${hermesConfig}, but broker.enabled is false — none will resolve`);
    }, T);

    it('fails on an unparseable Hermes config and an unreadable .env instead of passing them', async () => {
      sb.writeConfig(baseConfig(sb));
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      fs.writeFileSync(path.join(sb.hermesHome, 'config.yaml'), 'secrets: [unclosed\n  - : :\n');
      // A directory where the file should be: it exists, and reading it throws.
      fs.mkdirSync(envFile());
      const r = await runCli(sb, ['hermes', 'doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`✗ Could not read ${envFile()}`);
      expect(r.stdout).toMatch(/✗ Hermes config unreadable \(cannot parse .*config\.yaml: [\s\S]*\) — can't check secret-source bindings/);
    }, T);

    it('fails when no supported service is proxied, and when the vault backend cannot start', async () => {
      sb.writeConfig(['credentials:', '  backend: encrypted-file', '  proxiedServices:', '    - github']);
      const none = await runCli(sb, ['hermes', 'doctor']);
      expect(none.code).toBe(1);
      expect(none.stdout).toContain('✗ No Hermes-supported services configured (anthropic, openai)');

      // HashiCorp Vault backend with no address: the store cannot be created.
      sb.writeConfig(['credentials:', '  backend: vault', '  proxiedServices:', '    - anthropic']);
      const broken = await runCli(sb, ['hermes', 'doctor']);
      expect(broken.code).toBe(1);
      expect(broken.stdout).toMatch(/✗ Vault backend "vault" failed: .+/);
    }, T);
  });

  describe('configure', () => {
    it('refuses without a loopback token', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['hermes', 'configure']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('No loopback token configured. Run `aquaman hermes setup` first.');
    }, T);

    it('prints the settings and the commands by default and with --dry-run, storing nothing', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9920)));
      fakeHermes(sb);
      for (const args of [['hermes', 'configure'], ['hermes', 'configure', '--method', 'dotenv', '--dry-run']]) {
        const r = await runCli(sb, args);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Hermes settings:');
        expect(r.stdout).toContain('AQUAMAN_LOOPBACK_URL=http://127.0.0.1:9920');
        expect(r.stdout).toContain(`OPENAI_API_KEY=${TOKEN}`);
        expect(r.stdout).toContain('Store them with Hermes 0.21.4 or later:');
        expect(r.stdout).toContain('  hermes config set OPENAI_BASE_URL http://127.0.0.1:9920/openai/v1');
        expect(r.stdout).toContain(`On an earlier Hermes, add the lines above to ${envFile()}`);
      }
      const named = await runCli(sb, ['hermes', 'configure', '--profile', 'work']);
      expect(named.stdout).toContain(`  hermes -p work config set AQUAMAN_LOOPBACK_TOKEN ${TOKEN}`);
      expect(setKeys(sb)).toEqual([]);
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('--method dotenv stores through Hermes and is the same on a second run', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9921)));
      fakeHermes(sb);
      const first = await runCli(sb, ['hermes', 'configure', '--method', 'dotenv']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`✓ Stored 6 settings with \`hermes config set\` (${envFile()})`);
      const once = fs.readFileSync(envFile(), 'utf-8');
      expect(once).toContain(`ANTHROPIC_API_KEY=${TOKEN}`);
      expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600);

      const second = await runCli(sb, ['hermes', 'configure', '--method', 'dotenv']);
      expect(second.code).toBe(0);
      expect(fs.readFileSync(envFile(), 'utf-8')).toBe(once);
    }, T);

    it('--method dotenv exits 1 when Hermes refuses a setting', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9924)));
      fakeHermes(sb, '0.23.1', { refuseKey: 'AQUAMAN_LOOPBACK_URL' });
      const r = await runCli(sb, ['hermes', 'configure', '--method', 'dotenv']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ `hermes config set AQUAMAN_LOOPBACK_URL` failed:');
    }, T);
  });
});
