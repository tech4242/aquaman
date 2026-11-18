/**
 * The native credential dialog (`packages/proxy/src/credential-prompt.ts`).
 *
 * No dialog is ever shown here: `node:child_process` is mocked, so every
 * spawn is captured and its result scripted. What is asserted is what the
 * daemon would have run: the helper's absolute path, the exact argument list
 * (the message as an argument, never as script text), the fixed environment,
 * and how each exit is read (value, cancel, timeout, no dialog).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  existing: new Set<string>(),
}));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, existsSync: (p: string) => h.existing.has(String(p)) };
});

import {
  createNativePrompter,
  clampPromptTimeout,
  displayText,
  promptMessage,
  PROMPT_TIMEOUT_SECONDS,
  PROMPT_TIMEOUT_MIN_SECONDS,
  PROMPT_TIMEOUT_MAX_SECONDS,
} from '../../packages/proxy/src/credential-prompt.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}

interface Script {
  code?: number | null;
  stdout?: string | string[];
  stderr?: string | string[];
  /** Emit `error` instead of `close` (the helper could not be started). */
  error?: Error;
  /** Never finish on its own; the test drives the child. */
  hang?: boolean;
}

let children: FakeChild[] = [];

function script(s: Script): void {
  h.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    children.push(child);
    if (!s.hang) {
      setImmediate(() => {
        if (s.error) { child.emit('error', s.error); return; }
        for (const c of [s.stdout ?? []].flat()) child.stdout.write(c);
        for (const c of [s.stderr ?? []].flat()) child.stderr.write(c);
        // Let the stream deliver its data before the process "closes".
        setImmediate(() => child.emit('close', s.code ?? 0));
      });
    }
    return child;
  });
}

function lastSpawn(): { binary: string; args: string[]; options: { stdio: unknown; env: Record<string, string> } } {
  const call = h.spawn.mock.calls[h.spawn.mock.calls.length - 1]!;
  return { binary: call[0], args: call[1], options: call[2] };
}

