/**
 * `aquaman openclaw doctor`: each check's pass and fail branch, the fix it
 * prints and the exit code.
 *
 * The real `openclaw` never runs. PATH holds one private directory
 * (test/helpers/cov-cli-hosts.ts); "installed" means a fake script there. The
 * proxy the doctor probes is a local HTTP server on the sandbox's socket path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { createSandbox, baseConfig, runCli, addCredential, type Sandbox } from '../helpers/cov-cli-hosts.js';

const T = 120_000;
const VERSION: string = JSON.parse(fs.readFileSync(path.resolve('packages/proxy/package.json'), 'utf-8')).version;

const PLUGIN_ENTRY = { enabled: true, config: { backend: 'encrypted-file', services: ['anthropic', 'openai'] } };
const SECRET_PROVIDER = {
  providers: { aquaman: { source: 'exec', pluginIntegration: { pluginId: 'aquaman-plugin', integrationId: 'aquaman' } } },
};
const ref = (svc: string) => ({ source: 'exec', provider: 'aquaman', id: `${svc}/api_key` });
const ROUTED_MODELS = {
  providers: {
    anthropic: { apiKey: ref('anthropic'), baseUrl: 'http://127.0.0.1:8585/anthropic' },
    openai: { apiKey: ref('openai'), baseUrl: 'http://127.0.0.1:8585/openai/v1' },
  },
};
/** openclaw.json as `aquaman openclaw setup` leaves it on a current gateway. */
const wired = (extra: Record<string, any> = {}) => ({
  plugins: { entries: { 'aquaman-plugin': PLUGIN_ENTRY } },
  secrets: SECRET_PROVIDER,
  models: ROUTED_MODELS,
  ...extra,
});

function installPlugin(sb: Sandbox, version: string | null = VERSION): void {
  const dir = path.join(sb.openclawDir, 'extensions', 'aquaman-plugin');
  fs.mkdirSync(dir, { recursive: true });
  if (version) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'aquaman-plugin', version }));
}

function writeAuthProfiles(sb: Sandbox, file = 'auth-profiles.json'): void {
  const dir = path.join(sb.openclawDir, 'agents', 'main', 'agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), '{}');
}

/** Stand-in for the proxy on `<configDir>/proxy.sock`. */
async function fakeProxy(sb: Sandbox, health: { status?: number; body: unknown }): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === '/_health' ? (health.status ?? 200) : 404;
    res.end(JSON.stringify(health.body));
  });
  await new Promise<void>((resolve) => server.listen(path.join(sb.configDir, 'proxy.sock'), resolve));
  return () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
}

