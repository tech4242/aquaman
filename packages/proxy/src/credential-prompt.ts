/**
 * Asking the human, from the daemon, for a credential an agent needs.
 *
 * `aquaman request <ref>` lets an agent say "this task needs github/token"
 * without ever handling the value: the request goes to the daemon, the daemon
 * shows a native dialog, and the human types the value there. It goes from
 * the dialog into the vault. The agent gets back a status and the reference.
 *
 * The dialog is shown by the daemon, not by the CLI the agent ran, so the
 * value never passes through that command or its output. The helper binaries are
 * run by absolute path with a fixed environment, so a `PATH` the caller
 * controls cannot substitute them.
 *
 * What this is not: a security boundary against a process running as the
 * same user. Such a process can already edit the files that declare refs.
 * The dialog keeps the value out of the agent's hands and makes the human the
 * one who decides; it does not stop a hostile local process from asking.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export interface PromptRequest {
  service: string;
  key: string;
  /** Where the request says it came from. Reported by the caller, so shown as such. */
  project?: string;
  /** How long the dialog stays up. Defaults to PROMPT_TIMEOUT_SECONDS. */
  timeoutSeconds?: number;
}

export type PromptResult =
  | { outcome: 'entered'; value: string }
  | { outcome: 'approved' }
  | { outcome: 'declined' }
  | { outcome: 'timeout' }
  | { outcome: 'unavailable'; reason: string };

export interface CredentialPrompter {
  /** Ask the human to type the secret value. */
  askValue(request: PromptRequest): Promise<PromptResult>;
  /** Ask the human whether a credential that is already in the vault may be used. */
  askApproval(request: PromptRequest): Promise<PromptResult>;
}

/**
 * How long a dialog stays up before it counts as unanswered. Shorter than the
 * two minutes coding agents commonly allow one command, so the caller still
 * gets its `pending` answer.
 */
export const PROMPT_TIMEOUT_SECONDS = 90;
export const PROMPT_TIMEOUT_MIN_SECONDS = 10;
export const PROMPT_TIMEOUT_MAX_SECONDS = 600;

/** A caller-supplied wait, held inside the allowed range; the default for anything that is not a number. */
export function clampPromptTimeout(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return PROMPT_TIMEOUT_SECONDS;
  return Math.min(PROMPT_TIMEOUT_MAX_SECONDS, Math.max(PROMPT_TIMEOUT_MIN_SECONDS, Math.round(seconds)));
}
const MAX_VALUE_BYTES = 64 * 1024;

const OSASCRIPT = '/usr/bin/osascript';
const ZENITY_CANDIDATES = ['/usr/bin/zenity', '/usr/local/bin/zenity'];

/**
 * One line of caller-supplied text for the dialog. Whoever sends the request
 * chooses this text, and the dialog is where a person decides, so nothing in
 * it may start a new line or reorder what is shown: control and format
 * characters (which include bidirectional overrides) and the Unicode line and
 * paragraph separators become spaces, runs of space collapse, and a backslash,
 * which some dialog helpers read as the start of an escape, becomes a slash.
 */
export function displayText(text: string, max = 120): string {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\\/g, '/')
    .replace(/\s+/gu, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function promptMessage(request: PromptRequest, kind: 'value' | 'approval'): string {
  const lines = [
    kind === 'value'
      ? 'An agent is asking aquaman for a credential that is not in your vault.'
      : 'An agent is asking to use a credential that is already in your vault.',
    '',
    `Credential: ${displayText(`${request.service}/${request.key}`, 140)}`,
    '',
    kind === 'value'
      ? 'Type the value to store it in your vault. The agent receives a reference, never the value. Cancel if you did not expect this.'
      : 'Allow lets any aquaman project on this machine be given the value. Deny if you did not expect this.',
    '',
    'aquaman never asks for your login, Apple ID or password-manager password.',
  ];
  // Last, and one line: everything above it is aquaman's own wording.
  if (request.project) lines.push('', `Requested from (as the caller reports it): ${displayText(request.project)}`);
  return lines.join('\n');
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function run(binary: string, args: string[], seconds: number, extraEnv: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: process.env['LANG'] ?? 'en_US.UTF-8', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8').on('data', (c: string) => {
      if (stdout.length <= MAX_VALUE_BYTES) stdout += c;
    });
    child.stderr.setEncoding('utf-8').on('data', (c: string) => {
      if (stderr.length <= 4096) stderr += c;
    });
    // The dialogs time themselves out; this only covers a helper that hangs.
    const guard = setTimeout(() => child.kill('SIGKILL'), (seconds + 15) * 1000);
    child.on('error', (err) => { clearTimeout(guard); resolve({ code: null, stdout: '', stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(guard); resolve({ code, stdout, stderr }); });
  });
}

