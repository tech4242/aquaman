/**
 * The login item for the daemon (`packages/proxy/src/service-unit.ts`): the
 * text of the launchd agent and the systemd unit, and the installer.
 *
 * No system tool runs here. The installer takes its command runner, its home
 * directory and its daemon controls as parameters, so both platforms are
 * exercised on whatever machine runs the test: the runner below is a small
 * model of launchd or of systemd's user manager that records every call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildLaunchdPlist, buildSystemdUnit, unitPathEnv, unitEnvironment, unitFilePath, loginItemStep, terminalQuestion,
  installService, uninstallService, serviceStatus, ServiceError,
  LAUNCHD_LABEL, SYSTEMD_UNIT,
  type Consent, type ServiceDeps, type CommandResult,
} from '../../packages/proxy/src/service-unit.js';

const NODE = '/opt/node/bin/node';
const CLI = '/opt/aquaman/dist/cli/index.js';

describe('unit text', () => {
  const spec = { nodePath: NODE, cliPath: CLI, configDir: '/Users/a/.aquaman' };

  it('launchd agent: label, the three arguments, start at load, restart unless it exits cleanly, log in the config directory', () => {
    expect(buildLaunchdPlist(spec)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.aquaman.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>/opt/aquaman/dist/cli/index.js</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/a/.aquaman/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/a/.aquaman/daemon.log</string>
</dict>
</plist>
`);
  });

  it('systemd unit: simple service, restart on failure, wanted by the default target', () => {
    expect(buildSystemdUnit(spec)).toBe(`[Unit]
Description=aquaman credential proxy daemon

[Service]
Type=simple
ExecStart="/opt/node/bin/node" "/opt/aquaman/dist/cli/index.js" daemon
Restart=on-failure
Environment="PATH=/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
`);
  });

  it('writes AQUAMAN_CONFIG_DIR only when the installing command had one', () => {
    const withDir = { ...spec, configDirEnv: '/srv/aq' };
    expect(unitEnvironment(spec)).toEqual({ PATH: '/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' });
    expect(unitEnvironment(withDir)).toEqual({ PATH: '/opt/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', AQUAMAN_CONFIG_DIR: '/srv/aq' });
    expect(buildLaunchdPlist(withDir)).toContain('    <key>AQUAMAN_CONFIG_DIR</key>\n    <string>/srv/aq</string>');
    expect(buildSystemdUnit(withDir)).toContain('Environment="AQUAMAN_CONFIG_DIR=/srv/aq"');
    expect(buildSystemdUnit(spec)).not.toContain('AQUAMAN_CONFIG_DIR');
  });

  it('PATH starts with Node\'s directory and does not repeat a tool directory', () => {
    expect(unitPathEnv('/usr/local/bin/node')).toBe('/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
    expect(unitPathEnv('/home/u/.nvm/v24/bin/node')).toBe('/home/u/.nvm/v24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');
  });

  const awkward = '/Users/a b/R&D <x>/it\'s "node"/50%/$HOME/back\\slash';

  it('launchd agent: a path with spaces, &, <, > and quotes is escaped, one string per argument', () => {
    const plist = buildLaunchdPlist({ nodePath: `${awkward}/node`, cliPath: `${awkward}/cli.js`, configDir: awkward, configDirEnv: awkward });
    const escaped = '/Users/a b/R&amp;D &lt;x&gt;/it&apos;s &quot;node&quot;/50%/$HOME/back\\slash';
    expect(plist).toContain(`    <string>${escaped}/node</string>\n    <string>${escaped}/cli.js</string>\n    <string>daemon</string>`);
    expect(plist).toContain(`<string>${escaped}/daemon.log</string>`);
    expect(plist).toContain(`<key>AQUAMAN_CONFIG_DIR</key>\n    <string>${escaped}</string>`);
    expect(plist).toContain(`<string>${escaped}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>`);
    // Nothing of the path is left as markup.
    expect(plist).not.toContain('<x>');
    expect(plist.match(/<string>/g)!.length).toBe(plist.match(/<\/string>/g)!.length);
  });

  it('systemd unit: quotes and backslashes are escaped, % is doubled, and $ is doubled on the command line only', () => {
    const unit = buildSystemdUnit({ nodePath: `${awkward}/node`, cliPath: `${awkward}/cli.js`, configDir: awkward, configDirEnv: awkward });
    const exec = '/Users/a b/R&D <x>/it\'s \\"node\\"/50%%/$$HOME/back\\\\slash';
    const envValue = '/Users/a b/R&D <x>/it\'s \\"node\\"/50%%/$HOME/back\\\\slash';
    expect(unit).toContain(`ExecStart="${exec}/node" "${exec}/cli.js" daemon\n`);
    expect(unit).toContain(`Environment="AQUAMAN_CONFIG_DIR=${envValue}"\n`);
    expect(unit).toContain(`Environment="PATH=${envValue}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"\n`);
  });

  it.each([
    ['a newline in the Node path', { nodePath: '/opt/no\nde/node', cliPath: CLI, configDir: '/c' }],
    ['a newline in the CLI path', { nodePath: NODE, cliPath: '/opt/aq\n[Service]\nExecStart=/bin/evil/cli.js', configDir: '/c' }],
    ['a carriage return in the config directory', { nodePath: NODE, cliPath: CLI, configDir: '/c', configDirEnv: '/c\rx' }],
    ['a NUL in the CLI path', { nodePath: NODE, cliPath: '/opt/a\0q/cli.js', configDir: '/c' }],
    ['a bidirectional override in the Node path', { nodePath: '/opt/\u202Eedon/node', cliPath: CLI, configDir: '/c' }],
    ['a Unicode line separator in the CLI path', { nodePath: NODE, cliPath: '/opt/a\u2028q/cli.js', configDir: '/c' }],
    ['a relative Node path', { nodePath: 'node', cliPath: CLI, configDir: '/c' }],
    ['a relative CLI path', { nodePath: NODE, cliPath: 'dist/cli/index.js', configDir: '/c' }],
    ['a relative AQUAMAN_CONFIG_DIR', { nodePath: NODE, cliPath: CLI, configDir: '/c', configDirEnv: 'aq' }],
    ['a colon in Node\'s directory, which a PATH cannot hold', { nodePath: '/opt/a:b/node', cliPath: CLI, configDir: '/c' }],
  ])('refuses %s, for both unit formats, with something to do about it', (_name, bad) => {
    for (const build of [buildLaunchdPlist, buildSystemdUnit]) {
      let thrown: unknown;
      try { build(bad); } catch (err) { thrown = err; }
      expect(thrown).toBeInstanceOf(ServiceError);
      expect((thrown as ServiceError).fix).toMatch(/Install Node|Run the installed aquaman/);
    }
  });

  it('refuses a control character in the log path of the launchd agent', () => {
    expect(() => buildLaunchdPlist({ nodePath: NODE, cliPath: CLI, configDir: '/c\n/d' })).toThrow(ServiceError);
  });

  it('knows where each platform keeps the unit, and that other platforms have none', () => {
    expect(unitFilePath('darwin', '/Users/a')).toBe('/Users/a/Library/LaunchAgents/sh.aquaman.daemon.plist');
    expect(unitFilePath('linux', '/home/a')).toBe('/home/a/.config/systemd/user/aquaman.service');
    expect(unitFilePath('win32', 'C:\\Users\\a')).toBeNull();
  });

  it('the terminal question says what will happen, where, and how to undo it', () => {
    expect(terminalQuestion('/h/unit.plist')).toBe(
      'aquaman will start at every login and keep running in the background.\n' +
      '  Unit file: /h/unit.plist\n' +
      '  Remove it later with: aquaman service uninstall\n' +
      'Install it? [y/N] ',
    );
  });

  it.each([
    ['darwin', ['keychain', 'keychain'], false, true],
    ['linux', ['systemd-creds', 'systemd-creds'], false, true],
    ['darwin', ['keychain', 'keychain'], true, false],
    // Either backend may be the one the daemon ends up with; `install` refuses this one, so the step would lead nowhere.
    ['darwin', ['keychain', 'encrypted-file'], false, false],
    ['linux', ['encrypted-file', 'keychain'], false, false],
    ['win32', ['keychain', 'keychain'], false, false],
  ] as const)('step for a person on %s with backends %j, unit present %s: %s', (platform, backends, present, expected) => {
    const step = loginItemStep(platform, [...backends], present);
    if (expected) expect(step).toContain('aquaman service install');
    else expect(step).toBeNull();
  });
});

// ---------------------------------------------------------------------------

/**
 * Every value here is a secret or an env-only setting the daemon reads; none may reach a unit file or a result.
 * The values are markers, not valid settings: the installer never interprets them.
 */
