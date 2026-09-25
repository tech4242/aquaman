/**
 * Unit tests for the Codex adapter (v0.16.0).
 *
 * Asserts against Codex's hook protocol as read from openai/codex main on
 * 2026-09-23: shell calls arrive as tool_name "Bash" with
 * tool_input { command }, a rewrite is permissionDecision "allow" plus
 * updatedInput { command }, and invalid output fails OPEN (the unwrapped
 * command runs), so the rewrite payload carries nothing Codex might reject.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  handleCodexPreToolUse,
  handleCodexPostToolUse,
  installCodexHooks,
  uninstallCodexHooks,
  codexHookStatus,
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
