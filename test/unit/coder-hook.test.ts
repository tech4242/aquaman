/**
 * Unit tests for the Claude Code hook handlers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handlePreToolUse, handlePostToolUse, type HookContext } from 'aquaman-coder';

class StubBroker {
  values: Record<string, string>;
  constructor(values: Record<string, string>) { this.values = values; }
  async resolve({ service, key }: { service: string; key: string }) {
    const v = this.values[`${service}/${key}`];
    if (!v) throw new Error(`No credential for ${service}/${key}`);
    return { value: v, expiresAt: new Date(Date.now() + 60000).toISOString() };
  }
  async health() { return { status: 'ok' }; }
}

function ctxWithProjects(yaml: string, broker: any): { ctx: HookContext; tmp: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-hook-test-'));
  const projectsPath = path.join(tmpDir, 'projects.yaml');
  fs.writeFileSync(projectsPath, yaml);
  return { ctx: { broker, projectsPath }, tmp: tmpDir };
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

  it('injects env vars when project matches and broker resolves', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env:
      ANTHROPIC_API_KEY: aquaman://anthropic/api_key
      GITHUB_TOKEN: aquaman://github/token
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({
      'anthropic/api_key': 'sk-ant-real',
      'github/token': 'ghp_real_token',
    }));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({ tool_name: 'Bash', cwd: cwdDir }, ctx);
    expect(result?.hookSpecificOutput).toBeDefined();
    const env = (result!.hookSpecificOutput as any).additionalEnvVars;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-real');
    expect(env.GITHUB_TOKEN).toBe('ghp_real_token');
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });

  it('blocks the command when the broker fails', async () => {
    const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-'));
    const yaml = `projects:
  my-app:
    paths: ["${cwdDir}"]
    env:
      X: aquaman://missing/key
`;
    const { ctx } = ctxWithProjects(yaml, new StubBroker({}));
    tmp = path.dirname(ctx.projectsPath!);
    const result = await handlePreToolUse({ tool_name: 'Bash', cwd: cwdDir }, ctx);
    expect(result?.decision).toBe('block');
    expect(result?.reason).toContain('failed to resolve X');
    fs.rmSync(cwdDir, { recursive: true, force: true });
  });
});

describe('handlePostToolUse', () => {
  it('returns null when output has no secrets', () => {
    const result = handlePostToolUse({ tool_output: 'hello world' });
    expect(result).toBeNull();
  });

  it('redacts secrets and returns updatedToolOutput', () => {
    const result = handlePostToolUse({
      tool_output: 'token=ghp_' + 'a'.repeat(36),
    });
    expect(result?.hookSpecificOutput).toBeDefined();
    const out = (result!.hookSpecificOutput as any).updatedToolOutput;
    expect(out).toContain('[REDACTED:github-token]');
    expect(out).not.toContain('ghp_aaaa');
  });

  it('redacts secrets inside JSON tool output', () => {
    const result = handlePostToolUse({
      tool_output: { stdout: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n' },
    });
    expect(result).not.toBeNull();
    const out = (result!.hookSpecificOutput as any).updatedToolOutput;
    expect(out).toContain('[REDACTED:aws-access-key-id]');
  });
});