const ENV_ONLY = {
  AQUAMAN_ENCRYPTION_PASSWORD: 'SECRET-encryption-password-value',
  AQUAMAN_KEEPASS_PASSWORD: 'SECRET-keepass-password-value',
  AQUAMAN_LOOPBACK_TOKEN: 'aqm_lb_SECRET-loopback-token',
  AQUAMAN_LOOPBACK_ENABLED: 'SECRET-lb-enabled',
  AQUAMAN_LOOPBACK_PORT: 'SECRET-18585',
  AQUAMAN_BACKEND: 'SECRET-backend',
  AQUAMAN_SERVICES: 'SECRET-services-list',
  AQUAMAN_AUDIT_ENABLED: 'SECRET-audit',
  AQUAMAN_CACHE_TTL: 'SECRET-ttl',
  AQUAMAN_BROKER_ENABLED: 'SECRET-broker',
  AQUAMAN_OPENSHELL_DRIVER: 'SECRET-driver',
  AQUAMAN_BITWARDEN_FOLDER: 'SECRET-bw-folder',
  AQUAMAN_BITWARDEN_ORGANIZATION_ID: 'SECRET-bw-org',
  AQUAMAN_BITWARDEN_COLLECTION_ID: 'SECRET-bw-collection',
  AQUAMAN_KEEPER_FOLDER_UID: 'SECRET-keeper-folder',
  AQUAMAN_KEEPER_CONFIG: '/SECRET/keeper/config.json',
  VAULT_ADDR: 'https://SECRET-vault.example',
  VAULT_TOKEN: 'hvs.SECRET-vault-token',
  VAULT_NAMESPACE: 'SECRET-namespace',
  BW_SESSION: 'SECRET-bw-session',
  OP_SERVICE_ACCOUNT_TOKEN: 'ops_SECRET-service-account',
  OP_CONNECT_HOST: 'https://SECRET-connect.example',
  OP_CONNECT_TOKEN: 'SECRET-connect-token',
  ANTHROPIC_API_KEY: 'sk-ant-SECRET',
  OPENAI_API_KEY: 'sk-SECRET-openai',
  GITHUB_TOKEN: 'ghp_SECRET',
};

