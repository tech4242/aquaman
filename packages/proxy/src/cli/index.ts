#!/usr/bin/env node

/**
 * aquaman CLI - Credential isolation layer for OpenClaw
 *
 * Features NOT in OpenClaw:
 * - Credential proxy: API keys never touch OpenClaw process
 * - Enterprise backends: 1Password, HashiCorp Vault
 * - Hash-chained audit logs: Tamper-evident logging
 * - Custom service registry: YAML-based service config
 */

import { Command, Help } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';

import {
  loadConfig,
  getConfigDir,
  ensureConfigDir,
  getDefaultConfig,
  expandPath,
  createAuditLogger,
  createCredentialStore,
  saveConfig,
  type WrapperConfig
} from '../core/index.js';

import { fileURLToPath } from 'node:url';

import { createCredentialProxy, type CredentialProxy } from '../daemon.js';
import { createServiceRegistry, ServiceRegistry } from '../service-registry.js';
import { createOpenClawIntegration, authProfilesAreSqliteOnly } from '../openclaw/integration.js';
import { loadPolicyFromConfig, validatePolicyConfig, getDefaultPolicyPresets, matchPolicy, type ServicePolicy } from '../request-policy.js';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

// Read version from package.json (single source of truth)
const __cliFilename = fileURLToPath(import.meta.url);
const __cliDirname = path.dirname(__cliFilename);
const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__cliDirname, '../../package.json'), 'utf-8'));
const VERSION: string = pkgJson.version;

// ANSI color helpers — aquamarine theme
// Respects NO_COLOR (https://no-color.org/) and disables in piped/redirected output
const noColor = process.env['NO_COLOR'] !== undefined ||
                (!process.stdout.isTTY && process.env['FORCE_COLOR'] === undefined);
const aqua = (s: string) => noColor ? s : `\x1b[38;2;127;255;212m${s}\x1b[0m`;

// Credential name validation — shared pattern from daemon.ts and systemd-creds backend
const SAFE_CRED_NAME = /^[a-z0-9][a-z0-9._-]*$/;
function validateCredName(label: string, value: string): void {
  if (!SAFE_CRED_NAME.test(value)) {
    console.error(`Invalid ${label}: "${value}". Allowed: lowercase alphanumeric, dots, hyphens, underscores.`);
    process.exit(1);
  }
}

// PID file management
const getPidFile = () => path.join(getConfigDir(), 'daemon.pid');

const writePidFile = () => {
  fs.writeFileSync(getPidFile(), process.pid.toString(), 'utf-8');
};

const readPidFile = (): number | null => {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) return null;
  const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  return isNaN(pid) ? null : pid;
};

const removePidFile = () => {
  const pidFile = getPidFile();
  if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
};

const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Prompt for secret input with echo suppression (TTY) or plain readline (pipe) */
async function promptSecretInput(prompt: string): Promise<string> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  if (process.stdin.isTTY) {
    return new Promise((resolve) => {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      let input = '';
      const onData = (data: Buffer) => {
        const char = data.toString();
        if (char === '\n' || char === '\r') {
          stdin.setRawMode(false);
          stdin.removeListener('data', onData);
          stdin.pause();
          rl.close();
          process.stdout.write('\n');
          resolve(input.trim());
        } else if (char === '\x7f' || char === '\b') {
          input = input.slice(0, -1);
        } else if (char === '\x03') {
          stdin.setRawMode(false);
          process.exit(0);
        } else {
          input += char;
        }
      };
      stdin.on('data', onData);
    });
  }

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const program = new Command();

program
  .name('aquaman')
  .description('Credential isolation for AI agents \u2014 vault for the proxy core, OpenClaw plugin path, coding-agent adapter path')
  .version(VERSION)
  .configureHelp({
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments
        .map((arg: any) => {
          const n = arg.name() + (arg.variadic ? '...' : '');
          return arg.required ? `<${n}>` : `[${n}]`;
        })
        .join(' ');
      // Command names render in default color; only section headings
      // (rendered by our custom formatHelp below) get the aqua treatment.
      return cmd.name() + (cmd.options.length ? ' [options]' : '') + (args ? ' ' + args : '');
    },
    // Custom grouped help layout for the root program. Subcommand helps
    // (e.g. `aquaman openclaw --help`) use Commander's default formatter.
    formatHelp(cmd, helper) {
      // Only customize the ROOT command's help. Nested subcommands keep the
      // default layout \u2014 call the un-overridden formatter directly to avoid
      // recursing into this override.
      if (cmd !== program) return Help.prototype.formatHelp.call(helper, cmd, helper);

      const lines: string[] = [];
      lines.push('');
      lines.push(`  \u{1F531} ${aqua('Aquaman')} ${VERSION} \u2014 Credential isolation for AI agents`);
      lines.push('');
      lines.push(`Usage: ${helper.commandUsage(cmd)}`);
      lines.push('');
      lines.push(cmd.description());
      lines.push('');

      // Options
      const opts = helper.visibleOptions(cmd);
      if (opts.length) {
        lines.push('Options:');
        for (const opt of opts) {
          lines.push(`  ${helper.optionTerm(opt).padEnd(20)}  ${helper.optionDescription(opt)}`);
        }
        lines.push('');
      }

      const all = helper.visibleCommands(cmd);
      const byName = new Map(all.map((c) => [c.name(), c]));
      const renderRow = (term: string, desc: string) =>
        `  ${term.padEnd(30)}  ${desc}`;
      const renderCmd = (c: any) => renderRow(c.name(), c.description() || '');

      // --- Vault & core (agent-agnostic) ---
      lines.push(aqua('Vault & core (agent-agnostic)'));
      const vaultCore = ['setup', 'doctor', 'status', 'daemon', 'stop', 'init'];
      for (const name of vaultCore) {
        const c = byName.get(name);
        if (c) lines.push(renderCmd(c));
      }
      lines.push('');
      lines.push(aqua('Vault management'));
      for (const name of ['credentials', 'audit', 'services', 'policy']) {
        const c = byName.get(name);
        if (c) lines.push(renderCmd(c));
      }
      lines.push('');

      // --- OpenClaw namespace (nested) ---
      const oc = byName.get('openclaw');
      if (oc) {
        lines.push(aqua('OpenClaw Gateway integration'));
        // Ordered for readability (setup/doctor/status first, then lifecycle).
        const ocOrder = ['setup', 'doctor', 'status', 'start', 'configure', 'migrate'];
        const ocSubs = helper.visibleCommands(oc).filter((s: any) => s.name() !== 'help');
        const ocSorted = [
          ...ocOrder.map((n) => ocSubs.find((s: any) => s.name() === n)).filter(Boolean),
          ...ocSubs.filter((s: any) => !ocOrder.includes(s.name())),
        ];
        for (const sub of ocSorted) {
          lines.push(renderRow(`openclaw ${sub!.name()}`, sub!.description() || ''));
        }
        lines.push('');
      }

      // --- Coder namespace (shim \u2014 list documented subcommands) ---
      if (byName.has('coder')) {
        lines.push(aqua('AI coding-agent integration (Claude Code today)'));
        const coderSubs: Array<[string, string]> = [
          ['coder setup <agent>', 'Install hooks for an agent (claude-code today)'],
          ['coder doctor', 'Deep diagnostic \u2014 projects, broker, per-project vault'],
          ['coder status', 'Configured projects + hook wiring + broker activity'],
          ['coder project list/add/remove', 'Manage ~/.aquaman/projects.yaml'],
          ['coder get <ref>', 'Resolve an aquaman://service/key reference'],
          ['coder exec <cmd>', 'Run command with project env injected + output redacted'],
        ];
        for (const [term, desc] of coderSubs) {
          lines.push(renderRow(term, desc));
        }
        lines.push(`  ${'(delegates to the aquaman-coder binary; install: npm install -g aquaman-coder)'}`);
        lines.push('');
      }

      // --- Other ---
      const helpCmd = byName.get('help');
      if (helpCmd) {
        lines.push(aqua('Other'));
        lines.push(renderCmd(helpCmd));
        lines.push('');
      }

      return lines.join('\n');
    }
  });

// ============================================================================
// Top-level commands (vault-only, agent-agnostic)
// ============================================================================
//
// `aquaman setup`, `aquaman doctor`, `aquaman status` cover the proxy + vault
// surface only. For full bundles, use the namespaced versions:
//   aquaman openclaw setup    full OpenClaw bundle
//   aquaman coder setup ...   coding-agent adapter
// ============================================================================

// aquaman setup \u2014 vault-only minimal setup wizard.
program
  .command('setup')
  .description('Vault-only setup wizard \u2014 backend + credentials (use `aquaman openclaw setup` or `aquaman coder setup` for full bundles)')
  .option('--backend <backend>', 'Credential backend (keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden)')
  .option('--no-policy', 'Skip request policy preset configuration')
  .option('--non-interactive', 'Use environment variables instead of prompts (for CI)')
  .action(async (options) => {
    await runVaultSetup({
      backend: options.backend,
      policy: options.policy !== false,
      nonInteractive: !!options.nonInteractive,
    });
    console.log('');
    console.log('  Next steps:');
    console.log('    \u2022 OpenClaw Gateway user?   ' + aqua('aquaman openclaw setup'));
    console.log('    \u2022 Claude Code / Codex / etc?  ' + aqua('aquaman coder setup claude-code') + ' (requires aquaman-coder)');
    console.log('');
  });

