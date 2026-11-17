/**
 * E2E: the long-running commands of the proxy CLI and the command that stops
 * them: `aquaman daemon`, `aquaman stop`, `aquaman openclaw start`.
 *
 * Real processes on real sockets, each in its own config directory. The
 * `openclaw` binary, where one is needed, is a shell script the test writes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  createSandbox, startDaemon, waitFor, exited, freePort, udsGet, stop, sleep, T,
  type Sandbox,
} from './cov-cli-core-helpers.js';

const BASE_CONFIG = 'credentials:\n  backend: encrypted-file\n  proxiedServices: [anthropic, github]\n';

function tcpHealth(port: number): Promise<number | 'refused'> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/_health', timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve('refused'));
    req.on('timeout', () => { req.destroy(); resolve('refused'); });
  });
}

function udsPost(socketPath: string, urlPath: string, body: unknown): Promise<{ status: number; json: any }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }); } catch (e) { reject(e); } });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('cli-core: daemon, stop and openclaw start', () => {
  let sb: Sandbox;
  beforeEach(() => { sb = createSandbox(); sb.writeConfig(BASE_CONFIG); });
  afterEach(async () => { await sb.cleanup(); });

  const pidFile = () => path.join(sb.config, 'daemon.pid');

  describe('daemon and stop', () => {
    it('daemon reports what it serves, refuses a second copy, shows up in status, and stop ends it cleanly', async () => {
      const { child, output } = await startDaemon(sb);
      expect(output()).toContain(`Credential proxy: ${sb.socket}`);
      expect(output()).toContain('Credential broker: 0 declared refs (see: aquaman broker list)');
      expect(output()).toContain('Audit logging: enabled');
      expect(output()).toContain('Credential backend: encrypted-file');
      expect(output()).toContain(`PID file: ${pidFile()}`);
      const pid = Number(fs.readFileSync(pidFile(), 'utf-8'));
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(JSON.parse((await udsGet(sb.socket, '/_health')).body).pid).toBe(pid);

      const second = await sb.run(['daemon']);
      expect(second.code).toBe(1);
      expect(second.stderr).toContain(`Daemon is already running (PID ${pid}). Use 'aquaman stop' first.`);
      // The first one was not disturbed.
      expect((await udsGet(sb.socket, '/_health')).status).toBe(200);

      const status = await sb.run(['status']);
      expect(status.stdout).toMatch(/Proxy: running {2}\(v\d+\.\d+\.\d+, uptime \d+s\)/);

      const stopped = await sb.run(['stop']);
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain(`Stopping daemon (PID ${pid})...`);
      expect(stopped.stdout).toContain('Daemon stopped.');
      expect(await exited(child)).toBe(0);
      expect(output()).toContain('Shutting down daemon...');
      expect(fs.existsSync(pidFile())).toBe(false);
      expect(fs.existsSync(sb.socket)).toBe(false);
    }, T * 2);

    it('stop with no pid file, an unreadable one, or a stale one says so and kills nothing', async () => {
      const none = await sb.run(['stop']);
      expect(none.code).toBe(0);
      expect(none.stdout).toContain('No daemon PID file found. Daemon may not be running.');

      fs.writeFileSync(pidFile(), 'not-a-pid');
      const garbage = await sb.run(['stop']);
      expect(garbage.code).toBe(0);
      expect(garbage.stdout).toContain('No daemon PID file found.');

      // The pid of a process that has already exited.
      const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf-8' });
      fs.writeFileSync(pidFile(), dead.stdout);
      const stale = await sb.run(['stop']);
      expect(stale.code).toBe(0);
      expect(stale.stdout).toContain(`Daemon (PID ${dead.stdout}) is not running. Cleaning up stale PID file.`);
      expect(fs.existsSync(pidFile())).toBe(false);
    }, T * 2);

    it('stop escalates to SIGKILL when the process ignores SIGTERM, then cleans up', async () => {
      const stubborn = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); console.log("up"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'ignore'] });
      try {
        await new Promise<void>((resolve) => stubborn.stdout!.once('data', () => resolve()));
        fs.writeFileSync(pidFile(), String(stubborn.pid));
        fs.writeFileSync(sb.socket, '');
        const gone = new Promise<NodeJS.Signals | null>((resolve) => stubborn.once('exit', (_c, signal) => resolve(signal)));

        const r = await sb.run(['stop']);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain('Daemon did not stop gracefully, sending SIGKILL...');
        expect(r.stdout).toContain('Daemon stopped.');
        expect(await gone).toBe('SIGKILL');
        expect(fs.existsSync(pidFile())).toBe(false);
        expect(fs.existsSync(sb.socket)).toBe(false);
      } finally {
        stubborn.kill('SIGKILL');
      }
    }, T);

    it('daemon exits 1 with the reason and the next command when the backend cannot be opened', async () => {
      const r = await sb.run(['daemon'], { env: { AQUAMAN_BACKEND: 'vault' } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Credential backend "vault" failed to initialize: vaultAddress required');
      expect(r.stderr).toContain('Run: aquaman doctor');
      expect(fs.existsSync(pidFile())).toBe(false);
      expect(fs.existsSync(sb.socket)).toBe(false);
    }, T);

    it('with the broker switched off, the daemon says so and hands out nothing, by resolve or by request', async () => {
      const { output } = await startDaemon(sb, { env: { AQUAMAN_BROKER_ENABLED: 'false' } });
      expect(output()).toContain('Credential broker: disabled (broker.enabled: false)');

      const got = await sb.run(['get', 'aquaman://github/token']);
      expect(got.code).toBe(1);
      expect(got.stdout).toBe('');
      expect(got.stderr).toContain('Fix: the proxy on this socket does not serve the broker.');

      // Off without a scope: refused before any dialog could be shown.
      const asked = await sb.run(['request', 'aquaman://github/token', '--json']);
      expect(asked.code).toBe(4);
      expect(JSON.parse(asked.stdout)).toMatchObject({ status: 'error', code: 'broker_disabled' });
    }, T * 2);

    it('counts declared refs, and warns on stderr when a declaring file does not parse', async () => {
      expect((await sb.run(['broker', 'allow', 'aquaman://github/token'])).code).toBe(0);
      fs.writeFileSync(path.join(sb.config, 'projects.yaml'), 'projects: [unclosed\n');
      const { output } = await startDaemon(sb);
      expect(output()).toContain('Credential broker: 1 declared ref (see: aquaman broker list)');
      expect(output()).toContain(`⚠ cannot parse ${path.join(sb.config, 'projects.yaml')}`);
      expect(output()).toContain('refs declared there are refused until it parses');
    }, T * 2);

    it('an enabled loopback listener with no token is not started, and the socket proxy still is', async () => {
      const port = await freePort();
      sb.writeConfig(`${BASE_CONFIG}loopback:\n  enabled: true\n  port: ${port}\n`);
      const { output } = await startDaemon(sb);
      expect(output()).toContain('Loopback listener is enabled but no token is set — refusing to start it (would be unauthenticated).');
      expect(output()).toContain('Fix: run `aquaman hermes setup` to generate one, or set AQUAMAN_LOOPBACK_TOKEN.');
      expect(await tcpHealth(port)).toBe('refused');
      expect((await udsGet(sb.socket, '/_health')).status).toBe(200);
    }, T);

    it('a loopback host that is not a loopback address is refused; a loopback one is served', async () => {
      const port = await freePort();
      sb.writeConfig(`${BASE_CONFIG}loopback:\n  enabled: true\n  port: ${port}\n  host: 0.0.0.0\n  token: aqm_lb_cov_cli_core_daemon\n`);
      const first = await startDaemon(sb);
      expect(first.output()).toContain('Loopback listener host "0.0.0.0" is not a loopback address — refusing to start it');
      expect(first.output()).toContain('Fix: set loopback.host to 127.0.0.1 in config.yaml.');
      expect(await tcpHealth(port)).toBe('refused');
      expect((await sb.run(['stop'])).stdout).toContain('Daemon stopped.');
      await exited(first.child);

      sb.writeConfig(`${BASE_CONFIG}loopback:\n  enabled: true\n  port: ${port}\n  host: 127.0.0.1\n  token: aqm_lb_cov_cli_core_daemon\n`);
      const second = await startDaemon(sb);
      expect(second.output()).toContain(`http://127.0.0.1:${port}`);
      expect(await tcpHealth(port)).toBe(200);
    }, T * 2);

    it('serves the OpenShell driver socket when it is enabled, and keeps running when that socket cannot be made', async () => {
      const first = await startDaemon(sb, { env: { AQUAMAN_OPENSHELL_DRIVER: 'true' } });
      const driverSocket = path.join(sb.config, 'openshell.sock');
      expect(first.output()).toContain(`OpenShell credential driver: ${driverSocket}`);
      expect(fs.statSync(driverSocket).isSocket()).toBe(true);
      expect(fs.statSync(driverSocket).mode & 0o777).toBe(0o600);
      expect((await sb.run(['stop'])).stdout).toContain('Daemon stopped.');
      expect(await exited(first.child)).toBe(0);

      const tooLong = path.join(sb.root, 'x'.repeat(120), 'openshell.sock');
      sb.writeConfig(`${BASE_CONFIG}openshell:\n  driver:\n    enabled: true\n    socketPath: ${tooLong}\n`);
      const second = await startDaemon(sb);
      expect(second.output()).toContain('⚠ OpenShell credential driver not started: socket path is');
      expect(second.output()).not.toContain('OpenShell credential driver: /');
      expect((await udsGet(sb.socket, '/_health')).status).toBe(200);
    }, T * 2);
  });

  describe('openclaw start', () => {
    /** Starts `openclaw start` and waits until its proxy answers. */
    async function startProxy(args: string[], until: string) {
      const child = sb.track(sb.spawnCli(['openclaw', 'start', ...args]));
      const output = await waitFor(child, async (text) => {
        if (!text.includes('Credential proxy started on') || !text.includes(until)) return false;
        try { return (await udsGet(sb.socket, '/_health')).status === 200; } catch { return false; }
      });
      return { child, output };
    }

    it('--dry-run prints the plan and the variables OpenClaw would get, and starts nothing', async () => {
      const r = await sb.run(['openclaw', 'start', '--dry-run']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Dry run - would start with this configuration:');
      expect(r.stdout).toContain(`  Socket: ${sb.socket}`);
      expect(r.stdout).toContain('  Backend: encrypted-file');
      expect(r.stdout).toContain('  Services: anthropic, github');
      expect(r.stdout).toContain('OpenClaw environment variables:');
      expect(r.stdout).toMatch(/ {2}ANTHROPIC_BASE_URL=http:\/\/aquaman\.local\/anthropic/);
      expect(r.stdout).not.toContain('OPENAI_BASE_URL');
      expect(fs.existsSync(sb.socket)).toBe(false);
    }, T);

    it('--no-launch runs the proxy alone, with the broker off, audits what passes through, and shuts down on SIGTERM', async () => {
      const { child, output } = await startProxy(['--no-launch'], 'ANTHROPIC_BASE_URL=');
      expect(output()).toContain('To use with OpenClaw, set these environment variables:');
      expect(output()).toContain('Daemon mode - credential proxy running.');
      expect(output()).toMatch(/ANTHROPIC_BASE_URL=http:\/\/aquaman\.local\/anthropic/);

      // An OpenClaw-hosted proxy never hands a value out.
      const resolve = await udsPost(sb.socket, '/broker/resolve', { service: 'github', key: 'token' });
      expect(resolve.status).toBe(404);
      expect(resolve.json.code).toBe('broker_disabled');

      // No credential stored: refused before anything leaves the machine, and audited.
      const forwarded = await udsGet(sb.socket, '/anthropic/v1/models');
      expect(forwarded.status).toBe(401);
      let tail = '';
      for (let i = 0; i < 40 && !tail.includes('anthropic use FAIL'); i++) {
        await sleep(250);
        tail = (await sb.run(['audit', 'tail'])).stdout;
      }
      expect(tail).toMatch(/\[CREDENTIAL_ACCESS\] anthropic use FAIL: /);

      await stop(child);
      expect(child.exitCode).toBe(0);
      expect(output()).toContain('Shutting down...');
    }, T * 2);

    it('without OpenClaw on PATH it keeps the proxy up and prints the variables to set by hand', async () => {
      const { output } = await startProxy([], 'ANTHROPIC_BASE_URL=');
      expect(output()).toContain('OpenClaw not found. Credential proxy is running.');
      expect(output()).toContain('To use with OpenClaw, set these environment variables:');
      expect(output()).not.toContain('Launching OpenClaw');
      expect((await udsGet(sb.socket, '/_health')).status).toBe(200);
    }, T);

    it('launches OpenClaw with the workspace and the proxy variables, and exits with its exit code', async () => {
      const record = path.join(sb.root, 'openclaw-launch.txt');
      sb.installBin('openclaw', [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "openclaw 2026.9.37"; exit 0; fi',
        `printf '%s\\n' "$*" "$ANTHROPIC_BASE_URL" > "${record}"`,
        'exit 3',
        '',
      ].join('\n'));
      const workspace = path.join(sb.root, 'workspace');
      const r = await sb.run(['openclaw', 'start', '--workspace', workspace]);
      expect(r.code).toBe(3);
      expect(r.stdout).toContain(`Credential proxy started on ${sb.socket}`);
      expect(r.stdout).toContain('Launching OpenClaw 2026.9.37...');
      expect(r.stdout).toContain('OpenClaw exited with code 3');
      const [args, baseUrl] = fs.readFileSync(record, 'utf-8').split('\n');
      expect(args).toBe(`--cwd ${workspace}`);
      expect(baseUrl).toBe('http://aquaman.local/anthropic');
    }, T);

    it('exits 1 with the reason when the backend cannot be opened', async () => {
      const r = await sb.run(['openclaw', 'start', '--no-launch'], { env: { AQUAMAN_BACKEND: 'vault' } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Credential backend "vault" failed to initialize: vaultAddress required');
      expect(r.stderr).toContain('Run: aquaman doctor');
      expect(r.stdout).not.toContain('Credential proxy started');
    }, T);
  });
});
