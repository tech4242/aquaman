/**
 * The parts of the login-item feature that start a process or read a
 * terminal: the tool runner and the y/N question in service-unit.ts, and the
 * login-item dialog in credential-prompt.ts.
 *
 * Nothing real is started and no dialog is shown: `node:child_process` is
 * mocked, so each spawn is captured and its result scripted, and the
 * "terminal" is a pair of in-memory streams.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const h = vi.hoisted(() => ({ spawn: vi.fn(), existing: new Set<string>() }));

vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, existsSync: (p: string) => h.existing.has(String(p)) };
});

import { runTool, askAtTerminal, terminalQuestion } from '../../packages/proxy/src/service-unit.js';
import { createNativePrompter, LOGIN_ITEM_MESSAGE } from '../../packages/proxy/src/credential-prompt.js';

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
}
let children: FakeChild[] = [];

function script(s: { code?: number | null; stdout?: string; stderr?: string; error?: Error; hang?: boolean }): void {
  h.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    children.push(child);
    if (!s.hang) {
      setImmediate(() => {
        if (s.error) { child.emit('error', s.error); return; }
        if (s.stdout) child.stdout.write(s.stdout);
        if (s.stderr) child.stderr.write(s.stderr);
        setImmediate(() => child.emit('close', s.code ?? 0));
      });
    }
    return child;
  });
}

beforeEach(() => { children = []; h.spawn.mockReset(); h.existing.clear(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('runTool', () => {
  it('starts the binary as given, with the argument array and exactly the environment it was handed, and no shell', async () => {
    script({ code: 0, stdout: 'pid = 12\n', stderr: 'note\n' });
    vi.stubEnv('AQUAMAN_ENCRYPTION_PASSWORD', 'not-for-the-tool');
    const r = await runTool('/bin/launchctl', ['print', 'gui/501/sh.aquaman.daemon; rm -rf ~'], { PATH: '/usr/bin:/bin' });
    expect(r).toEqual({ code: 0, stdout: 'pid = 12\n', stderr: 'note\n' });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    const [binary, args, options] = h.spawn.mock.calls[0];
    expect(binary).toBe('/bin/launchctl');
    expect(args).toEqual(['print', 'gui/501/sh.aquaman.daemon; rm -rf ~']);
    expect(options).toEqual({ stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    expect(options.shell).toBeUndefined();
  });

  it('reports a failing exit with what the tool printed', async () => {
    script({ code: 5, stderr: 'Bootstrap failed: 5: Input/output error\n' });
    expect(await runTool('/bin/launchctl', ['bootstrap', 'gui/501', '/x.plist'], {})).toEqual({ code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' });
  });

  it('a tool that cannot be started is a result, not an exception', async () => {
    script({ error: new Error('spawn /usr/bin/systemctl ENOENT') });
    expect(await runTool('/usr/bin/systemctl', ['--user', 'daemon-reload'], {})).toEqual({ code: null, stdout: '', stderr: 'spawn /usr/bin/systemctl ENOENT' });
  });

  it('stops keeping output past a bound, so a runaway tool cannot fill memory', async () => {
    script({ hang: true });
    const pending = runTool('/bin/launchctl', ['print', 'x'], {});
    const child = children[0];
    for (let i = 0; i < 40; i++) { child.stdout.write('o'.repeat(4096)); child.stderr.write('e'.repeat(4096)); }
    await new Promise((r) => setImmediate(r));
    child.emit('close', 0);
    const r = await pending;
    expect(r.stdout.length).toBeLessThan(40 * 4096);
    expect(r.stdout.length).toBeGreaterThan(65536);
    expect(r.stderr.length).toBeLessThan(40 * 4096);
  });

  it('kills a tool that hangs', async () => {
    vi.useFakeTimers();
    script({ hang: true });
    const pending = runTool('/bin/launchctl', ['bootout', 'x'], {});
    const child = children[0];
    await vi.advanceTimersByTimeAsync(29_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);
    expect(await pending).toEqual({ code: null, stdout: '', stderr: '' });
  });
});

describe('the y/N question at a terminal', () => {
  async function ask(typed: string | null): Promise<{ yes: boolean; shown: string }> {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (c: Buffer) => { shown += c.toString(); });
    const answer = askAtTerminal(input, output, '/h/Library/LaunchAgents/sh.aquaman.daemon.plist');
    if (typed === null) input.end();
    else input.write(typed);
    const yes = await answer;
    return { yes, shown };
  }

  it('shows what will be installed and where before reading the answer', async () => {
    const { shown } = await ask('n\n');
    expect(shown).toContain(terminalQuestion('/h/Library/LaunchAgents/sh.aquaman.daemon.plist'));
    expect(shown).toContain('start at every login');
    expect(shown).toContain('aquaman service uninstall');
  });

  it.each([
    ['y\n', true], ['Y\n', true], ['yes\n', true], ['  YES  \n', true],
    ['n\n', false], ['\n', false], ['no\n', false], ['yep\n', false], ['y n\n', false], ['1\n', false], ['true\n', false],
  ])('%j is %s', async (typed, expected) => {
    expect((await ask(typed)).yes).toBe(expected);
  });

  it('a terminal that closes without an answer is a no', async () => {
    expect((await ask(null)).yes).toBe(false);
  });
});

describe('the login-item dialog', () => {
  it('says the daemon will start at every login and keep running, and how to remove it; nothing in it comes from the caller', () => {
    expect(LOGIN_ITEM_MESSAGE).toBe(
      'A command is asking aquaman to start at every login and keep running in the background.\n\n' +
      'Allow adds a login item for the aquaman daemon to your account. Deny if you did not expect this.\n\n' +
      'To remove it later, run: aquaman service uninstall\n\n' +
      'aquaman never asks for your login, Apple ID or password-manager password.',
    );
  });

  describe('macOS', () => {
    const prompter = () => { h.existing.add('/usr/bin/osascript'); return createNativePrompter('darwin', 90); };

    it('is an approval with Deny as the default button, the message passed as an argument and never as script text', async () => {
      script({ code: 0, stdout: 'Allow\n' });
      expect(await prompter().askLoginItem({})).toEqual({ outcome: 'approved' });
      const [binary, args, options] = h.spawn.mock.calls[0];
      expect(binary).toBe('/usr/bin/osascript');
      expect(args[args.length - 1]).toBe(LOGIN_ITEM_MESSAGE);
      const scriptText = args.slice(0, -1).join('\n');
      expect(scriptText).toContain('buttons {"Deny", "Allow"} default button "Deny"');
      expect(scriptText).toContain('giving up after 90');
      expect(scriptText).not.toContain('default answer');
      expect(scriptText).not.toContain('every login');
      expect(options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: process.env['LANG'] ?? 'en_US.UTF-8' });
    });

    it('waits as long as the request says', async () => {
      script({ code: 0, stdout: 'Allow\n' });
      await prompter().askLoginItem({ timeoutSeconds: 20 });
      expect(h.spawn.mock.calls[0][1].join('\n')).toContain('giving up after 20');
    });

    it.each([
      ['Deny', { code: 0, stdout: 'Deny\n' }, { outcome: 'declined' }],
      ['anything that is not Allow', { code: 0, stdout: 'OK\n' }, { outcome: 'declined' }],
      ['a closed dialog', { code: 1, stderr: 'execution error: User canceled. (-128)' }, { outcome: 'declined' }],
      ['no answer', { code: 1, stderr: 'execution error: aquaman-timeout (9001)' }, { outcome: 'timeout' }],
      ['no desktop session', { code: 1, stderr: 'no window server' }, { outcome: 'unavailable', reason: expect.stringContaining('could not show a dialog') }],
    ])('%s is not an approval', async (_name, result, expected) => {
      script(result);
      expect(await prompter().askLoginItem({})).toEqual(expected);
    });

    it('answers unavailable when osascript is missing', async () => {
      expect(await createNativePrompter('darwin').askLoginItem({})).toEqual({ outcome: 'unavailable', reason: 'osascript is missing' });
      expect(h.spawn).not.toHaveBeenCalled();
    });
  });

  describe('Linux', () => {
    const prompter = () => {
      h.existing.add('/usr/bin/zenity');
      vi.stubEnv('DISPLAY', ':0');
      return createNativePrompter('linux', 90);
    };

    it('is a question with Deny as the default, shown without markup', async () => {
      script({ code: 0 });
      expect(await prompter().askLoginItem({ timeoutSeconds: 30 })).toEqual({ outcome: 'approved' });
      const [binary, args] = h.spawn.mock.calls[0];
      expect(binary).toBe('/usr/bin/zenity');
      expect(args).toEqual([
        '--question', '--no-markup', '--title=aquaman', '--timeout=30',
        '--ok-label=Allow', '--cancel-label=Deny', '--default-cancel', `--text=${LOGIN_ITEM_MESSAGE}`,
      ]);
    });

    it.each([
      ['Deny', 1, { outcome: 'declined' }],
      ['no answer', 5, { outcome: 'timeout' }],
      ['a dialog that could not be shown', 255, { outcome: 'unavailable', reason: 'could not show a dialog' }],
    ])('%s is not an approval', async (_name, code, expected) => {
      script({ code });
      expect(await prompter().askLoginItem({})).toEqual(expected);
    });

    it('answers unavailable without a desktop session', async () => {
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      expect(await createNativePrompter('linux').askLoginItem({})).toEqual({ outcome: 'unavailable', reason: expect.stringContaining('no desktop session') });
      expect(h.spawn).not.toHaveBeenCalled();
    });
  });
});
