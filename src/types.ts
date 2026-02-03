/**
 * Core types for aquaman-clawed security wrapper
 */

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export type AlertAction = 'block' | 'require_approval' | 'warn' | 'log';

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
  type: 'tool_call' | 'tool_result' | 'policy_violation' | 'approval_request' | 'credential_access';
  sessionId: string;
  agentId: string;
  data: ToolCall | ToolResult | PolicyViolation | ApprovalRequest | CredentialAccess;
  previousHash: string;
  hash: string;
}

export interface PolicyViolation {
  rule: string;
  action: AlertAction;
  severity: RiskLevel;
  toolCall: ToolCall;
  reason: string;
}

export interface ApprovalRequest {
  id: string;
  toolCall: ToolCall;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'timeout';
  requestedAt: Date;
  respondedAt?: Date;
  respondedBy?: string;
}

export interface CredentialAccess {
  service: string;
  operation: 'read' | 'use' | 'rotate';
  success: boolean;
  error?: string;
}

export interface AlertRule {
  id: string;
  name: string;
  pattern?: string | RegExp;
  tools?: string[];
  categories?: string[];
  action: AlertAction;
  severity: RiskLevel;
  message?: string;
}

export interface FilePermissions {
  allowedPaths: string[];
  deniedPaths: string[];
  sensitivePatterns: string[];
}

export interface CommandPermissions {
  allowedCommands: CommandRule[];
  deniedCommands: string[];
  dangerousPatterns: (string | RegExp)[];
}

export interface CommandRule {
  command: string;
  allowedArgs?: string[];
  deniedArgs?: string[];
}

export interface NetworkPermissions {
  defaultAction: 'allow' | 'deny';
  allowedDomains: string[];
  deniedDomains: string[];
  deniedPorts: number[];
}

export interface SandboxConfig {
  openclawImage: string;
  workspace: {
    hostPath: string;
    containerPath: string;
    readOnly: boolean;
  };
  resources?: {
    cpus?: string;
    memory?: string;
  };
  environment?: Record<string, string>;
  enableOpenclawSandbox: boolean; // Enable OpenClaw's internal sandbox.mode for double isolation
}

export interface WrapperConfig {
  wrapper: {
    proxyPort: number;
    upstreamPort: number;
  };
  audit: {
    enabled: boolean;
    logDir: string;
    alertWebhook?: string;
    alertRules: AlertRule[];
  };
  permissions: {
    files: FilePermissions;
    commands: CommandPermissions;
    network: NetworkPermissions;
  };
  credentials: {
    backend: 'keychain' | '1password' | 'vault' | 'encrypted-file';
    proxyPort: number;
    proxiedServices: string[];
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
  };
  approval: {
    channels: ApprovalChannel[];
    timeout: number;
    defaultOnTimeout: 'allow' | 'deny';
  };
  sandbox: SandboxConfig;
}

export interface ApprovalChannel {
  type: 'slack' | 'discord' | 'console';
  webhook?: string;
}

export interface GatewayMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const TOOL_RISK_LEVELS: Record<string, RiskLevel> = {
  // Critical - immediate alert
  'bash': 'critical',
  'sessions_spawn': 'critical',
  'cron_create': 'critical',
  'camera_access': 'critical',
  'screen_record': 'critical',
  'location_access': 'critical',

  // High - monitor
  'file_write': 'high',
  'message_send': 'high',
  'config_change': 'high',

  // Medium - log
  'browser_navigate': 'medium',
  'web_fetch': 'medium',

  // Low - log
  'file_read': 'low',
  'search': 'low'
};

export const DEFAULT_DANGEROUS_PATTERNS = [
  // eslint-disable-next-line no-useless-escape
  /rm\s+-rf\s+[\/~]/,
  /sudo\s+/,
  /chmod\s+777/,
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
  /eval\s+\$/,
  /dd\s+if=/,
  /mkfs\./,
  /:\(\)\s*\{\s*:\|:&\s*\};\s*:/  // fork bomb
];

export const DEFAULT_SENSITIVE_FILE_PATTERNS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/credentials*',
  '**/secrets*',
  '~/.ssh/**',
  '~/.aws/**',
  '~/.gnupg/**',
  '~/.openclaw/auth-profiles.json'
];
