/**
 * Dynamic service registry for credential proxy
 * Loads builtin services and user-defined services from YAML configuration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';

export type AuthMode = 'header' | 'url-path' | 'basic' | 'oauth' | 'none';

export interface OAuthConfig {
  tokenUrl: string;
  clientIdKey: string;
  clientSecretKey: string;
  scope?: string;
  audience?: string;
}

export interface ServiceDefinition {
  name: string;
  upstream: string;
  authHeader: string;
  authPrefix?: string;
  credentialKey: string;
  description?: string;
  /** Auth injection mode. Defaults to 'header' for backward compat. */
  authMode?: AuthMode;
  /** For url-path mode: template with {token} placeholder, e.g. "/bot{token}" */
  authPathTemplate?: string;
  /** Extra credential keys for multi-credential services (e.g. Twilio account_sid + auth_token) */
  additionalCredentialKeys?: string[];
  /** Extra headers to inject from additional credentials, keyed by header name */
  additionalHeaders?: Record<string, { credentialKey: string; prefix?: string }>;
  /** Hostname patterns for HTTP interception (e.g. ['api.telegram.org', '*.slack.com']) */
  hostPatterns?: string[];
  /** OAuth client credentials config for authMode 'oauth' */
  oauthConfig?: OAuthConfig;
}

export interface ServiceRegistryOptions {
  configPath?: string;
  builtinServices?: boolean;
}

interface ServicesConfig {
  services: ServiceDefinition[];
}

const BUILTIN_SERVICES: ServiceDefinition[] = [
  // ── LLM / AI Providers ──────────────────────────────────────────────
  {
    name: 'anthropic',
    upstream: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    credentialKey: 'api_key',
    description: 'Anthropic Claude API',
    authMode: 'header',
    hostPatterns: ['api.anthropic.com']
  },
  {
    name: 'openai',
    upstream: 'https://api.openai.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'api_key',
    description: 'OpenAI API',
    authMode: 'header',
    hostPatterns: ['api.openai.com']
  },
  {
    name: 'github',
    upstream: 'https://api.github.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'token',
    description: 'GitHub API',
    authMode: 'header',
    hostPatterns: ['api.github.com']
  },

  // ── Header Auth Channels ────────────────────────────────────────────
  {
    name: 'slack',
    upstream: 'https://slack.com/api',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'bot_token',
    description: 'Slack API',
    authMode: 'header',
    hostPatterns: ['slack.com', '*.slack.com']
  },
  {
    name: 'discord',
    upstream: 'https://discord.com/api',
    authHeader: 'Authorization',
    authPrefix: 'Bot ',
    credentialKey: 'bot_token',
    description: 'Discord API',
    authMode: 'header',
    hostPatterns: ['discord.com', '*.discord.com']
  },
  {
    name: 'matrix',
    upstream: 'https://matrix-client.matrix.org',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'access_token',
    description: 'Matrix homeserver API',
    authMode: 'header',
    hostPatterns: ['matrix.org', '*.matrix.org']
  },
  {
    name: 'mattermost',
    upstream: 'https://localhost',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'bot_token',
    description: 'Mattermost API (upstream must be overridden)',
    authMode: 'header',
    hostPatterns: []
  },
  {
    name: 'line',
    upstream: 'https://api.line.me',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'channel_access_token',
    description: 'LINE Messaging API',
    authMode: 'header',
    additionalCredentialKeys: ['channel_secret'],
    hostPatterns: ['api.line.me', 'api-data.line.me']
  },
  {
    name: 'twitch',
    upstream: 'https://api.twitch.tv',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'access_token',
    description: 'Twitch API',
    authMode: 'header',
    additionalHeaders: {
      'Client-Id': { credentialKey: 'client_id' }
    },
    hostPatterns: ['api.twitch.tv', 'id.twitch.tv']
  },
  {
    name: 'elevenlabs',
    upstream: 'https://api.elevenlabs.io',
    authHeader: 'xi-api-key',
    credentialKey: 'api_key',
    description: 'ElevenLabs TTS API',
    authMode: 'header',
    hostPatterns: ['api.elevenlabs.io']
  },
  {
    name: 'telnyx',
    upstream: 'https://api.telnyx.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'api_key',
    description: 'Telnyx Communications API',
    authMode: 'header',
    hostPatterns: ['api.telnyx.com']
  },
  {
    name: 'zalo',
    upstream: 'https://openapi.zalo.me',
    authHeader: 'access_token',
    credentialKey: 'bot_token',
    description: 'Zalo Official Account API',
    authMode: 'header',
    hostPatterns: ['openapi.zalo.me']
  },

  // ── URL-Path Auth Channels ──────────────────────────────────────────
  {
    name: 'telegram',
    upstream: 'https://api.telegram.org',
    authHeader: '',
    credentialKey: 'bot_token',
    description: 'Telegram Bot API',
    authMode: 'url-path',
    authPathTemplate: '/bot{token}',
    hostPatterns: ['api.telegram.org']
  },

  // ── HTTP Basic Auth Channels ────────────────────────────────────────
  {
    name: 'twilio',
    upstream: 'https://api.twilio.com',
    authHeader: 'Authorization',
    credentialKey: 'account_sid',
    description: 'Twilio Communications API',
    authMode: 'basic',
    additionalCredentialKeys: ['auth_token'],
    hostPatterns: ['api.twilio.com', '*.twilio.com']
  },
  {
    name: 'bluebubbles',
    upstream: 'https://localhost',
    authHeader: 'Authorization',
    credentialKey: 'password',
    description: 'BlueBubbles iMessage bridge (upstream must be overridden)',
    authMode: 'basic',
    additionalCredentialKeys: [],
    hostPatterns: []
  },
  {
    name: 'nextcloud',
    upstream: 'https://localhost',
    authHeader: 'Authorization',
    credentialKey: 'api_user',
    description: 'Nextcloud Talk API (upstream must be overridden)',
    authMode: 'basic',
    additionalCredentialKeys: ['api_password'],
    hostPatterns: []
  },

  // ── OAuth Client Credentials Channels ───────────────────────────────
  {
    name: 'ms-teams',
    upstream: 'https://graph.microsoft.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'client_id',
    description: 'Microsoft Teams via Graph API',
    authMode: 'oauth',
    oauthConfig: {
      tokenUrl: 'https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token',
      clientIdKey: 'client_id',
      clientSecretKey: 'client_secret',
      scope: 'https://graph.microsoft.com/.default'
    },
    additionalCredentialKeys: ['client_secret', 'tenant_id'],
    hostPatterns: ['graph.microsoft.com']
  },
  {
    name: 'feishu',
    upstream: 'https://open.feishu.cn',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'app_id',
    description: 'Feishu (Lark) Open API',
    authMode: 'oauth',
    oauthConfig: {
      tokenUrl: 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      clientIdKey: 'app_id',
      clientSecretKey: 'app_secret'
    },
    additionalCredentialKeys: ['app_secret'],
    hostPatterns: ['open.feishu.cn', 'open.larksuite.com']
  },
  {
    name: 'google-chat',
    upstream: 'https://chat.googleapis.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'service_account',
    description: 'Google Chat API',
    authMode: 'oauth',
    oauthConfig: {
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientIdKey: 'service_account',
      clientSecretKey: 'service_account',
      scope: 'https://www.googleapis.com/auth/chat.bot'
    },
    hostPatterns: ['chat.googleapis.com']
  },

  // ── Session / No-Proxy Channels (at-rest storage only) ─────────────
  {
    name: 'nostr',
    upstream: '',
    authHeader: '',
    credentialKey: 'private_key',
    description: 'Nostr relay signing key (at-rest storage only)',
    authMode: 'none',
    hostPatterns: []
  },
  {
    name: 'tlon',
    upstream: '',
    authHeader: '',
    credentialKey: 'code',
    description: 'Tlon/Urbit access code (at-rest storage only)',
    authMode: 'none',
    hostPatterns: []
  }
];

