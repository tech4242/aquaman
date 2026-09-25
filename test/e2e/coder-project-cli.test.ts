/**
 * E2E — `aquaman-coder project add|remove` edits projects.yaml without losing
 * bindings (issue #67). Through v0.15.x `project add` on an existing name
 * replaced the whole project, silently dropping its env bindings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

const CLI_PATH = path.resolve('packages/coder/src/cli/index.ts');

describe('aquaman-coder project add/remove', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-project-cli-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function run(...args: string[]) {
    const r = spawnSync('npx', ['tsx', CLI_PATH, 'project', ...args], {
      encoding: 'utf-8',
      env: { ...process.env, AQUAMAN_CONFIG_DIR: dir },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  }
  const project = (name: string) => parseYaml(fs.readFileSync(path.join(dir, 'projects.yaml'), 'utf-8')).projects[name];

  it('merges env bindings and paths into an existing project', () => {
    expect(run('add', 'app', '--path', '/code/app', '--env', 'GITHUB_TOKEN=aquaman://github/token').code).toBe(0);
    expect(run('add', 'app', '--env', 'OPENAI_API_KEY=aquaman://openai/api_key').code).toBe(0);
    expect(run('add', 'app', '--path', '/code/app-worktree', '--env', 'GITHUB_TOKEN=aquaman://github/bot_token').code).toBe(0);

    expect(project('app')).toEqual({
      paths: ['/code/app', '/code/app-worktree'],
      env: { GITHUB_TOKEN: 'aquaman://github/bot_token', OPENAI_API_KEY: 'aquaman://openai/api_key' },
    });
  }, 30_000);

  it('--replace keeps the old replace-the-project behavior', () => {
    run('add', 'app', '--path', '/code/app', '--env', 'GITHUB_TOKEN=aquaman://github/token');
    expect(run('add', 'app', '--replace', '--path', '/code/other', '--env', 'X=aquaman://x/y').code).toBe(0);
    expect(project('app')).toEqual({ paths: ['/code/other'], env: { X: 'aquaman://x/y' } });
  }, 30_000);

  it('remove --env drops one binding and keeps the project', () => {
    run('add', 'app', '--path', '/code/app', '--env', 'A=aquaman://a/k', '--env', 'B=aquaman://b/k');
    expect(run('remove', 'app', '--env', 'A').code).toBe(0);
    expect(project('app')).toEqual({ paths: ['/code/app'], env: { B: 'aquaman://b/k' } });

    const missing = run('remove', 'app', '--env', 'NOPE');
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('NOPE');
  }, 30_000);
});
