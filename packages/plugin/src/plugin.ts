/**
 * OpenClaw Plugin Entry Point
 *
 * This is the main plugin that implements the OpenClaw plugin interface.
 * It provides credential isolation through proxy mode:
 * credentials are held in a separate process and never enter the Gateway.
 */

import { type PluginConfig, mergeConfig, defaultConfig } from './config-schema.js';
import { createProxyManager, type ProxyManager, type ProxyConnectionInfo } from './proxy-manager.js';
import { executeCommand, type CommandContext, type CommandResult, getAvailableCommands, type PluginCommand } from './commands.js';
import { HttpInterceptor, createHttpInterceptor } from './http-interceptor.js';

/**
 * OpenClaw Plugin Interface (simplified for standalone use)
 *
 * When used with actual OpenClaw, this would implement their ToolPlugin interface.
 */
export interface AquamanPluginOptions {
  config?: Partial<PluginConfig>;
}

export class AquamanPlugin {
  /**
   * Plugin name - required by OpenClaw ToolPlugin interface
   */
  readonly name = 'aquaman-plugin';

  private config: PluginConfig;
  private proxyManager: ProxyManager | null = null;
  private httpInterceptor: HttpInterceptor | null = null;
  private initialized = false;
  private environmentVariables: Record<string, string> = {};

  constructor(options: AquamanPluginOptions = {}) {
    this.config = mergeConfig(options.config || {});
  }

  /**
   * Plugin lifecycle: onLoad
   * Called when the plugin is loaded by OpenClaw
   *
   * @param config - Configuration passed from openclaw.json
   */
  async onLoad(config?: Partial<PluginConfig>): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Merge any runtime config with defaults
    if (config) {
      this.config = mergeConfig({ ...this.config, ...config });
    }

    // Validate config
    this.validateConfig();

    console.log('[aquaman] Initializing plugin...');

    await this.initProxyMode();

    this.initialized = true;
    console.log('[aquaman] Plugin initialized in proxy mode');
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    // Vault backend requires address
    if (this.config.backend === 'vault' && !this.config.vaultAddress) {
      throw new Error('Vault backend requires vaultAddress configuration');
    }
  }

  /**
   * Plugin lifecycle: onUnload
   * Called when the plugin is unloaded
   */
  async onUnload(): Promise<void> {
    console.log('[aquaman] Unloading plugin...');

    if (this.httpInterceptor) {
      this.httpInterceptor.deactivate();
      this.httpInterceptor = null;
    }

    if (this.proxyManager) {
      await this.proxyManager.stop();
      this.proxyManager = null;
    }

    this.initialized = false;

    console.log('[aquaman] Plugin unloaded');
  }

  /**
   * Initialize proxy mode
   */
  private async initProxyMode(): Promise<void> {
    this.proxyManager = createProxyManager({
      config: this.config,
      onReady: (info) => {
        console.log(`[aquaman] Proxy ready on ${info.socketPath}`);
        this.configureEnvironmentForProxy();
      },
      onError: (error) => {
        console.error('[aquaman] Proxy error:', error);
      },
      onExit: (code) => {
        console.log(`[aquaman] Proxy exited with code ${code}`);
      }
    });

    // Start proxy
    try {
      const info = await this.proxyManager.start();
      this.configureEnvironmentForProxy();
      this.activateHttpInterceptor(info.socketPath);
    } catch (error) {
      console.error('[aquaman] Failed to start proxy:', error);
    }
  }

  /**
   * Activate HTTP interceptor for channel credential isolation.
   */
  private activateHttpInterceptor(proxySocketPath: string): void {
    // Build host map from the service registry's host patterns
    const hostMap = new Map<string, string>([
      ['api.anthropic.com', 'anthropic'],
      ['api.openai.com', 'openai'],
      ['api.github.com', 'github'],
      ['slack.com', 'slack'],
      ['*.slack.com', 'slack'],
      ['discord.com', 'discord'],
      ['*.discord.com', 'discord'],
      ['api.telegram.org', 'telegram'],
      ['matrix.org', 'matrix'],
      ['*.matrix.org', 'matrix'],
      ['api.line.me', 'line'],
      ['api-data.line.me', 'line'],
      ['api.twitch.tv', 'twitch'],
      ['id.twitch.tv', 'twitch'],
      ['api.twilio.com', 'twilio'],
      ['*.twilio.com', 'twilio'],
      ['api.telnyx.com', 'telnyx'],
      ['api.elevenlabs.io', 'elevenlabs'],
      ['openapi.zalo.me', 'zalo'],
      ['graph.microsoft.com', 'ms-teams'],
      ['open.feishu.cn', 'feishu'],
      ['open.larksuite.com', 'feishu'],
      ['chat.googleapis.com', 'google-chat'],
    ]);

    this.httpInterceptor = createHttpInterceptor({
      socketPath: proxySocketPath,
      hostMap,
      log: (msg) => console.log(msg),
    });

    this.httpInterceptor.activate();
  }

  /**
   * Configure environment variables using sentinel hostname
   */
  private configureEnvironmentForProxy(): void {
    const services = this.config.services || defaultConfig.services;
    for (const service of services!) {
      const serviceUrl = `http://aquaman.local/${service}`;

      switch (service) {
        case 'anthropic':
          this.setEnvVar('ANTHROPIC_BASE_URL', serviceUrl);
          break;
        case 'openai':
          this.setEnvVar('OPENAI_BASE_URL', serviceUrl);
          break;
        case 'github':
          this.setEnvVar('GITHUB_API_URL', serviceUrl);
          break;
        default: {
          const envKey = `${service.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
          this.setEnvVar(envKey, serviceUrl);
        }
      }
    }
  }

  /**
   * Set an environment variable and track it
   */
  private setEnvVar(key: string, value: string): void {
    process.env[key] = value;
    this.environmentVariables[key] = value;
    console.log(`[aquaman] Set ${key}=${value}`);
  }

  /**
   * Execute a slash command
   */
  async executeCommand(command: string, args: string[] = []): Promise<CommandResult> {
    const ctx: CommandContext = {
      config: this.config,
      proxyManager: this.proxyManager || undefined
    };

    return executeCommand(ctx, command, args);
  }

  /**
   * Get plugin status
   */
  getStatus(): {
    initialized: boolean;
    backend: string;
    proxyRunning: boolean;
    services: string[];
  } {
    return {
      initialized: this.initialized,
      backend: this.config.backend || 'keychain',
      proxyRunning: this.proxyManager?.isRunning() || false,
      services: this.config.services || []
    };
  }

  /**
   * Get configured backend
   */
  getBackend(): string {
    return this.config.backend || 'keychain';
  }

  /**
   * Check if plugin is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Get environment variables set by the plugin
   */
  getEnvironmentVariables(): Record<string, string> {
    return { ...this.environmentVariables };
  }

  /**
   * Get available slash commands
   */
  getCommands(): PluginCommand[] {
    const ctx: CommandContext = {
      config: this.config,
      proxyManager: this.proxyManager || undefined
    };

    return getAvailableCommands(ctx);
  }

  /**
   * Check if proxy is healthy
   */
  async isProxyHealthy(): Promise<boolean> {
    return this.proxyManager?.isRunning() || false;
  }
}

/**
 * Create plugin instance
 */
export function createAquamanPlugin(options?: AquamanPluginOptions): AquamanPlugin {
  return new AquamanPlugin(options);
}

/**
 * Default export for OpenClaw plugin loading
 */
export default AquamanPlugin;