interface World {
  deps: ServiceDeps;
  root: string;
  home: string;
  configDir: string;
  unitPath: string;
  /** Every tool call, as one string. */
  calls: string[];
  envs: Array<Record<string, string>>;
  /** The service manager's view. */
  svc: { loaded: boolean; enabled: boolean; pid: number | null };
  /** What is on the socket. */
  socket: { reachable: boolean; pid: number | null };
  pidFile: number | null;
  alive: Set<number>;
  signalled: number[];
  cleaned: number;
  consents: number;
  /** Tool subcommands that fail, with what they print. */
  failing: Map<string, string>;
  answer: Consent;
  /** Whether the service's daemon comes up after a load. */
  daemonStarts: boolean;
  /** Whether a signalled process exits. */
  obeysSignal: boolean;
  onConsent?: () => void;
}

const SERVICE_PID = 4242;

function world(platform: 'darwin' | 'linux', overrides: Partial<ServiceDeps> = {}): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqsvc-')));
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'aq');
  fs.mkdirSync(home);
  if (platform === 'linux') fs.mkdirSync(path.join(root, 'usr/bin'), { recursive: true }), fs.writeFileSync(path.join(root, 'usr/bin/systemctl'), '');
  const w: World = {
    root, home, configDir,
    unitPath: unitFilePath(platform, home)!,
    calls: [], envs: [],
    svc: { loaded: false, enabled: false, pid: null },
    socket: { reachable: false, pid: null },
    pidFile: null,
    alive: new Set(),
    signalled: [],
    cleaned: 0,
    consents: 0,
    failing: new Map(),
    answer: { outcome: 'approved' },
    daemonStarts: true,
    obeysSignal: true,
    deps: undefined as unknown as ServiceDeps,
  };
  const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
  const started = () => {
    w.svc.loaded = true;
    w.svc.enabled = true;
    if (w.daemonStarts) { w.svc.pid = SERVICE_PID; w.socket = { reachable: true, pid: SERVICE_PID }; }
  };
  const stoppedService = () => {
    if (w.socket.pid === w.svc.pid && w.svc.pid !== null) w.socket = { reachable: false, pid: null };
    w.svc = { loaded: false, enabled: false, pid: null };
  };
  const launchctl = (args: string[]): CommandResult => {
    const failing = w.failing.get(args[0]);
    if (failing !== undefined) return { code: 5, stdout: '', stderr: failing };
    if (args[0] === 'print') {
      return w.svc.loaded
        ? ok(`gui/501/${LAUNCHD_LABEL} = {\n\tactive count = 1\n\tstate = running\n${w.svc.pid ? `\tpid = ${w.svc.pid}\n` : ''}}\n`)
        : { code: 113, stdout: '', stderr: 'Bad request.\nCould not find service "sh.aquaman.daemon" in domain for user gui: 501' };
    }
    if (args[0] === 'bootstrap') { started(); return ok(); }
    if (args[0] === 'bootout') { stoppedService(); return ok(); }
    throw new Error(`unexpected launchctl ${args.join(' ')}`);
  };
  const systemctl = (args: string[]): CommandResult => {
    expect(args[0]).toBe('--user');
    const sub = args[1];
    const failing = w.failing.get(sub);
    if (failing !== undefined) return { code: 1, stdout: '', stderr: failing };
    if (sub === 'is-enabled') return w.svc.enabled ? ok('enabled\n') : { code: 1, stdout: 'disabled\n', stderr: '' };
    if (sub === 'show') return ok(`${w.svc.pid ?? 0}\n`);
    if (sub === 'daemon-reload') return ok();
    if (sub === 'enable') { started(); return ok(); }
    if (sub === 'disable') { stoppedService(); return ok(); }
    throw new Error(`unexpected systemctl ${args.join(' ')}`);
  };
  w.deps = {
    platform,
    uid: 501,
    username: 'ada',
    home,
    root,
    configDir,
    env: { ...ENV_ONLY, HOME: home, XDG_RUNTIME_DIR: '/run/user/501', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' },
    nodePath: NODE,
    cliPath: CLI,
    backends: ['keychain', 'keychain'],
    run: async (binary, args, env) => {
      w.calls.push([binary, ...args].join(' '));
      w.envs.push(env);
      if (binary === '/bin/launchctl' && platform === 'darwin') return launchctl(args);
      if (binary === '/usr/bin/systemctl' && platform === 'linux') return systemctl(args);
      throw new Error(`unexpected tool ${binary}`);
    },
    sleep: async () => {},
    daemon: {
      health: async () => ({ ...w.socket }),
      pidFile: () => w.pidFile,
      isRunning: (pid) => w.alive.has(pid),
      stop: (pid) => {
        w.signalled.push(pid);
        if (w.obeysSignal) { w.alive.delete(pid); if (w.socket.pid === pid) w.socket = { reachable: false, pid: null }; }
      },
      cleanup: () => { w.cleaned++; },
    },
    consent: async () => { w.consents++; w.onConsent?.(); return w.answer; },
    ...overrides,
  };
  return w;
}

/** A daemon somebody started by hand: on the socket, with a pid file that names it. */
function handStarted(w: World, pid = 777): void {
  w.socket = { reachable: true, pid };
  w.pidFile = pid;
  w.alive.add(pid);
}

const mutating = (calls: string[]) => calls.filter((c) => / (bootstrap|bootout|enable|disable|daemon-reload)( |$)/.test(c));
const snapshot = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
};

const PLATFORMS = [
  {
    platform: 'darwin' as const,
    load: ['/bin/launchctl bootstrap gui/501 UNIT'],
    unload: ['/bin/launchctl bootout gui/501/sh.aquaman.daemon'],
    afterRemove: [] as string[],
    loadCommand: 'bootstrap',
    unloadCommand: 'bootout',
    expected: (w: World) => buildLaunchdPlist({ nodePath: NODE, cliPath: CLI, configDir: w.configDir }),
    log: (w: World) => path.join(w.configDir, 'daemon.log'),
  },
  {
    platform: 'linux' as const,
    load: ['/usr/bin/systemctl --user daemon-reload', '/usr/bin/systemctl --user enable --now aquaman.service'],
    unload: ['/usr/bin/systemctl --user disable --now aquaman.service'],
    afterRemove: ['/usr/bin/systemctl --user daemon-reload'],
    loadCommand: 'enable',
    unloadCommand: 'disable',
    expected: (w: World) => buildSystemdUnit({ nodePath: NODE, cliPath: CLI, configDir: w.configDir }),
    log: () => 'journalctl --user -u aquaman.service',
  },
];

