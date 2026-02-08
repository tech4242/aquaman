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

import { Command } from 'commander';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs';

import {
  loadConfig,
  getConfigDir,
  ensureConfigDir,
  getDefaultConfig,
  expandPath,
  createAuditLogger,
  createCredentialStore,
  generateSelfSignedCert,
  type WrapperConfig
} from 'aquaman-core';

import { fileURLToPath } from 'node:url';

import { createCredentialProxy, type CredentialProxy } from '../daemon.js';
import { createServiceRegistry, ServiceRegistry } from '../service-registry.js';
import { createOpenClawIntegration } from '../openclaw/integration.js';
import { stringify as yamlStringify } from 'yaml';

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

const program = new Command();

program
  .name('aquaman')
  .description('Credential isolation layer for OpenClaw - keeps API keys outside the agent process')
  .version(VERSION)
  .addHelpText('before', `\n\u{1F531}\u{1F99E} Aquaman ${aqua(VERSION)} \u2014 Credential isolation for OpenClaw\n`)
  .configureHelp({
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments
        .map((arg: any) => {
          const n = arg.name() + (arg.variadic ? '...' : '');
          return arg.required ? `<${n}>` : `[${n}]`;
        })
        .join(' ');
      return aqua(cmd.name()) + (cmd.options.length ? ' [options]' : '') + (args ? ' ' + args : '');
    }
  });

// Start command - launches credential proxy + OpenClaw
program
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
      console.log(`  Port: ${config.credentials.proxyPort}`);
      console.log(`  TLS: ${config.credentials.tls?.enabled ? 'enabled' : 'disabled'}`);
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
      credentialStore = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
      });
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const bindAddr = config.credentials.bindAddress || '127.0.0.1';
    const credentialProxy = createCredentialProxy({
      port: config.credentials.proxyPort,
      bindAddress: bindAddr,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      tls: config.credentials.tls,
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

    const protocol = credentialProxy.isTlsEnabled() ? 'https' : 'http';
    console.log(`Credential proxy started on ${protocol}://${bindAddr}:${config.credentials.proxyPort}`);

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
      console.log('Daemon stopped.');
    } catch (err) {
      console.error('Failed to stop daemon:', err);
    }
  });

