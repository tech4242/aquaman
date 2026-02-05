/**
 * OpenClaw integration - manages configuration and launching
 *
 * This module provides:
 * - Detection of OpenClaw installation
 * - Configuration of environment variables for proxy integration
 * - Launching OpenClaw with the correct configuration
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateOpenClawEnv, writeEnvFile, appendToShellRc, formatEnvForDisplay } from './env-writer.js';
import type { WrapperConfig, ServiceConfig } from 'aquaman-core';

export interface OpenClawInfo {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface LaunchOptions {
  args?: string[];
  cwd?: string;
  inheritStdio?: boolean;
}

export class OpenClawIntegration {
  private config: WrapperConfig;
  private services: ServiceConfig[];

  constructor(config: WrapperConfig, services: ServiceConfig[]) {
    this.config = config;
    this.services = services;
  }

  /**
   * Detect if OpenClaw is installed and get version info
   */
  async detectOpenClaw(): Promise<OpenClawInfo> {
    const binaryPath = this.config.openclaw.binaryPath || 'openclaw';

    return new Promise((resolve) => {
      const proc = spawn(binaryPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let stdout = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.on('error', () => {
        resolve({ installed: false });
      });

      proc.on('close', (code) => {
        if (code === 0 && stdout) {
          // Parse version from output (e.g., "openclaw 1.2.3")
          const match = stdout.match(/openclaw\s+(\d+\.\d+\.\d+)/i);
          resolve({
            installed: true,
            version: match ? match[1] : stdout.trim(),
            path: binaryPath
          });
        } else {
          resolve({ installed: false });
        }
      });
    });
  }

  /**
   * Configure environment variables for OpenClaw
   */
  async configureOpenClaw(proxyPort: number, tlsEnabled: boolean): Promise<Record<string, string>> {
    const certPath = this.config.credentials.tls?.certPath;

    const env = generateOpenClawEnv({
      proxyHost: '127.0.0.1',
      proxyPort,
      tlsEnabled,
      services: this.services,
      nodeExtraCaCerts: tlsEnabled && certPath && fs.existsSync(certPath) ? certPath : undefined
    });

    return env;
  }

  /**
   * Write configuration according to the configured method
   */
  async writeConfiguration(env: Record<string, string>): Promise<string> {
    switch (this.config.openclaw.configMethod) {
      case 'dotenv': {
        const envPath = path.join(process.cwd(), '.env.aquaman');
        writeEnvFile(env, envPath);
        return envPath;
      }

      case 'shell-rc': {
        return appendToShellRc(env);
      }

      case 'env':
      default:
        // Return formatted string for display/export
        return formatEnvForDisplay(env);
    }
  }

  /**
   * Launch OpenClaw with the configured environment
   */
  async launchOpenClaw(options: LaunchOptions = {}): Promise<ChildProcess> {
    const info = await this.detectOpenClaw();

    if (!info.installed) {
      throw new Error(
        'OpenClaw not found. Install it with: npm install -g openclaw\n' +
        'Or specify the path in config: openclaw.binaryPath'
      );
    }

    const env = await this.configureOpenClaw(
      this.config.credentials.proxyPort,
      this.config.credentials.tls?.enabled ?? false
    );

    const binaryPath = this.config.openclaw.binaryPath || 'openclaw';
    const args = options.args || [];

    const proc = spawn(binaryPath, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: options.inheritStdio ? 'inherit' : ['inherit', 'inherit', 'inherit']
    });

    return proc;
  }

  /**
   * Get environment variables for display (dry-run mode)
   */
  async getEnvForDisplay(): Promise<string> {
    const env = await this.configureOpenClaw(
      this.config.credentials.proxyPort,
      this.config.credentials.tls?.enabled ?? false
    );

    return formatEnvForDisplay(env);
  }
}

export function createOpenClawIntegration(
  config: WrapperConfig,
  services: ServiceConfig[]
): OpenClawIntegration {
  return new OpenClawIntegration(config, services);
}
