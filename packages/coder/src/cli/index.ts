#!/usr/bin/env node
/**
 * aquaman-coder CLI.
 *
 * Subcommands:
 *   setup <agent>      Install hook configuration for a coding agent
 *                      (claude-code, codex)
 *   project list       List configured projects
 *   project add        Add a project (interactive or flags)
 *   project remove     Remove a project
 *   exec <cmd...>      Run a command with the matching project env injected
 *   hook               Stdio hook handler (invoked by Claude Code or Codex)
 *   doctor             Diagnostics
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { VERSION } from '../index.js';
import {
  defaultProjectsPath,
  loadProjects,
  saveProjects,
  findProjectForCwd,
  parseRef,
  type ProjectConfig,
} from '../projects.js';
import { BrokerClient, BrokerError, defaultSocketPath } from '../broker-client.js';
import { runHookFromStdin } from '../adapters/claude-code/hook.js';
import {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  defaultSettingsPath,
  sandboxSocketStatus,
} from '../adapters/claude-code/setup.js';
import {
  installCodexHooks,
  uninstallCodexHooks,
  codexHookStatus,
  defaultCodexHooksPath,
  codexHome,
} from '../adapters/codex/setup.js';

/** Claude Code's managed (enterprise) settings file for this platform. */
function managedSettingsPath(): string {
  return process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';
}

/** One-line statement of the Linux/WSL2 sandbox limitation (README carries the same line). */
const LINUX_SANDBOX_LIMITATION =
  'On Linux/WSL2 Claude Code ignores sandbox.network.allowUnixSockets, so sandboxed commands can reach the broker only with sandbox.network.allowAllUnixSockets: true, which opens every Unix socket to them.';

/**
 * Codex runs the rewritten command inside its own sandbox, which denies AF_UNIX
 * connects by default (verified with `codex sandbox`, 0.156.1: EPERM). A
 * permissions profile that extends ":workspace" and lists the socket works,
 * but only with `network.enabled = true`; `unix_sockets` alone stays EPERM.
 * Setup does not edit config.toml, so it prints this instead.
 */
function codexSandboxNote(): string {
  return `Codex's sandbox blocks the proxy socket by default. To allow it, add to ${path.join(codexHome(), 'config.toml')}:\n` +
    `  default_permissions = "aquaman"\n` +
    `  [permissions.aquaman]\n` +
    `  extends = ":workspace"\n` +
    `  [permissions.aquaman.network]\n` +
    `  enabled = true\n` +
    `  unix_sockets = { "${defaultSocketPath()}" = "allow" }`;
}

// ANSI color helpers — aquamarine theme. Mirrors packages/proxy/src/cli/index.ts
// so `aquaman coder doctor` matches `aquaman openclaw doctor`.
// Respects NO_COLOR (https://no-color.org/) and disables in piped output.
const noColor = process.env['NO_COLOR'] !== undefined ||
                (!process.stdout.isTTY && process.env['FORCE_COLOR'] === undefined);
const aqua = (s: string) => noColor ? s : `\x1b[38;2;127;255;212m${s}\x1b[0m`;

const program = new Command();
program
  .name('aquaman-coder')
  .description('Vault adapter for AI coding agents')
  .version(VERSION)
  .enablePositionalOptions();

// ---------------- setup ----------------