// Daemon command (runs credential proxy only)
program
  .command('daemon')
  .description('Run the credential proxy daemon (for advanced users)')
  .option('--token <token>', 'Client authentication token (reads AQUAMAN_CLIENT_TOKEN env if not set)')
  .action(async (options) => {
    // Check if daemon is already running
    const existingPid = readPidFile();
    if (existingPid && isProcessRunning(existingPid)) {
      console.error(`Daemon is already running (PID ${existingPid}). Use 'aquaman stop' first.`);
      process.exit(1);
    }

    const config = loadConfig();

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
      credentialStore = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
      });
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Client token: CLI flag → env var → none
    const daemonClientToken: string | undefined = options.token || process.env.AQUAMAN_CLIENT_TOKEN || undefined;

    // Start credential proxy
    const bindAddr = config.credentials.bindAddress || '127.0.0.1';
    const credentialProxy = createCredentialProxy({
      port: config.credentials.proxyPort,
      bindAddress: bindAddr,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      tls: config.credentials.tls,
      clientToken: daemonClientToken,
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

    const protocol = credentialProxy.isTlsEnabled() ? 'https' : 'http';
    console.log(`Credential proxy: ${protocol}://${bindAddr}:${config.credentials.proxyPort}`);
    console.log(`Client auth: ${daemonClientToken ? 'enabled' : 'disabled'}`);
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
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Plugin mode command - for use when managed by OpenClaw plugin
program
  .command('plugin-mode')
  .description('Run in plugin mode (managed by OpenClaw plugin)')
  .option('--port <port>', 'Port to listen on', '8081')
  .option('--token <token>', 'Client authentication token (generated if not provided)')
  .option('--ipc', 'Use IPC instead of HTTP for communication')
  .action(async (options) => {
    const config = loadConfig();
    const port = parseInt(options.port, 10);
    const clientToken: string = options.token || crypto.randomBytes(32).toString('hex');

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
      });
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const credentialProxy = createCredentialProxy({
      port,
      bindAddress: config.credentials.bindAddress || '127.0.0.1',
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      tls: config.credentials.tls,
      clientToken
    });
    await credentialProxy.start();

    const protocol = credentialProxy.isTlsEnabled() ? 'https' : 'http';

    // Output connection info as JSON for plugin to parse
    const connectionInfo = {
      ready: true,
      port: credentialProxy.getPort(),
      protocol,
      baseUrl: `${protocol}://127.0.0.1:${credentialProxy.getPort()}`,
      services: config.credentials.proxiedServices,
      backend: config.credentials.backend,
      token: clientToken
    };

    console.log(JSON.stringify(connectionInfo));

    // Handle shutdown
    const shutdown = async () => {
      await credentialProxy.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Configure command - write OpenClaw environment configuration
program
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
    const env = await integration.configureOpenClaw(
      config.credentials.proxyPort,
      config.credentials.tls?.enabled ?? false
    );

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
  .option('--no-tls', 'Skip TLS certificate generation')
  .action(async (options) => {
    ensureConfigDir();
    const configPath = path.join(getConfigDir(), 'config.yaml');

    if (fs.existsSync(configPath) && !options.force) {
      console.log(`Configuration already exists at ${configPath}`);
      console.log('Use --force to overwrite.');
      return;
    }

    const config = getDefaultConfig();
    fs.writeFileSync(configPath, yamlStringify(config), 'utf-8');
    console.log(`Created ${configPath}`);

    // Create audit directory
    const auditDir = path.join(getConfigDir(), 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    console.log(`Created ${auditDir}`);

    // Generate TLS certificates if enabled
    if (options.tls !== false && config.credentials.tls?.autoGenerate) {
      const certsDir = path.join(getConfigDir(), 'certs');
      fs.mkdirSync(certsDir, { recursive: true });

      const certPath = config.credentials.tls.certPath || path.join(certsDir, 'proxy.crt');
      const keyPath = config.credentials.tls.keyPath || path.join(certsDir, 'proxy.key');

      if (!fs.existsSync(certPath) || options.force) {
        console.log('Generating TLS certificates...');
        try {
          const { cert, key } = generateSelfSignedCert('aquaman-proxy', 365);
          fs.writeFileSync(certPath, cert, { mode: 0o644 });
          fs.writeFileSync(keyPath, key, { mode: 0o600 });
          console.log(`Created ${certPath}`);
          console.log(`Created ${keyPath}`);
        } catch (error) {
          console.error('Warning: Failed to generate TLS certificates:', error);
          console.log('TLS will be disabled. Run "aquaman init --force" to retry.');
        }
      } else {
        console.log('TLS certificates already exist (use --force to regenerate)');
      }
    }

    console.log('\nNext steps:');
    console.log('1. Add your API keys: aquaman credentials add anthropic api_key');
    console.log('2. Start the proxy:   aquaman start');
  });

// Setup command - all-in-one guided onboarding
program
  .command('setup')
  .description('All-in-one setup wizard — creates config, stores credentials, installs plugin')
  .option('--backend <backend>', 'Credential backend (keychain, encrypted-file, 1password, vault)')
  .option('--no-openclaw', 'Skip OpenClaw plugin installation')
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
        // Linux: check for libsecret
        try {
          const { execSync } = await import('node:child_process');
          execSync('pkg-config --exists libsecret-1', { stdio: 'pipe' });
          backend = 'keychain';
        } catch {
          backend = 'encrypted-file';
        }
      }
    }

    // Validate backend
    const validBackends = ['keychain', 'encrypted-file', '1password', 'vault'];
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
    }

    // 2. Run init internally (create dirs, config, no TLS by default)
    ensureConfigDir();
    const config = getDefaultConfig();
    config.credentials.backend = backend;
    config.credentials.tls = { enabled: false };
    fs.writeFileSync(configPath, yamlStringify(config), 'utf-8');

    // Create audit directory
    const auditDir = path.join(configDir, 'audit');
    fs.mkdirSync(auditDir, { recursive: true });

    // 3. Prompt for API keys (or read from env in non-interactive mode)
    let store;
    try {
      store = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword || process.env['AQUAMAN_ENCRYPTION_PASSWORD'],
        vaultAddress: config.credentials.vaultAddress || process.env['VAULT_ADDR'],
        vaultToken: config.credentials.vaultToken || process.env['VAULT_TOKEN'],
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
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

          openclawConfig.plugins.entries['aquaman-plugin'] = {
            enabled: true,
            config: {
              mode: 'proxy',
              backend,
              services: storedServices.length > 0 ? storedServices : ['anthropic', 'openai'],
              proxyPort: 8081
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
            fs.mkdirSync(profilesDir, { recursive: true });
            fs.writeFileSync(profilesPath, JSON.stringify({ version: 1, profiles, order }, null, 2));
            console.log('  \u2713 Auth profiles generated at ' + profilesPath);
          }
        }
      } else {
        console.log('  OpenClaw not detected — skipping plugin install');
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

// Doctor command - diagnostic tool
program
  .command('doctor')
  .description('Check aquaman configuration and diagnose issues')
  .action(async () => {
    const os = await import('node:os');
    const configDir = getConfigDir();
    const configPath = path.join(configDir, 'config.yaml');
    const openclawStateDir = process.env['OPENCLAW_STATE_DIR'] || path.join(os.homedir(), '.openclaw');
    let issues = 0;

    console.log('');
    console.log(`  \u{1F531}\u{1F99E} Aquaman ${VERSION} \u2014 Welcome to the doctor\u2019s office.`);
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
    try {
      config = loadConfig();
      const store = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
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
    const proxyPort = config.credentials.proxyPort;
    const pluginInstalled = fs.existsSync(path.join(openclawStateDir, 'extensions', 'aquaman-plugin'));
    const proxyFix = pluginInstalled
      ? 'Proxy starts automatically with OpenClaw. Run: openclaw'
      : 'Install plugin first: aquaman setup';
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/_health`);
      if (resp.ok) {
        console.log(`  \u2713 ${aqua('Proxy')} running on port ${proxyPort}`);
      } else {
        console.log(`  \u2717 ${aqua('Proxy')} not running on port ${proxyPort}`);
        console.log(`    \u2192 ${proxyFix}`);
        issues++;
      }
    } catch {
      console.log(`  \u2717 ${aqua('Proxy')} not running on port ${proxyPort}`);
      console.log(`    \u2192 ${proxyFix}`);
      issues++;
    }

    // 5. OpenClaw detection
    let openclawDetected = false;
    try {
      const { execSync } = await import('node:child_process');
      const versionOutput = execSync('openclaw --version', { stdio: 'pipe', encoding: 'utf-8' }).trim();
      console.log(`  \u2713 ${aqua('OpenClaw')} detected (${versionOutput})`);
      openclawDetected = true;
    } catch {
      if (fs.existsSync(openclawStateDir)) {
        console.log(`  \u2713 ${aqua('OpenClaw')} state dir exists`);
        openclawDetected = true;
      } else {
        console.log(`  - ${aqua('OpenClaw')} not detected (skipping plugin checks)`);
      }
    }

    if (openclawDetected) {
      // 6. Plugin installed
      const pluginPath = path.join(openclawStateDir, 'extensions', 'aquaman-plugin');
      if (fs.existsSync(pluginPath)) {
        console.log(`  \u2713 ${aqua('Plugin')} installed (${pluginPath})`);
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

      // 8. Auth profiles exist
      const profilesPath = path.join(openclawStateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
      if (fs.existsSync(profilesPath)) {
        console.log(`  \u2713 ${aqua('Auth profiles')} exist`);
      } else {
        console.log(`  \u2717 ${aqua('Auth profiles')} missing`);
        console.log('    \u2192 Run: aquaman setup');
        issues++;
      }
    }

    // 9. Unmigrated plaintext credentials
    if (openclawDetected) {
      try {
        const { extractCredentials, scanCredentialsDir } = await import('../migration/openclaw-migrator.js');
        const openclawJsonPath = path.join(openclawStateDir, 'openclaw.json');
        const credentialsDir = path.join(openclawStateDir, 'credentials');

        let plaintext: { source: string; service: string; key: string }[] = [];

        // Scan openclaw.json channels
        if (fs.existsSync(openclawJsonPath)) {
          try {
            const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
            const channelCreds = extractCredentials(openclawConfig);
            for (const c of channelCreds) {
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

        if (plaintext.length > 0) {
          console.log(`  \u2717 ${aqua('Unmigrated:')} ${plaintext.length} plaintext credentials exposed in OpenClaw config`);
          for (const c of plaintext) {
            console.log(`    ${c.service}/${c.key} \u2190 ${c.source}`);
          }
          console.log('    \u2192 Run: aquaman migrate openclaw --auto');
          issues++;
        } else {
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
    const config = loadConfig();
    const backend = options.backend || config.credentials.backend;

    let store;
    try {
      store = createCredentialStore({
        backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        vaultNamespace: config.credentials.vaultNamespace,
        vaultMountPath: config.credentials.vaultMountPath,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
      });
    } catch (error) {
      console.error('Credential store not available:', error instanceof Error ? error.message : error);
      process.exit(1);
    }

    // Read value from stdin
    console.log(`Enter value for ${service}/${key} (input hidden):`);

    const readline = await import('node:readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    // Disable echo
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let value = '';
    process.stdin.on('data', (data) => {
      const char = data.toString();
      if (char === '\n' || char === '\r') {
        process.stdin.setRawMode(false);
        rl.close();
        storeCredential();
      } else if (char === '\x7f' || char === '\b') {
        value = value.slice(0, -1);
      } else {
        value += char;
      }
    });

    async function storeCredential() {
      console.log('');
      await store!.set(service, key, value.trim());
      console.log(`Credential stored: ${service}/${key}`);
    }
  });

credentials
  .command('list')
  .description('List stored credentials')
  .action(async () => {
    const config = loadConfig();
    let store;
    try {
      store = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
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
    const config = loadConfig();
    let store;
    try {
      store = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
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
  .option('--backend <backend>', 'Override backend (keychain, encrypted-file, vault, 1password)')
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
            console.log(`  op item create --vault aquaman --category "API Credential" --title aquaman-${name}-${key} credential="YOUR_KEY"`);
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

// Migration commands
const migrate = program.command('migrate').description('Migrate credentials from other sources');

migrate
  .command('openclaw')
  .description('Migrate channel credentials from openclaw.json into aquaman')
  .option('-c, --config <path>', 'Path to openclaw.json')
  .option('--dry-run', 'Show what would be migrated without writing')
  .option('--overwrite', 'Overwrite existing credentials in store')
  .option('--auto', 'Auto-detect and migrate all credentials with guided preview')
  .action(async (opts: { config?: string; dryRun?: boolean; overwrite?: boolean; auto?: boolean }) => {
    const {
      findOpenClawConfig,
      migrateFromOpenClaw,
      extractCredentials,
      scanCredentialsDir,
      readCredentialFromFile,
      getCleanupCommands
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

      console.log(`\n  \u{1F531}\u{1F99E} Aquaman ${aqua(VERSION)} \u2014 Time to put your secrets somewhere safe.\n`);
      console.log('  Scanning for plaintext credentials...\n');

      const openclawStateDir = process.env['OPENCLAW_STATE_DIR'] || path.join(os.homedir(), '.openclaw');
      const openclawConfigPath = findOpenClawConfig(opts.config || path.join(openclawStateDir, 'openclaw.json'));
      const credentialsDir = path.join(openclawStateDir, 'credentials');

      // Scan both sources
      const fromConfig: Array<{ service: string; key: string; source: string; value: string | null }> = [];
      const fromDir: Array<{ service: string; key: string; source: string; value: string | null }> = [];

      // 1. Scan openclaw.json
      if (fs.existsSync(openclawConfigPath)) {
        try {
          const content = fs.readFileSync(openclawConfigPath, 'utf-8');
          const config = JSON.parse(content);
          const mappings = extractCredentials(config);
          for (const m of mappings) {
            // Resolve value
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

      // Merge & de-duplicate (prefer credentials dir over config)
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

      if (allCredentials.length === 0) {
        console.log('  No plaintext credentials found. Nothing to migrate.');
        return;
      }

      // Display preview
      const dim = noColor ? (s: string) => s : (s: string) => `\x1b[2m${s}\x1b[0m`;
      const green = noColor ? (s: string) => s : (s: string) => `\x1b[32m${s}\x1b[0m`;

      console.log(`  Found ${allCredentials.length} credential${allCredentials.length > 1 ? 's' : ''}:\n`);

      if (fromConfig.length > 0) {
        console.log(`    From ${dim('openclaw.json')}:`);
        for (const c of fromConfig) {
          if (seen.has(`${c.service}/${c.key}`) || allCredentials.some(a => a.service === c.service && a.key === c.key && a.source === c.source)) {
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
        appConfig.credentials.backend === '1password' ? '1Password' :
        appConfig.credentials.backend === 'vault' ? 'HashiCorp Vault' :
        appConfig.credentials.backend;

      console.log(`\n  Destination: ${aqua(backendLabel)} (${appConfig.credentials.backend})\n`);

      // Dry run: show preview only
      if (opts.dryRun) {
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
        store = createCredentialStore({
          backend: appConfig.credentials.backend,
          encryptionPassword: appConfig.credentials.encryptionPassword,
          vaultAddress: appConfig.credentials.vaultAddress,
          vaultToken: appConfig.credentials.vaultToken,
          onePasswordVault: appConfig.credentials.onePasswordVault,
          onePasswordAccount: appConfig.credentials.onePasswordAccount
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

      // Cleanup commands
      const migratedResults = allCredentials.map(c => ({
        service: c.service,
        key: c.key,
        source: c.source
      }));
      const cleanup = getCleanupCommands(openclawConfigPath, credentialsDir, migratedResults);
      if (cleanup.length > 0) {
        console.log('  Cleanup \u2014 remove plaintext sources:');
        for (const cmd of cleanup) {
          console.log(`    ${cmd}`);
        }
        console.log('');
      }

      return;
    }

    // --- Original (non-auto) mode ---
    const configPath = findOpenClawConfig(opts.config);
    console.log(`Reading: ${configPath}`);

    if (opts.dryRun) {
      console.log('(dry run - no credentials will be written)\n');
    }

    const store = createCredentialStore({
      backend: appConfig.credentials.backend,
      encryptionPassword: appConfig.credentials.encryptionPassword,
      vaultAddress: appConfig.credentials.vaultAddress,
      vaultToken: appConfig.credentials.vaultToken,
      onePasswordVault: appConfig.credentials.onePasswordVault,
      onePasswordAccount: appConfig.credentials.onePasswordAccount
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
program
  .command('status')
  .description('Show aquaman status')
  .action(async () => {
    const config = loadConfig();

    console.log('aquaman status\n');

    console.log('Configuration:');
    console.log(`  Config dir: ${getConfigDir()}`);
    console.log(`  Credential backend: ${config.credentials.backend}`);
    console.log(`  Proxy port: ${config.credentials.proxyPort}`);
    console.log(`  TLS: ${config.credentials.tls?.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Audit logging: ${config.audit.enabled ? 'enabled' : 'disabled'}`);

    console.log('\nProxied services:');
    for (const service of config.credentials.proxiedServices) {
      console.log(`  - ${service}`);
    }

    // Check for stored credentials
    try {
      const store = createCredentialStore({
        backend: config.credentials.backend,
        encryptionPassword: config.credentials.encryptionPassword,
        vaultAddress: config.credentials.vaultAddress,
        vaultToken: config.credentials.vaultToken,
        onePasswordVault: config.credentials.onePasswordVault,
        onePasswordAccount: config.credentials.onePasswordAccount
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

function formatEntry(entry: any): string {
  switch (entry.type) {
    case 'tool_call':
      return `${entry.data.tool} ${JSON.stringify(entry.data.params).slice(0, 80)}`;
    case 'tool_result':
      return `Result for ${entry.data.toolCallId}`;
    case 'credential_access':
      return `${entry.data.service} ${entry.data.operation} ${entry.data.success ? 'OK' : 'FAIL'}`;
    default:
      return JSON.stringify(entry.data).slice(0, 80);
  }
}

// Show help when run without arguments (like openclaw does)
if (process.argv.length <= 2) {
  program.help();
}

program.parseAsync();