describe('aquaman openclaw doctor (cli-hosts coverage)', () => {
  let sb: Sandbox;
  let closers: Array<() => Promise<void>>;
  beforeEach(() => { sb = createSandbox(); closers = []; });
  afterEach(async () => {
    for (const c of closers) await c();
    sb.cleanup();
  });

  const doctor = (env: Record<string, string | undefined> = {}) => runCli(sb, ['openclaw', 'doctor'], { env });
  const withAudit = () => fs.mkdirSync(path.join(sb.configDir, 'audit'), { recursive: true });

  it('passes every check on a fully wired install and exits 0', async () => {
    sb.writeConfig(baseConfig(sb));
    withAudit();
    await addCredential(sb, 'anthropic', 'api_key', 'sk-ant-doctor-value');
    closers.push(await fakeProxy(sb, { body: { status: 'ok', version: VERSION } }));
    sb.fakeBin('openclaw', 'echo "OpenClaw 2026.9.37"');
    installPlugin(sb);
    sb.writeOpenClawJson(wired());

    const r = await doctor();
    expect(r.stdout).toContain(`✓ Config exists (${path.join(sb.configDir, 'config.yaml')})`);
    expect(r.stdout).toContain('✓ Backend: encrypted-file (accessible)');
    expect(r.stdout).toContain('✓ Stored securely: anthropic/api_key (1 in encrypted-file)');
    expect(r.stdout).toContain(`✓ Proxy running on socket (v${VERSION})`);
    expect(r.stdout).toContain('✓ Audit directory writable (no entries yet)');
    // The version comes from the program on PATH when nothing pins it.
    expect(r.stdout).toContain('✓ OpenClaw installed (OpenClaw 2026.9.37)');
    expect(r.stdout).toContain(`✓ Plugin installed v${VERSION}`);
    expect(r.stdout).toContain('✓ Plugin configured in openclaw.json');
    expect(r.stdout).toContain('✓ Plugin allowed (no plugins.allow trust list');
    expect(r.stdout).toContain('✓ SecretRef wiring active (anthropic, openai)');
    expect(r.stdout).toContain('✓ Model routing through the proxy for anthropic, openai');
    expect(r.stdout).toContain('✓ Auth profiles not needed (SecretRef wiring replaces the placeholder flow)');
    expect(r.stdout).toContain('✓ Unmigrated: none (all credentials secured)');
    expect(r.stdout).toContain('All checks passed.');
    expect(r.stdout).not.toContain('✗');
    // Nothing exported in this shell, so no environment note.
    expect(r.stdout).not.toContain('Environment');
    expect(r.code).toBe(0);
    expect(r.all).not.toContain('sk-ant-doctor-value');
  }, T);

  describe('backend', () => {
    it.each([
      ['systemd-creds', undefined],
      ['keeper', undefined],
      ['bitwarden', undefined],
      // Installed and logged in, but locked and no BW_SESSION.
      ['bitwarden', 'echo \'{"status":"locked"}\''],
    ])('reports %s as not accessible when its program is missing or locked', async (backend, fakeBw) => {
      sb.writeConfig(['credentials:', `  backend: ${backend}`, '  proxiedServices:', '    - anthropic']);
      if (fakeBw) sb.fakeBin('bw', fakeBw);
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Backend not accessible');
      expect(r.stdout).toContain('→ Run: aquaman setup');
      expect(r.stdout).not.toContain('Stored securely');
    }, T);

    it('fails when the vault is reachable but empty', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✓ Backend: encrypted-file (accessible)');
      expect(r.stdout).toContain('✗ Stored securely: none');
      expect(r.stdout).toContain('→ Run: aquaman credentials add anthropic api_key');
    }, T);
  });

  describe('proxy', () => {
    it('fails on a proxy of a different version, with the update command', async () => {
      sb.writeConfig(baseConfig(sb));
      closers.push(await fakeProxy(sb, { body: { status: 'ok', version: '0.0.1' } }));
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✓ Proxy running on socket (v0.0.1)');
      expect(r.stdout).toContain(`✗ Version mismatch: CLI v${VERSION} ≠ proxy v0.0.1`);
      expect(r.stdout).toContain('→ Update: npm install -g aquaman-proxy');
    }, T);

    it('accepts a proxy that reports no version', async () => {
      sb.writeConfig(baseConfig(sb));
      closers.push(await fakeProxy(sb, { body: { status: 'ok' } }));
      const r = await doctor();
      expect(r.stdout).toContain('✓ Proxy running on socket (vunknown)');
      expect(r.stdout).not.toContain('Version mismatch');
    }, T);

    it('treats an error answer from the socket as not running, and names how the plugin starts it', async () => {
      sb.writeConfig(baseConfig(sb));
      closers.push(await fakeProxy(sb, { status: 503, body: { error: 'starting' } }));
      installPlugin(sb);
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Proxy not running on socket');
      expect(r.stdout).toContain('→ Proxy starts automatically with OpenClaw. Run: openclaw');
    }, T);
  });

  describe('audit', () => {
    it('notes a disabled audit log without counting it as an issue', async () => {
      sb.writeConfig(['credentials:', '  backend: encrypted-file', 'audit:', '  enabled: false']);
      const r = await doctor();
      expect(r.stdout).toContain('- Audit disabled in config');
      expect(r.stdout).not.toContain('✗ Audit');
    }, T);

    it('counts the entries of an existing log', async () => {
      sb.writeConfig(baseConfig(sb));
      withAudit();
      fs.writeFileSync(path.join(sb.configDir, 'audit', 'current.jsonl'), '{"a":1}\n{"a":2}\n{"a":3}\n');
      const r = await doctor();
      expect(r.stdout).toContain('✓ Audit log writable (3 entries)');
    }, T);

    it('fails on a log it cannot write to', async () => {
      sb.writeConfig(baseConfig(sb));
      withAudit();
      const log = path.join(sb.configDir, 'audit', 'current.jsonl');
      fs.writeFileSync(log, '{"a":1}\n', { mode: 0o400 });
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`✗ Audit log not writable (${log})`);
      expect(r.stdout).toContain('→ Check file permissions on ~/.aquaman/audit/');
    }, T);
  });

  describe('policy', () => {
    it('summarises a valid policy and its deny rules', async () => {
      sb.writeConfig(baseConfig(sb, [
        'policy:',
        '  anthropic:',
        '    defaultAction: allow',
        '    rules:',
        '      - { method: "*", path: "/v1/organizations/**", action: deny }',
        '      - { method: DELETE, path: "/v1/files/*", action: deny }',
        '      - { method: GET, path: "/v1/models", action: allow }',
      ]));
      const r = await doctor();
      expect(r.stdout).toContain('✓ Policy valid (1 service, 3 rules)');
      expect(r.stdout).toContain('anthropic: deny /v1/organizations/**, deny DELETE /v1/files/*');
      expect(r.stdout).not.toContain('✗ Policy');
      expect(r.stdout).not.toContain('not configured');
    }, T);

    it('fails on a deny rule that can never match and on rules for a service that is not proxied', async () => {
      sb.writeConfig(baseConfig(sb, [
        'policy:',
        '  slack:',
        '    defaultAction: allow',
        '    rules:',
        '      - { method: "*", path: "/admin.*", action: deny }',
      ]));
      withAudit();
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("✗ Policy slack: deny rule '/admin.*' never matches real Slack traffic");
      expect(r.stdout).toContain('⚠ Policy service "slack" has rules but is not in proxiedServices');
      // Two separate issues, on top of the empty vault and the stopped proxy.
      expect(r.stdout).toContain('4 issues found.');
    }, T);

    it('fails on an invalid rule and names it', async () => {
      sb.writeConfig(baseConfig(sb, [
        'policy:',
        '  openai:',
        '    defaultAction: allow',
        '    rules:',
        '      - { method: GET, path: "v1/models", action: deny }',
      ]));
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Policy rule 1 for "openai" has path "v1/models" that doesn\'t start with /');
      expect(r.stdout).not.toContain('Policy valid');
    }, T);
  });

  describe('OpenClaw detection', () => {
    it('skips the plugin checks when neither the program nor the state dir exists', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await doctor();
      expect(r.stdout).toContain('- OpenClaw not detected (skipping plugin checks)');
      expect(r.stdout).not.toContain('Plugin');
      expect(r.stdout).not.toContain('Unmigrated');
      expect(r.stdout).toContain('→ Install plugin first: aquaman setup');
    }, T);

    it('detects OpenClaw from its state dir alone', async () => {
      sb.writeConfig(baseConfig(sb));
      fs.mkdirSync(sb.openclawDir);
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✓ OpenClaw detected (state dir found)');
      expect(r.stdout).toContain('✗ Plugin not installed');
      expect(r.stdout).toContain('✗ openclaw.json not found');
      expect(r.stdout).toContain('✗ Auth profiles missing');
    }, T);

    it('still counts OpenClaw as installed when its --version fails', async () => {
      sb.writeConfig(baseConfig(sb));
      sb.fakeBin('openclaw', 'exit 3');
      const r = await doctor();
      expect(r.stdout).toMatch(/✓ OpenClaw installed\n/);
      expect(r.stdout).toContain('✗ Plugin not installed');
    }, T);
  });

  describe('plugin', () => {
    it('fails on a plugin of another version and explains the 2026.11 provenance report', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb, '0.14.0');
      sb.writeOpenClawJson(wired());
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.11.3' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✓ Plugin installed v0.14.0');
      expect(r.stdout).toContain('→ Plugin source OpenClaw 2026.11+ reports "can\'t verify where this plugin came from"');
      expect(r.stdout).toContain(`✗ Version mismatch: CLI v${VERSION} ≠ plugin v0.14.0`);
      expect(r.stdout).toContain('→ Update: openclaw plugins install aquaman-plugin');
    }, T);

    it('says nothing about provenance below 2026.11, and reads no version from a plugin without package.json', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb, null);
      sb.writeOpenClawJson(wired());
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.stdout).toContain(`✓ Plugin installed (${path.join(sb.openclawDir, 'extensions', 'aquaman-plugin')})`);
      expect(r.stdout).not.toContain('Plugin source');
      expect(r.stdout).not.toContain('Version mismatch');
    }, T);

    it('fails when openclaw.json has no entry for the plugin', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson({ plugins: { entries: { other: { enabled: true } } } });
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Plugin not configured in openclaw.json');
    }, T);

    it('fails on an openclaw.json that is not JSON, once', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson('{ not json');
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ openclaw.json is not standard JSON');
      expect(r.stdout).toContain('→ Remove comments and trailing commas from the file');
      expect(r.stdout.match(/openclaw\.json/g)).toHaveLength(1);
    }, T);

    it('fails on a config with $include, because the plugin then answers no reference with the proxy token', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(wired({ agents: { $include: './agents.json' } }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Key references');
      expect(r.stdout).toContain('uses $include');
      expect(r.stdout).toContain('→ Keep the OpenClaw config in one file without $include');
    }, T);

    it('fails when a plugins.allow list leaves the plugin out', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(wired({ plugins: { allow: ['anthropic'], entries: { 'aquaman-plugin': PLUGIN_ENTRY } } }));
      const r = await doctor();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Plugin not in plugins.allow trust list');
      expect(r.stdout).toContain('add "aquaman-plugin" to plugins.allow in openclaw.json');
      expect(r.stdout).toContain('dangerous-exec finding for proxy-manager.ts');
    }, T);
  });

  describe('model routing', () => {
    it('fails when a provider has an apiKey ref but still calls the vendor directly', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(wired({
        models: { providers: { anthropic: ROUTED_MODELS.providers.anthropic, openai: { apiKey: ref('openai') } } },
      }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✓ SecretRef wiring active (anthropic, openai)');
      expect(r.stdout).toContain("✗ Model routing openai: aquaman's key reference is set but the baseUrl is not the proxy, so the proxy is bypassed and that host is sent a key it cannot use");
      expect(r.stdout).toContain('→ Run: aquaman openclaw setup   (routes the provider through the proxy, or removes the reference where the baseUrl is your own)');
    }, T);

    it('notes a provider key exported in the shell, in the singular and the plural', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(wired());
      const one = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.11.3', OPENAI_API_KEY: 'sk-exported-openai' });
      expect(one.stdout).toContain('→ Environment OPENAI_API_KEY is set in this shell. If OpenClaw starts with it,');
      expect(one.stdout).toContain('Unset it where OpenClaw runs.');
      expect(one.all).not.toContain('sk-exported-openai');

      const two = await doctor({
        AQUAMAN_OPENCLAW_VERSION: '2026.11.3', OPENAI_API_KEY: 'sk-exported-openai', ANTHROPIC_API_KEY: 'sk-exported-ant',
      });
      expect(two.stdout).toContain('→ Environment ANTHROPIC_API_KEY, OPENAI_API_KEY are set in this shell. If OpenClaw starts with them,');
      expect(two.stdout).toContain('Unset them where OpenClaw runs.');
    }, T);
  });

  describe('channel routing', () => {
    const telegram = (entry: Record<string, any>, more: Record<string, any> = {}) =>
      wired({ channels: { telegram: { enabled: true, ...entry }, ...more } });

    it('passes a routed channel that the proxy serves', async () => {
      sb.writeConfig(baseConfig(sb).map((l) => (l === '    - openai' ? '    - openai\n    - telegram' : l)));
      installPlugin(sb);
      sb.writeOpenClawJson(telegram({ apiRoot: 'http://127.0.0.1:8585/telegram', botToken: 'aqm_lb_placeholder' }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.stdout).toContain('✓ Channel routing through the proxy for telegram');
      expect(r.stdout).not.toContain('✗ Channel routing');
      // The loopback token in botToken is aquaman's own placeholder, not a plaintext credential.
      expect(r.stdout).toContain('✓ Unmigrated: none');
    }, T);

    it('fails a routed channel that is missing from proxiedServices', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(telegram({ apiRoot: 'http://127.0.0.1:8585/telegram', botToken: 'aqm_lb_placeholder' }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Channel routing telegram routed here but missing from proxiedServices, so the proxy returns 404');
      expect(r.stdout).toContain('→ Add telegram to credentials.proxiedServices in ~/.aquaman/config.yaml (or re-run: aquaman openclaw setup)');
    }, T);

    it('fails a channel pointed at the user\'s own endpoint', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(telegram({ apiRoot: 'https://bot-api.internal.example', botToken: 'aquaman-proxy-managed' }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Channel routing telegram sends its token straight to the vendor');
      expect(r.stdout).toContain('→ it already points at your own endpoint (self-hosted Bot API or regional proxy)');
    }, T);

    it('fails an unwired channel with no vault credential, and lists channels that cannot be routed', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson(telegram({ botToken: 'aquaman-proxy-managed' }, { discord: { enabled: true }, slack: { enabled: true } }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Channel routing telegram sends its token straight to the vendor');
      expect(r.stdout).toContain('→ no credential in the vault (add it: aquaman credentials add telegram bot_token)');
      expect(r.stdout).toContain('→ Channel routing not available for discord, slack on this OpenClaw (no config-level endpoint override)');
      expect(r.stdout).toContain('(their tokens can live in the vault, but the proxy is not in their egress path)');
    }, T);

    it('fails an unwired channel whose credential is already in the vault, pointing at setup', async () => {
      sb.writeConfig(baseConfig(sb));
      await addCredential(sb, 'telegram', 'bot_token', '123456:REAL-BOT-TOKEN');
      installPlugin(sb);
      sb.writeOpenClawJson(telegram({ botToken: 'aquaman-proxy-managed' }));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('→ routable but not wired yet (re-run: aquaman openclaw setup)');
      expect(r.all).not.toContain('REAL-BOT-TOKEN');
    }, T);
  });

  describe('auth profiles', () => {
    it('2026.8.1+: a legacy auth-profiles.json blocks providers; unwired installs are sent to setup first', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson({ plugins: { entries: { 'aquaman-plugin': PLUGIN_ENTRY } } });
      writeAuthProfiles(sb);
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Auth profiles legacy auth-profiles.json blocks anthropic/openai on 2026.9.37 (AUTH_PROFILE_MIGRATION_REQUIRED)');
      expect(r.stdout).toContain('→ First: aquaman openclaw setup   (wires the SecretRef provider that replaces it)');
      expect(r.stdout).toContain('→ Then run once: openclaw doctor --fix');
      expect(r.stdout).toContain('→ SecretRef wiring available on this OpenClaw — run: aquaman openclaw setup');
    }, T);

    it('2026.6.5-2026.7.x without SecretRef wiring: JSON present fails, SQLite passes, neither fails', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson({ plugins: { entries: { 'aquaman-plugin': PLUGIN_ENTRY } } });
      const env = { AQUAMAN_OPENCLAW_VERSION: '2026.7.33' };

      const neither = await doctor(env);
      expect(neither.stdout).toContain('✗ Auth profiles missing: no credential wiring for OpenClaw 2026.7.33');
      expect(neither.stdout).toContain('→ Run: aquaman openclaw setup   (wires the SecretRef provider; the plugin no longer writes auth-profiles.json here)');

      writeAuthProfiles(sb, 'openclaw-agent.sqlite');
      const sqlite = await doctor(env);
      expect(sqlite.stdout).toContain('✓ Auth profiles (SQLite store present; OpenClaw ≥ 2026.6.5)');

      writeAuthProfiles(sb);
      const json = await doctor(env);
      expect(json.code).toBe(1);
      expect(json.stdout).toContain('✗ Auth profiles JSON present but 2026.7.33 reads from SQLite');
      expect(json.stdout).toContain('→ Import the placeholder once: openclaw doctor --fix  (backs up openclaw.json first)');
    }, T);

    it('below 2026.6.5 the JSON file is the working surface', async () => {
      sb.writeConfig(baseConfig(sb));
      installPlugin(sb);
      sb.writeOpenClawJson({ plugins: { entries: { 'aquaman-plugin': PLUGIN_ENTRY } } });
      writeAuthProfiles(sb);
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.5.12' });
      expect(r.stdout).toContain('✓ Auth profiles exist');
      expect(r.stdout).not.toContain('SecretRef');
    }, T);
  });

  describe('plaintext credentials left in OpenClaw', () => {
    const PLAINTEXT = { channels: { telegram: { accounts: { mybot: { botToken: '123456:PLAINTEXT-BOT-TOKEN' } } } } };
    const writeCredFile = () => {
      const dir = path.join(sb.openclawDir, 'credentials');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'xai.json'), JSON.stringify({ api_key: 'xai-plaintext-file-key' }));
    };

    it('fails on credentials that are not in the vault yet, naming each source but no value', async () => {
      sb.writeConfig(baseConfig(sb));
      await addCredential(sb, 'anthropic', 'api_key', 'sk-ant-doctor-value');
      installPlugin(sb);
      sb.writeOpenClawJson(wired({
        ...PLAINTEXT,
        plugins: {
          entries: {
            'aquaman-plugin': PLUGIN_ENTRY,
            'notion-skill': { enabled: true, config: { apiToken: 'ntn_plaintext_plugin_token' } },
          },
        },
      }));
      writeCredFile();
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Unmigrated: 3 plaintext credentials exposed in OpenClaw config');
      expect(r.stdout).toContain('notion-skill/api_token ← openclaw.json');
      expect(r.all).not.toContain('ntn_plaintext_plugin_token');
      expect(r.stdout).toContain('telegram/bot_token ← openclaw.json');
      expect(r.stdout).toContain('xai/api_key ← credentials/xai.json');
      expect(r.stdout).toContain('→ Run: aquaman openclaw migrate --auto');
      expect(r.stdout).not.toContain('Cleanup needed');
      expect(r.all).not.toContain('PLAINTEXT-BOT-TOKEN');
      expect(r.all).not.toContain('xai-plaintext-file-key');
    }, T);

    it('asks for cleanup when the vault already holds them', async () => {
      sb.writeConfig(baseConfig(sb));
      await addCredential(sb, 'telegram', 'bot_token', '123456:PLAINTEXT-BOT-TOKEN');
      await addCredential(sb, 'xai', 'api_key', 'xai-plaintext-file-key');
      installPlugin(sb);
      sb.writeOpenClawJson(wired(PLAINTEXT));
      writeCredFile();
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Cleanup needed: 2 plaintext sources remain after migration');
      expect(r.stdout).toContain('→ Remove plaintext sources listed above (credentials are already in secure store)');
      expect(r.stdout).not.toContain('✗ Unmigrated');
    }, T);

    it('treats everything as unmigrated when the vault cannot be opened', async () => {
      sb.writeConfig(['credentials:', '  backend: keeper', '  proxiedServices:', '    - anthropic']);
      installPlugin(sb);
      sb.writeOpenClawJson(wired(PLAINTEXT));
      const r = await doctor({ AQUAMAN_OPENCLAW_VERSION: '2026.9.37' });
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('✗ Backend not accessible');
      expect(r.stdout).toContain('✗ Unmigrated: 1 plaintext credentials exposed in OpenClaw config');
    }, T);
  });
});