program
  .command('setup <agent>')
  .description('Install hook configuration for a coding agent (claude-code, codex)')
  .option('--uninstall', 'Remove aquaman hooks from the agent config', false)
  .action((agent: string, opts: { uninstall?: boolean }) => {
    if (agent === 'codex') {
      const result = opts.uninstall ? uninstallCodexHooks() : installCodexHooks();
      console.log(result.changed
        ? `${opts.uninstall ? 'Removed' : 'Installed'} aquaman-coder hook -> ${result.path}`
        : `No changes needed (${result.path})`);
      if (!opts.uninstall) {
        console.log('\nCodex runs a new hook only after you approve it: start `codex` and choose to trust the aquaman hooks in the startup hook review.');
        console.log(`\n${codexSandboxNote()}`);
      }
      return;
    }
    if (agent !== 'claude-code') {
      console.error(`Unsupported agent "${agent}". Supported: claude-code, codex`);
      process.exit(1);
    }

    const result = opts.uninstall
      ? uninstallClaudeCodeHooks()
      : installClaudeCodeHooks();

    if (result.changed) {
      console.log(`${opts.uninstall ? 'Removed' : 'Installed'} aquaman-coder hook -> ${result.path}`);
    } else {
      console.log(`No changes needed (${result.path})`);
    }
    switch (result.sandboxSocket) {
      case 'added':
        console.log(`Allowed the proxy socket for Claude Code's sandbox (sandbox.network.allowUnixSockets: ${defaultSocketPath()})`);
        break;
      case 'present':
        console.log('Claude Code sandbox: proxy socket already allowed');
        break;
      case 'removed':
        console.log('Removed the proxy socket from sandbox.network.allowUnixSockets');
        break;
      case 'unsupported-platform':
        if (!opts.uninstall) console.log(`Note: ${LINUX_SANDBOX_LIMITATION}`);
        break;
    }
  });

// ---------------- project ----------------

const project = program.command('project').description('Manage ~/.aquaman/projects.yaml');

project
  .command('list')
  .description('List configured projects')
  .action(() => {
    const file = loadProjects();
    const names = Object.keys(file.projects);
    if (names.length === 0) {
      console.log('No projects configured.');
      console.log('Add one with: aquaman-coder project add <name> --path . --env KEY=aquaman://service/key');
      return;
    }
    for (const name of names) {
      const cfg = file.projects[name];
      console.log(`${name}`);
      for (const p of cfg.paths) console.log(`  path: ${p}`);
      for (const [k, v] of Object.entries(cfg.env)) console.log(`  env:  ${k} = ${v}`);
    }
  });

project
  .command('add <name>')
  .description('Add a project to ~/.aquaman/projects.yaml, or add paths/env bindings to an existing one')
  .option('--path <path>', 'Filesystem path (repeat for multiple)', collect, [])
  .option('--env <name=ref>', 'Env binding (repeat for multiple)', collect, [])
  .option('--replace', 'Replace an existing project instead of merging into it', false)
  .action((name: string, opts: { path: string[]; env: string[]; replace?: boolean }) => {
    const file = loadProjects();
    const env: Record<string, string> = {};
    for (const e of opts.env) {
      const idx = e.indexOf('=');
      if (idx < 0) {
        console.error(`Bad --env "${e}". Expected NAME=aquaman://service/key`);
        process.exit(1);
      }
      const key = e.slice(0, idx);
      const ref = e.slice(idx + 1);
      if (!parseRef(ref)) {
        console.error(`Bad reference "${ref}". Expected aquaman://service/key`);
        process.exit(1);
      }
      env[key] = ref;
    }
    // Through v0.15.x this replaced an existing project, silently dropping its
    // bindings (issue #67). It now merges: new paths are appended, and an env
    // name that already exists takes the new ref. --replace keeps the old behavior.
    const existing = opts.replace ? undefined : file.projects[name];
    if (existing) {
      const paths = [...existing.paths];
      for (const p of opts.path) if (!paths.includes(p)) paths.push(p);
      file.projects[name] = { ...existing, paths, env: { ...existing.env, ...env } };
      saveProjects(file);
      console.log(`Updated project "${name}" -> ${defaultProjectsPath()}`);
      return;
    }
    const paths = opts.path.length > 0 ? opts.path : [process.cwd()];
    const cfg: ProjectConfig = { paths, env };
    file.projects[name] = cfg;
    saveProjects(file);
    console.log(`${opts.replace ? 'Replaced' : 'Added'} project "${name}" -> ${defaultProjectsPath()}`);
  });

