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
  MemoryStore,
  generateSelfSignedCert,
  type WrapperConfig
} from 'aquaman-core';

import { createCredentialProxy, type CredentialProxy } from '../daemon.js';
import { createServiceRegistry, ServiceRegistry } from '../service-registry.js';
import { createOpenClawIntegration } from '../openclaw/integration.js';
import { stringify as yamlStringify } from 'yaml';

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
  .version('0.1.0');

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
    } catch {
      console.log('Note: Using memory store for credentials');
      credentialStore = new MemoryStore();
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
  .action(async () => {
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
    } catch {
      console.log('Note: Using memory store for credentials');
      credentialStore = new MemoryStore();
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

    // Write PID file
    writePidFile();

    const protocol = credentialProxy.isTlsEnabled() ? 'https' : 'http';
    console.log(`Credential proxy: ${protocol}://${bindAddr}:${config.credentials.proxyPort}`);
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
  .option('--ipc', 'Use IPC instead of HTTP for communication')
  .action(async (options) => {
    const config = loadConfig();
    const port = parseInt(options.port, 10);

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
    } catch {
      credentialStore = new MemoryStore();
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
      tls: config.credentials.tls
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
      backend: config.credentials.backend
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
  .action(async (opts: { config?: string; dryRun?: boolean; overwrite?: boolean }) => {
    const { findOpenClawConfig, migrateFromOpenClaw } = await import('../migration/openclaw-migrator.js');
    const appConfig = loadConfig();

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

program.parse();
