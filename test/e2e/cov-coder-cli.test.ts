/**
 * E2E: the aquaman-coder CLI surfaces that had no test: `setup <agent>`,
 * `doctor`, `status`, `project list`, the stdio `hook` entry point, and the
 * human-readable (non --json) output of `init` and `bind`.
 *
 * Every run gets its own HOME, AQUAMAN_CONFIG_DIR and CODEX_HOME and a PATH
 * that holds no real `claude` or `codex`. The broker is a small HTTP server on
 * the config dir's proxy.sock, in this process, so each answer the daemon can
 * give (found, not stored, not declared, broker off) can be produced on demand.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

const CLI_PATH = path.resolve('packages/coder/src/cli/index.ts');
const TSX = path.resolve('node_modules/tsx/dist/cli.mjs');
const T = 120_000;
const darwin = process.platform === 'darwin';

interface Run { code: number | null; stdout: string; stderr: string; out: string }

describe('aquaman-coder CLI', () => {
  let base: string;
  let home: string;
  let cfg: string;
  let codexHome: string;
  let bin: string;
  let proj: string;
  let server: http.Server | null = null;
  /** ref -> value, or a refusal `{ status, body }`. Anything missing is a plain 404. */
  let vault: Record<string, string | { status: number; body: unknown }>;
  let requests: Array<{ method: string; url: string; body: any }>;

  const sock = () => path.join(cfg, 'proxy.sock');
  const settingsPath = () => path.join(home, '.claude', 'settings.json');
  const hooksPath = () => path.join(codexHome, 'hooks.json');
  const projectsPath = () => path.join(cfg, 'projects.yaml');

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aqc-')));
    home = path.join(base, 'h');
    cfg = path.join(base, 'a');
    codexHome = path.join(base, 'cx');
    bin = path.join(base, 'bin');
    proj = path.join(base, 'proj');
    for (const d of [home, cfg, codexHome, bin, proj]) fs.mkdirSync(d);
    vault = {};
    requests = [];
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    fs.rmSync(base, { recursive: true, force: true });
  });

  function run(args: string[], opts: { cwd?: string; stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX, CLI_PATH, ...args], {
        cwd: opts.cwd ?? proj,
        env: {
          ...process.env,
          HOME: home,
          AQUAMAN_CONFIG_DIR: cfg,
          CODEX_HOME: codexHome,
          // No real claude/codex: only the private bin and the system basics.
          PATH: `${bin}:/usr/bin:/bin`,
          NO_COLOR: '1',
          ...opts.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr, out: stdout + stderr }));
      child.stdin.end(opts.stdin ?? '');
    });
  }

  /** A `claude` that only answers `--version`. */
  function fakeClaude(version: string) {
    const file = path.join(bin, 'claude');
    fs.writeFileSync(file, `#!/bin/sh\necho "${version} (Claude Code)"\n`, { mode: 0o755 });
  }

  function startBroker(): Promise<void> {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        requests.push({ method: req.method!, url: req.url!, body });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url === '/_health') return send(200, { status: 'ok', version: '9.9.9' });
        if (req.url === '/broker/resolve') {
          const entry = vault[`${body.service}/${body.key}`];
          if (typeof entry === 'string') return send(200, { value: entry, expires_at: new Date(Date.now() + 60_000).toISOString() });
          if (entry) return send(entry.status, entry.body);
          return send(404, { error: `Credential not found: ${body.service}/${body.key}` });
        }
        if (req.url === '/broker/available') {
          return send(200, { available: body.refs.map((r: any) => typeof vault[`${r.service}/${r.key}`] === 'string') });
        }
        send(404, { error: 'not found' });
      });
    });
    return new Promise((resolve) => server!.listen(sock(), () => resolve()));
  }

  function writeProjects(projects: Record<string, unknown>) {
    fs.writeFileSync(projectsPath(), JSON.stringify({ version: 1, projects }), { mode: 0o600 });
  }
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  // ---------------- no arguments ----------------

  it('prints the help when run with no arguments', async () => {
    const r = await run([]);
    expect(r.stdout).toContain('Usage: aquaman-coder');
    expect(r.stdout).toContain('doctor');
    expect(r.stdout).toContain('setup [options] <agent>');
    expect(r.code).toBe(0);
  }, T);

  // ---------------- setup ----------------

  describe('setup', () => {
    it('codex: installs the hook into $CODEX_HOME/hooks.json, prints the trust step and the sandbox profile, and uninstalls', async () => {
      const first = await run(['setup', 'codex']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Installed aquaman-coder hook -> ${hooksPath()}`);
      expect(first.stdout).toContain('trust the aquaman hooks');
      // The sandbox note names this install's config.toml and socket, not the defaults.
      expect(first.stdout).toContain(`add to ${path.join(codexHome, 'config.toml')}`);
      expect(first.stdout).toContain(`unix_sockets = { "${sock()}" = "allow" }`);
      expect(first.stdout).toContain('enabled = true');
      const hooks = readJson(hooksPath()).hooks;
      expect(hooks.PreToolUse[0].hooks[0].command).toBe('aquaman-coder hook --host codex');
      expect(hooks.PostToolUse[0].hooks[0].command).toBe('aquaman-coder hook --host codex');
      // Setup never writes config.toml.
      expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);

      const again = await run(['setup', 'codex']);
      expect(again.stdout).toContain(`No changes needed (${hooksPath()})`);

      const removed = await run(['setup', 'codex', '--uninstall']);
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain(`Removed aquaman-coder hook -> ${hooksPath()}`);
      expect(removed.stdout).not.toContain('sandbox');
      expect(readJson(hooksPath()).hooks).toBeUndefined();
    }, T);

    it('refuses an agent it does not know and writes nothing', async () => {
      const r = await run(['setup', 'cursor']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Unsupported agent "cursor". Supported: claude-code, codex');
      expect(fs.existsSync(settingsPath())).toBe(false);
      expect(fs.existsSync(hooksPath())).toBe(false);
    }, T);

    it('claude-code: installs both hooks, reports the sandbox socket, is idempotent, and uninstalls', async () => {
      const first = await run(['setup', 'claude-code']);
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(`Installed aquaman-coder hook -> ${settingsPath()}`);
      const settings = readJson(settingsPath());
      expect(JSON.stringify(settings.hooks.PreToolUse)).toContain('aquaman-coder hook');
      expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('aquaman-coder hook');
      // Fail-open unless asked.
      expect(JSON.stringify(settings)).not.toContain('onFailure');
      if (darwin) {
        expect(first.stdout).toContain(`Allowed the proxy socket for Claude Code's sandbox (sandbox.network.allowUnixSockets: ${sock()})`);
        expect(settings.sandbox.network.allowUnixSockets).toEqual([sock()]);
        // Never the directory, never everything, and the sandbox itself is not switched on.
        expect(settings.sandbox.network.allowAllUnixSockets).toBeUndefined();
        expect(settings.sandbox.enabled).toBeUndefined();
      } else {
        expect(first.stdout).toContain('Note: On Linux/WSL2 Claude Code ignores sandbox.network.allowUnixSockets');
      }

      const again = await run(['setup', 'claude-code']);
      expect(again.code).toBe(0);
      expect(again.stdout).toContain(`No changes needed (${settingsPath()})`);
      if (darwin) expect(again.stdout).toContain('Claude Code sandbox: proxy socket already allowed');

      const removed = await run(['setup', 'claude-code', '--uninstall']);
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain(`Removed aquaman-coder hook -> ${settingsPath()}`);
      if (darwin) expect(removed.stdout).toContain('Removed the proxy socket from sandbox.network.allowUnixSockets');
      else expect(removed.stdout).not.toContain('Linux/WSL2');
      expect(fs.readFileSync(settingsPath(), 'utf-8')).not.toContain('aquaman');
    }, T);

    it('--fail-closed refuses a Claude Code that predates onFailure and installs nothing', async () => {
      fakeClaude('2.1.200');
      const r = await run(['setup', 'claude-code', '--fail-closed']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('--fail-closed needs Claude Code 2.1.295 or later (found 2.1.200)');
      expect(fs.existsSync(settingsPath())).toBe(false);
    }, T);

    it('--fail-closed sets onFailure: block on PreToolUse only when Claude Code is new enough', async () => {
      fakeClaude('2.1.325');
      const r = await run(['setup', 'claude-code', '--fail-closed']);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain('Could not find');
      const settings = readJson(settingsPath());
      const pre = settings.hooks.PreToolUse.flatMap((g: any) => g.hooks);
      const post = settings.hooks.PostToolUse.flatMap((g: any) => g.hooks);
      expect(pre.find((h: any) => h.command.includes('aquaman-coder hook')).onFailure).toBe('block');
      expect(post.find((h: any) => h.command.includes('aquaman-coder hook')).onFailure).toBeUndefined();

      // --no-fail-closed takes it off again, without a version check.
      fs.rmSync(path.join(bin, 'claude'));
      const off = await run(['setup', 'claude-code', '--no-fail-closed']);
      expect(off.code).toBe(0);
      expect(off.out).not.toContain('Could not find');
      expect(fs.readFileSync(settingsPath(), 'utf-8')).not.toContain('onFailure');
    }, T);

    it('--fail-closed without a `claude` on PATH says it could not check, and still installs', async () => {
      const r = await run(['setup', 'claude-code', '--fail-closed']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Could not find `claude` to check its version; --fail-closed needs Claude Code 2.1.295 or later.');
      expect(fs.readFileSync(settingsPath(), 'utf-8')).toContain('"onFailure": "block"');
    }, T);
  });

  // ---------------- project ----------------

  describe('project', () => {
    it('list says how to add one when there are none, then lists paths and references', async () => {
      const empty = await run(['project', 'list']);
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain('No projects configured.');
      expect(empty.stdout).toContain('aquaman-coder project add <name> --path . --env KEY=aquaman://service/key');

      writeProjects({
        app: { paths: ['/code/app', '/code/app-wt'], env: { GITHUB_TOKEN: 'aquaman://github/token' } },
        other: { paths: ['/code/other'], env: {} },
      });
      const listed = await run(['project', 'list']);
      expect(listed.code).toBe(0);
      expect(listed.stdout.split('\n').filter(Boolean)).toEqual([
        'app',
        '  path: /code/app',
        '  path: /code/app-wt',
        '  env:  GITHUB_TOKEN = aquaman://github/token',
        'other',
        '  path: /code/other',
      ]);
    }, T);

    it('add refuses an --env without "=" or with a bad reference, and writes nothing', async () => {
      const noEq = await run(['project', 'add', 'app', '--env', 'GITHUB_TOKEN']);
      expect(noEq.code).toBe(1);
      expect(noEq.stderr).toContain('Bad --env "GITHUB_TOKEN". Expected NAME=aquaman://service/key');

      const badRef = await run(['project', 'add', 'app', '--env', 'GITHUB_TOKEN=ghp_literal']);
      expect(badRef.code).toBe(1);
      expect(badRef.stderr).toContain('Bad reference "ghp_literal". Expected aquaman://service/key');
      expect(fs.existsSync(projectsPath())).toBe(false);
    }, T);

    it('add without --path uses the current directory', async () => {
      const r = await run(['project', 'add', 'here', '--env', 'A=aquaman://a/k']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Added project "here" -> ${projectsPath()}`);
      expect(parseYaml(fs.readFileSync(projectsPath(), 'utf-8')).projects.here).toEqual({ paths: [proj], env: { A: 'aquaman://a/k' } });
    }, T);

    it('remove fails on an unknown project and deletes a known one', async () => {
      writeProjects({ app: { paths: ['/code/app'], env: {} }, keep: { paths: ['/code/keep'], env: {} } });
      const missing = await run(['project', 'remove', 'nope']);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain('Project "nope" not found');

      const removed = await run(['project', 'remove', 'app']);
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain('Removed project "app"');
      expect(Object.keys(parseYaml(fs.readFileSync(projectsPath(), 'utf-8')).projects)).toEqual(['keep']);
    }, T);
  });

  // ---------------- exec ----------------

  describe('exec', () => {
    it('refuses to run outside any project', async () => {
      const marker = path.join(base, 'ran');
      const r = await run(['exec', '--', '/usr/bin/touch', marker]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`No aquaman project covers ${proj}.`);
      expect(r.stderr).toContain('aquaman-coder project add <name>');
      expect(fs.existsSync(marker)).toBe(false);
    }, T);

    it('reports a command that cannot be started', async () => {
      writeProjects({ app: { paths: [proj], env: {} } });
      const r = await run(['exec', '--', 'aquaman-no-such-command-xyz']);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('Failed to spawn "aquaman-no-such-command-xyz"');
    }, T);

    it('injects the resolved value into the command only, and redacts it from the output', async () => {
      const value = 'plain-value-with-no-known-shape-7731';
      vault['github/token'] = value;
      writeProjects({ app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } });
      await startBroker();
      const r = await run(['exec', '--', '/bin/sh', '-c', 'echo "len=${#GITHUB_TOKEN} v=$GITHUB_TOKEN"; exit 7']);
      expect(r.code).toBe(7);
      expect(r.stdout).toContain(`len=${value.length} `);
      expect(r.out).not.toContain(value);
      expect(requests.find((q) => q.url === '/broker/resolve')!.body).toMatchObject({ service: 'github', key: 'token' });
    }, T);
  });

  // ---------------- init / bind, human-readable ----------------

  describe('init and bind without --json', () => {
    it('init rejects an unknown agent in plain text', async () => {
      const r = await run(['init', '--agent', 'cursor']);
      expect(r.code).toBe(1);
      expect(r.stderr.trim()).toBe('Unsupported agent "cursor". Supported: claude-code, codex');
      expect(r.stdout).toBe('');
      expect(fs.existsSync(projectsPath())).toBe(false);
    }, T);

    it('init --agent claude-code prints the project, hooks, skill, instructions and the restart step', async () => {
      const r = await run(['init', '--agent', 'claude-code']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Project "proj" covers ${proj}`);
      expect(r.stdout).toContain(`Hooks: ${settingsPath()}`);
      expect(r.stdout).toContain(`Skill: ${path.join(home, '.claude', 'skills', 'aquaman-credentials', 'SKILL.md')}`);
      expect(r.stdout).toContain(`Instructions: ${path.join(proj, 'CLAUDE.md')}`);
      expect(r.stdout).toContain('A person needs to: restart Claude Code');
      expect(fs.existsSync(path.join(proj, 'CLAUDE.md'))).toBe(true);
      expect(fs.readFileSync(settingsPath(), 'utf-8')).toContain('aquaman-coder hook');
    }, T);

    it('init --agent codex --no-hooks prints the exec form and the sandbox step, and installs no hook', async () => {
      const r = await run(['init', '--agent', 'codex', '--no-hooks', '--no-skill', '--no-instructions']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Hooks: none. Run commands that need credentials as: aquaman-coder exec -- <command>');
      expect(r.stdout).toContain("A person needs to: let Codex's sandbox reach the proxy socket");
      expect(r.stdout).not.toContain('Skill:');
      expect(r.stdout).not.toContain('Instructions:');
      expect(fs.existsSync(hooksPath())).toBe(false);
      expect(fs.existsSync(path.join(proj, 'AGENTS.md'))).toBe(false);
    }, T);

    it('bind prints the error and its fix on stderr, checks, and binds with and without a route', async () => {
      const bad = await run(['bind', '1BAD=aquaman://github/token']);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain('Bad binding "1BAD=aquaman://github/token". Expected NAME=aquaman://service/key');

      const nowhere = await run(['bind', 'GITHUB_TOKEN=aquaman://github/token']);
      expect(nowhere.code).toBe(1);
      expect(nowhere.stderr).toContain(`No aquaman project covers ${proj}`);
      expect(nowhere.stderr).toContain('Fix: Run from the project directory');
      // bind never creates a project.
      expect(fs.existsSync(projectsPath())).toBe(false);

      writeProjects({ app: { paths: [proj], env: {} } });
      const check = await run(['bind', 'GITHUB_TOKEN=aquaman://github/token', '--check']);
      expect(check.code).toBe(0);
      expect(check.stdout).toContain('GITHUB_TOKEN -> aquaman://github/token can be bound in project "app"');
      expect(parseYaml(fs.readFileSync(projectsPath(), 'utf-8')).projects.app.env).toEqual({});

      const plain = await run(['bind', 'GITHUB_TOKEN=aquaman://github/token']);
      expect(plain.code).toBe(0);
      expect(plain.stdout).toContain('GITHUB_TOKEN -> aquaman://github/token in project "app"');

      const routed = await run(['bind', 'OPENAI_API_KEY=aquaman://openai/api_key', '--via-proxy', 'OPENAI_BASE_URL']);
      expect(routed.code).toBe(0);
      expect(routed.stdout).toContain('OPENAI_API_KEY -> aquaman://openai/api_key through the proxy in project "app" (OPENAI_BASE_URL gets the proxy URL)');
      expect(parseYaml(fs.readFileSync(projectsPath(), 'utf-8')).projects.app).toEqual({
        paths: [proj],
        env: { GITHUB_TOKEN: 'aquaman://github/token', OPENAI_API_KEY: 'aquaman://openai/api_key' },
        routes: { OPENAI_API_KEY: { url_env: 'OPENAI_BASE_URL', base_path: '/v1' } },
      });
    }, T);
  });

  // ---------------- hook ----------------

  describe('hook (stdio)', () => {
    const pre = (command: string, extra: Record<string, unknown> = {}) => JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' }, cwd: proj, ...extra,
    });

    it('rejects an unknown --host with exit 2 before reading anything', async () => {
      const r = await run(['hook', '--host', 'cursor'], { stdin: pre('ls') });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('aquaman-coder: unknown --host cursor');
      expect(r.stdout).toBe('');
    }, T);

    it('exits 2 with a message on stdin that is not JSON', async () => {
      const r = await run(['hook'], { stdin: '{not json' });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('aquaman-coder: malformed hook input');
      expect(r.stdout).toBe('');
    }, T);

    it('prints nothing and exits 0 for an event it does not handle, and for a tool it ignores', async () => {
      const other = await run(['hook'], { stdin: JSON.stringify({ hook_event_name: 'SessionStart', cwd: proj }) });
      expect(other).toMatchObject({ code: 0, stdout: '' });

      writeProjects({ app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } });
      const monitor = await run(['hook'], { stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Monitor', tool_input: { command: 'tail -f x' }, cwd: proj }) });
      expect(monitor).toMatchObject({ code: 0, stdout: '' });
    }, T);

    it('exits 2 when projects.yaml is invalid, so the failure is not silent', async () => {
      fs.writeFileSync(projectsPath(), 'projects:\n  app:\n    paths: []\n');
      const r = await run(['hook'], { stdin: pre('ls') });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('aquaman-coder: hook failed: Project "app" has no paths');
      expect(r.stdout).toBe('');
    }, T);

    it('PreToolUse: wraps a Bash command with the permission tail and prints schema-valid JSON', async () => {
      vault['github/token'] = 'v';
      writeProjects({ app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } });
      await startBroker();
      const r = await run(['hook'], { stdin: pre("git push 'origin'") });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      expect(out.hookEventName).toBe('PreToolUse');
      expect(out.permissionDecision).toBe('allow');
      // tool_input is spread, only `command` is replaced.
      expect(out.updatedInput.description).toBe('d');
      expect(out.updatedInput.command).toBe(`aquaman-coder exec -- sh -c 'git push '\\''origin'\\'''\nexit\ngit push 'origin'`);
      expect(out.additionalContext).toContain('GITHUB_TOKEN');
      // The hook asked whether anything would resolve, and no value travelled.
      expect(requests.map((q) => q.url)).toEqual(['/_health', '/broker/available']);
      expect(r.out).not.toContain('"v"');
    }, T);

    it('PreToolUse: with the proxy down it denies, except for aquaman commands', async () => {
      writeProjects({ app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } });
      const denied = await run(['hook'], { stdin: pre('git push') });
      expect(denied.code).toBe(0);
      const out = JSON.parse(denied.stdout).hookSpecificOutput;
      expect(out.permissionDecision).toBe('deny');
      expect(out.permissionDecisionReason).toContain('proxy not reachable');
      expect(out.permissionDecisionReason).toContain('aquaman init --agent claude-code');

      const own = await run(['hook'], { stdin: pre('aquaman init --agent claude-code') });
      expect(own).toMatchObject({ code: 0, stdout: '' });
    }, T);

    it('--host codex: the rewrite carries only `command`, and no permission tail', async () => {
      vault['github/token'] = 'v';
      writeProjects({ app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } });
      await startBroker();
      const r = await run(['hook', '--host', 'codex'], { stdin: pre('git push') });
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: "aquaman-coder exec -- sh -c 'git push'" },
        },
      });
    }, T);

    it('PostToolUse: rewrites output for Claude Code, only warns for Codex and when rewriting is off', async () => {
      const token = 'ghp_' + 'a'.repeat(36);
      const event = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: `token=${token}`, cwd: proj });

      const claude = await run(['hook'], { stdin: event });
      expect(claude.code).toBe(0);
      const out = JSON.parse(claude.stdout).hookSpecificOutput;
      expect(out.hookEventName).toBe('PostToolUse');
      expect(out.updatedToolOutput).not.toContain(token);
      expect(out.updatedToolOutput).toContain('token=');
      expect(claude.stdout).not.toContain(token);

      const warnOnly = await run(['hook'], { stdin: event, env: { AQUAMAN_DISABLE_OUTPUT_REWRITE: '1' } });
      const warn = JSON.parse(warnOnly.stdout).hookSpecificOutput;
      expect(warn.updatedToolOutput).toBeUndefined();
      expect(warn.additionalContext).toContain('tool output contained secret patterns');

      const codex = await run(['hook', '--host', 'codex'], { stdin: event });
      expect(codex.code).toBe(0);
      const cx = JSON.parse(codex.stdout).hookSpecificOutput;
      expect(Object.keys(cx).sort()).toEqual(['additionalContext', 'hookEventName']);
      expect(cx.additionalContext).toContain('Codex offers no way for a hook to rewrite shell output');
      expect(codex.stdout).not.toContain(token);

      const clean = await run(['hook'], { stdin: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: 'nothing here' }) });
      expect(clean).toMatchObject({ code: 0, stdout: '' });
    }, T);
  });

  // ---------------- doctor ----------------

  describe('doctor', () => {
    const check = (r: Run, name: string) => JSON.parse(r.stdout).checks.find((c: any) => c.name === name);

    it('on an empty install fails projects.yaml, the proxy and the hooks, each with a fix', async () => {
      const r = await run(['doctor', '--json']);
      expect(r.code).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.ok).toBe(false);
      expect(report.issues).toBe(3);
      expect(check(r, 'projects.yaml')).toMatchObject({ ok: false, detail: projectsPath() });
      expect(check(r, 'projects.yaml').fix).toContain('aquaman-coder project add');
      expect(check(r, 'projects parsed')).toBeUndefined();
      expect(check(r, 'proxy running').ok).toBe(false);
      expect(check(r, 'proxy running').detail).toContain(sock());
      expect(check(r, 'proxy running').fix).toContain('aquaman init --agent <agent> --no-hooks');
      expect(check(r, 'agent hooks')).toMatchObject({ ok: false, detail: 'no coding agent is wired to aquaman' });
      expect(check(r, 'Claude Code sandbox').ok).toBe(true);
      expect(check(r, 'Claude Code sandbox').detail).toContain('not enabled');
    }, T);

    it('reports a projects.yaml that does not validate', async () => {
      fs.writeFileSync(projectsPath(), 'projects:\n  app:\n    paths: [/x]\n    env:\n      "1BAD": aquaman://a/k\n');
      const r = await run(['doctor', '--json']);
      expect(r.code).toBe(1);
      expect(check(r, 'projects.yaml').ok).toBe(true);
      expect(check(r, 'projects parsed').ok).toBe(false);
      expect(check(r, 'projects parsed').detail).toContain('invalid env name "1BAD"');
    }, T);

    it('checks every binding against the broker and names the right fix for each refusal', async () => {
      vault['github/token'] = 'stored-value-1';
      vault['stripe/key'] = { status: 404, body: { error: 'aquaman://stripe/key is not declared', code: 'broker_ref_not_declared' } };
      vault['openai/api_key'] = { status: 404, body: { error: 'The broker is off on this proxy', code: 'broker_disabled' } };
      writeProjects({
        app: {
          paths: [proj],
          env: {
            GITHUB_TOKEN: 'aquaman://github/token',
            NPM_TOKEN: 'aquaman://npm/token',
            STRIPE_KEY: 'aquaman://stripe/key',
            OPENAI_API_KEY: 'aquaman://openai/api_key',
          },
        },
      });
      await startBroker();
      const r = await run(['doctor', '--json']);
      expect(r.code).toBe(1);
      expect(check(r, 'projects parsed')).toMatchObject({ ok: true, detail: '1 project(s)' });
      expect(check(r, 'proxy running')).toMatchObject({ ok: true, detail: 'version 9.9.9' });
      expect(check(r, 'project app: GITHUB_TOKEN')).toEqual({ name: 'project app: GITHUB_TOKEN', ok: true, detail: 'aquaman://github/token' });
      expect(check(r, 'project app: NPM_TOKEN')).toMatchObject({ ok: false, fix: 'aquaman credentials add npm token' });
      expect(check(r, 'project app: NPM_TOKEN').detail).toContain('aquaman://npm/token — Credential not found');
      expect(check(r, 'project app: STRIPE_KEY').fix).toContain('aquaman broker list');
      expect(check(r, 'project app: STRIPE_KEY').fix).toContain(projectsPath());
      expect(check(r, 'project app: OPENAI_API_KEY').fix).toContain('started by the OpenClaw plugin');
      expect(check(r, 'project app: OPENAI_API_KEY').fix).toContain('aquaman daemon');
      // A check never carries a value.
      expect(r.out).not.toContain('stored-value-1');
    }, T);

    it('passes and exits 0, in plain text, when everything is in place', async () => {
      vault['github/token'] = 'stored-value-2';
      writeProjects({ app: { paths: [proj], env: { GITHUB_TOKEN: 'aquaman://github/token' } } });
      await startBroker();
      expect((await run(['setup', 'claude-code'])).code).toBe(0);

      const r = await run(['doctor']);
      expect(r.out).not.toContain('✗');
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Welcome to the doctor’s office.');
      expect(r.stdout).toContain(`✓ projects.yaml  ${projectsPath()}`);
      expect(r.stdout).toContain('✓ proxy running  version 9.9.9');
      expect(r.stdout).toContain('✓ project app: GITHUB_TOKEN  aquaman://github/token');
      expect(r.stdout).toContain(`✓ Claude Code hooks  ${settingsPath()} (a hook that cannot run lets the command through without credentials`);
      expect(r.stdout).toContain('✓ Claude Code sandbox  not enabled');
      expect(r.stdout).toContain('All checks passed.');
      expect(r.stdout).not.toContain('stored-value-2');
      // NO_COLOR is honoured.
      expect(r.stdout).not.toContain('\x1b[');
    }, T);

    it('in plain text lists each failure with its fix and counts them', async () => {
      const r = await run(['doctor']);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`✗ projects.yaml  ${projectsPath()}`);
      expect(r.stdout).toContain('→ aquaman-coder project add <name> --path <dir> --env NAME=aquaman://service/key');
      expect(r.stdout).toContain('✗ agent hooks  no coding agent is wired to aquaman');
      expect(r.stdout).toContain('→ aquaman coder setup claude-code   (or: aquaman coder setup codex)');
      expect(r.stdout).toContain('3 issues found. Fix the above and re-run `aquaman coder doctor`.');
    }, T);

    it('colours check names when FORCE_COLOR is set and NO_COLOR is not', async () => {
      const env = { ...process.env } as Record<string, string>;
      delete env.NO_COLOR;
      const child = await new Promise<Run>((resolve, reject) => {
        const c = spawn(process.execPath, [TSX, CLI_PATH, 'doctor'], {
          cwd: proj,
          env: { ...env, HOME: home, AQUAMAN_CONFIG_DIR: cfg, CODEX_HOME: codexHome, PATH: `${bin}:/usr/bin:/bin`, FORCE_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        c.stdout.on('data', (d) => { stdout += d; });
        c.on('error', reject);
        c.on('close', (code) => resolve({ code, stdout, stderr: '', out: stdout }));
      });
      expect(child.code).toBe(1);
      expect(child.stdout).toContain('\x1b[38;2;63;193;192mprojects.yaml\x1b[0m');
    }, T);

    it('says a fail-closed Claude Code hook blocks the tool call', async () => {
      expect((await run(['setup', 'claude-code', '--fail-closed'])).code).toBe(0);
      const r = await run(['doctor', '--json']);
      expect(check(r, 'Claude Code hooks')).toEqual({
        name: 'Claude Code hooks',
        ok: true,
        detail: `${settingsPath()} (a hook that cannot run blocks the tool call)`,
      });
      expect(check(r, 'agent hooks')).toBeUndefined();
    }, T);

    it('Codex: an untrusted hook and a default sandbox both fail; trusted with a network profile passes', async () => {
      expect((await run(['setup', 'codex'])).code).toBe(0);
      const before = await run(['doctor', '--json']);
      expect(check(before, 'Codex hooks')).toMatchObject({
        ok: false,
        detail: `${hooksPath()} (installed, not yet trusted, so Codex skips them)`,
        fix: 'Start `codex` and trust the aquaman hooks in the startup hook review',
      });
      expect(check(before, 'Codex sandbox').ok).toBe(false);
      expect(check(before, 'Codex sandbox').detail).toContain('does not exist');
      expect(check(before, 'Codex sandbox').fix).toContain('default_permissions = "aquaman"');
      expect(check(before, 'Codex sandbox').fix).toContain(sock());
      expect(check(before, 'agent hooks')).toBeUndefined();

      fs.writeFileSync(path.join(codexHome, 'config.toml'), [
        'default_permissions = "aquaman"',
        '[permissions.aquaman]',
        'extends = ":workspace"',
        '[permissions.aquaman.network]',
        'enabled = true',
        `unix_sockets = { "${sock()}" = "allow" }`,
        `[hooks.state."${hooksPath()}:pre_tool_use:0:0"]`,
        'trusted_hash = "sha256:abc"',
        '',
      ].join('\n'));
      const after = await run(['doctor', '--json']);
      expect(check(after, 'Codex hooks')).toEqual({ name: 'Codex hooks', ok: true, detail: hooksPath() });
      expect(check(after, 'Codex sandbox')).toEqual({
        name: 'Codex sandbox',
        ok: true,
        detail: 'permissions profile "aquaman" enables network and allows the proxy socket',
      });
    }, T);

    it('Claude Code sandbox: enabled without the socket fails; a project-level allowance is merged in', async () => {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify({ sandbox: { enabled: true } }));
      writeProjects({ app: { paths: [proj], env: {} } });

      const blocked = await run(['doctor', '--json']);
      expect(check(blocked, 'Claude Code sandbox')).toMatchObject({
        ok: false,
        detail: 'enabled, but sandboxed commands cannot connect to the proxy socket (EPERM)',
      });
      expect(check(blocked, 'Claude Code sandbox').fix).toContain(darwin ? 'aquaman coder setup claude-code' : 'allowAllUnixSockets: true');

      // The project's own settings count, the way Claude Code merges list settings.
      fs.mkdirSync(path.join(proj, '.claude'));
      fs.writeFileSync(path.join(proj, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { network: { allowAllUnixSockets: true } } }));
      const allowed = await run(['doctor', '--json']);
      expect(check(allowed, 'Claude Code sandbox')).toEqual({ name: 'Claude Code sandbox', ok: true, detail: 'enabled; proxy socket allowed' });
    }, T);

    it('Claude Code sandbox: a "~/" project path is read from HOME', async () => {
      fs.mkdirSync(path.join(home, 'code', '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, 'code', '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }));
      writeProjects({ app: { paths: ['~/code'], env: {} } });
      const r = await run(['doctor', '--json']);
      expect(check(r, 'Claude Code sandbox').ok).toBe(false);
      expect(check(r, 'Claude Code sandbox').detail).toContain('enabled, but');
    }, T);
  });

  // ---------------- status ----------------

  describe('status', () => {
    it('plain text on an empty install: no projects, no hooks, broker unreachable', async () => {
      const r = await run(['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('aquaman-coder status');
      expect(r.stdout).toContain('Projects: none configured');
      expect(r.stdout).toContain('Add one: aquaman coder project add <name>');
      expect(r.stdout).toContain('Claude Code hooks: not configured');
      expect(r.stdout).toContain(settingsPath());
      expect(r.stdout).toContain('Codex hooks: not configured');
      expect(r.stdout).not.toContain(hooksPath());
      expect(r.stdout).toContain(`Broker: unreachable (Cannot reach aquaman proxy at ${sock()}`);
    }, T);

    it('plain text with projects, both hosts wired and the broker up', async () => {
      writeProjects({
        app: { paths: [proj, '/code/app-wt'], env: { A: 'aquaman://a/k', B: 'aquaman://b/k' } },
        other: { paths: ['/code/other'], env: {} },
      });
      expect((await run(['setup', 'claude-code'])).code).toBe(0);
      expect((await run(['setup', 'codex'])).code).toBe(0);
      await startBroker();
      const r = await run(['status']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`Projects: 2 configured (${projectsPath()})`);
      expect(r.stdout).toContain('- app: 2 path(s), 2 env binding(s)');
      expect(r.stdout).toContain('- other: 1 path(s), 0 env binding(s)');
      expect(r.stdout).toContain('Claude Code hooks: installed');
      expect(r.stdout).toContain('Codex hooks: installed, not yet trusted');
      expect(r.stdout).toContain(hooksPath());
      expect(r.stdout).toContain('Broker: reachable (proxy v9.9.9)');

      fs.writeFileSync(path.join(codexHome, 'config.toml'), `[hooks.state."${hooksPath()}:pre_tool_use:0:0"]\ntrusted_hash = "x"\n`);
      const trusted = await run(['status']);
      expect(trusted.stdout).toContain('Codex hooks: installed, trusted');
    }, T);

    it('reports an invalid projects.yaml instead of failing, in both forms', async () => {
      fs.writeFileSync(projectsPath(), 'projects:\n  app:\n    paths: []\n');
      const text = await run(['status']);
      expect(text.code).toBe(0);
      expect(text.stdout).toContain('Projects: invalid (Project "app" has no paths)');

      const json = await run(['status', '--json']);
      expect(json.code).toBe(0);
      const report = JSON.parse(json.stdout);
      expect(report.projects_error).toBe('Project "app" has no paths');
      expect(report.projects).toEqual([]);
      expect(report.current_project).toBeNull();
      expect(report.broker).toMatchObject({ reachable: false, socket: sock() });
    }, T);

    it('--json names the project covering the current directory and never a value', async () => {
      vault['a/k'] = 'stored-value-3';
      writeProjects({ app: { paths: [proj], env: { A: 'aquaman://a/k' }, routes: {} } });
      await startBroker();
      const r = await run(['status', '--json']);
      expect(r.code).toBe(0);
      const report = JSON.parse(r.stdout);
      expect(report.current_project).toBe('app');
      expect(report.projects).toEqual([{ name: 'app', paths: [proj], env: { A: 'aquaman://a/k' }, routes: {} }]);
      expect(report.hooks).toEqual({
        claude_code: { installed: false, path: settingsPath() },
        codex: { installed: false, trusted: false, path: hooksPath() },
      });
      expect(report.broker).toEqual({ reachable: true, version: '9.9.9', socket: sock() });
      expect(r.out).not.toContain('stored-value-3');
      // status asks only for health.
      expect(requests.map((q) => q.url)).toEqual(['/_health']);
    }, T);
  });
});
