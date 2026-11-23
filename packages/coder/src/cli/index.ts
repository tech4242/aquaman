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
import * as os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { Command } from 'commander';
import { VERSION } from '../index.js';
import {
  defaultProjectsPath,
  loadProjects,
  saveProjects,
  ROUTE_BASE_PATH,
  defaultRouteBasePath,
  isLoaderEnvName,
  type ProjectRoute,
  findProjectForCwd,
  parseRef,
  type ProjectConfig,
} from '../projects.js';
import { BrokerClient, BrokerError, defaultSocketPath } from '../broker-client.js';
import { runHookFromStdin } from '../adapters/claude-code/hook.js';
import {
  installClaudeCodeHooks,
  claudeCodeHooksInstalled,
  uninstallClaudeCodeHooks,
  defaultSettingsPath,
  sandboxSocketStatus,
  claudeHookFailsClosed,
  versionAtLeast,
  ON_FAILURE_MIN_VERSION,
} from '../adapters/claude-code/setup.js';
import {
  installCodexHooks,
  uninstallCodexHooks,
  codexHookStatus,
  codexSandboxStatus,
  defaultCodexHooksPath,
  codexHome,
} from '../adapters/codex/setup.js';
import { writeAgentsBlock, installSkill, type CodingAgent, type RunMode } from '../agent-setup.js';

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
 * connects by default (verified with `codex sandbox`, 0.156.1 and 0.169.0:
 * EPERM). A permissions profile with `network.enabled = true` works;
 * `unix_sockets` alone stays EPERM. 0.156.1 also needed the socket listed, and
 * 0.169.0 ignores the list once network is enabled, so the snippet carries
 * both. Setup does not edit config.toml, so it prints this instead, and
 * doctor checks the file (`codexSandboxStatus`).
 */
/** `claude --version`, or null when Claude Code is not on PATH. */
function claudeCodeVersion(): string | null {
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /\d+\.\d+\.\d+/.exec(out)?.[0] ?? null;
  } catch {
    return null;
  }
}

function codexSandboxNote(): string {
  return `Codex's sandbox blocks the proxy socket by default. To allow it, add to ${path.join(codexHome(), 'config.toml')}:\n` +
    `  default_permissions = "aquaman"\n` +
    `  [permissions.aquaman]\n` +
    `  extends = ":workspace"\n` +
    `  [permissions.aquaman.network]\n` +
    `  enabled = true\n` +
    `  unix_sockets = { "${defaultSocketPath()}" = "allow" }\n` +
    `Note: enabled = true also gives sandboxed commands outbound network access, and on Codex 0.169 every Unix socket, not only this one.`;
}

// ANSI color helpers: the aqua of the website and the banner. Mirrors packages/proxy/src/cli/index.ts
// so `aquaman coder doctor` matches `aquaman openclaw doctor`.
// Respects NO_COLOR (https://no-color.org/) and disables in piped output.
const noColor = process.env['NO_COLOR'] !== undefined ||
                (!process.stdout.isTTY && process.env['FORCE_COLOR'] === undefined);
