/**
 * E2E: `aquaman service install|uninstall|status`, the login-item part of
 * `aquaman init --agent`, and the line `aquaman doctor` prints about it. The
 * real CLI runs as a child process in its own HOME and config directory.
 *
 * `launchctl` and `systemctl` are never run: every case here stops before the
 * command would call one (a dry run, a refusal, a no, nobody to ask). What
 * happens after a yes is covered with a fake runner in
 * test/unit/service-unit.test.ts. The proxy on the socket is a stand-in whose
 * answers the test decides, so no dialog is shown either, and the backend the
 * CLI sees is `keychain` by name only: nothing here opens a vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createSandbox, startDaemon, fakeProxy, json, sleep, udsGet, PROXY_CLI, TSX, T,
  type FakeProxy, type Sandbox,
} from './cov-cli-core-helpers.js';

/** A backend `install` accepts. The sandbox's default, `encrypted-file`, is the one it refuses. */
const KEYCHAIN = { AQUAMAN_BACKEND: 'keychain', AQUAMAN_ENCRYPTION_PASSWORD: undefined };

const SCRIPT = '/usr/bin/script';
const SCRIPT_CALL = process.platform === 'darwin'
  ? `cat | ${SCRIPT} -q /dev/null "$@"`
  : `cat | ${SCRIPT} -qec "$1" /dev/null`;
