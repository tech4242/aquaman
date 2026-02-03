#!/usr/bin/env node

/**
 * aquaman CLI - Secure sandbox control plane for OpenClaw
 */

import { Command } from 'commander';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { loadConfig, getConfigDir, ensureConfigDir, getDefaultConfig, expandPath } from '../utils/config.js';
import { createAuditLogger } from '../audit/logger.js';
import { createAlertEngine } from '../audit/alerting.js';
import { createGatewayProxy, type GatewayProxy } from '../proxy/gateway-proxy.js';
import { createCredentialProxy, type CredentialProxy } from '../credentials/proxy-daemon.js';
import { createCredentialStore, MemoryStore } from '../credentials/store.js';
import { createApprovalManager } from '../approval/manager.js';
import { createApprovalApi, apiApprove, apiDeny, apiGetPending } from '../approval/api.js';
import { createSandboxOrchestrator } from '../sandbox/orchestrator.js';
import { generateComposeConfig, writeComposeFile } from '../sandbox/compose-generator.js';
import type { WrapperConfig } from '../types.js';
import { stringify as yamlStringify } from 'yaml';

const APPROVAL_API_PORT = 18791;

const program = new Command();

program
  .name('aquaman')
  .description('Secure sandbox control plane for OpenClaw - credential isolation, audit logging, and guardrails')
  .version('0.1.0');