describe.each(PLATFORMS)('installer on $platform', (p) => {
  let w: World;
  const cmds = (list: string[]) => list.map((c) => c.replace('UNIT', w.unitPath));
  beforeEach(() => { w = world(p.platform); });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  it('installs after a yes: writes the unit, loads it, and reports the daemon running', async () => {
    const before = snapshot(w.home);
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(0);
    expect(r.result).toMatchObject({ status: 'installed', platform: p.platform, unit: w.unitPath, daemon: { running: true }, log: p.log(w) });
    expect(r.result['warning']).toBeUndefined();
    expect((r.result['daemon'] as any).replaced).toBeUndefined();
    expect(w.consents).toBe(1);
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toBe(p.expected(w));
    expect(fs.statSync(w.unitPath).mode & 0o022).toBe(0);
    expect(mutating(w.calls)).toEqual(cmds(p.load));
    expect(w.signalled).toEqual([]);
    // Nothing else appeared under the home directory: the unit and its parents only.
    expect(snapshot(w.home).filter((f) => !before.includes(f) && !w.unitPath.includes(f))).toEqual([]);
    expect(snapshot(path.dirname(w.unitPath))).toEqual([path.basename(w.unitPath)]);
  });

  it('runs the tool by absolute path with a fixed environment that holds nothing of the caller\'s but the session address', async () => {
    await installService(w.deps);
    expect(w.calls.every((c) => c.startsWith(p.platform === 'darwin' ? '/bin/launchctl ' : '/usr/bin/systemctl --user '))).toBe(true);
    const expectedEnv = p.platform === 'darwin'
      ? { PATH: '/usr/bin:/bin' }
      : { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/501', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' };
    for (const env of w.envs) expect(env).toEqual(expectedEnv);
  });

  it('is safe to repeat: the same unit, loaded, is reported as already installed and nobody is asked', async () => {
    await installService(w.deps);
    const calls = w.calls.length;
    const again = await installService(w.deps);
    expect(again).toMatchObject({ exitCode: 0, result: { status: 'already_installed', unit: w.unitPath, log: p.log(w) } });
    expect(w.consents).toBe(1);
    expect(mutating(w.calls.slice(calls))).toEqual([]);
  });

  it('a unit that differs is unloaded, rewritten and loaded again, after a yes', async () => {
    await installService(w.deps);
    const calls = w.calls.length;
    w.deps.nodePath = '/opt/node-25/bin/node';
    const r = await installService(w.deps);
    expect(r).toMatchObject({ exitCode: 0, result: { status: 'installed', daemon: { running: true } } });
    expect(w.consents).toBe(2);
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toContain('/opt/node-25/bin/node');
    expect(mutating(w.calls.slice(calls))).toEqual(cmds([...p.unload, ...p.load]));
    // The daemon on the socket was the service's own: it went with the unload, and nothing was signalled.
    expect(w.signalled).toEqual([]);
    expect((r.result['daemon'] as any).replaced).toBeUndefined();
  });

  it('the same unit on disk but not loaded is loaded again, after a yes', async () => {
    await installService(w.deps);
    w.svc = { loaded: false, enabled: false, pid: null };
    w.socket = { reachable: false, pid: null };
    const calls = w.calls.length;
    const r = await installService(w.deps);
    expect(r.result['status']).toBe('installed');
    expect(w.consents).toBe(2);
    expect(mutating(w.calls.slice(calls))).toEqual(cmds(p.load));
  });

  it.each([
    ['declined', { outcome: 'declined', reason: 'the person at the dialog said no' }, 2],
    ['pending', { outcome: 'pending', reason: 'nobody answered the dialog' }, 3],
    ['error', { outcome: 'error', error: 'Approval dialogs are disabled on this proxy', code: 'broker_disabled', fix: 'Run in a terminal: aquaman service install' }, 4],
    ['error', { outcome: 'error', error: 'timed out waiting for the proxy', code: 'proxy_error' }, 4],
  ] as const)('without a yes (%s) nothing is written, loaded or stopped', async (status, answer, exitCode) => {
    handStarted(w);
    w.answer = answer as Consent;
    const before = snapshot(w.root);
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(exitCode);
    expect(r.result['status']).toBe(status);
    expect(snapshot(w.root)).toEqual(before);
    expect(fs.existsSync(w.unitPath)).toBe(false);
    expect(w.calls).toEqual([]);
    expect(w.signalled).toEqual([]);
    expect(w.cleaned).toBe(0);
    if (status === 'declined') {
      // A way around the person's no is not handed back.
      expect(r.result['fix']).toBeUndefined();
      expect(r.result['reason']).toBe('the person at the dialog said no');
    } else {
      expect(r.result['fix']).toBe('Run in a terminal: aquaman service install');
    }
  });

  it('a no to a changed unit leaves the installed one loaded and untouched', async () => {
    await installService(w.deps);
    const text = fs.readFileSync(w.unitPath, 'utf-8');
    const calls = w.calls.length;
    w.deps.cliPath = '/somewhere/else/cli.js';
    w.answer = { outcome: 'declined', reason: 'answered no at the terminal' };
    const r = await installService(w.deps);
    expect(r).toMatchObject({ exitCode: 2, result: { status: 'declined' } });
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toBe(text);
    expect(mutating(w.calls.slice(calls))).toEqual([]);
    expect(w.svc.loaded).toBe(true);
  });

  it('refuses the encrypted-file backend before asking anyone, whichever of the two backends it is', async () => {
    for (const backends of [['encrypted-file', 'encrypted-file'], ['keychain', 'encrypted-file'], ['encrypted-file', 'keychain']]) {
      w.deps.backends = backends;
      for (const dryRun of [false, true]) {
        const r = await installService(w.deps, { dryRun });
        expect(r.exitCode).toBe(1);
        expect(r.result).toMatchObject({ status: 'error', unit: w.unitPath });
        expect(r.result['error']).toContain('AQUAMAN_ENCRYPTION_PASSWORD');
        expect(r.result['error']).toContain('storing it on disk');
        expect(r.result['fix']).toMatch(/keychain.*systemd-creds.*aquaman daemon/);
      }
    }
    expect(w.consents).toBe(0);
    expect(w.calls).toEqual([]);
    expect(fs.existsSync(w.unitPath)).toBe(false);
  });

  it('--dry-run prints the unit and the commands, asks nobody, runs nothing and writes nothing', async () => {
    handStarted(w);
    const before = snapshot(w.root);
    const r = await installService(w.deps, { dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.result).toMatchObject({
      status: 'dry_run',
      unit: w.unitPath,
      unit_file: p.expected(w),
      commands: cmds(p.load),
      log: p.log(w),
    });
    expect(w.consents).toBe(0);
    expect(w.calls).toEqual([]);
    expect(w.signalled).toEqual([]);
    expect(snapshot(w.root)).toEqual(before);
  });

  it('stops a daemon started by hand, once the answer is yes, so the service can bind the socket', async () => {
    handStarted(w, 777);
    const r = await installService(w.deps);
    expect(r).toMatchObject({ exitCode: 0, result: { status: 'installed', daemon: { running: true, replaced: true } } });
    expect(w.signalled).toEqual([777]);
    expect(w.cleaned).toBe(1);
    // Stopped before the unit is loaded, and only after the unit file was written.
    expect(w.socket).toEqual({ reachable: true, pid: SERVICE_PID });
  });

  it.each([
    ['no pid file', (x: World) => { x.socket = { reachable: true, pid: 900 }; x.alive.add(900); }],
    ['a pid file that names another process', (x: World) => { x.socket = { reachable: true, pid: 900 }; x.pidFile = 901; x.alive.add(900); x.alive.add(901); }],
    ['a proxy that reports no pid', (x: World) => { x.socket = { reachable: true, pid: null }; x.pidFile = 901; x.alive.add(901); }],
    ['a pid file whose process is gone', (x: World) => { x.socket = { reachable: true, pid: 900 }; x.pidFile = 900; }],
  ])('refuses, before asking, when the proxy on the socket is not one it may signal: %s', async (_name, arrange) => {
    arrange(w);
    const before = snapshot(w.root);
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result).toMatchObject({ status: 'error', error: expect.stringContaining('cannot stop'), fix: expect.stringContaining('aquaman stop') });
    expect(w.consents).toBe(0);
    expect(w.signalled).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(snapshot(w.root)).toEqual(before);
  });

  it('checks the proxy on the socket again after the answer: one that appeared meanwhile is not signalled and the unit file is taken back', async () => {
    w.onConsent = () => { w.socket = { reachable: true, pid: 900 }; w.alive.add(900); };
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result['error']).toContain('cannot stop');
    expect(w.signalled).toEqual([]);
    expect(fs.existsSync(w.unitPath)).toBe(false);
    expect(mutating(w.calls)).toEqual(cmds(p.afterRemove));
  });

  it('a daemon that does not stop: the unit file is taken back and the error says what to run', async () => {
    handStarted(w, 777);
    w.obeysSignal = false;
    const r = await installService(w.deps);
    expect(r).toMatchObject({ exitCode: 1, result: { status: 'error', error: expect.stringContaining('did not stop'), fix: 'Run: aquaman stop, then this command again' } });
    expect(w.signalled).toEqual([777]);
    expect(w.cleaned).toBe(0);
    expect(fs.existsSync(w.unitPath)).toBe(false);
    expect(w.svc.loaded).toBe(false);
  });

  it('the tool failing on a first install leaves no unit file, and the error carries a fix', async () => {
    w.failing.set(p.loadCommand, 'Bootstrap failed: 5: Input/output error');
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result['status']).toBe('error');
    expect(r.result['error']).toContain('Bootstrap failed: 5: Input/output error');
    expect(r.result['error']).toMatch(/\(exit \d\)/);
    expect(r.result['fix']).toContain('aquaman service install');
    expect(r.result['fix']).not.toContain('has been stopped');
    expect(fs.existsSync(w.unitPath)).toBe(false);
    expect(snapshot(path.dirname(w.unitPath))).toEqual([]);
    expect(w.svc.loaded).toBe(false);
  });

  it('the tool failing after a hand-started daemon was stopped says so, and how to start one meanwhile', async () => {
    handStarted(w, 777);
    w.failing.set(p.loadCommand, 'nope');
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result['fix']).toContain('The daemon that was running has been stopped; start it by hand meanwhile: aquaman daemon');
    expect(fs.existsSync(w.unitPath)).toBe(false);
  });

  it('the tool failing on a changed unit puts the previous file back and loads it again', async () => {
    await installService(w.deps);
    const previous = fs.readFileSync(w.unitPath, 'utf-8');
    w.deps.nodePath = '/opt/node-25/bin/node';
    let loads = 0;
    const run = w.deps.run;
    // The load of the changed unit fails; the load that restores the previous one works.
    w.deps.run = async (binary, args, env) => {
      if (args.includes(p.loadCommand) && ++loads === 1) {
        w.calls.push([binary, ...args].join(' '));
        return { code: 1, stdout: 'refused on stdout', stderr: '' };
      }
      return run(binary, args, env);
    };
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result['error']).toContain('refused on stdout');
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toBe(previous);
    expect(w.svc.loaded).toBe(true);
    expect(loads).toBe(2);
    expect(snapshot(path.dirname(w.unitPath))).toEqual([path.basename(w.unitPath)]);
  });

  it('an installed unit that cannot be unloaded is left as it is', async () => {
    await installService(w.deps);
    const previous = fs.readFileSync(w.unitPath, 'utf-8');
    w.deps.nodePath = '/opt/node-25/bin/node';
    w.failing.set(p.unloadCommand, 'Operation not permitted');
    const r = await installService(w.deps);
    expect(r).toMatchObject({ exitCode: 1, result: { status: 'error', fix: 'Run: aquaman service uninstall, then: aquaman service install' } });
    expect(r.result['error']).toContain('Operation not permitted');
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toBe(previous);
    expect(w.svc.loaded).toBe(true);
  });

  it('a unit directory that cannot be written: an error with a fix, nothing loaded, nothing stopped', async () => {
    handStarted(w, 777);
    // A file where a directory has to be.
    const blocker = path.join(w.home, p.platform === 'darwin' ? 'Library' : '.config');
    fs.writeFileSync(blocker, '');
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result['error']).toContain('could not be written');
    expect(r.result['fix']).toContain('writable by you');
    expect(mutating(w.calls).filter((c) => !c.endsWith('daemon-reload'))).toEqual([]);
    expect(w.signalled).toEqual([]);
    expect(fs.statSync(blocker).isFile()).toBe(true);
  });

  it('installed but the daemon does not come up: says so and where to look', async () => {
    w.daemonStarts = false;
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(0);
    expect(r.result).toMatchObject({ status: 'installed', daemon: { running: false } });
    expect(r.result['warning']).toContain(p.log(w));
  });

  it('uninstall unloads the service and deletes the file; a second run finds nothing to do', async () => {
    await installService(w.deps);
    const calls = w.calls.length;
    const r = await uninstallService(w.deps);
    expect(r).toMatchObject({ exitCode: 0, result: { status: 'uninstalled', unit: w.unitPath, note: expect.stringContaining('aquaman daemon') } });
    expect(fs.existsSync(w.unitPath)).toBe(false);
    expect(mutating(w.calls.slice(calls))).toEqual(cmds([...p.unload, ...p.afterRemove]));
    expect(w.svc.loaded).toBe(false);
    expect(w.consents).toBe(1);

    const total = w.calls.length;
    expect(await uninstallService(w.deps)).toMatchObject({ exitCode: 0, result: { status: 'not_installed', unit: w.unitPath } });
    // No unit file, so the service manager is not asked anything.
    expect(w.calls.length).toBe(total);
  });

  it('uninstall deletes a unit file that is not loaded without unloading anything', async () => {
    await installService(w.deps);
    w.svc = { loaded: false, enabled: false, pid: null };
    const calls = w.calls.length;
    expect((await uninstallService(w.deps)).result['status']).toBe('uninstalled');
    expect(mutating(w.calls.slice(calls))).toEqual(cmds(p.afterRemove));
    expect(fs.existsSync(w.unitPath)).toBe(false);
  });

  it('uninstall keeps the file when the service cannot be unloaded', async () => {
    await installService(w.deps);
    w.failing.set(p.unloadCommand, 'Operation not permitted');
    const r = await uninstallService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result).toMatchObject({ status: 'error', fix: expect.stringContaining('again') });
    expect(r.result['error']).toContain('Operation not permitted');
    expect(fs.existsSync(w.unitPath)).toBe(true);
  });

  it('status: nothing installed, and no question to the service manager', async () => {
    const r = await serviceStatus(w.deps);
    expect(r).toEqual({
      exitCode: 0,
      result: {
        supported: true,
        platform: p.platform,
        unit: { path: w.unitPath, present: false, current: null },
        loaded: false,
        starts_at_login: false,
        daemon: { reachable: false, pid: null, managed_by_service: false },
        log: p.log(w),
      },
    });
    expect(w.calls).toEqual([]);
  });

  it('status: installed, loaded, and the daemon on the socket is the service\'s', async () => {
    await installService(w.deps);
    expect((await serviceStatus(w.deps)).result).toMatchObject({
      unit: { path: w.unitPath, present: true, current: true },
      loaded: true,
      starts_at_login: true,
      daemon: { reachable: true, pid: SERVICE_PID, managed_by_service: true },
    });
  });

  it('status: a hand-started daemon is not the service\'s, and a unit written for other paths is not current', async () => {
    handStarted(w, 777);
    expect((await serviceStatus(w.deps)).result).toMatchObject({ starts_at_login: false, daemon: { reachable: true, pid: 777, managed_by_service: false } });

    w.socket = { reachable: false, pid: null };
    await installService(w.deps);
    w.socket = { reachable: true, pid: 777 };
    w.deps.nodePath = '/opt/node-25/bin/node';
    expect((await serviceStatus(w.deps)).result).toMatchObject({
      unit: { present: true, current: false },
      loaded: true,
      starts_at_login: true,
      daemon: { reachable: true, pid: 777, managed_by_service: false },
    });
  });

  it('status: a unit file that is not loaded does not start at login', async () => {
    await installService(w.deps);
    w.svc = { loaded: false, enabled: false, pid: null };
    w.socket = { reachable: false, pid: null };
    // This command's own paths cannot go into a unit; the file on disk is still reported.
    w.deps.cliPath = 'relative/cli.js';
    expect((await serviceStatus(w.deps)).result).toMatchObject({
      unit: { present: true, current: false },
      loaded: false,
      starts_at_login: false,
      daemon: { reachable: false, managed_by_service: false },
    });
  });

  it('no secret and no env-only setting reaches the unit file or the answer, only the names of what was not carried over', async () => {
    const dry = await installService(w.deps, { dryRun: true });
    const done = await installService(w.deps);
    const status = await serviceStatus(w.deps);
    const again = await installService(w.deps);
    const written = fs.readFileSync(w.unitPath, 'utf-8');
    const everything = written + JSON.stringify([dry.result, done.result, status.result, again.result]) + fs.readFileSync(w.unitPath, 'utf-8');
    for (const [name, value] of Object.entries(ENV_ONLY)) {
      expect(everything, name).not.toContain(value);
      expect(written, name).not.toContain(name);
    }
    expect(everything).not.toContain('SECRET');
    for (const r of [dry, done, status, again]) {
      expect(r.result['env_not_passed']).toEqual(expect.arrayContaining(['AQUAMAN_ENCRYPTION_PASSWORD', 'VAULT_TOKEN', 'BW_SESSION', 'OP_SERVICE_ACCOUNT_TOKEN', 'AQUAMAN_LOOPBACK_TOKEN', 'AQUAMAN_BACKEND']));
      // Names of aquaman's own settings only: not every variable of the shell.
      expect(r.result['env_not_passed']).not.toContain('GITHUB_TOKEN');
      expect(r.result['env_not_passed']).not.toContain('HOME');
    }
    // The unit's whole environment.
    const keys = p.platform === 'darwin'
      ? [...written.split('<key>EnvironmentVariables</key>')[1].split('</dict>')[0].matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1])
      : [...written.matchAll(/^Environment="([^=]+)=/gm)].map((m) => m[1]);
    expect(keys).toEqual(['PATH']);
  });

  it('writes AQUAMAN_CONFIG_DIR into the unit when the installing command had it, and reports nothing as not carried over when nothing is set', async () => {
    w.deps.env = { AQUAMAN_CONFIG_DIR: w.configDir };
    const r = await installService(w.deps);
    expect(r.result['env_not_passed']).toBeUndefined();
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toContain(w.configDir);
    expect(fs.readFileSync(w.unitPath, 'utf-8')).toContain('AQUAMAN_CONFIG_DIR');
  });

  it('refuses paths that cannot be written into a unit, before asking and before touching anything', async () => {
    w.deps.cliPath = '/opt/aq\nuaman/cli.js';
    for (const dryRun of [false, true]) {
      const r = await installService(w.deps, { dryRun });
      expect(r).toMatchObject({ exitCode: 1, result: { status: 'error', platform: p.platform, fix: expect.stringContaining('ordinary characters') } });
    }
    expect(w.consents).toBe(0);
    expect(w.calls).toEqual([]);
    expect(fs.existsSync(w.unitPath)).toBe(false);
  });
});