const BUILTIN_SERVICE_NAMES = new Set(BUILTIN_SERVICES.map(s => s.name));

export class ServiceRegistry {
  private services: Map<string, ServiceDefinition> = new Map();
  private configPath: string;
  private includeBuiltin: boolean;

  constructor(options?: ServiceRegistryOptions) {
    this.configPath = options?.configPath || path.join(os.homedir(), '.aquaman', 'services.yaml');
    this.includeBuiltin = options?.builtinServices !== false;
    this.load();
  }

  private load(): void {
    // Load builtin services first
    if (this.includeBuiltin) {
      for (const service of BUILTIN_SERVICES) {
        this.services.set(service.name, service);
      }
    }

    // Load user services (builtins cannot be overridden via YAML)
    this.loadUserServices();
  }

  private loadUserServices(): void {
    if (!fs.existsSync(this.configPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      const config = parseYaml(content) as ServicesConfig;

      if (config?.services && Array.isArray(config.services)) {
        for (const service of config.services) {
          if (BUILTIN_SERVICE_NAMES.has(service.name)) {
            console.warn(`Cannot override builtin service "${service.name}" via config file — ignoring`);
            continue;
          }
          const validation = this.validateService(service);
          if (validation.valid) {
            this.services.set(service.name, service);
          } else {
            console.warn(`Invalid service "${service.name}": ${validation.error}`);
          }
        }
      }
    } catch (error) {
      console.error(`Failed to load services from ${this.configPath}:`, error);
    }
  }

  get(name: string): ServiceDefinition | undefined {
    return this.services.get(name);
  }

  getAll(): ServiceDefinition[] {
    return Array.from(this.services.values());
  }

  getNames(): string[] {
    return Array.from(this.services.keys());
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  /**
   * Convert to the old SERVICE_CONFIGS format for backwards compatibility.
   * Only includes services that have a proxiable upstream (excludes 'none' mode).
   */
  toConfigMap(): Record<string, { upstream: string; authHeader: string; authPrefix?: string; credentialKey: string }> {
    const result: Record<string, { upstream: string; authHeader: string; authPrefix?: string; credentialKey: string }> = {};
    for (const [name, service] of this.services) {
      if (service.authMode === 'none') continue;
      result[name] = {
        upstream: service.upstream,
        authHeader: service.authHeader,
        authPrefix: service.authPrefix,
        credentialKey: service.credentialKey
      };
    }
    return result;
  }

  validateService(service: Partial<ServiceDefinition>): { valid: boolean; error?: string } {
    if (!service.name || typeof service.name !== 'string') {
      return { valid: false, error: 'name is required and must be a string' };
    }

    const mode = service.authMode || 'header';

    // 'none' mode services are at-rest storage only — no upstream or auth needed
    if (mode === 'none') {
      if (!service.credentialKey || typeof service.credentialKey !== 'string') {
        return { valid: false, error: 'credentialKey is required and must be a string' };
      }
      return { valid: true };
    }

    if (!service.upstream || typeof service.upstream !== 'string') {
      return { valid: false, error: 'upstream is required and must be a string' };
    }

    // Validate upstream URL
    try {
      const url = new URL(service.upstream);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return { valid: false, error: 'upstream must use http or https protocol' };
      }
    } catch {
      return { valid: false, error: 'upstream must be a valid URL' };
    }

    // authHeader is required for 'header' and 'basic' modes, optional for others
    if ((mode === 'header' || mode === 'basic') && !service.authHeader) {
      return { valid: false, error: 'authHeader is required for header and basic auth modes' };
    }

    if (!service.credentialKey || typeof service.credentialKey !== 'string') {
      return { valid: false, error: 'credentialKey is required and must be a string' };
    }

    if (service.authPrefix !== undefined && typeof service.authPrefix !== 'string') {
      return { valid: false, error: 'authPrefix must be a string if provided' };
    }

    if (mode === 'url-path' && !service.authPathTemplate) {
      return { valid: false, error: 'authPathTemplate is required for url-path auth mode' };
    }

    if (mode === 'oauth' && !service.oauthConfig) {
      return { valid: false, error: 'oauthConfig is required for oauth auth mode' };
    }

    return { valid: true };
  }

  /**
   * Validate all services in a config file
   */
  static validateConfigFile(configPath: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!fs.existsSync(configPath)) {
      return { valid: false, errors: ['Config file does not exist'] };
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const config = parseYaml(content) as ServicesConfig;

      if (!config?.services) {
        return { valid: false, errors: ['Config must have a "services" array'] };
      }

      if (!Array.isArray(config.services)) {
        return { valid: false, errors: ['"services" must be an array'] };
      }

      const registry = new ServiceRegistry({ builtinServices: false });
      const names = new Set<string>();

      for (let i = 0; i < config.services.length; i++) {
        const service = config.services[i];
        const validation = registry.validateService(service);

        if (!validation.valid) {
          errors.push(`Service ${i + 1}: ${validation.error}`);
        } else if (BUILTIN_SERVICE_NAMES.has(service.name)) {
          errors.push(`Service ${i + 1}: cannot override builtin service "${service.name}"`);
        } else if (names.has(service.name)) {
          errors.push(`Service ${i + 1}: duplicate name "${service.name}"`);
        } else {
          names.add(service.name);
        }
      }

      return { valid: errors.length === 0, errors };
    } catch (error) {
      return { valid: false, errors: [`Failed to parse YAML: ${error}`] };
    }
  }

