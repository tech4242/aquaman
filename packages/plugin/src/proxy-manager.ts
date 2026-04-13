/**
 * Proxy process lifecycle manager
 *
 * Spawns and manages the aquaman proxy daemon as a separate process
 * for maximum credential isolation. Communicates via Unix domain socket.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { PluginConfig } from './config-schema.js';

/**
 * Find the aquaman proxy binary.
 *
 * Search order:
 * 1. Plugin's own node_modules/.bin/aquaman (bundled dep — version-matched)
 * 2. PATH (global install via npm install -g aquaman-proxy)
 */
export function findAquamanProxyBinary(): string | null {
  // 1. Resolve from this file's location → plugin package root → node_modules/.bin/
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(thisDir, '..');
  const localBin = path.join(pluginRoot, 'node_modules', '.bin', 'aquaman');
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  // 2. Search PATH
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'aquaman');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found in this dir
    }
  }

  return null;
}

/**
 * Execute an aquaman proxy CLI command (non-interactive).
 * Captures stdout/stderr and returns them.
 */
export function execAquamanProxyCli(
  args: string[],
  options?: { timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const binary = findAquamanProxyBinary();
    if (!binary) {
      reject(new Error('aquaman proxy binary not found. Install with: npm install -g aquaman-proxy'));
      return;
    }

    const proc = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    const timeout = options?.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`aquaman CLI timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', () => clearTimeout(timer));
  });
}

/**
 * Execute an aquaman proxy CLI command interactively (stdio: inherit).
 * Used for commands that need TTY input (setup, credentials add).
 */
export function execAquamanProxyInteractive(
  args: string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const binary = findAquamanProxyBinary();
    if (!binary) {
      reject(new Error('aquaman proxy binary not found. Install with: npm install -g aquaman-proxy'));
      return;
    }

    const proc = spawn(binary, args, {
      stdio: 'inherit',
      env: process.env,
    });

    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  });
}

export interface ProxyConnectionInfo {
  ready: boolean;
  socketPath: string;
  services: string[];
  backend: string;
  hostMap?: Record<string, string>;
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
      const binaryPath = this.findBinary();

      if (!binaryPath) {
        const error = new Error(
          'aquaman proxy binary not found. Install with: npm install -g aquaman-proxy'
        );
        this.options.onError?.(error);
        reject(error);
        return;
      }

      // Build arguments — UDS is the default, no --port needed
      const args = ['plugin-mode'];

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
          const stderrText = stderr || stdout;
          const error = new Error(`Proxy exited with code ${code}: ${stderrText}`);
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
   * Get socket path
   */
  getSocketPath(): string | null {
    return this.connectionInfo?.socketPath || null;
  }

  /**
   * Find the aquaman proxy binary
   */
  private findBinary(): string | null {
    return findAquamanProxyBinary();
  }
}

export function createProxyManager(options: ProxyManagerOptions): ProxyManager {
  return new ProxyManager(options);
}