describe('installer: macOS only', () => {
  let w: World;
  beforeEach(() => { w = world('darwin'); });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  it('creates the daemon log readable by the user only, and narrows one that was wider', async () => {
    await installService(w.deps);
    const log = path.join(w.configDir, 'daemon.log');
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.statSync(w.configDir).mode & 0o077).toBe(0);

    await uninstallService(w.deps);
    fs.writeFileSync(log, 'earlier output\n');
    fs.chmodSync(log, 0o644);
    await installService(w.deps);
    expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(log, 'utf-8')).toBe('earlier output\n');
  });

  it('waits for launchd to let go of the old job before loading the new one', async () => {
    await installService(w.deps);
    w.deps.nodePath = '/opt/node-25/bin/node';
    const run = w.deps.run;
    let lingering = 3;
    let slept = 0;
    w.deps.sleep = async () => { slept++; };
    w.deps.run = async (binary, args, env) => {
      const r = await run(binary, args, env);
      // After bootout, `print` still finds the job a few times.
      if (args[0] === 'print' && !w.svc.loaded && w.calls.some((c) => c.includes('bootout')) && lingering-- > 0) {
        return { code: 0, stdout: 'state = exited\n', stderr: '' };
      }
      return r;
    };
    const before = slept;
    expect((await installService(w.deps)).result['status']).toBe('installed');
    expect(slept - before).toBeGreaterThanOrEqual(3);
  });

  it('a loaded job with no process is loaded but manages no daemon', async () => {
    w.daemonStarts = false;
    await installService(w.deps);
    handStarted(w, 777);
    expect((await serviceStatus(w.deps)).result).toMatchObject({ loaded: true, daemon: { reachable: true, managed_by_service: false } });
  });

  it('replaces a symlink left at the unit path instead of writing through it', async () => {
    const elsewhere = path.join(w.root, 'elsewhere.txt');
    fs.writeFileSync(elsewhere, 'untouched');
    fs.mkdirSync(path.dirname(w.unitPath), { recursive: true });
    fs.symlinkSync(elsewhere, w.unitPath);
    // The symlink's target is not our unit text, so this is a changed unit that is not loaded.
    const r = await installService(w.deps);
    expect(r.result['status']).toBe('installed');
    expect(fs.readFileSync(elsewhere, 'utf-8')).toBe('untouched');
    expect(fs.lstatSync(w.unitPath).isSymbolicLink()).toBe(false);
  });
});

