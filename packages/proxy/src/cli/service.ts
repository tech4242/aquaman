/**
 * `aquaman service install|uninstall|status`, and the part of
 * `aquaman init --agent` that concerns the login item. The logic is in
 * service-unit.ts; this file connects it to the real machine and prints.
 */

import type { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getConfigDir, loadConfig, loadStoredConfig } from '../core/index.js';
import { clampPromptTimeout, PROMPT_TIMEOUT_SECONDS, PROMPT_TIMEOUT_MIN_SECONDS, PROMPT_TIMEOUT_MAX_SECONDS } from '../credential-prompt.js';
import { SERVICE_CONSENT_PATH } from '../service-consent.js';
import {
  askAtTerminal, installService, uninstallService, serviceStatus, runTool, unitFilePath, loginItemStep,
  type Consent, type ServiceDeps, type ServiceOutcome,
} from '../service-unit.js';

/** The CLI's own socket and pid-file helpers, so the rules for talking to a daemon exist once. */
export interface ServiceCliHelpers {
  /** Absolute path of the CLI entry the unit runs. */
  cliPath: string;
  proxyPost(socketPath: string, urlPath: string, body: Record<string, unknown>, timeoutMs: number):
    Promise<{ status: number; json: any } | { error: string; code: string }>;
  proxyHealthy(socketPath: string): Promise<boolean>;
  proxyPid(socketPath: string): Promise<number | null>;
  readPidFile(): number | null;
  removePidFile(): void;
  isProcessRunning(pid: number): boolean;
}

const INSTALL_IN_TERMINAL = 'Run in a terminal: aquaman service install';

/** The yes from the daemon's dialog, for a command with no terminal. */
async function consentByDialog(helpers: ServiceCliHelpers, socketPath: string, timeoutSeconds: number): Promise<Consent> {
  const response = await helpers.proxyPost(socketPath, SERVICE_CONSENT_PATH, { timeout_seconds: timeoutSeconds }, (timeoutSeconds + 30) * 1000);
  if ('error' in response) {
    // No daemon means nobody to show the dialog: a person's step, not a failure of the command.
    if (response.code === 'proxy_unreachable') return { outcome: 'pending', reason: 'the daemon is not running, so no dialog can be shown' };
    return { outcome: 'error', error: response.error, code: response.code };
  }
  const { status, json } = response;
  if (status !== 200) return { outcome: 'error', error: String(json.error), code: json.code, fix: json.fix };
  if (json.status === 'approved') return { outcome: 'approved' };
  if (json.status === 'declined') return { outcome: 'declined', reason: String(json.reason) };
  return { outcome: 'pending', reason: String(json.reason ?? 'no answer') };
}

/** The installer's view of this machine: the real tools, the real home, the daemon on the real socket. */
export function buildDeps(helpers: ServiceCliHelpers, consent: 'terminal-or-dialog' | 'dialog', timeoutSeconds: number): ServiceDeps {
  const configDir = path.resolve(getConfigDir());
  const socketPath = path.join(configDir, 'proxy.sock');
  const home = os.homedir();
  const atTerminal = consent === 'terminal-or-dialog' && process.stdin.isTTY === true && process.stdout.isTTY === true;
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    username: os.userInfo().username,
    home,
    root: '/',
    configDir,
    // The unit gets the directory as an absolute path, whatever the caller's working directory is.
    env: { ...process.env, ...(process.env['AQUAMAN_CONFIG_DIR'] ? { AQUAMAN_CONFIG_DIR: configDir } : {}) },
    nodePath: process.execPath,
    cliPath: helpers.cliPath,
    backends: [loadStoredConfig().credentials.backend, loadConfig().credentials.backend],
    run: runTool,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    daemon: {
      health: async () => ({ reachable: await helpers.proxyHealthy(socketPath), pid: await helpers.proxyPid(socketPath) }),
      pidFile: helpers.readPidFile,
      isRunning: helpers.isProcessRunning,
      stop: (pid) => { process.kill(pid, 'SIGTERM'); },
      cleanup: () => {
        helpers.removePidFile();
        try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
      },
    },
    consent: async () => {
      if (!atTerminal) return consentByDialog(helpers, socketPath, timeoutSeconds);
      // On stderr, so `--json` still prints one object and nothing else on stdout.
      const yes = await askAtTerminal(process.stdin, process.stderr, unitFilePath(process.platform, home)!);
      return yes ? { outcome: 'approved' } : { outcome: 'declined', reason: 'answered no at the terminal' };
    },
  };
}

/** What `install` and `uninstall` say in words, one line each. */
export function renderResult(result: Record<string, unknown>): string[] {
  const lines = [`${result['status']}${result['unit'] ? `: ${result['unit']}` : ''}${result['reason'] ? ` (${result['reason']})` : ''}`];
  if (result['error']) lines.push(String(result['error']));
  if (result['unit_file']) {
    lines.push('\nUnit file:\n', String(result['unit_file']), 'Commands (not run):');
    for (const c of result['commands'] as string[]) lines.push(`  ${c}`);
    lines.push('\nNothing was changed.');
  }
  if (result['warning']) lines.push(`Warning: ${result['warning']}`);
  if (result['note']) lines.push(String(result['note']));
  if (result['status'] === 'installed' || result['status'] === 'already_installed') {
    lines.push(`Log: ${result['log']}`, 'Remove it with: aquaman service uninstall');
  }
  if (result['env_not_passed']) {
    lines.push(`Not carried into the service (set only in this shell's environment): ${(result['env_not_passed'] as string[]).join(', ')}`);
  }
  for (const step of (result['human_steps'] as string[] | undefined) ?? []) lines.push(`A person needs to: ${step}`);
  if (result['fix']) lines.push(`Fix: ${result['fix']}`);
  return lines;
}