const aqua = (s: string) => noColor ? s : `\x1b[38;2;63;193;192m${s}\x1b[0m`;

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
  .option('--fail-closed', `claude-code: block the tool call when the hook cannot run (Claude Code >= ${ON_FAILURE_MIN_VERSION})`)
  .option('--no-fail-closed', 'claude-code: let the tool call run when the hook cannot run (the default)')
  .action((agent: string, opts: { uninstall?: boolean; failClosed?: boolean }) => {
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

    if (opts.failClosed && !opts.uninstall) {
      const version = claudeCodeVersion();
      if (version && !versionAtLeast(version, ON_FAILURE_MIN_VERSION)) {
        console.error(`--fail-closed needs Claude Code ${ON_FAILURE_MIN_VERSION} or later (found ${version}). Update Claude Code and re-run.`);
        process.exit(1);
      }
      if (!version) {
        console.log(`Could not find \`claude\` to check its version; --fail-closed needs Claude Code ${ON_FAILURE_MIN_VERSION} or later.`);
      }
    }

    const result = opts.uninstall
      ? uninstallClaudeCodeHooks()
      : installClaudeCodeHooks({ failClosed: opts.failClosed });

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
    // An existing project is merged into, never replaced, so its other
    // bindings survive (issue #67): new paths are appended, and an env name
    // that already exists takes the new ref. --replace opts out.
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

/** How long the daemon's dialog waits for a person before a marked reference counts as unanswered. */
const ASK_FIRST_DIALOG_SECONDS = 90;

/** The daemon's refusals for a reference marked ask-first: the credential is there, and a person has not allowed it. */
const ASK_FIRST_REFUSALS = new Set(['ask_first_declined', 'ask_first_unanswered', 'ask_first_required', 'prompt_unavailable']);

/**
 * Resolve one reference for `exec`. First without a dialog and inside the
 * client's usual timeout, which is every reference that is not marked
 * ask-first and every marked one a person already allowed. Only a marked
 * reference nobody has allowed is asked for again, this time waiting for the
 * daemon's dialog.
 */
async function resolveAskingIfMarked(
  broker: BrokerClient,
  parsed: { service: string; key: string },
  ref: string,
  cwd: string,
): Promise<{ value: string }> {
  try {
    return await broker.resolve({ service: parsed.service, key: parsed.key, ttlSeconds: 60, ask: false });
  } catch (err) {
    if (!(err instanceof BrokerError) || err.code !== 'ask_first_required') throw err;
  }
  console.error(`aquaman: ${ref} is marked ask-first. Waiting up to ${ASK_FIRST_DIALOG_SECONDS} seconds for an answer in aquaman's dialog on this machine.`);
  return broker.resolve({
    service: parsed.service,
    key: parsed.key,
    ttlSeconds: 60,
    askTimeoutSeconds: ASK_FIRST_DIALOG_SECONDS,
    project: cwd,
    timeoutMs: (ASK_FIRST_DIALOG_SECONDS + 30) * 1000,
  });
}

program
  .command('exec <cmd> [args...]')
  .description('Run a command with project env injected and stdout/stderr redacted')
  .passThroughOptions()
  .allowUnknownOption()
  .option('--raw', 'Disable stdout/stderr redaction', false)
  .action(async (cmd: string, args: string[], opts: { raw?: boolean }) => {
    // Unredacted output is for a person at a terminal. Anything that captures
    // the output instead (an agent's shell tool, a pipe) would be handed the values.
    if (opts.raw && !process.stdout.isTTY) {
      console.error('aquaman: --raw only works with a terminal on stdout; without it, output is redacted for whoever is capturing it. Drop --raw.');
      process.exit(1);
    }
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
    let askFirstRefused = false;
    for (const [envName, ref] of Object.entries(match.config.env)) {
      // loadProjects() refuses a file with a reference that does not parse.
      const parsed = parseRef(ref)!;
      const route = match.config.routes?.[envName];
      try {
        if (route) {
          // Routed: the command gets the local proxy's address and token, and
          // the proxy adds the credential on the way out. The value itself is
          // never fetched, so it is never in this process or the command.
          const target = await broker.route(parsed);
          env[envName] = target.token;
          env[route.url_env] = target.url + (route.base_path ?? '');
          injectedValues.push(target.token);
          continue;
        }
        const result = await resolveAskingIfMarked(broker, parsed, ref, cwd);
        env[envName] = result.value;
        injectedValues.push(result.value);
      } catch (err) {
        if (err instanceof BrokerError && err.code !== undefined && ASK_FIRST_REFUSALS.has(err.code)) askFirstRefused = true;
        // One reference the daemon will not serve (not stored yet, not
        // declared) leaves that one variable unset. The command still runs:
        // most commands in a project need none of its credentials, and the
        // ones that do fail on their own with the variable named here.
        if (err instanceof BrokerError && err.status === 404 && err.code !== 'broker_disabled') {
          console.error(`aquaman: ${envName} is not set for this command: ${err.message}${route && err.fix ? `. ${err.fix}` : ''}`);
          continue;
        }
        console.error(`aquaman: failed to resolve ${envName}: ${(err as Error).message}`);
        process.exit(1);
      }
    }

    // Reached with nothing to inject only when the hook could not ask the
    // proxy first. The hook's `allow` was for a command run with credentials,
    // so this one is not run under it.
    if (injectedValues.length === 0 && Object.keys(match.config.env).length > 0) {
      if (askFirstRefused) {
        // Nothing to add or bind: the credential is there, and a person has not allowed it.
        console.error('aquaman: none of this project\'s credentials were handed out (see above), so the command was not run.');
        process.exit(1);
      }
      console.error('aquaman: none of this project\'s credentials are available, so the command was not run. Add one (aquaman request <ref> --env <NAME>) or run the command without aquaman-coder exec.');
      process.exit(1);
    }

    const stdio = opts.raw ? 'inherit' : ['inherit', 'pipe', 'pipe'] as const;
    const child = spawn(cmd, args, { env, stdio: stdio as any });

    if (!opts.raw) {
      // Value-based redaction: prepend patterns built from the exact strings
      // we just injected so they're stripped from child stdout/stderr no
      // matter what shape they happen to have. Generic BUILTIN_PATTERNS still
      // run after as defense-in-depth for any secrets the child surfaces that
      // we did NOT inject (hardcoded tokens, env vars leaked from parent, ...).
      // A value can arrive split across two chunks, so each stream goes
      // through a redactor that holds back the end of the text while it could
      // still be the start of one. A finished line that is not is written at
      // once, which is what lets a program that answers and then waits (a
      // stdio MCP server) run under exec.
      const { createStreamRedactor, buildValuePatterns, BUILTIN_PATTERNS } = await import('aquaman-proxy');
      const patterns = [...buildValuePatterns(injectedValues), ...BUILTIN_PATTERNS];
      const longestValue = injectedValues.reduce((n, v) => Math.max(n, v.length), 0);
      const pipeRedacted = (src: NodeJS.ReadableStream, dst: NodeJS.WritableStream) => {
        const redactor = createStreamRedactor(patterns, longestValue, injectedValues);
        src.setEncoding('utf-8');
        src.on('data', (chunk: string) => {
          const out = redactor.push(chunk);
          if (out) dst.write(out);
        });
        src.on('end', () => {
          const out = redactor.end();
          if (out) dst.write(out);
        });
      };
      if (child.stdout) pipeRedacted(child.stdout, process.stdout);
      if (child.stderr) pipeRedacted(child.stderr, process.stderr);
    }

    // Whoever started this process stops it with a signal (an agent host
    // ending a server it launched), and the command is what they meant to
    // stop: without this it would be left running with the credentials.
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(signal, () => { child.kill(signal); });
    }

    // `close` fires after the child's output streams have ended, so the held
    // back tail is written before this process exits.
    child.on('close', (code, signal) => process.exit(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 0)));
    child.on('error', (err) => {
      console.error(`Failed to spawn "${cmd}": ${err.message}`);
      process.exit(1);
    });
  });


