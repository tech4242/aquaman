/**
 * Unit tests for the plugin's proxy-manager helpers.
 *
 * Focus on pickProxyEnv (v0.11.5 ClawScan ASI03 + ASI05 mitigation):
 * the spawned aquaman proxy must NOT inherit arbitrary parent-process
 * env vars; only an explicit allowlist + AQUAMAN_/VAULT_/BW_ prefix
 * families reach it.
 */

import { describe, it, expect } from 'vitest';
import { pickProxyEnv } from '../../packages/plugin/src/proxy-manager.js';

describe('pickProxyEnv', () => {
  it('forwards process basics (HOME, PATH, USER, SHELL, TMPDIR, LOGNAME)', () => {
    const out = pickProxyEnv({
      HOME: '/home/test',
      PATH: '/usr/bin',
      USER: 'test',
      SHELL: '/bin/bash',
      TMPDIR: '/tmp',
      LOGNAME: 'test',
    });
    expect(out.HOME).toBe('/home/test');
    expect(out.PATH).toBe('/usr/bin');
    expect(out.USER).toBe('test');
    expect(out.SHELL).toBe('/bin/bash');
    expect(out.TMPDIR).toBe('/tmp');
    expect(out.LOGNAME).toBe('test');
  });

  it('forwards locale (LANG, LC_*)', () => {
    const out = pickProxyEnv({
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      LC_MESSAGES: 'C',
    });
    expect(out.LANG).toBe('en_US.UTF-8');
    expect(out.LC_ALL).toBe('en_US.UTF-8');
    expect(out.LC_CTYPE).toBe('UTF-8');
    expect(out.LC_MESSAGES).toBe('C');
  });

  it('forwards Node basics (NODE_ENV, NODE_PATH)', () => {
    const out = pickProxyEnv({
      NODE_ENV: 'production',
      NODE_PATH: '/usr/lib/node_modules',
    });
    expect(out.NODE_ENV).toBe('production');
    expect(out.NODE_PATH).toBe('/usr/lib/node_modules');
  });

  it('forwards AQUAMAN_*, VAULT_*, BW_* prefix families', () => {
    const out = pickProxyEnv({
      AQUAMAN_BACKEND: 'keychain',
      AQUAMAN_VAULT_TOKEN: 'tok',
      VAULT_ADDR: 'https://vault.example',
      VAULT_TOKEN: 'hvs.tok',
      BW_SESSION: 'session-key',
    });
    expect(out.AQUAMAN_BACKEND).toBe('keychain');
    expect(out.AQUAMAN_VAULT_TOKEN).toBe('tok');
    expect(out.VAULT_ADDR).toBe('https://vault.example');
    expect(out.VAULT_TOKEN).toBe('hvs.tok');
    expect(out.BW_SESSION).toBe('session-key');
  });

  it('does NOT forward LLM provider keys', () => {
    const out = pickProxyEnv({
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      OPENAI_API_KEY: 'sk-secret',
      ANTHROPIC_AUTH_TOKEN: 'tok',
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('does NOT forward cloud provider credentials', () => {
    const out = pickProxyEnv({
      AWS_ACCESS_KEY_ID: 'AKIATEST',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'session',
      AZURE_CLIENT_SECRET: 'azure',
      GOOGLE_APPLICATION_CREDENTIALS: '/path',
    });
    expect(out.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.AWS_SESSION_TOKEN).toBeUndefined();
    expect(out.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(out.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
  });

  it('does NOT forward source-control / package-registry tokens', () => {
    const out = pickProxyEnv({
      GH_TOKEN: 'gh_secret',
      GITHUB_TOKEN: 'gh_secret',
      NPM_TOKEN: 'npm_secret',
      GITLAB_TOKEN: 'gl_secret',
    });
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect(out.NPM_TOKEN).toBeUndefined();
    expect(out.GITLAB_TOKEN).toBeUndefined();
  });

  it('does NOT forward arbitrary unrelated vars', () => {
    const out = pickProxyEnv({
      DATABASE_URL: 'postgres://...',
      STRIPE_SECRET_KEY: 'sk_test_...',
      SLACK_BOT_TOKEN: 'xoxb-...',
      DEBUG: 'app:*',
      EDITOR: 'vim',
    });
    expect(out.DATABASE_URL).toBeUndefined();
    expect(out.STRIPE_SECRET_KEY).toBeUndefined();
    expect(out.SLACK_BOT_TOKEN).toBeUndefined();
    expect(out.DEBUG).toBeUndefined();
    expect(out.EDITOR).toBeUndefined();
  });

  it('preserves only allowlisted keys when mixed', () => {
    const out = pickProxyEnv({
      HOME: '/home/test',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AQUAMAN_BACKEND: 'keychain',
      GH_TOKEN: 'gh_secret',
      VAULT_ADDR: 'https://vault.example',
      DATABASE_URL: 'postgres://...',
      LANG: 'en_US.UTF-8',
    });
    expect(Object.keys(out).sort()).toEqual(
      ['AQUAMAN_BACKEND', 'HOME', 'LANG', 'VAULT_ADDR'].sort()
    );
  });

  it('returns empty object when input has no allowlisted keys', () => {
    const out = pickProxyEnv({
      ANTHROPIC_API_KEY: 'x',
      OPENAI_API_KEY: 'x',
      GH_TOKEN: 'x',
    });
    expect(out).toEqual({});
  });

  it('handles empty input', () => {
    expect(pickProxyEnv({})).toEqual({});
  });

  it('skips undefined values (NodeJS.ProcessEnv shape)', () => {
    const out = pickProxyEnv({
      HOME: '/home/test',
      AQUAMAN_BACKEND: undefined,
    });
    expect(out.HOME).toBe('/home/test');
    expect(out.AQUAMAN_BACKEND).toBeUndefined();
  });

  it('uses process.env by default when no argument is passed', () => {
    // Just verify it runs without throwing — actual contents depend on
    // the test runner's env. We assert structure only.
    const out = pickProxyEnv();
    expect(out).toBeDefined();
    expect(typeof out).toBe('object');
  });
});
