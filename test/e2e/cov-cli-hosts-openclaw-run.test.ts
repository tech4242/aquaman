/**
 * `aquaman openclaw start|configure|status` and the plain (non --auto) form of
 * `aquaman openclaw migrate`, driven as real processes.
 *
 * The real `openclaw` never runs: PATH holds one private directory
 * (test/helpers/cov-cli-hosts.ts) and the "gateway" a test launches is a
 * shell script that records how it was started.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  createSandbox, baseConfig, runCli, startCli, addCredential, waitForOutput, waitForExit, type Sandbox,
} from '../helpers/cov-cli-hosts.js';

const T = 120_000;

function udsGet(socketPath: string, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('aquaman openclaw start / configure / status / migrate (cli-hosts coverage)', () => {
  let sb: Sandbox;
  let child: ChildProcess | undefined;
  beforeEach(() => { sb = createSandbox(); child = undefined; });
  afterEach(async () => {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await waitForExit(child, 10_000); }
    sb.cleanup();
  });

  const sock = () => path.join(sb.configDir, 'proxy.sock');

  describe('start', () => {
    it('--dry-run prints the plan and starts nothing', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['openclaw', 'start', '--dry-run']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Dry run - would start with this configuration:');
      expect(r.stdout).toContain(`Socket: ${sock()}`);
      expect(r.stdout).toContain('Backend: encrypted-file');
      expect(r.stdout).toContain('Services: anthropic, openai');
      expect(r.stdout).toContain('ANTHROPIC_BASE_URL=http://aquaman.local/anthropic');
      expect(r.stdout).toContain('OPENAI_BASE_URL=http://aquaman.local/openai');
      expect(fs.existsSync(sock())).toBe(false);
    }, T);

    it('--no-launch serves the socket, audits a request, and stops on SIGTERM', async () => {
      sb.writeConfig(baseConfig(sb));
      // Present on PATH, and must not be started.
      const launched = path.join(sb.root, 'launched');
      sb.fakeBin('openclaw', `echo started > "${launched}"`);

      child = startCli(sb, ['openclaw', 'start', '--no-launch']);
      const out = await waitForOutput(child, 'ANTHROPIC_BASE_URL=');
      expect(out).toContain(`Credential proxy started on ${sock()}`);
      expect(out).toContain('Daemon mode - credential proxy running.');
      expect(out).toContain('To use with OpenClaw, set these environment variables:');
      expect(fs.statSync(sock()).mode & 0o777).toBe(0o600);

      const health = await udsGet(sock(), '/_health');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body).status).toBe('ok');

      // This proxy fronts OpenClaw, so it never hands a value out.
      const broker = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ socketPath: sock(), path: '/broker/resolve', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ service: 'anthropic', key: 'api_key' }));
      });
      expect(broker.status).toBe(404);
      expect(JSON.parse(broker.body).code).toBe('broker_disabled');

      // Nothing stored: the request is refused with the fix, and audited.
      const refused = await udsGet(sock(), '/anthropic/v1/models');
      expect(refused.status).toBe(401);
      expect(JSON.parse(refused.body).fix).toContain('aquaman credentials add anthropic api_key');

      const closing = waitForOutput(child, 'Shutting down...');
      child.kill('SIGTERM');
      await closing;
      expect(await waitForExit(child)).toBe(0);
      expect(fs.existsSync(launched)).toBe(false);

      const audit = fs.readFileSync(path.join(sb.configDir, 'audit', 'current.jsonl'), 'utf-8')
        .trim().split('\n').map((l) => JSON.parse(l));
      const access = audit.filter((e) => JSON.stringify(e).includes('"anthropic"'));
      expect(access.length).toBeGreaterThan(0);
      expect(JSON.stringify(access)).toContain('"success":false');
    }, T);

    it('keeps the proxy up and prints the env vars when OpenClaw is not installed', async () => {
      sb.writeConfig(baseConfig(sb));
      child = startCli(sb, ['openclaw', 'start']);
      const out = await waitForOutput(child, 'OPENAI_BASE_URL=');
      expect(out).toContain('OpenClaw not found. Credential proxy is running.');
      expect(out).toContain('To use with OpenClaw, set these environment variables:');
      expect((await udsGet(sock(), '/_health')).status).toBe(200);
      child.kill('SIGTERM');
      expect(await waitForExit(child)).toBe(0);
    }, T);

    it('launches OpenClaw with the workspace and the sentinel base URLs, and exits with its code', async () => {
      sb.writeConfig(baseConfig(sb));
      const record = path.join(sb.root, 'launch-record');
      sb.fakeBin('openclaw', [
        'if [ "$1" = "--version" ]; then echo "openclaw 2026.9.37"; exit 0; fi',
        `printf '%s\\n' "args=$*" "anthropic=$ANTHROPIC_BASE_URL" "openai=$OPENAI_BASE_URL" > "${record}"`,
        'exit 7',
      ].join('\n'));
      const workspace = path.join(sb.root, 'ws');
      fs.mkdirSync(workspace);

      const r = await runCli(sb, ['openclaw', 'start', '--workspace', workspace]);
      expect(r.stdout).toContain('Launching OpenClaw 2026.9.37...');
      expect(r.stdout).toContain('OpenClaw exited with code 7');
      expect(r.code).toBe(7);
      expect(fs.readFileSync(record, 'utf-8').trim().split('\n')).toEqual([
        `args=--cwd ${workspace}`,
        'anthropic=http://aquaman.local/anthropic',
        'openai=http://aquaman.local/openai',
      ]);
    }, T);

    it('does not launch when openclaw.autoLaunch is false', async () => {
      sb.writeConfig(baseConfig(sb, ['openclaw:', '  autoLaunch: false']));
      const launched = path.join(sb.root, 'launched');
      sb.fakeBin('openclaw', `echo started > "${launched}"`);
      child = startCli(sb, ['openclaw', 'start']);
      const out = await waitForOutput(child, 'ANTHROPIC_BASE_URL=');
      expect(out).toContain('Daemon mode - credential proxy running.');
      child.kill('SIGTERM');
      expect(await waitForExit(child)).toBe(0);
      expect(fs.existsSync(launched)).toBe(false);
    }, T);

    it('exits 1 with the next step when the credential backend cannot start', async () => {
      sb.writeConfig(['credentials:', '  backend: vault', '  proxiedServices:', '    - anthropic', 'audit:', '  enabled: false']);
      const r = await runCli(sb, ['openclaw', 'start', '--no-launch']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Credential backend "vault" failed to initialize:');
      expect(r.stderr).toContain('Fix the backend configuration and retry. Run: aquaman doctor');
      expect(r.stdout).not.toContain('Credential proxy started');
      expect(fs.existsSync(sock())).toBe(false);
    }, T);
  });

  describe('configure', () => {
    it('prints export lines by default and for any --dry-run, writing nothing', async () => {
      sb.writeConfig(baseConfig(sb));
      for (const args of [[], ['--method', 'dotenv', '--dry-run'], ['--method', 'shell-rc', '--dry-run']]) {
        const r = await runCli(sb, ['openclaw', 'configure', ...args], { cwd: sb.root });
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Environment variables for OpenClaw:');
        expect(r.stdout).toContain('export ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"');
        expect(r.stdout).toContain('export OPENAI_BASE_URL="http://aquaman.local/openai"');
      }
      expect(fs.existsSync(path.join(sb.root, '.env.aquaman'))).toBe(false);
      expect(fs.readdirSync(sb.home)).toEqual([]);
    }, T);

    it('--method dotenv writes .env.aquaman in the current directory, owner-only', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['openclaw', 'configure', '--method', 'dotenv'], { cwd: sb.root });
      expect(r.code).toBe(0);
      const file = path.join(fs.realpathSync(sb.root), '.env.aquaman');
      expect(r.stdout).toContain(`Configuration written to: ${file}`);
      expect(fs.readFileSync(file, 'utf-8')).toBe(
        'ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"\nOPENAI_BASE_URL="http://aquaman.local/openai"\n'
      );
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }, T);

    it('--method shell-rc adds one marked section to the shell rc file and replaces it on a re-run', async () => {
      sb.writeConfig(baseConfig(sb));
      const zshrc = path.join(sb.home, '.zshrc');
      fs.writeFileSync(zshrc, 'alias ll="ls -l"\n');

      const first = await runCli(sb, ['openclaw', 'configure', '--method', 'shell-rc'], { env: { SHELL: '/bin/zsh' } });
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Configuration written to: ${zshrc}`);
      const second = await runCli(sb, ['openclaw', 'configure', '--method', 'shell-rc'], { env: { SHELL: '/bin/zsh' } });
      expect(second.code).toBe(0);

      const rc = fs.readFileSync(zshrc, 'utf-8');
      expect(rc).toContain('alias ll="ls -l"');
      expect(rc.match(/^# aquaman environment$/gm)).toHaveLength(1);
      expect(rc.match(/^# end aquaman environment$/gm)).toHaveLength(1);
      expect(rc).toContain('export ANTHROPIC_BASE_URL="http://aquaman.local/anthropic"');

      // Any other shell gets .bashrc.
      const bash = await runCli(sb, ['openclaw', 'configure', '--method', 'shell-rc'], { env: { SHELL: '/bin/bash' } });
      expect(bash.stdout).toContain(`Configuration written to: ${path.join(sb.home, '.bashrc')}`);
      expect(fs.readFileSync(path.join(sb.home, '.bashrc'), 'utf-8')).toContain('export OPENAI_BASE_URL=');
    }, T);
  });

  describe('status', () => {
    it('summarises config, policies, stored credentials and the installed OpenClaw', async () => {
      sb.writeConfig(baseConfig(sb, [
        'policy:',
        '  openai:',
        '    defaultAction: allow',
        '    rules:',
        '      - { method: "*", path: "/v1/organization/**", action: deny }',
        '      - { method: DELETE, path: "/v1/**", action: deny }',
        '  anthropic:',
        '    defaultAction: deny',
        '    rules:',
        '      - { method: POST, path: "/v1/messages", action: allow }',
      ]));
      await addCredential(sb, 'anthropic', 'api_key', 'sk-ant-status-value');
      sb.fakeBin('openclaw', 'echo "openclaw 2026.9.37"');

      const r = await runCli(sb, ['openclaw', 'status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Config dir: ${sb.configDir}`);
      expect(r.stdout).toContain('Credential backend: encrypted-file');
      expect(r.stdout).toContain(`Socket path: ${sock()}`);
      expect(r.stdout).toContain('Audit logging: enabled');
      expect(r.stdout).toContain('Proxied services:\n  - anthropic\n  - openai');
      expect(r.stdout).toContain('Request policies: 2 services, 3 rules');
      expect(r.stdout).toContain('- openai: 2 rules (default: allow)');
      expect(r.stdout).toContain('- anthropic: 1 rule (default: deny)');
      expect(r.stdout).toContain('Stored credentials: 1');
      expect(r.stdout).toContain('OpenClaw: installed (2026.9.37)');
      expect(r.all).not.toContain('sk-ant-status-value');
    }, T);

    it('reports no policy, an unavailable backend and a missing OpenClaw', async () => {
      sb.writeConfig(['credentials:', '  backend: vault', '  proxiedServices:', '    - anthropic', 'audit:', '  enabled: false']);
      const r = await runCli(sb, ['openclaw', 'status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Audit logging: disabled');
      expect(r.stdout).toContain('Request policies: not configured');
      expect(r.stdout).toContain('Stored credentials: (backend unavailable)');
      expect(r.stdout).toContain('OpenClaw: not found');
    }, T);
  });

  describe('migrate (without --auto)', () => {
    const CHANNELS = {
      channels: {
        telegram: { accounts: { mybot: { botToken: '123456:PLAIN-TELEGRAM-TOKEN' } } },
        slack: { accounts: { ws1: { botToken: 'xoxb-plain-slack-token' } } },
      },
    };
    const storedCount = async () => {
      const r = await runCli(sb, ['openclaw', 'status']);
      return Number(/Stored credentials: (\d+)/.exec(r.stdout)?.[1]);
    };

    it('reads ~/.openclaw/openclaw.json by default and exits 1 when it is missing', async () => {
      sb.writeConfig(baseConfig(sb));
      const r = await runCli(sb, ['openclaw', 'migrate']);
      const expected = path.join(sb.home, '.openclaw', 'openclaw.json');
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`Reading: ${expected}`);
      expect(r.stdout).toContain('Errors 1:');
      expect(r.stdout).toContain(`-:- - Config file not found: ${expected}`);
    }, T);

    it('--dry-run lists what would move, with its source path, and stores nothing', async () => {
      sb.writeConfig(baseConfig(sb));
      const cfg = sb.writeOpenClawJson(CHANNELS);
      const r = await runCli(sb, ['openclaw', 'migrate', '--config', cfg, '--dry-run']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Reading: ${cfg}`);
      expect(r.stdout).toContain('(dry run - no credentials will be written)');
      expect(r.stdout).toContain('Would migrate 2 credential(s):');
      expect(r.stdout).toContain('telegram:bot_token ← channels.telegram.accounts.mybot.botToken');
      expect(r.stdout).toContain('slack:bot_token ← channels.slack.accounts.ws1.botToken');
      expect(r.stdout).not.toContain('Credentials stored securely');
      expect(r.all).not.toContain('PLAIN-TELEGRAM-TOKEN');
      expect(await storedCount()).toBe(0);
    }, T);

    it('stores the credentials, then skips them on a second run unless --overwrite is given', async () => {
      sb.writeConfig(baseConfig(sb));
      const cfg = sb.writeOpenClawJson(CHANNELS);

      const first = await runCli(sb, ['openclaw', 'migrate', '-c', cfg]);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain('Migrated 2 credential(s):');
      expect(first.stdout).toContain('Credentials stored securely. You can now remove plaintext tokens from openclaw.json.');
      expect(first.all).not.toContain('xoxb-plain-slack-token');
      expect(await storedCount()).toBe(2);
      // The plain form never edits openclaw.json.
      expect(sb.readOpenClawJson()).toEqual(CHANNELS);

      const second = await runCli(sb, ['openclaw', 'migrate', '-c', cfg]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('Skipped 2:');
      expect(second.stdout).toMatch(/telegram:bot_token - .*(exist|overwrite)/i);
      expect(second.stdout).not.toContain('Migrated');

      const forced = await runCli(sb, ['openclaw', 'migrate', '-c', cfg, '--overwrite']);
      expect(forced.code).toBe(0);
      expect(forced.stdout).toContain('Migrated 2 credential(s):');
      expect(await storedCount()).toBe(2);
    }, T);

    it('finds nothing to migrate in aquaman\'s own placeholders or in a config without channels', async () => {
      sb.writeConfig(baseConfig(sb));
      const cfg = sb.writeOpenClawJson({
        channels: { telegram: { accounts: { mybot: { botToken: 'aquaman-proxy-managed' } } } },
      });
      for (const content of [null, { plugins: {} }]) {
        if (content) sb.writeOpenClawJson(content);
        const r = await runCli(sb, ['openclaw', 'migrate', '-c', cfg]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Skipped 1:');
        expect(r.stdout).toContain('-:- - No channel credentials found in config');
        expect(r.stdout).not.toContain('Migrated');
      }
      expect(await storedCount()).toBe(0);
    }, T);

    it('exits 1 on an openclaw.json that is not JSON', async () => {
      sb.writeConfig(baseConfig(sb));
      const cfg = sb.writeOpenClawJson('{ nope');
      const r = await runCli(sb, ['openclaw', 'migrate', '-c', cfg]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('Errors 1:');
      expect(r.stdout).toContain('-:- - Failed to parse config:');
    }, T);
  });

  describe('migrate --auto', () => {
    it('exits 1 before writing anything when the vault cannot be opened', async () => {
      sb.writeConfig(['credentials:', '  backend: vault', '  proxiedServices:', '    - anthropic']);
      const cfg = sb.writeOpenClawJson({ channels: { telegram: { accounts: { a: { botToken: '123456:PLAIN-TELEGRAM-TOKEN' } } } } });
      const before = fs.readFileSync(cfg, 'utf-8');
      const r = await runCli(sb, ['openclaw', 'migrate', '--auto', '--cleanup']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('Destination: HashiCorp Vault (vault)');
      expect(r.stderr).toContain('Failed to initialize credential store:');
      expect(r.stdout).not.toContain('Migrated');
      expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
    }, T);

    it('--cleanup reports a plaintext source it could not rewrite, and the credential is still in the vault', async () => {
      sb.writeConfig(baseConfig(sb));
      const cfg = sb.writeOpenClawJson({ channels: { telegram: { accounts: { a: { botToken: '123456:PLAIN-TELEGRAM-TOKEN' } } } } });
      const before = fs.readFileSync(cfg, 'utf-8');
      fs.chmodSync(cfg, 0o444);
      const r = await runCli(sb, ['openclaw', 'migrate', '--auto', '--cleanup']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Migrated 1 credential');
      expect(r.stdout).toContain('✗ openclaw.json: Failed to update config:');
      expect(fs.readFileSync(cfg, 'utf-8')).toBe(before);
      const status = await runCli(sb, ['openclaw', 'status']);
      expect(status.stdout).toContain('Stored credentials: 1');
    }, T);

    it('adds a migrated plugin service to an existing services.yaml without dropping what is there', async () => {
      sb.writeConfig(baseConfig(sb));
      const servicesYaml = path.join(sb.configDir, 'services.yaml');
      fs.writeFileSync(servicesYaml, [
        'services:',
        '  - name: my-internal-api',
        '    upstream: https://internal.example',
        '    authHeader: Authorization',
        '    authPrefix: "Bearer "',
        '    credentialKey: api_key',
        '',
      ].join('\n'));
      sb.writeOpenClawJson({
        plugins: { entries: { 'notion-skill': { enabled: true, config: { apiToken: 'ntn_plain_plugin_token' } } } },
      });

      const r = await runCli(sb, ['openclaw', 'migrate', '--auto', '--no-cleanup']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Added notion-skill to services.yaml');
      expect(r.stdout).toContain('Updated proxiedServices in config.yaml');
      expect(r.stdout).toContain('Note: Set the upstream URL for new services in:');

      const yaml = fs.readFileSync(servicesYaml, 'utf-8');
      expect(yaml).toContain('name: my-internal-api');
      expect(yaml).toContain('upstream: https://internal.example');
      expect(yaml).toContain('name: notion-skill');
      expect(yaml).toContain('upstream: https://TODO-SET-UPSTREAM-URL');
      expect(sb.readConfig()).toContain('- notion-skill');
      // --no-cleanup: the plaintext stays and no cleanup commands are run.
      expect(sb.readOpenClawJson().plugins.entries['notion-skill'].config.apiToken).toBe('ntn_plain_plugin_token');
    }, T);
  });

  describe('root help and stale daemon pid', () => {
    it('--help groups the commands by integration and lists each host namespace\'s subcommands', async () => {
      const r = await runCli(sb, ['--help']);
      expect(r.code).toBe(0);
      const out = r.stdout;
      for (const heading of [
        'Vault & core (agent-agnostic)', 'Vault management', 'OpenClaw Gateway integration',
        'AI coding-agent integration (Claude Code, Codex)', 'Hermes integration', 'NVIDIA OpenShell integration', 'Other',
      ]) expect(out).toContain(heading);
      expect(out).toContain('Usage: aquaman [options] [command]');
      expect(out).toMatch(/-V, --version\s+output the version number/);
      // Namespaced rows, in reading order: setup, doctor, status first.
      const order = ['openclaw setup', 'openclaw doctor', 'openclaw status', 'openclaw start', 'openclaw configure', 'openclaw migrate']
        .map((row) => out.indexOf(`  ${row} `));
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      for (const row of ['hermes setup', 'hermes doctor', 'hermes status', 'hermes configure', 'openshell setup', 'openshell doctor', 'coder exec <cmd>']) {
        expect(out).toContain(`  ${row} `);
      }
      expect(out).toContain('(delegates to the aquaman-coder binary; install: npm install -g aquaman-coder)');
      // Entry points that only the plugin or the host starts stay out of the help.
      expect(out).not.toContain('plugin-mode');
      // Sections come in a fixed order.
      expect(out.indexOf('Vault & core')).toBeLessThan(out.indexOf('OpenClaw Gateway integration'));
      expect(out.indexOf('OpenClaw Gateway integration')).toBeLessThan(out.indexOf('Hermes integration'));
      expect(out.indexOf('Hermes integration')).toBeLessThan(out.indexOf('NVIDIA OpenShell integration'));
    }, T);

    it('a namespace\'s own --help keeps the standard layout, with argument and option markers', async () => {
      const r = await runCli(sb, ['openclaw', '--help']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: aquaman openclaw [options] [command]');
      expect(r.stdout).toContain('Commands:');
      expect(r.stdout).toMatch(/migrate \[options\]\s+Migrate channel credentials/);
      expect(r.stdout).not.toContain('Vault & core (agent-agnostic)');
      expect(r.stdout).not.toContain('plugin-mode');

      const creds = await runCli(sb, ['credentials', '--help']);
      expect(creds.stdout).toMatch(/add \[options\] <service> <key>/);
    }, T);

    it('stop clears a pid file whose process is gone', async () => {
      sb.writeConfig(baseConfig(sb));
      // A pid that was just released: a process that has exited.
      const { spawnSync } = await import('node:child_process');
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      const pidFile = path.join(sb.configDir, 'daemon.pid');
      fs.writeFileSync(pidFile, String(dead));
      const r = await runCli(sb, ['stop']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Daemon (PID ${dead}) is not running. Cleaning up stale PID file.`);
      expect(fs.existsSync(pidFile)).toBe(false);
    }, T);
  });
});
