/**
 * Dynamic service registry for credential proxy
 * Loads builtin services and user-defined services from YAML configuration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';

export interface ServiceDefinition {
  name: string;
  upstream: string;
  authHeader: string;
  authPrefix?: string;
  credentialKey: string;
  description?: string;
}

export interface ServiceRegistryOptions {
  configPath?: string;
  builtinServices?: boolean;
}

interface ServicesConfig {
  services: ServiceDefinition[];
}

const BUILTIN_SERVICES: ServiceDefinition[] = [
  {
    name: 'anthropic',
    upstream: 'https://api.anthropic.com',
    authHeader: 'x-api-key',
    credentialKey: 'api_key',
    description: 'Anthropic Claude API'
  },
  {
    name: 'openai',
    upstream: 'https://api.openai.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'api_key',
    description: 'OpenAI API'
  },
  {
    name: 'slack',
    upstream: 'https://slack.com/api',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'bot_token',
    description: 'Slack API'
  },
  {
    name: 'discord',
    upstream: 'https://discord.com/api',
    authHeader: 'Authorization',
    authPrefix: 'Bot ',
    credentialKey: 'bot_token',
    description: 'Discord API'
  },
  {
    name: 'github',
    upstream: 'https://api.github.com',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    credentialKey: 'token',
    description: 'GitHub API'
  }
];

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

    // Load user services (override builtins if same name)
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
   * Convert to the old SERVICE_CONFIGS format for backwards compatibility
   */
  toConfigMap(): Record<string, { upstream: string; authHeader: string; authPrefix?: string; credentialKey: string }> {
    const result: Record<string, { upstream: string; authHeader: string; authPrefix?: string; credentialKey: string }> = {};
    for (const [name, service] of this.services) {
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

    if (!service.authHeader || typeof service.authHeader !== 'string') {
      return { valid: false, error: 'authHeader is required and must be a string' };
    }

    if (!service.credentialKey || typeof service.credentialKey !== 'string') {
      return { valid: false, error: 'credentialKey is required and must be a string' };
    }

    if (service.authPrefix !== undefined && typeof service.authPrefix !== 'string') {
      return { valid: false, error: 'authPrefix must be a string if provided' };
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
   * Get the list of builtin service names
   */
  static getBuiltinServiceNames(): string[] {
    return BUILTIN_SERVICES.map(s => s.name);
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
