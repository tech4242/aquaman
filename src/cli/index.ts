#!/usr/bin/env node

/**
 * aquaman CLI - Security wrapper for OpenClaw
 */

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { loadConfig, getConfigDir, ensureConfigDir, getDefaultConfig } from '../utils/config.js';
import { AuditLogger, createAuditLogger } from '../audit/logger.js';
import { AlertEngine, createAlertEngine, createRateLimiter } from '../audit/alerting.js';
import { GatewayProxy, createGatewayProxy } from '../proxy/gateway-proxy.js';
import { createCredentialProxy, CredentialProxy } from '../credentials/proxy-daemon.js';
import { createCredentialStore, KeychainStore, MemoryStore } from '../credentials/store.js';
import { createFileControl } from '../permissions/file-control.js';
import { createCommandControl } from '../permissions/command-control.js';
import { createNetworkControl } from '../permissions/network-control.js';
import { createApprovalManager, ApprovalManager } from '../approval/manager.js';
import { createApprovalApi, apiApprove, apiDeny, apiGetPending } from '../approval/api.js';
import {
  backupOpenClawConfig,
  generateProxyModelsConfig,
  writeModelsConfig,
  clearAuthProfiles,
  openclawConfigExists
} from '../utils/openclaw-config.js';
import type { WrapperConfig, ToolCall } from '../types.js';
import { stringify as yamlStringify } from 'yaml';

const APPROVAL_API_PORT = 18791;

const program = new Command();

program
  .name('aquaman')
  .description('Security wrapper for OpenClaw - audit logging, guardrails, and credential isolation')
  .version('0.1.0');

// Start command
program
  .command('start')
  .description('Start OpenClaw with security wrapper')
  .option('-c, --config <path>', 'Path to config file')
  .option('--no-proxy', 'Disable gateway proxy')
  .option('--no-credential-proxy', 'Disable credential proxy')
  .action(async (options) => {
    const config = loadConfig();

    console.log('Starting aquaman security wrapper...\n');

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled
    });
    await auditLogger.initialize();

    // Initialize alert engine
    const alertEngine = createAlertEngine({
      rules: config.audit.alertRules,
      onAlert: (result, toolCall) => {
        if (result.matched) {
          console.log(`[${result.severity.toUpperCase()}] ${result.message}`);
        }
      }
    });

    // Initialize permission controls
    const fileControl = createFileControl({ permissions: config.permissions.files });
    const commandControl = createCommandControl({ permissions: config.permissions.commands });
    const networkControl = createNetworkControl({ permissions: config.permissions.network });

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
      console.log('Note: Using memory store for credentials (keytar not available)');
      credentialStore = new MemoryStore();
    }

    // Start credential proxy if enabled
    let credentialProxy: CredentialProxy | null = null;
    if (options.credentialProxy !== false) {
      credentialProxy = createCredentialProxy({
        port: config.credentials.proxyPort,
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
    }

    // Start gateway proxy if enabled
    let gatewayProxy: GatewayProxy | null = null;
    if (options.proxy !== false) {
      gatewayProxy = createGatewayProxy({
        proxyPort: config.wrapper.proxyPort,
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
    }

    // Start approval API for CLI communication
    const approvalApi = createApprovalApi({
      port: APPROVAL_API_PORT,
      manager: approvalManager
    });
    await approvalApi.start();

    console.log('\nSecurity wrapper ready!');
    console.log(`  Gateway proxy: ${options.proxy !== false ? `127.0.0.1:${config.wrapper.proxyPort}` : 'disabled'}`);
    console.log(`  Credential proxy: ${options.credentialProxy !== false ? `127.0.0.1:${config.credentials.proxyPort}` : 'disabled'}`);
    console.log(`  Approval API: 127.0.0.1:${APPROVAL_API_PORT}`);
    console.log(`  Audit log: ${config.audit.logDir}`);
    console.log('\nPress Ctrl+C to stop.\n');

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down...');
      await approvalApi.stop();
      if (gatewayProxy) await gatewayProxy.stop();
      if (credentialProxy) await credentialProxy.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

// Init command
program
  .command('init')
  .description('Initialize aquaman configuration and configure OpenClaw')
  .option('--force', 'Overwrite existing configuration')
  .option('--skip-openclaw', 'Skip OpenClaw configuration')
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
    console.log(`✓ Created ${configPath}`);

    // Create audit directory
    const auditDir = path.join(getConfigDir(), 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    console.log(`✓ Created ${auditDir}`);

    // Configure OpenClaw to use proxy
    if (!options.skipOpenclaw && openclawConfigExists()) {
      console.log('\nConfiguring OpenClaw to use credential proxy...');

      const backups = backupOpenClawConfig();
      if (backups.models) console.log(`  Backed up: ${backups.models}`);
      if (backups.auth) console.log(`  Backed up: ${backups.auth}`);

      const proxyConfig = generateProxyModelsConfig(config.credentials.proxyPort);
      writeModelsConfig(proxyConfig);
      console.log(`✓ Updated ~/.openclaw/models.json with proxy URLs`);

      clearAuthProfiles();
      console.log(`✓ Cleared ~/.openclaw/auth-profiles.json (credentials now in secure storage)`);
    }

    console.log('\nNext steps:');
    console.log('1. Add your API keys: aquaman credentials add anthropic api_key');
    console.log('2. Start the wrapper:  aquaman start');
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
  .description('Show wrapper status')
  .action(async () => {
    const config = loadConfig();
    console.log('aquaman-clawed status\n');

    console.log('Configuration:');
    console.log(`  Config dir: ${getConfigDir()}`);
    console.log(`  Gateway proxy port: ${config.wrapper.proxyPort}`);
    console.log(`  Upstream port: ${config.wrapper.upstreamPort}`);
    console.log(`  Credential proxy port: ${config.credentials.proxyPort}`);
    console.log(`  Credential backend: ${config.credentials.backend}`);

    console.log('\nAudit:');
    console.log(`  Enabled: ${config.audit.enabled}`);
    console.log(`  Log dir: ${config.audit.logDir}`);
    console.log(`  Alert rules: ${config.audit.alertRules.length}`);

    console.log('\nPermissions:');
    console.log(`  Allowed paths: ${config.permissions.files.allowedPaths.length}`);
    console.log(`  Denied paths: ${config.permissions.files.deniedPaths.length}`);
    console.log(`  Allowed commands: ${config.permissions.commands.allowedCommands.length}`);
    console.log(`  Dangerous patterns: ${config.permissions.commands.dangerousPatterns.length}`);
    console.log(`  Network default: ${config.permissions.network.defaultAction}`);
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
