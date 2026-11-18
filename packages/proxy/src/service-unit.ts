/**
 * Keeping the daemon running across logins and reboots: a launchd agent on
 * macOS, a systemd user unit on Linux.
 *
 * The unit runs `<node> <aquaman cli> daemon` and nothing else. Its
 * environment is a PATH and, when the installing command had one, the config
 * directory. No secret is written into a unit file: a backend that needs one
 * in the daemon's environment (`encrypted-file`) is refused instead.
 *
 * A login item starts at every login, and the installing command may be run
 * by an agent, so a person says yes first: `consent` is the terminal question
 * or the daemon's dialog, and nothing is stopped or written before it
 * answers `approved`.
 *
 * The system tools are run by absolute path with a fixed environment and an
 * argument array, never through a shell. Everything that touches the machine
 * comes in through `ServiceDeps`, so tests pass a fake runner and a temporary
 * home and never run `launchctl` or `systemctl`.
 *
 * What this is not: a boundary against software running as the same user,
 * which can write a launch agent itself.
 */

import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

export const LAUNCHD_LABEL = 'sh.aquaman.daemon';
export const SYSTEMD_UNIT = 'aquaman.service';

const LAUNCHCTL = '/bin/launchctl';
const SYSTEMCTL_CANDIDATES = ['/usr/bin/systemctl', '/bin/systemctl'];
/** Where vault CLIs (`op`, `bw`, `keeper`) are usually installed. A login item gets no shell PATH. */
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const TOOL_ENV_PATH = '/usr/bin:/bin';
const TOOL_TIMEOUT_MS = 30_000;

/**
 * Settings the daemon reads from its environment only. A login item does not
 * inherit the installing shell, so any of these that are set are reported by
 * name (never by value) as not carried over.
 */
const ENV_ONLY_SETTINGS = [
  'AQUAMAN_BACKEND', 'AQUAMAN_SERVICES', 'AQUAMAN_ENCRYPTION_PASSWORD', 'AQUAMAN_KEEPASS_PASSWORD',
  'AQUAMAN_AUDIT_ENABLED', 'AQUAMAN_CACHE_TTL', 'AQUAMAN_LOOPBACK_ENABLED', 'AQUAMAN_LOOPBACK_PORT',
  'AQUAMAN_LOOPBACK_TOKEN', 'AQUAMAN_BROKER_ENABLED', 'AQUAMAN_OPENSHELL_DRIVER',
  'AQUAMAN_BITWARDEN_FOLDER', 'AQUAMAN_BITWARDEN_ORGANIZATION_ID', 'AQUAMAN_BITWARDEN_COLLECTION_ID',
  'AQUAMAN_KEEPER_FOLDER_UID', 'AQUAMAN_KEEPER_CONFIG',
  'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_NAMESPACE', 'BW_SESSION',
  'OP_SERVICE_ACCOUNT_TOKEN', 'OP_CONNECT_HOST', 'OP_CONNECT_TOKEN',
];

const INSTALL_IN_TERMINAL = 'Run in a terminal: aquaman service install';

/** A refusal a person can act on. */
export class ServiceError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

export interface UnitSpec {
  /** Absolute path of the Node binary the daemon runs under. */
  nodePath: string;
  /** Absolute path of the aquaman CLI entry. */
  cliPath: string;
  /** Where the daemon's log goes (macOS). */
  configDir: string;
  /** `AQUAMAN_CONFIG_DIR` of the installing command, when it had one. */
  configDirEnv?: string;
}

/**
 * A path that goes into a unit file. Control and format characters (a
 * newline, a bidirectional override) cannot be written into a plist or a
 * unit file so that every reader agrees on what they mean, so such a path is
 * refused instead of escaped.
 */
function unitPathValue(label: string, value: string): string {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new ServiceError(
      `${label} contains a control or formatting character, which a unit file cannot hold safely`,
      'Install Node and aquaman under a path made of ordinary characters, then run this command again',
    );
  }
  if (!path.isAbsolute(value)) {
    throw new ServiceError(`${label} is not an absolute path: ${value}`, 'Run the installed aquaman command, not a relative copy of it');
  }
  return value;
}

