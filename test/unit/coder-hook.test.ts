/**
 * Unit tests for the Claude Code hook handlers.
 *
 * Asserts against Claude Code's real hook protocol (verified against
 * https://code.claude.com/docs/en/hooks): updatedInput rewriting on
 * PreToolUse + additionalContext-only on PostToolUse.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handlePreToolUse, handlePostToolUse, type HookContext } from 'aquaman-coder';

class StubBroker {
  values: Record<string, string>;
  healthy: boolean;
  constructor(values: Record<string, string>, healthy = true) {
    this.values = values;
    this.healthy = healthy;
  }
  async resolve({ service, key }: { service: string; key: string }) {
    const v = this.values[`${service}/${key}`];
    if (!v) throw new Error(`No credential for ${service}/${key}`);
    return { value: v, expiresAt: new Date(Date.now() + 60000).toISOString() };
  }
  async health() {
    if (!this.healthy) throw new Error('proxy down');
    return { status: 'ok' };
  }
}

function ctxWithProjects(yaml: string, broker: any, wrapperPrefix?: string): { ctx: HookContext; tmp: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-hook-test-'));
  const projectsPath = path.join(tmpDir, 'projects.yaml');
  fs.writeFileSync(projectsPath, yaml);
  return { ctx: { broker, projectsPath, wrapperPrefix }, tmp: tmpDir };
}

describe('handlePreToolUse', () => {
  let tmp: string;
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns null for non-Bash tools', async () => {
    const { ctx } = ctxWithProjects('projects: {}', new StubBroker({}));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({ tool_name: 'Read', cwd: '/tmp' }, ctx);
    expect(result).toBeNull();
  });

  it('returns null when no project matches cwd', async () => {
    const yaml = `projects:
  my-app:
    paths: ["/tmp/my-app"]
    env:
      X: aquaman://anthropic/api_key
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({ 'anthropic/api_key': 'sk-ant-X' }));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({ tool_name: 'Bash', cwd: '/var/elsewhere' }, ctx);
    expect(result).toBeNull();
  });

  it('rewrites the Bash command to wrap with aquaman-coder exec', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({}));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'curl https://api.github.com' },
      cwd: cwdDir,
    }, ctx);
    const out = result?.hookSpecificOutput as any;
    expect(out.hookEventName).toBe('PreToolUse');
    expect(out.permissionDecision).toBe('allow');
    expect(out.updatedInput.command).toContain('aquaman-coder exec --');
    expect(out.updatedInput.command).toContain('curl https://api.github.com');
    expect(out.additionalContext).toContain('ANTHROPIC_API_KEY');
    expect(out.additionalContext).toContain('GITHUB_TOKEN');
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('does not re-wrap a command already running under the wrapper', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env:
      X: aquaman://anthropic/api_key
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({}));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'aquaman-coder exec -- echo hi' },
      cwd: cwdDir,
    }, ctx);
    expect(result).toBeNull();
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('denies the call when the broker proxy is unreachable', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env:
      X: aquaman://anthropic/api_key
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({}, false));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      cwd: cwdDir,
    }, ctx);
    const out = result?.hookSpecificOutput as any;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason).toContain('proxy not reachable');
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('skips wrapping when the project has no env bindings', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env: {}
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({}));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      cwd: cwdDir,
    }, ctx);
    expect(result).toBeNull();
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });
});

describe('handlePostToolUse', () => {
  it('returns null when output has no secrets', () => {
    const result = handlePostToolUse({ tool_response: 'hello world' });
    expect(result).toBeNull();
  });

  it('emits additionalContext warning when secrets are found', () => {
    const result = handlePostToolUse({
      tool_response: 'token=ghp_' + 'a'.repeat(36),
    });
    const out = result?.hookSpecificOutput as any;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.additionalContext).toContain('secret patterns');
    expect(out.additionalContext).toContain('github-token');
  });

  it('handles JSON tool responses', () => {
    const result = handlePostToolUse({
      tool_response: { stdout: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n' },
    });
    expect(result).not.toBeNull();
    const out = result?.hookSpecificOutput as any;
    expect(out.additionalContext).toContain('aws-access-key-id');
  });
});
