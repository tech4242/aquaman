#!/usr/bin/env node
/**
 * aquaman-coder CLI.
 *
 * Subcommands:
 *   setup <agent>      Install hook configuration for a coding agent
 *                      (currently: claude-code; codex/opencode/cursor planned)
 *   project list       List configured projects
 *   project add        Add a project (interactive or flags)
 *   project remove     Remove a project
 *   get <ref>          Resolve an aquaman:// ref via the broker and print
 *   exec <cmd...>      Run a command with the matching project env injected
 *   hook               Stdio hook handler (invoked by Claude Code)
 *   doctor             Diagnostics
 */

import * as fs from 'node:fs';
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
import { BrokerClient, defaultSocketPath } from '../broker-client.js';
import { runHookFromStdin } from '../adapters/claude-code/hook.js';
import {
  installClaudeCodeHooks,
  uninstallClaudeCodeHooks,
  defaultSettingsPath,
} from '../adapters/claude-code/setup.js';

const program = new Command();
program
  .name('aquaman-coder')
  .description('Vault adapter for AI coding agents')
  .version(VERSION)
  .enablePositionalOptions();

// ---------------- setup ----------------

program
  .command('setup <agent>')
  .description('Install hook configuration for a coding agent (claude-code)')
  .option('--uninstall', 'Remove aquaman hooks from the agent config', false)
  .action((agent: string, opts: { uninstall?: boolean }) => {
    if (agent !== 'claude-code') {
      console.error(`Unsupported agent "${agent}". Supported: claude-code`);
      console.error('(codex / opencode / cursor adapters are planned for v0.13.0+)');
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
  .description('Add a project to ~/.aquaman/projects.yaml')
  .option('--path <path>', 'Filesystem path (repeat for multiple)', collect, [])
  .option('--env <name=ref>', 'Env binding (repeat for multiple)', collect, [])
  .action((name: string, opts: { path: string[]; env: string[] }) => {
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
    const paths = opts.path.length > 0 ? opts.path : [process.cwd()];
    const cfg: ProjectConfig = { paths, env };
    file.projects[name] = cfg;
    saveProjects(file);
    console.log(`Added project "${name}" -> ${defaultProjectsPath()}`);
  });

project
  .command('remove <name>')
  .description('Remove a project')
  .action((name: string) => {
    const file = loadProjects();
    if (!file.projects[name]) {
      console.error(`Project "${name}" not found`);
      process.exit(1);
    }
    delete file.projects[name];
    saveProjects(file);
    console.log(`Removed project "${name}"`);
  });

// ---------------- get ----------------

program
  .command('get <ref>')
  .description('Resolve an aquaman:// ref via the broker and print the value')
  .action(async (ref: string) => {
    const parsed = parseRef(ref);
    if (!parsed) {
      console.error(`Bad reference "${ref}". Expected aquaman://service/key`);
      process.exit(1);
    }
    const broker = new BrokerClient();
    try {
      const result = await broker.resolve({ service: parsed.service, key: parsed.key });
      process.stdout.write(result.value);
      if (process.stdout.isTTY) process.stdout.write('\n');
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ---------------- exec ----------------

program
  .command('exec <cmd> [args...]')
  .description('Run a command with the matching project env injected')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (cmd: string, args: string[]) => {
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
    for (const [envName, ref] of Object.entries(match.config.env)) {
      const parsed = parseRef(ref);
      if (!parsed) continue;
      try {
        const result = await broker.resolve({ service: parsed.service, key: parsed.key, ttlSeconds: 60 });
        env[envName] = result.value;
      } catch (err) {
        console.error(`aquaman: failed to resolve ${envName}: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    const child = spawn(cmd, args, { env, stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    child.on('error', (err) => {
      console.error(`Failed to spawn "${cmd}": ${err.message}`);
      process.exit(1);
    });
  });

// ---------------- hook ----------------

program
  .command('hook')
  .description('Stdio hook handler (invoked by Claude Code, not directly)')
  .action(async () => {
    const code = await runHookFromStdin(process.argv);
    process.exit(code);
  });

// ---------------- doctor ----------------

program
  .command('doctor')
  .description('Diagnostic checks')
  .action(async () => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

    const projectsPath = defaultProjectsPath();
    checks.push({
      name: 'projects.yaml',
      ok: fs.existsSync(projectsPath),
      detail: projectsPath,
    });

    if (checks[0].ok) {
      try {
        const projects = loadProjects();
        const count = Object.keys(projects.projects).length;
        checks.push({ name: 'projects parsed', ok: true, detail: `${count} project(s)` });
      } catch (err) {
        checks.push({ name: 'projects parsed', ok: false, detail: (err as Error).message });
      }
    }

    const socketPath = defaultSocketPath();
    const broker = new BrokerClient({ socketPath, timeoutMs: 2000 });
    try {
      const health = await broker.health();
      checks.push({ name: 'proxy running', ok: true, detail: `version ${health.version ?? '?'}` });
    } catch (err) {
      checks.push({ name: 'proxy running', ok: false, detail: (err as Error).message });
    }

    const settingsPath = defaultSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      const installed = raw.includes('aquaman-coder hook');
      checks.push({
        name: 'Claude Code hooks',
        ok: installed,
        detail: installed ? settingsPath : `not configured (run: aquaman-coder setup claude-code)`,
      });
    } else {
      checks.push({
        name: 'Claude Code hooks',
        ok: false,
        detail: `${settingsPath} does not exist`,
      });
    }

    for (const c of checks) {
      console.log(`  ${c.ok ? 'OK' : 'FAIL'} ${c.name}${c.detail ? '  ' + c.detail : ''}`);
    }
    const fail = checks.some((c) => !c.ok);
    process.exit(fail ? 1 : 0);
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