describe('installer: Linux only', () => {
  let w: World;
  beforeEach(() => { w = world('linux'); });
  afterEach(() => { fs.rmSync(w.root, { recursive: true, force: true }); });

  it('does not enable lingering itself: it reports the command as a step for a person, until lingering is on', async () => {
    const r = await installService(w.deps);
    expect(r.result['human_steps']).toEqual([expect.stringContaining('loginctl enable-linger ada')]);
    expect(w.calls.some((c) => c.includes('loginctl') || c.includes('linger'))).toBe(false);
    expect((await serviceStatus(w.deps)).result['human_steps']).toEqual([expect.stringContaining('loginctl enable-linger ada')]);
    expect((await installService(w.deps, { dryRun: true })).result['human_steps']).toEqual([expect.stringContaining('loginctl enable-linger ada')]);

    fs.mkdirSync(path.join(w.root, 'var/lib/systemd/linger'), { recursive: true });
    fs.writeFileSync(path.join(w.root, 'var/lib/systemd/linger/ada'), '');
    expect((await installService(w.deps)).result).toMatchObject({ status: 'already_installed' });
    expect((await installService(w.deps)).result['human_steps']).toBeUndefined();
    expect((await serviceStatus(w.deps)).result['human_steps']).toBeUndefined();
  });

  it('no user manager to talk to: the fix is the lingering step for a person', async () => {
    w.failing.set('daemon-reload', 'Failed to connect to bus: No medium found');
    const r = await installService(w.deps);
    expect(r.exitCode).toBe(1);
    expect(r.result['error']).toContain('systemctl --user daemon-reload failed (exit 1): Failed to connect to bus');
    expect(r.result['fix']).toBe('systemctl --user needs a login session. On a machine nobody logs in to, a person runs: loginctl enable-linger ada, then: aquaman service install');
    expect(fs.existsSync(w.unitPath)).toBe(false);
  });

  it('enable failing for another reason points at systemd\'s own report', async () => {
    w.failing.set('enable', 'Unit aquaman.service has a bad unit file setting.');
    const r = await installService(w.deps);
    expect(r.result['error']).toContain('systemctl --user enable --now aquaman.service failed');
    expect(r.result['fix']).toContain('systemctl --user status aquaman.service');
    expect(fs.existsSync(w.unitPath)).toBe(false);
  });

  it('a unit that runs without being enabled counts as loaded and is disabled before it is replaced', async () => {
    await installService(w.deps);
    w.svc.enabled = false;
    expect((await serviceStatus(w.deps)).result).toMatchObject({ loaded: true, daemon: { managed_by_service: true } });
    w.deps.nodePath = '/opt/node-25/bin/node';
    const calls = w.calls.length;
    await installService(w.deps);
    expect(mutating(w.calls.slice(calls))[0]).toBe(`/usr/bin/systemctl --user disable --now ${SYSTEMD_UNIT}`);
  });

  it('uses /bin/systemctl where that is the one that exists, and a default runtime directory when the caller has none', async () => {
    fs.rmSync(path.join(w.root, 'usr/bin/systemctl'));
    fs.mkdirSync(path.join(w.root, 'bin'));
    fs.writeFileSync(path.join(w.root, 'bin/systemctl'), '');
    w.deps.env = {};
    const calls: string[] = [];
    const envs: Array<Record<string, string>> = [];
    w.deps.run = async (binary, args, env) => { calls.push([binary, ...args].join(' ')); envs.push(env); return { code: 0, stdout: '0\n', stderr: '' }; };
    await installService(w.deps);
    expect(calls).toContain('/bin/systemctl --user enable --now aquaman.service');
    expect(envs[0]).toEqual({ PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/501' });
  });

  it('refuses a machine without systemctl, for install, uninstall and status alike', async () => {
    fs.rmSync(path.join(w.root, 'usr/bin/systemctl'));
    const install = await installService(w.deps);
    expect(install).toMatchObject({ exitCode: 1, result: { status: 'error', platform: 'linux', error: expect.stringContaining('systemctl was not found'), fix: expect.stringContaining('aquaman daemon') } });
    expect((await uninstallService(w.deps)).exitCode).toBe(1);
    expect((await serviceStatus(w.deps)).result).toMatchObject({ supported: false, starts_at_login: false, reason: expect.stringContaining('systemctl was not found') });
    expect(w.consents).toBe(0);
  });
});

describe('installer: a platform with no login item', () => {
  it('install and uninstall refuse with the by-hand command; status says unsupported and still reports the daemon', async () => {
    const w = world('darwin');
    try {
      w.deps.platform = 'win32';
      handStarted(w, 777);
      const install = await installService(w.deps);
      expect(install).toMatchObject({ exitCode: 1, result: { status: 'error', platform: 'win32', error: expect.stringContaining('no login item for win32'), fix: 'Start the daemon by hand: aquaman daemon' } });
      expect(await uninstallService(w.deps)).toMatchObject({ exitCode: 1, result: { status: 'error', platform: 'win32' } });
      expect(await serviceStatus(w.deps)).toEqual({
        exitCode: 0,
        result: {
          supported: false,
          platform: 'win32',
          reason: expect.stringContaining('no login item for win32'),
          starts_at_login: false,
          daemon: { reachable: true, pid: 777, managed_by_service: false },
        },
      });
      expect(w.consents).toBe(0);
      expect(w.calls).toEqual([]);
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  });

  it('an error that is not a refusal is not swallowed', async () => {
    const w = world('linux');
    try {
      // `root` of the wrong type makes the existence check itself throw.
      (w.deps as any).root = undefined;
      await expect(installService(w.deps)).rejects.toThrow(TypeError);
    } finally {
      fs.rmSync(w.root, { recursive: true, force: true });
    }
  });
});