/** The PATH the daemon gets: Node's own directory first, then the usual tool directories. */
export function unitPathEnv(nodePath: string): string {
  const nodeDir = path.dirname(unitPathValue('The path of the Node binary', nodePath));
  if (nodeDir.includes(':')) {
    throw new ServiceError(
      `The directory of the Node binary contains a colon, which a PATH cannot hold: ${nodeDir}`,
      'Install Node under a path without a colon, then run this command again',
    );
  }
  return [nodeDir, ...TOOL_DIRS.filter((d) => d !== nodeDir)].join(':');
}

/** The whole environment of the unit. Nothing else is ever added to it. */
export function unitEnvironment(spec: UnitSpec): Record<string, string> {
  const env: Record<string, string> = { PATH: unitPathEnv(spec.nodePath) };
  if (spec.configDirEnv) env['AQUAMAN_CONFIG_DIR'] = unitPathValue('AQUAMAN_CONFIG_DIR', spec.configDirEnv);
  return env;
}

export function daemonLogPath(configDir: string): string {
  return path.join(configDir, 'daemon.log');
}

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The launchd agent: started at login, restarted unless it exits cleanly, logging to the config directory. */
export function buildLaunchdPlist(spec: UnitSpec): string {
  const args = [unitPathValue('The path of the Node binary', spec.nodePath), unitPathValue('The path of the aquaman CLI', spec.cliPath), 'daemon'];
  const log = unitPathValue('The path of the daemon log', daemonLogPath(spec.configDir));
  const env = unitEnvironment(spec);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...Object.entries(env).flatMap(([k, v]) => [`    <key>${xml(k)}</key>`, `    <string>${xml(v)}</string>`]),
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/**
 * A path that becomes a word of `ExecStart`. systemd expands `$NAME` in the
 * arguments of a command line and documents `$$` as the way to write a
 * dollar sign there, but the first word, the executable, is not an argument.
 * A path with a dollar sign in it is refused, so the unit never depends on
 * which of the two readings applies to which word.
 */
function systemdCommandPath(label: string, value: string): string {
  const checked = unitPathValue(label, value);
  if (checked.includes('$')) {
    throw new ServiceError(
      `${label} contains a dollar sign, which a systemd command line cannot hold in a way every version reads the same: ${checked}`,
      'Install Node and aquaman under a path without a dollar sign, then run this command again',
    );
  }
  return checked;
}

/** One double-quoted systemd word. `%` starts a specifier everywhere; `$` starts a variable in the arguments of a command line. */
function systemdQuote(text: string, commandLine: boolean): string {
  let out = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (commandLine) out = out.replace(/\$/g, '$$$$');
  return `"${out}"`;
}

/** The systemd user unit: started with the user manager, restarted when it fails. */
export function buildSystemdUnit(spec: UnitSpec): string {
  const node = systemdCommandPath('The path of the Node binary', spec.nodePath);
  const cli = systemdCommandPath('The path of the aquaman CLI', spec.cliPath);
  const env = unitEnvironment(spec);
  return [
    '[Unit]',
    'Description=aquaman credential proxy daemon',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${systemdQuote(node, true)} ${systemdQuote(cli, true)} daemon`,
    'Restart=on-failure',
    ...Object.entries(env).map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`, false)}`),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/**
 * The line `init --agent` adds for a person when nothing starts the daemon
 * at login, or null when there is nothing useful to say: the platform has no
 * unit, one is installed, or the backend is one `install` refuses.
 */
export function loginItemStep(platform: NodeJS.Platform, backends: string[], unitPresent: boolean): string | null {
  if (platform !== 'darwin' && platform !== 'linux') return null;
  if (unitPresent || backends.includes('encrypted-file')) return null;
  return 'run `aquaman service install` in a terminal so the daemon starts at every login; until then it is gone after a reboot';
}

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export type CommandRunner = (binary: string, args: string[], env: Record<string, string>) => Promise<CommandResult>;

/** Runs a system tool: absolute path, argument array, the given environment only, no shell. */
export const runTool: CommandRunner = (binary, args, env) =>
  new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (c: string) => { if (stdout.length <= 65536) stdout += c; });
    child.stderr.setEncoding('utf-8').on('data', (c: string) => { if (stderr.length <= 65536) stderr += c; });
    const guard = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(guard); resolve({ code: null, stdout: '', stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });

/** What the terminal question says. The dialog's wording lives in credential-prompt.ts. */
export function terminalQuestion(unitPath: string): string {
  return [
    'aquaman will start at every login and keep running in the background.',
    `  Unit file: ${unitPath}`,
    '  Remove it later with: aquaman service uninstall',
    'Install it? [y/N] ',
  ].join('\n');
}

/** One y/N question at a terminal. Anything but `y` or `yes`, a closed stdin included, is a no. */
export function askAtTerminal(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, unitPath: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    let answer: string | null = null;
    rl.question(terminalQuestion(unitPath), (line) => { answer = line; rl.close(); });
    rl.on('close', () => resolve(answer !== null && /^y(es)?$/i.test(answer.trim())));
  });
}

export type Consent =
  | { outcome: 'approved' }
  | { outcome: 'declined'; reason: string }
  /** Nobody could be asked: no dialog, no answer, no daemon to show one. */
  | { outcome: 'pending'; reason: string }
  /** The proxy on the socket does not take the question. */
  | { outcome: 'error'; error: string; code?: string; fix?: string };

export interface DaemonControl {
  /** Whether a proxy answers on the socket, and the pid it reports there. */
  health(): Promise<{ reachable: boolean; pid: number | null }>;
  /** The pid in the daemon's pid file. */
  pidFile(): number | null;
  isRunning(pid: number): boolean;
  /** Ask the process to stop (SIGTERM). Throws what `process.kill` throws; `ESRCH` means it is already gone. */
  stop(pid: number): void;
  /** Remove what a stopped daemon may have left: the pid file and the socket. */
  cleanup(): void;
}

export interface ServiceDeps {
  platform: NodeJS.Platform;
  uid: number;
  username: string;
  /** The user's home directory; the unit file lives under it. */
  home: string;
  /** Prefix for the fixed system paths that are only checked for existence (`/` outside tests). */
  root: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  /** The backend in config.yaml and the one in effect for this command; either may be the one the daemon ends up with. */
  backends: string[];
  run: CommandRunner;
  sleep(ms: number): Promise<void>;
  daemon: DaemonControl;
  consent(): Promise<Consent>;
}

export interface ServiceOutcome { result: Record<string, unknown>; exitCode: number }

interface Manager {
  unitPath: string;
  buildUnit(spec: UnitSpec): string;
  /** For `--dry-run`: the commands an install runs, in order. */
  installCommands: string[][];
  query(): Promise<{ loaded: boolean; pid: number | null }>;
  /** Null on success, or what failed. */
  load(): Promise<string | null>;
  unload(): Promise<string | null>;
  /** After the unit file changed without a load (a removal, a rollback). */
  refresh(): Promise<void>;
  /** Things the unit needs on disk before it is loaded. */
  prepare(): void;
  /** What a person does when `load` fails. */
  loadFix(detail: string): string;
  /** Where the service's output goes, as a path or a command. */
  log: string;
}

const lastLine = (text: string): string => text.trim().split('\n').pop()!.slice(0, 300);

function failure(what: string, r: CommandResult): string {
  const detail = lastLine(r.stderr || r.stdout);
  return `${what} failed${r.code === null ? '' : ` (exit ${r.code})`}${detail ? `: ${detail}` : ''}`;
}

function launchdManager(deps: ServiceDeps): Manager {
  const unitPath = unitFilePath('darwin', deps.home)!;
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${LAUNCHD_LABEL}`;
  const env = { PATH: TOOL_ENV_PATH };
  const log = daemonLogPath(deps.configDir);
  const query = async () => {
    const r = await deps.run(LAUNCHCTL, ['print', target], env);
    if (r.code !== 0) return { loaded: false, pid: null };
    const pid = /^\s*pid = (\d+)\s*$/m.exec(r.stdout);
    return { loaded: true, pid: pid ? Number(pid[1]) : null };
  };
  return {
    unitPath,
    buildUnit: buildLaunchdPlist,
    installCommands: [[LAUNCHCTL, 'bootstrap', domain, unitPath]],
    query,
    async load() {
      const r = await deps.run(LAUNCHCTL, ['bootstrap', domain, unitPath], env);
      return r.code === 0 ? null : failure('launchctl bootstrap', r);
    },
    async unload() {
      const r = await deps.run(LAUNCHCTL, ['bootout', target], env);
      if (r.code !== 0) return failure('launchctl bootout', r);
      // launchd removes the job after the process has gone; loading again before that fails.
      for (let i = 0; i < 50 && (await query()).loaded; i++) await deps.sleep(100);
      return null;
    },
    async refresh() { /* launchd reads the file when it is loaded */ },
    prepare() {
      fs.mkdirSync(deps.configDir, { recursive: true, mode: 0o700 });
      // The daemon's output can name services and paths: readable by this user only.
      fs.closeSync(fs.openSync(log, 'a', 0o600));
      fs.chmodSync(log, 0o600);
    },
    loadFix: () => `${INSTALL_IN_TERMINAL}. To see what launchd reports: ${LAUNCHCTL} print ${target}`,
    log,
  };
}

