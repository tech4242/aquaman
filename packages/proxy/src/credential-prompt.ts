/**
 * Asking the human, from the daemon, for a credential an agent needs.
 *
 * `aquaman request <ref>` lets an agent say "this task needs github/token"
 * without ever handling the value: the request goes to the daemon, the daemon
 * shows a native dialog, and the human types the value there. It goes from
 * the dialog into the vault. The agent gets back a status and the reference.
 * What can be done with the reference afterwards depends on the request, and
 * the dialog says which (see CONSEQUENCE).
 *
 * The dialog is shown by the daemon, not by the CLI the agent ran, so the
 * value never passes through that command or its output. The helper binaries are
 * run by absolute path with a fixed environment, so a `PATH` the caller
 * controls cannot substitute them.
 *
 * What this is not: a security boundary against a process running as the
 * same user. Such a process can already edit the files that declare refs.
 * The dialog keeps the value out of the request and its output and makes the
 * human the one who decides; it does not stop a hostile local process from
 * asking.
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
  /**
   * The credential is for a program routed through the proxy: it is stored
   * (or approved) without being declared for handing out. The dialog says
   * something different in that case, because something different happens.
   */
  routed?: boolean;
  /**
   * The locator of an item that already exists in the vault, which the caller
   * asks to have read as this credential (a link). Chosen by the caller, so
   * shown as such. Only an approval is asked for: nothing is typed.
   */
  from?: string;
  /**
   * With `from`: the reference is linked and not declared, so the value is
   * injected by the proxy and not handed to commands. Picks the wording.
   */
  linkOnly?: boolean;
  /**
   * A program is asking for the value of a reference marked ask-first
   * (ask-first.ts). An approval: nothing is typed. `windowSeconds` is how
   * long a yes lasts, and the dialog says so.
   */
  read?: {
    windowSeconds: number;
    via: ReadVia;
    /** With `via: 'forward'`: the address the value would be sent to, as services.yaml gives it. Shown as such. */
    upstream?: string;
  };
  /** A command is asking to remove the ask-first mark from the reference. An approval. */
  unmark?: boolean;
  /**
   * With `unmark`, when the record of marks cannot be read: the references
   * that stay marked if the person agrees. Every other one loses its mark,
   * so the dialog names them. The names come from the declaring files.
   */
  keepMarked?: readonly string[];
  /**
   * With `read` or `unmark`: marked references that are read from the same
   * vault item as this one, so the person sees which mark the question is
   * about when the name asked for is not the name they marked.
   */
  sameItemAs?: readonly string[];
}

/**
 * How a request that needs a value reached the daemon: a program asking for
 * it on the Unix socket, the OpenShell driver, or a request to be forwarded
 * to a service that services.yaml defines. This is all aquaman knows about
 * who is asking, so it is all the dialog says about them. There is no entry
 * for the loopback listener: a request there never raises a dialog.
 */
export type ReadVia = 'socket' | 'openshell' | 'forward';

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
  /**
   * Ask the human whether aquaman may start at every login. An approval:
   * nothing is typed, and the wording is fixed, with no text from the caller.
   */
  askLoginItem(request: LoginItemRequest): Promise<PromptResult>;
}

export interface LoginItemRequest {
  /** How long the dialog stays up. Defaults to PROMPT_TIMEOUT_SECONDS. */
  timeoutSeconds?: number;
}

/**
 * The whole text of the login-item dialog. It says what agreeing does (the
 * daemon starts at every login and keeps running) and how to undo it, and it
 * carries nothing the requesting command chose.
 */
export const LOGIN_ITEM_MESSAGE = [
  'A command is asking aquaman to start at every login and keep running in the background.',
  '',
  'Allow adds a login item for the aquaman daemon to your account. Deny if you did not expect this.',
  '',
  'To remove it later, run: aquaman service uninstall',
  '',
  'aquaman never asks for your login, Apple ID or password-manager password.',
].join('\n');

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

/**
 * What the person is told happens if they agree. One sentence set per case,
 * and each has to be true of that case: an ordinary request ends with the
 * reference declared, so commands (and anything else running as the user) can
 * be handed the value; a routed request ends with the value stored and not
 * declared, so the program holds a local token and the proxy adds the key.
 */
