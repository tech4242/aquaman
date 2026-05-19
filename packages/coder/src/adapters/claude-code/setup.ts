/**
 * Claude Code setup — writes the hook configuration into
 * `~/.claude/settings.json` so Claude Code invokes aquaman-coder on
 * each tool call.
 *
 * Never overwrites unrelated keys. Atomic write via .tmp + rename.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeSettings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>>;
  apiKeyHelper?: string;
  [key: string]: unknown;
}

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export interface SetupOptions {
  settingsPath?: string;
  hookCommand?: string;
}

export interface SetupResult {
  path: string;
  changed: boolean;
  before: ClaudeSettings | null;
  after: ClaudeSettings;
}

/**
 * Ensure ~/.claude/settings.json has PreToolUse + PostToolUse hooks
 * pointing at `aquaman-coder hook`.
 */
export function installClaudeCodeHooks(opts: SetupOptions = {}): SetupResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const hookCommand = opts.hookCommand ?? 'aquaman-coder hook';

  const dir = path.dirname(settingsPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let before: ClaudeSettings | null = null;
  let settings: ClaudeSettings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    try {
      before = JSON.parse(raw) as ClaudeSettings;
      settings = JSON.parse(raw) as ClaudeSettings;
    } catch (err) {
      throw new Error(`Existing ${settingsPath} is not valid JSON: ${(err as Error).message}`);
    }
  }

  settings.hooks = settings.hooks ?? {};

  for (const event of ['PreToolUse', 'PostToolUse']) {
    const list = settings.hooks[event] ?? [];
    const alreadyInstalled = list.some((entry) =>
      entry.hooks?.some((h) => h.command === hookCommand)
    );
    if (alreadyInstalled) continue;

    list.push({
      matcher: '*',
      hooks: [{ type: 'command', command: hookCommand }],
    });
    settings.hooks[event] = list;
  }

  const after = settings;
  const changed = JSON.stringify(before) !== JSON.stringify(after);

  if (changed) {
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(after, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  }

  return { path: settingsPath, changed, before, after };
}

/**
 * Remove aquaman-coder hooks from settings.json.
 */
export function uninstallClaudeCodeHooks(opts: SetupOptions = {}): SetupResult {
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  const hookCommand = opts.hookCommand ?? 'aquaman-coder hook';

  if (!fs.existsSync(settingsPath)) {
    return { path: settingsPath, changed: false, before: null, after: {} };
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  const before = JSON.parse(raw) as ClaudeSettings;
  const settings = JSON.parse(raw) as ClaudeSettings;

  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = settings.hooks[event]
        .map((entry) => ({
          ...entry,
          hooks: entry.hooks.filter((h) => h.command !== hookCommand),
        }))
        .filter((entry) => entry.hooks.length > 0);
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }

  const changed = JSON.stringify(before) !== JSON.stringify(settings);
  if (changed) {
    const tmp = settingsPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, settingsPath);
  }

  return { path: settingsPath, changed, before, after: settings };
}