function systemdManager(deps: ServiceDeps): Manager {
  const systemctl = SYSTEMCTL_CANDIDATES.find((p) => fs.existsSync(path.join(deps.root, p)));
  if (!systemctl) {
    throw new ServiceError(
      'systemctl was not found, so there is no systemd user manager to install a unit into',
      'Start the daemon by hand instead: aquaman daemon',
    );
  }
  const unitPath = unitFilePath('linux', deps.home)!;
  // `systemctl --user` finds the user manager through these two; nothing else of the caller's environment reaches it.
  const env: Record<string, string> = { PATH: TOOL_ENV_PATH, XDG_RUNTIME_DIR: deps.env['XDG_RUNTIME_DIR'] || `/run/user/${deps.uid}` };
  if (deps.env['DBUS_SESSION_BUS_ADDRESS']) env['DBUS_SESSION_BUS_ADDRESS'] = deps.env['DBUS_SESSION_BUS_ADDRESS'];
  const sc = (...args: string[]) => deps.run(systemctl, ['--user', ...args], env);
  return {
    unitPath,
    buildUnit: buildSystemdUnit,
    installCommands: [[systemctl, '--user', 'daemon-reload'], [systemctl, '--user', 'enable', '--now', SYSTEMD_UNIT]],
    async query() {
      const enabled = (await sc('is-enabled', SYSTEMD_UNIT)).code === 0;
      const show = await sc('show', SYSTEMD_UNIT, '--property=MainPID', '--value');
      const main = Number(show.stdout.trim());
      const pid = show.code === 0 && Number.isInteger(main) && main > 0 ? main : null;
      return { loaded: enabled || pid !== null, pid };
    },
    async load() {
      const reload = await sc('daemon-reload');
      if (reload.code !== 0) return failure('systemctl --user daemon-reload', reload);
      const enable = await sc('enable', '--now', SYSTEMD_UNIT);
      return enable.code === 0 ? null : failure(`systemctl --user enable --now ${SYSTEMD_UNIT}`, enable);
    },
    async unload() {
      const r = await sc('disable', '--now', SYSTEMD_UNIT);
      return r.code === 0 ? null : failure(`systemctl --user disable --now ${SYSTEMD_UNIT}`, r);
    },
    async refresh() { await sc('daemon-reload'); },
    prepare() { /* the journal takes the output */ },
    loadFix: (detail) => /bus|XDG_RUNTIME_DIR|medium/i.test(detail)
      ? `systemctl --user needs a login session. On a machine nobody logs in to, a person runs: loginctl enable-linger ${deps.username}, then: aquaman service install`
      : `${INSTALL_IN_TERMINAL}. To see what systemd reports: systemctl --user status ${SYSTEMD_UNIT}`,
    log: `journalctl --user -u ${SYSTEMD_UNIT}`,
  };
}