const CONSEQUENCE = {
  value: {
    declared: 'Type the value to store it in your vault. Commands the agent runs in this project will be given the value, and other software running as you can ask aquaman for it. Cancel if you did not expect this.',
    routed: 'Type the value to store it in your vault. The app in this project gets a local token, not the key: aquaman adds the key to its requests on the way out. Cancel if you did not expect this.',
  },
  approval: {
    declared: 'Allow lets any aquaman project on this machine be given the value. Deny if you did not expect this.',
    routed: 'Allow lets an app in this project send its requests through aquaman, which adds the key on the way out. The app gets a local token, not the key. Deny if you did not expect this.',
  },
  link: {
    declared: 'Allow makes aquaman read that item whenever this credential is used. aquaman does not change or delete the item. Commands the agent runs in this project will be given the value, and other software running as you can ask aquaman for it. Deny if you did not expect this, or if the item named below is not one you want used this way.',
    routed: 'Allow makes aquaman read that item whenever this credential is used. aquaman does not change or delete the item. The app in this project gets a local token, not the key: aquaman adds the key to its requests on the way out. Deny if you did not expect this, or if the item named below is not one you want used this way.',
    only: 'Allow makes aquaman read that item whenever this credential is used. aquaman does not change or delete the item. The value is added to requests aquaman forwards for this service; it is not given to commands unless the credential is also declared (aquaman broker allow). Deny if you did not expect this, or if the item named below is not one you want used this way.',
  },
} as const;

/**
 * A window in the words a person would use: "8 hours", "90 minutes",
 * "45 seconds". Whole units only, so the dialog never states a longer time
 * than the daemon keeps.
 */
