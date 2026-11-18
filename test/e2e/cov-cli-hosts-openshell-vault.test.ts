/**
 * `aquaman openshell doctor|setup` branches the existing cli-openshell tests
 * leave out, and the vault setup wizard (`aquaman setup`) as far as it runs
 * without a terminal: `--non-interactive`, the environment variables it reads,
 * and prompts answered over a pipe.
 *
 * Nothing real is contacted: the driver socket is a local server, and PATH
 * holds one private directory (test/helpers/cov-cli-hosts.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { createSandbox, baseConfig, runCli, type Sandbox } from '../helpers/cov-cli-hosts.js';

const T = 120_000;
const FAKE_KEEPER = path.resolve('test/helpers/fake-keeper.mjs');

describe('aquaman openshell (cli-hosts coverage)', () => {
  let sb: Sandbox;
  let servers: net.Server[];
  let children: ChildProcess[];
  beforeEach(() => { sb = createSandbox(); servers = []; children = []; });
  afterEach(async () => {
    for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
    for (const c of children) c.kill('SIGKILL');
    sb.cleanup();
  });

  const driverSock = () => path.join(sb.configDir, 'openshell.sock');
  const enabled = (extra: string[] = []) => baseConfig(sb, ['openshell:', '  driver:', '    enabled: true', ...extra]);
  const listen = async (mode: number): Promise<void> => {
    const server = net.createServer((c) => c.end());
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(driverSock(), resolve));
    fs.chmodSync(driverSock(), mode);
  };
  const gatewayToml = (socketPath: string, transport = 'uds') => {
    const file = path.join(sb.root, 'gateway.toml');
    fs.writeFileSync(file, [
      '[openshell.gateway]',
      'credential_drivers = ["aquaman"]',
      '',
      '[openshell.credential_drivers.aquaman]',
      `transport = "${transport}"`,
      `socket_path = "${socketPath}"`,
      '',
      '[openshell.other]',
      'x = 1',
      '',
    ].join('\n'));
    return file;
  };

  it('doctor passes every check against a served 0600 socket, declared refs and a matching gateway config', async () => {
    sb.writeConfig(enabled(['broker:', '  allowedRefs:', '    - aquaman://anthropic/api_key', '    - aquaman://github/token']));
    await listen(0o600);
    const toml = gatewayToml(driverSock());
    const r = await runCli(sb, ['openshell', 'doctor', '--gateway-config', toml]);
    expect(r.stdout).toContain('✓ gRPC packages installed (@grpc/grpc-js, @grpc/proto-loader)');
    expect(r.stdout).toContain('✓ Driver enabled in config.yaml');
    expect(r.stdout).toContain(`✓ Socket path ${driverSock()}`);
    expect(r.stdout).toContain('✓ Socket is owner-only (0600)');
    expect(r.stdout).toContain('✓ Driver socket accepts connections');
    expect(r.stdout).toContain('✓ 2 declared refs usable by reference (aquaman broker list)');
    expect(r.stdout).toContain(`✓ Gateway config ${toml} points at this driver`);
    expect(r.stdout).toContain('All checks passed.');
    expect(r.stdout).not.toContain('✗');
    expect(r.code).toBe(0);
  }, T);

  it('doctor fails a socket other users can reach, and a gateway config that points elsewhere', async () => {
    sb.writeConfig(enabled(['broker:', '  allowedRefs:', '    - aquaman://anthropic/api_key']));
    await listen(0o666);
    const toml = gatewayToml('/somewhere/else.sock');
    const r = await runCli(sb, ['openshell', 'doctor', '--gateway-config', toml]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✗ Socket mode is 666, expected 600');
    expect(r.stdout).toContain('→ aquaman stop; aquaman daemon');
    expect(r.stdout).toContain('✓ 1 declared ref usable by reference');
    expect(r.stdout).toContain(`✗ Gateway config ${toml} does not point at this driver`);
    expect(r.stdout).toContain('→ paste the snippet from: aquaman openshell setup');
    expect(r.stdout).toContain('2 checks failed.');
  }, T);

  it('doctor fails a gateway config with the right socket but another transport', async () => {
    sb.writeConfig(enabled(['broker:', '  allowedRefs:', '    - aquaman://anthropic/api_key']));
    await listen(0o600);
    const toml = gatewayToml(driverSock(), 'tcp');
    const r = await runCli(sb, ['openshell', 'doctor', '--gateway-config', toml]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`✗ Gateway config ${toml} does not point at this driver`);
    expect(r.stdout).toContain('1 check failed.');
  }, T);

  it('doctor fails a socket file nobody is listening on', async () => {
    sb.writeConfig(enabled());
    // A listener that dies without cleaning up leaves the socket file behind.
    const holder = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(driverSock())}, () => console.log('up'))`], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    children.push(holder);
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    fs.chmodSync(driverSock(), 0o600);
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('close', () => resolve()));
    expect(fs.statSync(driverSock()).isSocket()).toBe(true);

    const r = await runCli(sb, ['openshell', 'doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✓ Socket is owner-only (0600)');
    expect(r.stdout).toContain('✗ Driver socket does not accept connections');
    expect(r.stdout).toContain('• No declared refs yet: reference-mode providers will be refused until you run aquaman broker allow <ref>');
  }, T);

  it('doctor fails a disabled driver, a disabled broker, an over-long socket path and an unreadable gateway config', async () => {
    const long = path.join('/tmp', 'x'.repeat(110), 'openshell.sock');
    sb.writeConfig(baseConfig(sb, [
      'openshell:', '  driver:', '    enabled: false', `    socketPath: ${long}`,
      'broker:', '  enabled: false',
    ]));
    const missing = path.join(sb.root, 'no-such.toml');
    const r = await runCli(sb, ['openshell', 'doctor', '--gateway-config', missing]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('✗ Driver not enabled');
    expect(r.stdout).toContain('→ aquaman openshell setup');
    expect(r.stdout).toContain(`✗ Socket path over 103 bytes: ${long}`);
    expect(r.stdout).toContain('→ aquaman openshell setup --socket <shorter absolute path>');
    expect(r.stdout).toContain('✗ Driver socket not present (daemon not running, or started before setup)');
    expect(r.stdout).toContain('✗ Broker disabled (broker.enabled: false): references cannot resolve');
    expect(r.stdout).toContain('→ set broker.enabled: true in config.yaml');
    expect(r.stdout).toContain(`✗ Cannot read ${missing}`);
    expect(r.stdout).toContain('5 checks failed.');
  }, T);

  it('setup warns about a socket path over the Unix limit but still records it', async () => {
    const long = path.join('/tmp', 'y'.repeat(110), 'openshell.sock');
    const r = await runCli(sb, ['openshell', 'setup', '--socket', long]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`⚠ ${long} is longer than the 103-byte Unix socket limit. Rerun with --socket <shorter path>.`);
    expect(parseYaml(sb.readConfig()).openshell.driver).toEqual({ enabled: true, socketPath: long });
    expect(r.stdout).toContain(`socket_path = "${long}"`);
  }, T);
});

describe('aquaman setup: the vault wizard without a terminal (cli-hosts coverage)', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); });
  afterEach(() => { sb.cleanup(); });

  const configPath = () => path.join(sb.configDir, 'config.yaml');
  const stored = async () => {
    const r = await runCli(sb, ['credentials', 'list']);
    return r.all;
  };

  it('rejects an unknown backend and writes nothing', async () => {
    const r = await runCli(sb, ['setup', '--non-interactive', '--backend', 'nope']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Invalid backend: nope. Valid: keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden, keeper');
    expect(fs.existsSync(configPath())).toBe(false);
  }, T);

  it('--non-interactive stores the keys from the environment and applies the default policy presets', async () => {
    const r = await runCli(sb, ['setup', '--non-interactive', '--backend', 'encrypted-file'], {
      env: { ANTHROPIC_API_KEY: 'sk-ant-wizard-value', OPENAI_API_KEY: 'sk-openai-wizard-value' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Vault setup');
    expect(r.stdout).toContain('Backend:  encrypted-file');
    expect(r.stdout).toContain('✓ Stored anthropic/api_key');
    expect(r.stdout).toContain('✓ Stored openai/api_key');
    expect(r.stdout).toContain('✓ Default policy presets applied.');
    expect(r.stdout).toContain('aquaman openclaw setup');
    expect(r.stdout).toContain('aquaman coder setup claude-code');
    expect(r.all).not.toContain('sk-ant-wizard-value');

    const cfg = parseYaml(fs.readFileSync(configPath(), 'utf-8'));
    expect(cfg.credentials.backend).toBe('encrypted-file');
    expect(Object.keys(cfg.policy).sort()).toEqual(['anthropic', 'openai']);
    expect(cfg.policy.openai.rules).toContainEqual({ method: 'DELETE', path: '/v1/**', action: 'deny' });
    expect(JSON.stringify(cfg)).not.toContain('sk-ant-wizard-value');
    expect(fs.statSync(configPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(sb.configDir, 'audit')).mode & 0o777).toBe(0o700);

    const list = await stored();
    expect(list).toContain('anthropic');
    expect(list).toContain('openai');
  }, T);

  it('--no-policy stores the key and writes no policy; with no key there is nothing to apply', async () => {
    const r = await runCli(sb, ['setup', '--non-interactive', '--backend', 'encrypted-file', '--no-policy'], {
      env: { ANTHROPIC_API_KEY: 'sk-ant-wizard-value' },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓ Stored anthropic/api_key');
    expect(r.stdout).not.toContain('Default policy presets applied');
    expect(parseYaml(fs.readFileSync(configPath(), 'utf-8')).policy).toBeUndefined();

    const none = await runCli(sb, ['setup', '--non-interactive', '--backend', 'encrypted-file']);
    expect(none.code).toBe(0);
    expect(none.stdout).not.toContain('Stored');
    expect(none.stdout).not.toContain('Default policy presets applied');
  }, T);

  it('keeps the rest of an existing config and only changes the backend', async () => {
    sb.writeConfig([
      'credentials:', '  backend: vault', '  proxiedServices:', '    - github',
      'loopback:', '  enabled: true', '  port: 9333', '  token: aqm_lb_existingtoken00000000',
    ]);
    const r = await runCli(sb, ['setup', '--non-interactive', '--backend', 'encrypted-file']);
    expect(r.code).toBe(0);
    const cfg = parseYaml(fs.readFileSync(configPath(), 'utf-8'));
    expect(cfg.credentials.backend).toBe('encrypted-file');
    expect(cfg.credentials.proxiedServices).toEqual(['github']);
    expect(cfg.loopback).toMatchObject({ enabled: true, port: 9333, token: 'aqm_lb_existingtoken00000000' });
  }, T);

  it('records the Keeper folder UID from the environment', async () => {
    fs.chmodSync(FAKE_KEEPER, 0o755);
    fs.symlinkSync(FAKE_KEEPER, path.join(sb.bin, 'keeper'));
    const state = path.join(sb.root, 'keeper-state.json');
    fs.writeFileSync(state, JSON.stringify({ folders: { WizardFolder0000000000: {} }, records: {} }));
    const r = await runCli(sb, ['setup', '--non-interactive', '--backend', 'keeper'], {
      env: { AQUAMAN_KEEPER_FOLDER_UID: 'WizardFolder0000000000', FAKE_KEEPER_STATE: state },
    });
    expect(r.code).toBe(0);
    const cfg = parseYaml(fs.readFileSync(configPath(), 'utf-8'));
    expect(cfg.credentials.backend).toBe('keeper');
    expect(cfg.credentials.keeperFolderUid).toBe('WizardFolder0000000000');
  }, T);

  it('stops when the store cannot be created, naming the backend and the reason', async () => {
    const r = await runCli(sb, ['setup', '--non-interactive', '--backend', 'encrypted-file'], {
      env: { AQUAMAN_ENCRYPTION_PASSWORD: 'short' },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Failed to initialize encrypted-file: Weak encryption password');
    expect(r.stdout).not.toContain('Next steps');
  }, T);

  it('asks for each key over a pipe: a typed key is stored trimmed, an empty answer skips', async () => {
    const r = await runCli(sb, ['setup', '--backend', 'encrypted-file'], {
      answers: [
        ['? Anthropic API key (or Enter to skip): ', ''],
        ['? OpenAI API key (or Enter to skip): ', '  sk-openai-piped-value '],
      ],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓ openai/api_key');
    expect(r.stdout).not.toContain('✓ anthropic/api_key');
    expect(r.stdout).toContain('✓ Default policy presets applied.');
    expect(r.stdout).not.toContain('sk-openai-piped-value');
    expect(Object.keys(parseYaml(fs.readFileSync(configPath(), 'utf-8')).policy)).toEqual(['openai']);

    const list = await stored();
    expect(list).toContain('openai');
    expect(list).not.toContain('anthropic');
  }, T);
});
