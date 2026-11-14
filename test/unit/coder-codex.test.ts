/**
 * Unit tests for the Codex adapter (v0.16.0).
 *
 * Asserts against Codex's hook protocol as read from openai/codex main on
 * 2026-09-23: shell calls arrive as tool_name "Bash" with
 * tool_input { command }, a rewrite is permissionDecision "allow" plus
 * updatedInput { command }, and invalid output fails OPEN (the unwrapped
 * command runs), so the rewrite payload carries nothing Codex might reject.
 */

import { describe, it, expect, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleCodexPreToolUse,
  handleCodexPostToolUse,
  installCodexHooks,
  uninstallCodexHooks,
  codexHookStatus,
  codexSandboxStatus,
  CODEX_HOOK_COMMAND,
} from 'aquaman-coder';

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-codex-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const healthy = { async health() { return { status: 'ok' }; } } as any;
const down = { async health() { throw new Error('proxy down'); } } as any;

function projects(cwd: string): string {
  const p = path.join(tmpDir(), 'projects.yaml');
  fs.writeFileSync(p, `version: 1\nprojects:\n  app:\n    paths: ["${cwd}"]\n    env:\n      GITHUB_TOKEN: aquaman://github/token\n`);
  return p;
}

function codexEvent(command: string, cwd: string) {
  return {
    session_id: 's', turn_id: 't', transcript_path: null, cwd,
    hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default',
    tool_name: 'Bash', tool_input: { command }, tool_use_id: 'call_1',
  };
}

describe('handleCodexPreToolUse', () => {
  it('rewrites a Bash call with exactly allow + updatedInput.command', async () => {
    const cwd = tmpDir();
    const decision = await handleCodexPreToolUse(codexEvent('npm publish', cwd), {
      broker: healthy, projectsPath: projects(cwd),
    });
    expect(decision).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { command: `aquaman-coder exec -- sh -c 'npm publish'` },
      },
    });
  });

  it('denies with a non-empty reason when the proxy is down', async () => {
    const cwd = tmpDir();
    const decision = await handleCodexPreToolUse(codexEvent('npm publish', cwd), {
      broker: down, projectsPath: projects(cwd),
    });
    expect(decision?.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: expect.stringContaining('aquaman daemon'),
    });
  });

  it('is a no-op outside a configured project', async () => {
    const decision = await handleCodexPreToolUse(codexEvent('ls', tmpDir()), {
      broker: healthy, projectsPath: projects('/nonexistent-aquaman-project'),
    });
    expect(decision).toBeNull();
  });
});

describe('handleCodexPostToolUse', () => {
  it('warns via additionalContext and never sends a rewrite field Codex rejects', () => {
    const decision = handleCodexPostToolUse({
      hook_event_name: 'PostToolUse', tool_name: 'Bash',
      tool_response: 'token: ghp_' + 'a'.repeat(36),
    });
    const out = decision?.hookSpecificOutput as Record<string, unknown>;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.additionalContext).toMatch(/github-token/);
    expect(out).not.toHaveProperty('updatedToolOutput');
    expect(out).not.toHaveProperty('updatedMCPToolOutput');
    expect(String(out.additionalContext)).not.toContain('ghp_');
  });

  it('is silent on clean output', () => {
    expect(handleCodexPostToolUse({ hook_event_name: 'PostToolUse', tool_response: 'ok' })).toBeNull();
  });
});