// aquaman doctor \u2014 overview with persona-aware soft upsells.
program
  .command('doctor')
  .description('Overview health check (vault + integration summaries with soft upsells)')
  .action(async () => {
    const os = await import('node:os');
    const configDir = getConfigDir();
    const configPath = path.join(configDir, 'config.yaml');
    const openclawStateDir = process.env['OPENCLAW_STATE_DIR'] || path.join(os.homedir(), '.openclaw');
    let issues = 0;

    console.log('');
    console.log(`  \u{1F531} Aquaman ${VERSION} \u2014 health check`);
    console.log('');
    console.log(`  ${aqua('Vault')}`);

    // Vault \u2014 config file
    if (!fs.existsSync(configPath)) {
      console.log(`    \u2717 Config missing (${configPath})`);
      console.log('      \u2192 Run: aquaman setup');
      issues++;
    } else {
      // Vault \u2014 backend + creds
      try {
        const config = loadConfig();
        const store = await createCredentialStore({
          backend: config.credentials.backend,
          encryptionPassword: config.credentials.encryptionPassword,
          vaultAddress: config.credentials.vaultAddress,
          vaultToken: config.credentials.vaultToken,
          onePasswordVault: config.credentials.onePasswordVault,
          onePasswordAccount: config.credentials.onePasswordAccount,
          keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
          keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
          bitwardenFolder: config.credentials.bitwardenFolder,
          bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
          bitwardenCollectionId: config.credentials.bitwardenCollectionId
        });
        const creds = await store.list();
        console.log(`    \u2713 ${config.credentials.backend} backend (${creds.length} credential${creds.length !== 1 ? 's' : ''})`);
      } catch (err) {
        console.log(`    \u2717 Backend not accessible: ${(err as Error).message}`);
        console.log('      \u2192 Run: aquaman setup');
        issues++;
      }

      // Vault \u2014 proxy running
      const sockPath = path.join(configDir, 'proxy.sock');
      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.request({ socketPath: sockPath, path: '/_health', method: 'GET' }, (res) => {
            res.resume();
            res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`)));
          });
          req.on('error', reject);
          req.end();
        });
        console.log(`    \u2713 Proxy running on socket`);
      } catch {
        console.log(`    \u2717 Proxy not running`);
        console.log('      \u2192 Run: aquaman daemon &');
        issues++;
      }
    }

    // OpenClaw integration
    let openclawDetected = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('which openclaw', { stdio: 'pipe' });
      openclawDetected = true;
    } catch { /* */ }
    if (!openclawDetected) openclawDetected = fs.existsSync(openclawStateDir);

    console.log('');
    console.log(`  ${aqua('OpenClaw integration')}`);
    if (!openclawDetected) {
      console.log(`    \u2022 not detected (skipping \u2014 only relevant if you run an OpenClaw Gateway)`);
    } else {
      const pluginInstalled = fs.existsSync(path.join(openclawStateDir, 'extensions', 'aquaman-plugin'));
      if (pluginInstalled) {
        console.log(`    \u2713 plugin installed   (deep: ${aqua('aquaman openclaw doctor')})`);
      } else {
        console.log(`    \u2717 plugin not installed`);
        console.log('      \u2192 Run: aquaman openclaw setup');
        issues++;
      }
    }

    // Coder integration
    const projectsYaml = path.join(configDir, 'projects.yaml');
    const claudeSettings = path.join(os.homedir(), '.claude', 'settings.json');
    let coderConfigured = fs.existsSync(projectsYaml);
    if (!coderConfigured && fs.existsSync(claudeSettings)) {
      try {
        const raw = fs.readFileSync(claudeSettings, 'utf-8');
        coderConfigured = raw.includes('aquaman-coder hook') || raw.includes('aquaman coder hook');
      } catch { /* */ }
    }
    console.log('');
    console.log(`  ${aqua('Coder integration')}`);
    if (coderConfigured) {
      console.log(`    \u2713 configured   (deep: ${aqua('aquaman coder doctor')})`);
    } else {
      console.log(`    \u2022 not configured`);
      console.log(`      Your coding agents (Claude Code, Codex, \u2026) could use the same`);
      console.log(`      vault protection. Install: ${aqua('npm install -g aquaman-coder')}`);
    }

    console.log('');
    if (issues === 0) {
      console.log('  All baseline checks passed.');
    } else {
      console.log(`  ${issues} issue${issues > 1 ? 's' : ''} found in baseline. Fix above and re-run.`);
    }
    console.log('');
    process.exitCode = issues > 0 ? 1 : 0;
  });

// aquaman status \u2014 proxy overview.
program
  .command('status')
  .description('Proxy daemon status overview')
  .action(async () => {
    const config = loadConfig();

    console.log('');
    console.log(`  \u{1F531} ${aqua('Aquaman')} ${VERSION} — status`);
    console.log('');

    // Proxy state (probe socket first — the headline number)
    const sockPath = path.join(getConfigDir(), 'proxy.sock');
    let proxyLine = `  ${aqua('Proxy:')} not running`;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request({ socketPath: sockPath, path: '/_health', method: 'GET' }, (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end', () => resolve(buf));
        });
        req.on('error', reject);
        req.end();
      });
      const health = JSON.parse(body);
      proxyLine = `  ${aqua('Proxy:')} running  (v${health.version}, uptime ${Math.floor(health.uptime ?? 0)}s)`;
    } catch { /* not running */ }
    console.log(proxyLine);

    // Configuration
    console.log('');
    console.log(`  ${aqua('Configuration')}`);
    console.log(`    Config dir:  ${getConfigDir()}`);
    console.log(`    Backend:     ${config.credentials.backend}`);
    console.log(`    Socket:      ${sockPath}`);
    console.log(`    Audit:       ${config.audit.enabled ? 'enabled' : 'disabled'}`);

    // Proxied services
    console.log('');
    console.log(`  ${aqua('Proxied services')}  (${config.credentials.proxiedServices.length})`);
    for (const svc of config.credentials.proxiedServices) console.log(`    - ${svc}`);

    console.log('');
    console.log(`  For deeper views: ${aqua('aquaman openclaw status')} / ${aqua('aquaman coder status')}`);
    console.log('');
  });

// ---------------- Shared helper: vault-only setup ----------------
async function runVaultSetup(opts: { backend?: string; policy: boolean; nonInteractive: boolean; quiet?: boolean }):
  Promise<{ store: import('../core/index.js').CredentialStore; storedServices: string[]; backend: string }> {
  const os = await import('node:os');
  const configDir = getConfigDir();
  const configPath = path.join(configDir, 'config.yaml');

  if (!opts.quiet) console.log('\n  \u{1F531} Vault setup\n');

  // Backend detection
  const platform = os.platform();
  let backend = opts.backend;
  if (!backend) {
    if (platform === 'darwin') {
      backend = 'keychain';
    } else {
      try {
        const { execSync } = await import('node:child_process');
        execSync('pkg-config --exists libsecret-1', { stdio: 'pipe' });
        backend = 'keychain';
      } catch {
        const { isSystemdCredsAvailable } = await import('../core/credentials/backends/systemd-creds.js');
        backend = isSystemdCredsAvailable() ? 'systemd-creds' : 'encrypted-file';
      }
    }
  }
  const validBackends = ['keychain', 'encrypted-file', 'keepassxc', '1password', 'vault', 'systemd-creds', 'bitwarden'];
  if (!validBackends.includes(backend)) {
    console.error(`  Invalid backend: ${backend}. Valid: ${validBackends.join(', ')}`);
    process.exit(1);
  }

  if (!opts.quiet) {
    const platformLabel = platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform;
    console.log(`  Platform: ${platformLabel}`);
    console.log(`  Backend:  ${backend}\n`);
  }

  ensureConfigDir();
  let config = getDefaultConfig();
  if (fs.existsSync(configPath)) {
    config = loadConfig();
  }
  config.credentials.backend = backend as any;
  fs.writeFileSync(configPath, yamlStringify(config), { encoding: 'utf-8', mode: 0o600 });

  const auditDir = path.join(configDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });

  let store: import('../core/index.js').CredentialStore;
  try {
    store = await createCredentialStore({
      backend: config.credentials.backend,
      encryptionPassword: config.credentials.encryptionPassword || process.env['AQUAMAN_ENCRYPTION_PASSWORD'] || process.env['AQUAMAN_KEEPASS_PASSWORD'],
      vaultAddress: config.credentials.vaultAddress || process.env['VAULT_ADDR'],
      vaultToken: config.credentials.vaultToken || process.env['VAULT_TOKEN'],
      onePasswordVault: config.credentials.onePasswordVault,
      onePasswordAccount: config.credentials.onePasswordAccount,
      keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
      keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
      bitwardenFolder: config.credentials.bitwardenFolder,
      bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
      bitwardenCollectionId: config.credentials.bitwardenCollectionId
    });
  } catch (err) {
    console.error(`  Failed to initialize ${backend}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const storedServices: string[] = [];
  if (opts.nonInteractive) {
    const anth = process.env['ANTHROPIC_API_KEY'];
    if (anth) { await store.set('anthropic', 'api_key', anth); storedServices.push('anthropic'); console.log('  \u2713 Stored anthropic/api_key'); }
    const op = process.env['OPENAI_API_KEY'];
    if (op) { await store.set('openai', 'api_key', op); storedServices.push('openai'); console.log('  \u2713 Stored openai/api_key'); }
  } else {
    const readline = await import('node:readline');
    const promptSecret = (prompt: string): Promise<string> => new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      if (process.stdin.isTTY) {
        process.stdout.write(prompt);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        let input = '';
        const onData = (data: Buffer) => {
          const char = data.toString();
          if (char === '\n' || char === '\r') {
            stdin.setRawMode(false); stdin.removeListener('data', onData); stdin.pause(); rl.close();
            process.stdout.write('\n'); resolve(input.trim());
          } else if (char === '\x7f' || char === '\b') { input = input.slice(0, -1); }
          else if (char === '\x03') { stdin.setRawMode(false); process.exit(0); }
          else { input += char; }
        };
        stdin.on('data', onData);
      } else {
        rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); });
      }
    });
    const anth = await promptSecret('  ? Anthropic API key (or Enter to skip): ');
    if (anth) { await store.set('anthropic', 'api_key', anth); storedServices.push('anthropic'); console.log('    \u2713 anthropic/api_key\n'); }
    const op = await promptSecret('  ? OpenAI API key (or Enter to skip): ');
    if (op) { await store.set('openai', 'api_key', op); storedServices.push('openai'); console.log('    \u2713 openai/api_key\n'); }
  }

  if (opts.policy && storedServices.length > 0) {
    const presets = getDefaultPolicyPresets();
    const policyToApply: Record<string, any> = {};
    for (const svc of storedServices) {
      if (presets[svc]) policyToApply[svc] = presets[svc];
    }
    if (Object.keys(policyToApply).length > 0) {
      config.policy = policyToApply;
      saveConfig(config);
      if (!opts.quiet) console.log('  \u2713 Default policy presets applied.\n');
    }
  }

  return { store, storedServices, backend: backend as string };
}

// OpenClaw integration namespace \u2014 full bundle setup, deep doctor/status,
// migration tools, and the (hidden) plugin-mode entry the plugin spawns.
const openclaw = program
  .command('openclaw')
  .description('OpenClaw Gateway integration (full setup, deep diagnostics, migration)');

// openclaw start \u2014 launches credential proxy + OpenClaw
openclaw
  .command('start')
  .description('Start credential proxy and launch OpenClaw')
  .option('-w, --workspace <path>', 'Workspace directory for OpenClaw')
  .option('--no-launch', 'Start daemon only, do not launch OpenClaw')
  .option('--dry-run', 'Show what would be done without executing')
  .action(async (options) => {
    const config = loadConfig();

    if (options.dryRun) {
      console.log('Dry run - would start with this configuration:\n');
      console.log('Credential proxy:');
      console.log(`  Socket: ${path.join(getConfigDir(), 'proxy.sock')}`);
      console.log(`  Backend: ${config.credentials.backend}`);
      console.log(`  Services: ${config.credentials.proxiedServices.join(', ')}`);
      console.log('');

      const registry = createServiceRegistry({ configPath: config.services.configPath });
      const services = registry.getAll().filter(s =>
        config.credentials.proxiedServices.includes(s.name)
      );
      const integration = createOpenClawIntegration(config, services);
      const envDisplay = await integration.getEnvForDisplay();

      console.log('OpenClaw environment variables:');
      console.log(envDisplay);
      return;
    }

    console.log('Starting aquaman...\n');

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled
    });
    await auditLogger.initialize();

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const socketPath = path.join(getConfigDir(), 'proxy.sock');
    const policyConfig = loadPolicyFromConfig(config);
    const credentialProxy = createCredentialProxy({
      socketPath,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      policyConfig,
      onRequest: (info) => {
        auditLogger.logCredentialAccess('system', 'system', {
          service: info.service,
          operation: 'use',
          success: !info.error,
          error: info.error
        });
      }
    });
    await credentialProxy.start();

    console.log(`Credential proxy started on ${socketPath}`);

    if (options.launch !== false && config.openclaw.autoLaunch) {
      // Get services for OpenClaw integration
      const services = serviceRegistry.getAll().filter(s =>
        config.credentials.proxiedServices.includes(s.name)
      );

      const integration = createOpenClawIntegration(config, services);

      // Check if OpenClaw is installed
      const info = await integration.detectOpenClaw();
      if (!info.installed) {
        console.log('\nOpenClaw not found. Credential proxy is running.');
        console.log('To use with OpenClaw, set these environment variables:\n');
        const envDisplay = await integration.getEnvForDisplay();
        console.log(envDisplay);
      } else {
        console.log(`\nLaunching OpenClaw ${info.version}...`);

        const args: string[] = [];
        if (options.workspace) {
          args.push('--cwd', expandPath(options.workspace));
        }

        const proc = await integration.launchOpenClaw({
          args,
          inheritStdio: true
        });

        // Handle process exit
        proc.on('close', async (code) => {
          console.log(`\nOpenClaw exited with code ${code}`);
          await credentialProxy.stop();
          process.exit(code ?? 0);
        });
      }
    } else {
      console.log('\nDaemon mode - credential proxy running.');
      console.log('Press Ctrl+C to stop.\n');

      // Get services for display
      const services = serviceRegistry.getAll().filter(s =>
        config.credentials.proxiedServices.includes(s.name)
      );
      const integration = createOpenClawIntegration(config, services);
      const envDisplay = await integration.getEnvForDisplay();

      console.log('To use with OpenClaw, set these environment variables:');
      console.log(envDisplay);
    }

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await credentialProxy.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Stop command
program
  .command('stop')
  .description('Stop the credential proxy daemon')
  .action(async () => {
    const pid = readPidFile();

    if (!pid) {
      console.log('No daemon PID file found. Daemon may not be running.');
      return;
    }

    if (!isProcessRunning(pid)) {
      console.log(`Daemon (PID ${pid}) is not running. Cleaning up stale PID file.`);
      removePidFile();
      return;
    }

    console.log(`Stopping daemon (PID ${pid})...`);
    try {
      process.kill(pid, 'SIGTERM');

      // Wait for process to exit (max 5 seconds)
      let attempts = 0;
      while (isProcessRunning(pid) && attempts < 50) {
        await new Promise(r => setTimeout(r, 100));
        attempts++;
      }

      if (isProcessRunning(pid)) {
        console.log('Daemon did not stop gracefully, sending SIGKILL...');
        process.kill(pid, 'SIGKILL');
      }

      removePidFile();
      const sockPath = path.join(getConfigDir(), 'proxy.sock');
      try { fs.unlinkSync(sockPath); } catch { /* already removed */ }
      console.log('Daemon stopped.');
    } catch (err) {
      console.error('Failed to stop daemon:', err);
    }
  });

