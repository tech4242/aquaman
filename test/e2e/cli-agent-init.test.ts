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
      mode: 'hook',
      hooks: { path: path.join(home, '.claude', 'settings.json'), installed: true, changed: true },
      skill: { path: path.join(home, '.claude', 'skills', 'aquaman-credentials', 'SKILL.md'), changed: true },
      agents_file: { path: path.join(project, 'CLAUDE.md'), action: 'created' },
    });
    expect(out.human_steps.join(' ')).toMatch(/restart Claude Code/);
    expect(projects()['my-app']).toEqual({ paths: [project], env: {} });
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')).toContain('aquaman-coder hook');
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

  it('--no-hooks writes nothing to the agent host and tells the agent to use exec', () => {
    const out = JSON.parse(run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-hooks']).stdout);
    expect(out).toMatchObject({
      ok: true,
      mode: 'exec',
      run: 'aquaman-coder exec -- <command>',
      hooks: { installed: false, changed: false },
      project: { name: 'my-app', created: true },
    });
    expect(out.human_steps).toEqual([]);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
    const block = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8');
    expect(block).toContain('aquaman-coder exec -- <command>');
    expect(block).not.toContain('already have its variables injected');
  }, 60_000);

  it('--no-hooks with Codex writes no hooks file and asks for no hook trust', () => {
    const out = JSON.parse(run(CODER_CLI, ['init', '--agent', 'codex', '--json', '--no-hooks']).stdout);
    expect(out).toMatchObject({ ok: true, mode: 'exec', hooks: { installed: false } });
    expect(fs.existsSync(path.join(home, '.codex', 'hooks.json'))).toBe(false);
    expect(out.human_steps.join(' ')).not.toMatch(/trust the aquaman hooks/);
  }, 60_000);

  it('--no-hooks where hooks are already installed reports hook mode and leaves them', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json']);
    const settings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8');
    const out = JSON.parse(run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-hooks']).stdout);
    expect(out).toMatchObject({ ok: true, mode: 'hook', hooks: { installed: true, changed: false } });
    expect(out.run).toBeUndefined();
    expect(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf-8')).toBe(settings);
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf-8')).toContain('already have its variables injected');
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

  it('bind --via-proxy records the route, with /v1 for openai, and binding again without it removes it', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-hooks']);
    const r = run(CODER_CLI, ['bind', 'OPENAI_API_KEY=aquaman://openai/api_key', '--via-proxy', 'OPENAI_BASE_URL', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, via_proxy: { url_env: 'OPENAI_BASE_URL', base_path: '/v1' } });
    run(CODER_CLI, ['bind', 'STRIPE_SECRET_KEY=aquaman://stripe/secret_key', '--via-proxy', 'STRIPE_API_BASE', '--json']);
    expect(projects()['my-app'].routes).toEqual({
      OPENAI_API_KEY: { url_env: 'OPENAI_BASE_URL', base_path: '/v1' },
      STRIPE_SECRET_KEY: { url_env: 'STRIPE_API_BASE' },
    });
    expect(JSON.parse(run(CODER_CLI, ['status', '--json']).stdout).projects[0].routes.STRIPE_SECRET_KEY).toEqual({ url_env: 'STRIPE_API_BASE' });

    run(CODER_CLI, ['bind', 'OPENAI_API_KEY=aquaman://openai/api_key', '--json']);
    run(CODER_CLI, ['bind', 'STRIPE_SECRET_KEY=aquaman://stripe/secret_key', '--json']);
    expect(projects()['my-app'].routes).toBeUndefined();
    expect(projects()['my-app'].env.OPENAI_API_KEY).toBe('aquaman://openai/api_key');
  }, 120_000);

  it('bind --via-proxy refuses a bad URL variable, a bad path, and a URL variable that holds a credential', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-hooks']);
    run(CODER_CLI, ['bind', 'GITHUB_TOKEN=aquaman://github/token', '--json']);
    for (const args of [
      ['--via-proxy', '1BAD'],
      ['--via-proxy', 'OPENAI_API_KEY'],
      ['--via-proxy', 'GITHUB_TOKEN'],
      ['--via-proxy', 'OPENAI_BASE_URL', '--base-path', '/v1/../x'],
      ['--base-path', '/v1'],
    ]) {
      const r = run(CODER_CLI, ['bind', 'OPENAI_API_KEY=aquaman://openai/api_key', ...args, '--json']);
      expect(r.code, args.join(' ')).toBe(1);
    }
    expect(projects()['my-app'].routes).toBeUndefined();
  }, 120_000);

  it('request --via-proxy stops before any dialog when the route could not work, and says why', () => {
    const cases: Array<[string[], RegExp]> = [
      [['aquaman://openai/api_key', '--via-proxy', 'OPENAI_BASE_URL'], /needs --env/],
      [['aquaman://acme/api_key', '--env', 'ACME_KEY', '--via-proxy', 'ACME_URL'], /no definition for "acme"/],
      [['aquaman://stripe/restricted_key', '--env', 'STRIPE_SECRET_KEY', '--via-proxy', 'STRIPE_API_BASE'], /injects stripe\/secret_key/],
      [['aquaman://telegram/bot_token', '--env', 'TELEGRAM_TOKEN', '--via-proxy', 'TELEGRAM_URL'], /request header or as HTTP basic auth/],
      [['aquaman://twilio/phone_number', '--env', 'TWILIO_FROM', '--via-proxy', 'TWILIO_URL'], /injects twilio\/account_sid and twilio\/auth_token/],
      [['aquaman://twilio/auth_token', '--env', 'TWILIO_AUTH_TOKEN', '--via-proxy', 'TWILIO_URL'], /loopback listener is off/],
      [['aquaman://stripe/secret_key', '--env', 'STRIPE_SECRET_KEY', '--via-proxy', 'STRIPE_API_BASE'], /loopback listener is off/],
    ];
    for (const [args, message] of cases) {
      const r = run(PROXY_CLI, ['request', ...args, '--json']);
      expect(r.code, args.join(' ')).toBe(1);
      expect(JSON.parse(r.stdout).error, args.join(' ')).toMatch(message);
    }
    const off = JSON.parse(run(PROXY_CLI, ['request', 'aquaman://stripe/secret_key', '--env', 'STRIPE_SECRET_KEY', '--via-proxy', 'STRIPE_API_BASE', '--json']).stdout);
    expect(off.fix).toContain('--loopback');
  }, 180_000);

  it('a binding cannot name a variable that controls how programs are loaded', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-hooks']);
    for (const args of [
      ['PATH=aquaman://github/token'],
      ['LD_PRELOAD=aquaman://github/token'],
      ['NODE_OPTIONS=aquaman://github/token'],
      ['OPENAI_API_KEY=aquaman://openai/api_key', '--via-proxy', 'NODE_OPTIONS'],
      ['OPENAI_API_KEY=aquaman://openai/api_key', '--via-proxy', 'DYLD_INSERT_LIBRARIES'],
      ['OPENAI_API_KEY=aquaman://openai/api_key', '--via-proxy', 'https_proxy'],
    ]) {
      expect(run(CODER_CLI, ['bind', ...args, '--json']).code, args.join(' ')).toBe(1);
    }
    expect(projects()['my-app'].env).toEqual({});
    // A hand-edited file is refused as a whole rather than used.
    const file = path.join(config, 'projects.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('env: {}', 'env:\n      K: aquaman://openai/api_key\n    routes:\n      K:\n        url_env: LD_PRELOAD'));
    const r = run(CODER_CLI, ['exec', '--', 'true']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/url_env/);
  }, 180_000);

  it('exec --raw refuses when its output is being captured', () => {
    run(CODER_CLI, ['init', '--agent', 'claude-code', '--json', '--no-hooks']);
    const r = run(CODER_CLI, ['exec', '--raw', '--', 'printenv', 'HOME']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--raw only works with a terminal');
    expect(r.stdout).toBe('');
  }, 60_000);

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
