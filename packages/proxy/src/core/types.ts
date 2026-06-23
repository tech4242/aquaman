/**
 * Core types for aquaman credential isolation layer
 *
 * This module focuses on unique features NOT in OpenClaw:
 * - Credential proxy via Unix domain socket
 * - Enterprise backends (1Password, Vault)
 * - Hash-chained tamper-evident audit logs
 * - Dynamic service registry
 */

export interface ToolCall {
  id: string;
  sessionId: string;
  agentId: string;
  tool: string;
  params: Record<string, unknown>;
  timestamp: Date;
}

export interface ToolResult {
  id: string;
  toolCallId: string;
  result: unknown;
  error?: string;
  timestamp: Date;
}

export interface AuditEntry {
  id: string;
  timestamp: Date;
  type: 'tool_call' | 'tool_result' | 'credential_access';
  sessionId: string;
  agentId: string;
  data: ToolCall | ToolResult | CredentialAccess;
  previousHash: string;
  hash: string;
}

export interface CredentialAccess {
  service: string;
  operation: 'read' | 'use' | 'rotate';
  success: boolean;
  error?: string;
}

export interface ServiceConfig {
  name: string;
  upstream: string;
  authHeader: string;
  authPrefix?: string;
  credentialKey: string;
  description?: string;
}

export interface CredentialsConfig {
  backend: 'keychain' | '1password' | 'vault' | 'encrypted-file' | 'keepassxc' | 'systemd-creds' | 'bitwarden';
  proxiedServices: string[];
  encryptionPassword?: string;
  // 1Password options
  onePasswordVault?: string;
  onePasswordAccount?: string;
  // HashiCorp Vault options
  vaultAddress?: string;
  vaultToken?: string;
  vaultNamespace?: string;
  vaultMountPath?: string;
  // KeePassXC options
  keepassxcDatabasePath?: string;
  keepassxcKeyFilePath?: string;
  // systemd-creds options
  systemdCredsDir?: string;
  // Bitwarden options
  bitwardenFolder?: string;
  bitwardenOrganizationId?: string;
  bitwardenCollectionId?: string;
}

export interface AuditConfig {
  enabled: boolean;
  logDir: string;
}

export interface ServicesConfig {
  configPath: string;
}

export interface OpenClawConfig {
  autoLaunch: boolean;
  configMethod: 'env' | 'dotenv' | 'shell-rc';
  binaryPath?: string;
}

/**
 * Opt-in loopback TCP listener (v0.13.0+).
 *
 * Foreign-language agent hosts (Hermes, a Python host) build
 * their own HTTP client internally and expose no transport/socket hook, so a
 * UDS-dialing dispatcher can't be injected. For those hosts the proxy exposes
 * a 127.0.0.1:<port> listener that honors the host's native base_url + api_key
 * convention. This is default-off and never reachable off-box; access control
 * is the generated per-install token (the UDS path stays the default and keeps
 * its 0o600 file-permission gate).
 */
export interface LoopbackConfig {
  enabled: boolean;
  port: number;
  /** Generated at setup; required when enabled. Presented by the host as the provider api_key. */
  token?: string;
  /** Bind address — always loopback. Defaults to 127.0.0.1; never bind 0.0.0.0. */
  host?: string;
}

export interface HermesConfig {
  configMethod: 'env' | 'dotenv';
  binaryPath?: string;
}

export interface WrapperConfig {
  credentials: CredentialsConfig;
  audit: AuditConfig;
  services: ServicesConfig;
  openclaw: OpenClawConfig;
  loopback?: LoopbackConfig;
  hermes?: HermesConfig;
  policy?: Record<string, { defaultAction: 'allow' | 'deny'; rules: Array<{ method: string; path: string; action: 'allow' | 'deny' }> }>;
}

export type CredentialBackend = 'keychain' | '1password' | 'vault' | 'encrypted-file' | 'keepassxc' | 'systemd-creds' | 'bitwarden';