project
  .command('remove <name>')
  .description('Remove a project, or only some of its env bindings with --env')
  .option('--env <name>', 'Remove only this env binding (repeat for multiple)', collect, [])
  .action((name: string, opts: { env: string[] }) => {
    const file = loadProjects();
    if (!file.projects[name]) {
      console.error(`Project "${name}" not found`);
      process.exit(1);
    }
    if (opts.env.length > 0) {
      const env = { ...file.projects[name].env };
      const missing = opts.env.filter((e) => !(e in env));
      if (missing.length > 0) {
        console.error(`Project "${name}" has no env binding: ${missing.join(', ')}`);
        process.exit(1);
      }
      for (const e of opts.env) delete env[e];
      file.projects[name] = { ...file.projects[name], env };
      saveProjects(file);
      console.log(`Removed ${opts.env.join(', ')} from project "${name}"`);
      return;
    }
    delete file.projects[name];
    saveProjects(file);
    console.log(`Removed project "${name}"`);
  });

// ---------------- exec ----------------

program
  .command('exec <cmd> [args...]')
  .description('Run a command with project env injected and stdout/stderr redacted')
  .passThroughOptions()
  .allowUnknownOption()
  .option('--raw', 'Disable stdout/stderr redaction', false)
  .action(async (cmd: string, args: string[], opts: { raw?: boolean }) => {
    const cwd = process.cwd();
    const projects = loadProjects();
    const match = findProjectForCwd(cwd, projects);
    if (!match) {
      console.error(`No aquaman project covers ${cwd}.`);
      console.error('Add one with: aquaman-coder project add <name>');
      process.exit(1);
    }

    const broker = new BrokerClient();
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    const injectedValues: string[] = [];
    for (const [envName, ref] of Object.entries(match.config.env)) {
      const parsed = parseRef(ref);
      if (!parsed) continue;
      try {
        const result = await broker.resolve({ service: parsed.service, key: parsed.key, ttlSeconds: 60 });
        env[envName] = result.value;
        injectedValues.push(result.value);
      } catch (err) {
        console.error(`aquaman: failed to resolve ${envName}: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    const stdio = opts.raw ? 'inherit' : ['inherit', 'pipe', 'pipe'] as const;
    const child = spawn(cmd, args, { env, stdio: stdio as any });

    if (!opts.raw) {
      // Value-based redaction: prepend patterns built from the exact strings
      // we just injected so they're stripped from child stdout/stderr no
      // matter what shape they happen to have. Generic BUILTIN_PATTERNS still
      // run after as defense-in-depth for any secrets the child surfaces that
      // we did NOT inject (hardcoded tokens, env vars leaked from parent, ...).
      const { redact, buildValuePatterns, BUILTIN_PATTERNS } = await import('aquaman-proxy');
      const patterns = [...buildValuePatterns(injectedValues), ...BUILTIN_PATTERNS];
      const pipeRedacted = (src: NodeJS.ReadableStream, dst: NodeJS.WritableStream) => {
        src.setEncoding('utf-8');
        src.on('data', (chunk: string) => {
          dst.write(redact(chunk, patterns).output);
        });
      };
      if (child.stdout) pipeRedacted(child.stdout, process.stdout);
      if (child.stderr) pipeRedacted(child.stderr, process.stderr);
    }

    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to spawn "${cmd}": ${err.message}`);
      process.exit(1);
    });
  });

// ---------------- hook ----------------

program
  .command('hook')
  .description('Stdio hook handler (invoked by Claude Code or Codex, not directly)')
  .option('--host <host>', 'Which agent invoked the hook: claude-code or codex', 'claude-code')
  .action(async (opts: { host: string }) => {
    if (opts.host !== 'claude-code' && opts.host !== 'codex') {
      process.stderr.write(`aquaman-coder: unknown --host ${opts.host}\n`);
      process.exit(2);
    }
    const code = await runHookFromStdin(process.argv, { host: opts.host });
    process.exit(code);
  });

// ---------------- doctor ----------------

