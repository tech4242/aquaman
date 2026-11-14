/**
 * Unit tests for installClaudeCodeHooks / uninstallClaudeCodeHooks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  installClaudeCodeHooks, uninstallClaudeCodeHooks, socketAllowedByEntry, sandboxSocketStatus,
  claudeHookFailsClosed, versionAtLeast, ON_FAILURE_MIN_VERSION,
} from 'aquaman-coder';

describe('aquaman-coder / claude-code setup', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-claude-test-'));
    settingsPath = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('creates settings.json with PreToolUse + PostToolUse hooks', () => {
    const result = installClaudeCodeHooks({ settingsPath });
    expect(result.changed).toBe(true);
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('aquaman coder hook');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('aquaman coder hook');
  });

  // `onFailure: "block"` (Claude Code >= 2.1.295) is opt-in: verified live on
  // 2.1.325 that with it a hook that cannot start blocks the Bash call, and
  // without it the call runs.
  it('fail-closed is off by default, set on PreToolUse only, and reversible', () => {
    installClaudeCodeHooks({ settingsPath });
    expect(claudeHookFailsClosed(settingsPath)).toBe(false);
    expect(fs.readFileSync(settingsPath, 'utf-8')).not.toContain('onFailure');

    // Applies to an existing install, and leaves a foreign hook alone.
    const withForeign = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    withForeign.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool check' }] });
    fs.writeFileSync(settingsPath, JSON.stringify(withForeign));
    expect(installClaudeCodeHooks({ settingsPath, failClosed: true }).changed).toBe(true);
    const on = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(on.hooks.PreToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'other-tool check' });
    expect(on.hooks.PreToolUse[1].hooks[0]).toEqual({ type: 'command', command: 'aquaman coder hook', onFailure: 'block' });
    expect(on.hooks.PostToolUse[0].hooks[0]).toEqual({ type: 'command', command: 'aquaman coder hook' });
    expect(claudeHookFailsClosed(settingsPath)).toBe(true);

    // A plain re-run keeps the choice; --no-fail-closed removes it.
    expect(installClaudeCodeHooks({ settingsPath }).changed).toBe(false);
    installClaudeCodeHooks({ settingsPath, failClosed: false });
    expect(claudeHookFailsClosed(settingsPath)).toBe(false);
  });

  it('versionAtLeast compares dotted versions numerically', () => {
    expect(versionAtLeast('2.1.325', ON_FAILURE_MIN_VERSION)).toBe(true);
    expect(versionAtLeast('2.1.295', ON_FAILURE_MIN_VERSION)).toBe(true);
    expect(versionAtLeast('2.1.99', ON_FAILURE_MIN_VERSION)).toBe(false);
    expect(versionAtLeast('2.2.0', ON_FAILURE_MIN_VERSION)).toBe(true);
    expect(versionAtLeast('garbage', ON_FAILURE_MIN_VERSION)).toBe(false);
  });

  it('preserves unrelated settings keys', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'claude-sonnet-4', theme: 'dark' }, null, 2),
    );
    installClaudeCodeHooks({ settingsPath });

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.model).toBe('claude-sonnet-4');
    expect(settings.theme).toBe('dark');
    expect(settings.hooks).toBeDefined();
  });

  it('is idempotent — re-running does not duplicate the hook', () => {
    installClaudeCodeHooks({ settingsPath });
    const r2 = installClaudeCodeHooks({ settingsPath });
    expect(r2.changed).toBe(false);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse.length).toBe(1);
    expect(settings.hooks.PostToolUse.length).toBe(1);
  });

  it('settings.json is mode 0o600', () => {
    installClaudeCodeHooks({ settingsPath });
    const mode = fs.statSync(settingsPath).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it('uninstall removes the aquaman entries but preserves others', () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '*', hooks: [{ type: 'command', command: 'other-hook' }] },
            { matcher: '*', hooks: [{ type: 'command', command: 'aquaman-coder hook' }] },
          ],
        },
      }, null, 2),
    );

    const r = uninstallClaudeCodeHooks({ settingsPath });
    expect(r.changed).toBe(true);

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.PreToolUse.length).toBe(1);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('other-hook');
  });

  it('uninstall is a no-op when nothing is installed', () => {
    const r = uninstallClaudeCodeHooks({ settingsPath });
    expect(r.changed).toBe(false);
  });

  it('rejects existing invalid JSON', () => {
    fs.writeFileSync(settingsPath, '{ not valid json');
    expect(() => installClaudeCodeHooks({ settingsPath })).toThrow(/not valid JSON/);
  });
});

/**
 * v0.15.0: Claude Code's sandbox denies Unix-socket connects by default, so a
 * sandboxed `aquaman-coder exec` can't reach the broker. On macOS setup
 * allowlists exactly the proxy socket. On Linux/WSL2 the allowlist is
 * ignored, so setup leaves the sandbox alone. Semantics verified against
 * @anthropic-ai/sandbox-runtime 0.0.76 (the runtime Claude Code embeds) on
 * 2026-09-18: exact path and parent-directory entries match; globs don't.
 */