function managerFor(deps: ServiceDeps): Manager {
  if (deps.platform === 'darwin') return launchdManager(deps);
  if (deps.platform === 'linux') return systemdManager(deps);
  throw new ServiceError(
    `aquaman has no login item for ${deps.platform}: it installs a launchd agent on macOS and a systemd user unit on Linux`,
    'Start the daemon by hand: aquaman daemon',
  );
}

/** Where the unit file for this platform lives, or null where there is none. */
export function unitFilePath(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  if (platform === 'linux') return path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);
  return null;
}

const specOf = (deps: ServiceDeps): UnitSpec => ({
  nodePath: deps.nodePath,
  cliPath: deps.cliPath,
  configDir: deps.configDir,
  configDirEnv: deps.env['AQUAMAN_CONFIG_DIR'] || undefined,
});

const readUnit = (file: string): string | null => {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
};

function writeUnit(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written whole and renamed into place, so a loader never reads half a unit
  // and a symlink left at the path is replaced, not followed.
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o644, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** What only a person can do, and what the unit does not carry. Reported with every answer about an installed unit. */
function notes(deps: ServiceDeps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const steps: string[] = [];
  // systemd starts a user's units at boot only if the user lingers; changing that is a person's call.
  if (deps.platform === 'linux' && !fs.existsSync(path.join(deps.root, 'var/lib/systemd/linger', deps.username))) {
    steps.push(`on a machine nobody logs in to, the unit only starts at boot with lingering: loginctl enable-linger ${deps.username}`);
  }
  if (steps.length) out['human_steps'] = steps;
  const notPassed = ENV_ONLY_SETTINGS.filter((name) => deps.env[name]);
  if (notPassed.length) out['env_not_passed'] = notPassed;
  return out;
}

const refused = (err: unknown, platform: string): ServiceOutcome => {
  if (!(err instanceof ServiceError)) throw err;
  return { result: { status: 'error', platform, error: err.message, fix: err.fix }, exitCode: 1 };
};

/**
 * Which process, if any, has to stop so the service's daemon can bind the
 * socket. Only a proxy that reports, over the socket, the pid in the pid
 * file is ever signalled; an OpenClaw-hosted proxy or a recycled pid is not,
 * and is reported as `foreign`.
 */
async function daemonToStop(deps: ServiceDeps, servicePid: number | null): Promise<{ pid: number | null } | 'foreign'> {
  const health = await deps.daemon.health();
  if (!health.reachable) return { pid: null };
  if (servicePid !== null && health.pid === servicePid) return { pid: null };
  const filePid = deps.daemon.pidFile();
  if (filePid !== null && health.pid === filePid && deps.daemon.isRunning(filePid)) return { pid: filePid };
  return 'foreign';
}

const FOREIGN_PROXY = {
  error: 'A proxy is running on the socket that this command cannot stop, so the service could not take its place',
  fix: 'Stop it (aquaman stop, or stop the OpenClaw gateway that started it), then run this command again',
};

/**
 * `aquaman service install`. Every reason to refuse is checked before the
 * question is asked, and nothing is stopped or written before the answer is
 * yes, so a run that ends in an error or a no leaves the machine as it was.
 */
export async function installService(deps: ServiceDeps, opts: { dryRun?: boolean } = {}): Promise<ServiceOutcome> {
  const platform = deps.platform;
  let mgr: Manager;
  let unitText: string;
  try {
    mgr = managerFor(deps);
    unitText = mgr.buildUnit(specOf(deps));
  } catch (err) {
    return refused(err, platform);
  }
  const base = { platform, unit: mgr.unitPath };

  if (deps.backends.includes('encrypted-file')) {
    return {
      result: {
        status: 'error',
        ...base,
        error: 'The encrypted-file backend needs AQUAMAN_ENCRYPTION_PASSWORD in the daemon\'s environment, and a login item can only have it by storing it on disk, which aquaman does not do',
        fix: 'Use a backend that needs no password in the environment (aquaman setup --backend keychain, or systemd-creds on Linux), or keep starting the daemon by hand: aquaman daemon',
      },
      exitCode: 1,
    };
  }

  if (opts.dryRun) {
    return {
      result: {
        status: 'dry_run',
        ...base,
        unit_file: unitText,
        commands: mgr.installCommands.map((c) => c.join(' ')),
        log: mgr.log,
        ...notes(deps),
      },
      exitCode: 0,
    };
  }

  const existing = readUnit(mgr.unitPath);
  // Without a unit file there is nothing of ours to ask the service manager about.
  const before = existing !== null ? await mgr.query() : { loaded: false, pid: null };
  if (existing === unitText && before.loaded) {
    return { result: { status: 'already_installed', ...base, log: mgr.log, ...notes(deps) }, exitCode: 0 };
  }
  if ((await daemonToStop(deps, before.pid)) === 'foreign') {
    return { result: { status: 'error', ...base, ...FOREIGN_PROXY }, exitCode: 1 };
  }

  const consent = await deps.consent();
  if (consent.outcome === 'declined') {
    // No `fix`: the way around a person's no is not handed back.
    return { result: { status: 'declined', ...base, reason: consent.reason }, exitCode: 2 };
  }
  if (consent.outcome === 'pending') {
    return { result: { status: 'pending', ...base, reason: consent.reason, fix: INSTALL_IN_TERMINAL }, exitCode: 3 };
  }
  if (consent.outcome === 'error') {
    return { result: { status: 'error', ...base, error: consent.error, code: consent.code, fix: consent.fix ?? INSTALL_IN_TERMINAL }, exitCode: 4 };
  }

  // From here on the machine changes. `undo` puts the unit file back the way it was found.
  const now = await mgr.query();
  let unloaded = false;
  const undo = async () => {
    try {
      if (existing === null) fs.rmSync(mgr.unitPath, { force: true });
      else writeUnit(mgr.unitPath, existing);
    } catch { /* the directory is not writable; the error being reported says so */ }
    if (existing !== null && unloaded) await mgr.load();
    else await mgr.refresh();
  };
  const fail = (error: string, fix: string): ServiceOutcome => ({ result: { status: 'error', ...base, error, fix }, exitCode: 1 });

  if (now.loaded) {
    const problem = await mgr.unload();
    if (problem) return fail(`The installed unit could not be unloaded: ${problem}`, 'Run: aquaman service uninstall, then: aquaman service install');
    unloaded = true;
  }
  try {
    writeUnit(mgr.unitPath, unitText);
    mgr.prepare();
  } catch (err) {
    await undo();
    return fail(
      `The unit file could not be written: ${err instanceof Error ? err.message : String(err)}`,
      `Check that ${path.dirname(mgr.unitPath)} and ${deps.configDir} are writable by you, then run this command again`,
    );
  }

  // Asked again: the answer above is as old as the dialog was open.
  const target = await daemonToStop(deps, null);
  if (target === 'foreign') {
    await undo();
    return fail(FOREIGN_PROXY.error, FOREIGN_PROXY.fix);
  }
  let stopped = false;
  if (target.pid !== null) {
    try {
      deps.daemon.stop(target.pid);
    } catch (err) {
      // ESRCH: the process exited between the check and the signal. It is
      // stopped, which is what the signal was for.
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        await undo();
        return fail(
          `The running daemon could not be stopped: ${err instanceof Error ? err.message : String(err)}`,
          'Run: aquaman stop, then this command again',
        );
      }
    }
    for (let i = 0; i < 50 && deps.daemon.isRunning(target.pid); i++) await deps.sleep(100);
    if (deps.daemon.isRunning(target.pid)) {
      await undo();
      return fail('The running daemon did not stop, so the service could not take its place', 'Run: aquaman stop, then this command again');
    }
    deps.daemon.cleanup();
    stopped = true;
  }

  const problem = await mgr.load();
  if (problem) {
    await undo();
    return fail(
      `The unit was not installed: ${problem}`,
      `${mgr.loadFix(problem)}${stopped ? '. The daemon that was running has been stopped; start it by hand meanwhile: aquaman daemon' : ''}`,
    );
  }

  let running = false;
  for (let i = 0; i < 40 && !running; i++) {
    await deps.sleep(250);
    running = (await deps.daemon.health()).reachable;
  }
  return {
    result: {
      status: 'installed',
      ...base,
      daemon: { running, ...(stopped ? { replaced: true } : {}) },
      log: mgr.log,
      ...(running ? {} : { warning: `The unit is installed but the daemon does not answer on its socket yet. See: ${mgr.log}` }),
      ...notes(deps),
    },
    exitCode: 0,
  };
}

