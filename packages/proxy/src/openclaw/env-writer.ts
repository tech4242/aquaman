/**
 * Environment configuration generator for OpenClaw integration
 *
 * Generates environment variables to configure OpenClaw to use
 * the aquaman credential proxy instead of direct API access.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ServiceConfig } from 'aquaman-core';

export interface EnvConfig {
  proxyHost: string;
  proxyPort: number;
  tlsEnabled: boolean;
  services: ServiceConfig[];
  nodeExtraCaCerts?: string;
}

/**
 * Generate environment variables for OpenClaw to use the credential proxy
 */
export function generateOpenClawEnv(config: EnvConfig): Record<string, string> {
  const env: Record<string, string> = {};
  const protocol = config.tlsEnabled ? 'https' : 'http';

  // For each service, set the base URL to point to our proxy
  for (const service of config.services) {
    const baseUrl = `${protocol}://${config.proxyHost}:${config.proxyPort}/${service.name}`;

    // Map service names to OpenClaw environment variables
    switch (service.name) {
      case 'anthropic':
        env['ANTHROPIC_BASE_URL'] = baseUrl;
        break;
      case 'openai':
        env['OPENAI_BASE_URL'] = baseUrl;
        break;
      case 'github':
        env['GITHUB_API_URL'] = baseUrl;
        break;
      case 'slack':
        env['SLACK_API_URL'] = baseUrl;
        break;
      case 'discord':
        env['DISCORD_API_URL'] = baseUrl;
        break;
      default:
        // For custom services, use uppercase name with _BASE_URL suffix
        const envKey = `${service.name.toUpperCase().replace(/-/g, '_')}_BASE_URL`;
        env[envKey] = baseUrl;
    }
  }

  // If TLS is enabled with self-signed certs, set NODE_EXTRA_CA_CERTS
  if (config.tlsEnabled && config.nodeExtraCaCerts) {
    env['NODE_EXTRA_CA_CERTS'] = config.nodeExtraCaCerts;
  }

  // Disable SSL verification for self-signed certs (development only)
  if (config.tlsEnabled && !config.nodeExtraCaCerts) {
    env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  }

  return env;
}

/**
 * Write environment variables to a .env file
 */
export function writeEnvFile(env: Record<string, string>, filePath: string): void {
  const lines = Object.entries(env)
    .map(([key, value]) => `${key}="${value}"`)
    .join('\n');

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(filePath, lines + '\n', { mode: 0o600 });
}

/**
 * Write environment variables to shell rc file (bashrc/zshrc)
 */
export function appendToShellRc(env: Record<string, string>): string {
  const shell = process.env['SHELL'] || '/bin/bash';
  const rcFile = shell.includes('zsh')
    ? path.join(os.homedir(), '.zshrc')
    : path.join(os.homedir(), '.bashrc');

  const marker = '# aquaman environment';
  const endMarker = '# end aquaman environment';

  let content = '';
  if (fs.existsSync(rcFile)) {
    content = fs.readFileSync(rcFile, 'utf-8');
  }

  // Remove existing aquaman section if present
  const markerIndex = content.indexOf(marker);
  const endMarkerIndex = content.indexOf(endMarker);
  if (markerIndex !== -1 && endMarkerIndex !== -1) {
    content = content.slice(0, markerIndex) + content.slice(endMarkerIndex + endMarker.length + 1);
  }

  // Build new section
  const envLines = Object.entries(env)
    .map(([key, value]) => `export ${key}="${value}"`)
    .join('\n');

  const section = `${marker}\n${envLines}\n${endMarker}\n`;

  // Append to file
  content = content.trimEnd() + '\n\n' + section;
  fs.writeFileSync(rcFile, content, { mode: 0o644 });

  return rcFile;
}

/**
 * Format environment variables for display (dry-run output)
 */
export function formatEnvForDisplay(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `  ${key}=${value}`)
    .join('\n');
}