describe('aquaman-coder / claude-code setup — sandbox socket allowance', () => {
  let tmpDir: string;
  let settingsPath: string;
  let socketPath: string;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-claude-sb-')));
    settingsPath = path.join(tmpDir, 'settings.json');
    socketPath = path.join(tmpDir, '.aquaman', 'proxy.sock');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

  it('on macOS adds exactly the proxy socket to sandbox.network.allowUnixSockets', () => {
    const r = installClaudeCodeHooks({ settingsPath, socketPath, platform: 'darwin' });
    expect(r.sandboxSocket).toBe('added');
    const s = read();
    expect(s.sandbox.network.allowUnixSockets).toEqual([socketPath]);
    // Never flips the sandbox itself or widens it.
    expect(s.sandbox.enabled).toBeUndefined();
    expect(s.sandbox.network.allowAllUnixSockets).toBeUndefined();
  });

  it('is idempotent and keeps the user’s other sockets and sandbox settings', () => {
    fs.writeFileSync(settingsPath, JSON.stringify({
      sandbox: { enabled: true, network: { allowUnixSockets: ['/var/run/docker.sock'], allowedDomains: ['github.com'] } },
    }));
    installClaudeCodeHooks({ settingsPath, socketPath, platform: 'darwin' });
    const r2 = installClaudeCodeHooks({ settingsPath, socketPath, platform: 'darwin' });
    expect(r2.sandboxSocket).toBe('present');
    expect(r2.changed).toBe(false);
    const s = read();
    expect(s.sandbox.enabled).toBe(true);
    expect(s.sandbox.network.allowedDomains).toEqual(['github.com']);
    expect(s.sandbox.network.allowUnixSockets).toEqual(['/var/run/docker.sock', socketPath]);
  });

  it('treats a parent-directory entry, a ~ entry, or allowAllUnixSockets as already covering the socket', () => {
    for (const network of [
      { allowUnixSockets: [path.dirname(socketPath)] },
      { allowAllUnixSockets: true },
    ]) {
      fs.writeFileSync(settingsPath, JSON.stringify({ sandbox: { network } }));
      expect(installClaudeCodeHooks({ settingsPath, socketPath, platform: 'darwin' }).sandboxSocket).toBe('present');
    }
    expect(socketAllowedByEntry('~/.aquaman/proxy.sock', path.join(os.homedir(), '.aquaman', 'proxy.sock'))).toBe(true);
  });

  it('does not count glob entries (the sandbox does not expand them)', () => {
    expect(socketAllowedByEntry(path.join(tmpDir, '*', 'proxy.sock'), socketPath)).toBe(false);
    expect(socketAllowedByEntry(path.join(tmpDir, '.aqua'), socketPath)).toBe(false); // prefix, not a parent dir
  });

  it('leaves the sandbox untouched on Linux/WSL2, where allowUnixSockets is ignored', () => {
    const r = installClaudeCodeHooks({ settingsPath, socketPath, platform: 'linux' });
    expect(r.sandboxSocket).toBe('unsupported-platform');
    expect(read().sandbox).toBeUndefined();
  });

  it('uninstall removes only the entry setup added and prunes what it emptied', () => {
    installClaudeCodeHooks({ settingsPath, socketPath, platform: 'darwin' });
    const r = uninstallClaudeCodeHooks({ settingsPath, socketPath });
    expect(r.sandboxSocket).toBe('removed');
    expect(read().sandbox).toBeUndefined();

    fs.writeFileSync(settingsPath, JSON.stringify({
      sandbox: { enabled: true, network: { allowUnixSockets: ['/var/run/docker.sock', socketPath] } },
    }));
    uninstallClaudeCodeHooks({ settingsPath, socketPath });
    expect(read().sandbox).toEqual({ enabled: true, network: { allowUnixSockets: ['/var/run/docker.sock'] } });
  });

  describe('sandboxSocketStatus (doctor)', () => {
    const write = (name: string, obj: unknown) => {
      const p = path.join(tmpDir, name);
      fs.writeFileSync(p, JSON.stringify(obj));
      return p;
    };

    it('merges allowlists across settings files like Claude Code does', () => {
      const user = write('user.json', { sandbox: { enabled: true } });
      const project = write('project.json', { sandbox: { network: { allowUnixSockets: [socketPath] } } });
      expect(sandboxSocketStatus([user], socketPath, 'darwin')).toMatchObject({ sandboxEnabled: true, socketAllowed: false });
      expect(sandboxSocketStatus([user, project], socketPath, 'darwin')).toMatchObject({ sandboxEnabled: true, socketAllowed: true });
    });

    it('on Linux only allowAllUnixSockets makes the socket reachable', () => {
      const listed = write('listed.json', { sandbox: { enabled: true, network: { allowUnixSockets: [socketPath] } } });
      expect(sandboxSocketStatus([listed], socketPath, 'linux').socketAllowed).toBe(false);
      const all = write('all.json', { sandbox: { enabled: true, network: { allowAllUnixSockets: true } } });
      expect(sandboxSocketStatus([all], socketPath, 'linux').socketAllowed).toBe(true);
    });

    it('ignores missing and malformed files', () => {
      const bad = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(bad, '{not json');
      const st = sandboxSocketStatus([bad, path.join(tmpDir, 'missing.json')], socketPath, 'darwin');
      expect(st).toEqual({ sandboxEnabled: false, socketAllowed: false, sources: [] });
    });
  });
});
