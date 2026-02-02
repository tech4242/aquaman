/**
 * OpenClaw configuration management
 * Generates proxy-aware configs for OpenClaw
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const OPENCLAW_DIR = path.join(os.homedir(), '.openclaw');
const MODELS_JSON = path.join(OPENCLAW_DIR, 'models.json');
const AUTH_PROFILES = path.join(OPENCLAW_DIR, 'auth-profiles.json');

export interface OpenClawConfig {
  providers?: Record<string, { baseUrl?: string; apiKey?: string }>;
  [key: string]: unknown;
}

export function getOpenClawDir(): string {
  return OPENCLAW_DIR;
}

export function openclawConfigExists(): boolean {
  return fs.existsSync(OPENCLAW_DIR);
}

export function backupOpenClawConfig(): { models?: string; auth?: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backups: { models?: string; auth?: string } = {};

  if (fs.existsSync(MODELS_JSON)) {
    const backupPath = `${MODELS_JSON}.backup-${timestamp}`;
    fs.copyFileSync(MODELS_JSON, backupPath);
    backups.models = backupPath;
  }

  if (fs.existsSync(AUTH_PROFILES)) {
    const backupPath = `${AUTH_PROFILES}.backup-${timestamp}`;
    fs.copyFileSync(AUTH_PROFILES, backupPath);
    backups.auth = backupPath;
  }

  return backups;
}

export function generateProxyModelsConfig(credentialProxyPort: number): OpenClawConfig {
  // Load existing config if present
  let existing: OpenClawConfig = {};
  if (fs.existsSync(MODELS_JSON)) {
    try {
      existing = JSON.parse(fs.readFileSync(MODELS_JSON, 'utf-8'));
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  const proxyBase = `http://127.0.0.1:${credentialProxyPort}`;

  return {
    ...existing,
    providers: {
      ...existing.providers,
      anthropic: {
        ...existing.providers?.anthropic,
        baseUrl: `${proxyBase}/anthropic/v1`
      },
      openai: {
        ...existing.providers?.openai,
        baseUrl: `${proxyBase}/openai/v1`
      }
    }
  };
}

export function writeModelsConfig(config: OpenClawConfig): void {
  if (!fs.existsSync(OPENCLAW_DIR)) {
    fs.mkdirSync(OPENCLAW_DIR, { recursive: true });
  }
  fs.writeFileSync(MODELS_JSON, JSON.stringify(config, null, 2), 'utf-8');
}

export function clearAuthProfiles(): void {
  // Write empty auth profiles so OpenClaw doesn't complain
  fs.writeFileSync(AUTH_PROFILES, '{}', { mode: 0o600 });
}

export function readAuthProfiles(): Record<string, unknown> | null {
  if (!fs.existsSync(AUTH_PROFILES)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(AUTH_PROFILES, 'utf-8'));
  } catch {
    return null;
  }
}
