/**
 * Unit tests for the Hermes config-writer (v0.13.0+)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  managedScopeShadowedKeys,
  generateHermesEnv,
  hermesWiredServices,
  getHermesEnvPath,
  hermesConfigSetWritesEnv,
  isHermesProfileName,
  hermesConfigSetArgs,
  formatHermesConfigSetCommands,
  readEnvAssignments,
  hermesEnvWiring,
  hermesRealKeysInEnv,
  hermesEnvOpenToOthers,
  hermesSecretSourceRefs,
  hermesManagedEnvPath,
} from 'aquaman-proxy';

describe('generateHermesEnv', () => {
  const opts = { port: 8585, token: 'aqm_lb_tok', host: '127.0.0.1' };

  it('maps anthropic to /anthropic (no /v1) + placeholder key', () => {
    const env = generateHermesEnv({ ...opts, services: ['anthropic'] });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8585/anthropic');
    expect(env['ANTHROPIC_API_KEY']).toBe('aqm_lb_tok');
  });

  it('maps openai to /openai/v1 + placeholder key', () => {
    const env = generateHermesEnv({ ...opts, services: ['openai'] });
    expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:8585/openai/v1');
    expect(env['OPENAI_API_KEY']).toBe('aqm_lb_tok');
  });

  it('ignores unsupported services (channels/other providers)', () => {
    const env = generateHermesEnv({ ...opts, services: ['slack', 'telegram', 'github'] });
    // Only the always-on loopback wiring remains — no provider vars.
    expect(Object.keys(env).sort()).toEqual(['AQUAMAN_LOOPBACK_TOKEN', 'AQUAMAN_LOOPBACK_URL']);
  });

  it('always wires the loopback origin + token for the secret source (v0.14.0+)', () => {
    const env = generateHermesEnv({ ...opts, services: ['anthropic'] });
    expect(env['AQUAMAN_LOOPBACK_URL']).toBe('http://127.0.0.1:8585');
    expect(env['AQUAMAN_LOOPBACK_TOKEN']).toBe('aqm_lb_tok');
  });

  it('honors a custom host', () => {
    const env = generateHermesEnv({ port: 9000, token: 't', host: '127.0.0.2', services: ['anthropic'] });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.2:9000/anthropic');
  });

  it('defaults host to 127.0.0.1', () => {
    const env = generateHermesEnv({ port: 9000, token: 't', services: ['anthropic'] });
    expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:9000/anthropic');
  });
});

describe('hermesWiredServices', () => {
  it('returns only anthropic/openai from a mixed list', () => {
    expect(hermesWiredServices(['anthropic', 'slack', 'openai', 'github'])).toEqual(['anthropic', 'openai']);
  });

  it('returns empty when no supported services present', () => {
    expect(hermesWiredServices(['slack', 'discord'])).toEqual([]);
  });
});

describe('getHermesEnvPath', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in original)) delete process.env[k];
    Object.assign(process.env, original);
  });

  it('defaults to ~/.hermes/.env', () => {
    delete process.env['HERMES_HOME'];
    expect(getHermesEnvPath('/home/me')).toBe(path.join('/home/me', '.hermes', '.env'));
  });

  it('honors the HERMES_HOME override (matches the Hermes CLI)', () => {
    process.env['HERMES_HOME'] = '/custom/hermes';
    expect(getHermesEnvPath('/home/me')).toBe(path.join('/custom/hermes', '.env'));
  });
});

describe('storing the settings through `hermes config set`', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-hermes-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const file = () => path.join(dir, '.env');
  const env = generateHermesEnv({ port: 8585, token: 'aqm_lb_tok', services: ['anthropic', 'openai'] });

  it('sets each base URL before its key: Hermes records the base URL with the key in its credential pool', () => {
    const keys = hermesConfigSetArgs(env).map((args) => args[2]);
    expect(keys).toEqual([
      'AQUAMAN_LOOPBACK_URL', 'AQUAMAN_LOOPBACK_TOKEN',
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY',
      'OPENAI_BASE_URL', 'OPENAI_API_KEY',
    ]);
  });

  it('builds one `config set` per setting, with the profile flag before the subcommand', () => {
    expect(hermesConfigSetArgs({ A_URL: 'http://127.0.0.1:1', B_KEY: 'x y' })).toEqual([
      ['config', 'set', 'A_URL', 'http://127.0.0.1:1'],
      ['config', 'set', 'B_KEY', 'x y'],
    ]);
    expect(hermesConfigSetArgs({ A_URL: 'u' }, 'work')).toEqual([['-p', 'work', 'config', 'set', 'A_URL', 'u']]);
  });

  it('prints the same commands for a shell, quoting a value that needs it', () => {
    expect(formatHermesConfigSetCommands({ A_URL: 'http://127.0.0.1:8585/openai/v1', B: "it's $HOME" }, 'work')).toBe(
      "  hermes -p work config set A_URL http://127.0.0.1:8585/openai/v1\n  hermes -p work config set B 'it'\\''s $HOME'",
    );
  });

  it.each([
    ['0.21.4', true], ['0.21.5', true], ['0.22.0', true], ['0.23.1', true], ['1.0.0', true],
    ['0.21.3', false], ['0.19.0', false], ['0.18.1', false],
    // A build that does not say which version it is cannot be relied on to store by shape.
    ['dev build', false], ['', false], [undefined, false],
  ])('Hermes %s stores every setting in .env: %s', (version, expected) => {
    expect(hermesConfigSetWritesEnv(version)).toBe(expected);
  });

  it.each([
    ['work', true], ['default', true], ['a', true], ['team_2-b', true], ['9lives', true], ['a'.repeat(64), true],
    ['', false], ['Work', false], ['-p', false], ['_x', false], ['a b', false], ['a/b', false],
    ['../x', false], ['a.b', false], ['a'.repeat(65), false], ['wörk', false], ['x\n', false],
  ])('profile name %j is accepted: %s', (name, ok) => {
    expect(isHermesProfileName(name)).toBe(ok);
  });

  it('reads assignments as Hermes writes them and as people write them', () => {
    fs.writeFileSync(file(), [
      '# a comment', '', 'PLAIN=value', 'export EXPORTED=1', '  INDENTED = spaced  ',
      'QUOTED="has # and space"', "SINGLE='x'", 'EMPTY=', 'not an assignment', 'TWICE=first', 'TWICE=second',
      'URL=http://127.0.0.1:8585/openai/v1', '9BAD=x',
    ].join('\r\n'));
    expect(readEnvAssignments(file())).toEqual({
      PLAIN: 'value', EXPORTED: '1', INDENTED: 'spaced', QUOTED: 'has # and space', SINGLE: 'x',
      EMPTY: '', TWICE: 'second', URL: 'http://127.0.0.1:8585/openai/v1',
    });
    expect(readEnvAssignments(path.join(dir, 'absent'))).toBeNull();
  });

  it('says which settings a file lacks and which it holds with another value', () => {
    expect(hermesEnvWiring(file(), env)).toEqual({ readable: false, missing: Object.keys(env), differing: [] });
    fs.writeFileSync(file(), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    expect(hermesEnvWiring(file(), env)).toEqual({ readable: true, missing: [], differing: [] });
    fs.writeFileSync(file(), 'ANTHROPIC_BASE_URL=https://gateway.example.com\nAQUAMAN_LOOPBACK_URL=http://127.0.0.1:8585\n');
    expect(hermesEnvWiring(file(), env)).toEqual({
      readable: true,
      missing: ['AQUAMAN_LOOPBACK_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
      differing: ['ANTHROPIC_BASE_URL'],
    });
  });

  it('finds a provider key that is not an aquaman placeholder, and only that', () => {
    expect(hermesRealKeysInEnv(file(), env)).toEqual([]);
    fs.writeFileSync(file(), [
      'ANTHROPIC_API_KEY=sk-ant-' + 'a'.repeat(20),
      'OPENAI_API_KEY=aqm_lb_an_older_token',
      'AQUAMAN_LOOPBACK_TOKEN=something-else',
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
    ].join('\n'));
    expect(hermesRealKeysInEnv(file(), env)).toEqual(['ANTHROPIC_API_KEY']);
    fs.writeFileSync(file(), 'ANTHROPIC_API_KEY=\nOPENAI_API_KEY=aquaman-proxy-managed\n');
    expect(hermesRealKeysInEnv(file(), env)).toEqual([]);
  });

  it('says when the file can be read by others', () => {
    expect(hermesEnvOpenToOthers(file())).toBe(false);
    fs.writeFileSync(file(), 'X=1\n', { mode: 0o600 });
    expect(hermesEnvOpenToOthers(file())).toBe(false);
    for (const mode of [0o640, 0o604, 0o644]) {
      fs.chmodSync(file(), mode);
      expect(hermesEnvOpenToOthers(file())).toBe(true);
    }
  });

  it('places a named profile under profiles/<name> when Hermes cannot be asked', () => {
    const before = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = dir;
    try {
      expect(getHermesEnvPath('/nowhere')).toBe(path.join(dir, '.env'));
      expect(getHermesEnvPath('/nowhere', 'default')).toBe(path.join(dir, '.env'));
      expect(getHermesEnvPath('/nowhere', 'work')).toBe(path.join(dir, 'profiles', 'work', '.env'));
    } finally {
      if (before === undefined) delete process.env['HERMES_HOME'];
      else process.env['HERMES_HOME'] = before;
    }
  });
});

describe('managedScopeShadowedKeys (Hermes >=0.17 managed scope)', () => {
  let dir: string;
  const OUR_ENV = {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8585/anthropic',
    ANTHROPIC_API_KEY: 'aqm_lb_token',
    OPENAI_BASE_URL: 'http://127.0.0.1:8585/openai/v1',
    OPENAI_API_KEY: 'aqm_lb_token',
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-managed-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (content: string) => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, content);
    return p;
  };

  it('returns empty when the managed file does not exist', () => {
    expect(managedScopeShadowedKeys(OUR_ENV, path.join(dir, 'missing.env'))).toEqual([]);
  });

  it('returns empty when the managed file pins unrelated keys', () => {
    const p = write('SOME_OTHER_KEY=value\nHTTP_PROXY=http://proxy\n');
    expect(managedScopeShadowedKeys(OUR_ENV, p)).toEqual([]);
  });

  it('detects a pinned key aquaman manages', () => {
    const p = write('ANTHROPIC_API_KEY=sk-ant-direct\n');
    expect(managedScopeShadowedKeys(OUR_ENV, p)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('detects multiple pinned keys, export-prefixed and indented lines included', () => {
    const p = write('  export ANTHROPIC_BASE_URL=https://api.anthropic.com\nOPENAI_API_KEY = sk-openai\n');
    expect(managedScopeShadowedKeys(OUR_ENV, p).sort()).toEqual(['ANTHROPIC_BASE_URL', 'OPENAI_API_KEY']);
  });

  it('ignores comments and non-assignment lines', () => {
    const p = write('# ANTHROPIC_API_KEY=commented-out\nnot an assignment\n');
    expect(managedScopeShadowedKeys(OUR_ENV, p)).toEqual([]);
  });

  it('returns empty for an unreadable path instead of throwing', () => {
    expect(managedScopeShadowedKeys(OUR_ENV, path.join(dir, 'nodir', 'x.env'))).toEqual([]);
  });
});

describe('hermesSecretSourceRefs (v0.15.0 doctor input)', () => {
  let home: string;
  const prevHermesHome = process.env['HERMES_HOME'];
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-hermes-refs-'));
    process.env['HERMES_HOME'] = path.join(home, '.hermes');
    fs.mkdirSync(process.env['HERMES_HOME'], { recursive: true });
  });
  afterEach(() => {
    if (prevHermesHome === undefined) delete process.env['HERMES_HOME'];
    else process.env['HERMES_HOME'] = prevHermesHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns valid bound refs, skipping the provider vars the source refuses', () => {
    fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), [
      'secrets:',
      '  aquaman:',
      '    enabled: true',
      '    env:',
      '      GITHUB_TOKEN: aquaman://github/token',
      '      DATABASE_URL: aquaman://supabase/db_url',
      '      ANTHROPIC_API_KEY: aquaman://anthropic/api_key',
      '      BROKEN: not-a-ref',
    ].join('\n'));
    const r = hermesSecretSourceRefs(home);
    expect(r.error).toBeUndefined();
    expect(r.refs).toEqual(['aquaman://github/token', 'aquaman://supabase/db_url']);
    expect(r.path).toBe(path.join(home, '.hermes', 'config.yaml'));
  });

  it('is empty without a config file and reports a malformed one', () => {
    expect(hermesSecretSourceRefs(home).refs).toEqual([]);
    fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), 'secrets: [\n');
    expect(hermesSecretSourceRefs(home).error).toMatch(/cannot parse/);
  });
});

describe('hermesManagedEnvPath (Hermes 0.21 HERMES_MANAGED_DIR)', () => {
  const prev = process.env['HERMES_MANAGED_DIR'];
  afterEach(() => {
    if (prev === undefined) delete process.env['HERMES_MANAGED_DIR'];
    else process.env['HERMES_MANAGED_DIR'] = prev;
  });

  it('defaults to /etc/hermes/.env and honors a non-empty override', () => {
    delete process.env['HERMES_MANAGED_DIR'];
    expect(hermesManagedEnvPath()).toBe('/etc/hermes/.env');
    process.env['HERMES_MANAGED_DIR'] = '  ';
    expect(hermesManagedEnvPath()).toBe('/etc/hermes/.env');
    process.env['HERMES_MANAGED_DIR'] = '/opt/org/hermes-policy';
    expect(hermesManagedEnvPath()).toBe('/opt/org/hermes-policy/.env');
  });

  it('managedScopeShadowedKeys reads the relocated scope by default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-managed-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'ANTHROPIC_BASE_URL=https://api.anthropic.com\n');
      process.env['HERMES_MANAGED_DIR'] = dir;
      expect(managedScopeShadowedKeys({ ANTHROPIC_BASE_URL: 'x', OPENAI_BASE_URL: 'y' })).toEqual(['ANTHROPIC_BASE_URL']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
