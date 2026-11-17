/**
 * Host integration glue: the OpenClaw env writer and launcher, and the Hermes
 * integration class.
 *
 * No real `openclaw` or `hermes` is run: the "binaries" are small scripts in a
 * temp directory, named through the integrations' own `binaryPath` setting.
 * HOME, HERMES_HOME and the working directory all point into temp directories.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOpenClawIntegration } from 'aquaman-proxy';
import type { WrapperConfig, ServiceConfig } from 'aquaman-core';
import {
  generateOpenClawEnv,
  writeEnvFile,
  appendToShellRc,
  formatEnvForDisplay,
} from '../../packages/proxy/src/openclaw/env-writer.js';
import {
  HermesIntegration,
  createHermesIntegration,
  detectHermes,
} from '../../packages/proxy/src/hermes/integration.js';

const svc = (name: string): ServiceConfig => ({ name, upstream: `https://${name}.example.com`, authHeader: 'Authorization', credentialKey: 'api_key' });

describe('host integrations', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['HOME', 'SHELL', 'HERMES_HOME'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-int-'));
    for (const name of ENV) saved[name] = process.env[name];
    process.env['HOME'] = dir;
    delete process.env['HERMES_HOME'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** An executable stand-in for a host CLI. */
  function fakeBinary(name: string, body: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return p;
  }

  describe('generateOpenClawEnv', () => {
    it('maps each known service to the variable its client reads', () => {
      const env = generateOpenClawEnv({ services: ['anthropic', 'openai', 'github', 'slack', 'discord'].map(svc) });
      expect(env).toEqual({
        ANTHROPIC_BASE_URL: 'http://aquaman.local/anthropic',
        OPENAI_BASE_URL: 'http://aquaman.local/openai',
        GITHUB_API_URL: 'http://aquaman.local/github',
        SLACK_API_URL: 'http://aquaman.local/slack',
        DISCORD_API_URL: 'http://aquaman.local/discord',
      });
    });

    it('derives NAME_BASE_URL for a custom service', () => {
      expect(generateOpenClawEnv({ services: [svc('my-llm')] })).toEqual({ MY_LLM_BASE_URL: 'http://aquaman.local/my-llm' });
    });

    it('drops a service whose name could not be written safely into a shell file', () => {
      const env = generateOpenClawEnv({ services: [svc('x"; rm -rf ~; "'), svc('$(id)'), svc('Upper'), svc('ok')] });
      expect(env).toEqual({ OK_BASE_URL: 'http://aquaman.local/ok' });
    });
  });

  describe('writeEnvFile', () => {
    it('creates missing directories and writes an owner-only file', () => {
      const file = path.join(dir, 'a', 'b', '.env.aquaman');
      writeEnvFile({ ANTHROPIC_BASE_URL: 'http://aquaman.local/anthropic', OPENAI_BASE_URL: 'http://aquaman.local/openai' }, file);
      expect(fs.readFileSync(file, 'utf-8')).toBe(
        'ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"\nOPENAI_BASE_URL="http://aquaman.local/openai"\n',
      );
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });

  describe('appendToShellRc', () => {
    const env = { ANTHROPIC_BASE_URL: 'http://aquaman.local/anthropic' };
    const block = '# aquaman environment\nexport ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"\n# end aquaman environment\n';

    it('writes ~/.zshrc for zsh, creating it when missing', () => {
      process.env['SHELL'] = '/bin/zsh';
      const rc = appendToShellRc(env);
      expect(rc).toBe(path.join(dir, '.zshrc'));
      expect(fs.readFileSync(rc, 'utf-8')).toBe(`\n\n${block}`);
      expect(fs.existsSync(path.join(dir, '.bashrc'))).toBe(false);
    });

    it('writes ~/.bashrc for any other shell, and when SHELL is unset', () => {
      process.env['SHELL'] = '/usr/bin/fish';
      expect(appendToShellRc(env)).toBe(path.join(dir, '.bashrc'));
      delete process.env['SHELL'];
      expect(appendToShellRc(env)).toBe(path.join(dir, '.bashrc'));
    });

    it('keeps what the file already holds and appends the block after it', () => {
      process.env['SHELL'] = '/bin/bash';
      const rc = path.join(dir, '.bashrc');
      fs.writeFileSync(rc, 'export EDITOR=vim\nalias ll="ls -l"\n\n\n');
      appendToShellRc(env);
      expect(fs.readFileSync(rc, 'utf-8')).toBe(`export EDITOR=vim\nalias ll="ls -l"\n\n${block}`);
    });

    it('replaces its own earlier block instead of adding a second one', () => {
      process.env['SHELL'] = '/bin/bash';
      const rc = path.join(dir, '.bashrc');
      fs.writeFileSync(rc, 'export EDITOR=vim\n');
      appendToShellRc({ OLD_BASE_URL: 'http://aquaman.local/old' });
      fs.appendFileSync(rc, 'export AFTER=1\n');
      appendToShellRc(env);
      const content = fs.readFileSync(rc, 'utf-8');
      expect(content).toBe(`export EDITOR=vim\n\nexport AFTER=1\n\n${block}`);
      expect(content).not.toContain('OLD_BASE_URL');
      expect(content.match(/^# aquaman environment$/gm)).toHaveLength(1);
      expect(content.match(/^# end aquaman environment$/gm)).toHaveLength(1);
    });
  });

  describe('formatEnvForDisplay', () => {
    it('prints one indented NAME=value per line', () => {
      expect(formatEnvForDisplay({ A: '1', B: '2' })).toBe('  A=1\n  B=2');
      expect(formatEnvForDisplay({})).toBe('');
    });
  });

  describe('OpenClawIntegration', () => {
    const config = (over: Partial<WrapperConfig['openclaw']>): WrapperConfig => ({
      credentials: { backend: 'encrypted-file', proxiedServices: ['anthropic'] },
      audit: { enabled: false, logDir: path.join(dir, 'audit') },
      services: { configPath: path.join(dir, 'services.yaml') },
      openclaw: { autoLaunch: false, configMethod: 'env', ...over },
    } as WrapperConfig);

    it('reads the version from `openclaw <x.y.z>` output', async () => {
      const bin = fakeBinary('openclaw', 'echo "OpenClaw 2026.9.37 (abc123)"');
      const info = await createOpenClawIntegration(config({ binaryPath: bin }), []).detectOpenClaw();
      expect(info).toEqual({ installed: true, version: '2026.9.37', path: bin });
    });

    it('falls back to the whole output when it has no recognisable version', async () => {
      const bin = fakeBinary('openclaw', 'echo "  dev build  "');
      const info = await createOpenClawIntegration(config({ binaryPath: bin }), []).detectOpenClaw();
      expect(info).toEqual({ installed: true, version: 'dev build', path: bin });
    });

    it('reports not installed for a missing binary, a failing one, and one that prints nothing', async () => {
      const missing = createOpenClawIntegration(config({ binaryPath: path.join(dir, 'nope') }), []);
      expect(await missing.detectOpenClaw()).toEqual({ installed: false });
      const failing = createOpenClawIntegration(config({ binaryPath: fakeBinary('oc-fail', 'echo "openclaw 1.2.3"; exit 3') }), []);
      expect(await failing.detectOpenClaw()).toEqual({ installed: false });
      const silent = createOpenClawIntegration(config({ binaryPath: fakeBinary('oc-silent', 'exit 0') }), []);
      expect(await silent.detectOpenClaw()).toEqual({ installed: false });
    });

    it('writes .env.aquaman in the working directory for the dotenv method', async () => {
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      const integration = createOpenClawIntegration(config({ configMethod: 'dotenv' }), [svc('anthropic')]);
      const env = await integration.configureOpenClaw();
      const written = await integration.writeConfiguration(env);
      expect(written).toBe(path.join(dir, '.env.aquaman'));
      expect(fs.readFileSync(written, 'utf-8')).toBe('ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"\n');
    });

    it('writes the shell rc file for the shell-rc method', async () => {
      process.env['SHELL'] = '/bin/zsh';
      const integration = createOpenClawIntegration(config({ configMethod: 'shell-rc' }), [svc('openai')]);
      const written = await integration.writeConfiguration(await integration.configureOpenClaw());
      expect(written).toBe(path.join(dir, '.zshrc'));
      expect(fs.readFileSync(written, 'utf-8')).toContain('export OPENAI_BASE_URL="http://aquaman.local/openai"');
    });

    it('refuses to launch when OpenClaw is not installed, naming the fix', async () => {
      const integration = createOpenClawIntegration(config({ binaryPath: path.join(dir, 'nope') }), [svc('anthropic')]);
      await expect(integration.launchOpenClaw()).rejects.toThrow(/OpenClaw not found\. Install it with: npm install -g openclaw\nOr specify the path in config: openclaw\.binaryPath/);
    });

    it('launches the configured binary with the proxy variables, the given arguments and working directory', async () => {
      const out = path.join(dir, 'launched.txt');
      const bin = fakeBinary(
        'openclaw',
        `if [ "$1" = "--version" ]; then echo "openclaw 2026.9.1"; exit 0; fi\n` +
        `printf '%s|%s|%s|%s' "$ANTHROPIC_BASE_URL" "$OPENAI_BASE_URL" "$*" "$(pwd -P)" > "${out}"`,
      );
      const work = fs.mkdirSync(path.join(dir, 'work'), { recursive: true }) ?? path.join(dir, 'work');
      const integration = createOpenClawIntegration(config({ binaryPath: bin }), [svc('anthropic'), svc('openai')]);
      for (const inheritStdio of [true, false]) {
        fs.rmSync(out, { force: true });
        const proc = await integration.launchOpenClaw({ args: ['gateway', '--port', '1'], cwd: work, inheritStdio });
        const code = await new Promise<number | null>((resolve) => proc.on('close', resolve));
        expect(code).toBe(0);
        expect(fs.readFileSync(out, 'utf-8')).toBe(
          `http://aquaman.local/anthropic|http://aquaman.local/openai|gateway --port 1|${fs.realpathSync(work)}`,
        );
      }
    });

    it('launches with no arguments in the current directory by default', async () => {
      const out = path.join(dir, 'launched.txt');
      const bin = fakeBinary(
        'openclaw',
        `if [ "$1" = "--version" ]; then echo "openclaw 2026.9.1"; exit 0; fi\nprintf '%s|%s' "$#" "$(pwd -P)" > "${out}"`,
      );
      const proc = await createOpenClawIntegration(config({ binaryPath: bin }), []).launchOpenClaw();
      await new Promise((resolve) => proc.on('close', resolve));
      expect(fs.readFileSync(out, 'utf-8')).toBe(`0|${fs.realpathSync(process.cwd())}`);
    });
  });

  describe('HermesIntegration', () => {
    const TOKEN = 'aqm_lb_cov_hermes_token_0123456789';
    const options = { port: 8585, token: TOKEN, services: ['anthropic', 'openai', 'github'] };

    it('builds the loopback variables for the wired services only', () => {
      const integration = createHermesIntegration(options);
      expect(integration).toBeInstanceOf(HermesIntegration);
      const env = integration.configureHermes();
      expect(env['AQUAMAN_LOOPBACK_URL']).toBe('http://127.0.0.1:8585');
      expect(env['AQUAMAN_LOOPBACK_TOKEN']).toBe(TOKEN);
      expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:8585/anthropic');
      expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:8585/openai/v1');
      expect(Object.keys(env).some((k) => k.includes('GITHUB'))).toBe(false);
      expect(integration.wiredServices()).toEqual(['anthropic', 'openai']);
    });

    it('uses the configured host', () => {
      const env = createHermesIntegration({ ...options, host: 'localhost' }).configureHermes();
      expect(env['AQUAMAN_LOOPBACK_URL']).toBe('http://localhost:8585');
    });

    it('points at ~/.hermes/.env, or under HERMES_HOME when that is set', () => {
      const integration = createHermesIntegration(options);
      expect(integration.envPath()).toBe(path.join(dir, '.hermes', '.env'));
      process.env['HERMES_HOME'] = path.join(dir, 'elsewhere');
      expect(integration.envPath()).toBe(path.join(dir, 'elsewhere', '.env'));
    });

    it('writes the dotenv file by default and returns its path', () => {
      const integration = createHermesIntegration(options);
      const env = integration.configureHermes();
      const dest = integration.writeConfiguration(env);
      expect(dest).toBe(path.join(dir, '.hermes', '.env'));
      const content = fs.readFileSync(dest, 'utf-8');
      expect(content).toContain(`AQUAMAN_LOOPBACK_TOKEN=${TOKEN}`);
      expect(content).toContain('ANTHROPIC_BASE_URL=http://127.0.0.1:8585/anthropic');
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    });

    it('writes nothing for the env method and returns the block to export', () => {
      const integration = createHermesIntegration({ ...options, config: { configMethod: 'env' } });
      const env = integration.configureHermes();
      const shown = integration.writeConfiguration(env);
      expect(shown).toBe(Object.entries(env).map(([k, v]) => `  ${k}=${v}`).join('\n'));
      expect(shown).toBe(integration.getEnvForDisplay());
      expect(fs.existsSync(path.join(dir, '.hermes'))).toBe(false);
    });

    it('detects the configured binary and reads its version', async () => {
      const bin = fakeBinary('hermes', 'echo "Hermes Agent v0.23.1 (2026.11.2)"');
      const integration = createHermesIntegration({ ...options, config: { configMethod: 'dotenv', binaryPath: bin } });
      expect(await integration.detect()).toEqual({ installed: true, version: '0.23.1', path: bin });
    });

    it('falls back to the first output line, and reports a missing or failing binary as not installed', async () => {
      expect(await detectHermes(fakeBinary('hermes-dev', 'echo "dev build"; echo "second line"'))).toEqual({
        installed: true,
        version: 'dev build',
        path: path.join(dir, 'hermes-dev'),
      });
      expect(await detectHermes(path.join(dir, 'nope'))).toEqual({ installed: false });
      expect(await detectHermes(fakeBinary('hermes-fail', 'echo "Hermes v1.2.3"; exit 2'))).toEqual({ installed: false });
    });
  });
});