// Daemon command (runs credential proxy only)
program
  .command('daemon')
  .description('Run the credential proxy daemon (for advanced users)')
  .action(async () => {
    // Check if daemon is already running
    const existingPid = readPidFile();
    if (existingPid && isProcessRunning(existingPid)) {
      console.error(`Daemon is already running (PID ${existingPid}). Use 'aquaman stop' first.`);
      process.exit(1);
    }

    const config = loadConfig();
    const socketPath = path.join(getConfigDir(), 'proxy.sock');

    console.log('Starting aquaman credential proxy daemon...\n');

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled
    });
    await auditLogger.initialize();

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const policyConfig2 = loadPolicyFromConfig(config);
    const credentialProxy = createCredentialProxy({
      socketPath,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      policyConfig: policyConfig2,
      onRequest: (info) => {
        auditLogger.logCredentialAccess('system', 'system', {
          service: info.service,
          operation: 'use',
          success: !info.error,
          error: info.error
        });
      }
    });
    await credentialProxy.start();

    // Write PID file
    writePidFile();

    console.log(`Credential proxy: ${socketPath}`);
    console.log(`Audit logging: ${config.audit.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Credential backend: ${config.credentials.backend}`);
    console.log(`PID file: ${getPidFile()}`);
    console.log('');
    console.log('Press Ctrl+C to stop, or run: aquaman stop\n');

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down daemon...');
      await credentialProxy.stop();
      removePidFile();
      try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Plugin mode command - for use when managed by OpenClaw plugin
