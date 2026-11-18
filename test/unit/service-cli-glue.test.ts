/**
 * The part of `aquaman service` that connects the installer to the real
 * machine (`packages/proxy/src/cli/service.ts`): what it hands the installer,
 * how a reply from the daemon becomes an answer, and what is printed.
 *
 * The lines here are the ones the CLI only reaches after a person said yes,
 * where the next step would be the real `launchctl` or `systemctl`. They are
 * exercised directly instead: the config directory and home are temporary,
 * the proxy helpers are fakes, and the only process signalled is one this
 * test started.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDeps, renderResult, renderStatus, loginItemPresent, type ServiceCliHelpers } from '../../packages/proxy/src/cli/service.js';
import { runTool, unitFilePath } from '../../packages/proxy/src/service-unit.js';

describe('service CLI glue', () => {
  let root: string;
  let configDir: string;
  let home: string;
  let posts: Array<{ socketPath: string; urlPath: string; body: Record<string, unknown>; timeoutMs: number }>;
  let reply: Awaited<ReturnType<ServiceCliHelpers['proxyPost']>>;
  let removed: number;
  let helpers: ServiceCliHelpers;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqglue-')));
    configDir = path.join(root, 'aq');
    home = path.join(root, 'home');
    fs.mkdirSync(configDir);
    fs.mkdirSync(home);
    vi.stubEnv('AQUAMAN_CONFIG_DIR', configDir);
    vi.stubEnv('HOME', home);
    vi.stubEnv('AQUAMAN_BACKEND', 'vault');
    posts = [];
    removed = 0;
    reply = { status: 200, json: { status: 'approved' } };
    helpers = {
      cliPath: '/opt/aquaman/dist/cli/index.js',
      proxyPost: async (socketPath, urlPath, body, timeoutMs) => { posts.push({ socketPath, urlPath, body, timeoutMs }); return reply; },
      proxyHealthy: async () => true,
      proxyPid: async () => 4321,
      readPidFile: () => 4321,
      removePidFile: () => { removed++; },
      isProcessRunning: (pid) => pid === 4321,
    };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('hands the installer this machine: the running Node, the CLI entry, the real runner, and both backends', () => {
    const deps = buildDeps(helpers, 'dialog', 90);
    expect(deps).toMatchObject({
      platform: process.platform,
      uid: process.getuid!(),
      username: os.userInfo().username,
      home,
      root: '/',
      configDir,
      nodePath: process.execPath,
      cliPath: '/opt/aquaman/dist/cli/index.js',
      // config.yaml (absent here, so the default) and the one in effect for this command.
      backends: ['keychain', 'vault'],
    });
    expect(deps.run).toBe(runTool);
    expect(deps.env['AQUAMAN_CONFIG_DIR']).toBe(configDir);
  });

  it('gives the unit an absolute config directory when the variable is relative, and none when it is not set', () => {
    const cwd = process.cwd();
    process.chdir(root);
    try {
      vi.stubEnv('AQUAMAN_CONFIG_DIR', 'aq');
      const deps = buildDeps(helpers, 'dialog', 90);
      expect(deps.env['AQUAMAN_CONFIG_DIR']).toBe(configDir);
      expect(deps.configDir).toBe(configDir);
    } finally {
      process.chdir(cwd);
    }
    vi.stubEnv('AQUAMAN_CONFIG_DIR', '');
    expect(buildDeps(helpers, 'dialog', 90).env['AQUAMAN_CONFIG_DIR']).toBeFalsy();
  });

  it('reads the daemon through the CLI\'s own socket helpers', async () => {
    const deps = buildDeps(helpers, 'dialog', 90);
    expect(await deps.daemon.health()).toEqual({ reachable: true, pid: 4321 });
    expect(deps.daemon.pidFile()).toBe(4321);
    expect(deps.daemon.isRunning(4321)).toBe(true);
    expect(deps.daemon.isRunning(1)).toBe(false);
    await deps.sleep(1);
  });

  it('stops a daemon with SIGTERM, and cleans up its pid file and socket', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    try {
      const exit = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
      const deps = buildDeps(helpers, 'dialog', 90);
      deps.daemon.stop(child.pid!);
      expect(await exit).toBe('SIGTERM');
    } finally {
      child.kill('SIGKILL');
    }

    const socket = path.join(configDir, 'proxy.sock');
    fs.writeFileSync(socket, '');
    const deps = buildDeps(helpers, 'dialog', 90);
    deps.daemon.cleanup();
    expect(removed).toBe(1);
    expect(fs.existsSync(socket)).toBe(false);
    // Nothing left to remove is not an error.
    deps.daemon.cleanup();
    expect(removed).toBe(2);
  });

  it('without a terminal, the yes comes from the daemon: asked over the socket, with the wait and a margin', async () => {
    const deps = buildDeps(helpers, 'terminal-or-dialog', 45);
    expect(await deps.consent()).toEqual({ outcome: 'approved' });
    expect(posts).toEqual([{ socketPath: path.join(configDir, 'proxy.sock'), urlPath: '/_service/consent', body: { timeout_seconds: 45 }, timeoutMs: 75_000 }]);
  });

  it.each([
    ['a no', { status: 200, json: { status: 'declined', reason: 'the person at the dialog said no' } }, { outcome: 'declined', reason: 'the person at the dialog said no' }],
    ['nobody to ask', { status: 200, json: { status: 'pending', reason: 'nobody answered the dialog', fix: 'ignored' } }, { outcome: 'pending', reason: 'nobody answered the dialog' }],
    ['a reply that is neither', { status: 200, json: { status: 'installed' } }, { outcome: 'pending', reason: 'no answer' }],
    ['a reply with no status', { status: 200, json: {} }, { outcome: 'pending', reason: 'no answer' }],
    ['a refusal from the proxy', { status: 404, json: { error: 'Approval dialogs are disabled on this proxy', code: 'broker_disabled', fix: 'run it in a terminal' } }, { outcome: 'error', error: 'Approval dialogs are disabled on this proxy', code: 'broker_disabled', fix: 'run it in a terminal' }],
    ['no daemon', { error: 'Cannot reach the aquaman proxy at /x/proxy.sock', code: 'proxy_unreachable' }, { outcome: 'pending', reason: 'the daemon is not running, so no dialog can be shown' }],
    ['a socket it may not connect to', { error: 'Connecting to /x/proxy.sock was denied (EPERM)', code: 'socket_blocked' }, { outcome: 'error', error: 'Connecting to /x/proxy.sock was denied (EPERM)', code: 'socket_blocked' }],
    ['a daemon that never answers', { error: 'timed out waiting for the proxy', code: 'proxy_error' }, { outcome: 'error', error: 'timed out waiting for the proxy', code: 'proxy_error' }],
  ] as const)('reads %s from the daemon', async (_name, response, expected) => {
    reply = response as typeof reply;
    expect(await buildDeps(helpers, 'dialog', 90).consent()).toEqual(expected);
  });

  it('only an explicit "approved" is a yes', async () => {
    for (const status of ['Approved', 'ok', 'yes', true, 1, 'installed', 'already_installed', 'stored', 'ready', undefined]) {
      reply = { status: 200, json: { status } };
      expect((await buildDeps(helpers, 'dialog', 90).consent()).outcome).not.toBe('approved');
    }
    for (const status of [201, 204, 302]) {
      reply = { status, json: { status: 'approved', error: 'not a 200' } };
      expect((await buildDeps(helpers, 'dialog', 90).consent()).outcome).toBe('error');
    }
  });

  it('knows whether a unit file is on disk without asking a service manager', () => {
    expect(loginItemPresent()).toBe(false);
    const unit = unitFilePath(process.platform, home);
    if (unit) {
      fs.mkdirSync(path.dirname(unit), { recursive: true });
      fs.writeFileSync(unit, 'x');
      expect(loginItemPresent()).toBe(true);
    }
  });

  describe('what is printed', () => {
    it('installed: the unit, the log, how to remove it, what a person still has to do and what was not carried over', () => {
      expect(renderResult({
        status: 'installed', platform: 'linux', unit: '/h/.config/systemd/user/aquaman.service', daemon: { running: true },
        log: 'journalctl --user -u aquaman.service',
        human_steps: ['on a machine nobody logs in to, the unit only starts at boot with lingering: loginctl enable-linger ada'],
        env_not_passed: ['VAULT_TOKEN', 'BW_SESSION'],
      })).toEqual([
        'installed: /h/.config/systemd/user/aquaman.service',
        'Log: journalctl --user -u aquaman.service',
        'Remove it with: aquaman service uninstall',
        'Not carried into the service (set only in this shell\'s environment): VAULT_TOKEN, BW_SESSION',
        'A person needs to: on a machine nobody logs in to, the unit only starts at boot with lingering: loginctl enable-linger ada',
      ]);
    });

    it('installed but not answering: the warning names the log', () => {
      const lines = renderResult({ status: 'installed', unit: '/u.plist', log: '/c/daemon.log', warning: 'The unit is installed but the daemon does not answer on its socket yet. See: /c/daemon.log' });
      expect(lines).toContain('Warning: The unit is installed but the daemon does not answer on its socket yet. See: /c/daemon.log');
    });

    it('already installed, uninstalled, declined, and an error with its fix', () => {
      expect(renderResult({ status: 'already_installed', unit: '/u.plist', log: '/c/daemon.log' })).toEqual([
        'already_installed: /u.plist', 'Log: /c/daemon.log', 'Remove it with: aquaman service uninstall',
      ]);
      expect(renderResult({ status: 'uninstalled', unit: '/u.plist', note: 'The daemon the service ran has stopped. Start one by hand when needed: aquaman daemon' })).toEqual([
        'uninstalled: /u.plist', 'The daemon the service ran has stopped. Start one by hand when needed: aquaman daemon',
      ]);
      expect(renderResult({ status: 'declined', unit: '/u.plist', reason: 'answered no at the terminal' })).toEqual(['declined: /u.plist (answered no at the terminal)']);
      expect(renderResult({ status: 'error', error: 'launchctl bootstrap failed (exit 5)', fix: 'Run in a terminal: aquaman service install' })).toEqual([
        'error', 'launchctl bootstrap failed (exit 5)', 'Fix: Run in a terminal: aquaman service install',
      ]);
    });

    it('a dry run: the unit text, the commands, and that nothing changed', () => {
      expect(renderResult({ status: 'dry_run', unit: '/u.plist', unit_file: '<plist/>\n', commands: ['/bin/launchctl bootstrap gui/501 /u.plist'], log: '/c/daemon.log' })).toEqual([
        'dry_run: /u.plist', '\nUnit file:\n', '<plist/>\n', 'Commands (not run):', '  /bin/launchctl bootstrap gui/501 /u.plist', '\nNothing was changed.',
      ]);
    });

    it('status: installed and current, started by the service', () => {
      expect(renderStatus({
        supported: true, unit: { path: '/u.plist', present: true, current: true }, loaded: true, starts_at_login: true,
        daemon: { reachable: true, pid: 9, managed_by_service: true }, log: '/c/daemon.log',
      })).toEqual([
        'Starts at login: yes',
        '  Unit file:  /u.plist (present)',
        '  Loaded:     yes',
        '  Daemon:     reachable on the socket (started by the service)',
        '  Log:        /c/daemon.log',
      ]);
    });

    it('status: a unit written for other paths, with a step for a person and the settings it does not carry', () => {
      expect(renderStatus({
        supported: true, unit: { path: '/u.service', present: true, current: false }, loaded: false, starts_at_login: false,
        daemon: { reachable: false, pid: null, managed_by_service: false }, log: 'journalctl --user -u aquaman.service',
        human_steps: ['loginctl enable-linger ada'], env_not_passed: ['VAULT_TOKEN'],
      })).toEqual([
        'Starts at login: no',
        '  Unit file:  /u.service (present, differs from what install would write now)',
        '  Loaded:     no',
        '  Daemon:     not reachable on the socket',
        '  Log:        journalctl --user -u aquaman.service',
        '  Not carried into the service (set only in this shell\'s environment): VAULT_TOKEN',
        '  A person needs to: loginctl enable-linger ada',
      ]);
    });

    it('status on a platform with no login item says why', () => {
      expect(renderStatus({ supported: false, reason: 'aquaman has no login item for win32', starts_at_login: false })).toEqual([
        'Starts at login: no (aquaman has no login item for win32)',
      ]);
    });
  });
});
