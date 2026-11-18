/**
 * `aquaman hermes setup|status|doctor|configure`, driven as a real process.
 *
 * The real `hermes` program never runs: PATH holds one private directory
 * (test/helpers/cov-cli-hosts.ts) and a fake `hermes` script is put there when
 * a test needs one to be "installed". HERMES_HOME and HERMES_MANAGED_DIR point
 * into the sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createSandbox, baseConfig, runCli, addCredential, type Sandbox } from '../helpers/cov-cli-hosts.js';

const T = 120_000;
const TOKEN = 'aqm_lb_0123456789abcdef0123456789abcdef';

function fakeHermes(sb: Sandbox, version = '0.23.1'): void {
  sb.fakeBin('hermes', `echo "Hermes Agent v${version} (2026.11.1)"`);
}

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
      expect(r.stdout).toContain(`~/.hermes/.env:    ${envFile()}`);
      expect(r.stdout).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:9911/anthropic');
      expect(r.stdout).toContain('OPENAI_BASE_URL=http://127.0.0.1:9911/openai/v1');
      expect(sb.readConfig()).toBe(before);
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('enables the listener, generates a token and writes the managed block into $HERMES_HOME/.env', async () => {
      sb.writeConfig(baseConfig(sb));
      fs.mkdirSync(sb.hermesHome, { recursive: true });
      fs.writeFileSync(envFile(), 'MY_OWN_VAR=keep-me\n');

      const r = await runCli(sb, ['hermes', 'setup', '--port', '9912']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('✓ Loopback listener enabled on http://127.0.0.1:9912');
      expect(r.stdout).toContain(`✓ Wrote Hermes env block to ${envFile()}`);
      expect(r.stdout).toContain('Hermes CLI not found on PATH. Install: uv tool install hermes-agent');
      expect(r.stdout).toContain('aquaman hermes doctor');

      const cfg = sb.readConfig();
      expect(cfg).toMatch(/loopback:\n\s+enabled: true/);
      expect(cfg).toContain('port: 9912');
      const token = /token: (aqm_lb_[A-Za-z0-9_-]+)/.exec(cfg)?.[1];
      expect(token).toBeTruthy();

      const dotenv = fs.readFileSync(envFile(), 'utf-8');
      expect(dotenv).toContain('MY_OWN_VAR=keep-me');
      expect(dotenv).toContain('# >>> aquaman managed >>>');
      expect(dotenv).toContain('AQUAMAN_LOOPBACK_URL=http://127.0.0.1:9912');
      expect(dotenv).toContain(`AQUAMAN_LOOPBACK_TOKEN=${token}`);
      expect(dotenv).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:9912/anthropic');
      expect(dotenv).toContain(`ANTHROPIC_API_KEY=${token}`);
      // The token is shown masked only.
      expect(r.all).not.toContain(token!);
    }, T);

    it('--no-write keeps an existing token, prints the env vars and reports a detected Hermes', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9913)));
      fakeHermes(sb);
      const r = await runCli(sb, ['hermes', 'setup', '--no-write']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Skipped writing ~/.hermes/.env (--no-write). Env vars:');
      expect(r.stdout).toContain(`AQUAMAN_LOOPBACK_TOKEN=${TOKEN}`);
      expect(r.stdout).toContain('✓ Hermes detected (v0.23.1)');
      expect(sb.readConfig()).toContain(`token: ${TOKEN}`);
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
      expect(r.stdout).toContain(`~/.hermes/.env:    not wired  (${envFile()})`);
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
        fs.writeFileSync(envFile(), '# >>> aquaman managed >>>\nX=1\n# <<< aquaman managed <<<\n');
        fs.mkdirSync(sb.managedDir, { recursive: true });
        fs.writeFileSync(path.join(sb.managedDir, '.env'), 'export ANTHROPIC_API_KEY=sk-admin\nOTHER=1\n');

        const r = await runCli(sb, ['hermes', 'status']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain(`Loopback listener: enabled  http://127.0.0.1:${srv.port}`);
        expect(r.stdout).toContain('Token:             aqm_lb_…cdef');
        expect(r.stdout).toContain(`~/.hermes/.env:    wired  (${envFile()})`);
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
      expect(r.stdout).toContain('✗ ~/.hermes/.env not wired — run: aquaman hermes setup');
      expect(r.stdout).toContain('✓ No managed-scope override of aquaman env vars');
      expect(r.stdout).toContain('✗ No credential for anthropic/api_key — run: aquaman credentials add anthropic api_key');
      expect(r.stdout).toContain('✗ No credential for openai/api_key — run: aquaman credentials add openai api_key');
      expect(r.stdout).toContain(`• No aquaman secret-source bindings in ${path.join(sb.hermesHome, 'config.yaml')} (optional)`);
      expect(r.stdout).toContain('• Hermes CLI not found on PATH (install: uv tool install hermes-agent)');
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
        fakeHermes(sb);

        const r = await runCli(sb, ['hermes', 'doctor']);
        expect(r.stdout).toContain(`✓ Loopback listener enabled (http://127.0.0.1:${srv.port})`);
        expect(r.stdout).toContain('✓ Loopback token configured');
        expect(r.stdout).toContain('✓ Loopback listener responding to /_health');
        expect(r.stdout).toContain(`✓ ~/.hermes/.env has the aquaman block (${envFile()})`);
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

    it('prints the env vars by default and with --dry-run, writing nothing', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9920)));
      for (const args of [['hermes', 'configure'], ['hermes', 'configure', '--method', 'dotenv', '--dry-run']]) {
        const r = await runCli(sb, args);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Hermes env vars (add to ~/.hermes/.env):');
        expect(r.stdout).toContain('AQUAMAN_LOOPBACK_URL=http://127.0.0.1:9920');
        expect(r.stdout).toContain(`OPENAI_API_KEY=${TOKEN}`);
        expect(r.stdout).toContain('OPENAI_BASE_URL=http://127.0.0.1:9920/openai/v1');
      }
      expect(fs.existsSync(envFile())).toBe(false);
    }, T);

    it('--method dotenv writes the block and is idempotent', async () => {
      sb.writeConfig(baseConfig(sb, loopback(9921)));
      const first = await runCli(sb, ['hermes', 'configure', '--method', 'dotenv']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Configuration written to: ${envFile()}`);
      const once = fs.readFileSync(envFile(), 'utf-8');
      expect(once).toContain(`ANTHROPIC_API_KEY=${TOKEN}`);
      // It holds the loopback token, so a file aquaman creates is owner-only.
      expect(fs.statSync(envFile()).mode & 0o777).toBe(0o600);

      const second = await runCli(sb, ['hermes', 'configure', '--method', 'dotenv']);
      expect(second.code).toBe(0);
      const twice = fs.readFileSync(envFile(), 'utf-8');
      expect(twice.match(/# >>> aquaman managed >>>/g)).toHaveLength(1);
      expect(twice).toBe(once);
    }, T);
  });
});
