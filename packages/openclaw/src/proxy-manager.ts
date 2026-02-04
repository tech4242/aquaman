/**
 * Proxy process lifecycle manager
 *
 * Spawns and manages the aquaman proxy daemon as a separate process
 * for maximum credential isolation.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PluginConfig } from './config-schema.js';

export interface ProxyConnectionInfo {
  ready: boolean;
  port: number;
  protocol: 'http' | 'https';
  baseUrl: string;
  services: string[];
  backend: string;
}

export interface ProxyManagerOptions {
  config: PluginConfig;
  onReady?: (info: ProxyConnectionInfo) => void;
  onError?: (error: Error) => void;
  onExit?: (code: number | null) => void;
}

export class ProxyManager {
  private process: ChildProcess | null = null;
  private options: ProxyManagerOptions;
  private connectionInfo: ProxyConnectionInfo | null = null;
  private starting = false;
  private startPromise: Promise<ProxyConnectionInfo> | null = null;

  constructor(options: ProxyManagerOptions) {
    this.options = options;
  }

  /**
   * Start the proxy process
   */
  async start(): Promise<ProxyConnectionInfo> {
    if (this.process && this.connectionInfo) {
      return this.connectionInfo;
    }

    if (this.starting && this.startPromise) {
      return this.startPromise;
    }

    this.starting = true;
    this.startPromise = this.doStart();

    try {
      const result = await this.startPromise;
      return result;
    } finally {
      this.starting = false;
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<ProxyConnectionInfo> {
    return new Promise((resolve, reject) => {
      const config = this.options.config;

      // Find aquaman binary
      const binaryPath = this.findAquamanBinary();

      if (!binaryPath) {
        const error = new Error(
          'aquaman proxy binary not found. Install with: npm install -g @aquaman/proxy'
        );
        this.options.onError?.(error);
        reject(error);
        return;
      }

      // Build arguments
      const args = [
        'plugin-mode',
        '--port', String(config.proxyPort || 8081)
      ];

      // Spawn proxy process
      this.process = spawn(binaryPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Pass config through environment
          AQUAMAN_BACKEND: config.backend,
          AQUAMAN_VAULT_ADDRESS: config.vaultAddress,
          AQUAMAN_VAULT_TOKEN: config.vaultToken,
          AQUAMAN_VAULT_NAMESPACE: config.vaultNamespace,
          AQUAMAN_VAULT_MOUNT_PATH: config.vaultMountPath,
          AQUAMAN_1PASSWORD_VAULT: config.onePasswordVault,
          AQUAMAN_1PASSWORD_ACCOUNT: config.onePasswordAccount
        }
      });

      let stdout = '';
      let stderr = '';

      this.process.stdout?.on('data', (data) => {
        stdout += data.toString();

        // Try to parse connection info from first line
        const firstLine = stdout.split('\n')[0];
        if (firstLine && !this.connectionInfo) {
          try {
            const info = JSON.parse(firstLine) as ProxyConnectionInfo;
            if (info.ready) {
              this.connectionInfo = info;
              this.options.onReady?.(info);
              resolve(info);
            }
          } catch {
            // Not JSON yet, keep buffering
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        stderr += data.toString();
        console.error('[aquaman-proxy]', data.toString().trim());
      });

      this.process.on('error', (error) => {
        this.options.onError?.(error);
        reject(error);
      });

      this.process.on('exit', (code) => {
        this.process = null;
        this.connectionInfo = null;
        this.options.onExit?.(code);

        if (!this.connectionInfo) {
          const error = new Error(`Proxy exited with code ${code}: ${stderr || stdout}`);
          reject(error);
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        if (!this.connectionInfo) {
          const error = new Error('Proxy startup timeout');
          this.stop();
          reject(error);
        }
      }, 10000);
    });
  }

  /**
   * Stop the proxy process
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      const proc = this.process!;

      const timeout = setTimeout(() => {
        proc.kill('SIGKILL');
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(timeout);
        this.process = null;
        this.connectionInfo = null;
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  /**
   * Check if proxy is running
   */
  isRunning(): boolean {
    return this.process !== null && this.connectionInfo !== null;
  }

  /**
   * Get connection info
   */
  getConnectionInfo(): ProxyConnectionInfo | null {
    return this.connectionInfo;
  }

  /**
   * Get base URL for a service
   */
  getServiceUrl(service: string): string | null {
    if (!this.connectionInfo) {
      return null;
    }
    return `${this.connectionInfo.baseUrl}/${service}`;
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    if (!this.connectionInfo) {
      return false;
    }

    try {
      const response = await fetch(`${this.connectionInfo.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Find the aquaman binary
   */
  private findAquamanBinary(): string | null {
    // Check common locations
    const locations = [
      // In node_modules
      path.join(process.cwd(), 'node_modules', '.bin', 'aquaman'),
      path.join(process.cwd(), 'node_modules', '@aquaman', 'proxy', 'dist', 'cli', 'index.js'),

      // Global install
      '/usr/local/bin/aquaman',

      // In PATH (will use which in spawn)
      'aquaman'
    ];

    for (const loc of locations) {
      if (loc === 'aquaman') {
        // Check if in PATH
        try {
          const { execSync } = require('child_process');
          execSync('which aquaman', { stdio: 'ignore' });
          return 'aquaman';
        } catch {
          continue;
        }
      }

      if (fs.existsSync(loc)) {
        return loc;
      }
    }

    return null;
  }
}

export function createProxyManager(options: ProxyManagerOptions): ProxyManager {
  return new ProxyManager(options);
}
