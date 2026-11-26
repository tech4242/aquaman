/**
 * OpenClaw's config file: locating it, the merge patch aquaman hands to
 * `openclaw config patch`, and what happens when the patch cannot be applied.
 * The program is the stand-in in test/helpers/fake-openclaw.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openclawPaths, openclawProfileArgs, isOpenClawProfileName, openclawConfigReadOnly, configHasIncludes,
  configMergePatch, patchIsApplied, applyOpenClawPatch,
} from '../../packages/proxy/src/openclaw/config-file.js';
import { installFakeOpenClaw, fakeOpenClawCalls, applyMergePatch } from '../helpers/fake-openclaw.js';

describe('openclawPaths', () => {
  it('uses ~/.openclaw, or what the environment names', () => {
    expect(openclawPaths(undefined, {}, '/h')).toEqual({ stateDir: '/h/.openclaw', configPath: '/h/.openclaw/openclaw.json' });
    expect(openclawPaths(undefined, { OPENCLAW_STATE_DIR: '/s' }, '/h')).toEqual({ stateDir: '/s', configPath: '/s/openclaw.json' });
    expect(openclawPaths(undefined, { OPENCLAW_STATE_DIR: '/s', OPENCLAW_CONFIG_PATH: '/c/oc.json' }, '/h'))
      .toEqual({ stateDir: '/s', configPath: '/c/oc.json' });
    expect(openclawPaths(undefined, { OPENCLAW_CONFIG_PATH: '/c/oc.json' }, '/h'))
      .toEqual({ stateDir: '/h/.openclaw', configPath: '/c/oc.json' });
  });

  it('a named profile lives under ~/.openclaw-<name>, whatever the environment says', () => {
    const env = { OPENCLAW_STATE_DIR: '/s', OPENCLAW_CONFIG_PATH: '/c/oc.json' };
    expect(openclawPaths('work', env, '/h')).toEqual({ stateDir: '/h/.openclaw-work', configPath: '/h/.openclaw-work/openclaw.json' });
    expect(openclawProfileArgs('work')).toEqual(['--profile', 'work']);
    expect(openclawProfileArgs(undefined)).toEqual([]);
  });

  it.each([
    ['work', true], ['dev', true], ['Team_2-b', true], ['a'.repeat(64), true],
    ['', false], ['../x', false], ['a b', false], ['-p', false], ['a/b', false], ['a.b', false], ['a'.repeat(65), false], ['x\n', false],
  ])('profile name %j is accepted: %s', (name, ok) => {
    expect(isOpenClawProfileName(name)).toBe(ok);
  });
});

describe('a config aquaman must not change', () => {
  it('names the variable that marks the config read-only', () => {
    expect(openclawConfigReadOnly({})).toBeNull();
    expect(openclawConfigReadOnly({ OPENCLAW_CONFIG_READONLY: '1' })).toBe('OPENCLAW_CONFIG_READONLY');
    expect(openclawConfigReadOnly({ OPENCLAW_NIX_MODE: '1' })).toBe('OPENCLAW_NIX_MODE');
    // Only the value OpenClaw itself acts on.
    expect(openclawConfigReadOnly({ OPENCLAW_CONFIG_READONLY: 'true', OPENCLAW_NIX_MODE: '0' })).toBeNull();
  });

  it('finds $include at any depth, in objects and arrays', () => {
    expect(configHasIncludes({ a: { b: 1 } })).toBe(false);
    expect(configHasIncludes({ $include: './x.json5' })).toBe(true);
    expect(configHasIncludes({ models: { providers: { $include: ['./a', './b'] } } })).toBe(true);
    expect(configHasIncludes({ list: [{ ok: 1 }, { $include: './x' }] })).toBe(true);
    expect(configHasIncludes(null)).toBe(false);
    expect(configHasIncludes('$include')).toBe(false);
  });
});

describe('configMergePatch', () => {
  it('is undefined when nothing differs, key order aside', () => {
    expect(configMergePatch({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBeUndefined();
    expect(configMergePatch({}, {})).toBeUndefined();
  });

  it('names only what changed: objects by key, arrays and scalars whole, removed keys as null', () => {
    const before = {
      gateway: { port: 18789 },
      plugins: { allow: ['anthropic'], entries: { other: { enabled: true } } },
      models: { providers: { anthropic: { baseUrl: 'https://x', apiKey: { source: 'exec', provider: 'aquaman', id: 'anthropic/api_key' }, models: [] } } },
    };
    const after = {
      gateway: { port: 18789 },
      plugins: { allow: ['anthropic', 'aquaman-plugin'], entries: { other: { enabled: true }, 'aquaman-plugin': { enabled: true } } },
      models: { providers: { anthropic: { baseUrl: 'https://x', models: [] } } },
    };
    expect(configMergePatch(before, after)).toEqual({
      plugins: { allow: ['anthropic', 'aquaman-plugin'], entries: { 'aquaman-plugin': { enabled: true } } },
      models: { providers: { anthropic: { apiKey: null } } },
    });
  });

  it('replaces a scalar by an object and an object by a scalar', () => {
    expect(configMergePatch({ t: 'token' }, { t: { source: 'exec' } })).toEqual({ t: { source: 'exec' } });
    expect(configMergePatch({ t: { source: 'exec' } }, { t: 'token' })).toEqual({ t: 'token' });
  });

  it('applied the way OpenClaw applies a patch, it gives the wanted config', () => {
    const before = { a: { b: 1, c: [1], d: { e: 'x' } }, gone: true };
    const after = { a: { b: 2, c: [1, 2], d: { e: 'x', f: null as unknown as string } }, added: { deep: { er: 1 } } };
    const wanted = { a: { b: 2, c: [1, 2], d: { e: 'x' } }, added: { deep: { er: 1 } } };
    const patch = configMergePatch(before, wanted)!;
    expect(applyMergePatch(structuredClone(before), patch)).toEqual(wanted);
    // An undefined value means "not there", like a missing key.
    expect(configMergePatch({ a: 1 }, { a: 1, b: undefined })).toBeUndefined();
    expect(configMergePatch({ a: 1, b: 2 }, { a: 1, b: undefined })).toEqual({ b: null });
    expect(after.added).toBeDefined();
  });
});

describe('patchIsApplied', () => {
  const patch = { models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic', apiKey: null } } }, plugins: { allow: ['a', 'b'] } };
  it('looks only at what the patch named', () => {
    expect(patchIsApplied({
      models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic', models: [] }, ollama: {} } },
      plugins: { allow: ['a', 'b'], entries: { added: { by: 'openclaw' } } },
      meta: { lastTouchedVersion: 'x' },
    }, patch)).toBe(true);
  });
  it.each([
    ['a value is different', { models: { providers: { anthropic: { baseUrl: 'https://x' } } }, plugins: { allow: ['a', 'b'] } }],
    ['a deleted key is still there', { models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic', apiKey: 'k' } } }, plugins: { allow: ['a', 'b'] } }],
    ['an array is different', { models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' } } }, plugins: { allow: ['a'] } }],
    ['a branch is missing', { plugins: { allow: ['a', 'b'] } }],
    ['there is no config', null],
  ])('is false when %s', (_name, config) => {
    expect(patchIsApplied(config, patch)).toBe(false);
  });
});

describe('applyOpenClawPatch', () => {
  let dir: string;
  let home: string;
  let env: NodeJS.ProcessEnv;
  const patch = { gateway: { port: 19001 } };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-ocf-'));
    home = path.join(dir, 'home');
    fs.mkdirSync(home);
    env = { PATH: process.env['PATH'], HOME: home };
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const configFile = () => path.join(home, '.openclaw', 'openclaw.json');
  const patchFile = () => path.join(dir, 'cfg', 'openclaw-setup.patch.json');
  const base = () => ({ patchDir: path.join(dir, 'cfg'), env, configPath: configFile() });

  it('does nothing for no patch', async () => {
    expect(await applyOpenClawPatch(undefined, { ...base(), binary: installFakeOpenClaw(dir) })).toEqual({ status: 'unchanged' });
    expect(fakeOpenClawCalls(dir)).toEqual([]);
  });

  it('hands the patch to `openclaw config patch --stdin` and reports what OpenClaw said', async () => {
    const result = await applyOpenClawPatch(patch, { ...base(), binary: installFakeOpenClaw(dir) });
    expect(result).toEqual({ status: 'applied', note: 'Applied 1 config update(s). Restart the gateway to apply.' });
    expect(fakeOpenClawCalls(dir)).toEqual([{ argv: ['config', 'patch', '--stdin'], stdin: JSON.stringify(patch), env: { OPENCLAW_CONFIG_PATH: null } }]);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual(patch);
    expect(fs.existsSync(patchFile())).toBe(false);
  });

  it('passes the profile before the subcommand', async () => {
    const result = await applyOpenClawPatch(patch, { ...base(), binary: installFakeOpenClaw(dir), profile: 'work', configPath: path.join(home, '.openclaw-work', 'openclaw.json') });
    expect(result.status).toBe('applied');
    expect(fakeOpenClawCalls(dir)[0]!.argv).toEqual(['--profile', 'work', 'config', 'patch', '--stdin']);
  });

  it.each([
    ['no program', { binary: null }, 'no_cli'],
    ['a read-only config', { envExtra: { OPENCLAW_CONFIG_READONLY: '1' } }, 'read_only'],
    ['a config with $include', { current: { models: { $include: './m.json' } } }, 'includes'],
  ] as const)('with %s: runs nothing, saves the patch owner-only and gives the command', async (_name, extra, reason) => {
    const binary = 'binary' in extra ? extra.binary : installFakeOpenClaw(dir);
    const result = await applyOpenClawPatch(patch, {
      ...base(), binary,
      env: 'envExtra' in extra ? { ...env, ...extra.envExtra } : env,
      current: 'current' in extra ? extra.current : {},
      profile: 'work',
    });
    expect(result).toMatchObject({
      status: 'manual', reason, patchPath: patchFile(),
      command: `openclaw --profile work config patch --file ${patchFile()}`,
    });
    expect(JSON.parse(fs.readFileSync(patchFile(), 'utf-8'))).toEqual(patch);
    expect(fs.statSync(patchFile()).mode & 0o777).toBe(0o600);
    expect(fakeOpenClawCalls(dir)).toEqual([]);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('reports a refusal with what OpenClaw said, and keeps the patch', async () => {
    const result = await applyOpenClawPatch(patch, { ...base(), binary: installFakeOpenClaw(dir, { refusePatch: 'Config validation failed: gateway.port: nope' }) });
    expect(result).toMatchObject({
      status: 'failed',
      detail: 'Config change declined. No settings were saved. Config validation failed: gateway.port: nope',
      patchPath: patchFile(),
    });
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('reports a program that cannot be run', async () => {
    const result = await applyOpenClawPatch(patch, { ...base(), binary: path.join(dir, 'nope') });
    expect(result.status).toBe('failed');
    expect((result as { detail: string }).detail).toContain('ENOENT');
  });

  it('counts success as applied only when the file holds the change', async () => {
    const liar = path.join(dir, 'liar');
    fs.writeFileSync(liar, '#!/bin/sh\ncat > /dev/null\necho "Applied 1 config update(s)."\n', { mode: 0o755 });
    const result = await applyOpenClawPatch(patch, { ...base(), binary: liar });
    expect(result).toMatchObject({ status: 'failed', detail: `OpenClaw reported success, but ${configFile()} does not hold the change` });
  });

  it('leaves startup warnings out of what it reports', async () => {
    const noisy = path.join(dir, 'noisy');
    fs.writeFileSync(noisy, '#!/bin/sh\ncat > /dev/null\necho "openclaw: SECURITY WARNING: old node" >&2\necho "Config validation failed: x" >&2\nexit 1\n', { mode: 0o755 });
    const result = await applyOpenClawPatch(patch, { ...base(), binary: noisy });
    expect(result).toMatchObject({ status: 'failed', detail: 'Config validation failed: x' });
  });

  it('quotes a patch path with a space in the command it gives', async () => {
    const result = await applyOpenClawPatch(patch, { ...base(), binary: null, patchDir: path.join(dir, 'my cfg') });
    expect((result as { command: string }).command).toBe(`openclaw config patch --file '${path.join(dir, 'my cfg', 'openclaw-setup.patch.json')}'`);
  });
});