const hasScript = fs.existsSync(SCRIPT) && (process.platform === 'darwin' || process.platform === 'linux')
  && spawnSync('/bin/sh', ['-c', SCRIPT_CALL, 'sh', '/usr/bin/true'], { input: '', stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// A Linux machine without systemd has no user manager to install into, and the command says so first.
const supported = process.platform === 'darwin'
  || (process.platform === 'linux' && ['/usr/bin/systemctl', '/bin/systemctl'].some((p) => fs.existsSync(p)));

describe.skipIf(!supported)('aquaman service', () => {
  let sb: Sandbox;
  let proxy: FakeProxy | undefined;
  beforeEach(() => { sb = createSandbox(); proxy = undefined; });
  afterEach(async () => {
    await proxy?.close();
    await sb.cleanup();
  });

  const unitPath = () => process.platform === 'darwin'
    ? path.join(sb.home, 'Library', 'LaunchAgents', 'sh.aquaman.daemon.plist')
    : path.join(sb.home, '.config', 'systemd', 'user', 'aquaman.service');
  const homeFiles = () => fs.readdirSync(sb.home, { recursive: true }).map(String).sort();
  const pidFile = () => path.join(sb.config, 'daemon.pid');

  /** A process that only waits: something a pid file can name without it being this test. */
  function idleProcess(): ChildProcess {
    return sb.track(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' }));
  }

  /**
   * A stand-in for a daemon started by hand: it reports `pid` on /_health,
   * the pid file names the same process, and the consent endpoint answers
   * what the test says. The answer is never `approved`: after a yes the CLI
   * would go on to the real service manager.
   */
  async function standInDaemon(consent: (res: Parameters<Parameters<typeof fakeProxy>[1]>[1]) => void, opts: { pidFile?: boolean } = {}): Promise<number> {
    const idle = idleProcess();
    proxy = await fakeProxy(sb.socket, (req, res) => {
      if (req.url === '/_health') json(res, 200, { status: 'ok', pid: idle.pid });
      else if (req.url === '/_service/consent') consent(res);
      else json(res, 404, { error: 'not here' });
    });
    if (opts.pidFile !== false) fs.writeFileSync(pidFile(), String(idle.pid));
    return idle.pid!;
  }
  const consentRequests = () => proxy!.requests.filter((r) => r.url === '/_service/consent');

  describe('install --dry-run', () => {
    it('prints the unit file and the commands, and changes nothing', async () => {
      const r = await sb.run(['service', 'install', '--dry-run'], { env: KEYCHAIN });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`dry_run: ${unitPath()}`);
      expect(r.stdout).toContain('Commands (not run):');
      expect(r.stdout).toContain('Nothing was changed.');
      expect(r.stdout).toContain(PROXY_CLI);
      if (process.platform === 'darwin') {
        expect(r.stdout).toContain('<string>sh.aquaman.daemon</string>');
        expect(r.stdout).toMatch(/\/bin\/launchctl bootstrap gui\/\d+ /);
      } else {
        expect(r.stdout).toContain('WantedBy=default.target');
        expect(r.stdout).toContain('systemctl --user enable --now aquaman.service');
      }
      expect(homeFiles()).toEqual([]);
      expect(fs.readdirSync(sb.config)).toEqual([]);
    }, T);

    it('--json: one object with the unit text, the commands, and the settings the service would not inherit, by name only', async () => {
      const r = await sb.run(['service', 'install', '--dry-run', '--json'], { env: { ...KEYCHAIN, VAULT_TOKEN: 'hvs.e2e-secret-token-value' } });
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({ status: 'dry_run', platform: process.platform, unit: unitPath() });
      expect(out.commands.length).toBeGreaterThan(0);
      // The unit runs this Node and this CLI as the daemon, from the sandbox's config directory.
      expect(out.unit_file).toContain(fs.realpathSync(process.execPath));
      expect(out.unit_file).toContain(PROXY_CLI);
      expect(out.unit_file).toContain(sb.config);
      expect(out.unit_file).toContain('AQUAMAN_CONFIG_DIR');
      expect(out.env_not_passed).toEqual(expect.arrayContaining(['AQUAMAN_BACKEND', 'VAULT_TOKEN']));
      expect(r.stdout).not.toContain('hvs.e2e-secret-token-value');
      expect(homeFiles()).toEqual([]);
    }, T);

    it('a relative AQUAMAN_CONFIG_DIR goes into the unit as an absolute path', async () => {
      const r = await sb.run(['service', 'install', '--dry-run', '--json'], { cwd: sb.root, env: { ...KEYCHAIN, AQUAMAN_CONFIG_DIR: 'aq' } });
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).unit_file).toContain(sb.config);
    }, T);
  });

  describe('install refuses', () => {
    it('the encrypted-file backend, saying why and what to use instead, before anybody is asked', async () => {
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'never reached' }));
      const r = await sb.run(['service', 'install', '--json']);
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('error');
      expect(out.error).toContain('AQUAMAN_ENCRYPTION_PASSWORD');
      expect(out.error).toContain('storing it on disk');
      expect(out.fix).toContain('keychain');
      expect(out.fix).toContain('systemd-creds');
      expect(out.fix).toContain('aquaman daemon');
      expect(consentRequests()).toEqual([]);
      expect(homeFiles()).toEqual([]);

      const text = await sb.run(['service', 'install', '--dry-run']);
      expect(text.code).toBe(1);
      expect(text.stderr).toContain('The encrypted-file backend needs AQUAMAN_ENCRYPTION_PASSWORD');
      expect(text.stderr).toContain('Fix: Use a backend that needs no password');
      expect(text.stdout).toBe('');
    }, T * 2);

    it('the encrypted-file backend when only config.yaml names it, since that is what a login item would start with', async () => {
      sb.writeConfig('credentials:\n  backend: encrypted-file\n');
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error).toContain('AQUAMAN_ENCRYPTION_PASSWORD');
    }, T);

    it('a --timeout that is not a whole number, with exit 1', async () => {
      const r = await sb.run(['service', 'install', '--timeout', 'soon', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'error', error: 'Invalid --timeout: soon', fix: expect.stringContaining('between 10 and 600') });
    }, T);

    it('a proxy on the socket that it may not signal, before anybody is asked', async () => {
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'never reached' }), { pidFile: false });
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({
        status: 'error',
        error: expect.stringContaining('cannot stop'),
        fix: expect.stringContaining('aquaman stop'),
      });
      expect(consentRequests()).toEqual([]);
      expect(homeFiles()).toEqual([]);
    }, T);
  });

  describe('install without a terminal', () => {
    it('no daemon: pending, exit 3, with the step for a person, and nothing written', async () => {
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(3);
      expect(JSON.parse(r.stdout)).toEqual({
        status: 'pending',
        platform: process.platform,
        unit: unitPath(),
        reason: 'the daemon is not running, so no dialog can be shown',
        fix: 'Run in a terminal: aquaman service install',
      });
      expect(homeFiles()).toEqual([]);

      const text = await sb.run(['service', 'install'], { env: KEYCHAIN });
      expect(text.code).toBe(3);
      expect(text.stderr).toContain(`pending: ${unitPath()} (the daemon is not running, so no dialog can be shown)`);
      expect(text.stderr).toContain('Fix: Run in a terminal: aquaman service install');
      expect(text.stdout).toBe('');
    }, T * 2);

    it('asks the daemon for a dialog with the wait it was given, and a no is exit 2 with no way around it', async () => {
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'the person at the dialog said no' }));
      const r = await sb.run(['service', 'install', '--json', '--timeout', '5'], { env: KEYCHAIN, input: 'y\n' });
      expect(r.code).toBe(2);
      const out = JSON.parse(r.stdout);
      expect(out).toEqual({ status: 'declined', platform: process.platform, unit: unitPath(), reason: 'the person at the dialog said no' });
      expect(out.fix).toBeUndefined();
      // Clamped to the daemon's minimum; the "y" on stdin answered nothing.
      expect(consentRequests()).toEqual([{ method: 'POST', url: '/_service/consent', body: { timeout_seconds: 10 } }]);
      expect(homeFiles()).toEqual([]);

      const text = await sb.run(['service', 'install'], { env: KEYCHAIN });
      expect(text.code).toBe(2);
      expect(text.stderr).toContain('declined:');
      expect(text.stderr).not.toContain('Fix:');
    }, T * 2);

    it('a dialog that could not be shown or was not answered is pending, exit 3', async () => {
      await standInDaemon((res) => json(res, 200, { status: 'pending', reason: 'the daemon has no desktop session (no DISPLAY or WAYLAND_DISPLAY)', fix: 'Run in a terminal: aquaman service install' }));
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'pending', reason: 'the daemon has no desktop session (no DISPLAY or WAYLAND_DISPLAY)', fix: 'Run in a terminal: aquaman service install' });
      expect(consentRequests()[0].body).toEqual({ timeout_seconds: 90 });
      expect(homeFiles()).toEqual([]);
    }, T);

    it('a reply with neither a yes nor a no is pending, never an approval', async () => {
      await standInDaemon((res) => json(res, 200, { status: 'installed' }));
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'pending', reason: 'no answer' });
      expect(homeFiles()).toEqual([]);
    }, T);

    it('a proxy that does not take the question is exit 4, with the proxy\'s own error, code and fix', async () => {
      await standInDaemon((res) => json(res, 404, { error: 'Approval dialogs are disabled on this proxy', fix: 'OpenClaw-hosted proxies never show dialogs. Run in a terminal: aquaman service install', code: 'broker_disabled' }));
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(4);
      expect(JSON.parse(r.stdout)).toMatchObject({
        status: 'error',
        error: 'Approval dialogs are disabled on this proxy',
        code: 'broker_disabled',
        fix: 'OpenClaw-hosted proxies never show dialogs. Run in a terminal: aquaman service install',
      });
      expect(homeFiles()).toEqual([]);
    }, T);

    it('a proxy that answers something other than JSON is exit 4, with the step for a person', async () => {
      await standInDaemon((res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('approved'); });
      const r = await sb.run(['service', 'install', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(4);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'error', code: 'bad_response', fix: 'Run in a terminal: aquaman service install' });
      expect(homeFiles()).toEqual([]);
    }, T);
  });

  describe.skipIf(!hasScript)('install at a terminal', () => {
    function runAtTerminal(args: string[], typed: { after: string; keys: string }): Promise<{ code: number | null; output: string }> {
      const command = [TSX, PROXY_CLI, ...args];
      const scriptArgs = process.platform === 'darwin' ? command : [command.map(shellQuote).join(' ')];
      return new Promise((resolve, reject) => {
        const child = spawn('/bin/sh', ['-c', SCRIPT_CALL, 'sh', ...scriptArgs], { cwd: sb.project, env: sb.env(KEYCHAIN), stdio: ['pipe', 'pipe', 'pipe'] });
        let output = '';
        let sent = false;
        const onData = (d: Buffer) => {
          output += d.toString();
          if (!sent && output.includes(typed.after)) {
            sent = true;
            void sleep(400).then(() => child.stdin.end(typed.keys));
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, output }));
      });
    }

    // Only ever answered with a no: a yes would go on to the real service manager.
    it.each([
      ['n', 'n\r'],
      ['a bare Enter', '\r'],
      ['something that is not yes', 'sure\r'],
    ])('asks one y/N question that says what will be installed, and %s installs nothing', async (_name, keys) => {
      const r = await runAtTerminal(['service', 'install'], { after: 'Install it? [y/N]', keys });
      expect(r.output).toContain('aquaman will start at every login and keep running in the background.');
      expect(r.output).toContain(`Unit file: ${unitPath()}`);
      expect(r.output).toContain('Remove it later with: aquaman service uninstall');
      expect(r.output).toContain('declined:');
      expect(r.output).toContain('answered no at the terminal');
      expect(r.output).not.toContain('Fix:');
      expect(r.code).toBe(2);
      expect(homeFiles()).toEqual([]);
    }, T);

    it('at a terminal the daemon is not asked for a dialog', async () => {
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'never reached' }));
      const r = await runAtTerminal(['service', 'install'], { after: 'Install it? [y/N]', keys: 'n\r' });
      expect(r.code).toBe(2);
      expect(consentRequests()).toEqual([]);
    }, T);
  });

  describe('status and uninstall', () => {
    it('status with nothing installed: says so in words and in JSON, and exits 0', async () => {
      const text = await sb.run(['service', 'status'], { env: KEYCHAIN });
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain('Starts at login: no');
      expect(text.stdout).toContain(`Unit file:  ${unitPath()} (not present)`);
      expect(text.stdout).toContain('Loaded:     no');
      expect(text.stdout).toContain('Daemon:     not reachable on the socket');
      expect(text.stdout).toContain('→ Run in a terminal: aquaman service install');

      const r = await sb.run(['service', 'status', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        supported: true,
        platform: process.platform,
        unit: { path: unitPath(), present: false, current: null },
        loaded: false,
        starts_at_login: false,
        daemon: { reachable: false, pid: null, managed_by_service: false },
      });
      expect(homeFiles()).toEqual([]);
    }, T * 2);

    it('status sees a daemon on the socket and that no service started it', async () => {
      const pid = await standInDaemon((res) => json(res, 404, {}));
      const r = await sb.run(['service', 'status', '--json'], { env: KEYCHAIN });
      expect(JSON.parse(r.stdout).daemon).toEqual({ reachable: true, pid, managed_by_service: false });
      const text = await sb.run(['service', 'status'], { env: KEYCHAIN });
      expect(text.stdout).toContain('Daemon:     reachable on the socket (not started by the service)');
    }, T * 2);

    it('uninstall with nothing installed finds nothing to do', async () => {
      const r = await sb.run(['service', 'uninstall', '--json'], { env: KEYCHAIN });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ status: 'not_installed', platform: process.platform, unit: unitPath() });
      const text = await sb.run(['service', 'uninstall'], { env: KEYCHAIN });
      expect(text.code).toBe(0);
      expect(text.stdout).toContain(`not_installed: ${unitPath()}`);
    }, T * 2);

    it('lists the three commands in the help', async () => {
      const r = await sb.run(['service', '--help']);
      expect(r.stdout).toContain('install');
      expect(r.stdout).toContain('uninstall');
      expect(r.stdout).toContain('status');
      const install = await sb.run(['service', 'install', '--help']);
      expect(install.stdout).toContain('No flag or environment variable');
      expect(install.stdout).toContain('--dry-run');
      expect(install.stdout).toMatch(/declined\s+2/);
      expect(install.stdout).toMatch(/pending\s+3/);
    }, T * 2);
  });

  describe('aquaman init --agent', () => {
    const FAKE_CODER = 'echo \'{"ok":true,"project":{"name":"app","path":"/x"},"mode":"exec","human_steps":[]}\'';
    const init = (args: string[], env: Record<string, string | undefined> = KEYCHAIN) =>
      sb.run(['init', '--agent', 'claude-code', '--no-hooks', ...args], { env });
    // Written up front, so the backend in the file does not depend on what this machine would auto-detect.
    beforeEach(() => { sb.writeConfig('credentials:\n  backend: keychain\n'); });

    it('without --service installs nothing and adds one step for a person that names the command', async () => {
      sb.installFakeCoder(FAKE_CODER);
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'never reached' }));
      const r = await init(['--json']);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(true);
      expect(out.service).toBeUndefined();
      expect(out.human_steps).toEqual([expect.stringContaining('aquaman service install')]);
      expect(consentRequests()).toEqual([]);
      expect(homeFiles().some((f) => f.includes('aquaman.daemon') || f.includes('aquaman.service'))).toBe(false);

      const text = await init([]);
      expect(text.stdout).toMatch(/→ A person needs to: run `aquaman service install` in a terminal/);
    }, T * 2);

    it('without --service adds no step when a unit file is already there, or when the backend is one install refuses', async () => {
      sb.installFakeCoder(FAKE_CODER);
      await standInDaemon((res) => json(res, 404, {}));
      const refusedBackend = JSON.parse((await init(['--json'], {})).stdout);
      expect(refusedBackend).toMatchObject({ ok: true, human_steps: [] });

      fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
      fs.writeFileSync(unitPath(), 'a unit file somebody installed\n');
      const present = JSON.parse((await init(['--json'])).stdout);
      expect(present).toMatchObject({ ok: true, human_steps: [] });
      expect(present.service).toBeUndefined();
    }, T * 2);

    it('--service asks through the daemon\'s dialog after setup, and reports a no without failing the setup', async () => {
      sb.installFakeCoder(FAKE_CODER);
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'the person at the dialog said no' }));
      const r = await init(['--service', '--json']);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({
        ok: true,
        agent: 'claude-code',
        mode: 'exec',
        service: { status: 'declined', platform: process.platform, unit: unitPath(), reason: 'the person at the dialog said no' },
        human_steps: [],
      });
      expect(out.service.fix).toBeUndefined();
      expect(consentRequests()).toEqual([{ method: 'POST', url: '/_service/consent', body: { timeout_seconds: 90 } }]);
      // Asked after the coder side was set up.
      expect(sb.coderCalls()).toEqual([['init', '--agent', 'claude-code', '--json', '--no-hooks']]);
      expect(homeFiles().some((f) => f.includes('aquaman.daemon') || f.includes('aquaman.service'))).toBe(false);

      const text = await init(['--service']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('• Start at login: declined');
    }, T * 2);

    it('--service with nobody to ask reports pending and the step for a person', async () => {
      sb.installFakeCoder(FAKE_CODER);
      await standInDaemon((res) => json(res, 200, { status: 'pending', reason: 'nobody answered the dialog' }));
      const out = JSON.parse((await init(['--service', '--json'])).stdout);
      expect(out).toMatchObject({ ok: true, service: { status: 'pending', reason: 'nobody answered the dialog', fix: 'Run in a terminal: aquaman service install' } });
      const text = await init(['--service']);
      expect(text.stdout).toContain('• Start at login: pending');
      expect(text.stdout).toContain('→ Run in a terminal: aquaman service install');
    }, T * 2);

    it('--service with the encrypted-file backend reports the refusal in the JSON and asks nobody', async () => {
      sb.installFakeCoder(FAKE_CODER);
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'never reached' }));
      const r = await init(['--service', '--json'], {});
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(true);
      expect(out.service.status).toBe('error');
      expect(out.service.error).toContain('AQUAMAN_ENCRYPTION_PASSWORD');
      expect(out.service.fix).toContain('aquaman daemon');
      expect(consentRequests()).toEqual([]);

      const text = await init(['--service'], {});
      expect(text.stdout).toContain('• Start at login: error (The encrypted-file backend needs AQUAMAN_ENCRYPTION_PASSWORD');
    }, T * 2);

    it('--service is not asked for when setup did not succeed', async () => {
      sb.installFakeCoder('echo \'{"ok":false,"error":"no project here","human_steps":[]}\'');
      await standInDaemon((res) => json(res, 200, { status: 'declined', reason: 'never reached' }));
      const r = await init(['--service', '--json']);
      expect(r.code).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out.ok).toBe(false);
      expect(out.service).toBeUndefined();
      expect(consentRequests()).toEqual([]);
    }, T);
  });

  describe('aquaman doctor', () => {
    it('says whether the daemon starts at login, as information and not as an issue', async () => {
      sb.writeConfig('credentials:\n  backend: encrypted-file\n');
      await standInDaemon((res) => json(res, 404, {}));
      const without = await sb.run(['doctor']);
      expect(without.stdout).toContain('• Daemon does not start at login (to change that: aquaman service install)');
      expect(without.stdout).toContain('All baseline checks passed.');
      expect(without.code).toBe(0);

      fs.mkdirSync(path.dirname(unitPath()), { recursive: true });
      fs.writeFileSync(unitPath(), 'a unit file somebody installed\n');
      const withUnit = await sb.run(['doctor']);
      expect(withUnit.stdout).toContain('• Daemon starts at login (details: aquaman service status)');
      expect(withUnit.code).toBe(0);
    }, T * 2);
  });

  describe('aquaman daemon', () => {
    it('starts when the pid file names a live process that is not a daemon, as after a crash and a reboot', async () => {
      const stranger = idleProcess();
      fs.writeFileSync(pidFile(), String(stranger.pid));
      await startDaemon(sb);
      const health = JSON.parse((await udsGet(sb.socket, '/_health')).body);
      expect(health.pid).not.toBe(stranger.pid);
      expect(Number(fs.readFileSync(pidFile(), 'utf-8'))).toBe(health.pid);
      // The other process was left alone.
      expect(stranger.exitCode).toBeNull();
      expect(stranger.signalCode).toBeNull();
    }, T);

    // Only where no dialog can appear: the daemon here is a real one with the native prompter.
    it.skipIf(process.platform !== 'linux')('records a login-item request in the audit log, without a dialog when there is no desktop session', async () => {
      await startDaemon(sb, { env: { DISPLAY: undefined, WAYLAND_DISPLAY: undefined } });
      const r = await sb.run(['service', 'install', '--json'], { env: { ...KEYCHAIN, DISPLAY: undefined, WAYLAND_DISPLAY: undefined } });
      expect(r.code).toBe(3);
      expect(JSON.parse(r.stdout)).toMatchObject({ status: 'pending', reason: expect.stringContaining('no desktop session') });
      const tail = (await sb.run(['audit', 'tail'])).stdout;
      expect(tail).toContain('aquaman-service');
      expect(tail).toContain('pending: login item');
      expect(homeFiles().some((f) => f.includes('aquaman.service'))).toBe(false);
    }, T);
  });
});