openclaw
  .command('plugin-mode', { hidden: true })
  .description('Run in plugin mode (invoked by OpenClaw plugin, not by humans)')
  .action(async () => {
    const config = loadConfig();
    const socketPath = path.join(getConfigDir(), 'proxy.sock');

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled
    });
    await auditLogger.initialize();

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const policyConfig3 = loadPolicyFromConfig(config);
    const credentialProxy = createCredentialProxy({
      socketPath,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      policyConfig: policyConfig3,
      onRequest: (info) => {
        auditLogger.logCredentialAccess('system', 'system', {
          service: info.service,
          operation: 'use',
          success: !info.error,
          error: info.error
        });
      }
    });
    await credentialProxy.start();

    // Build host map from service registry for the plugin's interceptor
    const hostMap = serviceRegistry.buildHostMap();
    const hostMapObj: Record<string, string> = {};
    for (const [pattern, serviceName] of hostMap) {
      hostMapObj[pattern] = serviceName;
    }

    // Output connection info as JSON for plugin to parse
    const connectionInfo = {
      ready: true,
      socketPath,
      services: config.credentials.proxiedServices,
      backend: config.credentials.backend,
      hostMap: hostMapObj
    };

    console.log(JSON.stringify(connectionInfo));

    // Handle shutdown
    const shutdown = async () => {
      await credentialProxy.stop();
      try { fs.unlinkSync(socketPath); } catch { /* already removed */ }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// openclaw configure — write OpenClaw environment configuration
openclaw
  .command('configure')
  .description('Generate environment configuration for OpenClaw')
  .option('--method <method>', 'Output method: env, dotenv, shell-rc', 'env')
  .option('--dry-run', 'Show configuration without writing')
  .action(async (options) => {
    const config = loadConfig();
    config.openclaw.configMethod = options.method;

    const registry = createServiceRegistry({ configPath: config.services.configPath });
    const services = registry.getAll().filter(s =>
      config.credentials.proxiedServices.includes(s.name)
    );

    const integration = createOpenClawIntegration(config, services);
    const env = await integration.configureOpenClaw();

    if (options.dryRun || options.method === 'env') {
      console.log('Environment variables for OpenClaw:\n');
      for (const [key, value] of Object.entries(env)) {
        console.log(`export ${key}="${value}"`);
      }
      console.log('\nCopy and paste these into your shell, or use --method dotenv/shell-rc');
    } else {
      const result = await integration.writeConfiguration(env);
      console.log(`Configuration written to: ${result}`);
    }
  });

// Init command
program
  .command('init')
  .description('Initialize aquaman configuration')
  .option('--force', 'Overwrite existing configuration')
  .action(async (options) => {
    ensureConfigDir();
    const configPath = path.join(getConfigDir(), 'config.yaml');
    const configExists = fs.existsSync(configPath);

    if (configExists && !options.force) {
      console.log(`Configuration already exists at ${configPath}`);
      console.log('Use --force to overwrite.');
    } else {
      const config = getDefaultConfig();
      fs.writeFileSync(configPath, yamlStringify(config), { encoding: 'utf-8', mode: 0o600 });
      console.log(`Created ${configPath}`);
    }

    // Resolve audit directory from the (possibly pre-existing) config so a
    // custom logDir is honored; fall back to the default if the config is
    // missing or unreadable. Creating the dir is idempotent — running init
    // against an existing config heals a missing audit dir, which is what
    // `aquaman doctor` directs users to do.
    let auditDir = path.join(getConfigDir(), 'audit');
    try {
      const cfg = loadConfig();
      if (cfg?.audit?.logDir) auditDir = expandPath(cfg.audit.logDir);
    } catch { /* fall through to default */ }
    const auditExisted = fs.existsSync(auditDir);
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
    if (!auditExisted) console.log(`Created ${auditDir}`);

    if (!configExists || options.force) {
      console.log('\nNext steps:');
      console.log('1. Add your API keys: aquaman credentials add anthropic api_key');
      console.log('2. Start the proxy:   aquaman start');
    }
  });

// Setup command - all-in-one guided onboarding
// openclaw setup — full OpenClaw bundle: vault wizard + plugin install +
// openclaw.json wiring + auth-profiles.json + optional auto-migration.
openclaw
  .command('setup')
  .description('Full setup for OpenClaw — vault + plugin + auth profiles + (optional) auto-migrate')
  .option('--backend <backend>', 'Credential backend (keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden)')
  .option('--no-openclaw', 'Skip OpenClaw plugin installation step (run vault setup only)')
  .option('--no-policy', 'Skip request policy preset configuration')
  .option('--non-interactive', 'Use environment variables instead of prompts (for CI)')
  .action(async (options) => {
    const os = await import('node:os');
    const configDir = getConfigDir();
    const configPath = path.join(configDir, 'config.yaml');
    const isNonInteractive = options.nonInteractive || false;
    const openclawStateDir = process.env['OPENCLAW_STATE_DIR'] || path.join(os.homedir(), '.openclaw');

    console.log('\n  \u{1F531} Aquaman Setup\n');

    // Check if already configured
    if (fs.existsSync(configPath) && !isNonInteractive) {
      const rl = (await import('node:readline')).createInterface({
        input: process.stdin,
        output: process.stdout
      });
      const answer = await new Promise<string>((resolve) => {
        rl.question('  Aquaman is already configured. Re-run setup? (y/N): ', resolve);
      });
      rl.close();
      if (answer.toLowerCase() !== 'y') {
        console.log('  Already configured. Run `aquaman doctor` to check status.');
        return;
      }
    }

    // 1. Detect platform and pick default backend
    const platform = os.platform();
    let backend = options.backend;
    if (!backend) {
      if (platform === 'darwin') {
        backend = 'keychain';
      } else {
        // Linux: check for libsecret first, then systemd-creds, then encrypted-file
        try {
          const { execSync } = await import('node:child_process');
          execSync('pkg-config --exists libsecret-1', { stdio: 'pipe' });
          backend = 'keychain';
        } catch {
          const { isSystemdCredsAvailable } = await import('../core/credentials/backends/systemd-creds.js');
          backend = isSystemdCredsAvailable() ? 'systemd-creds' : 'encrypted-file';
        }
      }
    }

    // Validate backend
    const validBackends = ['keychain', 'encrypted-file', 'keepassxc', '1password', 'vault', 'systemd-creds', 'bitwarden'];
    if (!validBackends.includes(backend)) {
      console.error(`  Invalid backend: ${backend}`);
      console.error(`  Valid options: ${validBackends.join(', ')}`);
      process.exit(1);
    }

    const platformLabel = platform === 'darwin' ? 'macOS' :
                          platform === 'linux' ? 'Linux' : platform;
    console.log(`  Platform: ${platformLabel}`);
    console.log(`  Backend:  ${backend}\n`);

    // Check backend prerequisites before prompting for keys
    if (backend === '1password') {
      try {
        const { execSync } = await import('node:child_process');
        execSync('which op', { stdio: 'pipe' });
        try {
          execSync('op whoami', { stdio: 'pipe' });
        } catch {
          console.error('  1Password CLI is installed but not signed in.');
          console.error('  Run: eval $(op signin)');
          process.exit(1);
        }
      } catch {
        console.error('  1Password CLI not found.');
        console.error('  Install: brew install 1password-cli');
        console.error('  Then: eval $(op signin)');
        process.exit(1);
      }
    } else if (backend === 'vault') {
      const vaultAddr = process.env['VAULT_ADDR'];
      const vaultToken = process.env['VAULT_TOKEN'];
      if (!vaultAddr || !vaultToken) {
        if (isNonInteractive) {
          console.error('  Vault backend requires VAULT_ADDR and VAULT_TOKEN environment variables.');
          process.exit(1);
        }
      }
      if (vaultAddr) {
        try {
          const resp = await fetch(`${vaultAddr}/v1/sys/health`);
          if (!resp.ok) {
            console.error(`  Vault health check failed (HTTP ${resp.status}).`);
            console.error(`  Check VAULT_ADDR (${vaultAddr}) and VAULT_TOKEN.`);
            process.exit(1);
          }
        } catch (err) {
          console.error(`  Cannot reach Vault at ${vaultAddr}.`);
          process.exit(1);
        }
      }
    } else if (backend === 'keepassxc') {
      const keepassPassword = process.env['AQUAMAN_KEEPASS_PASSWORD'];
      if (!keepassPassword) {
        if (isNonInteractive) {
          console.error('  KeePassXC backend requires AQUAMAN_KEEPASS_PASSWORD environment variable.');
          process.exit(1);
        } else {
          // Use hidden input to avoid echoing the master password
          const password = await promptSecretInput('  ? KeePassXC master password: ');
          if (!password.trim()) {
            console.error('  KeePassXC backend requires a master password.');
            process.exit(1);
          }
          process.env['AQUAMAN_KEEPASS_PASSWORD'] = password.trim();
        }
      }
    } else if (backend === 'systemd-creds') {
      const { isSystemdCredsAvailable } = await import('../core/credentials/backends/systemd-creds.js');
      if (!isSystemdCredsAvailable()) {
        console.error('  systemd-creds backend requires systemd-creds with --user support (systemd >= 256).');
        console.error('  Try: systemd-creds --version');
        process.exit(1);
      }
    } else if (backend === 'bitwarden') {
      try {
        const { execSync } = await import('node:child_process');
        execSync('which bw', { stdio: 'pipe' });
        // Check status
        const statusJson = execSync('bw status', { stdio: 'pipe', encoding: 'utf-8' });
        const status = JSON.parse(statusJson);
        if (status.status === 'unauthenticated') {
          console.error('  Bitwarden CLI is installed but not logged in.');
          console.error('  Run: bw login');
          process.exit(1);
        }
        if (status.status === 'locked') {
          const session = process.env['BW_SESSION'];
          if (!session) {
            console.error('  Bitwarden vault is locked.');
            console.error('  Run: export BW_SESSION=$(bw unlock --raw)');
            process.exit(1);
          }
          // Verify session works
          try {
            execSync('bw sync', { stdio: 'pipe', env: { ...process.env, BW_SESSION: session } });
          } catch {
            console.error('  BW_SESSION is invalid or expired.');
            console.error('  Run: export BW_SESSION=$(bw unlock --raw)');
            process.exit(1);
          }
        }
      } catch {
        console.error('  Bitwarden CLI not found.');
        console.error('  Install: https://bitwarden.com/help/cli/');
        console.error('  Then: bw login && export BW_SESSION=$(bw unlock --raw)');
        process.exit(1);
      }
    }

    // 2. Run init internally (create dirs, config)
    ensureConfigDir();
    const config = getDefaultConfig();
    config.credentials.backend = backend;
    fs.writeFileSync(configPath, yamlStringify(config), { encoding: 'utf-8', mode: 0o600 });

    // Create audit directory
    const auditDir = path.join(configDir, 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });

    // 3. Prompt for API keys (or read from env in non-interactive mode)
    let store;
    try {
      store = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword || process.env['AQUAMAN_ENCRYPTION_PASSWORD'] || process.env['AQUAMAN_KEEPASS_PASSWORD'],
        vaultAddress: config.credentials.vaultAddress || process.env['VAULT_ADDR'],
        vaultToken: config.credentials.vaultToken || process.env['VAULT_TOKEN'],
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch (err) {
      console.error(`  Failed to initialize ${backend} credential store: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }

    const storedServices: string[] = [];

    if (isNonInteractive) {
      // Non-interactive: read from env vars
      const anthropicKey = process.env['ANTHROPIC_API_KEY'];
      if (anthropicKey) {
        await store.set('anthropic', 'api_key', anthropicKey);
        storedServices.push('anthropic');
        console.log('  \u2713 Stored anthropic/api_key');
      }

      const openaiKey = process.env['OPENAI_API_KEY'];
      if (openaiKey) {
        await store.set('openai', 'api_key', openaiKey);
        storedServices.push('openai');
        console.log('  \u2713 Stored openai/api_key');
      }
    } else {
      // Interactive: prompt with hidden input
      const readline = await import('node:readline');

      const promptSecret = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          // Attempt to hide input on TTY
          if (process.stdin.isTTY) {
            process.stdout.write(prompt);
            const stdin = process.stdin;
            stdin.setRawMode(true);
            stdin.resume();
            let input = '';
            const onData = (data: Buffer) => {
              const char = data.toString();
              if (char === '\n' || char === '\r') {
                stdin.setRawMode(false);
                stdin.removeListener('data', onData);
                stdin.pause();
                rl.close();
                process.stdout.write('\n');
                resolve(input.trim());
              } else if (char === '\x7f' || char === '\b') {
                input = input.slice(0, -1);
              } else if (char === '\x03') {
                // Ctrl+C
                stdin.setRawMode(false);
                process.exit(0);
              } else {
                input += char;
              }
            };
            stdin.on('data', onData);
          } else {
            rl.question(prompt, (answer) => {
              rl.close();
              resolve(answer.trim());
            });
          }
        });
      };

      const anthropicKey = await promptSecret('  ? Enter your Anthropic API key: ');
      if (anthropicKey) {
        await store.set('anthropic', 'api_key', anthropicKey);
        storedServices.push('anthropic');
        console.log('    \u2713 Stored anthropic/api_key\n');
      }

      const openaiKey = await promptSecret('  ? Enter your OpenAI API key (or press Enter to skip): ');
      if (openaiKey) {
        await store.set('openai', 'api_key', openaiKey);
        storedServices.push('openai');
        console.log('    \u2713 Stored openai/api_key\n');
      } else {
        console.log('    Skipped\n');
      }
    }

    // 3.5. Apply request policy presets
    if (options.policy !== false && storedServices.length > 0) {
      let shouldApplyPolicy = true;

      if (!isNonInteractive) {
        const rl = (await import('node:readline')).createInterface({
          input: process.stdin,
          output: process.stdout
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question('  ? Enable API request policies? (Y/n): ', resolve);
        });
        rl.close();
        shouldApplyPolicy = answer.toLowerCase() !== 'n';
        if (shouldApplyPolicy) {
          console.log('    Policies restrict which API endpoints agents can call.\n');
        }
      }

      if (shouldApplyPolicy) {
        const presets = getDefaultPolicyPresets();
        const policyToApply: Record<string, any> = {};
        for (const svc of storedServices) {
          if (presets[svc]) {
            policyToApply[svc] = presets[svc];
          }
        }

        if (Object.keys(policyToApply).length > 0) {
          config.policy = policyToApply;
          saveConfig(config);

          console.log('  Applying default policy presets:\n');
          for (const [svc, sp] of Object.entries(policyToApply) as [string, ServicePolicy][]) {
            console.log(formatServicePolicy(svc, sp, '    '));
            console.log('');
          }
          console.log('  Customize policies later: ~/.aquaman/config.yaml\n');
        }
      }
    }

    // 4. Detect OpenClaw and install plugin
    if (options.openclaw !== false) {
      const openclawDetected = fs.existsSync(openclawStateDir);
      let cliDetected = false;
      try {
        const { execSync } = await import('node:child_process');
        execSync('which openclaw', { stdio: 'pipe' });
        cliDetected = true;
      } catch { /* not installed */ }

      if (openclawDetected || cliDetected) {
        let shouldInstall = true;

        if (!isNonInteractive) {
          const rl = (await import('node:readline')).createInterface({
            input: process.stdin,
            output: process.stdout
          });
          const answer = await new Promise<string>((resolve) => {
            rl.question('  ? OpenClaw detected. Install plugin? (Y/n): ', resolve);
          });
          rl.close();
          shouldInstall = answer.toLowerCase() !== 'n';
        }

        if (shouldInstall) {
          // a. Copy plugin files
          const currentDir = path.dirname(fileURLToPath(import.meta.url));
          const pluginSrc = path.resolve(currentDir, '../../../plugin');
          const pluginDest = path.join(openclawStateDir, 'extensions', 'aquaman-plugin');
          fs.mkdirSync(path.join(openclawStateDir, 'extensions'), { recursive: true });

          if (fs.existsSync(pluginSrc)) {
            fs.cpSync(pluginSrc, pluginDest, { recursive: true });
            console.log('  \u2713 Plugin installed to ' + pluginDest);
          } else if (cliDetected) {
            // npm install — plugin source not bundled, use openclaw's plugin installer
            try {
              const { execSync: execSyncFallback } = await import('node:child_process');
              execSyncFallback('openclaw plugins install aquaman-plugin', { stdio: 'pipe' });
              console.log('  \u2713 Plugin installed via openclaw');
            } catch {
              console.log('  \u2717 Could not install plugin. Run: openclaw plugins install aquaman-plugin');
            }
          }

          // b. Write/merge openclaw.json
          const openclawJsonPath = path.join(openclawStateDir, 'openclaw.json');
          let openclawConfig: any = {};
          if (fs.existsSync(openclawJsonPath)) {
            try {
              openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
            } catch { /* start fresh */ }
          }

          if (!openclawConfig.plugins) openclawConfig.plugins = {};
          if (!openclawConfig.plugins.entries) openclawConfig.plugins.entries = {};

          // Set plugins.allow so OpenClaw trusts the plugin (avoids extensions_no_allowlist audit warning)
          if (!openclawConfig.plugins.allow) openclawConfig.plugins.allow = [];
          if (!openclawConfig.plugins.allow.includes('aquaman-plugin')) {
            openclawConfig.plugins.allow.push('aquaman-plugin');
          }

          openclawConfig.plugins.entries['aquaman-plugin'] = {
            enabled: true,
            config: {
              backend,
              services: storedServices.length > 0 ? storedServices : ['anthropic', 'openai'],
            }
          };

          fs.writeFileSync(openclawJsonPath, JSON.stringify(openclawConfig, null, 2), 'utf-8');
          console.log('  \u2713 Plugin config written to ' + openclawJsonPath);

          // c. Generate auth-profiles.json (only if missing)
          const profilesPath = path.join(openclawStateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
          if (!fs.existsSync(profilesPath)) {
            const profiles: Record<string, any> = {};
            const order: Record<string, string[]> = {};

            const profileServices = storedServices.length > 0 ? storedServices : ['anthropic', 'openai'];
            for (const svc of profileServices) {
              if (svc === 'anthropic' || svc === 'openai') {
                profiles[`${svc}:default`] = {
                  type: 'api_key',
                  provider: svc,
                  key: 'aquaman-proxy-managed'
                };
                order[svc] = [`${svc}:default`];
              }
            }

            const profilesDir = path.dirname(profilesPath);
            fs.mkdirSync(profilesDir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles, order }, null, 2), { mode: 0o600 });
            console.log('  \u2713 Auth profiles generated at ' + profilesPath);

            // OpenClaw >= 2026.6.5 reads provider auth profiles from each agent's
            // openclaw-agent.sqlite, not auth-profiles.json (openclaw/openclaw#89102).
            // The placeholder above must be imported into SQLite once with
            // `openclaw doctor --fix`. We deliberately do NOT auto-run that here:
            // it is OpenClaw's broad config-healing command \u2014 verified to take
            // ~19s (gateway probes) and to rewrite openclaw.json (it reset our
            // plugin entry to bundled defaults in testing). `aquaman openclaw
            // doctor` detects the SQLite-only case and prints the import step so
            // the operator runs it intentionally. Holistic fix (SecretRef
            // provider manifest) is tracked for the next plugin touch.
            let ocVersion: string | null = null;
            try {
              const { execSync } = await import('node:child_process');
              ocVersion = execSync('openclaw --version', { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
            } catch { /* CLI not on PATH */ }
            if (authProfilesAreSqliteOnly(ocVersion)) {
              console.log('  \u2192 OpenClaw \u2265 2026.6.5 reads auth profiles from SQLite; import the placeholder once:');
              console.log('      openclaw doctor --fix    (backs up openclaw.json first; see aquaman openclaw doctor)');
            }
          }
        }
      } else {
        console.log('  OpenClaw not detected — skipping plugin install');
      }
    }

    // 4.5. Auto-migrate plaintext credentials
    if (options.openclaw !== false) {
      const openclawDetected = fs.existsSync(openclawStateDir);
      let cliDetected = false;
      try {
        const { execSync } = await import('node:child_process');
        execSync('which openclaw', { stdio: 'pipe' });
        cliDetected = true;
      } catch { /* not installed */ }

      if (openclawDetected || cliDetected) {
        try {
          const { autoMigrateOpenClaw } = await import('../migration/openclaw-migrator.js');
          const result = await autoMigrateOpenClaw({
            store,
            isInteractive: !isNonInteractive,
            skipCleanup: true,
          });
          if (result.migrated > 0) {
            console.log(`  \u2713 Migrated ${result.migrated} plaintext credentials`);
          }
        } catch {
          // Migration is best-effort during setup
        }
      }
    }

    // 5. Success message
    const openclawPluginInstalled = options.openclaw !== false &&
      fs.existsSync(path.join(openclawStateDir, 'extensions', 'aquaman-plugin'));

    console.log('\n  \u2713 Setup complete!\n');
    if (storedServices.length === 0) {
      console.log('  Next: add credentials');
      console.log('    aquaman credentials add anthropic api_key\n');
    }
    if (openclawPluginInstalled) {
      console.log('  Next: start OpenClaw (proxy starts automatically via plugin)');
      console.log('    openclaw\n');
    } else {
      console.log('  Next: install the OpenClaw plugin');
      console.log('    aquaman setup\n');
    }
    console.log('  Troubleshooting: aquaman doctor');
    console.log('');
  });

// openclaw doctor — deep diagnostic for the OpenClaw integration. Includes
// the agent-agnostic vault/audit/policy checks too so a single command gives
// the OpenClaw operator the full picture.
openclaw
  .command('doctor')
  .description('Deep diagnostic for the OpenClaw integration (vault + plugin + auth profiles)')
  .action(async () => {
    const os = await import('node:os');
    const configDir = getConfigDir();
    const configPath = path.join(configDir, 'config.yaml');
    const openclawStateDir = process.env['OPENCLAW_STATE_DIR'] || path.join(os.homedir(), '.openclaw');
    let issues = 0;

    console.log('');
    console.log(`  \u{1F531} Aquaman ${VERSION} \u2014 Welcome to the doctor\u2019s office.`);
    console.log('');

    // 1. Config file
    if (fs.existsSync(configPath)) {
      console.log(`  \u2713 ${aqua('Config')} exists (${configPath})`);
    } else {
      console.log(`  \u2717 ${aqua('Config')} missing (${configPath})`);
      console.log('    \u2192 Run: aquaman setup');
      issues++;
    }

    // 2. Backend accessible
    let config;
    let store: import('../core/index.js').CredentialStore | null = null;
    try {
      config = loadConfig();

      if (config.credentials.backend === 'systemd-creds') {
        const { isSystemdCredsAvailable } = await import('../core/credentials/backends/systemd-creds.js');
        if (!isSystemdCredsAvailable()) {
          throw new Error('systemd-creds backend requires systemd >= 256 with --user support');
        }
      }

      if (config.credentials.backend === 'bitwarden') {
        const { BitwardenStore } = await import('../core/credentials/backends/bitwarden.js');
        if (!BitwardenStore.isAvailable()) {
          throw new Error('Bitwarden CLI (bw) not found. Install: https://bitwarden.com/help/cli/');
        }
        if (!BitwardenStore.isUnlocked()) {
          throw new Error('Bitwarden vault is locked. Run: export BW_SESSION=$(bw unlock --raw)');
        }
      }

      store = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });

      // 3. Count credentials
      const creds = await store.list();
      if (creds.length > 0) {
        const names = creds.map(c => `${c.service}/${c.key}`).join(', ');
        console.log(`  \u2713 ${aqua('Backend:')} ${config.credentials.backend} (accessible)`);
        console.log(`  \u2713 ${aqua('Stored securely:')} ${names} (${creds.length} in ${config.credentials.backend})`);
      } else {
        console.log(`  \u2713 ${aqua('Backend:')} ${config.credentials.backend} (accessible)`);
        console.log(`  \u2717 ${aqua('Stored securely:')} none`);
        console.log('    \u2192 Run: aquaman credentials add anthropic api_key');
        issues++;
      }
    } catch {
      console.log(`  \u2717 ${aqua('Backend')} not accessible`);
      console.log('    \u2192 Run: aquaman setup');
      issues++;
      config = loadConfig();
    }

    // 4. Proxy running
    const sockPath = path.join(getConfigDir(), 'proxy.sock');
    const pluginInstalled = fs.existsSync(path.join(openclawStateDir, 'extensions', 'aquaman-plugin'));
    const proxyFix = pluginInstalled
      ? 'Proxy starts automatically with OpenClaw. Run: openclaw'
      : 'Install plugin first: aquaman setup';
    try {
      const healthData = await new Promise<string>((resolve, reject) => {
        const req = http.request({ socketPath: sockPath, path: '/_health', method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(body);
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
      const health = JSON.parse(healthData) as { version?: string };
      const proxyVer = health.version || 'unknown';
      console.log(`  \u2713 ${aqua('Proxy')} running on socket (v${proxyVer})`);
      if (health.version && health.version !== VERSION) {
        console.log(`  \u2717 ${aqua('Version mismatch:')} CLI v${VERSION} \u2260 proxy v${health.version}`);
        console.log('    \u2192 Update: npm install -g aquaman-proxy');
        issues++;
      }
    } catch {
      console.log(`  \u2717 ${aqua('Proxy')} not running on socket`);
      console.log(`    \u2192 ${proxyFix}`);
      issues++;
    }

    // 5. Audit logger
    if (config) {
      const auditDir = expandPath(config.audit.logDir);
      const auditLog = path.join(auditDir, 'current.jsonl');

      if (!config.audit.enabled) {
        console.log(`  - ${aqua('Audit')} disabled in config`);
      } else if (!fs.existsSync(auditDir)) {
        console.log(`  \u2717 ${aqua('Audit')} directory missing (${auditDir})`);
        console.log('    \u2192 Run: aquaman init');
        issues++;
      } else {
        // Check log file exists and is writable
        try {
          if (fs.existsSync(auditLog)) {
            fs.accessSync(auditLog, fs.constants.W_OK);
            const content = fs.readFileSync(auditLog, 'utf-8').trim();
            const entryCount = content ? content.split('\n').length : 0;
            console.log(`  \u2713 ${aqua('Audit')} log writable (${entryCount} entries)`);
          } else {
            // Dir exists but no log yet — that's fine, first request will create it
            fs.accessSync(auditDir, fs.constants.W_OK);
            console.log(`  \u2713 ${aqua('Audit')} directory writable (no entries yet)`);
          }
        } catch {
          console.log(`  \u2717 ${aqua('Audit')} log not writable (${auditLog})`);
          console.log('    \u2192 Check file permissions on ~/.aquaman/audit/');
          issues++;
        }
      }
    }

    // 5.5 Policy config
    if (config?.policy && Object.keys(config.policy).length > 0) {
      const policyConfigDoc = loadPolicyFromConfig(config);
      const validation = validatePolicyConfig(policyConfigDoc);
      if (validation.valid) {
        const serviceCount = Object.keys(policyConfigDoc).length;
        const ruleCount = Object.values(policyConfigDoc).reduce((sum, sp) => sum + sp.rules.length, 0);
        console.log(`  \u2713 ${aqua('Policy')} valid (${serviceCount} service${serviceCount !== 1 ? 's' : ''}, ${ruleCount} rule${ruleCount !== 1 ? 's' : ''})`);
        for (const [svc, sp] of Object.entries(policyConfigDoc)) {
          const denyRules = sp.rules.filter(r => r.action === 'deny');
          if (denyRules.length > 0) {
            const summary = denyRules.map(r => r.method !== '*' ? `${r.action} ${r.method} ${r.path}` : `${r.action} ${r.path}`).join(', ');
            console.log(`      ${svc}: ${summary}`);
          }
        }
        // Warn about policies for non-proxied services
        if (config.credentials.proxiedServices) {
          for (const svc of Object.keys(policyConfigDoc)) {
            if (!config.credentials.proxiedServices.includes(svc)) {
              console.log(`  \u26a0 ${aqua('Policy')} service "${svc}" has rules but is not in proxiedServices`);
              issues++;
            }
          }
        }
      } else {
        for (const err of validation.errors) {
          console.log(`  \u2717 ${aqua('Policy')} ${err}`);
        }
        issues++;
      }
    } else {
      console.log(`  \u2139 ${aqua('Policy')} not configured \u2014 agents can call any endpoint on proxied services`);
      console.log('    \u2192 Run: aquaman setup (or add policy rules to ~/.aquaman/config.yaml)');
    }

    // 6. OpenClaw detection
    let openclawDetected = false;
    let openclawVersion: string | null = null;
    let cliFound = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('which openclaw', { stdio: 'pipe' });
      cliFound = true;
    } catch { /* not in PATH */ }

    if (cliFound) {
      try {
        const { execSync } = await import('node:child_process');
        const ver = execSync('openclaw --version', { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
        openclawVersion = ver;
        console.log(`  \u2713 ${aqua('OpenClaw')} installed (${ver})`);
      } catch {
        console.log(`  \u2713 ${aqua('OpenClaw')} installed`);
      }
      openclawDetected = true;
    } else if (fs.existsSync(openclawStateDir)) {
      console.log(`  \u2713 ${aqua('OpenClaw')} detected (state dir found)`);
      openclawDetected = true;
    } else {
      console.log(`  - ${aqua('OpenClaw')} not detected (skipping plugin checks)`);
    }

    if (openclawDetected) {
      // 6. Plugin installed + version check
      const pluginPath = path.join(openclawStateDir, 'extensions', 'aquaman-plugin');
      if (fs.existsSync(pluginPath)) {
        const pluginPkgPath = path.join(pluginPath, 'package.json');
        let pluginVer: string | null = null;
        try {
          pluginVer = JSON.parse(fs.readFileSync(pluginPkgPath, 'utf-8')).version;
        } catch { /* ok */ }
        const verLabel = pluginVer ? ` v${pluginVer}` : '';
        console.log(`  \u2713 ${aqua('Plugin')} installed${verLabel} (${pluginPath})`);
        if (pluginVer && pluginVer !== VERSION) {
          console.log(`  \u2717 ${aqua('Version mismatch:')} CLI v${VERSION} \u2260 plugin v${pluginVer}`);
          console.log('    \u2192 Update: openclaw plugins install aquaman-plugin');
          issues++;
        }
      } else {
        console.log(`  \u2717 ${aqua('Plugin')} not installed`);
        console.log('    \u2192 Run: aquaman setup');
        issues++;
      }

      // 7. openclaw.json has plugin entry
      const openclawJsonPath = path.join(openclawStateDir, 'openclaw.json');
      if (fs.existsSync(openclawJsonPath)) {
        try {
          const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
          if (openclawConfig.plugins?.entries?.['aquaman-plugin']) {
            console.log(`  \u2713 ${aqua('Plugin')} configured in openclaw.json`);
          } else {
            console.log(`  \u2717 ${aqua('Plugin')} not configured in openclaw.json`);
            console.log('    \u2192 Run: aquaman setup');
            issues++;
          }
        } catch {
          console.log(`  \u2717 ${aqua('openclaw.json')} is invalid`);
          console.log('    \u2192 Run: aquaman setup');
          issues++;
        }
      } else {
        console.log(`  \u2717 ${aqua('openclaw.json')} not found`);
        console.log('    \u2192 Run: aquaman setup');
        issues++;
      }

      // 8. plugins.allow includes aquaman-plugin
      if (fs.existsSync(openclawJsonPath)) {
        try {
          const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
          const allowList: string[] = openclawConfig.plugins?.allow || [];
          if (allowList.includes('aquaman-plugin')) {
            console.log(`  \u2713 ${aqua('Plugin')} in plugins.allow trust list`);
          } else {
            console.log(`  \u2717 ${aqua('Plugin')} not in plugins.allow trust list`);
            console.log('    \u2192 Run: aquaman setup (or add "aquaman-plugin" to plugins.allow in openclaw.json)');
            console.log('    Note: "openclaw security audit" will show a dangerous-exec finding for proxy-manager.ts.');
            console.log('    This is expected \u2014 the plugin spawns the proxy as a separate process for credential isolation.');
            issues++;
          }
        } catch {
          // openclaw.json invalid — already reported above
        }
      }

      // 9. Auth profiles. OpenClaw >= 2026.6.5 reads provider auth profiles from
      //    each agent's openclaw-agent.sqlite and no longer reads
      //    auth-profiles.json at runtime (openclaw/openclaw#89102). On those
      //    versions the placeholder the plugin writes to the JSON file must be
      //    imported into SQLite once via `openclaw doctor --fix`.
      const agentDir = path.join(openclawStateDir, 'agents', 'main', 'agent');
      const profilesPath = path.join(agentDir, 'auth-profiles.json');
      const sqlitePath = path.join(agentDir, 'openclaw-agent.sqlite');
      if (authProfilesAreSqliteOnly(openclawVersion)) {
        if (fs.existsSync(profilesPath)) {
          console.log(`  \u2717 ${aqua('Auth profiles')} JSON present but ${openclawVersion} reads from SQLite`);
          console.log('    \u2192 Import the placeholder once: openclaw doctor --fix  (backs up openclaw.json first)');
          console.log('      (OpenClaw \u2265 2026.6.5 dropped the runtime auth-profiles.json read path \u2014 openclaw/openclaw#89102)');
          issues++;
        } else if (fs.existsSync(sqlitePath)) {
          console.log(`  \u2713 ${aqua('Auth profiles')} (SQLite store present; OpenClaw \u2265 2026.6.5)`);
        } else {
          console.log(`  \u2717 ${aqua('Auth profiles')} missing (no SQLite store found)`);
          console.log('    \u2192 Run: aquaman setup, then: openclaw doctor --fix');
          issues++;
        }
      } else if (fs.existsSync(profilesPath)) {
        console.log(`  \u2713 ${aqua('Auth profiles')} exist`);
      } else {
        console.log(`  \u2717 ${aqua('Auth profiles')} missing`);
        console.log('    \u2192 Run: aquaman setup');
        issues++;
      }
    }

    // 10. Unmigrated plaintext credentials
    if (openclawDetected) {
      try {
        const { extractCredentials, extractPluginCredentials, scanCredentialsDir } = await import('../migration/openclaw-migrator.js');
        const openclawJsonPath = path.join(openclawStateDir, 'openclaw.json');
        const credentialsDir = path.join(openclawStateDir, 'credentials');

        let plaintext: { source: string; service: string; key: string }[] = [];

        // Scan openclaw.json channels + plugin configs
        if (fs.existsSync(openclawJsonPath)) {
          try {
            const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
            const channelCreds = extractCredentials(openclawConfig);
            for (const c of channelCreds) {
              plaintext.push({ source: 'openclaw.json', service: c.service, key: c.key });
            }
            const pluginCreds = extractPluginCredentials(openclawConfig);
            for (const c of pluginCreds) {
              plaintext.push({ source: 'openclaw.json', service: c.service, key: c.key });
            }
          } catch {
            // Already reported in check 7
          }
        }

        // Scan credentials directory
        const fileCreds = scanCredentialsDir(credentialsDir);
        for (const c of fileCreds) {
          plaintext.push({ source: `credentials/${c.jsonPath[1]}`, service: c.service, key: c.key });
        }

        // Partition into unmigrated vs migrated-but-not-cleaned-up
        const unmigrated: typeof plaintext = [];
        const needsCleanup: typeof plaintext = [];

        if (store) {
          for (const c of plaintext) {
            const inStore = await store.exists(c.service, c.key);
            if (inStore) {
              needsCleanup.push(c);
            } else {
              unmigrated.push(c);
            }
          }
        } else {
          // Can't check store — treat all as unmigrated
          unmigrated.push(...plaintext);
        }

        if (unmigrated.length > 0) {
          console.log(`  \u2717 ${aqua('Unmigrated:')} ${unmigrated.length} plaintext credentials exposed in OpenClaw config`);
          for (const c of unmigrated) {
            console.log(`    ${c.service}/${c.key} \u2190 ${c.source}`);
          }
          console.log('    \u2192 Run: aquaman openclaw migrate --auto');
          issues++;
        }

        if (needsCleanup.length > 0) {
          console.log(`  \u2717 ${aqua('Cleanup needed:')} ${needsCleanup.length} plaintext sources remain after migration`);
          for (const c of needsCleanup) {
            console.log(`    ${c.service}/${c.key} \u2190 ${c.source}`);
          }
          console.log('    \u2192 Remove plaintext sources listed above (credentials are already in secure store)');
          issues++;
        }

        if (unmigrated.length === 0 && needsCleanup.length === 0) {
          console.log(`  \u2713 ${aqua('Unmigrated:')} none (all credentials secured)`);
        }
      } catch {
        // Migrator import failed — skip check
      }
    }

    // Summary
    console.log('');
    if (issues === 0) {
      console.log('  All checks passed.');
    } else {
      console.log(`  ${issues} issue${issues > 1 ? 's' : ''} found. Fix the above and re-run \`aquaman doctor\`.`);
    }
    console.log('');

    process.exitCode = issues > 0 ? 1 : 0;
  });

// Audit commands
const audit = program.command('audit').description('Audit log management');

audit
  .command('tail')
  .description('Show recent audit entries')
  .option('-n, --lines <count>', 'Number of lines', '20')
  .action(async (options) => {
    const config = loadConfig();
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: true
    });
    await auditLogger.initialize();

    const entries = await auditLogger.tail(parseInt(options.lines, 10));

    if (entries.length === 0) {
      console.log('No audit entries found.');
      return;
    }

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toISOString();
      const type = entry.type.toUpperCase().padEnd(16);
      console.log(`${time} [${type}] ${formatEntry(entry)}`);
    }
  });

audit
  .command('verify')
  .description('Verify audit log integrity')
  .action(async () => {
    const config = loadConfig();
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: true
    });
    await auditLogger.initialize();

    const result = await auditLogger.verifyIntegrity();

    if (result.valid) {
      console.log('Audit log integrity verified');
      const stats = auditLogger.getStats();
      console.log(`  Entries: ${stats.entryCount}`);
      console.log(`  Last hash: ${stats.lastHash.slice(0, 16)}...`);
    } else {
      console.log('Audit log integrity FAILED');
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
      process.exit(1);
    }
  });

