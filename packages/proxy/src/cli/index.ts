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
import { randomBytes } from 'node:crypto';

import {
  loadConfig,
  loadStoredConfig,
  getConfigDir,
  getConfigPath,
  ensureConfigDir,
  getDefaultConfig,
  expandPath,
  createAuditLogger,
  createCredentialStore,
  validatePasswordStrength,
  saveConfig,
  generateLoopbackToken,
  DEFAULT_LOOPBACK_PORT,
  wrapWithCache,
  resolveCacheTtl,
  createCredentialLinker,
  isVaultLocked,
  type CredentialStore,
  type CredentialStoreOptions,
  type WrapperConfig
} from '../core/index.js';
import { registerLinkCommands, refuseIfLinked, listedCredential, reportLinks, checkRequestLocator } from './links.js';

import { fileURLToPath } from 'node:url';

import { createCredentialProxy, SocketPathError } from '../daemon.js';
import { createServiceRegistry, ServiceRegistry } from '../service-registry.js';
import { createOpenClawIntegration, authProfilesAreSqliteOnly, legacyAuthProfilesBlockProviders, pluginInstallNeedsCapabilityConsent, pluginProvenanceIsReported } from '../openclaw/integration.js';
import { supportsSecretRefIntegrations, wireSecretRefProviders, secretRefWiringStatus } from '../openclaw/secretref.js';
import { openclawPaths, openclawProfileArgs, isOpenClawProfileName, configMergePatch, applyOpenClawPatch, type OpenClawWriteResult } from '../openclaw/config-file.js';
import {
  CHANNEL_ROUTING_SUPPORTED,
  wireChannelRouting,
  channelRoutingStatus,
  type ChannelSkipReason
} from '../openclaw/channel-routing.js';
import { createHermesIntegration, detectHermes, type HermesIntegration, type HermesApplyResult } from '../hermes/integration.js';
import { managedScopeShadowedKeys, hermesManagedEnvPath, HERMES_SUPPORTED_SERVICES, hermesSecretSourceRefs, hermesEnvWiring, hermesEnvOpenToOthers, isHermesProfileName, HERMES_CONFIG_SET_ENV_MIN } from '../hermes/config-writer.js';
import { createBrokerScope, parseAquamanRef, formatAquamanRef, defaultProjectsPath, isReservedService, RESERVED_SERVICE_REASON, type BrokerScope } from '../broker-scope.js';
import { startAuditAnchor } from '../audit-anchor.js';
import { auditVerifyCommand, auditAcceptCommand } from './audit-commands.js';
import { routableKeys, routeKeyMismatch } from '../route-auth.js';
import { createNativePrompter, clampPromptTimeout, PROMPT_TIMEOUT_SECONDS, PROMPT_TIMEOUT_MIN_SECONDS, PROMPT_TIMEOUT_MAX_SECONDS } from '../credential-prompt.js';
import { registerUnlockCommands } from './unlock.js';
import { registerServiceCommands, loginItemForInit, loginItemPresent, type ServiceCliHelpers } from './service.js';
import { loadPolicyFromConfig, validatePolicyConfig, lintPolicyConfig, getDefaultPolicyPresets, matchPolicy, type ServicePolicy } from '../request-policy.js';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

// Read version from package.json (single source of truth)
const __cliFilename = fileURLToPath(import.meta.url);
const __cliDirname = path.dirname(__cliFilename);
const pkgJson = JSON.parse(fs.readFileSync(path.resolve(__cliDirname, '../../package.json'), 'utf-8'));
const VERSION: string = pkgJson.version;

// ANSI color helpers: the aqua of the website and the banner
// Respects NO_COLOR (https://no-color.org/) and disables in piped/redirected output
const noColor = process.env['NO_COLOR'] !== undefined ||
                (!process.stdout.isTTY && process.env['FORCE_COLOR'] === undefined);
const aqua = (s: string) => noColor ? s : `\x1b[38;2;63;193;192m${s}\x1b[0m`;

// Credential name validation — shared pattern from daemon.ts and systemd-creds backend
const SAFE_CRED_NAME = /^[a-z0-9][a-z0-9._-]*$/;
function validateCredName(label: string, value: string): void {
  if (!SAFE_CRED_NAME.test(value)) {
    console.error(`Invalid ${label}: "${value}". Allowed: lowercase alphanumeric, dots, hyphens, underscores.`);
    process.exit(1);
  }
  if (label === 'service' && isReservedService(value)) {
    console.error(`"${value}" ${RESERVED_SERVICE_REASON}.`);
    console.error('Use a different service name. To check the audit log against its anchor, run: aquaman audit verify');
    process.exit(1);
  }
}

/**
 * What the vault holds for the user. aquaman's own records (the audit
 * anchor) are stored there too, and are not credentials: they are not
 * listed, counted, or taken as a sign that a credential has been stored.
 */
async function listCredentials(store: { list(): Promise<Array<{ service: string; key: string }>> }): Promise<Array<{ service: string; key: string }>> {
  return (await store.list()).filter((cred) => !isReservedService(cred.service));
}

/**
 * Soft hint for 1Password users running in biometric/desktop-app mode: every
 * `op` spawn prompts, which makes unattended agents unusable. The daemon cache
 * (v0.13.1+) bounds it to one prompt per TTL per credential; a service account
 * removes prompts entirely. Printed by `aquaman doctor` and deep doctors.
 */
function printOnePasswordModeHint(config: WrapperConfig, indent = '    '): void {
  if (config.credentials.backend !== '1password') return;
  if (process.env['OP_SERVICE_ACCOUNT_TOKEN'] || process.env['OP_CONNECT_HOST']) return;
  const vault = config.credentials.onePasswordVault || 'aquaman';
  const ttl = resolveCacheTtl(config);
  const cacheNote = ttl > 0
    ? `the daemon cache bounds this to one per ${Math.round(ttl / 60)} min per credential`
    : 'and the credential cache is disabled (cacheTtlSeconds: 0)';
  console.log(`${indent}• 1Password is in biometric/desktop-app mode — each vault read prompts (${cacheNote}).`);
  console.log(`${indent}  For zero prompts, create a service account scoped to the "${vault}" vault (create the`);
  console.log(`${indent}  vault + credentials as a human first, or grant write_items) and start the daemon with`);
  console.log(`${indent}  OP_SERVICE_ACCOUNT_TOKEN. If OP_CONNECT_HOST/OP_CONNECT_TOKEN are set they take precedence.`);
}

/**
 * For a process that serves credentials: write an audit entry when a link to
 * a vault item appears, goes away or is re-pointed while it runs, whoever
 * changed `credentials.links`. A link decides which vault item a reference is
 * read from, so the change belongs in the same log as the reads.
 */
function recordLinkChange(logger: () => ReturnType<typeof createAuditLogger>): (change: { name: string; locator?: string }) => void {
  return (change) => {
    const service = change.name.split('/')[0];
    logger().logCredentialAccess('system', 'system', {
      service,
      operation: 'rotate',
      success: true,
      note: change.locator === undefined
        ? `link removed: ${change.name}`
        : `link set: ${change.name} is read from ${change.locator}`,
    }).catch((err: unknown) => {
      console.error(`AUDIT FAILURE: could not record a link change for ${change.name}: ${err instanceof Error ? err.message : err}`);
    });
  };
}

/**
 * Map config.credentials onto CredentialStoreOptions — the single source for
 * every createCredentialStore() call in this CLI. Env fallbacks mirror
 * applyEnvOverrides() (belt and braces for callers that build partial configs).
 */
function storeOptionsFromConfig(config: WrapperConfig): CredentialStoreOptions {
  return {
    backend: config.credentials.backend,
    encryptionPassword: config.credentials.encryptionPassword || process.env['AQUAMAN_ENCRYPTION_PASSWORD'] || process.env['AQUAMAN_KEEPASS_PASSWORD'],
    vaultAddress: config.credentials.vaultAddress || process.env['VAULT_ADDR'],
    vaultToken: config.credentials.vaultToken || process.env['VAULT_TOKEN'],
    vaultNamespace: config.credentials.vaultNamespace,
    vaultMountPath: config.credentials.vaultMountPath,
    onePasswordVault: config.credentials.onePasswordVault,
    onePasswordAccount: config.credentials.onePasswordAccount,
    keepassxcDatabasePath: config.credentials.keepassxcDatabasePath,
    keepassxcKeyFilePath: config.credentials.keepassxcKeyFilePath,
    bitwardenFolder: config.credentials.bitwardenFolder,
    bitwardenOrganizationId: config.credentials.bitwardenOrganizationId,
    bitwardenCollectionId: config.credentials.bitwardenCollectionId,
    keeperFolderUid: config.credentials.keeperFolderUid,
    keeperConfigPath: config.credentials.keeperConfigPath,
    // A daemon outlives the config it started with, so a link made later has to reach it.
    links: 'always'
  };
}

/**
 * The audit operation for what a proxy reports: a broker resolve hands the
 * value out (`read`); a credential request, a login-item approval and a vault
 * session taken or dropped change what the proxy holds (`rotate`); everything
 * else injects a credential (`use`).
 */
function auditOperation(method: string): 'read' | 'rotate' | 'use' {
  if (method === 'BROKER') return 'read';
  // A broker request stores or declares a credential; the rest are a person's decisions too.
  if (method === 'BROKER_REQUEST' || method === 'SERVICE_CONSENT' || method === 'VAULT_UNLOCK' || method === 'VAULT_LOCK') return 'rotate';
  return 'use';
}

/** What a serving process prints at start when its vault needs a person's session. */
function reportVaultState(store: { vaultState?(): string }): void {
  if (store.vaultState?.() === 'locked') {
    console.log('Vault: locked. Requests that need a credential answer vault_locked until a person runs: aquaman unlock');
  }
}

/**
 * Build loopback listener options from config for the daemon. Returns undefined
 * unless the loopback listener is explicitly enabled. If it's enabled but no
 * token is configured we refuse to start the listener (an unauthenticated
 * loopback proxy would be an open credential gateway for any local process) and
 * print how to fix it — the UDS proxy still starts normally.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function loadLoopbackOptions(config: WrapperConfig): { port: number; token: string; host?: string } | undefined {
  const lb = config.loopback;
  if (!lb?.enabled) return undefined;
  if (!lb.token) {
    console.error('Loopback listener is enabled but no token is set — refusing to start it (would be unauthenticated).');
    console.error('Fix: run `aquaman hermes setup` to generate one, or set AQUAMAN_LOOPBACK_TOKEN.');
    return undefined;
  }
  const host = lb.host || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    console.error(`Loopback listener host "${host}" is not a loopback address — refusing to start it (it would be reachable from other machines).`);
    console.error('Fix: set loopback.host to 127.0.0.1 in config.yaml.');
    return undefined;
  }
  return { port: lb.port || DEFAULT_LOOPBACK_PORT, token: lb.token, host };
}

/** Broker scope for `aquaman daemon`, or undefined when `broker.enabled: false`. */
function daemonBrokerScope(config: WrapperConfig, store?: Pick<CredentialStore, 'itemIdentity'>): BrokerScope | undefined {
  if (config.broker?.enabled === false) return undefined;
  return createBrokerScope({
    configPath: getConfigPath(),
    loopbackDeniedServices: HERMES_SUPPORTED_SERVICES,
    // So the isolated tier holds for every name one of its items can have.
    itemIdentity: store ? (service, key) => store.itemIdentity?.(service, key) : undefined,
  });
}

/**
 * Add or remove refs in config.yaml `broker.allowedRefs`. Edits the raw file
 * (not loadConfig + saveConfig) so env overrides such as the loopback token
 * are never persisted as a side effect. The daemon re-reads the list on change.
 */
/**
 * Add or remove refs in `broker.allowedRefs`, editing the raw config file so
 * values that only exist as environment overrides are never written back.
 * Returns the raw config as written.
 */
function writeBrokerAllowedRefs(refs: string[], mode: 'allow' | 'revoke'): Record<string, any> {
  ensureConfigDir();
  const configPath = getConfigPath();
  let raw: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    const parsed = yamlParse(fs.readFileSync(configPath, 'utf-8'));
    if (parsed && typeof parsed === 'object') raw = parsed;
  }
  const current = new Set<string>(Array.isArray(raw.broker?.allowedRefs) ? raw.broker.allowedRefs : []);
  for (const ref of refs) {
    if (mode === 'allow') current.add(ref);
    else current.delete(ref);
  }
  raw.broker = { ...(raw.broker && typeof raw.broker === 'object' ? raw.broker : {}), allowedRefs: [...current].sort() };
  fs.writeFileSync(configPath, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600 });
  return raw;
}

function updateBrokerAllowedRefs(refs: string[], mode: 'allow' | 'revoke'): void {
  const invalid = refs.filter(r => !parseAquamanRef(r));
  if (invalid.length > 0) {
    console.error(`Invalid ref${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`);
    console.error('Refs look like aquaman://<service>/<key>, e.g. aquaman://github/token');
    process.exit(1);
  }
  const reserved = refs.filter(r => isReservedService(parseAquamanRef(r)!.service));
  if (reserved.length > 0) {
    console.error(`Not declared: ${reserved.join(', ')}. "${parseAquamanRef(reserved[0])!.service}" ${RESERVED_SERVICE_REASON}.`);
    console.error('Use a different service name. To check the audit log against its anchor, run: aquaman audit verify');
    process.exit(1);
  }

  const raw = writeBrokerAllowedRefs(refs, mode);

  const verb = mode === 'allow' ? 'Allowed' : 'Revoked';
  for (const ref of refs) console.log(`${verb}: ${ref}`);
  if (mode === 'allow') {
    console.log('\nAny process running as you can now fetch these values from `aquaman daemon`. Only allow refs you intend to materialize.');
  }
  if (raw.broker.enabled === false) {
    console.log('Note: broker.enabled is false in config.yaml, so the broker is off regardless.');
  }
}

/**
 * `POST /broker/resolve` against the running daemon over UDS. Always goes
 * through the daemon (never the vault directly), so `aquaman get` is
 * scope-checked and audited exactly like a coding-agent or Hermes resolve.
 */
function brokerResolve(
  socketPath: string,
  service: string,
  key: string,
  timeoutMs: number,
): Promise<{ value: string } | { error: string; fix?: string; code?: string }> {
  const body = JSON.stringify({ service, key });
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: '/broker/resolve',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let payload = '';
        res.on('data', (chunk) => { payload += chunk; });
        res.on('end', () => {
          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            resolve({ error: `Proxy returned a non-JSON response (HTTP ${res.statusCode})` });
            return;
          }
          if (res.statusCode === 200 && typeof json.value === 'string') {
            resolve({ value: json.value });
          } else {
            resolve({ error: json.error || `Broker error (HTTP ${res.statusCode})`, fix: json.fix, code: json.code });
          }
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        resolve({ error: `Cannot reach the aquaman proxy at ${socketPath}`, fix: 'Start it with: aquaman init --agent <agent> --no-hooks  (or, in a terminal of your own: aquaman daemon)', code: 'proxy_unreachable' });
      } else if (err.code === 'EPERM' || err.code === 'EACCES') {
        resolve({ error: `Connecting to ${socketPath} was denied (${err.code})`, fix: 'If this runs inside a sandbox, allowlist the socket; otherwise check its owner and 0600 mode', code: 'socket_blocked' });
      } else {
        resolve({ error: err.message });
      }
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: `Broker request timed out after ${timeoutMs}ms`, fix: 'A vault that prompts (e.g. 1Password biometrics) may need longer: pass --timeout <ms>' });
    });
    req.end(body);
  });
}

function describeBroker(scope: BrokerScope | undefined): string {
  if (!scope) return 'disabled (broker.enabled: false)';
  const n = scope.declared().length;
  return `${n} declared ref${n === 1 ? '' : 's'} (see: aquaman broker list)`;
}

/**
 * Probe the loopback listener's /_health endpoint (no token required). Returns
 * true if it responds 200 within a short timeout, false otherwise.
 */