function entered(stdout: string): PromptResult {
  // Each helper prints the value followed by exactly one newline.
  const value = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (value.length === 0) return { outcome: 'declined' };
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return { outcome: 'unavailable', reason: 'the value entered is too large' };
  return { outcome: 'entered', value };
}

// The message reaches AppleScript as an argument, never as script text.
const osaValue = (seconds: number) => [
  'on run argv',
  `set r to display dialog (item 1 of argv) default answer "" with hidden answer buttons {"Cancel", "Store in vault"} default button "Store in vault" with title "aquaman" giving up after ${seconds}`,
  'if gave up of r then error "aquaman-timeout" number 9001',
  'return text returned of r',
  'end run',
];
const osaApproval = (seconds: number) => [
  'on run argv',
  `set r to display dialog (item 1 of argv) buttons {"Deny", "Allow"} default button "Deny" with title "aquaman" giving up after ${seconds}`,
  'if gave up of r then error "aquaman-timeout" number 9001',
  'return button returned of r',
  'end run',
];

function osaArgs(script: string[], message: string): string[] {
  return [...script.flatMap((line) => ['-e', line]), message];
}

function macPrompter(defaultSeconds: number): CredentialPrompter {
  const failed = (r: RunResult): PromptResult => {
    if (r.stderr.includes('9001')) return { outcome: 'timeout' };
    if (r.stderr.includes('-128')) return { outcome: 'declined' };
    return { outcome: 'unavailable', reason: 'could not show a dialog (no desktop session for the daemon?)' };
  };
  return {
    async askValue(request) {
      const seconds = request.timeoutSeconds ?? defaultSeconds;
      const r = await run(OSASCRIPT, osaArgs(osaValue(seconds), promptMessage(request, 'value')), seconds);
      return r.code === 0 ? entered(r.stdout) : failed(r);
    },
    async askApproval(request) {
      const seconds = request.timeoutSeconds ?? defaultSeconds;
      const r = await run(OSASCRIPT, osaArgs(osaApproval(seconds), promptMessage(request, 'approval')), seconds);
      if (r.code !== 0) return failed(r);
      return r.stdout.trim() === 'Allow' ? { outcome: 'approved' } : { outcome: 'declined' };
    },
  };
}

function zenityPrompter(zenity: string, defaultSeconds: number): CredentialPrompter {
  const display: Record<string, string> = {};
  for (const name of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) {
    const v = process.env[name];
    if (v) display[name] = v;
  }
  const common = (seconds: number) => ['--title=aquaman', `--timeout=${seconds}`];
  // The entry dialog reads `_` as a keyboard-shortcut marker; doubled, it is a literal underscore.
  const entryText = (text: string) => text.replace(/_/g, '__');
  const failed = (r: RunResult): PromptResult => {
    if (r.code === 5) return { outcome: 'timeout' };
    if (r.code === 1) return { outcome: 'declined' };
    return { outcome: 'unavailable', reason: 'could not show a dialog' };
  };
  return {
    async askValue(request) {
      const seconds = request.timeoutSeconds ?? defaultSeconds;
      const r = await run(zenity, ['--entry', '--hide-text', ...common(seconds), `--text=${entryText(promptMessage(request, 'value'))}`], seconds, display);
      return r.code === 0 ? entered(r.stdout) : failed(r);
    },
    async askApproval(request) {
      const seconds = request.timeoutSeconds ?? defaultSeconds;
      const r = await run(
        zenity,
        ['--question', '--no-markup', ...common(seconds), '--ok-label=Allow', '--cancel-label=Deny', '--default-cancel', `--text=${promptMessage(request, 'approval')}`],
        seconds,
        display,
      );
      return r.code === 0 ? { outcome: 'approved' } : failed(r);
    },
  };
}

function unavailablePrompter(reason: string): CredentialPrompter {
  const result: PromptResult = { outcome: 'unavailable', reason };
  return { askValue: async () => result, askApproval: async () => result };
}

/** The dialog mechanism for this machine, or one that always answers `unavailable`. */
export function createNativePrompter(
  platform: NodeJS.Platform = process.platform,
  timeoutSeconds: number = PROMPT_TIMEOUT_SECONDS,
): CredentialPrompter {
  if (platform === 'darwin') {
    return fs.existsSync(OSASCRIPT) ? macPrompter(timeoutSeconds) : unavailablePrompter('osascript is missing');
  }
  if (platform === 'linux') {
    if (!process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
      return unavailablePrompter('the daemon has no desktop session (no DISPLAY or WAYLAND_DISPLAY)');
    }
    const zenity = ZENITY_CANDIDATES.find((p) => fs.existsSync(p));
    return zenity ? zenityPrompter(zenity, timeoutSeconds) : unavailablePrompter('zenity is not installed');
  }
  return unavailablePrompter(`no dialog support on ${platform}`);
}