export function windowText(seconds: number): string {
  const unit = (n: number, name: string) => `${n} ${name}${n === 1 ? '' : 's'}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
  if (seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/**
 * Who is asking, as far as aquaman can say: the listener the request came in
 * on. It cannot name the program, and the sentence after it says so.
 */
const READ_OPENING: Record<ReadVia, string> = {
  socket: 'A program running as you is asking aquaman for the value of a credential that is marked "ask first".',
  openshell: 'A program connected to aquaman\'s OpenShell driver is asking aquaman for the value of a credential that is marked "ask first".',
  forward: 'A program running as you is asking aquaman to send a request that carries a credential marked "ask first" to a service that is not built into aquaman.',
};

/**
 * What a yes to a read means, for the window the daemon will keep. True for
 * every caller: the approval is for the reference, not for a program. For a
 * forwarded request the value goes to the address services.yaml gives, which
 * a program running as the user can have written, so the dialog says where.
 */
export function readConsequence(windowSeconds: number, via: ReadVia = 'socket'): string {
  const window = `for the next ${windowText(windowSeconds)} (or until aquaman is restarted or its vault is locked)`;
  if (via === 'forward') {
    return `aquaman cannot tell which program is asking. Allow sends the value to the address this service is defined with in services.yaml, shown below, and ${window} any program running as you can have it sent there, or read it from aquaman, without another dialog. Deny if you did not expect this, or if the address below is not one this value should go to.`;
  }
  return `aquaman cannot tell which program is asking. Allow hands it the value, and ${window} any program running as you can read this value from aquaman without another dialog. Deny if you did not expect this.`;
}

/** At most this many names of a list are written out in a dialog; the rest are counted. */
const DIALOG_LIST_MAX = 8;

/** A list of reference names as one bounded line: the first few, then how many more. */
function listText(names: readonly string[]): string {
  const shown = names.slice(0, DIALOG_LIST_MAX).map((n) => displayText(n, 140));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

/** What a yes to removing the mark means. */
export const UNMARK_CONSEQUENCE = 'Allow removes the "ask first" mark. aquaman then hands this value out without asking, to any program running as you, whenever the credential is declared for handing out. Deny if you did not expect this.';

function askFirstMessage(request: PromptRequest): string {
  const lines = [
    request.read
      ? READ_OPENING[request.read.via]
      : 'A command is asking aquaman to stop asking you before it hands out the credential below.',
    '',
    `Credential: ${displayText(`${request.service}/${request.key}`, 140)}`,
    '',
    request.read ? readConsequence(request.read.windowSeconds, request.read.via) : UNMARK_CONSEQUENCE,
    '',
    'aquaman never asks for your login, Apple ID or password-manager password.',
  ];
  // Last, one line each: everything above is aquaman's own wording, and
  // every name, address and path below was chosen by something else.
  const reported: string[] = [];
  if (request.read?.via === 'forward') {
    reported.push(`Sent to (as services.yaml says): ${displayText(request.read.upstream ?? 'not given', 200)}`);
  }
  if (request.sameItemAs && request.sameItemAs.length > 0) {
    reported.push(`This is the same vault item as the marked credential: ${listText(request.sameItemAs)}`);
  }
  if (request.unmark === true && request.keepMarked !== undefined) {
    const n = request.keepMarked.length;
    reported.push(n === 0
      ? 'The record of marks cannot be read, so every credential counts as marked. After Allow none is marked.'
      : `The record of marks cannot be read, so every credential counts as marked. After Allow only ${n === 1 ? 'this one stays' : `these ${n} stay`} marked: ${listText(request.keepMarked)}`);
  }
  if (request.project) reported.push(`Requested from (as the caller reports it): ${displayText(request.project)}`);
  if (reported.length > 0) lines.push('', ...reported);
  return lines.join('\n');
}

/**
 * Room for a whole locator (links.ts caps one at 200 characters), so the
 * person sees all of what they are agreeing to and never a shortened form.
 */
const LOCATOR_DISPLAY_MAX = 220;

export function promptMessage(request: PromptRequest, kind: 'value' | 'approval'): string {
  if (kind === 'approval' && (request.read !== undefined || request.unmark === true)) return askFirstMessage(request);
  // An approval that names a vault item is a different decision from one
  // about a stored credential, and is worded as such.
  const what = kind === 'approval' && request.from !== undefined ? 'link' : kind;
  const lines = [
    what === 'value'
      ? 'An agent is asking aquaman for a credential that is not in your vault.'
      : what === 'approval'
        ? 'An agent is asking to use a credential that is already in your vault.'
        : 'An agent is asking aquaman to use an item that already exists in your vault as the credential below.',
    '',
    `Credential: ${displayText(`${request.service}/${request.key}`, 140)}`,
    '',
    what === 'link' && request.linkOnly === true && request.routed !== true
      ? CONSEQUENCE.link.only
      : CONSEQUENCE[what][request.routed === true ? 'routed' : 'declared'],
    '',
    'aquaman never asks for your login, Apple ID or password-manager password.',
  ];
  // Last, and one line each: everything above is aquaman's own wording.
  const reported: string[] = [];
  if (what === 'link') reported.push(`Vault item (as the caller wrote it): ${displayText(request.from!, LOCATOR_DISPLAY_MAX)}`);
  if (request.project) reported.push(`Requested from (as the caller reports it): ${displayText(request.project)}`);
  if (reported.length > 0) lines.push('', ...reported);
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
    async askLoginItem(request) {
      const seconds = request.timeoutSeconds ?? defaultSeconds;
      const r = await run(OSASCRIPT, osaArgs(osaApproval(seconds), LOGIN_ITEM_MESSAGE), seconds);
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
    async askLoginItem(request) {
      const seconds = request.timeoutSeconds ?? defaultSeconds;
      const r = await run(
        zenity,
        ['--question', '--no-markup', ...common(seconds), '--ok-label=Allow', '--cancel-label=Deny', '--default-cancel', `--text=${LOGIN_ITEM_MESSAGE}`],
        seconds,
        display,
      );
      return r.code === 0 ? { outcome: 'approved' } : failed(r);
    },
  };
}

function unavailablePrompter(reason: string): CredentialPrompter {
  const result: PromptResult = { outcome: 'unavailable', reason };
  return { askValue: async () => result, askApproval: async () => result, askLoginItem: async () => result };
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