function probeLoopbackHealth(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/_health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// PID file management
const getPidFile = () => path.join(getConfigDir(), 'daemon.pid');

const writePidFile = () => {
  const pidFile = getPidFile();
  fs.writeFileSync(pidFile, process.pid.toString(), { encoding: 'utf-8', mode: 0o600 });
  // The mode above applies only when the file is created.
  fs.chmodSync(pidFile, 0o600);
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

/**
 * Read one line typed at a terminal without showing it. The terminal is put
 * in raw mode and stdin is read directly: a readline interface must not be
 * attached while a secret is typed, because on a terminal it echoes each key.
 * Enter submits, DEL/^H rubs out one character, Ctrl-C exits the process with
 * `interruptExitCode`.
 */
function readHiddenTtyLine(interruptExitCode: number): Promise<string> {
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
          process.exit(interruptExitCode);
        } else {
          value += char;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * Ask for a secret during setup. On a terminal the answer is read hidden
 * (readHiddenTtyLine); from a pipe it is read as a plain line.
 */
async function promptSecretInput(prompt: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write(prompt);
    return (await readHiddenTtyLine(0)).trim();
  }

  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** One-line explanation of why `openclaw setup` left a channel alone. */
function describeChannelSkip(reason: ChannelSkipReason, channel: string): string {
  switch (reason) {
    case 'no-vault-credential':
      return `no credential in the vault (add it: aquaman credentials add ${channel} bot_token)`;
    case 'user-endpoint':
      return 'it already points at your own endpoint (self-hosted Bot API or regional proxy)';
    case 'token-file':
      return 'its token comes from tokenFile, whose precedence over a config token we will not guess at';
    case 'multi-account':
      return 'multi-account channels need one vault entry per account, which the service model has no room for yet';
    case 'not-wired':
      return 'routable but not wired yet (re-run: aquaman openclaw setup)';
    case 'unroutable':
      return 'this OpenClaw has no per-channel endpoint override in its config for it, so aquaman does not route its traffic';
  }
}

const program = new Command();

program
  .name('aquaman')
  .description('Credential broker for AI agents: vault, daemon, audit and policy, with the OpenClaw, coding-agent, Hermes, OpenShell and Agent Substrate integrations')
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
      lines.push(`  \u{1F419} ${aqua('aquaman')} ${VERSION}: credential broker for AI agents`);
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
      const vaultCore = ['setup', 'doctor', 'status', 'daemon', 'stop', 'service', 'unlock', 'lock', 'init', 'request'];
      for (const name of vaultCore) {
        const c = byName.get(name);
        if (c) lines.push(renderCmd(c));
      }
      lines.push('');
      lines.push(aqua('Vault management'));
      for (const name of ['credentials', 'get', 'broker', 'audit', 'services', 'policy']) {
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
        lines.push(aqua('AI coding-agent integration (Claude Code, Codex)'));
        const coderSubs: Array<[string, string]> = [
          ['coder init --agent <agent>', 'Project + hooks + skill for the current directory, no prompts'],
          ['coder setup <agent>', 'Install hooks for an agent (claude-code, codex)'],
          ['coder bind NAME=<ref>', 'Bind an env var to a reference for the current project'],
          ['coder doctor', 'Deep diagnostic \u2014 projects, broker, per-project vault'],
          ['coder status', 'Configured projects + hook wiring + broker activity'],
          ['coder project list/add/remove', 'Manage ~/.aquaman/projects.yaml'],
          ['coder exec <cmd>', 'Run command with project env injected + output redacted'],
        ];
        for (const [term, desc] of coderSubs) {
          lines.push(renderRow(term, desc));
        }
        lines.push(`  ${'(delegates to the aquaman-coder binary; install: npm install -g aquaman-coder)'}`);
        lines.push('');
      }

      // --- Hermes namespace (nested) ---
      const hm = byName.get('hermes');
      if (hm) {
        lines.push(aqua('Hermes integration'));
        const hmOrder = ['setup', 'doctor', 'status', 'configure'];
        const hmSubs = helper.visibleCommands(hm).filter((s: any) => s.name() !== 'help');
        const hmSorted = [
          ...hmOrder.map((n) => hmSubs.find((s: any) => s.name() === n)).filter(Boolean),
          ...hmSubs.filter((s: any) => !hmOrder.includes(s.name())),
        ];
        for (const sub of hmSorted) {
          lines.push(renderRow(`hermes ${sub!.name()}`, sub!.description() || ''));
        }
        lines.push('');
      }

      const os_ = byName.get('openshell');
      if (os_) {
        lines.push(aqua('NVIDIA OpenShell integration'));
        for (const sub of helper.visibleCommands(os_).filter((s: any) => s.name() !== 'help')) {
          lines.push(renderRow(`openshell ${sub.name()}`, sub.description() || ''));
        }
        lines.push('');
      }

      const substrate_ = byName.get('substrate');
      if (substrate_) {
        lines.push(aqua('Agent Substrate integration'));
        for (const sub of helper.visibleCommands(substrate_).filter((s: any) => s.name() !== 'help')) {
          lines.push(renderRow(`substrate ${sub.name()}`, sub.description() || ''));
        }
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
  .option('--backend <backend>', 'Credential backend (keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden, keeper)')
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
    const openclawStateDir = openclawPaths().stateDir;
    let issues = 0;

    console.log('');
    console.log(`  \u{1F419} aquaman ${VERSION} \u2014 health check`);
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
        const store = await createCredentialStore(storeOptionsFromConfig(config));
        const creds = await listCredentials(store);
        console.log(`    \u2713 ${config.credentials.backend} backend (${creds.length} credential${creds.length !== 1 ? 's' : ''})`);
        printOnePasswordModeHint(config);
        issues += reportLinks(config.credentials.backend);
      } catch (err) {
        if (isVaultLocked(err)) {
          // This command reads the vault itself and has no session. The
          // daemon holds its own; whether that one works is reported below.
          console.log('    \u2022 Vault: locked in this shell, so credentials are not listed here');
          console.log('      The daemon keeps its own session (see the proxy lines below). For commands in this shell: export BW_SESSION=$(bw unlock --raw)');
          console.log('      and then `aquaman unlock` in the same shell: a new `bw unlock` ends the session the daemon holds.');
        } else {
          console.log(`    \u2717 Backend not accessible: ${(err as Error).message}`);
          console.log('      \u2192 Run: aquaman setup');
          issues++;
        }
      }

      // Vault \u2014 proxy running
      const sockPath = path.join(configDir, 'proxy.sock');
      try {
        const vault = await new Promise<unknown>((resolve, reject) => {
          const req = http.request({ socketPath: sockPath, path: '/_health', method: 'GET' }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
              if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
              try { resolve(JSON.parse(text).vault); } catch { resolve(undefined); }
            });
          });
          req.on('error', reject);
          req.end();
        });
        console.log(`    \u2713 Proxy running on socket`);
        if (vault === 'locked') {
          console.log('    \u2717 The daemon\'s vault is locked: requests that need a credential answer vault_locked');
          console.log('      \u2192 Run in a terminal: aquaman unlock');
          issues++;
        } else if (vault === 'unlocked') {
          console.log('    \u2713 The daemon\'s vault is unlocked (session in memory only)');
        }
      } catch {
        console.log(`    \u2717 Proxy not running`);
        console.log('      \u2192 Run: aquaman daemon &');
        issues++;
      }
      // Informational: never counted as an issue.
      console.log(loginItemPresent()
        ? '    \u2022 Daemon starts at login (details: aquaman service status)'
        : '    \u2022 Daemon does not start at login (to change that: aquaman service install)');
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

    // Hermes integration
    const hermesStateDir = process.env['HERMES_HOME'] || path.join(os.homedir(), '.hermes');
    let hermesDetected = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('which hermes', { stdio: 'pipe' });
      hermesDetected = true;
    } catch { /* */ }
    if (!hermesDetected) hermesDetected = fs.existsSync(hermesStateDir);

    console.log('');
    console.log(`  ${aqua('Hermes integration')}`);
    if (!hermesDetected) {
      console.log(`    \u2022 not detected (skipping \u2014 only relevant if you run the Hermes agent host)`);
    } else {
      let loopbackEnabled = false;
      try { loopbackEnabled = loadConfig().loopback?.enabled === true; } catch { /* */ }
      if (loopbackEnabled) {
        console.log(`    \u2713 loopback listener enabled   (deep: ${aqua('aquaman hermes doctor')})`);
      } else {
        console.log(`    \u2022 not configured`);
        console.log(`      Isolate Hermes' provider keys via an opt-in loopback listener.`);
        console.log(`      Run: ${aqua('aquaman hermes setup')}`);
      }
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
    console.log(`  \u{1F419} ${aqua('aquaman')} ${VERSION} — status`);
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
      // Reported only by a proxy whose backend a person unlocks (bitwarden).
      if (health.vault === 'locked') proxyLine += `\n  ${aqua('Vault:')} locked  (run in a terminal: aquaman unlock)`;
      else if (health.vault === 'unlocked') proxyLine += `\n  ${aqua('Vault:')} unlocked  (the daemon holds a session in memory; to drop it: aquaman lock)`;
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

  if (!opts.quiet) console.log('\n  \u{1F419} Vault setup\n');

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
  const validBackends = ['keychain', 'encrypted-file', 'keepassxc', '1password', 'vault', 'systemd-creds', 'bitwarden', 'keeper'];
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
  // `config` is what gets written: the file as stored, plus what this wizard
  // decides. Values that exist only as environment overrides (the encryption
  // password, a Vault token, a loopback token, ...) must not reach the file,
  // so it never starts from loadConfig().
  const config = loadStoredConfig();
  config.credentials.backend = backend as any;
  if (backend === 'keeper' && process.env['AQUAMAN_KEEPER_FOLDER_UID']) {
    config.credentials.keeperFolderUid = process.env['AQUAMAN_KEEPER_FOLDER_UID'];
  }
  saveConfig(config);
  // The store is opened with the environment applied, like every other command.
  const runtimeConfig = loadConfig();
  runtimeConfig.credentials.backend = backend as any;

  const auditDir = path.join(configDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });

  let store: import('../core/index.js').CredentialStore;
  try {
    store = await createCredentialStore(storeOptionsFromConfig(runtimeConfig));
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
    const anth = await promptSecretInput('  ? Anthropic API key (or Enter to skip): ');
    if (anth) { await store.set('anthropic', 'api_key', anth); storedServices.push('anthropic'); console.log('    \u2713 anthropic/api_key\n'); }
    const op = await promptSecretInput('  ? OpenAI API key (or Enter to skip): ');
    if (op) { await store.set('openai', 'api_key', op); storedServices.push('openai'); console.log('    \u2713 openai/api_key\n'); }
  }

  if (opts.policy && storedServices.length > 0) {
    const presets = getDefaultPolicyPresets();
    const policyToApply: Record<string, any> = {};
    for (const svc of storedServices) {
      if (presets[svc]) policyToApply[svc] = presets[svc];
    }
    if (Object.keys(policyToApply).length > 0) {
      // A preset fills in a service that has no policy; a policy already in
      // the file is the user's and is kept.
      config.policy = { ...policyToApply, ...config.policy };
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
      enabled: config.audit.enabled,
      maxArchives: auditMaxArchives(config),
    });
    await auditLogger.initialize();

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = wrapWithCache(await createCredentialStore({ ...storeOptionsFromConfig(config), serving: true, onLinkChange: recordLinkChange(() => auditLogger) }), resolveCacheTtl(config));
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
    // No `broker`: this proxy fronts OpenClaw, and the OpenClaw path never
    // hands credential values out (v0.15.0; see broker-scope.ts).
    // Set once the audit anchor exists; called when `aquaman unlock` opened the vault.
    const vaultOpened = { run: (): void => {} };
    const credentialProxy = createCredentialProxy({
      socketPath,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      policyConfig,
      loopback: loadLoopbackOptions(config),
      onVaultUnlocked: () => vaultOpened.run(),
      // Returned, so the proxy knows whether the entry was written.
      onRequest: (info) => {
        return auditLogger.logCredentialAccess('system', 'system', {
          service: info.service,
          operation: auditOperation(info.method),
          success: !info.error,
          error: info.error
        });
      }
    });
    await startProxyOrExit(credentialProxy);
    const auditAnchor = startAuditAnchor(config, auditLogger, credentialStore);
    vaultOpened.run = () => { void auditAnchor.recheck(); };

    console.log(`Credential proxy started on ${socketPath}`);
    reportVaultState(credentialStore);

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
          await auditAnchor.stop();
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
      await auditAnchor.stop();
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
    // A pid file can outlive its daemon (a crash, a power loss), and after a
    // reboot its number may belong to some other process. Only a proxy that
    // answers on the socket with that pid counts as the daemon still running;
    // otherwise a daemon started at login would refuse to start for good.
    const existingPid = readPidFile();
    const socketPath = path.join(getConfigDir(), 'proxy.sock');
    if (existingPid && isProcessRunning(existingPid) && (await proxyPid(socketPath)) === existingPid) {
      console.error(`Daemon is already running (PID ${existingPid}). Use 'aquaman stop' first.`);
      process.exit(1);
    }

    const config = loadConfig();

    console.log('Starting aquaman credential proxy daemon...\n');

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled,
      maxArchives: auditMaxArchives(config),
    });
    await auditLogger.initialize();

    // Initialize credential store
    let credentialStore;
    try {
      credentialStore = wrapWithCache(await createCredentialStore({ ...storeOptionsFromConfig(config), serving: true, onLinkChange: recordLinkChange(() => auditLogger) }), resolveCacheTtl(config));
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const policyConfig2 = loadPolicyFromConfig(config);
    // The daemon is the only proxy that serves the credential broker, and only
    // for declared refs (projects.yaml + broker.allowedRefs). Over loopback the
    // Hermes LLM-provider keys are never materialized.
    const brokerScope = daemonBrokerScope(config, credentialStore);
    // Set once the audit anchor exists; called when `aquaman unlock` opened the vault.
    const vaultOpened = { run: (): void => {} };
    const credentialProxy = createCredentialProxy({
      socketPath,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      policyConfig: policyConfig2,
      loopback: loadLoopbackOptions(config),
      onVaultUnlocked: () => vaultOpened.run(),
      broker: brokerScope,
      // `aquaman request`: the human supplies or approves a credential in a
      // dialog this daemon shows. Off when the broker is off.
      credentialRequests: brokerScope
        ? {
            prompter: createNativePrompter(),
            declare: (service, key) => { writeBrokerAllowedRefs([formatAquamanRef(service, key)], 'allow'); },
            links: createCredentialLinker({ store: credentialStore, backend: config.credentials.backend, configPath: getConfigPath() }),
          }
        : undefined,
      // Returned, so the proxy knows whether the entry was written.
      onRequest: (info) => {
        return auditLogger.logCredentialAccess('system', 'system', {
          service: info.service,
          operation: auditOperation(info.method),
          success: !info.error,
          error: info.error
        });
      }
    });
    await startProxyOrExit(credentialProxy);
    const auditAnchor = startAuditAnchor(config, auditLogger, credentialStore);
    vaultOpened.run = () => { void auditAnchor.recheck(); };

    // OpenShell external credential driver (v0.17.0+). Opt-in; a failure here
    // is reported but never takes the proxy down.
    let openshellDriver: { socketPath: string; stop(): Promise<void> } | undefined;
    let openshellDriverError: string | undefined;
    if (config.openshell?.driver?.enabled) {
      try {
        const { startOpenShellDriver } = await import('../openshell/integration.js');
        openshellDriver = await startOpenShellDriver({ config, store: credentialStore, scope: brokerScope, audit: auditLogger, version: VERSION });
      } catch (err) {
        openshellDriverError = err instanceof Error ? err.message : String(err);
      }
    }

    // Agent Substrate credential provider. Opt-in; a failure here is reported
    // but never takes the proxy down.
    let substrateProvider: { address: string; stop(): Promise<void> } | undefined;
    let substrateProviderError: string | undefined;
    if (config.substrate?.provider?.enabled) {
      try {
        const { startSubstrateProvider } = await import('../substrate/integration.js');
        substrateProvider = await startSubstrateProvider({ config, store: credentialStore, audit: auditLogger });
      } catch (err) {
        substrateProviderError = err instanceof Error ? err.message : String(err);
      }
    }

    // Write PID file
    writePidFile();

    console.log(`Credential proxy: ${socketPath}`);
    console.log(`Credential broker: ${describeBroker(brokerScope)}`);
    if (openshellDriver) console.log(`OpenShell credential driver: ${openshellDriver.socketPath}`);
    if (openshellDriverError) console.error(`  ⚠ OpenShell credential driver not started: ${openshellDriverError}`);
    if (substrateProvider) console.log(`Agent Substrate credential provider: ${substrateProvider.address}`);
    if (substrateProviderError) console.error(`  ⚠ Agent Substrate credential provider not started: ${substrateProviderError}`);
    if (brokerScope?.declarationError()) {
      console.error(`  ⚠ ${brokerScope.declarationError()} — refs declared there are refused until it parses`);
    }
    console.log(`Audit logging: ${config.audit.enabled ? 'enabled' : 'disabled'}`);
    console.log(`Credential backend: ${config.credentials.backend}`);
    reportVaultState(credentialStore);
    console.log(`PID file: ${getPidFile()}`);
    console.log('');
    console.log('Press Ctrl+C to stop, or run: aquaman stop\n');

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down daemon...');
      await openshellDriver?.stop();
      await substrateProvider?.stop();
      await credentialProxy.stop();
      await auditAnchor.stop();
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
      credentialStore = wrapWithCache(await createCredentialStore({ ...storeOptionsFromConfig(config), serving: true, onLinkChange: recordLinkChange(() => auditLogger) }), resolveCacheTtl(config));
    } catch (err) {
      console.error(`Credential backend "${config.credentials.backend}" failed to initialize: ${err instanceof Error ? err.message : err}`);
      console.error('Fix the backend configuration and retry. Run: aquaman doctor');
      process.exit(1);
    }

    // Initialize audit logger
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: config.audit.enabled,
      maxArchives: auditMaxArchives(config),
    });
    await auditLogger.initialize();

    // Initialize service registry
    const serviceRegistry = createServiceRegistry({ configPath: config.services.configPath });

    // Start credential proxy
    const policyConfig3 = loadPolicyFromConfig(config);
    // No `broker`: this proxy runs inside the OpenClaw plugin's lifecycle and
    // must never hand credential values to the gateway or its agents — that
    // was the ClawScan finding against 0.14.x (v0.15.0; see broker-scope.ts).
    // Set once the audit anchor exists; called when `aquaman unlock` opened the vault.
    const vaultOpened = { run: (): void => {} };
    const credentialProxy = createCredentialProxy({
      socketPath,
      store: credentialStore,
      allowedServices: config.credentials.proxiedServices,
      serviceRegistry,
      policyConfig: policyConfig3,
      loopback: loadLoopbackOptions(config),
      onVaultUnlocked: () => vaultOpened.run(),
      // Returned, so the proxy knows whether the entry was written.
      onRequest: (info) => {
        return auditLogger.logCredentialAccess('system', 'system', {
          service: info.service,
          operation: auditOperation(info.method),
          success: !info.error,
          error: info.error
        });
      }
    });
    await startProxyOrExit(credentialProxy);
    const auditAnchor = startAuditAnchor(config, auditLogger, credentialStore);
    vaultOpened.run = () => { void auditAnchor.recheck(); };

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
      await auditAnchor.stop();
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