// ---------------- init / bind (agent-run, no prompts) ----------------

/**
 * The project covering `cwd`, creating one named after the directory if none
 * does. Returns its name and whether it was created.
 */
function ensureProjectForCwd(cwd: string): { name: string; created: boolean; file: ReturnType<typeof loadProjects> } {
  const file = fs.existsSync(defaultProjectsPath()) ? loadProjects() : { version: 1, projects: {} };
  const match = findProjectForCwd(cwd, file);
  if (match) return { name: match.name, created: false, file };
  // A project's bindings reach every command under its paths. The home
  // directory, or anything above it, is never what someone meant by "this project".
  const home = fs.realpathSync(os.homedir());
  if (cwd === home || home.startsWith(cwd.endsWith(path.sep) ? cwd : cwd + path.sep)) {
    throw new Error(`${cwd} is your home directory or contains it. Run this from the project's own directory`);
  }
  const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let name = base;
  for (let n = 2; file.projects[name]; n++) name = `${base}-${n}`;
  file.projects[name] = { paths: [cwd], env: {} };
  saveProjects(file);
  return { name, created: true, file };
}

program
  .command('init')
  .description('Set up a coding agent for the current directory: project, hooks, skill, instructions block. Never prompts')
  .option('--no-hooks', 'Install no hooks; commands that need credentials are then run as `aquaman-coder exec -- <command>`')
  .requiredOption('--agent <agent>', 'claude-code or codex')
  .option('--json', 'Print one JSON object and nothing else')
  .option('--no-instructions', 'Do not write the aquaman block into CLAUDE.md / AGENTS.md')
  .option('--no-skill', 'Do not install the aquaman-credentials skill')
  .action((opts: { agent: string; json?: boolean; instructions: boolean; skill: boolean; hooks: boolean }) => {
    const result: Record<string, any> = { ok: false, agent: opts.agent, human_steps: [] as string[] };
    const finish = (code: number): never => {
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.error) {
        console.error(result.error);
      } else {
        console.log(`Project "${result.project.name}" covers ${result.project.path}`);
        console.log(result.mode === 'hook' ? `Hooks: ${result.hooks.path}` : 'Hooks: none. Run commands that need credentials as: aquaman-coder exec -- <command>');
        if (result.skill) console.log(`Skill: ${result.skill.path}`);
        if (result.agents_file) console.log(`Instructions: ${result.agents_file.path}`);
        for (const step of result.human_steps) console.log(`A person needs to: ${step}`);
      }
      process.exit(code);
    };
    if (opts.agent !== 'claude-code' && opts.agent !== 'codex') {
      result.error = `Unsupported agent "${opts.agent}". Supported: claude-code, codex`;
      result.fix = 'aquaman-coder init --agent claude-code   (or: --agent codex)';
      finish(1);
    }
    const agent = opts.agent as CodingAgent;
    const cwd = fs.realpathSync(process.cwd());
    try {
      const project = ensureProjectForCwd(cwd);
      result.project = { name: project.name, path: cwd, created: project.created };

      if (!opts.hooks) {
        // Nothing is written to the host's settings. Hooks someone installed
        // earlier are user-level and still wrap commands here, so say so.
        const hooksPath = agent === 'claude-code' ? defaultSettingsPath() : defaultCodexHooksPath();
        const installed = agent === 'claude-code' ? claudeCodeHooksInstalled(hooksPath) : codexHookStatus(hooksPath).installed;
        result.hooks = { path: hooksPath, installed, changed: false };
      } else if (agent === 'claude-code') {
        const hooks = installClaudeCodeHooks();
        result.hooks = { path: hooks.path, installed: true, changed: hooks.changed };
        if (hooks.changed) result.human_steps.push('restart Claude Code (or start a new session) so it loads the hooks');
      } else {
        const hooks = installCodexHooks();
        result.hooks = { path: hooks.path, installed: true, changed: hooks.changed };
        if (!codexHookStatus(hooks.path).trusted) {
          result.human_steps.push('start `codex` and trust the aquaman hooks in the startup hook review');
        }
      }
      const mode: RunMode = result.hooks.installed ? 'hook' : 'exec';
      result.mode = mode;
      if (mode === 'exec') result.run = 'aquaman-coder exec -- <command>';
      if (agent === 'codex') {
        const sandbox = codexSandboxStatus(defaultSocketPath());
        if (!sandbox.ok) result.human_steps.push(`let Codex's sandbox reach the proxy socket: ${sandbox.detail}. The config.toml profile is in docs/codex.md (https://aquaman.sh/docs/codex/)`);
      }
      if (opts.skill) result.skill = installSkill(agent);
      if (opts.instructions) result.agents_file = writeAgentsBlock(agent, cwd, mode);
      result.ok = true;
    } catch (err) {
      result.error = (err as Error).message;
      finish(1);
    }
    finish(0);
  });