/** What `status` says in words. */
export function renderStatus(r: any): string[] {
  if (!r.supported) return [`Starts at login: no (${r.reason})`];
  const lines = [
    `Starts at login: ${r.starts_at_login ? 'yes' : 'no'}`,
    `  Unit file:  ${r.unit.path} (${r.unit.present ? (r.unit.current ? 'present' : 'present, differs from what install would write now') : 'not present'})`,
    `  Loaded:     ${r.loaded ? 'yes' : 'no'}`,
    `  Daemon:     ${r.daemon.reachable ? `reachable on the socket (${r.daemon.managed_by_service ? 'started by the service' : 'not started by the service'})` : 'not reachable on the socket'}`,
    `  Log:        ${r.log}`,
  ];
  if (r.env_not_passed) lines.push(`  Not carried into the service (set only in this shell's environment): ${r.env_not_passed.join(', ')}`);
  for (const step of r.human_steps ?? []) lines.push(`  A person needs to: ${step}`);
  if (!r.unit.present) lines.push(`  \u2192 ${INSTALL_IN_TERMINAL}`);
  return lines;
}

function print(outcome: ServiceOutcome, json: boolean, render: (result: any) => string[] = renderResult): never {
  if (json) {
    console.log(JSON.stringify(outcome.result, null, 2));
  } else {
    const stream = outcome.exitCode === 0 ? console.log : console.error;
    for (const line of render(outcome.result)) stream(line);
  }
  process.exit(outcome.exitCode);
}

export function registerServiceCommands(program: Command, helpers: ServiceCliHelpers): void {
  const service = program
    .command('service')
    .description('Keep the daemon running across logins and reboots (launchd agent on macOS, systemd user unit on Linux)');

  service
    .command('install')
    .description('Install and start the login item for the daemon. A person approves it: at the terminal, or in a dialog the daemon shows')
    .option('--dry-run', 'Print the unit file and the commands that would run; change nothing')
    .option('--timeout <seconds>', `Without a terminal: how long the dialog waits for an answer (${PROMPT_TIMEOUT_MIN_SECONDS}-${PROMPT_TIMEOUT_MAX_SECONDS})`, String(PROMPT_TIMEOUT_SECONDS))
    .option('--json', 'Print one JSON object and nothing else')
    .addHelpText('after', `
At a terminal the command asks one y/N question. Without a terminal it asks the
running daemon to show an approval dialog. No flag or environment variable
answers for the person.

Statuses and exit codes:
  installed          0   the unit is installed and loaded
  already_installed  0   the same unit was already installed and loaded; nobody was asked
  dry_run            0   --dry-run: nothing was changed
  declined           2   a person said no
  pending            3   nobody could be asked (no daemon, no desktop session, no answer); the output says what a person runs
  error              4   the proxy on the socket does not take the question
  error              1   refused: unsupported platform, the encrypted-file backend, a proxy this command cannot stop, a failing system tool`)
    .action(async (opts: { dryRun?: boolean; timeout: string; json?: boolean }) => {
      if (!/^\d+$/.test(opts.timeout)) {
        print({ result: { status: 'error', error: `Invalid --timeout: ${opts.timeout}`, fix: `Give a whole number of seconds between ${PROMPT_TIMEOUT_MIN_SECONDS} and ${PROMPT_TIMEOUT_MAX_SECONDS}` }, exitCode: 1 }, Boolean(opts.json));
      }
      const deps = buildDeps(helpers, 'terminal-or-dialog', clampPromptTimeout(Number(opts.timeout)));
      print(await installService(deps, { dryRun: opts.dryRun === true }), Boolean(opts.json));
    });

  service
    .command('uninstall')
    .description('Stop the service and delete its unit file')
    .option('--json', 'Print one JSON object and nothing else')
    .action(async (opts: { json?: boolean }) => {
      print(await uninstallService(buildDeps(helpers, 'dialog', PROMPT_TIMEOUT_SECONDS)), Boolean(opts.json));
    });

  service
    .command('status')
    .description('Whether the daemon starts at login, and whether the daemon on the socket is the service\'s')
    .option('--json', 'Print one JSON object and nothing else')
    .action(async (opts: { json?: boolean }) => {
      print(await serviceStatus(buildDeps(helpers, 'dialog', PROMPT_TIMEOUT_SECONDS)), Boolean(opts.json), renderStatus);
    });
}

/** Whether a unit file for the daemon is on disk. Reads no service manager. */
export function loginItemPresent(): boolean {
  const file = unitFilePath(process.platform, os.homedir());
  return file !== null && fs.existsSync(file);
}

/**
 * The login item, for `aquaman init --agent`. With `--service` the question
 * goes to the person through the daemon's dialog (this command never asks at
 * the terminal) and the answer is the `service` object. Without it nothing is
 * installed, and a step for a person is returned when no unit is on disk.
 */
export async function loginItemForInit(helpers: ServiceCliHelpers, wanted: boolean): Promise<{ service?: Record<string, unknown>; humanStep?: string }> {
  if (wanted) return { service: (await installService(buildDeps(helpers, 'dialog', PROMPT_TIMEOUT_SECONDS))).result };
  const step = loginItemStep(process.platform, [loadStoredConfig().credentials.backend, loadConfig().credentials.backend], loginItemPresent());
  return step ? { humanStep: step } : {};
}
