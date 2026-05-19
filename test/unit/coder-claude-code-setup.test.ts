/**
 * Unit tests for installClaudeCodeHooks / uninstallClaudeCodeHooks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installClaudeCodeHooks, uninstallClaudeCodeHooks } from 'aquaman-coder';

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
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('aquaman-coder hook');
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('aquaman-coder hook');
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
