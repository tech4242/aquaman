/**
 * OpenClaw Plugin Entry Point
 *
 * This is the main plugin that implements the OpenClaw plugin interface.
 * It provides credential isolation through two modes:
 *
 * 1. Embedded Mode (default): Direct vault access, simpler setup
 * 2. Proxy Mode: Separate process, stronger credential isolation
 */

import { type PluginConfig, mergeConfig, defaultConfig } from './config-schema.js';
import { createEmbeddedMode, type EmbeddedMode } from './embedded.js';
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
  private embeddedMode: EmbeddedMode | null = null;
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

    if (this.config.mode === 'proxy') {
      // Proxy mode: Start separate process
      await this.initProxyMode();
    } else {
      // Embedded mode: Direct vault access
      await this.initEmbeddedMode();
    }

    this.initialized = true;
    console.log(`[aquaman] Plugin initialized in ${this.config.mode || 'embedded'} mode`);
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

    this.embeddedMode = null;
    this.initialized = false;

    console.log('[aquaman] Plugin unloaded');
  }

  /**
   * Initialize embedded mode
   */
  private async initEmbeddedMode(): Promise<void> {
    this.embeddedMode = createEmbeddedMode({
      config: this.config
    });

    await this.embeddedMode.initialize();

    // Set environment variables for OpenClaw
    this.configureEnvironment();
  }

  /**
   * Initialize proxy mode
   */
  private async initProxyMode(): Promise<void> {
    if (!this.config.proxyAutoStart) {
      console.log('[aquaman] Proxy auto-start disabled');
      return;
    }

    this.proxyManager = createProxyManager({
      config: this.config,
      onReady: (info) => {
        console.log(`[aquaman] Proxy ready at ${info.baseUrl}`);
        this.configureEnvironmentForProxy(info);
      },
      onError: (error) => {
        console.error('[aquaman] Proxy error:', error);
      },
      onExit: (code) => {
        console.log(`[aquaman] Proxy exited with code ${code}`);
      }
    });

    // Also initialize embedded mode for credential management
    this.embeddedMode = createEmbeddedMode({
      config: this.config
    });
    await this.embeddedMode.initialize();

    // Start proxy
    try {
      const info = await this.proxyManager.start();
      this.configureEnvironmentForProxy(info);
      this.activateHttpInterceptor(info.baseUrl);
    } catch (error) {
      console.error('[aquaman] Failed to start proxy:', error);
      console.log('[aquaman] Falling back to embedded mode');
      this.configureEnvironment();
    }
  }

  /**
   * Activate HTTP fetch interceptor for channel credential isolation.
   */
  private activateHttpInterceptor(proxyBaseUrl: string): void {
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
      proxyBaseUrl,
      hostMap,
      log: (msg) => console.log(msg),
    });

    this.httpInterceptor.activate();
  }

  /**
   * Configure environment variables for embedded mode
   * In embedded mode, we still set base URLs pointing to a local proxy
   * so credential injection works consistently.
   */
  private configureEnvironment(): void {
    const services = this.config.services || defaultConfig.services;
    const port = this.config.proxyPort || 8081;
    const baseUrl = `http://127.0.0.1:${port}`;

    this.setServiceEnvironmentVariables(services!, baseUrl);
    console.log('[aquaman] Embedded mode active - credentials available via plugin');
  }

  /**
   * Configure environment variables to route through proxy
   */
  private configureEnvironmentForProxy(info: ProxyConnectionInfo): void {
    const services = this.config.services || defaultConfig.services;
    this.setServiceEnvironmentVariables(services!, info.baseUrl);

    // Handle TLS
    if (info.protocol === 'https') {
      if (this.config.tlsCertPath) {
        this.setEnvVar('NODE_EXTRA_CA_CERTS', this.config.tlsCertPath);
      } else {
        // Development: disable TLS verification for self-signed certs
        this.setEnvVar('NODE_TLS_REJECT_UNAUTHORIZED', '0');
      }
    }
  }

  /**
   * Set environment variables for configured services
   */
  private setServiceEnvironmentVariables(services: string[], baseUrl: string): void {
    for (const service of services) {
      const serviceUrl = `${baseUrl}/${service}`;

      switch (service) {
        case 'anthropic':
          this.setEnvVar('ANTHROPIC_BASE_URL', serviceUrl);
          this.setEnvVar('ANTHROPIC_API_KEY', 'aquaman-proxy-managed');
          break;
        case 'openai':
          this.setEnvVar('OPENAI_BASE_URL', serviceUrl);
          this.setEnvVar('OPENAI_API_KEY', 'aquaman-proxy-managed');
          break;
        case 'github':
          this.setEnvVar('GITHUB_API_URL', serviceUrl);
          this.setEnvVar('GITHUB_TOKEN', 'aquaman-proxy-managed');
          break;
        case 'slack':
          this.setEnvVar('SLACK_API_URL', serviceUrl);
          this.setEnvVar('SLACK_BOT_TOKEN', 'aquaman-proxy-managed');
          break;
        case 'discord':
          this.setEnvVar('DISCORD_API_URL', serviceUrl);
          this.setEnvVar('DISCORD_BOT_TOKEN', 'aquaman-proxy-managed');
          break;
        default:
          const envKey = `${service.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
          this.setEnvVar(envKey, serviceUrl);
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
      embeddedMode: this.embeddedMode || undefined,
      proxyManager: this.proxyManager || undefined
    };

    return executeCommand(ctx, command, args);
  }

  /**
   * Get credential (for embedded mode)
   */
  async getCredential(service: string, key: string): Promise<string | null> {
    if (!this.embeddedMode) {
      throw new Error('Plugin not initialized');
    }
    return this.embeddedMode.getCredential(service, key);
  }

  /**
   * Set credential (for embedded mode)
   */
  async setCredential(service: string, key: string, value: string): Promise<void> {
    if (!this.embeddedMode) {
      throw new Error('Plugin not initialized');
    }
    return this.embeddedMode.setCredential(service, key, value);
  }

  /**
   * List credentials
   */
  async listCredentials(service?: string): Promise<Array<{ service: string; key: string }>> {
    if (!this.embeddedMode) {
      throw new Error('Plugin not initialized');
    }
    return this.embeddedMode.listCredentials(service);
  }

  /**
   * Get plugin status
   */
  getStatus(): {
    initialized: boolean;
    mode: string;
    backend: string;
    proxyRunning: boolean;
    services: string[];
  } {
    return {
      initialized: this.initialized,
      mode: this.config.mode || 'embedded',
      backend: this.config.backend || 'keychain',
      proxyRunning: this.proxyManager?.isRunning() || false,
      services: this.config.services || []
    };
  }

  /**
   * Get current operating mode
   */
  getMode(): 'embedded' | 'proxy' {
    return (this.config.mode as 'embedded' | 'proxy') || 'embedded';
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
      embeddedMode: this.embeddedMode || undefined,
      proxyManager: this.proxyManager || undefined
    };

    return getAvailableCommands(ctx);
  }

  /**
   * Get proxy URL for a service (proxy mode only)
   */
  getProxyUrl(service: string): string | null {
    return this.proxyManager?.getServiceUrl(service) || null;
  }

  /**
   * Check if proxy is healthy
   */
  async isProxyHealthy(): Promise<boolean> {
    return this.proxyManager?.healthCheck() || false;
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