// ── aquaman hermes … — Hermes integration via loopback listener ──
const hermes = program
  .command('hermes')
  .description('Hermes integration via opt-in loopback listener');

/** Mask a loopback token for display: keep the prefix + last 4 chars. */
function maskToken(token: string): string {
  if (token.length <= 12) return '****';
  return `${token.slice(0, 7)}…${token.slice(-4)}`;
}

/** The `--profile` value, lower-cased as Hermes reads it; exits on a name Hermes would not accept. */
function hermesProfileOption(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().toLowerCase();
  if (!isHermesProfileName(name)) {
    console.error(`Invalid --profile: ${raw}`);
    console.error('A Hermes profile name is lower-case letters, digits, "-" and "_" (list them with: hermes profile list).');
    process.exit(1);
  }
  return name;
}

/** `aquaman hermes <command>` with the profile flag it was run with, for a fix line. */
function hermesCommand(command: string, profile: string | undefined): string {
  return `aquaman hermes ${command}${profile ? ` --profile ${profile}` : ''}`;
}

/**
 * Say what became of storing the settings in Hermes. Returns the exit code.
 * No setting's value is printed: the commands a person runs by hand come from
 * `aquaman hermes configure`.
 */
function reportHermesApply(result: HermesApplyResult, profile: string | undefined): number {
  const configure = hermesCommand('configure', profile);
  switch (result.status) {
    case 'applied':
      console.log(`✓ Stored ${result.set.length} settings with \`hermes config set\` (${result.envPath})`);
      if (hermesEnvOpenToOthers(result.envPath)) {
        console.log(`⚠ ${result.envPath} can be read by other users of this machine, and it now holds the loopback token.`);
        console.log(`  Hermes keeps the mode the file had. Run: ${aqua(`chmod 600 ${result.envPath}`)}`);
      }
      return 0;
    case 'manual':
      if (result.reason === 'not_installed') {
        console.log('• Hermes CLI not found on PATH, so nothing was stored in Hermes.');
        console.log(`  Run this command again once it is installed, or print the commands with: ${aqua(configure)}`);
      } else {
        console.log(`• Hermes ${result.version ?? '(version not recognised)'}: \`hermes config set\` stores every setting in .env from ${HERMES_CONFIG_SET_ENV_MIN} on.`);
        console.log('  On this version some of them would land in config.yaml, so nothing was run.');
        console.log(`  Add the lines that ${aqua(configure)} prints to ${result.envPath}`);
      }
      return 0;
    case 'refused':
      console.log(`✗ ${result.envPath} holds a key in ${result.realKeys.join(', ')}, and \`hermes config set\` would replace it.`);
      console.log('  Nothing was stored in Hermes. Put the key in the vault first:');
      for (const name of result.realKeys) {
        const svc = name.replace(/_API_KEY$/, '').toLowerCase();
        console.log(`    ${aqua(`aquaman credentials add ${svc} api_key`)}`);
      }
      console.log(`  then run: ${aqua(`${hermesCommand('setup', profile)} --replace-keys`)}`);
      return 1;
    case 'failed':
      if (result.key) console.log(`✗ \`hermes config set ${result.key}\` failed: ${result.detail}`);
      else console.log(`✗ ${result.detail}`);
      if (result.set.length > 0) console.log(`  Stored before that: ${result.set.join(', ')}`);
      console.log(`  The settings are not complete in ${result.envPath}. Print the commands with: ${aqua(configure)}`);
      return 1;
  }
}

/** Whether the profile's `.env` holds the settings that point Hermes at the proxy. */
async function hermesWiringOf(
  integration: HermesIntegration,
  profile: string | undefined,
): Promise<{ envPath: string; readable: boolean; exists: boolean; absent: string[] }> {
  const envPath = await integration.resolveEnvPath(profile);
  const exists = fs.existsSync(envPath);
  const wiring = hermesEnvWiring(envPath, integration.configureHermes());
  return { envPath, exists, readable: wiring.readable, absent: [...wiring.missing, ...wiring.differing] };
}

// hermes setup — enable loopback listener, generate token, store the settings in Hermes
hermes
  .command('setup')
  .description('Enable the loopback listener, generate a token, and point Hermes at it with `hermes config set`')
  .option('--port <port>', 'Loopback listener port')
  .option('--profile <name>', 'Hermes profile to set up (default: the profile Hermes selects)')
  .option('--replace-keys', 'Replace a provider key already in the Hermes .env with the placeholder')
  .option('--dry-run', 'Show what would change without writing')
  .option('--no-write', 'Configure the proxy but store nothing in Hermes')
  .action(async (options) => {
    const profile = hermesProfileOption(options.profile);
    const config = loadConfig();

    // Resolve port: flag > existing config > default.
    let port = config.loopback?.port || DEFAULT_LOOPBACK_PORT;
    if (options.port) {
      const p = Number(options.port);
      if (!Number.isInteger(p) || p <= 0 || p >= 65536) {
        console.error(`Invalid --port: ${options.port}`);
        process.exit(1);
      }
      port = p;
    }

    const host = config.loopback?.host || '127.0.0.1';
    const token = config.loopback?.token || generateLoopbackToken();

    // Which services get wired (anthropic/openai today).
    const integration = createHermesIntegration({
      port, token, host,
      services: config.credentials.proxiedServices,
      config: config.hermes,
    });
    const wired = integration.wiredServices();
    const env = integration.configureHermes();

    if (wired.length === 0) {
      console.log('No Hermes-supported services (anthropic, openai) are in your proxiedServices list.');
      console.log('Add one with: aquaman credentials add anthropic api_key');
    }

    if (options.dryRun) {
      console.log('Dry run — would apply this configuration:\n');
      console.log(`  Loopback listener: http://${host}:${port}  (enabled)`);
      console.log(`  Token:             ${maskToken(token)}`);
      console.log(`  Wired services:    ${wired.join(', ') || '(none)'}`);
      console.log(`  Hermes .env:       ${await integration.resolveEnvPath(profile)}`);
      console.log('\nSettings, stored with `hermes config set`:');
      console.log(integration.getEnvForDisplay());
      return;
    }

    // Persist loopback config (enabled + port + token + host).
    // Written onto the file as stored, so that nothing else that exists only
    // as an environment override is saved along with the listener settings.
    const stored = loadStoredConfig();
    stored.loopback = { enabled: true, port, host, token };
    saveConfig(stored);
    console.log(`✓ Loopback listener enabled on http://${host}:${port} (saved to ${path.join(getConfigDir(), 'config.yaml')})`);

    let exitCode = 0;
    if (options.write !== false) {
      exitCode = reportHermesApply(
        await integration.applyConfiguration(env, { profile, replaceKeys: options.replaceKeys === true }),
        profile,
      );
    } else {
      console.log('Stored nothing in Hermes (--no-write). Settings:');
      console.log(integration.getEnvForDisplay());
      console.log('\nStore them with:');
      console.log(integration.commandsForDisplay(env, profile));
    }

    const info = await detectHermes(config.hermes?.binaryPath || 'hermes');
    console.log('');
    if (info.installed) {
      console.log(`✓ Hermes detected (v${info.version})`);
    } else {
      console.log('• Install Hermes: https://hermes-agent.nousresearch.com/docs/getting-started/installation');
    }

    console.log('\nNext steps:');
    console.log(`  1. Add credentials:  ${aqua('aquaman credentials add anthropic api_key')}`);
    console.log(`  2. Start the daemon: ${aqua('aquaman daemon')}`);
    console.log(`  3. Verify:           ${aqua(hermesCommand('doctor', profile))}`);
    if (exitCode !== 0) process.exit(exitCode);
  });

// hermes status — loopback config + env file + Hermes detection (overview)
hermes
  .command('status')
  .description('Show loopback listener config, whether Hermes points at it, and Hermes detection')
  .option('--profile <name>', 'Hermes profile to look at (default: the profile Hermes selects)')
  .action(async (options) => {
    const profile = hermesProfileOption(options.profile);
    const config = loadConfig();
    const lb = config.loopback;

    console.log('Hermes integration status\n');
    if (lb?.enabled) {
      console.log(`  Loopback listener: ${aqua('enabled')}  http://${lb.host || '127.0.0.1'}:${lb.port || DEFAULT_LOOPBACK_PORT}`);
      console.log(`  Token:             ${lb.token ? maskToken(lb.token) : aqua('MISSING — run: aquaman hermes setup')}`);
    } else {
      console.log(`  Loopback listener: disabled  (enable with: ${aqua('aquaman hermes setup')})`);
    }

    const integration = createHermesIntegration({
      port: lb?.port || DEFAULT_LOOPBACK_PORT,
      token: lb?.token || '',
      host: lb?.host || '127.0.0.1',
      services: config.credentials.proxiedServices,
      config: config.hermes,
    });
    console.log(`  Wired services:    ${integration.wiredServices().join(', ') || '(none)'}`);

    const wiring = await hermesWiringOf(integration, profile);
    const wiringText = wiring.absent.length === 0 ? aqua('wired')
      : wiring.absent.length === Object.keys(integration.configureHermes()).length ? 'not wired'
      : `incomplete: ${wiring.absent.join(', ')} not set to the proxy`;
    console.log(`  Hermes .env:       ${wiringText}  (${wiring.envPath})`);

    const shadowed = managedScopeShadowedKeys(integration.configureHermes());
    if (shadowed.length > 0) {
      console.log(`  Managed scope:     ⚠ ${hermesManagedEnvPath()} pins ${shadowed.join(', ')} — proxy bypassed for these keys`);
    }

    const info = await detectHermes(config.hermes?.binaryPath || 'hermes');
    console.log(`  Hermes CLI:        ${info.installed ? aqua(`v${info.version}`) : 'not found'}`);

    // Live liveness probe of the loopback listener (no token needed for _health).
    if (lb?.enabled) {
      const alive = await probeLoopbackHealth(lb.host || '127.0.0.1', lb.port || DEFAULT_LOOPBACK_PORT);
      console.log(`  Listener:          ${alive ? aqua('responding') : 'not responding (is the daemon running?)'}`);
    }
  });