  /**
   * Build a hostname → service name map for HTTP interception.
   * Only includes services with hostPatterns defined.
   */
  buildHostMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const [name, service] of this.services) {
      if (service.hostPatterns) {
        for (const pattern of service.hostPatterns) {
          map.set(pattern, name);
        }
      }
    }
    return map;
  }

  /**
   * Get the list of builtin service names
   */
  static getBuiltinServiceNames(): string[] {
    return BUILTIN_SERVICES.map(s => s.name);
  }

  /**
   * Check whether a service name is a builtin (protected from override via config/register)
   */
  static isBuiltinService(name: string): boolean {
    return BUILTIN_SERVICE_NAMES.has(name);
  }

  /**
   * Reload services from config file
   */
  reload(): void {
    this.services.clear();
    this.load();
  }

  /**
   * Override a service definition (useful for testing to redirect to mock servers)
   */
  override(name: string, partial: Partial<ServiceDefinition>): void {
    const existing = this.services.get(name);
    if (!existing) {
      throw new Error(`Service "${name}" not found in registry`);
    }
    this.services.set(name, { ...existing, ...partial });
  }

  /**
   * Add a new service dynamically (useful for testing)
   */
  register(service: ServiceDefinition): void {
    if (BUILTIN_SERVICE_NAMES.has(service.name)) {
      throw new Error(`Cannot register service "${service.name}": name conflicts with a builtin service`);
    }
    const validation = this.validateService(service);
    if (!validation.valid) {
      throw new Error(`Invalid service: ${validation.error}`);
    }
    this.services.set(service.name, service);
  }
}

export function createServiceRegistry(options?: ServiceRegistryOptions): ServiceRegistry {
  return new ServiceRegistry(options);
}
