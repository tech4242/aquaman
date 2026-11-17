/**
 * E2E: `aquaman init --agent`, the one command an agent runs to set a project
 * up: config, daemon, then the coder side. Covers the daemon being started,
 * found running, restarted for `--loopback`, and every way the command stops
 * with something a person has to do.
 *
 * The daemon it starts is a real one, detached, in the sandbox's config
 * directory; `aquaman-coder` is the real CLI from source or a script.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  createSandbox, startDaemon, fakeProxy, json, exited, freePort, udsGet, T,
  type FakeProxy, type Sandbox,
} from './cov-cli-core-helpers.js';

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

describe('cli-core: aquaman init --agent', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  let extra: ChildProcess | undefined;
  beforeEach(() => { sb = createSandbox(); proxy = undefined; extra = undefined; });
  afterEach(async () => {
    await proxy?.close();
    extra?.kill('SIGKILL');
    await sb.cleanup();
  });

  const configFile = () => path.join(sb.config, 'config.yaml');
  const pidFile = () => path.join(sb.config, 'daemon.pid');
  const rawConfig = () => parseYaml(fs.readFileSync(configFile(), 'utf-8'));
  const init = (args: string[], opts: Parameters<Sandbox['run']>[1] = {}) =>
    sb.run(['init', '--agent', ...args], { inheritLoader: true, ...opts });
  const daemonPid = () => Number(fs.readFileSync(pidFile(), 'utf-8'));

  it('refuses an agent it does not know, in JSON and in words, before creating anything', async () => {
    const r = await init(['cursor', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      agent: 'cursor',
      error: 'Unsupported agent "cursor". Supported: claude-code, codex',
      fix: expect.stringContaining('aquaman init --agent claude-code'),
      human_steps: [],
    });

    const text = await init(['cursor']);
    expect(text.code).toBe(1);
    expect(text.stderr).toContain('Unsupported agent "cursor". Supported: claude-code, codex');
    expect(text.stderr).toContain('→ aquaman init --agent claude-code');
    expect(text.stdout).toBe('');
    expect(fs.existsSync(configFile())).toBe(false);
  }, T);

  it('from nothing: creates the config, starts the daemon, sets up the project, and is a no-op the second time', async () => {
    sb.installRealCoder();
    const first = await init(['claude-code', '--no-hooks', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out).toMatchObject({
      ok: true,
      agent: 'claude-code',
      config: { path: configFile(), created: true, backend: 'encrypted-file' },
      daemon: { running: true, started: true, socket: sb.socket, log: path.join(sb.config, 'daemon.log') },
      project: { name: 'app', path: sb.project, created: true },
      mode: 'exec',
      run: 'aquaman-coder exec -- <command>',
      hooks: { installed: false },
      agents_file: { path: path.join(sb.project, 'CLAUDE.md'), action: 'created' },
      human_steps: [],
      next: expect.stringContaining('aquaman request aquaman://<service>/<key> --env <ENV_NAME>'),
    });
    expect(out.loopback).toBeUndefined();
    expect(out.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(sb.config, 'audit')).isDirectory()).toBe(true);
    // The listener is a port any local process can reach: never on unless asked for.
    expect(rawConfig().loopback.enabled).toBe(false);
    expect(fs.existsSync(path.join(sb.home, '.claude', 'settings.json'))).toBe(false);
    const pid = daemonPid();
    expect(JSON.parse((await udsGet(sb.socket, '/_health')).body).pid).toBe(pid);

    const second = await init(['claude-code', '--no-hooks']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`✓ Config found (${configFile()}, backend: encrypted-file)`);
    expect(second.stdout).toContain('✓ Daemon already running');
    expect(second.stdout).toContain(`✓ Project "app" covers ${sb.project}`);
    expect(second.stdout).toContain('✓ Hooks: none installed. Run commands that need credentials as: aquaman-coder exec -- <command>');
    expect(second.stdout).toContain(`✓ Skill: ${path.join(sb.home, '.claude', 'skills', 'aquaman-credentials', 'SKILL.md')}`);
    expect(second.stdout).toContain(`✓ Instructions: ${path.join(sb.project, 'CLAUDE.md')}`);
    expect(second.stdout).toContain('When a task needs a credential: aquaman request');
    expect(second.stdout.trim().startsWith('{')).toBe(false);
    expect(daemonPid()).toBe(pid);
  }, T * 2);

  it('with hooks: says where they went and what only a person can do', async () => {
    sb.installRealCoder();
    const r = await init(['claude-code']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ Config created');
    expect(r.stdout).toContain('✓ Daemon started');
    expect(r.stdout).toContain(`✓ Hooks: ${path.join(sb.home, '.claude', 'settings.json')}`);
    expect(r.stdout).toMatch(/→ A person needs to: .*restart Claude Code/);
    expect(fs.readFileSync(path.join(sb.home, '.claude', 'settings.json'), 'utf-8')).toContain('aquaman-coder hook');
  }, T);

  it('hands the coder exactly the agent and the --no-hooks choice', async () => {
    sb.installFakeCoder('echo \'{"ok":true,"project":{"name":"app","path":"/x"},"mode":"exec","human_steps":["trust the hooks"]}\'');
    const noHooks = await init(['codex', '--no-hooks', '--json']);
    expect(noHooks.code).toBe(0);
    expect(JSON.parse(noHooks.stdout)).toMatchObject({ ok: true, agent: 'codex', mode: 'exec', human_steps: ['trust the hooks'] });
    const withHooks = await init(['codex', '--json']);
    expect(withHooks.code).toBe(0);
    expect(sb.coderCalls()).toEqual([
      ['init', '--agent', 'codex', '--json', '--no-hooks'],
      ['init', '--agent', 'codex', '--json'],
    ]);
  }, T * 2);

  it('--loopback turns the listener on with a fresh token, replaces a non-loopback host, and changes nothing when repeated', async () => {
    sb.installRealCoder();
    const port = await freePort();
    sb.writeConfig(`credentials:\n  backend: encrypted-file\nloopback:\n  enabled: false\n  port: ${port}\n  host: 0.0.0.0\n`);

    const first = await init(['claude-code', '--no-hooks', '--loopback', '--json']);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const out = JSON.parse(first.stdout);
    expect(out.loopback).toEqual({ enabled: true, url: `http://127.0.0.1:${port}`, changed: true });
    expect(out.daemon).toMatchObject({ running: true, started: true });
    const lb = rawConfig().loopback;
    expect(lb).toMatchObject({ enabled: true, port, host: '127.0.0.1' });
    expect(lb.token).toMatch(/^aqm_lb_/);
    // The token is in the file, never in the command's output.
    expect(first.stdout).not.toContain(lb.token);
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    // The environment's password was not written back by the raw edit.
    expect(rawConfig().credentials.encryptionPassword).toBeUndefined();
    expect(fs.readdirSync(sb.config).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(await tcpHealth(port)).toBe(200);
    const pid = daemonPid();

    const second = await init(['claude-code', '--no-hooks', '--loopback']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`✓ Loopback listener enabled (http://127.0.0.1:${port})`);
    expect(second.stdout).toContain('✓ Daemon already running');
    expect(rawConfig().loopback.token).toBe(lb.token);
    expect(daemonPid()).toBe(pid);
  }, T * 2);

  it('--loopback restarts its own daemon when that one was started without the listener', async () => {
    sb.installRealCoder();
    const port = await freePort();
    sb.writeConfig(`credentials:\n  backend: encrypted-file\nloopback:\n  enabled: false\n  port: ${port}\n`);
    const { child } = await startDaemon(sb);
    const before = daemonPid();
    expect(await tcpHealth(port)).toBe('refused');

    const r = await init(['claude-code', '--no-hooks', '--loopback', '--json']);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.loopback).toEqual({ enabled: true, url: `http://127.0.0.1:${port}`, changed: true, daemon_restarted: true });
    expect(out.daemon).toMatchObject({ running: true, started: true });
    // The old daemon was asked to stop, not killed: it ran its own shutdown.
    expect(await exited(child)).toBe(0);
    expect(daemonPid()).not.toBe(before);
    expect(await tcpHealth(port)).toBe(200);
  }, T * 2);

  it('--loopback will not signal a proxy it cannot identify as its own daemon', async () => {
    const port = await freePort();
    sb.writeConfig(`credentials:\n  backend: encrypted-file\nloopback:\n  port: ${port}\n`);
    // Something on the socket that reports no pid, as an OpenClaw-hosted proxy would be. A pid
    // file left behind by an earlier daemon points at this test process.
    let speaksJson = true;
    proxy = await fakeProxy(sb.socket, (_req, res) => {
      if (speaksJson) return json(res, 200, { status: 'ok' });
      res.writeHead(200);
      res.end('ok');
    });
    fs.writeFileSync(pidFile(), String(process.pid));
    let signalled = false;
    const onTerm = () => { signalled = true; };
    process.once('SIGTERM', onTerm);
    try {
      const r = await init(['claude-code', '--loopback', '--json']);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({
        ok: false,
        loopback: { enabled: true, changed: true },
        error: 'A proxy is running without the loopback listener and this command cannot restart it',
        fix: expect.stringContaining('aquaman stop'),
      });

      // Nor one whose health reply cannot be read at all.
      speaksJson = false;
      const text = await init(['claude-code', '--loopback']);
      expect(text.code).toBe(1);
      expect(text.stderr).toContain('✗ A proxy is running without the loopback listener and this command cannot restart it');
      expect(text.stderr).toContain('→ Stop it (aquaman stop, or stop the OpenClaw gateway that started it)');
      expect(signalled).toBe(false);
      expect(proxy.requests.every((q) => q.url === '/_health')).toBe(true);
    } finally {
      process.removeListener('SIGTERM', onTerm);
      fs.rmSync(pidFile(), { force: true });
    }
  }, T * 2);

  it('--loopback says so when its daemon would not stop, and does not start a second one', async () => {
    const port = await freePort();
    sb.writeConfig(`credentials:\n  backend: encrypted-file\nloopback:\n  port: ${port}\n`);
    // A daemon that reports its own pid on the socket and ignores SIGTERM.
    const script = path.join(sb.root, 'stubborn.cjs');
    fs.writeFileSync(script, [
      'const http = require("node:http");',
      'process.on("SIGTERM", () => {});',
      'http.createServer((_q, s) => { s.writeHead(200, { "Content-Type": "application/json" }); s.end(JSON.stringify({ status: "ok", pid: process.pid })); })',
      '  .listen(process.argv[2], () => console.log("up"));',
    ].join('\n'));
    extra = spawn(process.execPath, [script, sb.socket], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => extra!.stdout!.once('data', () => resolve()));
    fs.writeFileSync(pidFile(), String(extra.pid));

    const r = await init(['claude-code', '--loopback']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('✗ The running daemon did not stop, so the loopback listener is not on yet');
    expect(r.stderr).toContain('→ Run: aquaman stop, then this command again');
    expect(extra.exitCode).toBeNull();
    expect(daemonPid()).toBe(extra.pid);
    expect(await tcpHealth(port)).toBe('refused');
    fs.rmSync(pidFile(), { force: true });
  }, T);

  it('when the daemon does not come up: exit 1 with the log path and the last line of the log', async () => {
    sb.writeConfig('credentials:\n  backend: encrypted-file\n');
    // The vault backend has no address, so the daemon exits as soon as it starts.
    const r = await init(['claude-code'], { env: { AQUAMAN_BACKEND: 'vault' } });
    const log = path.join(sb.config, 'daemon.log');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`✗ The daemon did not start. See ${log}: `);
    expect(r.stderr).toContain('Run: aquaman doctor');
    expect(r.stderr).toContain('→ Run `aquaman daemon` in a terminal to see the error, then `aquaman doctor`');
    expect(fs.readFileSync(log, 'utf-8')).toContain('Credential backend "vault" failed to initialize');
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(pidFile())).toBe(false);
  }, T);

  it('without aquaman-coder: the daemon is up, and the answer is the install command', async () => {
    const r = await init(['claude-code', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      daemon: { running: true, started: true },
      error: 'aquaman-coder is not installed',
      fix: 'npm install -g aquaman-coder',
    });

    const text = await init(['claude-code']);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain('✓ Daemon already running');
    expect(text.stderr).toContain('✗ aquaman-coder is not installed');
    expect(text.stderr).toContain('→ npm install -g aquaman-coder');
  }, T * 2);

  it('reports the coder\'s last line when it fails without JSON, and its error when it answers ok: false', async () => {
    sb.installFakeCoder('echo "first line" >&2\necho "EACCES: projects.yaml" >&2\nexit 1');
    const crashed = await init(['claude-code', '--json']);
    expect(crashed.code).toBe(1);
    expect(JSON.parse(crashed.stdout)).toMatchObject({ ok: false, error: 'aquaman-coder init failed: EACCES: projects.yaml' });
    const crashedText = await init(['claude-code']);
    expect(crashedText.code).toBe(1);
    expect(crashedText.stderr).toContain('✗ aquaman-coder init failed: EACCES: projects.yaml');

    // The real coder refuses the home directory as a project.
    sb.installRealCoder();
    const refused = await init(['claude-code', '--no-hooks', '--json'], { cwd: sb.home });
    expect(refused.code).toBe(1);
    const out = JSON.parse(refused.stdout);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('home directory');
    expect(fs.existsSync(path.join(sb.config, 'projects.yaml'))).toBe(false);
  }, T * 2);
});