const DISPLAY_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'LANG'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  h.spawn.mockReset();
  h.existing.clear();
  children = [];
  for (const name of DISPLAY_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  vi.useRealTimers();
  for (const name of DISPLAY_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const REQ = { service: 'github', key: 'token', project: '/work/app' };

describe('clampPromptTimeout', () => {
  it('uses the default for anything that is not a finite number', () => {
    for (const v of [undefined, null, '120', NaN, Infinity, -Infinity, {}, true]) {
      expect(clampPromptTimeout(v)).toBe(PROMPT_TIMEOUT_SECONDS);
    }
  });

  it('holds a number inside the allowed range and rounds it', () => {
    expect(clampPromptTimeout(1)).toBe(PROMPT_TIMEOUT_MIN_SECONDS);
    expect(clampPromptTimeout(-5)).toBe(PROMPT_TIMEOUT_MIN_SECONDS);
    expect(clampPromptTimeout(100000)).toBe(PROMPT_TIMEOUT_MAX_SECONDS);
    expect(clampPromptTimeout(45.4)).toBe(45);
    expect(clampPromptTimeout(45.6)).toBe(46);
    expect(clampPromptTimeout(PROMPT_TIMEOUT_MIN_SECONDS)).toBe(10);
    expect(clampPromptTimeout(PROMPT_TIMEOUT_MAX_SECONDS)).toBe(600);
  });
});

describe('displayText', () => {
  it('turns newlines, tabs and other control characters into single spaces', () => {
    expect(displayText('a\nb\r\nc\td\u0000e\u001bf')).toBe('a b c d e f');
  });

  it('removes bidirectional overrides and other format characters', () => {
    expect(displayText('safe‮evil⁦x⁩​z')).toBe('safe evil x z');
  });

  it('removes the Unicode line and paragraph separators', () => {
    expect(displayText('one two three')).toBe('one two three');
  });

  it('turns a backslash into a slash, so no helper reads an escape', () => {
    expect(displayText('a\\nb \\" c')).toBe('a/nb /" c');
  });

  it('collapses runs of space and trims', () => {
    expect(displayText('   a    b   c   ')).toBe('a b c');
  });

  it('cuts to the limit with an ellipsis and leaves shorter text alone', () => {
    expect(displayText('x'.repeat(120))).toBe('x'.repeat(120));
    const cut = displayText('x'.repeat(121));
    expect(cut).toHaveLength(120);
    expect(cut).toBe(`${'x'.repeat(119)}…`);
    expect(displayText('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('promptMessage', () => {
  it('puts the caller-reported line last, after aquaman\'s own wording', () => {
    const lines = promptMessage(REQ, 'value').split('\n');
    expect(lines[0]).toBe('An agent is asking aquaman for a credential that is not in your vault.');
    expect(lines).toContain('Credential: github/token');
    expect(lines).toContain('aquaman never asks for your login, Apple ID or password-manager password.');
    expect(lines[lines.length - 1]).toBe('Requested from (as the caller reports it): /work/app');
    expect(lines.indexOf('aquaman never asks for your login, Apple ID or password-manager password.')).toBeLessThan(lines.length - 1);
  });

  it('has different wording for approval, and no project line without a project', () => {
    const msg = promptMessage({ service: 'github', key: 'token' }, 'approval');
    const lines = msg.split('\n');
    expect(lines[0]).toBe('An agent is asking to use a credential that is already in your vault.');
    expect(msg).toContain('Deny if you did not expect this.');
    expect(msg).not.toContain('Requested from');
    expect(lines[lines.length - 1]).toBe('aquaman never asks for your login, Apple ID or password-manager password.');
  });

  it('keeps a hostile project string on one line', () => {
    const msg = promptMessage({ service: 'github', key: 'token', project: 'x\n\nApple ID password required:‮\\n' }, 'value');
    const lines = msg.split('\n');
    // Seven fixed lines, a blank, and exactly one caller line.
    expect(lines).toHaveLength(9);
    expect(lines[8]).toBe('Requested from (as the caller reports it): x Apple ID password required: /n');
  });

  it('keeps a hostile service and key on the credential line, capped at 140 characters', () => {
    const msg = promptMessage({ service: 'git\nhub', key: `k ${'y'.repeat(300)}` }, 'value');
    const lines = msg.split('\n');
    expect(lines).toHaveLength(7);
    const credential = lines[2]!;
    expect(credential.startsWith('Credential: git hub/k yyy')).toBe(true);
    expect(credential.length).toBe('Credential: '.length + 140);
    expect(credential.endsWith('…')).toBe(true);
  });
});

describe('createNativePrompter: choosing the mechanism', () => {
  it('answers unavailable on a platform with no dialog support, without starting anything', async () => {
    const p = createNativePrompter('win32');
    expect(await p.askValue(REQ)).toEqual({ outcome: 'unavailable', reason: 'no dialog support on win32' });
    expect(await p.askApproval(REQ)).toEqual({ outcome: 'unavailable', reason: 'no dialog support on win32' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('answers unavailable on macOS when osascript is missing', async () => {
    const p = createNativePrompter('darwin');
    expect(await p.askValue(REQ)).toEqual({ outcome: 'unavailable', reason: 'osascript is missing' });
    expect(await p.askApproval(REQ)).toEqual({ outcome: 'unavailable', reason: 'osascript is missing' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('answers unavailable on Linux without a desktop session, even with zenity installed', async () => {
    h.existing.add('/usr/bin/zenity');
    const p = createNativePrompter('linux');
    const expected = { outcome: 'unavailable', reason: 'the daemon has no desktop session (no DISPLAY or WAYLAND_DISPLAY)' };
    expect(await p.askValue(REQ)).toEqual(expected);
    expect(await p.askApproval(REQ)).toEqual(expected);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('answers unavailable on Linux with a desktop session but no zenity', async () => {
    process.env['DISPLAY'] = ':0';
    const p = createNativePrompter('linux');
    expect(await p.askValue(REQ)).toEqual({ outcome: 'unavailable', reason: 'zenity is not installed' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('takes zenity from /usr/bin first, then /usr/local/bin, never from PATH', async () => {
    process.env['WAYLAND_DISPLAY'] = 'wayland-0';
    h.existing.add('/usr/local/bin/zenity');
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('linux').askValue(REQ);
    expect(lastSpawn().binary).toBe('/usr/local/bin/zenity');

    h.existing.add('/usr/bin/zenity');
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('linux').askValue(REQ);
    expect(lastSpawn().binary).toBe('/usr/bin/zenity');
  });
});

describe('macOS: osascript', () => {
  beforeEach(() => { h.existing.add('/usr/bin/osascript'); });

  it('asks for a value with the message as the last argument, never inside the script', async () => {
    script({ code: 0, stdout: 'ghp_secret\n' });
    const req = { service: 'github', key: 'token', project: '" & (do shell script "id") & "' };
    const result = await createNativePrompter('darwin').askValue(req);
    expect(result).toEqual({ outcome: 'entered', value: 'ghp_secret' });

    const { binary, args, options } = lastSpawn();
    expect(binary).toBe('/usr/bin/osascript');
    expect(args).toEqual([
      '-e', 'on run argv',
      '-e', `set r to display dialog (item 1 of argv) default answer "" with hidden answer buttons {"Cancel", "Store in vault"} default button "Store in vault" with title "aquaman" giving up after ${PROMPT_TIMEOUT_SECONDS}`,
      '-e', 'if gave up of r then error "aquaman-timeout" number 9001',
      '-e', 'return text returned of r',
      '-e', 'end run',
      promptMessage(req, 'value'),
    ]);
    // Caller text appears in exactly one place: the trailing argument.
    const scriptLines = args.slice(0, -1);
    expect(scriptLines.join('\n')).not.toContain('do shell script');
    expect(args[args.length - 1]).toContain('do shell script');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('runs the helper with a fixed environment, not the daemon\'s', async () => {
    process.env['DISPLAY'] = ':9';
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('darwin').askValue(REQ);
    expect(lastSpawn().options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' });

    process.env['LANG'] = 'de_DE.UTF-8';
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('darwin').askValue(REQ);
    expect(lastSpawn().options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'de_DE.UTF-8' });
  });

  it('asks for approval with Deny as the default button', async () => {
    script({ code: 0, stdout: 'Allow\n' });
    const result = await createNativePrompter('darwin', 30).askApproval(REQ);
    expect(result).toEqual({ outcome: 'approved' });
    expect(lastSpawn().args).toEqual([
      '-e', 'on run argv',
      '-e', 'set r to display dialog (item 1 of argv) buttons {"Deny", "Allow"} default button "Deny" with title "aquaman" giving up after 30',
      '-e', 'if gave up of r then error "aquaman-timeout" number 9001',
      '-e', 'return button returned of r',
      '-e', 'end run',
      promptMessage(REQ, 'approval'),
    ]);
  });

  it('reads any button other than Allow as declined', async () => {
    script({ code: 0, stdout: 'Deny\n' });
    expect(await createNativePrompter('darwin').askApproval(REQ)).toEqual({ outcome: 'declined' });
    script({ code: 0, stdout: '' });
    expect(await createNativePrompter('darwin').askApproval(REQ)).toEqual({ outcome: 'declined' });
  });

  it('uses the request\'s own timeout over the prompter default', async () => {
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('darwin', 30).askValue({ ...REQ, timeoutSeconds: 12 });
    expect(lastSpawn().args[3]).toContain('giving up after 12');
    script({ code: 0, stdout: 'Allow\n' });
    await createNativePrompter('darwin', 30).askApproval({ ...REQ, timeoutSeconds: 13 });
    expect(lastSpawn().args[3]).toContain('giving up after 13');
  });

  it('strips exactly one trailing newline from the value and keeps the rest', async () => {
    script({ code: 0, stdout: ['  two\n', 'lines \n\n'] });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({ outcome: 'entered', value: '  two\nlines \n' });
    script({ code: 0, stdout: 'no-newline' });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({ outcome: 'entered', value: 'no-newline' });
  });

  it('reads an empty value as declined, not as a credential', async () => {
    script({ code: 0, stdout: '\n' });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({ outcome: 'declined' });
    script({ code: 0, stdout: '' });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({ outcome: 'declined' });
  });

  it('refuses a value larger than 64 KiB', async () => {
    // Multi-byte characters: under the character cap that stops collection, over the byte cap.
    script({ code: 0, stdout: `${'é'.repeat(40 * 1024)}\n` });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({
      outcome: 'unavailable',
      reason: 'the value entered is too large',
    });
  });

  it('stops collecting output once past the cap', async () => {
    const chunk = 'a'.repeat(40 * 1024);
    script({ code: 0, stdout: [chunk, chunk, chunk, chunk] });
    const result = await createNativePrompter('darwin').askValue(REQ);
    // Two chunks pass the cap; the third and fourth are dropped, and the result is refused as too large.
    expect(result).toEqual({ outcome: 'unavailable', reason: 'the value entered is too large' });
  });

  it('reads error 9001 as a timeout, for both dialogs', async () => {
    const stderr = '36:171: execution error: aquaman-timeout (9001)\n';
    script({ code: 1, stderr });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({ outcome: 'timeout' });
    script({ code: 1, stderr });
    expect(await createNativePrompter('darwin').askApproval(REQ)).toEqual({ outcome: 'timeout' });
  });

  it('reads error -128 (Cancel) as declined', async () => {
    script({ code: 1, stderr: 'execution error: User canceled. (-128)\n' });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({ outcome: 'declined' });
  });

  it('reads any other failure as no dialog, and never as a value', async () => {
    script({ code: 1, stdout: 'leftover\n', stderr: 'execution error: No user interaction allowed. (-1713)\n' });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({
      outcome: 'unavailable',
      reason: 'could not show a dialog (no desktop session for the daemon?)',
    });
    script({ code: 1, stdout: 'Allow\n', stderr: 'boom' });
    expect(await createNativePrompter('darwin').askApproval(REQ)).toEqual({
      outcome: 'unavailable',
      reason: 'could not show a dialog (no desktop session for the daemon?)',
    });
  });

  it('keeps only a bounded amount of stderr', async () => {
    // The timeout marker arrives after the cap, so it is not seen.
    script({ code: 1, stderr: ['x'.repeat(5000), ' (9001)'] });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({
      outcome: 'unavailable',
      reason: 'could not show a dialog (no desktop session for the daemon?)',
    });
  });

  it('answers unavailable when the helper cannot be started', async () => {
    script({ error: new Error('spawn /usr/bin/osascript EACCES') });
    expect(await createNativePrompter('darwin').askValue(REQ)).toEqual({
      outcome: 'unavailable',
      reason: 'could not show a dialog (no desktop session for the daemon?)',
    });
  });

  it('kills a helper that hangs 15 seconds past its own timeout', async () => {
    vi.useFakeTimers();
    script({ hang: true });
    const pending = createNativePrompter('darwin', 20).askValue(REQ);
    const child = children[0]!;
    await vi.advanceTimersByTimeAsync(34_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);
    expect(await pending).toEqual({
      outcome: 'unavailable',
      reason: 'could not show a dialog (no desktop session for the daemon?)',
    });
  });

  it('does not kill a helper that finished in time', async () => {
    vi.useFakeTimers();
    script({ hang: true });
    const pending = createNativePrompter('darwin', 20).askApproval(REQ);
    const child = children[0]!;
    child.stdout.write('Allow\n');
    await vi.advanceTimersByTimeAsync(1);
    child.emit('close', 0);
    expect(await pending).toEqual({ outcome: 'approved' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe('Linux: zenity', () => {
  beforeEach(() => {
    h.existing.add('/usr/bin/zenity');
    process.env['DISPLAY'] = ':0';
  });

  it('asks for a value with a hidden entry and doubled underscores in the text', async () => {
    script({ code: 0, stdout: 'sk_live_1\n' });
    const req = { service: 'stripe', key: 'api_key', project: '/home/u/my_app' };
    const result = await createNativePrompter('linux').askValue(req);
    expect(result).toEqual({ outcome: 'entered', value: 'sk_live_1' });

    const { binary, args, options } = lastSpawn();
    expect(binary).toBe('/usr/bin/zenity');
    expect(args).toEqual([
      '--entry',
      '--hide-text',
      '--title=aquaman',
      `--timeout=${PROMPT_TIMEOUT_SECONDS}`,
      `--text=${promptMessage(req, 'value').replace(/_/g, '__')}`,
    ]);
    expect(args[4]).toContain('Credential: stripe/api__key');
    expect(args[4]).toContain('/home/u/my__app');
    expect(args[4]).not.toMatch(/(^|[^_])_([^_]|$)/);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('a backslash escape in caller text cannot become a newline in the entry dialog', async () => {
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('linux').askValue({ service: 'github', key: 'token', project: 'a\\nType your password' });
    const text = lastSpawn().args[4]!;
    expect(text).not.toContain('\\');
    expect(text.endsWith('Requested from (as the caller reports it): a/nType your password')).toBe(true);
  });

  it('asks for approval without markup, Deny as the default, underscores literal', async () => {
    script({ code: 0 });
    const req = { service: 'stripe', key: 'api_key', project: '<b>bold</b>' };
    const result = await createNativePrompter('linux', 40).askApproval(req);
    expect(result).toEqual({ outcome: 'approved' });
    expect(lastSpawn().args).toEqual([
      '--question',
      '--no-markup',
      '--title=aquaman',
      '--timeout=40',
      '--ok-label=Allow',
      '--cancel-label=Deny',
      '--default-cancel',
      `--text=${promptMessage(req, 'approval')}`,
    ]);
    expect(lastSpawn().args[7]).toContain('stripe/api_key');
  });

  it('passes only the desktop-session variables that are set, on top of the fixed environment', async () => {
    process.env['XAUTHORITY'] = '/run/user/1000/xauth';
    process.env['XDG_RUNTIME_DIR'] = '/run/user/1000';
    process.env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/bus';
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('linux').askValue(REQ);
    expect(lastSpawn().options.env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      DISPLAY: ':0',
      XAUTHORITY: '/run/user/1000/xauth',
      XDG_RUNTIME_DIR: '/run/user/1000',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    });
  });

  it('uses the request\'s own timeout over the prompter default', async () => {
    script({ code: 0, stdout: 'v\n' });
    await createNativePrompter('linux', 40).askValue({ ...REQ, timeoutSeconds: 11 });
    expect(lastSpawn().args).toContain('--timeout=11');
    script({ code: 0 });
    await createNativePrompter('linux', 40).askApproval({ ...REQ, timeoutSeconds: 14 });
    expect(lastSpawn().args).toContain('--timeout=14');
  });

  it('reads exit 5 as a timeout and exit 1 as declined, for both dialogs', async () => {
    const p = createNativePrompter('linux');
    script({ code: 5 });
    expect(await p.askValue(REQ)).toEqual({ outcome: 'timeout' });
    script({ code: 1 });
    expect(await p.askValue(REQ)).toEqual({ outcome: 'declined' });
    script({ code: 5 });
    expect(await p.askApproval(REQ)).toEqual({ outcome: 'timeout' });
    script({ code: 1 });
    expect(await p.askApproval(REQ)).toEqual({ outcome: 'declined' });
  });

  it('reads any other exit, or a helper that cannot start, as no dialog', async () => {
    const p = createNativePrompter('linux');
    script({ code: 255, stdout: 'leftover\n', stderr: 'Gtk-WARNING: cannot open display' });
    expect(await p.askValue(REQ)).toEqual({ outcome: 'unavailable', reason: 'could not show a dialog' });
    script({ error: new Error('spawn ENOENT') });
    expect(await p.askApproval(REQ)).toEqual({ outcome: 'unavailable', reason: 'could not show a dialog' });
  });

  it('reads an empty entry as declined', async () => {
    script({ code: 0, stdout: '\n' });
    expect(await createNativePrompter('linux').askValue(REQ)).toEqual({ outcome: 'declined' });
  });
});