// hermes doctor — deep diagnostic; exit 1 on any failure
hermes
  .command('doctor')
  .description('Deep diagnostic — loopback config, listener reachability, env wiring, per-service vault credentials')
  .option('--profile <name>', 'Hermes profile to check (default: the profile Hermes selects)')
  .action(async (options) => {
    const profile = hermesProfileOption(options.profile);
    const config = loadConfig();
    const lb = config.loopback;
    let ok = true;
    const fail = (msg: string) => { ok = false; console.log(`  ✗ ${msg}`); };
    const pass = (msg: string) => console.log(`  ✓ ${msg}`);

    console.log('Hermes integration diagnostic\n');

    // 1. Loopback enabled + token present
    if (!lb?.enabled) {
      fail('Loopback listener is disabled — run: aquaman hermes setup');
    } else {
      pass(`Loopback listener enabled (http://${lb.host || '127.0.0.1'}:${lb.port || DEFAULT_LOOPBACK_PORT})`);
      if (!lb.token) fail('Loopback token missing — run: aquaman hermes setup');
      else pass('Loopback token configured');
    }

    // 2. Listener reachable
    if (lb?.enabled) {
      const alive = await probeLoopbackHealth(lb.host || '127.0.0.1', lb.port || DEFAULT_LOOPBACK_PORT);
      if (alive) pass('Loopback listener responding to /_health');
      else fail('Loopback listener not responding — start the daemon: aquaman daemon');
    }

    // 3. The profile's .env holds the settings that point Hermes at the proxy
    const integration = createHermesIntegration({
      port: lb?.port || DEFAULT_LOOPBACK_PORT,
      token: lb?.token || '',
      host: lb?.host || '127.0.0.1',
      services: config.credentials.proxiedServices,
      config: config.hermes,
    });
    {
      const wiring = await hermesWiringOf(integration, profile);
      const fix = hermesCommand('setup', profile);
      if (wiring.exists && !wiring.readable) {
        fail(`Could not read ${wiring.envPath}`);
      } else if (wiring.absent.length === 0) {
        pass(`Hermes .env points at the proxy (${wiring.envPath})`);
        if (hermesEnvOpenToOthers(wiring.envPath)) {
          fail(`${wiring.envPath} can be read by other users of this machine and holds the loopback token — run: chmod 600 ${wiring.envPath}`);
        }
      } else if (!lb?.token) {
        fail(`Hermes .env not wired (${wiring.envPath}) — run: ${fix}`);
      } else {
        fail(`Hermes .env does not point at the proxy: ${wiring.absent.join(', ')} missing or set to something else (${wiring.envPath}) — run: ${fix}`);
      }
    }

    // 3b. Hermes >=0.17 managed scope: /etc/hermes/.env overrides ~/.hermes/.env
    {
      const shadowed = managedScopeShadowedKeys(integration.configureHermes());
      if (shadowed.length > 0) {
        fail(`Hermes managed scope (${hermesManagedEnvPath()}) pins ${shadowed.join(', ')} — it overrides ~/.hermes/.env, so the proxy is BYPASSED for these keys. Remove them from the managed file or point them at the proxy.`);
      } else {
        pass('No managed-scope override of aquaman env vars');
      }
    }

    // 4. Per-service vault credentials resolve
    const wired = integration.wiredServices();
    if (wired.length === 0) {
      fail('No Hermes-supported services configured (anthropic, openai)');
    } else {
      try {
        const store = await createCredentialStore(storeOptionsFromConfig(config));
        for (const svc of wired) {
          const val = await store.get(svc, 'api_key');
          if (val) pass(`Vault credential ${svc}/api_key resolves`);
          else fail(`No credential for ${svc}/api_key — run: aquaman credentials add ${svc} api_key`);
        }
        printOnePasswordModeHint(config, '  ');
      } catch (err) {
        fail(`Vault backend "${config.credentials.backend}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // 5. Secret-source bindings are declared to the broker (v0.15.0+). The
    // daemon only materializes declared refs, so a binding in Hermes'
    // config.yaml alone now resolves to a "not declared" warning at startup.
    {
      const bound = hermesSecretSourceRefs();
      if (bound.error) {
        fail(`Hermes config unreadable (${bound.error}) — can't check secret-source bindings`);
      } else if (bound.refs.length === 0) {
        console.log(`  • No aquaman secret-source bindings in ${bound.path} (optional)`);
      } else {
        // The daemon decides with its store's item names, so a binding that is
        // a second name for a provider key is refused there. The same joining,
        // without opening the vault: `aquaman-<service>-<key>` on 1Password
        // and `<service>--<key>` on systemd-creds (their `itemIdentity`).
        const backend = config.credentials.backend;
        const itemIdentity = backend === '1password' ? (service: string, key: string) => `aquaman-${service}-${key}`
          : backend === 'systemd-creds' ? (service: string, key: string) => `${service}--${key}`
          : undefined;
        const scope = daemonBrokerScope(config, { itemIdentity });
        if (!scope) {
          fail(`${bound.refs.length} secret-source binding(s) in ${bound.path}, but broker.enabled is false — none will resolve`);
        } else {
          const undeclared = bound.refs.filter((ref) => {
            const r = parseAquamanRef(ref)!;
            return !scope.check(r.service, r.key, 'loopback').allowed;
          });
          if (undeclared.length === 0) {
            pass(`All ${bound.refs.length} secret-source binding(s) are declared to the broker`);
          } else {
            fail(`Secret-source binding(s) not declared to the broker, so the daemon refuses them: ${undeclared.join(', ')}`);
            console.log(`    → aquaman broker allow ${undeclared.join(' ')}`);
          }
        }
      }
    }

    // 6. Hermes installed
    const info = await detectHermes(config.hermes?.binaryPath || 'hermes');
    if (info.installed) pass(`Hermes CLI installed (v${info.version})`);
    else console.log('  • Hermes CLI not found on PATH (install: https://hermes-agent.nousresearch.com/docs/getting-started/installation)');

    console.log('');
    console.log(ok ? aqua('All checks passed.') : 'Some checks failed — see above.');
    process.exit(ok ? 0 : 1);
  });

// hermes configure — emit/write the Hermes env vars without touching daemon config
hermes
  .command('configure')
  .description('Print the Hermes settings (base URLs + placeholder key) and the commands that store them')
  .option('--method <method>', 'env (print) or dotenv (store in the Hermes .env with `hermes config set`)', 'env')
  .option('--profile <name>', 'Hermes profile (default: the profile Hermes selects)')
  .option('--replace-keys', 'Replace a provider key already in the Hermes .env with the placeholder')
  .option('--dry-run', 'Print without storing')
  .action(async (options) => {
    const profile = hermesProfileOption(options.profile);
    const config = loadConfig();
    const lb = config.loopback;
    if (!lb?.token) {
      console.error('No loopback token configured. Run `aquaman hermes setup` first.');
      process.exit(1);
    }
    const integration = createHermesIntegration({
      port: lb.port || DEFAULT_LOOPBACK_PORT,
      token: lb.token,
      host: lb.host || '127.0.0.1',
      services: config.credentials.proxiedServices,
      config: { configMethod: options.method === 'dotenv' ? 'dotenv' : 'env', binaryPath: config.hermes?.binaryPath },
    });
    const env = integration.configureHermes();

    if (options.dryRun || options.method !== 'dotenv') {
      console.log('Hermes settings:\n');
      for (const [k, v] of Object.entries(env)) console.log(`${k}=${v}`);
      console.log(`\nStore them with Hermes ${HERMES_CONFIG_SET_ENV_MIN} or later:\n`);
      console.log(integration.commandsForDisplay(env, profile));
      console.log(`\nOn an earlier Hermes, add the lines above to ${await integration.resolveEnvPath(profile)}`);
    } else {
      const code = reportHermesApply(
        await integration.applyConfiguration(env, { profile, replaceKeys: options.replaceKeys === true }),
        profile,
      );
      if (code !== 0) process.exit(code);
    }
  });


/** One JSON POST to the proxy over its Unix socket. */
function proxyPost(
  socketPath: string,
  urlPath: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; json: any } | { error: string; code: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) });
          } catch {
            resolve({ error: `Proxy returned a non-JSON response (HTTP ${res.statusCode})`, code: 'bad_response' });
          }
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        resolve({ error: `Cannot reach the aquaman proxy at ${socketPath}`, code: 'proxy_unreachable' });
      } else if (err.code === 'EPERM' || err.code === 'EACCES') {
        resolve({ error: `Connecting to ${socketPath} was denied (${err.code})`, code: 'socket_blocked' });
      } else {
        resolve({ error: err.message, code: 'proxy_error' });
      }
    });
    req.on('timeout', () => req.destroy(new Error('timed out waiting for the proxy')));
    req.end(payload);
  });
}

