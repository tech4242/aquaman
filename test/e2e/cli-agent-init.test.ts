/**
 * E2E: the commands an agent runs on its own. `aquaman-coder init` and `bind`
 * must work without prompts, be safe to repeat, and print one JSON object;
 * `aquaman request` must fail with a status an agent can act on when there is
 * no daemon.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

const CODER_CLI = path.resolve('packages/coder/src/cli/index.ts');
const PROXY_CLI = path.resolve('packages/proxy/src/cli/index.ts');
const TSX = path.resolve('node_modules/.bin/tsx');

describe('agent-run setup commands', () => {
  let root: string;
  let home: string;
  let config: string;
  let project: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-agent-init-')));
    home = path.join(root, 'home');
    config = path.join(root, 'aq');
    project = path.join(root, 'My App');
    for (const d of [home, config, project]) fs.mkdirSync(d);
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function run(cli: string, args: string[], cwd = project) {
    const r = spawnSync(TSX, [cli, ...args], {
      cwd,
      encoding: 'utf-8',
      // stdin closed: a command that tried to prompt would hang or fail here.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), AQUAMAN_CONFIG_DIR: config, NO_COLOR: '1' },
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  const projects = () => parseYaml(fs.readFileSync(path.join(config, 'projects.yaml'), 'utf-8')).projects;

  it('init --agent claude-code sets everything up and says so in JSON', () => {
    const r = run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      ok: true,
      agent: 'claude-code',
      project: { name: 'my-app', path: project, created: true },
      hooks: { path: path.join(home, '.claude', 'settings.json'), changed: true },
      skill: { path: path.join(home, '.claude', 'skills', 'aquaman-credentials', 'SKILL.md'), changed: true },
      agents_file: { path: path.join(project, 'CLAUDE.md'), action: 'created' },
    });
    expect(out.human_steps.join(' ')).toMatch(/restart Claude Code/);
    expect(projects()['my-app']).toEqual({ paths: [project], env: {} });
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')).toContain('aquaman coder hook');
    expect(fs.existsSync(out.skill.path)).toBe(true);
  }, 60_000);

  it('running init again changes nothing', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    const before = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8');
    const out = JSON.parse(run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']).stdout);
    expect(out).toMatchObject({
      ok: true,
      project: { name: 'my-app', created: false },
      hooks: { changed: false },
      skill: { changed: false },
      agents_file: { action: 'unchanged' },
      human_steps: [],
    });
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8')).toBe(before);
    expect(Object.keys(projects())).toEqual(['my-app']);
  }, 60_000);

  it('init --agent codex writes AGENTS.md, the Codex skill, and names what a person must do', () => {
    const out = JSON.parse(run(CODER_CLI, ['init', '--agent', 'codex', '--json']).stdout);
    expect(out.ok).toBe(true);
    expect(out.hooks.path).toBe(path.join(home, '.codex', 'hooks.json'));
    expect(out.skill.path).toBe(path.join(home, '.agents', 'skills', 'aquaman-credentials', 'SKILL.md'));
    expect(out.agents_file.path).toBe(path.join(project, 'AGENTS.md'));
    expect(out.human_steps.join(' ')).toMatch(/trust the aquaman hooks/);
    expect(out.human_steps.join(' ')).toMatch(/sandbox/);
  }, 60_000);

  it('--no-skill and --no-instructions leave those alone', () => {
    const out = JSON.parse(run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-skill', '--no-instructions']).stdout);
    expect(out.skill).toBeUndefined();
    expect(out.agents_file).toBeUndefined();
    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
  }, 60_000);

  it('rejects an unknown agent with JSON and a non-zero exit', () => {
    const r = run(CODER_CLI, ['init', '--agent', 'cursor', '--json']);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unsupported agent'),
      fix: expect.stringContaining('--agent claude-code'),
    });
  }, 60_000);

  it('bind adds an env reference to the project covering this directory', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    const first = run(CODER_CLI, ['bind', 'GITHUB_TOKEN=aquaman://github/token', '--json']);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ ok: true, project: 'my-app', env: 'GITHUB_TOKEN', ref: 'aquaman://github/token' });
    run(CODER_CLI, ['bind', 'STRIPE_KEY=aquaman://stripe/secret_key', '--json']);
    expect(projects()['my-app'].env).toEqual({
      GITHUB_TOKEN: 'aquaman://github/token',
      STRIPE_KEY: 'aquaman://stripe/secret_key',
    });
    const sub = path.join(project, 'src');
    fs.mkdirSync(sub);
    expect(JSON.parse(run(CODER_CLI, ['bind', 'X=aquaman://x/y', '--json'], sub).stdout).project).toBe('my-app');
  }, 90_000);

  it('bind never creates a project: outside a registered one it refuses and changes nothing', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    const before = fs.readFileSync(path.join(config, 'projects.yaml'), 'utf-8');
    // The parent of the project: binding here would hand the value to every sibling directory.
    for (const args of [['bind', 'GITHUB_TOKEN=aquaman://github/token', '--json'], ['bind', 'GITHUB_TOKEN=aquaman://github/token', '--check', '--json']]) {
      const r = run(CODER_CLI, args, root);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('No aquaman project covers'), fix: expect.stringContaining('aquaman init --agent') });
    }
    expect(fs.readFileSync(path.join(config, 'projects.yaml'), 'utf-8')).toBe(before);
  }, 90_000);

  it('init refuses the home directory and anything above it', () => {
    for (const cwd of [home, root]) {
      const r = run(CODER_CLI, ['init', '--agent', 'claude-code', '--json'], cwd);
      expect(r.code, cwd).toBe(1);
      expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, error: expect.stringContaining('home directory') });
    }
    expect(fs.existsSync(path.join(config, 'projects.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
  }, 60_000);

  it('bind --check reports the project and writes nothing', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    const r = run(CODER_CLI, ['bind', 'GITHUB_TOKEN=aquaman://github/token', '--check', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, project: 'my-app', checked: true });
    expect(projects()['my-app'].env).toEqual({});
  }, 90_000);

  it('bind refuses a value that is not a reference', () => {
    for (const bad of ['GITHUB_TOKEN=ghp_actual_secret', 'GITHUB_TOKEN', '1BAD=aquaman://github/token']) {
      const r = run(CODER_CLI, ['bind', bad, '--json']);
      expect(r.code, bad).toBe(1);
      expect(JSON.parse(r.stdout).ok).toBe(false);
    }
    expect(fs.existsSync(path.join(config, 'projects.yaml'))).toBe(false);
  }, 60_000);

  it('status --json and doctor --json print one parseable object', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    run(CODER_CLI, ['bind', 'GITHUB_TOKEN=aquaman://github/token', '--json']);
    const status = JSON.parse(run(CODER_CLI, ['status', '--json']).stdout);
    expect(status).toMatchObject({
      current_project: 'my-app',
      projects: [{ name: 'my-app', env: { GITHUB_TOKEN: 'aquaman://github/token' } }],
      hooks: { claude_code: { installed: true }, codex: { installed: false } },
      broker: { reachable: false },
    });
    const doctor = run(CODER_CLI, ['doctor', '--json']);
    expect(doctor.code).toBe(1);
    const report = JSON.parse(doctor.stdout);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c: { name: string }) => c.name === 'proxy running')).toMatchObject({ ok: false });
  }, 90_000);

  it('aquaman request without a daemon exits 4 with a status and a fix', () => {
    const r = run(PROXY_CLI, ['request', 'aquaman://github/token', '--json']);
    expect(r.code).toBe(4);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'error', ref: 'aquaman://github/token', code: 'proxy_unreachable' });
    const bad = run(PROXY_CLI, ['request', 'github/token', '--json']);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).status).toBe('error');
    const badTimeout = run(PROXY_CLI, ['request', 'aquaman://github/token', '--timeout', 'soon', '--json']);
    expect(badTimeout.code).toBe(1);
    expect(JSON.parse(badTimeout.stdout).error).toContain('--timeout');
  }, 60_000);

  it('init --agent with an encrypted-file vault and no usable password says what a person must do', () => {
    fs.writeFileSync(path.join(config, 'config.yaml'), 'credentials:\n  backend: encrypted-file\n');
    for (const password of [undefined, 'too-short']) {
      const r = spawnSync(TSX, [PROXY_CLI, 'init', '--agent', 'claude-code', '--json'], {
        cwd: project,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'AQUAMAN_ENCRYPTION_PASSWORD')),
          HOME: home, AQUAMAN_CONFIG_DIR: config, NO_COLOR: '1',
          ...(password ? { AQUAMAN_ENCRYPTION_PASSWORD: password } : {}),
        },
      });
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({ ok: false, daemon: { running: false, started: false } });
      expect(out.error).toContain('password');
      expect(out.fix).toContain('12 characters');
      expect(out.human_steps.join(' ')).toContain('AQUAMAN_ENCRYPTION_PASSWORD');
    }
    expect(fs.existsSync(path.join(config, 'proxy.sock'))).toBe(false);
  }, 60_000);
});