program
  .command('bind <binding>')
  .description('Bind NAME=aquaman://service/key for the project covering the current directory')
  .option('--check', 'Only check that the binding could be made; change nothing')
  .option('--via-proxy <URL_ENV>', 'Send the program through the proxy: NAME gets the proxy token and URL_ENV the proxy URL, so the program never holds the credential')
  .option('--base-path <path>', 'With --via-proxy: path appended to the proxy URL (default /v1 for openai, /api for slack, none otherwise)')
  .option('--json', 'Print one JSON object and nothing else')
  .action((binding: string, opts: { json?: boolean; check?: boolean; viaProxy?: string; basePath?: string }) => {
    const fail = (error: string, fix?: string): never => {
      if (opts.json) console.log(JSON.stringify({ ok: false, error, fix }, null, 2));
      else { console.error(error); if (fix) console.error(`Fix: ${fix}`); }
      process.exit(1);
    };
    const idx = binding.indexOf('=');
    const name = idx < 0 ? '' : binding.slice(0, idx);
    const ref = idx < 0 ? '' : binding.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) fail(`Bad binding "${binding}". Expected NAME=aquaman://service/key`);
    if (isLoaderEnvName(name)) fail(`${name} controls how programs are loaded or run and cannot be bound to a credential`);
    if (!parseRef(ref)) fail(`Bad reference "${ref}". Expected aquaman://service/key`);
    let route: ProjectRoute | undefined;
    if (opts.viaProxy !== undefined) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.viaProxy) || opts.viaProxy === name || isLoaderEnvName(opts.viaProxy)) {
        fail(`Bad --via-proxy "${opts.viaProxy}". Expected the name of the variable the program reads its base URL from, e.g. OPENAI_BASE_URL`);
      }
      const basePath = opts.basePath ?? defaultRouteBasePath(parseRef(ref)!.service);
      if (!ROUTE_BASE_PATH.test(basePath)) fail(`Bad --base-path "${basePath}". Expected a path such as /v1`);
      route = basePath ? { url_env: opts.viaProxy, base_path: basePath } : { url_env: opts.viaProxy };
    } else if (opts.basePath !== undefined) {
      fail('--base-path only applies with --via-proxy');
    }
    // A binding gives every command under the project's paths the value, so
    // the project is one somebody registered on purpose, never one made up
    // from wherever this happened to be run.
    const cwd = fs.realpathSync(process.cwd());
    const file = fs.existsSync(defaultProjectsPath()) ? loadProjects() : { version: 1, projects: {} };
    const match = findProjectForCwd(cwd, file);
    if (!match) {
      fail(
        `No aquaman project covers ${cwd}`,
        'Run from the project directory, after `aquaman init --agent <agent> --no-hooks` there (or: aquaman coder project add <name> --path <dir>)',
      );
    }
    const project = { name: match!.name };
    if (opts.check) {
      if (opts.json) console.log(JSON.stringify({ ok: true, project: project.name, env: name, ref, checked: true }, null, 2));
      else console.log(`${name} -> ${ref} can be bound in project "${project.name}"`);
      return;
    }
    const current = file.projects[project.name];
    if (route && Object.hasOwn(current.env, route.url_env)) {
      fail(`${route.url_env} is already bound to a credential in project "${project.name}"; pick another variable for the URL`);
    }
    // Binding a name again replaces how it is delivered: with a route, or without one.
    const routes = { ...(current.routes ?? {}) };
    if (route) routes[name] = route;
    else delete routes[name];
    file.projects[project.name] = { ...current, env: { ...current.env, [name]: ref } };
    if (Object.keys(routes).length > 0) file.projects[project.name].routes = routes;
    else delete file.projects[project.name].routes;
    saveProjects(file);
    if (opts.json) console.log(JSON.stringify({ ok: true, project: project.name, env: name, ref, ...(route ? { via_proxy: route } : {}) }, null, 2));
    else console.log(route
      ? `${name} -> ${ref} through the proxy in project "${project.name}" (${route.url_env} gets the proxy URL)`
      : `${name} -> ${ref} in project "${project.name}"`);
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
  .option('--json', 'Print one JSON object and nothing else')
  .action(async (doctorOpts: { json?: boolean }) => {
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
        fix: 'aquaman init --agent <agent> --no-hooks   (or, in a terminal of your own: aquaman daemon)',
      });
    }

    // 4. Per-project: every declared aquaman:// ref resolves
    if (brokerOk && projects) {
      for (const [name, cfg] of Object.entries(projects.projects)) {
        for (const [envName, ref] of Object.entries(cfg.env)) {
          // loadProjects() refuses a file with a reference that does not parse.
          const parsed = parseRef(ref)!;
          try {
            // A check never raises a dialog.
            await broker.resolve({ service: parsed.service, key: parsed.key, ttlSeconds: 1, ask: false });
            checks.push({ name: `project ${name}: ${envName}`, ok: true, detail: ref });
          } catch (err) {
            const code = err instanceof BrokerError ? err.code : undefined;
            if (code === 'ask_first_required') {
              checks.push({ name: `project ${name}: ${envName}`, ok: true, detail: `${ref} (marked ask-first: a person is asked in a dialog when a command needs it)` });
              continue;
            }
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
    const claudeInstalled = claudeCodeHooksInstalled(settingsPath);
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
      checks.push({
        name: 'Claude Code hooks',
        ok: true,
        detail: claudeHookFailsClosed(settingsPath)
          ? `${settingsPath} (a hook that cannot run blocks the tool call)`
          : `${settingsPath} (a hook that cannot run lets the command through without credentials; \`aquaman coder setup claude-code --fail-closed\` blocks instead)`,
      });
    }
    if (codex.installed) {
      checks.push({
        name: 'Codex hooks',
        ok: codex.trusted,
        detail: codex.trusted ? codexHooksPath : `${codexHooksPath} (installed, not yet trusted, so Codex skips them)`,
        fix: codex.trusted ? undefined : 'Start `codex` and trust the aquaman hooks in the startup hook review',
      });
      const codexSandbox = codexSandboxStatus(defaultSocketPath());
      checks.push({
        name: 'Codex sandbox',
        ok: codexSandbox.ok,
        detail: codexSandbox.detail,
        fix: codexSandbox.ok ? undefined : codexSandboxNote(),
      });
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

    if (doctorOpts.json) {
      const failed = checks.filter((c) => !c.ok).length;
      console.log(JSON.stringify({ ok: failed === 0, version: VERSION, issues: failed, checks }, null, 2));
      process.exit(failed > 0 ? 1 : 0);
    }

    // Render — matches `aquaman openclaw doctor` formatting.
    console.log('');
    console.log(`  \u{1F419} aquaman ${VERSION} — Welcome to the doctor’s office.`);
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
  .description('Show coder configuration and broker connectivity')
  .option('--json', 'Print one JSON object and nothing else')
  .action(async (statusOpts: { json?: boolean }) => {
    // Gather first, then print in one of two forms.
    const projectsPath = defaultProjectsPath();
    let projects: Array<{ name: string; paths: string[]; env: Record<string, string>; routes?: Record<string, ProjectRoute> }> = [];
    let projectsError: string | undefined;
    if (fs.existsSync(projectsPath)) {
      try {
        const file = loadProjects();
        projects = Object.entries(file.projects).map(([name, cfg]) => ({ name, paths: cfg.paths, env: cfg.env, ...(cfg.routes ? { routes: cfg.routes } : {}) }));
      } catch (err) {
        projectsError = (err as Error).message;
      }
    }
    let current: string | null = null;
    try {
      current = findProjectForCwd(process.cwd(), loadProjects())?.name ?? null;
    } catch { /* no projects file, or invalid */ }

    const settingsPath = defaultSettingsPath();
    const claudeInstalled = claudeCodeHooksInstalled(settingsPath);
    const codexStatus = codexHookStatus();

    const socketPath = defaultSocketPath();
    let broker: { reachable: boolean; version?: string; error?: string };
    try {
      const health = await new BrokerClient({ socketPath, timeoutMs: 2000 }).health();
      broker = { reachable: true, version: health.version };
    } catch (err) {
      broker = { reachable: false, error: (err as Error).message };
    }

    if (statusOpts.json) {
      console.log(JSON.stringify({
        version: VERSION,
        // Env maps hold references (aquaman://service/key), never values.
        current_project: current,
        projects,
        projects_error: projectsError,
        hooks: {
          claude_code: { installed: claudeInstalled, path: settingsPath },
          codex: { installed: codexStatus.installed, trusted: codexStatus.trusted, path: defaultCodexHooksPath() },
        },
        broker: { ...broker, socket: socketPath },
      }, null, 2));
      return;
    }

    console.log('\n  aquaman-coder status\n');
    if (projectsError) {
      console.log(`  Projects: invalid (${projectsError})`);
    } else if (projects.length === 0) {
      console.log('  Projects: none configured');
      console.log('  Add one: aquaman coder project add <name>\n');
    } else {
      console.log(`  Projects: ${projects.length} configured (${projectsPath})`);
      for (const p of projects) {
        console.log(`    - ${p.name}: ${p.paths.length} path(s), ${Object.keys(p.env).length} env binding(s)`);
      }
    }
    console.log('');
    console.log(`  Claude Code hooks: ${claudeInstalled ? 'installed' : 'not configured'}`);
    console.log(`    ${settingsPath}`);
    console.log(`  Codex hooks: ${codexStatus.installed ? (codexStatus.trusted ? 'installed, trusted' : 'installed, not yet trusted') : 'not configured'}`);
    if (codexStatus.installed) console.log(`    ${defaultCodexHooksPath()}`);
    console.log('');
    console.log(broker.reachable ? `  Broker: reachable (proxy v${broker.version ?? '?'})` : `  Broker: unreachable (${broker.error})`);
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
