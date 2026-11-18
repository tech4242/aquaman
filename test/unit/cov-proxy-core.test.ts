/**
 * Smaller proxy modules: the branch and failure paths their own suites do not
 * reach. Config loading and env overrides, the audit log's recovery and
 * integrity checks, password-based encryption, service validation, the OAuth
 * token cache, the OpenShell driver core, declared-ref loading, channel
 * routing status, and the Vault and KeePassXC backends.
 *
 * Everything runs against temp directories and local HTTP servers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { MemoryStore } from 'aquaman-core';
import {
  loadConfig,
  applyEnvOverrides,
  getDefaultConfig,
  expandPath,
  isAquamanPlaceholder,
} from '../../packages/proxy/src/core/utils/config.js';
import {
  computeHash,
  computeChainedHash,
  generateId,
  encryptWithPassword,
  decryptWithPassword,
} from '../../packages/proxy/src/core/utils/hash.js';
import { AuditLogger, createAuditLogger } from '../../packages/proxy/src/core/audit/logger.js';
import { ServiceRegistry, createServiceRegistry } from '../../packages/proxy/src/service-registry.js';
import { OAuthTokenCache } from '../../packages/proxy/src/oauth-token-cache.js';
import { createOpenShellDriverCore, DriverError, type DriverAccessEvent } from '../../packages/proxy/src/openshell/credential-driver.js';
import { loadProjectRefs, loadConfigAllowedRefs, createBrokerScope } from '../../packages/proxy/src/broker-scope.js';
import { hermesSecretSourceRefs, writeHermesEnv } from '../../packages/proxy/src/hermes/config-writer.js';
import { channelRoutingStatus, wireChannelRouting, loopbackChannelBaseUrl } from '../../packages/proxy/src/openclaw/channel-routing.js';
import { VaultStore, createVaultStore } from '../../packages/proxy/src/core/credentials/backends/vault.js';
import { KeePassXCStore, createKeePassXCStore } from '../../packages/proxy/src/core/credentials/backends/keepassxc.js';
import { matchPathPattern, matchPolicy } from '../../packages/proxy/src/request-policy.js';
import { findOpenClawConfig } from '../../packages/proxy/src/migration/openclaw-migrator.js';
import { startOpenShellDriver, type AuditSink } from '../../packages/proxy/src/openshell/integration.js';
import { openshellProtoDir } from '../../packages/proxy/src/openshell/grpc-server.js';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

let dir: string;
const savedEnv = new Map<string, string | undefined>();

/** Set (or with `undefined`, remove) an environment variable for this test only. */
function setEnv(name: string, value: string | undefined): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-core-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('config', () => {
  const OVERRIDE_VARS = [
    'AQUAMAN_BACKEND', 'AQUAMAN_SERVICES', 'AQUAMAN_ENCRYPTION_PASSWORD', 'AQUAMAN_AUDIT_ENABLED',
    'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_NAMESPACE',
    'AQUAMAN_BITWARDEN_FOLDER', 'AQUAMAN_BITWARDEN_ORGANIZATION_ID', 'AQUAMAN_BITWARDEN_COLLECTION_ID',
    'AQUAMAN_KEEPER_FOLDER_UID', 'AQUAMAN_KEEPER_CONFIG', 'AQUAMAN_CACHE_TTL',
    'AQUAMAN_LOOPBACK_ENABLED', 'AQUAMAN_LOOPBACK_PORT', 'AQUAMAN_LOOPBACK_TOKEN',
    'AQUAMAN_BROKER_ENABLED', 'AQUAMAN_OPENSHELL_DRIVER',
  ];

  beforeEach(() => {
    for (const name of OVERRIDE_VARS) setEnv(name, undefined);
    setEnv('AQUAMAN_CONFIG_DIR', dir);
  });

  it('falls back to the defaults, with a warning, when config.yaml cannot be parsed', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'credentials:\n  backend: [unclosed\n');
    const config = loadConfig();
    expect(config).toEqual(getDefaultConfig());
    expect(errors).toHaveBeenCalledWith(`Warning: Failed to load config from ${path.join(dir, 'config.yaml')}, using defaults`);
  });

  it('ignores an encryption password written in config.yaml, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'credentials:\n  backend: encrypted-file\n  encryptionPassword: from-the-file-0123\n');
    const config = loadConfig();
    expect(config.credentials.backend).toBe('encrypted-file');
    expect(config.credentials.encryptionPassword).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('credentials.encryptionPassword in config.yaml is deprecated and ignored'));
    // The environment is the only source.
    setEnv('AQUAMAN_ENCRYPTION_PASSWORD', 'from-the-environment-0123');
    expect(loadConfig().credentials.encryptionPassword).toBe('from-the-environment-0123');
  });

  it('merges each optional section over its default', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), [
      'loopback:', '  enabled: true', '  port: 9191',
      'hermes:', '  configMethod: env',
      'broker:', '  allowedRefs:', '    - aquaman://github/token',
      'policy:', '  github:', '    defaultAction: deny',
      'openshell:', '  driver:', '    enabled: true', '    socketPath: /tmp/os.sock',
      '',
    ].join('\n'));
    const config = loadConfig();
    expect(config.loopback).toEqual({ enabled: true, port: 9191, host: '127.0.0.1' });
    expect(config.hermes).toEqual({ configMethod: 'env' });
    expect(config.broker).toEqual({ enabled: true, allowedRefs: ['aquaman://github/token'] });
    expect(config.policy).toEqual({ github: { defaultAction: 'deny' } });
    expect(config.openshell).toEqual({ driver: { enabled: true, socketPath: '/tmp/os.sock' } });
  });

  it('applies each backend-specific environment override', () => {
    setEnv('VAULT_NAMESPACE', 'team-a');
    setEnv('AQUAMAN_BITWARDEN_FOLDER', 'agents');
    setEnv('AQUAMAN_BITWARDEN_ORGANIZATION_ID', 'org-1');
    setEnv('AQUAMAN_BITWARDEN_COLLECTION_ID', 'col-1');
    setEnv('AQUAMAN_KEEPER_FOLDER_UID', 'FolderUid0000000000000');
    setEnv('AQUAMAN_KEEPER_CONFIG', '/etc/keeper.json');
    const { credentials } = applyEnvOverrides(getDefaultConfig());
    expect(credentials.vaultNamespace).toBe('team-a');
    expect(credentials.bitwardenFolder).toBe('agents');
    expect(credentials.bitwardenOrganizationId).toBe('org-1');
    expect(credentials.bitwardenCollectionId).toBe('col-1');
    expect(credentials.keeperFolderUid).toBe('FolderUid0000000000000');
    expect(credentials.keeperConfigPath).toBe('/etc/keeper.json');
  });

  it('ignores an unknown backend name and a cache TTL that is not a non-negative integer', () => {
    setEnv('AQUAMAN_BACKEND', 'sticky-note');
    setEnv('AQUAMAN_CACHE_TTL', '-5');
    let config = applyEnvOverrides(getDefaultConfig());
    expect(config.credentials.backend).toBe('keychain');
    expect(config.credentials.cacheTtlSeconds).toBeUndefined();
    setEnv('AQUAMAN_CACHE_TTL', '1.5');
    expect(applyEnvOverrides(getDefaultConfig()).credentials.cacheTtlSeconds).toBeUndefined();
    setEnv('AQUAMAN_BACKEND', 'keeper');
    setEnv('AQUAMAN_CACHE_TTL', '0');
    config = applyEnvOverrides(getDefaultConfig());
    expect(config.credentials.backend).toBe('keeper');
    expect(config.credentials.cacheTtlSeconds).toBe(0);
  });

  it('only the literal "false" switches the broker off, and creates the section when it is missing', () => {
    const bare = getDefaultConfig();
    delete bare.broker;
    setEnv('AQUAMAN_BROKER_ENABLED', 'false');
    expect(applyEnvOverrides(bare).broker).toEqual({ enabled: false, allowedRefs: [] });
    setEnv('AQUAMAN_BROKER_ENABLED', '0');
    expect(applyEnvOverrides(getDefaultConfig()).broker!.enabled).toBe(true);
  });

  it('only the literal "true" switches the OpenShell driver on, and creates the section when it is missing', () => {
    setEnv('AQUAMAN_OPENSHELL_DRIVER', 'true');
    expect(applyEnvOverrides(getDefaultConfig()).openshell).toEqual({ driver: { enabled: true } });
    setEnv('AQUAMAN_OPENSHELL_DRIVER', 'yes');
    expect(applyEnvOverrides(getDefaultConfig()).openshell).toEqual({ driver: { enabled: false } });
    const existing = { ...getDefaultConfig(), openshell: { driver: { enabled: true, socketPath: '/tmp/x.sock' } } };
    expect(applyEnvOverrides(existing).openshell).toEqual({ driver: { enabled: false, socketPath: '/tmp/x.sock' } });
  });

  it('loopback overrides create the section when missing, and never set the host', () => {
    const bare = getDefaultConfig();
    delete bare.loopback;
    setEnv('AQUAMAN_LOOPBACK_PORT', '9292');
    expect(applyEnvOverrides(bare).loopback).toEqual({ enabled: false, port: 9292, host: '127.0.0.1' });
    const bare2 = getDefaultConfig();
    delete bare2.loopback;
    setEnv('AQUAMAN_LOOPBACK_PORT', '70000');
    setEnv('AQUAMAN_LOOPBACK_TOKEN', 'aqm_lb_from_env');
    expect(applyEnvOverrides(bare2).loopback).toEqual({ enabled: false, port: 8585, host: '127.0.0.1', token: 'aqm_lb_from_env' });
    const bare3 = getDefaultConfig();
    delete bare3.loopback;
    setEnv('AQUAMAN_LOOPBACK_TOKEN', undefined);
    setEnv('AQUAMAN_LOOPBACK_PORT', undefined);
    setEnv('AQUAMAN_LOOPBACK_ENABLED', 'true');
    expect(applyEnvOverrides(bare3).loopback).toEqual({ enabled: true, port: 8585, host: '127.0.0.1' });
  });

  it('expandPath resolves ~ and ${HOME} against the home directory and leaves other paths alone', () => {
    setEnv('HOME', dir);
    expect(expandPath('~/audit')).toBe(path.join(dir, 'audit'));
    expect(expandPath('${HOME}/audit')).toBe(`${dir}/audit`);
    expect(expandPath('/var/log/audit')).toBe('/var/log/audit');
  });

  it('isAquamanPlaceholder recognises aquaman\'s own values only', () => {
    expect(isAquamanPlaceholder('aquaman-proxy-managed')).toBe(true);
    expect(isAquamanPlaceholder('aquaman://github/token')).toBe(true);
    expect(isAquamanPlaceholder('aqm_lb_0123456789')).toBe(true);
    expect(isAquamanPlaceholder('sk-ant-real')).toBe(false);
    expect(isAquamanPlaceholder(undefined)).toBe(false);
    expect(isAquamanPlaceholder(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('hash and password encryption', () => {
  it('computeHash is SHA-256 in hex, and the chained hash covers the previous hash', () => {
    expect(computeHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(computeHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(computeChainedHash('data', 'prev')).toBe(computeHash('prevdata'));
    expect(computeChainedHash('data', 'prev')).not.toBe(computeChainedHash('data', 'other'));
  });

  it('generateId returns distinct UUIDs', () => {
    const a = generateId();
    const b = generateId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('round-trips a value, with a fresh salt and nonce every time', () => {
    const secret = 'sk-ant-üñí-✓-0123456789';
    const one = encryptWithPassword(secret, 'correct horse battery');
    const two = encryptWithPassword(secret, 'correct horse battery');
    expect(one).not.toBe(two);
    expect(one).not.toContain(secret);
    const parts = one.split(':');
    expect(parts).toHaveLength(4);
    expect(Buffer.from(parts[0]!, 'base64')).toHaveLength(16);
    expect(Buffer.from(parts[1]!, 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[2]!, 'base64')).toHaveLength(16);
    expect(decryptWithPassword(one, 'correct horse battery')).toBe(secret);
    expect(decryptWithPassword(two, 'correct horse battery')).toBe(secret);
  });

  it('refuses the wrong password', () => {
    const encrypted = encryptWithPassword('secret', 'correct horse battery');
    expect(() => decryptWithPassword(encrypted, 'wrong horse battery')).toThrow();
  });

  it('refuses ciphertext, an auth tag or a nonce that was changed', () => {
    const encrypted = encryptWithPassword('a secret long enough to span a block or two', 'correct horse battery');
    const [salt, iv, tag, data] = encrypted.split(':') as [string, string, string, string];
    const flip = (b64: string) => {
      const buf = Buffer.from(b64, 'base64');
      buf[0] = buf[0]! ^ 0xff;
      return buf.toString('base64');
    };
    expect(() => decryptWithPassword([salt, iv, tag, flip(data)].join(':'), 'correct horse battery')).toThrow();
    expect(() => decryptWithPassword([salt, iv, flip(tag), data].join(':'), 'correct horse battery')).toThrow();
    expect(() => decryptWithPassword([salt, flip(iv), tag, data].join(':'), 'correct horse battery')).toThrow();
    expect(() => decryptWithPassword([flip(salt), iv, tag, data].join(':'), 'correct horse battery')).toThrow();
  });

  it('refuses input that is not in the four-part format', () => {
    for (const bad of ['', 'only-one-part', 'a:b:c', 'a:b::d', ':b:c:d']) {
      expect(() => decryptWithPassword(bad, 'pw'), JSON.stringify(bad)).toThrow('Invalid encrypted data format');
    }
  });
});

// ---------------------------------------------------------------------------

describe('AuditLogger: recovery and integrity', () => {
  const access = { service: 'github', operation: 'read' as const, success: true };
  const logPath = () => path.join(dir, 'current.jsonl');

  it('initializes itself on the first write', async () => {
    const logger = new AuditLogger({ logDir: dir });
    const entry = await logger.logCredentialAccess('s1', 'agent', access);
    expect(entry).not.toBeNull();
    expect(fs.existsSync(path.join(dir, 'archive'))).toBe(true);
    expect(logger.getStats()).toEqual({ entryCount: 1, lastHash: entry!.hash });
    expect(fs.statSync(logPath()).mode & 0o777).toBe(0o600);
  });

  it('writes nothing at all when disabled', async () => {
    const logDir = path.join(dir, 'never');
    const logger = createAuditLogger({ logDir, enabled: false });
    await logger.initialize();
    expect(await logger.logCredentialAccess('s1', 'agent', access)).toBeNull();
    expect(await logger.logToolCall('s1', 'agent', 'bash', { cmd: 'ls' })).toBeNull();
    expect(await logger.logToolResult('s1', 'agent', 'id', { ok: true })).toBeNull();
    expect(fs.existsSync(logDir)).toBe(false);
    expect(await logger.getEntries()).toEqual([]);
    expect(await logger.verifyIntegrity()).toEqual({ valid: true, errors: [] });
    await expect(logger.rotateLog()).rejects.toThrow('No log file to rotate');
  });

  it('starts a fresh chain over an empty log file', async () => {
    fs.writeFileSync(logPath(), '\n');
    const logger = new AuditLogger({ logDir: dir });
    await logger.initialize();
    expect(logger.getStats().entryCount).toBe(0);
    await logger.logCredentialAccess('s1', 'agent', access);
    expect(await logger.verifyIntegrity()).toEqual({ valid: true, errors: [] });
  });

  it('continues the chain from an existing log', async () => {
    const first = new AuditLogger({ logDir: dir });
    const a = await first.logCredentialAccess('s1', 'agent', access);
    const second = new AuditLogger({ logDir: dir });
    const b = await second.logCredentialAccess('s2', 'agent', access);
    expect(b!.previousHash).toBe(a!.hash);
    expect(second.getStats().entryCount).toBe(2);
    expect(await second.verifyIntegrity()).toEqual({ valid: true, errors: [] });
  });

  it('warns when the last line of an existing log cannot be parsed, and the damage shows in verification', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = new AuditLogger({ logDir: dir });
    await first.logCredentialAccess('s1', 'agent', access);
    fs.appendFileSync(logPath(), '{"truncated": \n');
    const second = new AuditLogger({ logDir: dir });
    await second.initialize();
    expect(errors).toHaveBeenCalledWith('Warning: Could not parse last audit entry, integrity may be compromised');
    expect(second.getStats().entryCount).toBe(2);
    const result = await second.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(['Entry 1: failed to parse JSON']);
  });

  it('replays entries left in the write-ahead log by a crash, skips unreadable ones, and clears it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A valid first entry, taken from a log written the normal way.
    const source = path.join(dir, 'source');
    const writer = new AuditLogger({ logDir: source });
    const entry = await writer.logCredentialAccess('s1', 'agent', access);
    const line = fs.readFileSync(path.join(source, 'current.jsonl'), 'utf-8');

    const crashed = path.join(dir, 'crashed');
    fs.mkdirSync(crashed);
    fs.writeFileSync(path.join(crashed, 'current.wal'), `${line}{"half-written\n`);
    const logger = new AuditLogger({ logDir: crashed });
    await logger.initialize();

    expect(fs.readFileSync(path.join(crashed, 'current.jsonl'), 'utf-8')).toBe(line);
    expect(fs.readFileSync(path.join(crashed, 'current.wal'), 'utf-8')).toBe('');
    expect(logger.getStats()).toEqual({ entryCount: 1, lastHash: entry!.hash });
    expect(errors).toHaveBeenCalledWith('Warning: Could not recover WAL entry');
    expect(errors).toHaveBeenCalledTimes(1);
    // The chain goes on from the recovered entry.
    const next = await logger.logCredentialAccess('s2', 'agent', access);
    expect(next!.previousHash).toBe(entry!.hash);
    expect(await logger.verifyIntegrity()).toEqual({ valid: true, errors: [] });
  });

  it('leaves the write-ahead log alone when it is switched off', async () => {
    fs.writeFileSync(path.join(dir, 'current.wal'), 'left-over\n');
    const logger = new AuditLogger({ logDir: dir, walEnabled: false });
    await logger.logCredentialAccess('s1', 'agent', access);
    expect(fs.readFileSync(path.join(dir, 'current.wal'), 'utf-8')).toBe('left-over\n');
    expect(logger.getStats().entryCount).toBe(1);
  });

  it('detects a removed entry, an edited entry and a rewritten link', async () => {
    const logger = new AuditLogger({ logDir: dir });
    await logger.logCredentialAccess('s1', 'agent', access);
    await logger.logCredentialAccess('s2', 'agent', access);
    await logger.logCredentialAccess('s3', 'agent', access);
    const lines = fs.readFileSync(logPath(), 'utf-8').trim().split('\n');

    // Remove the middle entry: the third no longer points at its predecessor.
    fs.writeFileSync(logPath(), `${lines[0]}\n${lines[2]}\n`);
    let result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
    // Two things show it: the sequence skips a number, and the link is to an entry that is gone.
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toBe('Entry 1: sequence gap (expected 2, got 3)');
    expect(result.errors[1]).toMatch(/^Entry 1: previousHash mismatch \(expected [0-9a-f]{64}, got [0-9a-f]{64}\)$/);

    // Edit an entry's content: its hash no longer matches.
    const edited = JSON.parse(lines[1]!);
    edited.sessionId = 'forged';
    fs.writeFileSync(logPath(), `${lines[0]}\n${JSON.stringify(edited)}\n${lines[2]}\n`);
    result = await logger.verifyIntegrity();
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^Entry 1: hash mismatch/);
  });

  it('getEntries filters by type and session and pages; tail returns the last entries', async () => {
    const logger = new AuditLogger({ logDir: dir });
    await logger.logToolCall('s1', 'agent', 'bash', { command: 'ls', api_key: 'sk-should-not-be-logged' });
    await logger.logCredentialAccess('s1', 'agent', access);
    await logger.logCredentialAccess('s2', 'agent', access);
    await logger.logToolResult('s2', 'agent', 'call-1', ['a', 'b']);
    expect((await logger.getEntries({ type: 'credential_access' })).map((e) => e.sessionId)).toEqual(['s1', 's2']);
    expect((await logger.getEntries({ sessionId: 's2' })).map((e) => e.type)).toEqual(['credential_access', 'tool_result']);
    expect((await logger.getEntries({ offset: 1, limit: 2 })).map((e) => e.type)).toEqual(['credential_access', 'credential_access']);
    expect((await logger.tail(1)).map((e) => e.type)).toEqual(['tool_result']);
    expect(fs.readFileSync(logPath(), 'utf-8')).not.toContain('sk-should-not-be-logged');
  });
});

// ---------------------------------------------------------------------------

describe('ServiceRegistry: validation', () => {
  const registry = new ServiceRegistry({ builtinServices: false });

  it('an at-rest-only service needs a credential key and nothing else', () => {
    expect(registry.validateService({ name: 'notes', authMode: 'none' })).toEqual({ valid: false, error: 'credentialKey is required and must be a string' });
    expect(registry.validateService({ name: 'notes', authMode: 'none', credentialKey: 'private_key' })).toEqual({ valid: true });
  });

  it('names what is missing or malformed in a proxied service', () => {
    const base = { name: 'x', upstream: 'https://api.example.com', authHeader: 'Authorization', credentialKey: 'api_key' };
    expect(registry.validateService({})).toEqual({ valid: false, error: 'name is required and must be a string' });
    expect(registry.validateService({ ...base, upstream: undefined })).toEqual({ valid: false, error: 'upstream is required and must be a string' });
    expect(registry.validateService({ ...base, upstream: 'not a url' })).toEqual({ valid: false, error: 'upstream must be a valid URL' });
    expect(registry.validateService({ ...base, upstream: 'file:///etc/passwd' })).toEqual({ valid: false, error: 'upstream must use http or https protocol' });
    expect(registry.validateService({ ...base, authHeader: '' })).toEqual({ valid: false, error: 'authHeader is required for header and basic auth modes' });
    expect(registry.validateService({ ...base, authMode: 'basic', authHeader: undefined })).toEqual({ valid: false, error: 'authHeader is required for header and basic auth modes' });
    expect(registry.validateService({ ...base, credentialKey: undefined })).toEqual({ valid: false, error: 'credentialKey is required and must be a string' });
    expect(registry.validateService({ ...base, authPrefix: 7 as never })).toEqual({ valid: false, error: 'authPrefix must be a string if provided' });
    expect(registry.validateService({ ...base, authMode: 'url-path' })).toEqual({ valid: false, error: 'authPathTemplate is required for url-path auth mode' });
    expect(registry.validateService({ ...base, authMode: 'oauth' })).toEqual({ valid: false, error: 'oauthConfig is required for oauth auth mode' });
    expect(registry.validateService(base)).toEqual({ valid: true });
    expect(registry.validateService({ ...base, authMode: 'url-path', authHeader: undefined, authPathTemplate: '/bot{token}' })).toEqual({ valid: true });
  });

  it('register refuses a builtin name and an invalid definition', () => {
    const r = createServiceRegistry();
    expect(() => r.register({ name: 'anthropic', upstream: 'https://evil.example.com', authHeader: 'x-api-key', credentialKey: 'api_key' }))
      .toThrow('Cannot register service "anthropic": name conflicts with a builtin service');
    expect(r.get('anthropic')!.upstream).toBe('https://api.anthropic.com');
    expect(() => r.register({ name: 'mine', upstream: 'ftp://x', authHeader: 'A', credentialKey: 'k' })).toThrow('Invalid service: upstream must use http or https protocol');
    expect(() => r.override('does-not-exist', { upstream: 'http://127.0.0.1:1' })).toThrow('Service "does-not-exist" not found in registry');
    expect(r.has('mine')).toBe(false);
  });

  describe('validateConfigFile', () => {
    const file = () => path.join(dir, 'services.yaml');

    it('reports a missing file, a file without services, and services that are not a list', () => {
      expect(ServiceRegistry.validateConfigFile(file())).toEqual({ valid: false, errors: ['Config file does not exist'] });
      fs.writeFileSync(file(), 'something: else\n');
      expect(ServiceRegistry.validateConfigFile(file())).toEqual({ valid: false, errors: ['Config must have a "services" array'] });
      fs.writeFileSync(file(), '');
      expect(ServiceRegistry.validateConfigFile(file())).toEqual({ valid: false, errors: ['Config must have a "services" array'] });
      fs.writeFileSync(file(), 'services:\n  name: x\n');
      expect(ServiceRegistry.validateConfigFile(file())).toEqual({ valid: false, errors: ['"services" must be an array'] });
    });

    it('reports YAML that does not parse', () => {
      fs.writeFileSync(file(), 'services: [unclosed\n');
      const result = ServiceRegistry.validateConfigFile(file());
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^Failed to parse YAML: /);
    });

    it('numbers each problem: invalid entries, builtin names and duplicates', () => {
      fs.writeFileSync(file(), [
        'services:',
        '  - name: mine',
        '    upstream: https://api.mine.example.com',
        '    authHeader: Authorization',
        '    credentialKey: api_key',
        '  - name: broken',
        '    upstream: https://api.broken.example.com',
        '    authHeader: Authorization',
        '  - name: anthropic',
        '    upstream: https://evil.example.com',
        '    authHeader: x-api-key',
        '    credentialKey: api_key',
        '  - name: mine',
        '    upstream: https://other.example.com',
        '    authHeader: Authorization',
        '    credentialKey: api_key',
        '',
      ].join('\n'));
      expect(ServiceRegistry.validateConfigFile(file())).toEqual({
        valid: false,
        errors: [
          'Service 2: credentialKey is required and must be a string',
          'Service 3: cannot override builtin service "anthropic"',
          'Service 4: duplicate name "mine"',
        ],
      });
    });

    it('accepts a file of valid, distinct, non-builtin services', () => {
      fs.writeFileSync(file(), 'services:\n  - name: mine\n    upstream: https://api.mine.example.com\n    authHeader: Authorization\n    credentialKey: api_key\n');
      expect(ServiceRegistry.validateConfigFile(file())).toEqual({ valid: true, errors: [] });
    });
  });

  it('a services file cannot replace a builtin definition, and an invalid entry is skipped with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(dir, 'services.yaml');
    fs.writeFileSync(file, [
      'services:',
      '  - name: anthropic',
      '    upstream: https://evil.example.com',
      '    authHeader: x-api-key',
      '    credentialKey: api_key',
      '  - name: broken',
      '    upstream: nope',
      '    authHeader: A',
      '    credentialKey: k',
      '  - name: mine',
      '    upstream: https://api.mine.example.com',
      '    authHeader: Authorization',
      '    credentialKey: api_key',
      '',
    ].join('\n'));
    const r = createServiceRegistry({ configPath: file });
    expect(r.get('anthropic')!.upstream).toBe('https://api.anthropic.com');
    expect(r.has('broken')).toBe(false);
    expect(r.get('mine')!.upstream).toBe('https://api.mine.example.com');
    expect(warn).toHaveBeenCalledWith('Cannot override builtin service "anthropic" via config file — ignoring');
    expect(warn).toHaveBeenCalledWith('Invalid service "broken": upstream must be a valid URL');
    // At-rest-only services have no upstream to list.
    const map = r.toConfigMap();
    expect(map['mine']).toEqual({ upstream: 'https://api.mine.example.com', authHeader: 'Authorization', authPrefix: undefined, credentialKey: 'api_key' });
    expect(map['nostr']).toBeUndefined();
    expect(r.getNames()).toContain('nostr');
  });
});

// ---------------------------------------------------------------------------

describe('OAuthTokenCache: failure paths', () => {
  let server: http.Server;
  let origin: string;
  let requests: Array<{ url: string; body: string }>;
  let respond: (req: { url: string; body: string }) => { status?: number; body: string };

  beforeEach(async () => {
    requests = [];
    respond = () => ({ body: JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }) });
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const seen = { url: req.url ?? '', body };
        requests.push(seen);
        const r = respond(seen);
        res.statusCode = r.status ?? 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(r.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function storeWith(entries: Record<string, string>): Promise<MemoryStore> {
    const store = new MemoryStore();
    for (const [key, value] of Object.entries(entries)) await store.set('svc', key, value);
    return store;
  }
  const config = (tokenUrl: string, extra: Record<string, string> = {}) => ({ tokenUrl, clientIdKey: 'client_id', clientSecretKey: 'client_secret', ...extra });

  it('sends scope and audience when the service defines them, and the credentials in the body', async () => {
    const store = await storeWith({ client_id: 'id-1', client_secret: 'secret-1' });
    const token = await new OAuthTokenCache().getToken('svc', config(`${origin}/token`, { scope: 'chat.bot', audience: 'https://api.example.com' }), store);
    expect(token).toBe('tok-1');
    const sent = new URLSearchParams(requests[0]!.body);
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'id-1',
      client_secret: 'secret-1',
      scope: 'chat.bot',
      audience: 'https://api.example.com',
    });
    expect(requests[0]!.url).toBe('/token');
  });

  it('fills a template in the token URL from the vault', async () => {
    const store = await storeWith({ client_id: 'id', client_secret: 's', tenant_id: 'tenant-42' });
    await new OAuthTokenCache().getToken('svc', config(`${origin}/{tenant_id}/oauth2/token`), store);
    expect(requests[0]!.url).toBe('/tenant-42/oauth2/token');
  });

  it('names the missing credential a token URL template needs, and exchanges nothing', async () => {
    const store = await storeWith({ client_id: 'id', client_secret: 's' });
    await expect(new OAuthTokenCache().getToken('svc', config(`${origin}/{tenant_id}/token`), store))
      .rejects.toThrow('OAuth token URL requires credential "tenant_id" for service svc');
    expect(requests).toEqual([]);
  });

  it('refuses a template value that moves the token URL to another host, before sending the client secret anywhere', async () => {
    const store = await storeWith({ client_id: 'id', client_secret: 'top-secret', tenant: 'evil.example.net/x?' });
    await expect(new OAuthTokenCache().getToken('svc', config('https://{tenant}.login.example.com/token'), store))
      .rejects.toThrow('OAuth token URL hostname changed after template resolution for svc: expected "placeholder.login.example.com", got "evil.example.net"');
    expect(requests).toEqual([]);
  });

  it('refuses a template value that leaves the token URL unparseable', async () => {
    const store = await storeWith({ client_id: 'id', client_secret: 's', tenant: 'a b' });
    await expect(new OAuthTokenCache().getToken('svc', config('https://{tenant}.login.example.com/token'), store))
      .rejects.toThrow('OAuth token URL is not a valid URL after template resolution for svc: https://a b.login.example.com/token');
  });

  it('reports a refused exchange with the status, and a reply without a token', async () => {
    const store = await storeWith({ client_id: 'id', client_secret: 's' });
    respond = () => ({ status: 401, body: '{"error":"invalid_client"}' });
    await expect(new OAuthTokenCache().getToken('svc', config(`${origin}/token`), store))
      .rejects.toThrow('OAuth token exchange failed for svc: 401 {"error":"invalid_client"}');
    respond = () => ({ body: '{"token_type":"Bearer"}' });
    await expect(new OAuthTokenCache().getToken('svc', config(`${origin}/token`), store))
      .rejects.toThrow('OAuth response missing access_token for svc');
  });

  it('names the missing client credentials', async () => {
    const store = await storeWith({ client_id: 'id' });
    await expect(new OAuthTokenCache().getToken('svc', config(`${origin}/token`), store))
      .rejects.toThrow('OAuth credentials not found for svc: need client_id and client_secret');
    expect(requests).toEqual([]);
  });

  it('drops expired tokens, and exchanges again once a token is inside the refresh window', async () => {
    const store = await storeWith({ client_id: 'id', client_secret: 's' });
    const cache = new OAuthTokenCache({ refreshBuffer: 0 });
    let n = 0;
    respond = () => ({ body: JSON.stringify({ access_token: `tok-${++n}`, expires_in: 1 }) });
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(await cache.getToken('svc', config(`${origin}/token`), store)).toBe('tok-1');
      expect(await cache.getToken('svc', config(`${origin}/token`), store)).toBe('tok-1');
      expect(cache.cleanExpired()).toBe(0);
      vi.setSystemTime(Date.now() + 5_000);
      expect(cache.cleanExpired()).toBe(1);
      expect(cache.cleanExpired()).toBe(0);
      expect(await cache.getToken('svc', config(`${origin}/token`), store)).toBe('tok-2');
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------

describe('OpenShell driver core: failure paths', () => {
  let store: MemoryStore;
  let events: DriverAccessEvent[];
  const scope = createBrokerScope({ projectsPath: '/nonexistent/projects.yaml', allowedRefs: ['aquaman://github/token'] });
  const core = () => createOpenShellDriverCore({ store, scope, version: 'test', onAccess: (e) => events.push(e) });
  const code = async (p: Promise<unknown>) => p.then(() => 'no error', (e) => (e instanceof DriverError ? e.code : `not a DriverError: ${e}`));

  beforeEach(() => {
    store = new MemoryStore();
    events = [];
  });

  it('refuses a copy it cannot derive a vault key for, and stores nothing', async () => {
    const c = core();
    for (const req of [
      { value: 'sk-plain', credential_key: 'API_KEY' },
      { value: 'sk-plain', provider_id: 'p1' },
      { value: 'sk-plain', provider_id: 'p 1', credential_key: 'API_KEY' },
      { value: 'sk-plain', object_id: '../x', credential_key: 'API_KEY' },
    ]) {
      await expect(c.store(req)).rejects.toThrow(/cannot derive a vault key/);
      expect(await code(c.store(req))).toBe('invalid_argument');
    }
    expect(await store.list()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('reports a vault that refuses the copy as an internal error, audited as a failure without the value', async () => {
    store.set = async () => { throw new Error('vault is read-only'); };
    const attempt = core().store({ value: 'sk-plain-secret', provider: 'custom', provider_id: 'p1', credential_key: 'API_KEY' });
    await expect(attempt).rejects.toThrow('aquaman: vault write failed: vault is read-only');
    expect(await code(attempt)).toBe('internal');
    expect(events).toEqual([{
      op: 'store', mode: 'copy', ref: 'aquaman://openshell/p1.API_KEY', service: 'openshell', provider: 'custom', success: false, error: 'vault is read-only',
    }]);
    expect(JSON.stringify(events)).not.toContain('sk-plain-secret');
  });

  it('resolving a copy that is no longer in the vault is not_found, with the fix', async () => {
    const attempt = core().resolve([{ request_id: 'r1', provider: 'custom', handle: { driver: 'aquaman', handle: 'aquaman://openshell/p1.API_KEY' } }]);
    await expect(attempt).rejects.toThrow('aquaman: aquaman://openshell/p1.API_KEY is not in the vault. Fix: aquaman credentials add openshell p1.API_KEY');
    expect(await code(attempt)).toBe('not_found');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ op: 'resolve', mode: 'copy', success: false });
  });

  it('reports a vault that fails on read as an internal error naming the reference', async () => {
    await store.set('github', 'token', 'ghp_value');
    store.get = async () => { throw new Error('backend locked'); };
    const attempt = core().resolve([{ request_id: 'r1', handle: { driver: 'aquaman', handle: 'aquaman://github/token' } }]);
    await expect(attempt).rejects.toThrow('aquaman: vault read failed for aquaman://github/token: backend locked');
    expect(await code(attempt)).toBe('internal');
    expect(events).toEqual([{ op: 'resolve', mode: 'reference', ref: 'aquaman://github/token', service: 'github', provider: '', success: false, error: 'backend locked' }]);
  });

  it('refuses a handle that is not an aquaman reference, and an empty value', async () => {
    expect(await code(core().resolve([{ request_id: 'r1', handle: { driver: 'aquaman', handle: 'vault://x' } }]))).toBe('invalid_argument');
    expect(await code(core().resolve([{ request_id: 'r1' }]))).toBe('invalid_argument');
    expect(await code(core().delete({ handle: { driver: 'aquaman', handle: '' } }))).toBe('invalid_argument');
    expect(await code(core().store({ value: '', provider_id: 'p1', credential_key: 'K' }))).toBe('invalid_argument');
  });

  it('a resolve whose audit entry cannot be written returns no value; other operations keep their own result', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await store.set('github', 'token', 'ghp_value');
    for (const onAccess of [() => { throw new Error('audit disk full'); }, async () => { throw new Error('audit disk full'); }]) {
      const c = createOpenShellDriverCore({ store, scope, version: 'test', onAccess });
      const attempt = c.resolve([{ request_id: 'r1', handle: { driver: 'aquaman', handle: 'aquaman://github/token' } }]);
      await expect(attempt).rejects.toThrow(/the audit log could not be written, so aquaman:\/\/github\/token was not resolved\. Fix: /);
      expect(await code(attempt)).toBe('internal');
      await expect(attempt).rejects.not.toThrow(/ghp_value/);
      // A copy-mode store hands nothing out, so it succeeds and the failure is reported.
      expect((await c.store({ value: 'sk-copy', provider_id: 'p1', credential_key: 'K' })).handle.handle).toBe('aquaman://openshell/p1.K');
    }
    await new Promise((r) => setImmediate(r));
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^AUDIT FAILURE: could not record OpenShell resolve of aquaman:\/\/github\/token: audit disk full/));
    errors.mockRestore();
  });

  it('without a broker scope every reference is refused and nothing is listed', async () => {
    await store.set('github', 'token', 'ghp_value');
    const c = createOpenShellDriverCore({ store, version: 'test' });
    const attempt = c.store({ value: 'aquaman://github/token', provider_id: 'p1', credential_key: 'K' });
    await expect(attempt).rejects.toThrow(/the broker is disabled/);
    expect(await code(attempt)).toBe('failed_precondition');
    expect(c.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('declared-ref files that cannot be read', () => {
  it('loadProjectRefs declares nothing and says why', () => {
    const projects = path.join(dir, 'projects.yaml');
    fs.mkdirSync(projects); // a directory where the file should be
    const result = loadProjectRefs(projects);
    expect(result.refs.size).toBe(0);
    expect(result.error).toMatch(new RegExp(`^cannot read ${projects.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `));
  });

  it('loadConfigAllowedRefs declares nothing and says why', () => {
    const config = path.join(dir, 'config.yaml');
    fs.mkdirSync(config);
    const result = loadConfigAllowedRefs(config);
    expect(result.refs.size).toBe(0);
    expect(result.error).toContain(`cannot read ${config}: `);
  });

  it('a broker scope over unreadable files refuses every ref', () => {
    const projects = path.join(dir, 'projects.yaml');
    const config = path.join(dir, 'config.yaml');
    fs.mkdirSync(projects);
    fs.mkdirSync(config);
    const scope = createBrokerScope({ projectsPath: projects, configPath: config });
    const decision = scope.check('github', 'token', 'uds');
    expect(decision.allowed).toBe(false);
    expect(scope.declared()).toEqual([]);
  });

  it('hermesSecretSourceRefs reports a config it cannot read, and reads none from a missing one', () => {
    setEnv('HERMES_HOME', undefined);
    expect(hermesSecretSourceRefs(dir)).toEqual({ path: path.join(dir, '.hermes', 'config.yaml'), refs: [] });
    fs.mkdirSync(path.join(dir, '.hermes', 'config.yaml'), { recursive: true });
    const result = hermesSecretSourceRefs(dir);
    expect(result.refs).toEqual([]);
    expect(result.error).toContain(`cannot read ${path.join(dir, '.hermes', 'config.yaml')}: `);
  });

  it('writeHermesEnv creates the Hermes directory owner-only when it does not exist', () => {
    const file = path.join(dir, 'fresh', '.hermes', '.env');
    writeHermesEnv({ AQUAMAN_LOOPBACK_URL: 'http://127.0.0.1:8585' }, file);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf-8')).toBe('# >>> aquaman managed >>>\nAQUAMAN_LOOPBACK_URL=http://127.0.0.1:8585\n# <<< aquaman managed <<<\n');
  });
});

// ---------------------------------------------------------------------------

describe('channel routing status', () => {
  const has = { hasVaultCredential: () => true };

  it('reports a self-hosted apiRoot as the user\'s endpoint, not as routed', () => {
    expect(channelRoutingStatus({ channels: { telegram: { apiRoot: 'https://bot-api.internal.example.com' } } }, has)).toEqual({
      routed: [],
      notRouted: [{ channel: 'telegram', reason: 'user-endpoint' }],
      unroutable: [],
    });
    // A value that is not even a string is still somebody else's setting.
    expect(channelRoutingStatus({ channels: { telegram: { apiRoot: null } } }, has).notRouted).toEqual([{ channel: 'telegram', reason: 'user-endpoint' }]);
  });

  it('tells routed, not wired and no-credential apart', () => {
    expect(channelRoutingStatus({ channels: { telegram: { apiRoot: 'http://127.0.0.1:8585/telegram' } } }, has).routed).toEqual(['telegram']);
    expect(channelRoutingStatus({ channels: { telegram: { botToken: 'x' } } }, has).notRouted).toEqual([{ channel: 'telegram', reason: 'not-wired' }]);
    expect(channelRoutingStatus({ channels: { telegram: { botToken: 'x' } } }, { hasVaultCredential: () => false }).notRouted)
      .toEqual([{ channel: 'telegram', reason: 'no-vault-credential' }]);
    expect(channelRoutingStatus({}, has)).toEqual({ routed: [], notRouted: [], unroutable: [] });
    expect(channelRoutingStatus({ channels: 'x' }, has)).toEqual({ routed: [], notRouted: [], unroutable: [] });
  });

  it('only Telegram has a loopback base URL, with trailing slashes on the origin dropped', () => {
    expect(loopbackChannelBaseUrl('telegram', 'http://127.0.0.1:8585///')).toBe('http://127.0.0.1:8585/telegram');
    expect(loopbackChannelBaseUrl('discord', 'http://127.0.0.1:8585')).toBeNull();
  });

  it('wiring leaves a config with no channels untouched', () => {
    const config = { models: {} };
    expect(wireChannelRouting(config, { loopbackOrigin: 'http://127.0.0.1:8585', loopbackToken: 'aqm_lb_x', hasVaultCredential: () => true }))
      .toEqual({ changed: false, routedChannels: [], skipped: [] });
    expect(config).toEqual({ models: {} });
  });
});

// ---------------------------------------------------------------------------

describe('VaultStore against a local server', () => {
  let server: http.Server;
  let address: string;
  let seen: Array<{ method: string; url: string; token: string | undefined }>;
  let respond: (req: { method: string; url: string }) => { status: number; body?: string };

  beforeEach(async () => {
    seen = [];
    respond = () => ({ status: 404 });
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const r = { method: req.method ?? '', url: req.url ?? '' };
        seen.push({ ...r, token: req.headers['x-vault-token'] as string | undefined });
        const reply = respond(r);
        res.statusCode = reply.status;
        res.end(reply.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    setEnv('VAULT_TOKEN', undefined);
    setEnv('VAULT_NAMESPACE', undefined);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const vault = () => createVaultStore({ address, token: 'hvs.test' });

  it('requires an address as well as a token', () => {
    expect(() => new VaultStore({ address: '', token: 'hvs.test' })).toThrow('Vault address required. Provide via options.address or VAULT_ADDR env var.');
    expect(() => new VaultStore({ address, token: '' })).toThrow('Vault token required');
  });

  it('get surfaces a server error with its status and body, rather than reading it as "not stored"', async () => {
    respond = () => ({ status: 503, body: 'Vault is sealed' });
    await expect(vault().get('github', 'token')).rejects.toThrow('Vault API error (503): Vault is sealed');
    await expect(vault().exists('github', 'token')).rejects.toThrow('Vault API error (503)');
    expect(seen[0]).toEqual({ method: 'GET', url: '/v1/secret/data/aquaman/github/token', token: 'hvs.test' });
  });

  it('get surfaces a permission error', async () => {
    respond = () => ({ status: 403, body: '{"errors":["permission denied"]}' });
    await expect(vault().get('github', 'token')).rejects.toThrow('Vault API error (403): {"errors":["permission denied"]}');
  });

  it('get returns null for a secret with no credential field', async () => {
    respond = () => ({ status: 200, body: JSON.stringify({ data: { data: { something_else: 'x' } } }) });
    expect(await vault().get('github', 'token')).toBeNull();
  });

  it('set surfaces a refused write', async () => {
    respond = () => ({ status: 403, body: 'permission denied' });
    await expect(vault().set('github', 'token', 'ghp_value')).rejects.toThrow('Vault API error (403): permission denied');
  });

  it('delete is true on 204, false on 404, and surfaces a server error', async () => {
    respond = () => ({ status: 204 });
    expect(await vault().delete('github', 'token')).toBe(true);
    expect(seen[0]).toMatchObject({ method: 'DELETE', url: '/v1/secret/metadata/aquaman/github/token' });
    respond = () => ({ status: 404 });
    expect(await vault().delete('github', 'token')).toBe(false);
    respond = () => ({ status: 500, body: 'internal error' });
    await expect(vault().delete('github', 'token')).rejects.toThrow('Vault API error (500): internal error');
  });

  /** Node's HTTP server refuses the non-standard LIST method, so listing is answered by a stubbed fetch. */
  function stubFetch(): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const r = { method: init?.method ?? 'GET', url: url.pathname };
      seen.push({ ...r, token: (init?.headers as Record<string, string>)['X-Vault-Token'] });
      const reply = respond(r);
      return new Response(reply.body ?? '', { status: reply.status });
    });
  }

  it('list of one service is empty on 404 and surfaces a server error', async () => {
    stubFetch();
    respond = () => ({ status: 404 });
    expect(await vault().list('github')).toEqual([]);
    expect(seen[0]).toEqual({ method: 'LIST', url: '/v1/secret/metadata/aquaman/github', token: 'hvs.test' });
    respond = () => ({ status: 500, body: 'internal error' });
    await expect(vault().list('github')).rejects.toThrow('Vault API error (500): internal error');
    await expect(vault().list()).rejects.toThrow('Vault API error (500): internal error');
  });

  it('an error whose body mentions 404 is an error, not "not stored"', async () => {
    stubFetch();
    respond = () => ({ status: 500, body: 'upstream answered 404 for the storage backend' });
    await expect(vault().get('github', 'token')).rejects.toThrow('Vault API error (500): upstream answered 404');
    await expect(vault().exists('github', 'token')).rejects.toThrow('Vault API error (500)');
    await expect(vault().delete('github', 'token')).rejects.toThrow('Vault API error (500)');
    await expect(vault().list('github')).rejects.toThrow('Vault API error (500)');
    await expect(vault().list()).rejects.toThrow('Vault API error (500)');
    respond = () => ({ status: 403, body: '{"errors":["permission denied on path 404-team/"]}' });
    await expect(vault().get('github', 'token')).rejects.toThrow('Vault API error (403)');
    await expect(vault().delete('github', 'token')).rejects.toThrow('Vault API error (403)');
    await expect(vault().list('github')).rejects.toThrow('Vault API error (403)');
  });

  it('list tolerates a reply with no keys, and drops the trailing slash Vault puts on folders', async () => {
    stubFetch();
    respond = () => ({ status: 200, body: JSON.stringify({ data: {} }) });
    expect(await vault().list('github')).toEqual([]);
    expect(await vault().list()).toEqual([]);
    respond = (r) => ({
      status: 200,
      body: JSON.stringify({ data: { keys: r.url.endsWith('/aquaman') ? ['github/'] : ['token', 'nested/'] } }),
    });
    expect(await vault().list()).toEqual([{ service: 'github', key: 'token' }, { service: 'github', key: 'nested' }]);
  });

  it('refuses names that could not be path segments, before any request', async () => {
    await expect(vault().get('../sys', 'token')).rejects.toThrow('Invalid service name: "../sys"');
    await expect(vault().set('github', 'a/b', 'v')).rejects.toThrow('Invalid key name: "a/b"');
    expect(seen).toEqual([]);
  });

  it('isAvailable is false without a token, and false when the token is refused', async () => {
    expect(await VaultStore.isAvailable({ address })).toBe(false);
    expect(seen).toEqual([]);
    respond = () => ({ status: 403 });
    expect(await VaultStore.isAvailable({ address, token: 'hvs.bad' })).toBe(false);
    expect(seen[0]).toEqual({ method: 'GET', url: '/v1/auth/token/lookup-self', token: 'hvs.bad' });
    respond = () => ({ status: 200, body: '{}' });
    expect(await VaultStore.isAvailable({ address, token: 'hvs.good' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('KeePassXCStore: key file, groups and directories', () => {
  const PASSWORD = 'test-password-for-keepass';
  const stores: KeePassXCStore[] = [];
  const open = (options: ConstructorParameters<typeof KeePassXCStore>[0]) => {
    const s = createKeePassXCStore(options);
    stores.push(s);
    return s;
  };

  afterEach(() => {
    for (const s of stores.splice(0)) s.close();
  });

  it('creates the database in a directory that does not exist yet, owner-only', async () => {
    const dbPath = path.join(dir, 'nested', 'deeper', 'vault.kdbx');
    const store = open({ dbPath, password: PASSWORD });
    await store.set('github', 'token', 'ghp_kdbx');
    expect(fs.statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(dbPath).includes('ghp_kdbx')).toBe(false);
    expect(await open({ dbPath, password: PASSWORD }).get('github', 'token')).toBe('ghp_kdbx');
  });

  it('opens with a key file alone, and not with a different key file', async () => {
    const dbPath = path.join(dir, 'keyfile.kdbx');
    const keyFilePath = path.join(dir, 'vault.key');
    fs.writeFileSync(keyFilePath, Buffer.alloc(32, 7));
    await open({ dbPath, keyFilePath }).set('github', 'token', 'ghp_keyfile');
    expect(await open({ dbPath, keyFilePath }).get('github', 'token')).toBe('ghp_keyfile');

    const otherKey = path.join(dir, 'other.key');
    fs.writeFileSync(otherKey, Buffer.alloc(32, 9));
    await expect(open({ dbPath, keyFilePath: otherKey }).get('github', 'token'))
      .rejects.toThrow('Failed to open KeePassXC database - wrong password or key file?');
    await expect(open({ dbPath, password: PASSWORD }).get('github', 'token'))
      .rejects.toThrow('Failed to open KeePassXC database - wrong password or key file?');
  });

  it('a store using another group sees none of the first group\'s entries, and creates its group on first write', async () => {
    const dbPath = path.join(dir, 'groups.kdbx');
    await open({ dbPath, password: PASSWORD }).set('github', 'token', 'ghp_default_group');

    const other = open({ dbPath, password: PASSWORD, group: 'team-b' });
    expect(await other.get('github', 'token')).toBeNull();
    expect(await other.exists('github', 'token')).toBe(false);
    expect(await other.list()).toEqual([]);
    expect(await other.delete('github', 'token')).toBe(false);

    await other.set('github', 'token', 'ghp_team_b');
    expect(await other.get('github', 'token')).toBe('ghp_team_b');
    expect(await other.list()).toEqual([{ service: 'github', key: 'token' }]);
    // The first group's value is untouched.
    expect(await open({ dbPath, password: PASSWORD }).get('github', 'token')).toBe('ghp_default_group');
  });

  it('delete returns false for an entry that is not there and true for one that is', async () => {
    const dbPath = path.join(dir, 'delete.kdbx');
    const store = open({ dbPath, password: PASSWORD });
    await store.set('github', 'token', 'v');
    expect(await store.delete('github', 'missing')).toBe(false);
    expect(await store.delete('github', 'token')).toBe(true);
    expect(await store.get('github', 'token')).toBeNull();
    expect(await store.list('github')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('request policy: ** in the middle of a pattern', () => {
  it('matches any number of segments, and fails when what follows it never appears', () => {
    expect(matchPathPattern('/v1/**/delete', '/v1/a/b/delete')).toBe(true);
    expect(matchPathPattern('/v1/**/delete', '/v1/delete')).toBe(true);
    expect(matchPathPattern('/v1/**/delete', '/v1/a/b/update')).toBe(false);
    expect(matchPathPattern('/v1/**/delete', '/v2/a/delete')).toBe(false);
  });

  it('a deny rule with ** in the middle applies at every depth and to nothing else', () => {
    const policy = { github: { defaultAction: 'allow' as const, rules: [{ method: 'DELETE', path: '/repos/**/keys', action: 'deny' as const }] } };
    expect(matchPolicy('github', 'DELETE', '/repos/o/r/keys', policy).allowed).toBe(false);
    expect(matchPolicy('github', 'DELETE', '/repos/keys', policy).allowed).toBe(false);
    expect(matchPolicy('github', 'DELETE', '/repos/o/r/issues', policy).allowed).toBe(true);
    expect(matchPolicy('github', 'GET', '/repos/o/r/keys', policy).allowed).toBe(true);
  });
});

describe('findOpenClawConfig', () => {
  it('returns the given path as it is, and ~/.openclaw/openclaw.json otherwise', () => {
    setEnv('HOME', dir);
    expect(findOpenClawConfig('/somewhere/else.json')).toBe('/somewhere/else.json');
    expect(findOpenClawConfig()).toBe(path.join(dir, '.openclaw', 'openclaw.json'));
  });
});

describe('OpenShell driver over its socket: every access reaches the audit sink', () => {
  it('audits a resolve and a refused resolve, by reference and never by value', async () => {
    const sockDir = fs.mkdtempSync(path.join('/tmp', 'aqoc-'));
    const socketPath = path.join(sockDir, 'd.sock');
    const store = new MemoryStore();
    await store.set('github', 'token', 'ghp_openshell_audited_value');
    const scope = createBrokerScope({ projectsPath: path.join(sockDir, 'none.yaml'), allowedRefs: ['aquaman://github/token'] });
    const calls: Array<{ agentId: string; access: Parameters<AuditSink['logCredentialAccess']>[2] }> = [];
    const audit: AuditSink = { logCredentialAccess: (_s, agentId, access) => { calls.push({ agentId, access }); } };
    const server = await startOpenShellDriver({
      config: { ...getDefaultConfig(), openshell: { driver: { enabled: true, socketPath } } },
      store, scope, audit, version: 't',
    });
    const def = protoLoader.loadSync('credential_driver.proto', { includeDirs: [openshellProtoDir()], keepCase: true, defaults: true });
    const pkg: any = grpc.loadPackageDefinition(def);
    const client = new pkg.openshell.credentials.v1.CredentialDriver(`unix://${socketPath}`, grpc.credentials.createInsecure());
    const call = (m: string, req: unknown) => new Promise<any>((res, rej) => client[m](req, (e: any, r: any) => (e ? rej(e) : res(r))));
    try {
      const ok = await call('ResolveCredentials', { credentials: [{ request_id: 'r1', provider: 'gh', handle: { driver: 'aquaman', handle: 'aquaman://github/token' } }] });
      expect(ok.credentials).toHaveLength(1);
      expect(ok.credentials[0]).toMatchObject({ request_id: 'r1', value: 'ghp_openshell_audited_value' });
      await expect(call('ResolveCredentials', { credentials: [{ request_id: 'r2', provider: 'gh', handle: { driver: 'aquaman', handle: 'aquaman://github/undeclared' } }] }))
        .rejects.toMatchObject({ code: grpc.status.FAILED_PRECONDITION });
      await expect(call('DeleteCredential', { handle: { driver: 'aquaman', handle: 'not-a-handle' } }))
        .rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
      await expect(call('DeleteCredential', { handle: { driver: 'aquaman', handle: 'aquaman://github/token' } })).resolves.toEqual({});
      // Deleting a reference never removes the user's own vault item.
      expect(await store.get('github', 'token')).toBe('ghp_openshell_audited_value');

      expect(calls).toHaveLength(2);
      expect(calls[0]).toMatchObject({ agentId: 'openshell', access: { service: 'github', operation: 'read', success: true } });
      expect(calls[1]).toMatchObject({ agentId: 'openshell', access: { service: 'github', operation: 'read', success: false } });
      expect(JSON.stringify(calls)).not.toContain('ghp_openshell_audited_value');
    } finally {
      client.close();
      await server.stop();
      fs.rmSync(sockDir, { recursive: true, force: true });
    }
  });
});