// Start command - launches sandboxed OpenClaw
program
  .command('start')
  .description('Start OpenClaw in a secure sandbox (requires Docker)')
  .option('-w, --workspace <path>', 'Workspace directory to mount')
  .option('--read-only', 'Mount workspace as read-only')
  .option('-i, --image <image>', 'OpenClaw Docker image')
  .option('-d, --detach', 'Run in background')
  .action(async (options) => {
    const config = loadConfig();

    // Override config with CLI options
    if (options.workspace) {
      config.sandbox.workspace.hostPath = expandPath(options.workspace);
    }
    if (options.readOnly) {
      config.sandbox.workspace.readOnly = true;
    }
    if (options.image) {
      config.sandbox.openclawImage = options.image;
    }

    const orchestrator = createSandboxOrchestrator(config);

    console.log('Starting aquaman sandbox...\n');
    console.log('Security guarantees:');
    console.log('  Network isolation: ENABLED (internal Docker network)');
    console.log('  Credential isolation: ENABLED (credentials never in container)');
    console.log('  Audit logging: ENABLED (hash-chained logs)');
    console.log('');
    console.log('Configuration:');
    console.log(`  Workspace: ${config.sandbox.workspace.hostPath}`);
    console.log(`  Read-only: ${config.sandbox.workspace.readOnly}`);
    console.log(`  OpenClaw image: ${config.sandbox.openclawImage}`);
    console.log(`  OpenClaw sandbox mode: ${config.sandbox.enableOpenclawSandbox ? 'enabled' : 'disabled'}`);
    console.log('');

    try {
      await orchestrator.start({ detach: options.detach });

      if (options.detach) {
        console.log('\nSandbox started in background.');
        console.log('Use "aquaman status" to check status.');
        console.log('Use "aquaman logs -f" to follow logs.');
        console.log('Use "aquaman stop" to stop.');
      }
    } catch (error) {
      console.error('\nFailed to start sandbox:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop the sandboxed OpenClaw environment')
  .action(async () => {
    const config = loadConfig();
    const orchestrator = createSandboxOrchestrator(config);

    console.log('Stopping sandbox...');
    try {
      await orchestrator.stop();
      console.log('Sandbox stopped.');
    } catch (error) {
      console.error('Failed to stop:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Logs command
program
  .command('logs')
  .description('View sandbox container logs')
  .option('-f, --follow', 'Follow log output')
  .option('--aquaman', 'Show only aquaman control plane logs')
  .option('--openclaw', 'Show only OpenClaw logs')
  .action(async (options) => {
    const config = loadConfig();
    const orchestrator = createSandboxOrchestrator(config);

    let service: 'aquaman' | 'openclaw' | undefined;
    if (options.aquaman) service = 'aquaman';
    if (options.openclaw) service = 'openclaw';

    await orchestrator.logs(service, options.follow);
  });

// Daemon command (internal - used inside container)
program
  .command('daemon')
  .description('Run the proxy daemon (used internally by container)')
  .action(async () => {
    const config = loadConfig();
    const bindAddress = process.env['AQUAMAN_BIND_ADDRESS'] || '0.0.0.0';

    console.log('Starting aquaman daemon...\n');

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled
    });
    await auditLogger.initialize();

    // Initialize alert engine
    const alertEngine = createAlertEngine({
      rules: config.audit.alertRules,
      onAlert: (result) => {
        if (result.matched) {
          console.log(`[${result.severity.toUpperCase()}] ${result.message}`);
        }
      }
    });

    // Initialize approval manager
    const approvalManager = createApprovalManager({
      channels: config.approval.channels,
      timeout: config.approval.timeout,
      defaultOnTimeout: config.approval.defaultOnTimeout
    });

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = createCredentialStore({ backend: config.credentials.backend });
    } catch {
      console.log('Note: Using memory store for credentials');
      credentialStore = new MemoryStore();
    }

    // Start credential proxy
    const credentialProxy = createCredentialProxy({
      port: config.credentials.proxyPort,
      bindAddress,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
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

    // Start gateway proxy
    const gatewayProxy = createGatewayProxy({
      proxyPort: config.wrapper.proxyPort,
      bindAddress,
      upstreamHost: '127.0.0.1',
      upstreamPort: config.wrapper.upstreamPort,
      auditLogger,
      alertEngine,
      onToolCall: async (toolCall, alertResult) => {
        if (alertResult.requiresApproval) {
          return approvalManager.requestApproval(toolCall, alertResult.message);
        }
        return true;
      }
    });
    await gatewayProxy.start();

    // Start approval API
    const approvalApi = createApprovalApi({
      port: APPROVAL_API_PORT,
      bindAddress,
      manager: approvalManager
    });
    await approvalApi.start();

    console.log('\nDaemon ready!');
    console.log(`  Gateway proxy: ${bindAddress}:${config.wrapper.proxyPort}`);
    console.log(`  Credential proxy: ${bindAddress}:${config.credentials.proxyPort}`);
    console.log(`  Approval API: ${bindAddress}:${APPROVAL_API_PORT}`);

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down daemon...');
      await approvalApi.stop();
      await gatewayProxy.stop();
      await credentialProxy.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Generate compose file command
program
  .command('generate-compose')
  .description('Generate docker-compose.yml without starting')
  .option('-o, --output <path>', 'Output path', './docker-compose.yml')
  .action(async (options) => {
    const config = loadConfig();
    const composeConfig = generateComposeConfig(config);
    writeComposeFile(composeConfig, options.output);

    console.log(`Generated: ${options.output}`);
    console.log('\nTo start manually:');
    console.log('  docker compose up -d');
  });

// Init command - simplified for sandbox-only mode
program
  .command('init')
  .description('Initialize aquaman configuration')
  .option('--force', 'Overwrite existing configuration')
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

    console.log('\nNext steps:');
    console.log('1. Add your API keys: aquaman credentials add anthropic api_key');
    console.log('2. Start the sandbox:  aquaman start');
  });

// Audit commands
const audit = program.command('audit').description('Audit log management');

audit
  .command('tail')
  .description('Show recent audit entries')
  .option('-n, --lines <count>', 'Number of lines', '20')
  .option('-f, --follow', 'Follow mode (not implemented)')
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
      console.log('✓ Audit log integrity verified');
      const stats = auditLogger.getStats();
      console.log(`  Entries: ${stats.entryCount}`);
      console.log(`  Last hash: ${stats.lastHash.slice(0, 16)}...`);
    } else {
      console.log('✗ Audit log integrity FAILED');
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
  .action(async (service: string, key: string) => {
    const config = loadConfig();
    let store;
    try {
      store = createCredentialStore({ backend: config.credentials.backend });
    } catch {
      console.error('Credential store not available. Install keytar: npm install keytar');
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
      store = createCredentialStore({ backend: config.credentials.backend });
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
      store = createCredentialStore({ backend: config.credentials.backend });
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
  .command('revoke')
  .description('Revoke all credentials')
  .option('--all', 'Revoke all credentials')
  .action(async (options) => {
    if (!options.all) {
      console.log('Use --all to revoke all credentials');
      return;
    }

    const config = loadConfig();
    let store;
    try {
      store = createCredentialStore({ backend: config.credentials.backend });
    } catch {
      console.error('Credential store not available.');
      process.exit(1);
    }

    const creds = await store.list();
    for (const cred of creds) {
      await store.delete(cred.service, cred.key);
    }
    console.log(`Revoked ${creds.length} credentials`);
  });

// Approval commands
program
  .command('approve <request-id>')
  .description('Approve a pending request')
  .action(async (requestId: string) => {
    const success = await apiApprove(APPROVAL_API_PORT, requestId);
    if (success) {
      console.log(`✓ Approved: ${requestId}`);
    } else {
      console.log(`✗ Failed - request not found or daemon not running`);
      process.exit(1);
    }
  });

program
  .command('deny <request-id>')
  .description('Deny a pending request')
  .action(async (requestId: string) => {
    const success = await apiDeny(APPROVAL_API_PORT, requestId);
    if (success) {
      console.log(`✓ Denied: ${requestId}`);
    } else {
      console.log(`✗ Failed - request not found or daemon not running`);
      process.exit(1);
    }
  });

program
  .command('pending')
  .description('List pending approval requests')
  .action(async () => {
    try {
      const pending = await apiGetPending(APPROVAL_API_PORT);
      if (pending.length === 0) {
        console.log('No pending requests.');
        return;
      }
      console.log('Pending approval requests:\n');
      for (const req of pending as any[]) {
        console.log(`  ID: ${req.id}`);
        console.log(`  Tool: ${req.toolCall?.tool}`);
        console.log(`  Reason: ${req.reason}`);
        console.log('');
      }
    } catch {
      console.log('Daemon not running. Start with: aquaman start');
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Show sandbox status')
  .action(async () => {
    const config = loadConfig();
    const orchestrator = createSandboxOrchestrator(config);

    console.log('aquaman-clawed status\n');

    // Get container status
    const status = await orchestrator.getStatus();

    const statusIcon = (s: string) => {
      switch (s) {
        case 'running': return '\x1b[32m●\x1b[0m'; // green
        case 'stopped': return '\x1b[31m○\x1b[0m'; // red
        case 'starting': return '\x1b[33m◐\x1b[0m'; // yellow
        case 'unhealthy': return '\x1b[33m●\x1b[0m'; // yellow
        default: return '\x1b[90m?\x1b[0m'; // gray
      }
    };

    console.log('Sandbox:');
    console.log(`  ${statusIcon(status.aquaman)} Control plane: ${status.aquaman}`);
    console.log(`  ${statusIcon(status.openclaw)} OpenClaw: ${status.openclaw}`);
    console.log(`  Network: ${status.network}`);

    console.log('\nConfiguration:');
    console.log(`  Config dir: ${getConfigDir()}`);
    console.log(`  OpenClaw image: ${config.sandbox.openclawImage}`);
    console.log(`  Workspace: ${config.sandbox.workspace.hostPath}`);
    console.log(`  Read-only: ${config.sandbox.workspace.readOnly}`);
    console.log(`  Credential backend: ${config.credentials.backend}`);

    console.log('\nSecurity:');
    console.log(`  Network isolation: enabled (internal Docker network)`);
    console.log(`  Credential isolation: enabled (never in container)`);
    console.log(`  OpenClaw sandbox: ${config.sandbox.enableOpenclawSandbox ? 'enabled' : 'disabled'}`);
    console.log(`  Audit logging: ${config.audit.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Alert rules: ${config.audit.alertRules.length}`);
  });

function formatEntry(entry: any): string {
  switch (entry.type) {
    case 'tool_call':
      return `${entry.data.tool} ${JSON.stringify(entry.data.params).slice(0, 80)}`;
    case 'tool_result':
      return `Result for ${entry.data.toolCallId}`;
    case 'policy_violation':
      return `[${entry.data.severity}] ${entry.data.reason}`;
    case 'approval_request':
      return `[${entry.data.status}] ${entry.data.reason}`;
    case 'credential_access':
      return `${entry.data.service} ${entry.data.operation} ${entry.data.success ? '✓' : '✗'}`;
    default:
      return JSON.stringify(entry.data).slice(0, 80);
  }
}

program.parse();