program
  .command('doctor')
  .description('Deep diagnostic for the coder integration (projects, broker, hooks, per-project vault checks)')
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; detail?: string; fix?: string }> = [];

    // 1. projects.yaml exists
    const projectsPath = defaultProjectsPath();
    const projectsOk = fs.existsSync(projectsPath);
    checks.push({
      name: 'projects.yaml',
      ok: projectsOk,
      detail: projectsPath,
      fix: projectsOk ? undefined : 'aquaman-coder project add <name> --path <dir> --env NAME=aquaman://service/key',
    });

    // 2. projects.yaml parses
    let projects: ReturnType<typeof loadProjects> | null = null;
    if (projectsOk) {
      try {
        projects = loadProjects();
        const count = Object.keys(projects.projects).length;
        checks.push({ name: 'projects parsed', ok: true, detail: `${count} project(s)` });
      } catch (err) {
        checks.push({ name: 'projects parsed', ok: false, detail: (err as Error).message });
      }
    }

    // 3. Proxy running on socket
    const socketPath = defaultSocketPath();
    const broker = new BrokerClient({ socketPath, timeoutMs: 2000 });
    let brokerOk = false;
    try {
      const health = await broker.health();
      checks.push({ name: 'proxy running', ok: true, detail: `version ${health.version ?? '?'}` });
      brokerOk = true;
    } catch (err) {
      checks.push({
        name: 'proxy running',
        ok: false,
        detail: (err as Error).message,
        fix: 'aquaman daemon &',
      });
    }

    // 4. Per-project: every declared aquaman:// ref resolves
    if (brokerOk && projects) {
      for (const [name, cfg] of Object.entries(projects.projects)) {
        for (const [envName, ref] of Object.entries(cfg.env)) {
          const parsed = parseRef(ref);
          if (!parsed) {
            checks.push({ name: `project ${name}: env ${envName}`, ok: false, detail: `bad ref "${ref}"` });
            continue;
          }
          try {
            await broker.resolve({ service: parsed.service, key: parsed.key, ttlSeconds: 1 });
            checks.push({ name: `project ${name}: ${envName}`, ok: true, detail: ref });
          } catch (err) {
            const code = err instanceof BrokerError ? err.code : undefined;
            const fix =
              code === 'broker_disabled'
                ? 'The proxy on this socket was started by the OpenClaw plugin, which never hands out credentials. Run `aquaman daemon` for coding agents.'
                : code === 'broker_ref_not_declared'
                  ? `aquaman broker list  (the daemon does not see this ref as declared — is it reading ${defaultProjectsPath()}?)`
                  : `aquaman credentials add ${parsed.service} ${parsed.key}`;
            checks.push({
              name: `project ${name}: ${envName}`,
              ok: false,
              detail: `${ref} — ${(err as Error).message}`,
              fix,
            });
          }
        }
      }
    }

    // 5. Agent hooks installed. At least one host must be wired; each wired
    // host is checked on its own terms.
    const settingsPath = defaultSettingsPath();
    const claudeInstalled = fs.existsSync(settingsPath) &&
      /aquaman(-| )coder hook/.test(fs.readFileSync(settingsPath, 'utf-8'));
    const codexHooksPath = defaultCodexHooksPath();
    const codex = codexHookStatus(codexHooksPath);
    if (!claudeInstalled && !codex.installed) {
      checks.push({
        name: 'agent hooks',
        ok: false,
        detail: 'no coding agent is wired to aquaman',
        fix: 'aquaman coder setup claude-code   (or: aquaman coder setup codex)',
      });
    }
    if (claudeInstalled) {
      checks.push({ name: 'Claude Code hooks', ok: true, detail: settingsPath });
    }
    if (codex.installed) {
      checks.push({
        name: 'Codex hooks',
        ok: codex.trusted,
        detail: codex.trusted ? codexHooksPath : `${codexHooksPath} (installed, not yet trusted, so Codex skips them)`,
        fix: codex.trusted ? undefined : 'Start `codex` and trust the aquaman hooks in the startup hook review',
      });
      checks.push({ name: 'Codex sandbox', ok: true, detail: 'blocks the proxy socket unless allowed; see `aquaman coder setup codex` output or the aquaman-coder README' });
    }

    // 6. Claude Code sandbox can reach the proxy socket. Merge user, managed,
    // and each project's .claude/settings{,.local}.json the way Claude Code
    // merges list settings.
    const settingsFiles = [defaultSettingsPath(), managedSettingsPath()];
    for (const cfg of Object.values(projects?.projects ?? {})) {
      for (const p of cfg.paths ?? []) {
        const dir = p.startsWith('~/') ? path.join(process.env['HOME'] ?? '', p.slice(2)) : p;
        settingsFiles.push(path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'));
      }
    }
    const sb = sandboxSocketStatus(settingsFiles);
    if (!sb.sandboxEnabled) {
      checks.push({
        name: 'Claude Code sandbox',
        ok: true,
        detail: sb.socketAllowed || process.platform !== 'darwin'
          ? 'not enabled'
          : 'not enabled (proxy socket not allowlisted yet — run `aquaman coder setup claude-code` before enabling it)',
      });
    } else if (sb.socketAllowed) {
      checks.push({ name: 'Claude Code sandbox', ok: true, detail: 'enabled; proxy socket allowed' });
    } else {
      checks.push({
        name: 'Claude Code sandbox',
        ok: false,
        detail: 'enabled, but sandboxed commands cannot connect to the proxy socket (EPERM)',
        fix: process.platform === 'darwin' ? 'aquaman coder setup claude-code' : LINUX_SANDBOX_LIMITATION,
      });
    }

    // Render — matches `aquaman openclaw doctor` formatting.
    console.log('');
    console.log(`  \u{1F531} Aquaman ${VERSION} — Welcome to the doctor’s office.`);
    console.log('');
    for (const c of checks) {
      const mark = c.ok ? '✓' : '✗';
      console.log(`  ${mark} ${aqua(c.name)}${c.detail ? '  ' + c.detail : ''}`);
      if (!c.ok && c.fix) console.log(`    → ${c.fix}`);
    }
    const issues = checks.filter((c) => !c.ok).length;
    console.log('');
    if (issues === 0) {
      console.log('  All checks passed.');
    } else {
      console.log(`  ${issues} issue${issues > 1 ? 's' : ''} found. Fix the above and re-run \`aquaman coder doctor\`.`);
    }
    console.log('');
    process.exit(issues > 0 ? 1 : 0);
  });

