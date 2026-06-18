/**
 * Hermes integration (v0.13.0+)
 *
 * Detects a local Hermes (NousResearch) install and wires it to the aquaman
 * loopback listener by writing provider base-URL + placeholder-key env vars
 * into `~/.hermes/.env`. Unlike the OpenClaw path there is no in-process
 * plugin doing fetch interception — Hermes is a foreign (Python) host, so the
 * contract is purely: loopback listener on the proxy side + native env vars on
 * the Hermes side. See config-writer.ts for the path/auth rationale.
 */

import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  generateHermesEnv,
  writeHermesEnv,
  formatHermesEnvForDisplay,
  getHermesEnvPath,
  hermesWiredServices,
} from './config-writer.js';
import type { HermesConfig } from '../core/index.js';

export interface HermesInfo {
  installed: boolean;
  version?: string;
  path?: string;
}

export interface HermesIntegrationOptions {
  /** Loopback listener port the env vars should point at. */
  port: number;
  /** Loopback token used as the placeholder api_key. */
  token: string;
  /** Loopback host. Defaults to 127.0.0.1. */
  host?: string;
  /** Services to wire (only anthropic/openai are emitted today). */
  services: string[];
  /** Hermes integration config (configMethod, binaryPath). */
  config?: HermesConfig;
}

/**
 * Detect whether the Hermes CLI is installed and parse its version.
 * Parses lines like "Hermes Agent v0.16.0 (2026.6.5)".
 */
export async function detectHermes(binaryPath = 'hermes'): Promise<HermesInfo> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.on('error', () => resolve({ installed: false }));
    proc.on('close', (code) => {
      if (code === 0 && stdout) {
        const match = stdout.match(/Hermes(?:\s+Agent)?\s+v?(\d+\.\d+\.\d+)/i);
        resolve({
          installed: true,
          version: match ? match[1] : stdout.trim().split('\n')[0],
          path: binaryPath,
        });
      } else {
        resolve({ installed: false });
      }
    });
  });
}

export class HermesIntegration {
  private options: HermesIntegrationOptions;

  constructor(options: HermesIntegrationOptions) {
    this.options = options;
  }

  /** Build the env vars that point Hermes at the loopback listener. */
  configureHermes(): Record<string, string> {
    return generateHermesEnv({
      port: this.options.port,
      token: this.options.token,
      host: this.options.host,
      services: this.options.services,
    });
  }

  /** Which of the requested services actually get wired (anthropic/openai today). */
  wiredServices(): string[] {
    return hermesWiredServices(this.options.services);
  }

  /** Path to the Hermes dotenv file this integration writes. */
  envPath(): string {
    return getHermesEnvPath(os.homedir());
  }

  /**
   * Write the configuration. `dotenv` merges into ~/.hermes/.env; `env`
   * returns a display string for manual export. Returns the destination path
   * (dotenv) or the formatted block (env).
   */
  writeConfiguration(env: Record<string, string>): string {
    const method = this.options.config?.configMethod ?? 'dotenv';
    if (method === 'dotenv') {
      const dest = this.envPath();
      writeHermesEnv(env, dest);
      return dest;
    }
    return formatHermesEnvForDisplay(env);
  }

  getEnvForDisplay(): string {
    return formatHermesEnvForDisplay(this.configureHermes());
  }

  async detect(): Promise<HermesInfo> {
    return detectHermes(this.options.config?.binaryPath || 'hermes');
  }
}

export function createHermesIntegration(options: HermesIntegrationOptions): HermesIntegration {
  return new HermesIntegration(options);
}