function proxyHealthy(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ socketPath, path: '/_health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/** The backend `aquaman setup` would pick on this machine without asking. */
async function detectDefaultBackend(): Promise<string> {
  if (process.platform === 'darwin') return 'keychain';
  try {
    const { execSync } = await import('node:child_process');
    execSync('pkg-config --exists libsecret-1', { stdio: 'pipe' });
    return 'keychain';
  } catch {
    const { isSystemdCredsAvailable } = await import('../core/credentials/backends/systemd-creds.js');
    return isSystemdCredsAvailable() ? 'systemd-creds' : 'encrypted-file';
  }
}

/** The pid a proxy reports over its socket, or null (no proxy, or one that does not say). */
function proxyPid(socketPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request({ socketPath, path: '/_health', method: 'GET', timeout: 1500 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        try {
          const pid = JSON.parse(text).pid;
          resolve(typeof pid === 'number' ? pid : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * `aquaman init --agent <agent>`: everything an agent can do on its own to get
 * a project using aquaman. No prompts, no secrets, safe to run twice.
 */
async function initForAgent(agent: string, json: boolean, hooks: boolean, loopback: boolean, service: boolean): Promise<void> {
  const say = (line: string) => { if (!json) console.log(line); };
  const result: Record<string, any> = { ok: false, agent, version: VERSION, human_steps: [] as string[] };
  const finish = (code: number): never => {
    if (json) console.log(JSON.stringify(result, null, 2));
    process.exit(code);
  };
  if (agent !== 'claude-code' && agent !== 'codex') {
    result.error = `Unsupported agent "${agent}". Supported: claude-code, codex`;
    result.fix = 'aquaman init --agent claude-code   (or: --agent codex)';
    if (!json) { console.error(result.error); console.error(`  → ${result.fix}`); }
    finish(1);
  }

  // 1. Config
  ensureConfigDir();
  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    result.config = { path: configPath, created: false };
  } else {
    const config = getDefaultConfig();
    config.credentials.backend = (await detectDefaultBackend()) as typeof config.credentials.backend;
    fs.writeFileSync(configPath, yamlStringify(config), { encoding: 'utf-8', mode: 0o600 });
    fs.mkdirSync(path.join(getConfigDir(), 'audit'), { recursive: true, mode: 0o700 });
    result.config = { path: configPath, created: true };
  }
  result.config.backend = loadConfig().credentials.backend;
  say(`  ✓ Config ${result.config.created ? 'created' : 'found'} (${configPath}, backend: ${result.config.backend})`);

  // 2. Daemon
  const socketPath = path.join(getConfigDir(), 'proxy.sock');
  let running = await proxyHealthy(socketPath);
  let started = false;
  let restartFor: number | null = null;
  let enableLoopback: (() => void) | null = null;
  if (loopback) {
    // The listener is a TCP port any local process can reach, so it is only
    // turned on when asked for. The raw file is edited so that values which
    // exist only as environment overrides are never written back.
    const parsedRaw = yamlParse(fs.readFileSync(configPath, 'utf-8'));
    const raw: Record<string, any> = parsedRaw && typeof parsedRaw === 'object' ? parsedRaw : {};
    const lb = raw.loopback && typeof raw.loopback === 'object' ? raw.loopback : {};
    const host = LOOPBACK_HOSTS.has(lb.host) ? lb.host : '127.0.0.1';
    const next = { ...lb, enabled: true, port: lb.port || DEFAULT_LOOPBACK_PORT, host, token: lb.token || generateLoopbackToken() };
    const changed = lb.enabled !== true || !lb.token || lb.host !== host;
    // Nothing is written until every reason to refuse has been checked: a
    // run that stops with an error leaves the listener as it found it.
    if (changed) {
      enableLoopback = () => {
        raw.loopback = next;
        // The file now holds a token: written whole, readable by this user only.
        const tmp = `${configPath}.${randomBytes(8).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
        fs.renameSync(tmp, configPath);
        fs.chmodSync(configPath, 0o600);
      };
    }
    result.loopback = { enabled: !changed, url: `http://${next.host}:${next.port}`, changed: false };
    if (running && !(await probeLoopbackHealth(next.host, next.port))) {
      // A daemon started before the listener was enabled does not have it.
      // Only a process that says, over the socket, that it is the one in the
      // pid file gets signalled; an OpenClaw-hosted proxy or a recycled pid does not.
      const pid = readPidFile();
      const served = await proxyPid(socketPath);
      if (pid && served === pid && isProcessRunning(pid)) {
        restartFor = pid;
      } else {
        result.error = 'A proxy is running without the loopback listener and this command cannot restart it';
        result.fix = 'Stop it (aquaman stop, or stop the OpenClaw gateway that started it), then run this command again';
        if (!json) { console.error(`  ✗ ${result.error}`); console.error(`    → ${result.fix}`); }
        finish(1);
      }
    }
  }
  if ((!running || restartFor !== null) && result.config.backend === 'encrypted-file') {
    // This backend has no OS keystore behind it, so the daemon cannot open
    // the vault without a password from a person. Say so before starting it.
    // Only the yes/no leaves this check. Nothing derived from the password
    // itself, not even its length, goes into the output.
    const passwordUsable = validatePasswordStrength(loadConfig().credentials.encryptionPassword ?? '').valid;
    if (!passwordUsable) {
      result.daemon = { running: false, started: false, socket: socketPath };
      result.error = 'The encrypted-file vault needs a password of at least 12 characters before the daemon can start, and none is set or the one set is too short';
      result.fix = 'A person sets AQUAMAN_ENCRYPTION_PASSWORD (12 characters or more) in the environment the daemon starts from, then this command is run again. Do not invent one: the person needs it to open the vault later';
      result.human_steps.push('choose a vault password of at least 12 characters and export it as AQUAMAN_ENCRYPTION_PASSWORD');
      if (!json) { console.error(`  ✗ ${result.error}`); console.error(`    → ${result.fix}`); }
      finish(1);
    }
  }
  if (loopback) {
    if (enableLoopback) {
      enableLoopback();
      result.loopback.changed = true;
    }
    result.loopback.enabled = true;
    say(`  ✓ Loopback listener enabled (${result.loopback.url})`);
  }
  if (restartFor !== null) {
    // Stopped only now, after everything that could keep it from coming back was checked.
    process.kill(restartFor, 'SIGTERM');
    for (let i = 0; i < 50 && isProcessRunning(restartFor); i++) await new Promise((r) => setTimeout(r, 100));
    if (isProcessRunning(restartFor)) {
      result.error = 'The running daemon did not stop, so the loopback listener is not on yet';
      result.fix = 'Run: aquaman stop, then this command again';
      if (!json) { console.error(`  ✗ ${result.error}`); console.error(`    → ${result.fix}`); }
      finish(1);
    }
    removePidFile();
    try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
    running = false;
    result.loopback.daemon_restarted = true;
  }
  if (!running) {
    const logPath = path.join(getConfigDir(), 'daemon.log');
    const { spawn } = await import('node:child_process');
    const log = fs.openSync(logPath, 'a', 0o600);
    spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], { detached: true, stdio: ['ignore', log, log] }).unref();
    fs.closeSync(log);
    for (let i = 0; i < 40 && !running; i++) {
      await new Promise((r) => setTimeout(r, 250));
      running = await proxyHealthy(socketPath);
    }
    started = running;
    result.daemon = { running, started, socket: socketPath, log: logPath };
    if (!running) {
      result.error = `The daemon did not start. See ${logPath}`;
      let lastLine = '';
      try { lastLine = fs.readFileSync(logPath, 'utf-8').trim().split('\n').pop() ?? ''; } catch { /* no log */ }
      if (lastLine) result.error += `: ${lastLine.slice(0, 300)}`;
      result.fix = 'Run `aquaman daemon` in a terminal to see the error, then `aquaman doctor`';
      if (!json) { console.error(`  ✗ ${result.error}`); console.error(`    → ${result.fix}`); }
      finish(1);
    }
  } else {
    result.daemon = { running, started, socket: socketPath };
  }
  say(`  ✓ Daemon ${started ? 'started' : 'already running'}`);
  // A backend a person unlocks (bitwarden): the daemon runs, and reads from
  // the vault wait for the one step only a person can take.
  const vaultState = await new Promise<unknown>((resolve) => {
    const req = http.request({ socketPath, path: '/_health', method: 'GET', timeout: 1500 }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { resolve(JSON.parse(text).vault); } catch { resolve(undefined); } });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => { req.destroy(); resolve(undefined); });
    req.end();
  });
  if (vaultState === 'locked' || vaultState === 'unlocked') result.vault = vaultState;
  if (vaultState === 'locked') {
    result.human_steps.push('unlock the Bitwarden vault for the daemon: run `aquaman unlock` in a terminal and enter the master password there (an agent cannot do this step)');
    say('  • Vault: locked (credentials are not available until a person runs: aquaman unlock)');
  }

  // 3. The agent side lives in aquaman-coder.
  const { spawnSync } = await import('node:child_process');
  const coder = spawnSync('aquaman-coder', ['init', '--agent', agent, '--json', ...(hooks ? [] : ['--no-hooks'])], { encoding: 'utf-8' });
  if (coder.error && (coder.error as NodeJS.ErrnoException).code === 'ENOENT') {
    result.error = 'aquaman-coder is not installed';
    result.fix = 'npm install -g aquaman-coder';
    if (!json) { console.error(`  ✗ ${result.error}`); console.error(`    → ${result.fix}`); }
    finish(1);
  }
  let coderResult: any;
  try {
    coderResult = JSON.parse(coder.stdout);
  } catch {
    result.error = `aquaman-coder init failed: ${(coder.stderr || coder.stdout || '').trim().split('\n').pop() ?? 'no output'}`;
    if (!json) console.error(`  ✗ ${result.error}`);
    finish(1);
  }
  Object.assign(result, {
    project: coderResult.project,
    hooks: coderResult.hooks,
    mode: coderResult.mode,
    run: coderResult.run,
    skill: coderResult.skill,
    agents_file: coderResult.agents_file,
  });
  result.human_steps.push(...(coderResult.human_steps ?? []));
  result.ok = coderResult.ok === true;
  if (!result.ok) result.error = coderResult.error;
  result.next = 'When a task needs a credential: aquaman request aquaman://<service>/<key> --env <ENV_NAME>';

  say(`  ✓ Project "${coderResult.project?.name}" covers ${coderResult.project?.path}`);
  say(coderResult.mode === 'exec' ? '  ✓ Hooks: none installed. Run commands that need credentials as: aquaman-coder exec -- <command>' : `  ✓ Hooks: ${coderResult.hooks?.path}`);
  if (coderResult.skill?.path) say(`  ✓ Skill: ${coderResult.skill.path}`);
  if (coderResult.agents_file?.path) say(`  ✓ Instructions: ${coderResult.agents_file.path}`);
  if (result.ok) {
    // Last, after setup has succeeded: a login item is only ever added with a person's yes.
    const loginItem = await loginItemForInit(serviceCliHelpers, service);
    if (loginItem.service) {
      result.service = loginItem.service;
      say(`  ${loginItem.service.status === 'installed' || loginItem.service.status === 'already_installed' ? '✓' : '•'} Start at login: ${loginItem.service.status}${loginItem.service.error ? ` (${loginItem.service.error})` : ''}`);
      if (loginItem.service.fix) say(`    → ${loginItem.service.fix}`);
    }
    if (loginItem.humanStep) result.human_steps.push(loginItem.humanStep);
  }
  for (const step of result.human_steps) say(`  → A person needs to: ${step}`);
  say(`\n  ${result.next}`);
  finish(result.ok ? 0 : 1);
}

// Init command
program
  .command('init')
  .description('Initialize aquaman configuration; with --agent, set up a coding agent in one step')
  .option('--force', 'Overwrite existing configuration')
  .option('--agent <agent>', 'Also wire a coding agent for the current directory: claude-code or codex')
  .option('--json', 'With --agent: print one JSON object and nothing else')
  .option('--no-hooks', 'With --agent: install no hooks; commands that need credentials are run as `aquaman-coder exec -- <command>`')
  .option('--loopback', 'With --agent: also turn on the token-gated loopback listener, so a program can be routed through the proxy (aquaman request ... --via-proxy)')
  .option('--service', 'With --agent: also ask the person, in a dialog, to let the daemon start at every login (aquaman service install)')
  .addHelpText('after', `
With --agent the command never prompts and can be re-run safely. It creates the
config if missing, starts the daemon, installs the agent's hooks and skill,
registers the current directory as a project and writes a short block into
CLAUDE.md or AGENTS.md. With --no-hooks nothing is written to the agent host's
settings and no permission prompt changes. Credentials are added later, by a person:
  aquaman request aquaman://github/token --env GITHUB_TOKEN`)
  .action(async (options) => {
    if (options.agent) {
      await initForAgent(String(options.agent), Boolean(options.json), options.hooks !== false, options.loopback === true, options.service === true);
      return;
    }
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

/** The `--profile` value for OpenClaw; exits on a name that cannot be a profile. */
function openclawProfileOption(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!isOpenClawProfileName(raw)) {
    console.error(`Invalid --profile: ${raw}`);
    console.error('An OpenClaw profile name is letters, digits, "-" and "_".');
    process.exit(1);
  }
  return raw;
}

/** How a change to OpenClaw's config ended, for the person. Returns false when it was refused. */
function reportOpenClawWrite(write: OpenClawWriteResult, configFile: string, planned: string[]): boolean {
  const list = (mark: string) => { for (const line of planned) console.log(`  ${mark} ${line}`); };
  switch (write.status) {
    case 'unchanged':
      list('\u2713');
      console.log(`  \u2713 OpenClaw config already holds these settings (${configFile})`);
      return true;
    case 'applied':
      list('\u2713');
      console.log(`  \u2713 OpenClaw config changed through \`openclaw config patch\` (${configFile})`);
      if (write.note) console.log(`    ${write.note}`);
      return true;
    case 'manual': {
      const why = write.reason === 'no_cli'
        ? 'the `openclaw` program is not on PATH, and aquaman does not edit openclaw.json itself'
        : write.reason === 'read_only'
          ? `${write.variable}=1 marks the config as managed elsewhere`
          : 'the config uses $include, and aquaman sees only the root file';
      console.log(`  \u2717 OpenClaw config not changed: ${why}.`);
      console.log(`    The change is saved as a patch, with no secret in it: ${write.patchPath}`);
      if (planned.length > 0) {
        console.log('    It would set:');
        for (const line of planned) console.log(`      \u2022 ${line}`);
      }
      console.log(write.reason === 'includes'
        ? `    Check it against the included files, then apply it: ${aqua(write.command)}`
        : write.reason === 'read_only'
          ? '    Put its contents into the source your deployment builds the config from.'
          : `    Apply it once OpenClaw is installed: ${aqua(write.command)}`);
      return true;
    }
    case 'failed':
      console.log(`  \u2717 OpenClaw config not changed: ${write.detail}`);
      console.log(`    The patch is in ${write.patchPath}. After fixing the cause: ${aqua(write.command)}`);
      return false;
  }
}

// Setup command - all-in-one guided onboarding
// openclaw setup — full OpenClaw bundle: vault wizard + plugin install +
// openclaw.json wiring + auth-profiles.json + optional auto-migration.
openclaw
  .command('setup')
  .description('Full setup for OpenClaw — vault + plugin + auth profiles + (optional) auto-migrate')
  .option('--backend <backend>', 'Credential backend (keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden, keeper)')
  .option('--no-openclaw', 'Skip OpenClaw plugin installation step (run vault setup only)')
  .option('--no-policy', 'Skip request policy preset configuration')
  .option('--profile <name>', 'OpenClaw profile to set up (as in `openclaw --profile <name>`)')
  .option('--non-interactive', 'Use environment variables instead of prompts (for CI)')
  .action(async (options) => {
    const os = await import('node:os');
    const configDir = getConfigDir();
    const configPath = path.join(configDir, 'config.yaml');
    const isNonInteractive = options.nonInteractive || false;
    const openclawProfile = openclawProfileOption(options.profile);
    const ocPaths = openclawPaths(openclawProfile);
    const openclawStateDir = ocPaths.stateDir;
    const ocProfileArgs = openclawProfileArgs(openclawProfile);

    console.log('\n  \u{1F419} aquaman setup\n');

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
    const validBackends = ['keychain', 'encrypted-file', 'keepassxc', '1password', 'vault', 'systemd-creds', 'bitwarden', 'keeper'];
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
        } catch {
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
    } else if (backend === 'keeper') {
      const { KeeperStore } = await import('../core/credentials/backends/keeper.js');
      if (!KeeperStore.isAvailable()) {
        console.error('  Keeper Commander (keeper) not found.');
        console.error('  Install: pip install keepercommander');
        console.error('  Then, once: keeper shell -> login -> this-device register -> this-device persistent-login on');
        process.exit(1);
      }
      if (!process.env['AQUAMAN_KEEPER_FOLDER_UID']) {
        console.error('  Keeper backend needs the folder that will hold aquaman records.');
        console.error('  Create one in Keeper, then: export AQUAMAN_KEEPER_FOLDER_UID=<folder UID>');
        console.error('  (find the UID with: keeper get "<folder name>" --format json)');
        process.exit(1);
      }
    }

    // 2. Run init internally (create dirs, config)
    ensureConfigDir();
    // Start from the file as stored (the defaults when there is none) and
    // change only what setup decides: the backend, policy presets for newly
    // stored services, the loopback listener and routed channels. Everything
    // else in an existing config (the loopback token and port, declared broker
    // refs, policies, proxied services) is the user's and stays. Environment
    // overrides are not applied, so none of them is written to the file.
    const config = loadStoredConfig();
    config.credentials.backend = backend;
    if (backend === 'keeper') {
      config.credentials.keeperFolderUid = process.env['AQUAMAN_KEEPER_FOLDER_UID'];
      if (process.env['AQUAMAN_KEEPER_CONFIG']) config.credentials.keeperConfigPath = process.env['AQUAMAN_KEEPER_CONFIG'];
    }
    saveConfig(config);

    // Create audit directory
    const auditDir = path.join(configDir, 'audit');
    fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });

    // 3. Prompt for API keys (or read from env in non-interactive mode)
    let store;
    try {
      store = await createCredentialStore(storeOptionsFromConfig(config));
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
      const anthropicKey = await promptSecretInput('  ? Enter your Anthropic API key: ');
      if (anthropicKey) {
        await store.set('anthropic', 'api_key', anthropicKey);
        storedServices.push('anthropic');
        console.log('    \u2713 Stored anthropic/api_key\n');
      }

      const openaiKey = await promptSecretInput('  ? Enter your OpenAI API key (or press Enter to skip): ');
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
          // A service that already has a policy keeps it.
          if (presets[svc] && !config.policy?.[svc]) {
            policyToApply[svc] = presets[svc];
          }
        }

        if (Object.keys(policyToApply).length > 0) {
          config.policy = { ...config.policy, ...policyToApply };
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
          // Detect the gateway version once — it gates the install command
          // (capability consent on 2026.8.1+) and the credential surface:
          // SecretRef wiring (canonical, >= 2026.6.5) vs the legacy
          // auth-profiles.json placeholder. AQUAMAN_OPENCLAW_VERSION overrides
          // detection (tests + operators pinning behavior explicitly).
          let ocVersion: string | null = process.env.AQUAMAN_OPENCLAW_VERSION || null;
          if (!ocVersion) {
            try {
              const { execSync } = await import('node:child_process');
              ocVersion = execSync('openclaw --version', { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim().split('\n').pop()!.trim();
            } catch { /* CLI not on PATH */ }
          }

          // a. Copy plugin files
          const currentDir = path.dirname(fileURLToPath(import.meta.url));
          const pluginSrc = path.resolve(currentDir, '../../../plugin');
          const pluginDest = path.join(openclawStateDir, 'extensions', 'aquaman-plugin');
          fs.mkdirSync(path.join(openclawStateDir, 'extensions'), { recursive: true });

          if (fs.existsSync(pluginSrc)) {
            fs.cpSync(pluginSrc, pluginDest, { recursive: true });
            console.log('  \u2713 Plugin installed to ' + pluginDest);
          } else if (cliDetected) {
            // npm install — plugin source not bundled, use openclaw's plugin
            // installer. OpenClaw 2026.8.1+ requires capability consent for
            // third-party plugins: interactively we let OpenClaw show its own
            // consent screen to the human; --non-interactive means the operator
            // pre-approved, so we pass --accept-capabilities and say so. The
            // clawhub: source avoids the extra --force an npm spec needs.
            const consent = pluginInstallNeedsCapabilityConsent(ocVersion);
            const args = consent
              ? ['plugins', 'install', 'clawhub:aquaman-plugin', ...(isNonInteractive ? ['--accept-capabilities'] : [])]
              : ['plugins', 'install', 'aquaman-plugin'];
            try {
              const { execFileSync: execFileSyncFallback } = await import('node:child_process');
              execFileSyncFallback('openclaw', [...ocProfileArgs, ...args], { stdio: consent && !isNonInteractive ? 'inherit' : 'pipe' });
              console.log('  \u2713 Plugin installed via openclaw');
              if (consent && isNonInteractive) {
                console.log('  \u2192 Accepted the plugin\u2019s OpenClaw capabilities on your behalf (--non-interactive)');
              }
            } catch {
              console.log(`  \u2717 Could not install plugin. Run: openclaw ${[...ocProfileArgs, ...args].join(' ')}${consent && isNonInteractive ? '' : consent ? '  (then approve its capabilities)' : ''}`);
            }
          }

          // b. Work out the change to OpenClaw's config. Nothing is written
          // here: the difference goes to `openclaw config patch` below.
          const openclawJsonPath = ocPaths.configPath;
          const planned: string[] = [];
          let openclawConfig: any = {};
          if (fs.existsSync(openclawJsonPath)) {
            const existing = fs.readFileSync(openclawJsonPath, 'utf-8');
            // An empty file is a fresh one. Anything else that does not parse
            // is the person's config in a form this command cannot read
            // (comments, a trailing comma): writing a new file over it would
            // drop everything in it, so it is left alone.
            if (existing.trim() !== '') {
              let parsed: unknown;
              try {
                parsed = JSON.parse(existing);
              } catch (err) {
                console.error(`\n  \u2717 ${openclawJsonPath} is not strict JSON (${err instanceof Error ? err.message : String(err)}).`);
                console.error('    aquaman left it unchanged: it reads the file to decide what to change and cannot read comments or trailing commas.');
                console.error('    OpenClaw rewrites the file as standard JSON on its next config write. Or remove them yourself (keep a copy), then run: aquaman openclaw setup');
                process.exit(1);
              }
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                console.error(`\n  \u2717 ${openclawJsonPath} does not hold a JSON object.`);
                console.error('    aquaman left it unchanged. Fix the file, then run: aquaman openclaw setup');
                process.exit(1);
              }
              openclawConfig = parsed;
            }
          }
          const openclawConfigBefore = structuredClone(openclawConfig);

          if (!openclawConfig.plugins) openclawConfig.plugins = {};
          if (!openclawConfig.plugins.entries) openclawConfig.plugins.entries = {};

          // plugins.allow is an allowlist for EVERY plugin, OpenClaw's own
          // included: on current gateways the anthropic/openai model providers
          // are stock plugins. Creating a list that holds only aquaman-plugin
          // (what setup did through v0.14.x) blocked them, so every
          // anthropic/* model became "Unknown model" (verified 2026-09-18 on
          // 2026.7.33 and 2026.9.1). Append to an existing list; never create
          // a restrictive one on the user's behalf.
          if (Array.isArray(openclawConfig.plugins.allow)) {
            if (!openclawConfig.plugins.allow.includes('aquaman-plugin')) {
              openclawConfig.plugins.allow.push('aquaman-plugin');
            }
          } else {
            console.log('  \u2192 No plugins.allow list in openclaw.json; left it unset (a list with only aquaman-plugin would block OpenClaw\u2019s own provider plugins)');
          }

          const configuredServices = storedServices.length > 0 ? storedServices : ['anthropic', 'openai'];
          openclawConfig.plugins.entries['aquaman-plugin'] = {
            ...(openclawConfig.plugins.entries['aquaman-plugin'] && typeof openclawConfig.plugins.entries['aquaman-plugin'] === 'object'
              ? openclawConfig.plugins.entries['aquaman-plugin'] : {}),
            enabled: true,
            config: {
              backend,
              services: configuredServices,
            }
          };
          planned.push(`Plugin entry for aquaman-plugin (backend ${backend}; services ${configuredServices.join(', ')})`);

          // b2. SecretRef provider wiring (v0.14.0+, OpenClaw >= 2026.6.5).
          // Config-level refs in openclaw.json are runtime-read on every
          // version and survive OpenClaw's plaintext scrubs \u2014 no SQLite
          // import step needed, unlike the legacy placeholder.
          const secretRefSupported = supportsSecretRefIntegrations(ocVersion);
          // Which configured channels aquaman can actually take over: the host
          // must expose an endpoint override and the vault must already hold
          // the real token. Resolved up front because the wiring is sync, and
          // only for channels the user actually configured -- a vault probe
          // can be slow (keepassxc opens and derives a key per call).
          const channelsConfigured = CHANNEL_ROUTING_SUPPORTED.filter(
            c => openclawConfig.channels?.[c] && typeof openclawConfig.channels[c] === 'object'
          );
          const channelsWithVaultCredential = new Set<string>();
          if (channelsConfigured.length > 0) {
            const channelRegistry = createServiceRegistry();
            for (const channel of channelsConfigured) {
              const def = channelRegistry.get(channel);
              if (!def) continue;
              if (await store.exists(channel, def.credentialKey)) {
                channelsWithVaultCredential.add(channel);
              }
            }
          }

          // Both routes need the loopback listener: model traffic (provider
          // baseUrl) and channel egress (apiRoot). Decide once.
          let loopbackOrigin: string | undefined;
          let loopbackToken: string | undefined;
          if (secretRefSupported || channelsConfigured.length > 0) {
            // OpenClaw's model transport builds its own undici dispatcher: it
            // ignores the aquaman.local sentinel (its own DNS fails) and never
            // calls globalThis.fetch, so the plugin's interceptor can't see
            // provider traffic. Route it at the loopback listener instead —
            // OpenClaw's documented local-provider pattern (v0.15.0).
            const lbHost = config.loopback?.host || '127.0.0.1';
            const lbPort = config.loopback?.port || DEFAULT_LOOPBACK_PORT;
            const lbToken = config.loopback?.token || generateLoopbackToken();
            config.loopback = { enabled: true, host: lbHost, port: lbPort, token: lbToken };
            saveConfig(config);
            loopbackOrigin = `http://${lbHost}:${lbPort}`;
            loopbackToken = lbToken;
            console.log(`  \u2713 Loopback listener enabled on ${loopbackOrigin} (token-gated, loopback-bound)`);
          }

          if (secretRefSupported && loopbackOrigin) {
            const wiring = wireSecretRefProviders(openclawConfig, configuredServices, { loopbackOrigin });
            if (wiring.wiredProviders.length > 0) {
              planned.push(`SecretRef wiring for ${wiring.wiredProviders.join(', ')} (canonical credential surface)`);
            }
            if (wiring.baseUrlProviders.length > 0) {
              planned.push(`Model traffic routed through the proxy for ${wiring.baseUrlProviders.join(', ')}`);
            }
            if (wiring.keptUserBaseUrl.length > 0) {
              console.log(`  \u2192 Left ${wiring.keptUserBaseUrl.join(', ')} as configured: the baseUrl there is your own, so the proxy is not in the path and no key reference is written (its answer is the local token, which would go to that host)`);
            }
            if (wiring.removedRefs.length > 0) {
              planned.push(`Key reference removed from ${wiring.removedRefs.join(', ')}: the baseUrl there is not the proxy, and the local token was being sent to it`);
            }
            const userKept = wiring.skippedProviders.filter(s => s === 'anthropic' || s === 'openai');
            if (userKept.length > 0) {
              console.log(`  \u2192 Left existing user-set apiKey untouched for: ${userKept.join(', ')}`);
            }
          }

          // b3. Channel egress routing (v0.15.0+). Channels each build their
          // own undici dispatcher, so the plugin's fetch interceptor never
          // sees them. Telegram is the one bundled channel with an endpoint
          // override, and the Bot API carries its token in the path, so the
          // placeholder written here is the loopback token itself.
          if (loopbackOrigin && loopbackToken) {
            const routing = wireChannelRouting(openclawConfig, {
              loopbackOrigin,
              loopbackToken,
              tokenRef: secretRefSupported,
              hasVaultCredential: (svc) => channelsWithVaultCredential.has(svc)
            });
            if (routing.routedChannels.length > 0) {
              // A routed channel that isn't in proxiedServices gets a 404 from
              // our own proxy, which is exactly the dead bot the all-or-nothing
              // wiring exists to avoid. Open the route we just pointed at us.
              const proxied = config.credentials.proxiedServices;
              const added = routing.routedChannels.filter(c => !proxied.includes(c));
              if (added.length > 0) {
                config.credentials.proxiedServices = [...proxied, ...added];
                saveConfig(config);
              }
              planned.push(`Channel traffic routed through the proxy for ${routing.routedChannels.join(', ')}${secretRefSupported ? ' (token by reference, not in the file)' : ''}`);
            }
            for (const skip of routing.skipped) {
              console.log(`  \u2192 ${skip.channel} left as-is: ${describeChannelSkip(skip.reason, skip.channel)}`);
            }
          }

          const openclawWrite = await applyOpenClawPatch(configMergePatch(openclawConfigBefore, openclawConfig), {
            patchDir: configDir,
            profile: openclawProfile,
            binary: cliDetected ? 'openclaw' : null,
            current: openclawConfigBefore,
            configPath: openclawJsonPath,
          });
          if (!reportOpenClawWrite(openclawWrite, openclawJsonPath, planned)) process.exitCode = 1;

          // c. Generate auth-profiles.json (only if missing). With SecretRef
          // wiring active this is a redundant legacy surface \u2014 skip it so
          // `openclaw secrets audit` has no plaintext placeholder to flag.
          const profilesPath = path.join(openclawStateDir, 'agents', 'main', 'agent', 'auth-profiles.json');
          if (secretRefSupported) {
            console.log('  \u2192 Legacy auth-profiles.json placeholder skipped (SecretRef wiring replaces it)');
            if (legacyAuthProfilesBlockProviders(ocVersion) && fs.existsSync(profilesPath)) {
              // Left behind by aquaman-plugin <= 0.14.x. On 2026.8.1+ it locks
              // anthropic/openai out until OpenClaw archives it.
              console.log('  \u2717 A legacy auth-profiles.json from an older aquaman-plugin blocks providers on this OpenClaw');
              console.log('      Run once: openclaw doctor --fix   (archives it; aquaman-plugin 0.15.0+ never recreates it)');
            }
          } else if (!fs.existsSync(profilesPath)) {
            const profiles: Record<string, any> = {};
            const order: Record<string, string[]> = {};

            for (const svc of configuredServices) {
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
          for (const s of result.unstorable ?? []) {
            console.log(`  - Not migrated: plugin ${JSON.stringify(s.service)} in openclaw.json: ${s.reason}`);
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
  .option('--profile <name>', 'OpenClaw profile to check (as in `openclaw --profile <name>`)')
  .action(async (doctorOptions: { profile?: string }) => {
    const configDir = getConfigDir();
    const configPath = path.join(configDir, 'config.yaml');
    const ocPaths = openclawPaths(openclawProfileOption(doctorOptions.profile));
    const openclawStateDir = ocPaths.stateDir;
    let issues = 0;

    console.log('');
    console.log(`  \u{1F419} aquaman ${VERSION} \u2014 Welcome to the doctor\u2019s office.`);
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
    // Services the vault holds anything for. Used by the channel-routing
    // check below, which runs outside the store's try block.
    const vaultServices = new Set<string>();
    try {
      config = loadConfig();

      if (config.credentials.backend === 'systemd-creds') {
        const { isSystemdCredsAvailable } = await import('../core/credentials/backends/systemd-creds.js');
        if (!isSystemdCredsAvailable()) {
          throw new Error('systemd-creds backend requires systemd >= 256 with --user support');
        }
      }

      if (config.credentials.backend === 'keeper') {
        const { KeeperStore } = await import('../core/credentials/backends/keeper.js');
        if (!KeeperStore.isAvailable()) {
          throw new Error('Keeper Commander (keeper) not found. Install: pip install keepercommander');
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
        bitwardenCollectionId: config.credentials.bitwardenCollectionId,
        keeperFolderUid: config.credentials.keeperFolderUid,
        keeperConfigPath: config.credentials.keeperConfigPath
      });

      // 3. Count credentials
      const creds = await listCredentials(store);
      for (const c of creds) vaultServices.add(c.service);
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
        // Deny rules that can never fire (pre-0.15.0 preset shapes) — a
        // security issue, since the operator believes the endpoint is blocked.
        for (const warning of lintPolicyConfig(policyConfigDoc)) {
          console.log(`  \u2717 ${aqua('Policy')} ${warning}`);
          issues++;
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

    // 6. OpenClaw detection. AQUAMAN_OPENCLAW_VERSION overrides version
    // detection (tests + operators pinning behavior explicitly).
    let openclawDetected = false;
    let openclawVersion: string | null = process.env.AQUAMAN_OPENCLAW_VERSION || null;
    let cliFound = false;
    try {
      const { execSync } = await import('node:child_process');
      execSync('which openclaw', { stdio: 'pipe' });
      cliFound = true;
    } catch { /* not in PATH */ }

    if (cliFound) {
      try {
        const { execSync } = await import('node:child_process');
        const ver = openclawVersion ??
          execSync('openclaw --version', { stdio: 'pipe', encoding: 'utf-8', timeout: 5000 }).trim();
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
        if (pluginProvenanceIsReported(openclawVersion)) {
          console.log(`  \u2192 ${aqua('Plugin source')} OpenClaw 2026.11+ reports "can't verify where this plugin came from" for it and \`openclaw plugins doctor\` exits 1. The plugin still loads; this is how that OpenClaw classes a plugin installed from ClawHub or copied by setup.`);
        }
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
      const openclawJsonPath = ocPaths.configPath;
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
          const allowList: string[] | undefined = Array.isArray(openclawConfig.plugins?.allow) ? openclawConfig.plugins.allow : undefined;
          if (!allowList) {
            console.log(`  \u2713 ${aqua('Plugin')} allowed (no plugins.allow trust list; \`openclaw security audit\` notes extensions_no_allowlist)`);
          } else if (allowList.includes('aquaman-plugin')) {
            console.log(`  \u2713 ${aqua('Plugin')} in plugins.allow trust list`);
            // A list that excludes OpenClaw's own provider plugins blocks
            // them (aquaman setup <= 0.14.x wrote exactly such a list).
            const svcs: string[] = openclawConfig.plugins?.entries?.['aquaman-plugin']?.config?.services ?? ['anthropic', 'openai'];
            const blocked = ['anthropic', 'openai'].filter(p => svcs.includes(p) && !allowList.includes(p));
            if (blocked.length > 0 && supportsSecretRefIntegrations(openclawVersion)) {
              console.log(`  \u2717 ${aqua('Plugin')} plugins.allow blocks OpenClaw\u2019s own provider plugin(s): ${blocked.join(', ')} (their models report "Unknown model")`);
              console.log(`    \u2192 Add ${blocked.map(b => `"${b}"`).join(', ')} to plugins.allow in openclaw.json (aquaman setup <= 0.14.x created a list without them)`);
              issues++;
            }
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

      // 8.5. SecretRef provider wiring (v0.14.0+, OpenClaw >= 2026.6.5) — the
      //      canonical credential surface that replaces the placeholder
      //      auth-profiles dance.
      let secretRefFullyWired = false;
      if (supportsSecretRefIntegrations(openclawVersion) && fs.existsSync(openclawJsonPath)) {
        try {
          const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
          const pluginServices: string[] =
            openclawConfig.plugins?.entries?.['aquaman-plugin']?.config?.services ?? ['anthropic', 'openai'];
          const status = secretRefWiringStatus(openclawConfig, pluginServices);
          if (status.providerConfigured && status.missingProviders.length === 0) {
            secretRefFullyWired = true;
            console.log(`  ✓ ${aqua('SecretRef')} wiring active (${status.wiredProviders.join(', ') || 'no providers'})`);
            // The apiKey ref alone doesn't put the proxy in the path: without
            // a loopback baseUrl OpenClaw's transport calls the upstream
            // directly and the placeholder fails there (v0.15.0).
            if (status.missingBaseUrl.length > 0) {
              console.log(`  ✗ ${aqua('Model routing')} ${status.missingBaseUrl.join(', ')}: aquaman's key reference is set but the baseUrl is not the proxy, so the proxy is bypassed and that host is sent a key it cannot use`);
              console.log('    → Run: aquaman openclaw setup   (routes the provider through the proxy, or removes the reference where the baseUrl is your own)');
              issues++;
            } else if (status.baseUrlProviders.length > 0) {
              console.log(`  ✓ ${aqua('Model routing')} through the proxy for ${status.baseUrlProviders.join(', ')}`);
              // A provider key exported in the gateway's environment wins over
              // the configured SecretRef: verified live on OpenClaw 2026.11.3,
              // the gateway sent $OPENAI_API_KEY itself to the loopback
              // listener, which rejected it (401, no loopback token). The
              // real key is then in the agent process, and model calls fail.
              // Doctor can only see its own environment, so this is a note.
              const exported = status.baseUrlProviders
                .map((svc) => `${svc.toUpperCase()}_API_KEY`)
                .filter((name) => !!process.env[name]);
              if (exported.length > 0) {
                console.log(`  \u2192 ${aqua('Environment')} ${exported.join(', ')} ${exported.length > 1 ? 'are' : 'is'} set in this shell. If OpenClaw starts with ${exported.length > 1 ? 'them' : 'it'}, it sends that key instead of the proxy token: the key is in the agent process and the proxy answers 401. Unset ${exported.length > 1 ? 'them' : 'it'} where OpenClaw runs.`);
              }
            }
          } else if (status.providerConfigured) {
            // Half-migrated: the provider block exists but some providers still
            // lack refs — a real inconsistency, fail the check.
            console.log(`  ✗ ${aqua('SecretRef')} wiring incomplete (providers not wired: ${status.missingProviders.join(', ')})`);
            console.log('    → Run: aquaman openclaw setup   (completes the SecretRef wiring in openclaw.json)');
            issues++;
          } else {
            // Legacy placeholder flow still functional — upgrade suggestion,
            // not a failure. (OpenClaw's configure-flow scrubs treat the
            // plaintext placeholder as residue; SecretRef wiring is immune.)
            console.log(`  → ${aqua('SecretRef')} wiring available on this OpenClaw — run: aquaman openclaw setup`);
            console.log('    (replaces the legacy plaintext placeholder, which OpenClaw now scrubs by default)');
          }
        } catch {
          // openclaw.json invalid — already reported above
        }
      }

      // 8.6. Channel egress routing (v0.15.0+). Channels build their own
      //      undici dispatcher, so the plugin's fetch interceptor never sees
      //      them. Only channels whose endpoint OpenClaw lets us override can
      //      be routed; the rest are at-rest storage only and say so.
      if (fs.existsSync(openclawJsonPath)) {
        try {
          const openclawConfig = JSON.parse(fs.readFileSync(openclawJsonPath, 'utf-8'));
          const routing = channelRoutingStatus(openclawConfig, {
            hasVaultCredential: (svc) => vaultServices.has(svc)
          });
          if (routing.routed.length > 0) {
            console.log(`  \u2713 ${aqua('Channel routing')} through the proxy for ${routing.routed.join(', ')}`);
            // Routed but not proxied means our own proxy 404s the channel.
            const notProxied = routing.routed.filter(
              c => !(config?.credentials?.proxiedServices ?? []).includes(c)
            );
            if (notProxied.length > 0) {
              console.log(`  \u2717 ${aqua('Channel routing')} ${notProxied.join(', ')} routed here but missing from proxiedServices, so the proxy returns 404`);
              console.log(`    \u2192 Add ${notProxied.join(', ')} to credentials.proxiedServices in ~/.aquaman/config.yaml (or re-run: aquaman openclaw setup)`);
              issues++;
            }
          }
          for (const skip of routing.notRouted) {
            console.log(`  \u2717 ${aqua('Channel routing')} ${skip.channel} sends its token straight to the vendor`);
            console.log(`    \u2192 ${describeChannelSkip(skip.reason, skip.channel)}`);
            issues++;
          }
          if (routing.unroutable.length > 0) {
            // Not a failure: nothing the user can do, and the credentials can
            // still live in the vault. Stated so nobody assumes coverage.
            console.log(`  \u2192 ${aqua('Channel routing')} not available for ${routing.unroutable.join(', ')} on this OpenClaw (no config-level endpoint override)`);
            console.log('    (their tokens can live in the vault, but the proxy is not in their egress path)');
          }
        } catch {
          // openclaw.json invalid \u2014 already reported above
        }
      }

      // 9. Auth profiles. With SecretRef wiring active this surface is
      //    legacy/inert. Otherwise: OpenClaw >= 2026.6.5 reads provider auth
      //    profiles from each agent's openclaw-agent.sqlite and no longer reads
      //    auth-profiles.json at runtime (openclaw/openclaw#89102) — the
      //    placeholder the plugin writes to the JSON file must be imported
      //    into SQLite once via `openclaw doctor --fix`.
      const agentDir = path.join(openclawStateDir, 'agents', 'main', 'agent');
      const profilesPath = path.join(agentDir, 'auth-profiles.json');
      const sqlitePath = path.join(agentDir, 'openclaw-agent.sqlite');
      if (legacyAuthProfilesBlockProviders(openclawVersion) && fs.existsSync(profilesPath)) {
        // OpenClaw 2.0 line: the legacy JSON is not inert any more — it blocks
        // providers with AUTH_PROFILE_MIGRATION_REQUIRED (#114033). Older
        // aquaman-plugin versions rewrote it on every load; 0.15.0+ doesn't.
        console.log(`  \u2717 ${aqua('Auth profiles')} legacy auth-profiles.json blocks anthropic/openai on ${openclawVersion} (AUTH_PROFILE_MIGRATION_REQUIRED)`);
        if (!secretRefFullyWired) {
          console.log('    \u2192 First: aquaman openclaw setup   (wires the SecretRef provider that replaces it)');
        }
        console.log('    \u2192 Then run once: openclaw doctor --fix   (archives the file; aquaman-plugin 0.15.0+ never recreates it)');
        issues++;
      } else if (secretRefFullyWired) {
        console.log(`  ✓ ${aqua('Auth profiles')} not needed (SecretRef wiring replaces the placeholder flow)`);
        if (fs.existsSync(profilesPath)) {
          console.log('    → Optional: the legacy auth-profiles.json placeholder is inert and may be deleted');
          console.log('      (`openclaw secrets audit` flags its plaintext placeholder as PLAINTEXT_FOUND)');
        }
      } else if (authProfilesAreSqliteOnly(openclawVersion)) {
        if (fs.existsSync(profilesPath)) {
          console.log(`  \u2717 ${aqua('Auth profiles')} JSON present but ${openclawVersion} reads from SQLite`);
          console.log('    \u2192 Import the placeholder once: openclaw doctor --fix  (backs up openclaw.json first)');
          console.log('      (OpenClaw \u2265 2026.6.5 dropped the runtime auth-profiles.json read path \u2014 openclaw/openclaw#89102)');
          issues++;
        } else if (fs.existsSync(sqlitePath)) {
          console.log(`  \u2713 ${aqua('Auth profiles')} (SQLite store present; OpenClaw \u2265 2026.6.5)`);
        } else {
          console.log(`  \u2717 ${aqua('Auth profiles')} missing: no credential wiring for OpenClaw ${openclawVersion}`);
          console.log('    \u2192 Run: aquaman openclaw setup   (wires the SecretRef provider; the plugin no longer writes auth-profiles.json here)');
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
        const openclawJsonPath = ocPaths.configPath;
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
    // Opened for reading: a proxy may be writing this log right now.
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: true,
      readOnly: true
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

/** What the audit commands need from this file: the config, the store it names, and whether a proxy is serving. */
function auditCommandDeps() {
  const config = loadConfig();
  return {
    config,
    openStore: () => createCredentialStore(storeOptionsFromConfig(config)),
    proxyRunning: () => proxyHealthy(path.join(getConfigDir(), 'proxy.sock')),
  };
}

audit
  .command('verify')
  .description('Verify the audit log: its hash chain, and the log against its anchor in the credential store')
  .option('--chain-only', 'Check the hash chain alone, without reading the anchor from the credential store')
  .option('--json', 'Print the result as JSON')
  .action(async (options: { chainOnly?: boolean; json?: boolean }) => {
    process.exitCode = await auditVerifyCommand(options, auditCommandDeps());
  });

audit
  .command('accept')
  .description('Accept the audit log as it is and move its anchor (after a restored backup or a deliberate deletion). Needs a terminal')
  .action(async () => {
    process.exitCode = await auditAcceptCommand(auditCommandDeps());
  });

audit
  .command('rotate')
  .description('Rotate audit log to archive')
  .action(async () => {
    const config = loadConfig();
    const auditLogger = createAuditLogger({
      logDir: config.audit.logDir,
      enabled: true,
      maxArchives: auditMaxArchives(config),
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
    refuseIfLinked(service, key);

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
        bitwardenCollectionId: config.credentials.bitwardenCollectionId,
        keeperFolderUid: config.credentials.keeperFolderUid,
        keeperConfigPath: config.credentials.keeperConfigPath
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
  return readHiddenTtyLine(130);
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
        bitwardenCollectionId: config.credentials.bitwardenCollectionId,
        keeperFolderUid: config.credentials.keeperFolderUid,
        keeperConfigPath: config.credentials.keeperConfigPath
      });
    } catch {
      console.error('Credential store not available.');
      process.exit(1);
    }

    const creds = await listCredentials(store);

    if (creds.length === 0) {
      console.log('No credentials stored.');
      return;
    }

    console.log('Stored credentials:');
    for (const cred of creds) {
      console.log(`  ${listedCredential(cred)}`);
    }
  });

registerLinkCommands(credentials, (config) => createCredentialStore({ ...storeOptionsFromConfig(config), links: 'always' }), proxyPost);

credentials
  .command('delete <service> <key>')
  .description('Delete a credential')
  .action(async (service: string, key: string) => {
    validateCredName('service', service);
    validateCredName('key', key);
    refuseIfLinked(service, key);

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
        bitwardenCollectionId: config.credentials.bitwardenCollectionId,
        keeperFolderUid: config.credentials.keeperFolderUid,
        keeperConfigPath: config.credentials.keeperConfigPath
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
  .option('--backend <backend>', 'Override backend (keychain, encrypted-file, keepassxc, 1password, vault, systemd-creds, bitwarden, keeper)')
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

    // Either outcome can come from a rule or from the service's default.
    const rule = result.matchedRule;
    const why = rule
      ? `by rule: ${rule.method} ${rule.path} \u2192 ${rule.action}`
      : `(no matching rule, default: ${policyConfig[service].defaultAction})`;
    console.log(result.allowed ? `  \u2713 ALLOWED ${why}` : `  \u2717 DENIED ${why}`);
  });

// ── aquaman openshell …: NVIDIA OpenShell external credential driver (v0.17.0+) ──
const openshell = program
  .command('openshell')
  .description('NVIDIA OpenShell integration: aquaman as the gateway credential driver');

/** Edit config.yaml `openshell.driver` in the raw file so env overrides are never persisted. */
function updateOpenShellDriverConfig(enabled: boolean, socketPath?: string): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  let raw: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    const parsed = yamlParse(fs.readFileSync(configPath, 'utf-8'));
    if (parsed && typeof parsed === 'object') raw = parsed;
  }
  const current = raw.openshell?.driver && typeof raw.openshell.driver === 'object' ? raw.openshell.driver : {};
  raw.openshell = { ...(raw.openshell && typeof raw.openshell === 'object' ? raw.openshell : {}), driver: { ...current, enabled } };
  if (socketPath) raw.openshell.driver.socketPath = socketPath;
  fs.writeFileSync(configPath, yamlStringify(raw), { encoding: 'utf-8', mode: 0o600 });
}

openshell
  .command('setup')
  .description('Serve the OpenShell credential driver from `aquaman daemon` and print the gateway config')
  .option('--socket <path>', 'Absolute Unix socket path for the driver (default: <configDir>/openshell.sock)')
  .option('--disable', 'Turn the driver off again')
  .action(async (opts: { socket?: string; disable?: boolean }) => {
    const { grpcAvailable, gatewayConfigSnippet, openshellDriverSocketPath, MAX_SOCKET_PATH } = await import('../openshell/integration.js');
    const { GRPC_INSTALL_HINT } = await import('../openshell/grpc-server.js');

    if (opts.disable) {
      updateOpenShellDriverConfig(false);
      console.log('OpenShell credential driver disabled. Restart the daemon: aquaman stop && aquaman daemon');
      console.log('Remove the [openshell.credential_drivers.aquaman] table from your gateway config too.');
      return;
    }
    if (opts.socket && !path.isAbsolute(opts.socket)) {
      console.error('--socket must be an absolute path (the gateway config needs one).');
      process.exit(1);
    }

    updateOpenShellDriverConfig(true, opts.socket);
    const socketPath = openshellDriverSocketPath(loadConfig());

    console.log(`OpenShell credential driver enabled in ${getConfigPath()}`);
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
      console.error(`  ⚠ ${socketPath} is longer than the ${MAX_SOCKET_PATH}-byte Unix socket limit. Rerun with --socket <shorter path>.`);
    }
    if (!(await grpcAvailable())) {
      console.log(`\n  The driver needs two optional packages: ${aqua(GRPC_INSTALL_HINT)}`);
    }
    console.log('\n1. Add this to your OpenShell gateway config (TOML):\n');
    console.log(gatewayConfigSnippet(socketPath).split('\n').map((l) => `   ${l}`).join('\n'));
    console.log('\n2. Restart aquaman, then the gateway:');
    console.log('   aquaman stop; aquaman daemon');
    console.log('\n3. Create providers by reference. The secret stays in your vault; nothing is copied:');
    console.log(`   ${aqua('aquaman broker allow aquaman://anthropic/api_key')}`);
    console.log(`   openshell provider create --name claude --type anthropic --credential ANTHROPIC_API_KEY=aquaman://anthropic/api_key`);
    console.log('\n   A plain value (--credential KEY=sk-...) is stored in your vault under the "openshell" service instead.');
    console.log(`\nCheck everything with: ${aqua('aquaman openshell doctor')}`);
  });

openshell
  .command('doctor')
  .description('Check the OpenShell credential driver: packages, config, socket, declared refs')
  .option('--gateway-config <path>', 'Also check an OpenShell gateway TOML file points at this driver')
  .action(async (opts: { gatewayConfig?: string }) => {
    const net = await import('node:net');
    const { grpcAvailable, openshellDriverSocketPath, MAX_SOCKET_PATH } = await import('../openshell/integration.js');
    const { GRPC_INSTALL_HINT } = await import('../openshell/grpc-server.js');
    const config = loadConfig();
    const socketPath = openshellDriverSocketPath(config);
    let failed = 0;
    const pass = (m: string) => console.log(`  ✓ ${m}`);
    const fail = (m: string, fix?: string) => { failed++; console.log(`  ✗ ${m}`); if (fix) console.log(`    → ${fix}`); };

    console.log(`\n  ${aqua('OpenShell credential driver')}\n`);
    if (await grpcAvailable()) pass('gRPC packages installed (@grpc/grpc-js, @grpc/proto-loader)');
    else fail('gRPC packages missing', GRPC_INSTALL_HINT);

    if (config.openshell?.driver?.enabled) pass('Driver enabled in config.yaml');
    else fail('Driver not enabled', 'aquaman openshell setup');

    if (Buffer.byteLength(socketPath) <= MAX_SOCKET_PATH) pass(`Socket path ${socketPath}`);
    else fail(`Socket path over ${MAX_SOCKET_PATH} bytes: ${socketPath}`, 'aquaman openshell setup --socket <shorter absolute path>');

    let isSocket = false;
    try { isSocket = fs.statSync(socketPath).isSocket(); } catch { /* absent */ }
    if (!isSocket) {
      fail('Driver socket not present (daemon not running, or started before setup)', 'aquaman stop; aquaman daemon');
    } else {
      const mode = fs.statSync(socketPath).mode & 0o777;
      if (mode === 0o600) pass('Socket is owner-only (0600)');
      else fail(`Socket mode is ${mode.toString(8)}, expected 600`, 'aquaman stop; aquaman daemon');
      const reachable = await new Promise<boolean>((resolve) => {
        const c = net.connect(socketPath, () => { c.end(); resolve(true); });
        c.on('error', () => resolve(false));
        setTimeout(() => { c.destroy(); resolve(false); }, 2000);
      });
      if (reachable) pass('Driver socket accepts connections');
      else fail('Driver socket does not accept connections', 'aquaman stop; aquaman daemon');
    }

    const scope = daemonBrokerScope(config);
    if (!scope) {
      fail('Broker disabled (broker.enabled: false): references cannot resolve', 'set broker.enabled: true in config.yaml');
    } else {
      const n = scope.declared().length;
      if (n > 0) pass(`${n} declared ref${n === 1 ? '' : 's'} usable by reference (aquaman broker list)`);
      else console.log('  • No declared refs yet: reference-mode providers will be refused until you run aquaman broker allow <ref>');
    }

    if (opts.gatewayConfig) {
      let toml = '';
      try { toml = fs.readFileSync(opts.gatewayConfig, 'utf-8'); } catch { fail(`Cannot read ${opts.gatewayConfig}`); }
      if (toml) {
        const listsDriver = /credential_drivers\s*=\s*\[[^\]]*"aquaman"[^\]]*\]/.test(toml);
        const table = /\[openshell\.credential_drivers\.aquaman\]([\s\S]*?)(?=\n\[|$)/.exec(toml)?.[1] ?? '';
        const uds = /transport\s*=\s*"uds"/.test(table);
        const sock = /socket_path\s*=\s*"([^"]*)"/.exec(table)?.[1];
        if (listsDriver && uds && sock === socketPath) pass(`Gateway config ${opts.gatewayConfig} points at this driver`);
        else fail(`Gateway config ${opts.gatewayConfig} does not point at this driver`, 'paste the snippet from: aquaman openshell setup');
      }
    }

    console.log('');
    if (failed > 0) { console.log(`  ${failed} check${failed === 1 ? '' : 's'} failed.\n`); process.exit(1); }
    console.log('  All checks passed.\n');
  });

/** `audit.maxArchives` when it is a usable number; otherwise the logger's own default. */
function auditMaxArchives(config: WrapperConfig): number | undefined {
  const n = config.audit.maxArchives;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Start the proxy; a socket path too long to bind ends the command with the reason and the fix, not a stack trace. */
async function startProxyOrExit(proxy: { start(): Promise<void> }): Promise<void> {
  try {
    await proxy.start();
  } catch (err) {
    if (!(err instanceof SocketPathError)) throw err;
    console.error(`  \u2717 ${err.message}`);
    console.error(`    \u2192 ${err.fix}`);
    process.exit(1);
  }
}

// ── aquaman substrate …: Agent Substrate credential provider ──
const substrate = program
  .command('substrate')
  .description('Agent Substrate integration: aquaman as a credential provider for its egress gateway');

substrate
  .command('doctor')
  .description('Check the Agent Substrate credential provider: packages, settings, TLS files, grants, listener')
  .action(async () => {
    const net = await import('node:net');
    const { X509Certificate } = await import('node:crypto');
    const { grpcAvailable } = await import('../openshell/integration.js');
    const { GRPC_INSTALL_HINT } = await import('../openshell/grpc-server.js');
    const { substrateProviderSettings } = await import('../substrate/integration.js');
    const { readTlsContext } = await import('../substrate/grpc-server.js');
    const { loadSubstrateGrants } = await import('../substrate/grants.js');
    const config = loadConfig();
    let failed = 0;
    const pass = (m: string) => console.log(`  ✓ ${m}`);
    const fail = (m: string, fix?: string) => { failed++; console.log(`  ✗ ${m}`); if (fix) console.log(`    → ${fix}`); };
    const note = (m: string) => console.log(`  • ${m}`);

    console.log(`\n  ${aqua('Agent Substrate credential provider')}\n`);
    if (await grpcAvailable()) pass('gRPC packages installed (@grpc/grpc-js, @grpc/proto-loader)');
    else fail('gRPC packages missing', GRPC_INSTALL_HINT);

    if (config.substrate?.provider?.enabled) pass('Provider enabled in config.yaml');
    else fail('Provider not enabled', `set substrate.provider.enabled: true in ${getConfigPath()}`);

    const settings = substrateProviderSettings(config);
    if ('error' in settings) {
      fail(settings.error, `edit ${getConfigPath()}`);
    } else {
      pass(`Secret URIs: ate-secret://${settings.name}/<service>/<key>`);
      pass(`Only caller accepted: ${settings.callerSpiffeId}`);
      try {
        const context = readTlsContext(settings.tls);
        // The file may hold the key first; the first certificate in it is the serving one.
        const firstCert = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/.exec((context.cert as Buffer).toString('latin1'))?.[0] ?? '';
        const leaf = new X509Certificate(firstCert);
        const until = new Date(leaf.validTo);
        if (until.getTime() <= Date.now()) fail(`Serving certificate expired on ${until.toISOString()}`, `renew ${settings.tls.certFile}`);
        else pass(`TLS files load; serving certificate valid until ${until.toISOString()}`);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), 'check substrate.provider.tls in config.yaml and the mounted certificate volumes');
      }

      const port = Number(settings.listen.slice(settings.listen.lastIndexOf(':') + 1));
      const reachable = await new Promise<boolean>((resolve) => {
        const c = net.connect(port, '127.0.0.1', () => { c.end(); resolve(true); });
        c.on('error', () => resolve(false));
        setTimeout(() => { c.destroy(); resolve(false); }, 2000);
      });
      if (reachable) pass(`Listener accepts connections on port ${port}`);
      else fail(`Nothing is listening on port ${port} (daemon not running, or started before the provider was enabled)`, 'aquaman stop; aquaman daemon');
    }

    const grants = loadSubstrateGrants(getConfigPath());
    if (grants.error) fail(grants.error, `edit ${getConfigPath()}`);
    let refs = 0;
    for (const set of grants.grants.values()) refs += set.size;
    if (refs > 0) pass(`${refs} grant${refs === 1 ? '' : 's'} across ${grants.grants.size} atespace or actor entr${grants.grants.size === 1 ? 'y' : 'ies'}`);
    else note('No grants yet: every fetch is refused until substrate.provider.grants lists a reference');

    const backend = config.credentials.backend;
    if (backend === 'bitwarden' || backend === 'keychain' || backend === 'keepassxc' || backend === 'keeper') {
      note(`Backend ${backend} needs a person or a desktop session; in a cluster use vault, 1password with a service account, or encrypted-file`);
    }

    console.log('');
    if (failed > 0) { console.log(`  ${failed} check${failed === 1 ? '' : 's'} failed.\n`); process.exit(1); }
    console.log('  All checks passed.\n');
  });

// Credential broker scope (v0.15.0+)
const broker = program
  .command('broker')
  .description('Credential broker scope: which refs `aquaman daemon` may hand out');

broker
  .command('list')
  .description('List the refs the daemon broker will materialize, and where each is declared')
  .action(() => {
    const config = loadConfig();
    console.log('Credential broker: served by `aquaman daemon` only. OpenClaw-hosted proxies never hand out credential values.\n');
    if (config.broker?.enabled === false) {
      console.log('  Disabled (broker.enabled: false in config.yaml) — every broker request is refused.');
      return;
    }
    const scope = daemonBrokerScope(config)!;
    const declared = scope.declared();
    if (declared.length === 0) {
      console.log('  No declared refs — every broker request is refused.');
    }
    for (const d of declared) console.log(`  ${d.ref}  (${d.source})`);
    const err = scope.declarationError();
    if (err) console.log(`\n  ⚠ ${err} — refs declared there are refused until it parses`);
    console.log(`\n  Never over the loopback listener: ${HERMES_SUPPORTED_SERVICES.join(', ')} (process-isolated on the proxy path)`);
    console.log(`  Coding-agent refs: ${defaultProjectsPath()}  (aquaman coder project add ...)`);
    console.log(`  Other refs:        broker.allowedRefs in ${getConfigPath()}  (aquaman broker allow ...)`);
  });

broker
  .command('allow')
  .description('Allow aquaman://service/key refs to be materialized (e.g. Hermes secret-source bindings)')
  .argument('<refs...>', 'one or more aquaman://service/key refs')
  .action((refs: string[]) => {
    updateBrokerAllowedRefs(refs, 'allow');
  });

broker
  .command('revoke')
  .description('Stop materializing refs added with `aquaman broker allow`')
  .argument('<refs...>', 'one or more aquaman://service/key refs')
  .action((refs: string[]) => {
    updateBrokerAllowedRefs(refs, 'revoke');
  });

// v0.16.0: fills the "run a command, read the secret from stdout" slot every
// host has (sbx secret set --command, the auth command of a custom Codex
// provider, Claude Code apiKeyHelper, OpenClaw exec providers, Hermes key_cmd).
// This materializes the value into the CALLING process, so it is not process
// isolation; it is scope-checked and audited because it goes through the daemon.
program
  .command('get')
  .description('Print a declared credential to stdout, via the running daemon (for host credential-helper commands)')
  .argument('<ref>', 'aquaman://service/key, declared with `aquaman broker allow` or in projects.yaml')
  .option('--show', 'Allow printing to an interactive terminal')
  .option('--timeout <ms>', 'How long to wait for the daemon (vaults that prompt may need longer)', '15000')
  .addHelpText('after', `
Examples:
  sbx secret set github --command "$(command -v node) $(command -v aquaman) get aquaman://github/token"
  Codex config.toml:  [model_providers.<your-id>.auth]  command = "aquaman"  args = ["get", "aquaman://openai/api_key"]
                      (a provider you define; Codex refuses an auth command on its built-in "openai")
  Claude Code:        "apiKeyHelper": "aquaman get aquaman://anthropic/api_key"

The value lands in whichever process runs this command. Every read is checked
against the broker scope and written to the audit log.`)
  .action(async (ref: string, opts: { show?: boolean; timeout: string }) => {
    const parsed = parseAquamanRef(ref);
    if (!parsed) {
      console.error(`Invalid ref: ${ref}`);
      console.error('Refs look like aquaman://<service>/<key>, e.g. aquaman://github/token');
      process.exit(1);
    }
    const timeoutMs = Number(opts.timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      console.error(`Invalid --timeout: ${opts.timeout} (milliseconds, a positive integer)`);
      process.exit(1);
    }
    // Refuse before resolving, so an accidental run at a prompt neither
    // prints the secret into scrollback nor spends an audited read.
    if (process.stdout.isTTY && !opts.show) {
      console.error('Refusing to print a credential to a terminal.');
      console.error('This command is meant to be run by another program. To print it anyway, pass --show.');
      process.exit(1);
    }

    const result = await brokerResolve(path.join(getConfigDir(), 'proxy.sock'), parsed.service, parsed.key, timeoutMs);
    if ('value' in result) {
      // No trailing newline when piped: credential-helper consumers differ on
      // whether they trim, and a stray "\n" in an auth header breaks requests.
      process.stdout.write(process.stdout.isTTY ? `${result.value}\n` : result.value);
      return;
    }
    console.error(`Error: ${result.error}`);
    if (result.code === 'broker_ref_not_declared') {
      console.error(`Fix: aquaman broker allow ${ref}`);
    } else if (result.code === 'broker_disabled') {
      console.error('Fix: the proxy on this socket does not serve the broker. If the OpenClaw plugin started it, run `aquaman daemon` instead (the last proxy started owns the socket).');
    } else if (result.fix) {
      console.error(`Fix: ${result.fix}`);
    }
    process.exit(1);
  });


// `aquaman request`: the way an agent asks for a credential it must not see.
// The daemon shows the human a dialog; the value goes from the dialog into the
// vault. This command only ever prints a status and the reference.
program
  .command('request')
  .description('Ask for a credential by reference; a person supplies or approves it in a dialog. Never prints the value')
  .argument('<ref>', 'aquaman://service/key')
  .option('--env <NAME>', 'Also bind the ref to this env var for the project covering the current directory')
  .option('--via-proxy <URL_ENV>', 'With --env: route the program through the proxy. NAME gets the proxy token, URL_ENV the proxy URL; the program never holds the credential')
  .option('--base-path <path>', 'With --via-proxy: path appended to the proxy URL (default /v1 for openai, /api for slack)')
  .option('--from <locator>', 'Use an item that already exists in your vault instead of asking for the value (see: aquaman credentials link --help)')
  .option('--timeout <seconds>', `How long the dialog waits for an answer (${PROMPT_TIMEOUT_MIN_SECONDS}-${PROMPT_TIMEOUT_MAX_SECONDS})`, String(PROMPT_TIMEOUT_SECONDS))
  .option('--json', 'Print one JSON object and nothing else')
  .addHelpText('after', `
The command waits while the dialog is open: up to --timeout seconds, ${PROMPT_TIMEOUT_SECONDS} by
default. Give it a longer --timeout only if whatever runs it allows a command
that long. An unanswered dialog is "pending"; asking again is fine.

Statuses and exit codes:
  ready     0   stored and usable already; nobody was asked
  stored    0   a person typed the value; it is in the vault now
  approved  0   it was already in the vault; a person allowed its use
  linked    0   --from named an existing vault item; a person allowed it and it could be read
  declined  2   a person said no
  pending   3   nobody could be asked (no desktop session, no answer); the output says what to run by hand
  error     4   the daemon is not running, does not take requests, or refused: "code" says which
  error     1   the command was wrong: bad reference, bad --env, --env outside a project, bad --from

Example:
  aquaman request aquaman://github/token --env GITHUB_TOKEN --json`)
  .action(async (ref: string, opts: { env?: string; json?: boolean; timeout: string; viaProxy?: string; basePath?: string; from?: string }) => {
    const out = (result: Record<string, unknown>, code: number): never => {
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const stream = code === 0 ? console.log : console.error;
        stream(`${result.status}: ${ref}${result.reason ? ` (${result.reason})` : ''}`);
        if (result.error) stream(String(result.error));
        if (result.env) stream(result.via_proxy ? `Bound to ${result.env} for this project, through the proxy` : `Bound to ${result.env} for this project`);
        if (result.fix) stream(`Fix: ${result.fix}`);
      }
      process.exit(code);
    };

    const parsed = parseAquamanRef(ref);
    if (!parsed) {
      out({ status: 'error', ref, error: `Invalid ref: ${ref}`, fix: 'Refs look like aquaman://<service>/<key>, e.g. aquaman://github/token' }, 1);
    }
    if (opts.env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.env)) {
      out({ status: 'error', ref, error: `Invalid --env name: ${opts.env}`, fix: 'Use an environment variable name such as GITHUB_TOKEN' }, 1);
    }

    if (!/^\d+$/.test(opts.timeout)) {
      out({ status: 'error', ref, error: `Invalid --timeout: ${opts.timeout}`, fix: `Give a whole number of seconds between ${PROMPT_TIMEOUT_MIN_SECONDS} and ${PROMPT_TIMEOUT_MAX_SECONDS}` }, 1);
    }
    const timeoutSeconds = clampPromptTimeout(Number(opts.timeout));
    if (opts.from !== undefined) {
      const locator = checkRequestLocator(opts.from);
      if (!locator.ok) out({ status: 'error', ref, error: locator.error, code: locator.code, fix: locator.fix }, 1);
    }

    // A binding needs a project to live in. Checked before anyone is asked
    // for a value, so a dialog is never shown for a request that cannot finish.
    const { spawnSync } = await import('node:child_process');
    const bindSpec = opts.env ? `${opts.env}=${ref}` : '';
    const routeArgs: string[] = [];
    if (opts.viaProxy !== undefined || opts.basePath !== undefined) {
      if (!opts.env || opts.viaProxy === undefined) {
        out({ status: 'error', ref, error: '--via-proxy needs --env, and --base-path needs --via-proxy', fix: 'aquaman request aquaman://openai/api_key --env OPENAI_API_KEY --via-proxy OPENAI_BASE_URL' }, 1);
      }
      // A route only works for a service the proxy can forward and inject a
      // header or basic auth for, with the listener on. Say so before anyone
      // is asked.
      const parsedRef = parseAquamanRef(ref)!;
      const routeConfig = loadConfig();
      const def = createServiceRegistry({ configPath: routeConfig.services.configPath }).get(parsedRef.service);
      if (!def) {
        out({ status: 'error', ref, error: `The proxy has no definition for "${parsedRef.service}", so it cannot forward requests for it`, fix: `Add "${parsedRef.service}" to services.yaml (docs/app-through-proxy.md), or drop --via-proxy to have the variable set to the value instead` }, 1);
      }
      const routeKeys = routableKeys(def!);
      if (routeKeys.length === 0) {
        out({ status: 'error', ref, error: `"${parsedRef.service}" does not take its credential in a request header or as HTTP basic auth, so a program cannot be routed to it`, fix: 'Drop --via-proxy' }, 1);
      }
      if (!routeKeys.includes(parsedRef.key)) {
        out({ status: 'error', ref, ...routeKeyMismatch(parsedRef.service, routeKeys, parsedRef.key, def!.authMode) }, 1);
      }
      if (routeConfig.loopback?.enabled !== true || !routeConfig.loopback.token) {
        out({ status: 'error', ref, error: 'The loopback listener is off, so there is nowhere for the program to send its requests', fix: 'aquaman init --agent <agent> --loopback' }, 1);
      }
      routeArgs.push('--via-proxy', opts.viaProxy!);
      if (opts.basePath !== undefined) routeArgs.push('--base-path', opts.basePath);
    }
    if (opts.env) {
      const check = spawnSync('aquaman-coder', ['bind', bindSpec, '--check', ...routeArgs, '--json'], { encoding: 'utf-8' });
      if (check.error) {
        out({ status: 'error', ref, error: 'aquaman-coder is not installed, so --env cannot bind anything', fix: 'npm install -g aquaman-coder' }, 1);
      }
      if (check.status !== 0) {
        let detail: { error?: string; fix?: string } = {};
        try { detail = JSON.parse(check.stdout); } catch { /* keep the generic message */ }
        out({
          status: 'error',
          ref,
          error: detail.error ?? 'No project covers the current directory',
          fix: detail.fix ?? 'Run from the project directory, after: aquaman init --agent <agent> --no-hooks',
        }, 1);
      }
    }

    const response = await proxyPost(
      path.join(getConfigDir(), 'proxy.sock'),
      '/broker/request',
      { service: parsed!.service, key: parsed!.key, project: process.cwd(), timeout_seconds: timeoutSeconds, ...(routeArgs.length ? { routed: true } : {}), ...(opts.from !== undefined ? { from: opts.from } : {}) },
      (timeoutSeconds + 30) * 1000,
    );
    if ('error' in response) {
      out({ status: 'error', ref, error: response.error, code: response.code, fix: 'Start the daemon in the background: aquaman init --agent <agent> --no-hooks   (in a terminal of your own: aquaman daemon)' }, 4);
    }
    const { status, json } = response as { status: number; json: any };
    if (status !== 200) {
      out({ status: 'error', ref, error: json.error, code: json.code, fix: json.fix }, 4);
    }

    const result: Record<string, unknown> = { status: json.status, ref, reason: json.reason, fix: json.fix };
    const usable = json.status === 'ready' || json.status === 'stored' || json.status === 'approved' || json.status === 'linked';
    if (!usable && opts.env && typeof result.fix === 'string') {
      // The by-hand route has to end in the same place this command would have.
      result.fix = `${result.fix} && aquaman coder bind ${bindSpec}${routeArgs.length ? ` ${routeArgs.join(' ')}` : ''}`;
    }
    if (usable && opts.env) {
      const bind = spawnSync('aquaman-coder', ['bind', bindSpec, ...routeArgs, '--json'], { encoding: 'utf-8' });
      if (bind.status === 0) {
        result.env = opts.env;
        if (opts.viaProxy) {
          try { result.via_proxy = JSON.parse(bind.stdout).via_proxy; } catch { result.via_proxy = { url_env: opts.viaProxy }; }
        }
      } else {
        result.env_error = bind.error
          ? 'aquaman-coder is not installed (npm install -g aquaman-coder)'
          : (bind.stderr || bind.stdout || '').trim().split('\n').pop();
        result.fix = `aquaman coder bind ${opts.env}=${ref}${routeArgs.length ? ` ${routeArgs.join(' ')}` : ''}`;
      }
    }
    out(result, usable ? 0 : json.status === 'declined' ? 2 : 3);
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

      console.log(`\n  \u{1F419} aquaman ${aqua(VERSION)} \u2014 Time to put your secrets somewhere safe.\n`);
      console.log('  Scanning for plaintext credentials...\n');

      const openclawStateDir = openclawPaths().stateDir;
      const openclawConfigPath = findOpenClawConfig(opts.config || openclawPaths().configPath);
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
          const unstorablePlugins: Array<{ service: string; reason: string }> = [];
          const pluginMappings = extractPluginCredentials(config, unstorablePlugins);
          for (const s of unstorablePlugins) {
            console.log(`  Skipped plugin ${JSON.stringify(s.service)}: ${s.reason}. Its credentials stay in openclaw.json.\n`);
          }
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
          // The stored form, so no environment override is written back.
          const updatedConfig = loadStoredConfig();
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
        let openclawOnPath = false;
        try {
          const { execSync } = await import('node:child_process');
          execSync('which openclaw', { stdio: 'pipe' });
          openclawOnPath = true;
        } catch { /* not installed */ }
        const cleanupResult = await cleanupSources(openclawConfigPath, credentialsDir, migratedResults, (before, after) =>
          applyOpenClawPatch(configMergePatch(before, after), {
            patchDir: getConfigDir(),
            binary: openclawOnPath ? 'openclaw' : null,
            current: before,
            configPath: openclawConfigPath,
            // The file that was read is the file to change, also when it was named with --config.
            env: { ...process.env, OPENCLAW_CONFIG_PATH: openclawConfigPath },
          }));
        for (const d of cleanupResult.deleted) {
          console.log(`  ${green('\u2713')} ${d.description}`);
        }
        for (const e of cleanupResult.errors) {
          console.log(`  \u2717 ${e.source}: ${e.error}`);
        }
        if (cleanupResult.deleted.length > 0) {
          console.log('');
        }
        if (cleanupResult.errors.length > 0) {
          // The credentials are in the vault, but plaintext the user asked to
          // have removed is still on disk.
          console.log('  Plaintext originals remain where removal failed. Fix the cause and remove them by hand.');
          process.exit(1);
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
        bitwardenCollectionId: config.credentials.bitwardenCollectionId,
        keeperFolderUid: config.credentials.keeperFolderUid,
        keeperConfigPath: config.credentials.keeperConfigPath
      });
      const creds = await listCredentials(store);
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
      // An Agent Substrate fetch is recorded with the actor it was for as its session.
      return `${entry.data.service} ${entry.data.operation} ${entry.data.success ? 'OK' : `FAIL: ${entry.data.error || 'unknown'}`}${entry.data.note ? ` (${entry.data.note})` : ''}${typeof entry.sessionId === 'string' && entry.sessionId.startsWith('actor/') ? ` for ${entry.sessionId}` : ''}`;
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

// `aquaman service`: the login item that keeps the daemon running across reboots.
const serviceCliHelpers: ServiceCliHelpers = {
  cliPath: __cliFilename, proxyPost, proxyHealthy, proxyPid, readPidFile, removePidFile, isProcessRunning,
};
registerServiceCommands(program, serviceCliHelpers);
registerUnlockCommands(program, proxyPost);

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
