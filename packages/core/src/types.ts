/**
 * Core types for aquaman credential isolation layer
 *
 * This module focuses on unique features NOT in OpenClaw:
 * - Credential proxy with TLS
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
  backend: 'keychain' | '1password' | 'vault' | 'encrypted-file' | 'keepassxc';
  proxyPort: number;
  proxiedServices: string[];
  bindAddress?: string;
  encryptionPassword?: string;
  tls?: {
    enabled: boolean;
    certPath?: string;
    keyPath?: string;
    autoGenerate?: boolean;
  };
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

export interface WrapperConfig {
  credentials: CredentialsConfig;
  audit: AuditConfig;
  services: ServicesConfig;
  openclaw: OpenClawConfig;
}

export type CredentialBackend = 'keychain' | '1password' | 'vault' | 'encrypted-file' | 'keepassxc';