// ---------------- status ----------------

program
  .command('status')
  .description('Show coder configuration and recent broker activity')
  .action(async () => {
    console.log('\n  aquaman-coder status\n');

    // Projects
    const projectsPath = defaultProjectsPath();
    if (!fs.existsSync(projectsPath)) {
      console.log('  Projects: none configured');
      console.log(`  Add one: aquaman coder project add <name>\n`);
    } else {
      try {
        const projects = loadProjects();
        const names = Object.keys(projects.projects);
        console.log(`  Projects: ${names.length} configured (${projectsPath})`);
        for (const name of names) {
          const cfg = projects.projects[name];
          const envCount = Object.keys(cfg.env).length;
          console.log(`    - ${name}: ${cfg.paths.length} path(s), ${envCount} env binding(s)`);
        }
      } catch (err) {
        console.log(`  Projects: invalid (${(err as Error).message})`);
      }
    }

    // Claude Code hooks
    const settingsPath = defaultSettingsPath();
    console.log('');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const installed = raw.includes('aquaman-coder hook') || raw.includes('aquaman coder hook');
      console.log(`  Claude Code hooks: ${installed ? 'installed' : 'not configured'}`);
      console.log(`    ${settingsPath}`);
    } else {
      console.log('  Claude Code hooks: not configured (settings.json missing)');
    }
    const codexStatus = codexHookStatus();
    console.log(`  Codex hooks: ${codexStatus.installed ? (codexStatus.trusted ? 'installed, trusted' : 'installed, not yet trusted') : 'not configured'}`);
    if (codexStatus.installed) console.log(`    ${defaultCodexHooksPath()}`);

    // Broker connectivity
    console.log('');
    const socketPath = defaultSocketPath();
    const broker = new BrokerClient({ socketPath, timeoutMs: 2000 });
    try {
      const health = await broker.health();
      console.log(`  Broker: reachable (proxy v${health.version ?? '?'})`);
    } catch (err) {
      console.log(`  Broker: unreachable (${(err as Error).message})`);
    }
    console.log('');
  });

// ---------------- helpers ----------------

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

if (process.argv.length <= 2) {
  program.help();
}

program.parseAsync().catch((err: Error) => {
  console.error(err.message || err);
  process.exit(1);
});