audit
  .command('rotate')
  .description('Rotate audit log to archive')
  .action(async () => {
    const config = loadConfig();
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: true
    });
    await auditLogger.initialize();

    try {
      const archivePath = await auditLogger.rotateLog();
      console.log(`Log rotated to: ${archivePath}`);
    } catch (error) {
      console.error('Failed to rotate log:', error);
      process.exit(1);
    }
  });

// Credentials commands
const credentials = program.command('credentials').description('Credential management');

credentials
  .command('add <service> <key>')
  .description('Add a credential')
  .option('--backend <backend>', 'Override credential backend')
  .action(async (service: string, key: string, options) => {
    validateCredName('service', service);
    validateCredName('key', key);

    const config = loadConfig();
    const backend = options.backend || config.credentials.backend;

    let store;
    try {
      store = await createCredentialStore({
        backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch (error) {
      console.error('Credential store not available:', error instanceof Error ? error.message : error);
      process.exit(1);
    }

    // Two stdin paths:
    //   - TTY (interactive shell): per-character raw-mode read so the value
    //     never echoes. Submit on Enter, backspace on DEL/^H.
    //   - Pipe (scripts / CI / migrations): read all stdin into one buffer.
    //     Strip exactly ONE trailing newline so `printf x | ...` and
    //     `echo x | ...` both round-trip to `x` without mangling embedded
    //     newlines in PEM keys or JSON blobs.
    const value: string = process.stdin.isTTY
      ? await readTtyHiddenInput(`Enter value for ${service}/${key} (input hidden):`)
      : await readAllStdin();

    if (value.length === 0) {
      console.error('Empty credential value rejected. Pipe a value or type one.');
      process.exit(1);
    }

    await store!.set(service, key, value);
    console.log(`Credential stored: ${service}/${key}`);
  });

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  // Strip a single trailing \n (and the optional \r before it for CRLF).
  return raw.endsWith('\n') ? raw.replace(/\r?\n$/, '') : raw;
}

async function readTtyHiddenInput(prompt: string): Promise<string> {
  console.log(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  return new Promise((resolve) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          console.log('');
          resolve(value);
          return;
        }
        if (char === '\x7f' || char === '\b') {
          value = value.slice(0, -1);
        } else if (char === '\x03') {  // Ctrl-C
          process.stdin.setRawMode(false);
          process.exit(130);
        } else {
          value += char;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

credentials
  .command('list')
  .description('List stored credentials')
  .action(async () => {
    const config = loadConfig();
    let store;
    try {
      store = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch {
      console.error('Credential store not available.');
      process.exit(1);
    }

    const creds = await store.list();

    if (creds.length === 0) {
      console.log('No credentials stored.');
      return;
    }

    console.log('Stored credentials:');
    for (const cred of creds) {
      console.log(`  ${cred.service}/${cred.key}`);
    }
  });

credentials
  .command('delete <service> <key>')
  .description('Delete a credential')
  .action(async (service: string, key: string) => {
    validateCredName('service', service);
    validateCredName('key', key);

    const config = loadConfig();
    let store;
    try {
      store = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
    } catch {
      console.error('Credential store not available.');
      process.exit(1);
    }

    const deleted = await store.delete(service, key);
    if (deleted) {
      console.log(`Credential deleted: ${service}/${key}`);
    } else {
      console.log(`Credential not found: ${service}/${key}`);
    }
  });

credentials
  .command('guide')
  .description('Show setup commands for seeding credentials based on your backend')
  .option('--backend <backend>', 'Override backend (keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden)')
  .option('--service <name>', 'Show commands for a single service only')
  .action(async (options) => {
    const config = loadConfig();
    const backend = options.backend || config.credentials.backend;
    const registry = createServiceRegistry({ configPath: config.services.configPath });

    let serviceNames = config.credentials.proxiedServices;
    if (options.service) {
      if (!registry.has(options.service)) {
        console.error(`Unknown service: ${options.service}`);
        process.exit(1);
      }
      serviceNames = [options.service];
    }

    console.log(`Credential setup guide (backend: ${backend})\n`);

    for (const name of serviceNames) {
      const def = registry.get(name);
      if (!def) continue;

      // Collect all credential keys for this service
      const keys: string[] = [def.credentialKey];
      if (def.additionalCredentialKeys) {
        keys.push(...def.additionalCredentialKeys);
      }
      if (def.additionalHeaders) {
        for (const h of Object.values(def.additionalHeaders)) {
          if (!keys.includes(h.credentialKey)) {
            keys.push(h.credentialKey);
          }
        }
      }

      console.log(`${name} (${def.description || 'no description'}):`);
      if (keys.length > 1) {
        console.log(`  [multi-credential service: ${keys.length} keys required]`);
      }

      for (const key of keys) {
        switch (backend) {
          case 'vault':
            console.log(`  vault kv put secret/aquaman/${name}/${key} credential="YOUR_KEY"`);
            break;
          case '1password':
            // Prefer aquaman's own CLI — it pipes the value via a 0o600 temp
            // template file, never exposing the secret on argv or in op's
            // /proc/<pid>/cmdline.
            console.log(`  aquaman credentials add ${name} ${key}`);
            break;
          default:
            console.log(`  aquaman credentials add ${name} ${key}`);
            break;
        }
      }
      console.log('');
    }
  });

// Services commands
const services = program.command('services').description('Service registry management');

services
  .command('list')
  .description('List all configured services')
  .option('--builtin', 'Show only builtin services')
  .option('--custom', 'Show only custom services')
  .action(async (options) => {
    const config = loadConfig();
    const registry = createServiceRegistry({ configPath: config.services.configPath });
    const builtinNames = new Set(ServiceRegistry.getBuiltinServiceNames());
    const allServices = registry.getAll();

    let filtered = allServices;
    if (options.builtin) {
      filtered = allServices.filter(s => builtinNames.has(s.name));
    } else if (options.custom) {
      filtered = allServices.filter(s => !builtinNames.has(s.name));
    }

    if (filtered.length === 0) {
      console.log('No services found.');
      return;
    }

    console.log('Configured services:\n');
    for (const service of filtered) {
      const source = builtinNames.has(service.name) ? '(builtin)' : '(custom)';
      console.log(`  ${service.name} ${source}`);
      console.log(`    Upstream: ${service.upstream}`);
      console.log(`    Auth: ${service.authHeader}${service.authPrefix ? ` (prefix: "${service.authPrefix}")` : ''}`);
      console.log(`    Credential key: ${service.credentialKey}`);
      if (service.description) {
        console.log(`    Description: ${service.description}`);
      }
      console.log('');
    }
  });

services
  .command('validate')
  .description('Validate services.yaml configuration')
  .option('-p, --path <path>', 'Path to services.yaml')
  .action(async (options) => {
    const config = loadConfig();
    const configPath = options.path || config.services.configPath;

    if (!fs.existsSync(configPath)) {
      console.log(`No services file found at ${configPath}`);
      console.log('\nTo create a custom services file:');
      console.log(`  1. Create ${configPath}`);
      console.log('  2. Add services in YAML format:');
      console.log('');
      console.log('services:');
      console.log('  - name: my-api');
      console.log('    upstream: https://api.example.com');
      console.log('    authHeader: Authorization');
      console.log('    authPrefix: "Bearer "');
      console.log('    credentialKey: api_key');
      return;
    }

    const result = ServiceRegistry.validateConfigFile(configPath);

    if (result.valid) {
      console.log(`${configPath} is valid`);
      const registry = createServiceRegistry({ configPath });
      console.log(`  Found ${registry.getAll().length} services`);
    } else {
      console.log(`${configPath} has errors:\n`);
      for (const error of result.errors) {
        console.log(`  - ${error}`);
      }
      process.exit(1);
    }
  });

// Policy commands
const policy = program.command('policy').description('Request policy management');

policy
  .command('list')
  .description('List configured policy rules')
  .action(async () => {
    const config = loadConfig();
    const policyConfig = loadPolicyFromConfig(config);

    if (Object.keys(policyConfig).length === 0) {
      console.log('No policies configured. Run: aquaman setup');
      return;
    }

    for (const [name, sp] of Object.entries(policyConfig)) {
      console.log(formatServicePolicy(name, sp));
    }
  });

policy
  .command('test <service> <method> <path>')
  .description('Test whether a request would be allowed or denied')
  .action(async (service: string, method: string, reqPath: string) => {
    const config = loadConfig();
    const policyConfig = loadPolicyFromConfig(config);

    const result = matchPolicy(service, method.toUpperCase(), reqPath, policyConfig);

    if (!policyConfig[service]) {
      console.log(`  \u2713 ALLOWED (no policy for service "${service}")`);
      return;
    }

    if (result.allowed) {
      const svcPolicy = policyConfig[service];
      console.log(`  \u2713 ALLOWED (no matching rule, default: ${svcPolicy.defaultAction})`);
    } else {
      const rule = result.matchedRule!;
      console.log(`  \u2717 DENIED by rule: ${rule.method} ${rule.path} \u2192 ${rule.action}`);
    }
  });

// Migration commands
openclaw
  .command('migrate')
  .description('Migrate channel credentials from openclaw.json into aquaman')
  .option('-c, --config <path>', 'Path to openclaw.json')
  .option('--dry-run', 'Show what would be migrated without writing')
  .option('--overwrite', 'Overwrite existing credentials in store')
  .option('--auto', 'Auto-detect and migrate all credentials with guided preview')
  .option('--cleanup', 'Auto-remove plaintext originals after migration (no prompt)')
  .option('--no-cleanup', 'Skip plaintext removal after migration')
  .action(async (opts: { config?: string; dryRun?: boolean; overwrite?: boolean; auto?: boolean; cleanup?: boolean }) => {
    const {
      findOpenClawConfig,
      migrateFromOpenClaw,
      extractCredentials,
      extractPluginCredentials,
      extractPluginUpstreamUrls,
      scanCredentialsDir,
      readCredentialFromFile,
      getCleanupCommands,
      cleanupSources
    } = await import('../migration/openclaw-migrator.js');
    const appConfig = loadConfig();
    const os = await import('node:os');

    if (opts.auto) {
      // --- Auto mode: guided migration with preview ---
      const configDir = getConfigDir();
      const configPath = path.join(configDir, 'config.yaml');

      // Check aquaman is configured
      if (!fs.existsSync(configPath)) {
        console.error('No aquaman config found. Run `aquaman setup` first.');
        process.exit(1);
      }

      console.log(`\n  \u{1F531} Aquaman ${aqua(VERSION)} \u2014 Time to put your secrets somewhere safe.\n`);
      console.log('  Scanning for plaintext credentials...\n');

      const openclawStateDir = process.env['OPENCLAW_STATE_DIR'] || path.join(os.homedir(), '.openclaw');
      const openclawConfigPath = findOpenClawConfig(opts.config || path.join(openclawStateDir, 'openclaw.json'));
      const credentialsDir = path.join(openclawStateDir, 'credentials');

      // Scan all sources
      const fromConfig: Array<{ service: string; key: string; source: string; value: string | null }> = [];
      const fromPlugins: Array<{ service: string; key: string; source: string; value: string | null }> = [];
      const fromDir: Array<{ service: string; key: string; source: string; value: string | null }> = [];
      let upstreamMap = new Map<string, { upstream: string; hostname: string; sourceField: string }>();

      // 1. Scan openclaw.json (channels + plugin configs)
      if (fs.existsSync(openclawConfigPath)) {
        try {
          const content = fs.readFileSync(openclawConfigPath, 'utf-8');
          const config = JSON.parse(content);

          // Channel credentials
          const mappings = extractCredentials(config);
          for (const m of mappings) {
            let current: any = config;
            for (const key of m.jsonPath) {
              if (!current || typeof current !== 'object') { current = null; break; }
              current = current[key];
            }
            const value = typeof current === 'string' ? current : null;
            if (value && value !== 'aquaman-proxy-managed' && !value.startsWith('aquaman://')) {
              fromConfig.push({
                service: m.service,
                key: m.key,
                source: m.jsonPath.join('.'),
                value
              });
            }
          }

          // Plugin credentials
          const pluginMappings = extractPluginCredentials(config);
          for (const m of pluginMappings) {
            let current: any = config;
            for (const key of m.jsonPath) {
              if (!current || typeof current !== 'object') { current = null; break; }
              current = current[key];
            }
            const value = typeof current === 'string' ? current : null;
            if (value && value !== 'aquaman-proxy-managed' && !value.startsWith('aquaman://')) {
              fromPlugins.push({
                service: m.service,
                key: m.key,
                source: m.jsonPath.join('.'),
                value
              });
            }
          }

          // Extract upstream URLs from plugin configs
          upstreamMap = new Map(
            extractPluginUpstreamUrls(config).map(u => [u.pluginId, { upstream: u.upstream, hostname: u.hostname, sourceField: u.sourceField }])
          );
        } catch { /* skip unparseable config */ }
      }

      // 2. Scan credentials directory
      if (fs.existsSync(credentialsDir)) {
        const dirMappings = scanCredentialsDir(credentialsDir);
        for (const m of dirMappings) {
          const value = readCredentialFromFile(credentialsDir, m.jsonPath[1]);
          if (value) {
            fromDir.push({
              service: m.service,
              key: m.key,
              source: `credentials-dir.${m.jsonPath[1]}`,
              value
            });
          }
        }
      }

      // Merge & de-duplicate (prefer credentials dir over config over plugins)
      const seen = new Set<string>();
      const allCredentials: typeof fromDir = [];

      for (const cred of fromDir) {
        const id = `${cred.service}/${cred.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          allCredentials.push(cred);
        }
      }
      for (const cred of fromConfig) {
        const id = `${cred.service}/${cred.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          allCredentials.push(cred);
        }
      }
      for (const cred of fromPlugins) {
        const id = `${cred.service}/${cred.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          allCredentials.push(cred);
        }
      }

      if (allCredentials.length === 0) {
        console.log('  No plaintext credentials found. Nothing to migrate.');
        return;
      }

      // Display preview
      const dim = noColor ? (s: string) => s : (s: string) => `\x1b[2m${s}\x1b[0m`;
      const green = noColor ? (s: string) => s : (s: string) => `\x1b[32m${s}\x1b[0m`;

      console.log(`  Found ${allCredentials.length} credential${allCredentials.length > 1 ? 's' : ''}:\n`);

      if (fromConfig.length > 0) {
        console.log(`    From ${dim('openclaw.json channels')}:`);
        for (const c of fromConfig) {
          if (allCredentials.some(a => a.service === c.service && a.key === c.key && a.source === c.source)) {
            console.log(`      ${aqua(`${c.service}/${c.key}`)}    \u2190 ${dim(c.source)}`);
          }
        }
      }

      if (fromPlugins.length > 0) {
        console.log(`    From ${dim('openclaw.json plugins')}:`);
        for (const c of fromPlugins) {
          if (allCredentials.some(a => a.service === c.service && a.key === c.key && a.source === c.source)) {
            console.log(`      ${aqua(`${c.service}/${c.key}`)}    \u2190 ${dim(c.source)}`);
          }
        }
      }

      if (fromDir.length > 0) {
        console.log(`    From ${dim('~/.openclaw/credentials/')}:`);
        for (const c of fromDir) {
          console.log(`      ${aqua(`${c.service}/${c.key}`)}    \u2190 ${dim(c.source.replace('credentials-dir.', ''))}`);
        }
      }

      const backendLabel = appConfig.credentials.backend === 'keychain' ? 'macOS Keychain' :
        appConfig.credentials.backend === 'encrypted-file' ? 'Encrypted file' :
        appConfig.credentials.backend === 'keepassxc' ? 'KeePassXC (.kdbx)' :
        appConfig.credentials.backend === '1password' ? '1Password' :
        appConfig.credentials.backend === 'vault' ? 'HashiCorp Vault' :
        appConfig.credentials.backend;

      console.log(`\n  Destination: ${aqua(backendLabel)} (${appConfig.credentials.backend})\n`);

      // Dry run: show preview only
      if (opts.dryRun) {
        // Show which services would be registered
        if (fromPlugins.length > 0) {
          const registry = createServiceRegistry({ configPath: appConfig.services.configPath });
          const newServices = [...new Set(fromPlugins.map(c => c.service))].filter(s => !registry.has(s));
          if (newServices.length > 0) {
            console.log(`  Would add to services.yaml: ${newServices.join(', ')}`);
            for (const svc of newServices) {
              const info = upstreamMap.get(svc);
              if (info) {
                console.log(`    ${aqua(svc)}: upstream ${dim(info.upstream)} (from ${info.sourceField})`);
              }
            }
            console.log(`  Would add to proxiedServices: ${newServices.join(', ')}`);
          }
        }
        console.log('  (dry run \u2014 no credentials will be written)');
        return;
      }

      // Confirmation prompt (skip for non-TTY)
      const isTTY = process.stdin.isTTY && process.stdout.isTTY;
      if (isTTY) {
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(`  Migrate these ${allCredentials.length} credentials? (y/N): `, resolve);
        });
        rl.close();
        if (answer.toLowerCase() !== 'y') {
          console.log('  Aborted.');
          return;
        }
      }

      // Migrate
      let store;
      try {
        store = await createCredentialStore({
          backend: appConfig.credentials.backend,
          encryptionPassword: appConfig.credentials.encryptionPassword,
          vaultAddress: appConfig.credentials.vaultAddress,
          vaultToken: appConfig.credentials.vaultToken,
          onePasswordVault: appConfig.credentials.onePasswordVault,
          onePasswordAccount: appConfig.credentials.onePasswordAccount,
          keepassxcDatabasePath: appConfig.credentials.keepassxcDatabasePath,
          keepassxcKeyFilePath: appConfig.credentials.keepassxcKeyFilePath
        });
      } catch (err) {
        console.error(`  Failed to initialize credential store: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }

      let migrated = 0;
      for (const cred of allCredentials) {
        if (cred.value) {
          await store.set(cred.service, cred.key, cred.value);
          migrated++;
        }
      }

      console.log(`\n  ${green('\u2713')} Migrated ${migrated} credential${migrated > 1 ? 's' : ''}\n`);

      // Auto-register unknown plugin services in services.yaml + proxiedServices
      if (!opts.dryRun && fromPlugins.length > 0) {
        const registry = createServiceRegistry({ configPath: appConfig.services.configPath });
        const unknownServices = new Map<string, string[]>(); // service name → credential keys

        for (const cred of fromPlugins) {
          if (!registry.has(cred.service) && !unknownServices.has(cred.service)) {
            unknownServices.set(cred.service, []);
          }
          if (unknownServices.has(cred.service)) {
            unknownServices.get(cred.service)!.push(cred.key);
          }
        }

        if (unknownServices.size > 0) {
          // Read or create services.yaml
          const servicesYamlPath = appConfig.services.configPath;
          let servicesConfig: { services: any[] } = { services: [] };

          if (fs.existsSync(servicesYamlPath)) {
            try {
              const content = fs.readFileSync(servicesYamlPath, 'utf-8');
              const parsed = yamlParse(content);
              if (parsed?.services && Array.isArray(parsed.services)) {
                servicesConfig = parsed;
              }
            } catch { /* start fresh */ }
          }

          const existingNames = new Set(servicesConfig.services.map((s: any) => s.name));

          const todoServices: string[] = [];

          for (const [serviceName, credKeys] of unknownServices) {
            if (existingNames.has(serviceName)) continue;

            const info = upstreamMap.get(serviceName);
            const upstream = info?.upstream || 'https://TODO-SET-UPSTREAM-URL';
            const hostPatterns = info?.hostname ? [info.hostname] : [];

            servicesConfig.services.push({
              name: serviceName,
              upstream,
              authHeader: 'Authorization',
              authPrefix: 'Bearer ',
              credentialKey: credKeys[0],
              description: `Auto-generated from ${serviceName} plugin migration`,
              authMode: 'header',
              hostPatterns,
            });

            if (info) {
              console.log(`  ${green('\u2713')} Added ${aqua(serviceName)} to services.yaml (upstream: ${info.upstream})`);
            } else {
              console.log(`  ${green('\u2713')} Added ${aqua(serviceName)} to services.yaml`);
              todoServices.push(serviceName);
            }
          }

          fs.mkdirSync(path.dirname(servicesYamlPath), { recursive: true });
          fs.writeFileSync(servicesYamlPath, yamlStringify(servicesConfig), 'utf-8');

          // Add to proxiedServices in config.yaml
          const updatedConfig = loadConfig();
          let addedToProxied = false;
          for (const serviceName of unknownServices.keys()) {
            if (!updatedConfig.credentials.proxiedServices.includes(serviceName)) {
              updatedConfig.credentials.proxiedServices.push(serviceName);
              addedToProxied = true;
            }
          }
          if (addedToProxied) {
            saveConfig(updatedConfig);
            console.log(`  ${green('\u2713')} Updated proxiedServices in config.yaml`);
          }

          if (todoServices.length > 0) {
            console.log('');
            console.log(`  ${dim('Note: Set the upstream URL for new services in:')}`);
            console.log(`  ${dim(servicesYamlPath)}`);
            console.log('');
          }
        }
      }

      // Cleanup: remove plaintext originals
      const migratedResults = allCredentials.map(c => ({
        service: c.service,
        key: c.key,
        source: c.source
      }));

      // Determine whether to clean up
      let shouldCleanup = false;
      if (opts.cleanup === true) {
        shouldCleanup = true;
      } else if (opts.cleanup === false) {
        // --no-cleanup: skip
        shouldCleanup = false;
      } else if (isTTY) {
        // Interactive: prompt
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question('  Remove plaintext originals? (y/N): ', resolve);
        });
        rl.close();
        shouldCleanup = answer.toLowerCase() === 'y';
      }

      if (shouldCleanup) {
        const cleanupResult = cleanupSources(openclawConfigPath, credentialsDir, migratedResults);
        for (const d of cleanupResult.deleted) {
          console.log(`  ${green('\u2713')} ${d.description}`);
        }
        for (const e of cleanupResult.errors) {
          console.log(`  \u2717 ${e.source}: ${e.error}`);
        }
        if (cleanupResult.deleted.length > 0) {
          console.log('');
        }
      } else if (opts.cleanup !== true) {
        // Show manual cleanup commands if not auto-cleaning
        const cleanup = getCleanupCommands(openclawConfigPath, credentialsDir, migratedResults);
        if (cleanup.length > 0) {
          console.log('  Cleanup \u2014 remove plaintext sources:');
          for (const cmd of cleanup) {
            console.log(`    ${cmd}`);
          }
          console.log('');
        }
      }

      return;
    }

    // --- Original (non-auto) mode ---
    const configPath = findOpenClawConfig(opts.config);
    console.log(`Reading: ${configPath}`);

    if (opts.dryRun) {
      console.log('(dry run - no credentials will be written)\n');
    }

    const store = await createCredentialStore({
      backend: appConfig.credentials.backend,
      encryptionPassword: appConfig.credentials.encryptionPassword,
      vaultAddress: appConfig.credentials.vaultAddress,
      vaultToken: appConfig.credentials.vaultToken,
      onePasswordVault: appConfig.credentials.onePasswordVault,
      onePasswordAccount: appConfig.credentials.onePasswordAccount,
      keepassxcDatabasePath: appConfig.credentials.keepassxcDatabasePath,
      keepassxcKeyFilePath: appConfig.credentials.keepassxcKeyFilePath
    });

    const result = await migrateFromOpenClaw(configPath, store, {
      dryRun: opts.dryRun,
      overwrite: opts.overwrite,
    });

    if (result.migrated.length > 0) {
      console.log(`${opts.dryRun ? 'Would migrate' : 'Migrated'} ${result.migrated.length} credential(s):`);
      for (const m of result.migrated) {
        console.log(`  ${m.service}:${m.key} ← ${m.source}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log(`\nSkipped ${result.skipped.length}:`);
      for (const s of result.skipped) {
        console.log(`  ${s.service}:${s.key} - ${s.reason}`);
      }
    }

    if (result.errors.length > 0) {
      console.log(`\nErrors ${result.errors.length}:`);
      for (const e of result.errors) {
        console.log(`  ${e.service}:${e.key} - ${e.error}`);
      }
      process.exit(1);
    }

    if (!opts.dryRun && result.migrated.length > 0) {
      console.log('\nCredentials stored securely. You can now remove plaintext tokens from openclaw.json.');
      console.log('Add the migrated services to your aquaman config: services: [...]');
    }
  });

// Status command
// openclaw status — deep status for the OpenClaw integration.
openclaw
  .command('status')
  .description('OpenClaw-specific status (plugin lifecycle, sentinel env vars)')
  .action(async () => {
    const config = loadConfig();

    console.log('aquaman status\n');

    console.log('Configuration:');
    console.log(`  Config dir: ${getConfigDir()}`);
    console.log(`  Credential backend: ${config.credentials.backend}`);
    console.log(`  Socket path: ${path.join(getConfigDir(), 'proxy.sock')}`);
    console.log(`  Audit logging: ${config.audit.enabled ? 'enabled' : 'disabled'}`);

    console.log('\nProxied services:');
    for (const service of config.credentials.proxiedServices) {
      console.log(`  - ${service}`);
    }

    // Policy summary
    const policyConfig = loadPolicyFromConfig(config);
    const policySvcCount = Object.keys(policyConfig).length;
    if (policySvcCount > 0) {
      const ruleCount = Object.values(policyConfig).reduce((sum, sp) => sum + sp.rules.length, 0);
      console.log(`\nRequest policies: ${policySvcCount} service${policySvcCount !== 1 ? 's' : ''}, ${ruleCount} rule${ruleCount !== 1 ? 's' : ''}`);
      for (const [svc, sp] of Object.entries(policyConfig)) {
        console.log(`  - ${svc}: ${sp.rules.length} rule${sp.rules.length !== 1 ? 's' : ''} (default: ${sp.defaultAction})`);
      }
    } else {
      console.log('\nRequest policies: not configured');
    }

    // Check for stored credentials
    try {
      const store = await createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount,
        keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
        keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
        bitwardenFolder: config.credentials.bitwardenFolder,
        bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
        bitwardenCollectionId: config.credentials.bitwardenCollectionId
      });
      const creds = await store.list();
      console.log(`\nStored credentials: ${creds.length}`);
    } catch {
      console.log('\nStored credentials: (backend unavailable)');
    }

    // Check for OpenClaw
    const registry = createServiceRegistry({ configPath: config.services.configPath });
    const registryServices = registry.getAll().filter(s =>
      config.credentials.proxiedServices.includes(s.name)
    );
    const integration = createOpenClawIntegration(config, registryServices);
    const info = await integration.detectOpenClaw();

    console.log(`\nOpenClaw: ${info.installed ? `installed (${info.version})` : 'not found'}`);
  });

/** Format a single service policy for display (used by policy list, setup, doctor) */
function formatServicePolicy(name: string, sp: ServicePolicy, indent = '  '): string {
  const lines: string[] = [];
  lines.push(`${indent}${name} (default: ${sp.defaultAction})`);
  for (const rule of sp.rules) {
    const method = rule.method.padEnd(6);
    lines.push(`${indent}  ${rule.action === 'deny' ? 'deny' : 'allow'}  ${method} ${rule.path}`);
  }
  return lines.join('\n');
}

function formatEntry(entry: any): string {
  switch (entry.type) {
    case 'tool_call':
      return `${entry.data.tool} ${JSON.stringify(entry.data.params).slice(0, 80)}`;
    case 'tool_result':
      return `Result for ${entry.data.toolCallId}`;
    case 'credential_access':
      return `${entry.data.service} ${entry.data.operation} ${entry.data.success ? 'OK' : `FAIL: ${entry.data.error || 'unknown'}`}`;
    default:
      return JSON.stringify(entry.data).slice(0, 80);
  }
}

// ---------------- coder namespace (shim → aquaman-coder bin) ----------------
//
// The `aquaman coder *` namespace presents a unified user-facing surface for
// the coding-agent adapter. The actual implementation lives in the separate
// `aquaman-coder` package (see packages/coder/). This shim execs that binary
// with the remaining argv, so the proxy CLI never imports coder code — the
// `proxy → coder ✗` boundary in docs/PACKAGES.md stays intact.
//
// If aquaman-coder isn't installed, we print a clear install hint.

// Intercept `aquaman coder ...` BEFORE Commander parses it, so the catch-all
// behavior is exact: every token after `coder` flows through to the
// aquaman-coder binary verbatim, including --flags Commander would otherwise
// interpret as unknown options.
//
// Only intercept when `coder` is the first command token (argv[2]). This
// avoids false positives like `aquaman policy test coder/api /foo` where
// `coder` appears as a positional argument elsewhere.
if (process.argv[2] === 'coder') {
  const subArgs = process.argv.slice(3);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('aquaman-coder', subArgs, { stdio: 'inherit' });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    console.error('aquaman-coder is not installed.');
    console.error('Install it with: npm install -g aquaman-coder');
    process.exit(127);
  }
  if (result.error) {
    console.error(`Failed to run aquaman-coder: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

// Register the `coder` namespace so it shows up in `aquaman --help`.
// Its action is unreachable (the intercept above bypasses Commander entirely),
// but documentation matters.
program
  .command('coder')
  .description('AI coding-agent integration (delegates to `aquaman-coder`)')
  .allowUnknownOption()
  .helpOption(false)
  .action(() => { /* unreachable — handled by intercept */ });

// Show help when run without arguments (like openclaw does)
if (process.argv.length <= 2) {
  program.help();
}

program.parseAsync();
