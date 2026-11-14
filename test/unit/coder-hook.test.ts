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
import { spawnSync } from 'node:child_process';
import { handlePreToolUse, handlePostToolUse, withPermissionTail, type HookContext } from 'aquaman-coder';

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

  // Claude Code >= 2.1.290 matches permission rules against the rewritten
  // command and never looks inside `sh -c`. Verified live on 2.1.325: without
  // the tail a `deny` rule on the original command stopped applying inside an
  // aquaman project. The original must stay in the text as its own statement,
  // after an `exit` that keeps the shell from ever running it.
  it('keeps the original command visible to permission rules, after an exit', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:\n  my-app:\n    paths: ["${cwdDir}"]\n    env:\n      GITHUB_TOKEN: aquaman://github/token\n`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({}));
    tmp = path.dirname(ctx.projectsPath!);
    const original = `git push origin main && echo "it's done"`;
    const result = await handlePreToolUse({ tool_name: 'Bash', tool_input: { command: original, timeout: 5000 }, cwd: cwdDir }, ctx);
    const out = result?.hookSpecificOutput as any;
    const lines = (out.updatedInput.command as string).split('\n');
    expect(lines[0]).toBe(`aquaman-coder exec -- sh -c 'git push origin main && echo "it'\\''s done"'`);
    // A bare `exit`: `exit $?` makes Claude Code refuse to pre-check the command.
    expect(lines[1]).toBe('exit');
    expect(lines.slice(2).join('\n')).toBe(original);
    // Other input fields survive: updatedInput replaces the whole object.
    expect(out.updatedInput.timeout).toBe(5000);
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('the shell never runs the tail, and the wrapper status is the exit status', () => {
    const run = (wrapped: string) =>
      spawnSync('sh', ['-c', withPermissionTail(wrapped, 'echo TAIL-RAN')], { encoding: 'utf-8' });
    const ok = run(`sh -c 'echo wrapped; exit 7'`);
    expect(ok.stdout).toBe('wrapped\n');
    expect(ok.status).toBe(7);
    // A wrapper that cannot start must not fall through to the original.
    const missing = run('aquaman-no-such-binary exec -- true');
    expect(missing.stdout).toBe('');
    expect(missing.status).toBe(127);
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

  it('rewrites string output via updatedToolOutput with secrets redacted', () => {
    const token = 'ghp_' + 'a'.repeat(36);
    const result = handlePostToolUse({
      tool_response: `token=${token} rest-of-line`,
    });
    const out = result?.hookSpecificOutput as any;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.updatedToolOutput).toBe('token=[REDACTED:github-token] rest-of-line');
    expect(out.updatedToolOutput).not.toContain(token);
    expect(out.additionalContext).toContain('github-token');
  });

  it('deep-redacts structured tool responses preserving their shape', () => {
    const result = handlePostToolUse({
      tool_response: {
        stdout: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n',
        lines: ['clean', 'sk-ant-' + 'b'.repeat(40)],
        exitCode: 0,
      },
    });
    const out = result?.hookSpecificOutput as any;
    expect(out.additionalContext).toContain('aws-access-key-id');
    expect(out.updatedToolOutput).toEqual({
      stdout: 'AWS_KEY=[REDACTED:aws-access-key-id]\n',
      lines: ['clean', '[REDACTED:anthropic-key]'],
      exitCode: 0,
    });
  });

  it('falls back to warning-only when output rewriting is disabled', () => {
    const result = handlePostToolUse(
      { tool_response: 'token=ghp_' + 'a'.repeat(36) },
      { disableOutputRewrite: true }
    );
    const out = result?.hookSpecificOutput as any;
    expect(out.hookEventName).toBe('PostToolUse');
    expect(out.updatedToolOutput).toBeUndefined();
    expect(out.additionalContext).toContain('secret patterns');
    expect(out.additionalContext).toContain('aquaman-coder exec');
  });
});

/**
 * Claude Code 2.1.210 fixed exit-2 handling when a hook's stdout JSON
 * fails schema validation — malformed hook output now surfaces instead
 * of being silently ignored. Lock down that every decision we emit is
 * strictly schema-shaped: known fields only, correct types, hookEventName
 * matching the event.
 */
describe('hook output schema validity (Claude Code ≥2.1.210)', () => {
  const PRE_FIELDS = new Set([
    'hookEventName', 'permissionDecision', 'permissionDecisionReason',
    'updatedInput', 'additionalContext',
  ]);
  const POST_FIELDS = new Set([
    'hookEventName', 'additionalContext', 'updatedToolOutput',
  ]);

  it('PreToolUse decisions carry only documented hookSpecificOutput fields', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env:
      X: aquaman://anthropic/api_key
`;
    for (const healthy of [true, false]) {
      const { ctx } = ctxWithProjects(yaml, new StubBroker({}, healthy));
      const result = await handlePreToolUse({
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        cwd: cwdDir,
      }, ctx);
      const out = result?.hookSpecificOutput as any;
      expect(out).toBeDefined();
      expect(out.hookEventName).toBe('PreToolUse');
      for (const key of Object.keys(out)) {
        expect(PRE_FIELDS.has(key), `unexpected PreToolUse field: ${key}`).toBe(true);
      }
      expect(['allow', 'deny', 'ask']).toContain(out.permissionDecision);
      if (out.updatedInput !== undefined) {
        expect(typeof out.updatedInput).toBe('object');
        expect(typeof out.updatedInput.command).toBe('string');
      }
      fs.rmSync(path.dirname(ctx.projectsPath!), { recursive: true, force: true });
    }
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('PostToolUse decisions carry only documented hookSpecificOutput fields', () => {
    for (const ctx of [{}, { disableOutputRewrite: true }]) {
      const result = handlePostToolUse(
        { tool_response: 'sk-ant-' + 'c'.repeat(40) },
        ctx
      );
      const out = result?.hookSpecificOutput as any;
      expect(out.hookEventName).toBe('PostToolUse');
      for (const key of Object.keys(out)) {
        expect(POST_FIELDS.has(key), `unexpected PostToolUse field: ${key}`).toBe(true);
      }
      expect(typeof out.additionalContext).toBe('string');
    }
  });

  it('decisions serialize to valid JSON round-trips (stdout contract)', () => {
    const decision = handlePostToolUse({
      tool_response: { nested: { key: 'xoxb-1234567890-abcdef' } },
    });
    const serialized = JSON.stringify(decision);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toEqual(decision);
  });
});