describe('Codex hooks.json setup', () => {
  it('installs Bash-matched PreToolUse and PostToolUse handlers, idempotently', () => {
    const hooksPath = path.join(tmpDir(), 'hooks.json');
    const first = installCodexHooks({ hooksPath });
    expect(first.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(hooksPath, 'utf-8'));
    // Codex rejects unknown top-level fields in hooks.json.
    expect(Object.keys(written)).toEqual(['hooks']);
    for (const event of ['PreToolUse', 'PostToolUse']) {
      expect(written.hooks[event]).toEqual([
        { matcher: 'Bash', hooks: [{ type: 'command', command: CODEX_HOOK_COMMAND, timeout: 30 }] },
      ]);
    }
    expect(installCodexHooks({ hooksPath }).changed).toBe(false);
  });

  it('keeps unrelated hooks on install and uninstall', () => {
    const hooksPath = path.join(tmpDir(), 'hooks.json');
    const theirs = { matcher: 'Write', hooks: [{ type: 'command', command: 'lint-it' }] };
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: { PreToolUse: [theirs] } }));
    installCodexHooks({ hooksPath });
    uninstallCodexHooks({ hooksPath });
    expect(JSON.parse(fs.readFileSync(hooksPath, 'utf-8'))).toEqual({ hooks: { PreToolUse: [theirs] } });
  });

  it('reports installed-but-untrusted until config.toml holds the trust key', () => {
    const dir = tmpDir();
    const hooksPath = path.join(dir, 'hooks.json');
    const configPath = path.join(dir, 'config.toml');
    expect(codexHookStatus(hooksPath, configPath)).toEqual({ installed: false, trusted: false });

    installCodexHooks({ hooksPath });
    expect(codexHookStatus(hooksPath, configPath)).toEqual({ installed: true, trusted: false });

    fs.writeFileSync(configPath, `[hooks.state."${hooksPath}:pre_tool_use:0:0"]\ntrusted_hash = "sha256:abc"\n`);
    expect(codexHookStatus(hooksPath, configPath)).toEqual({ installed: true, trusted: true });
  });
});

// Every expectation here was checked against `codex sandbox` 0.169.0 on macOS
// (2026-11-14) by connecting to a real socket under each config: the states
// marked ok connected, the others returned EPERM.
describe('codexSandboxStatus', () => {
  // A real directory: the match resolves symlinks (macOS /tmp -> /private/tmp).
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-codex-sock-'));
  const socket = path.join(socketDir, 'proxy.sock');
  afterAll(() => fs.rmSync(socketDir, { recursive: true, force: true }));
  const status = (toml: string | null) => {
    const configPath = path.join(tmpDir(), 'config.toml');
    if (toml !== null) fs.writeFileSync(configPath, toml);
    return codexSandboxStatus(socket, configPath);
  };
  const profile = (network: string) =>
    `default_permissions = "aquaman"\n[permissions.aquaman]\nextends = ":workspace"\n[permissions.aquaman.network]\n${network}\n`;

  it('fails when config.toml is missing, empty or unparseable', () => {
    expect(status(null)).toMatchObject({ ok: false, detail: expect.stringContaining('does not exist') });
    expect(status('')).toMatchObject({ ok: false, detail: expect.stringContaining('no permissions profile') });
    expect(status('default_permissions = ')).toMatchObject({ ok: false, detail: expect.stringContaining('cannot parse') });
  });

  it('fails for a profile that lists the socket without enabling network', () => {
    expect(status(profile(`unix_sockets = { "${socket}" = "allow" }`))).toMatchObject({
      ok: false, detail: expect.stringContaining('enabled = true'),
    });
  });

  it('passes for the snippet setup prints', () => {
    expect(status(profile(`enabled = true\nunix_sockets = { "${socket}" = "allow" }`))).toMatchObject({
      ok: true, detail: expect.stringContaining('allows the proxy socket'),
    });
    // A parent directory covers the socket, as in the sandbox itself.
    expect(status(profile(`enabled = true\nunix_sockets = { "${socketDir}" = "allow" }`)).detail).toContain('allows the proxy socket');
    expect(status(profile('enabled = true\ndangerously_allow_all_unix_sockets = true')).detail).toContain('allows the proxy socket');
  });

  it('passes with a caveat when network is enabled but the socket is not listed', () => {
    expect(status(profile('enabled = true'))).toMatchObject({ ok: true, detail: expect.stringContaining('older Codex') });
  });

  it('fails for built-in profiles, an undefined profile and a profile that is not the default', () => {
    expect(status('default_permissions = ":workspace"\n').ok).toBe(false);
    expect(status('default_permissions = "nope"\n')).toMatchObject({ ok: false, detail: expect.stringContaining('not defined') });
    expect(status(`[permissions.aquaman.network]\nenabled = true\nunix_sockets = { "${socket}" = "allow" }\n`).ok).toBe(false);
  });

  it('accepts the legacy sandbox_mode settings and says they are legacy', () => {
    expect(status('sandbox_mode = "danger-full-access"\n').ok).toBe(true);
    expect(status('sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n')).toMatchObject({
      ok: true, detail: expect.stringContaining('0.156.1'),
    });
    expect(status('sandbox_mode = "workspace-write"\n').ok).toBe(false);
    expect(status('[sandbox_workspace_write]\nnetwork_access = true\n').ok).toBe(false);
  });
});