/** `aquaman service uninstall`: stop the service and delete its unit file. Removing needs nobody's yes. */
export async function uninstallService(deps: ServiceDeps): Promise<ServiceOutcome> {
  let mgr: Manager;
  try {
    mgr = managerFor(deps);
  } catch (err) {
    return refused(err, deps.platform);
  }
  const base = { platform: deps.platform, unit: mgr.unitPath };
  if (readUnit(mgr.unitPath) === null) return { result: { status: 'not_installed', ...base }, exitCode: 0 };
  if ((await mgr.query()).loaded) {
    const problem = await mgr.unload();
    if (problem) {
      return {
        result: { status: 'error', ...base, error: `The unit could not be unloaded, so its file was left in place: ${problem}`, fix: 'Run this command again in a terminal of your own session' },
        exitCode: 1,
      };
    }
  }
  fs.rmSync(mgr.unitPath, { force: true });
  await mgr.refresh();
  return {
    result: { status: 'uninstalled', ...base, note: 'The daemon the service ran has stopped. Start one by hand when needed: aquaman daemon' },
    exitCode: 0,
  };
}

/** `aquaman service status`: what is on disk, what the service manager says, and whose daemon is on the socket. */
export async function serviceStatus(deps: ServiceDeps): Promise<ServiceOutcome> {
  const health = await deps.daemon.health();
  let mgr: Manager;
  try {
    mgr = managerFor(deps);
  } catch (err) {
    const { result } = refused(err, deps.platform);
    return {
      result: { supported: false, platform: deps.platform, reason: result['error'], starts_at_login: false, daemon: { reachable: health.reachable, pid: health.pid, managed_by_service: false } },
      exitCode: 0,
    };
  }
  const existing = readUnit(mgr.unitPath);
  let expected: string | null = null;
  try { expected = mgr.buildUnit(specOf(deps)); } catch { /* this command's own paths cannot be written into a unit */ }
  const state = existing !== null ? await mgr.query() : { loaded: false, pid: null };
  return {
    result: {
      supported: true,
      platform: deps.platform,
      unit: {
        path: mgr.unitPath,
        present: existing !== null,
        // Whether `install` would write the same file today (Node or aquaman may have moved since).
        current: existing === null ? null : existing === expected,
      },
      loaded: state.loaded,
      starts_at_login: existing !== null && state.loaded,
      daemon: {
        reachable: health.reachable,
        pid: health.pid,
        managed_by_service: health.reachable && state.pid !== null && health.pid === state.pid,
      },
      log: mgr.log,
      ...(existing !== null ? notes(deps) : {}),
    },
    exitCode: 0,
  };
}
