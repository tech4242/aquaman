/**
 * Configuration loader and validator
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import type { WrapperConfig, AlertRule } from '../types.js';

const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.aquaman');
const CONFIG_FILE = 'config.yaml';

export function getConfigDir(): string {
  return process.env['AQUAMAN_CONFIG_DIR'] || DEFAULT_CONFIG_DIR;
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE);
}

export function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.includes('${HOME}')) {
    return p.replace('${HOME}', os.homedir());
  }
  return p;
}

export function getDefaultConfig(): WrapperConfig {
  return {
    wrapper: {
      proxyPort: 18790,
      upstreamPort: 18789
    },
    audit: {
      enabled: true,
      logDir: path.join(getConfigDir(), 'audit'),
      alertRules: getDefaultAlertRules()
    },
    permissions: {
      files: {
        allowedPaths: [
          `${os.homedir()}/workspace/**`,
          '/tmp/openclaw/**',
          '/tmp/aquaman/**'
        ],
        deniedPaths: [
          '**/.env',
          '**/.env.*',
          '**/*.pem',
          '**/*.key',
          '~/.ssh/**',
          '~/.aws/**',
          '~/.openclaw/auth-profiles.json'
        ],
        sensitivePatterns: [
          '**/credentials*',
          '**/secrets*'
        ]
      },
      commands: {
        allowedCommands: [
          { command: 'git', deniedArgs: ['push --force', 'reset --hard'] },
          { command: 'npm', allowedArgs: ['install', 'test', 'build', 'run'] },
          { command: 'node' },
          { command: 'ls' },
          { command: 'cat' },
          { command: 'grep' },
          { command: 'find' }
        ],
        deniedCommands: ['sudo', 'su', 'rm -rf /', 'dd', 'mkfs'],
        dangerousPatterns: [
          'curl.*\\|.*sh',
          'wget.*\\|.*sh',
          'eval\\s+\\$'
        ]
      },
      network: {
        defaultAction: 'deny',
        allowedDomains: [
          'api.anthropic.com',
          'api.openai.com',
          '*.slack.com',
          '*.discord.com',
          'api.github.com'
        ],
        deniedDomains: [
          '*.onion',
          'localhost',
          '127.0.0.1'
        ],
        deniedPorts: [22, 23, 25, 3389]
      }
    },
    credentials: {
      backend: 'keychain',
      proxyPort: 8081,
      proxiedServices: ['claude', 'openai', 'slack', 'discord']
    },
    approval: {
      channels: [{ type: 'console' }],
      timeout: 300,
      defaultOnTimeout: 'deny'
    }
  };
}

function getDefaultAlertRules(): AlertRule[] {
  return [
    {
      id: 'dangerous-command-pipe',
      name: 'Dangerous command piping',
      pattern: 'curl.*\\|.*sh',
      action: 'block',
      severity: 'critical',
      message: 'Blocked dangerous command pattern: piping download to shell'
    },
    {
      id: 'sudo-command',
      name: 'Sudo command',
      pattern: '^sudo\\s+',
      action: 'require_approval',
      severity: 'critical',
      message: 'Sudo command requires approval'
    },
    {
      id: 'rm-rf',
      name: 'Recursive force delete',
      pattern: 'rm\\s+-rf\\s+[/~]',
      action: 'block',
      severity: 'critical',
      message: 'Blocked dangerous recursive delete'
    },
    {
      id: 'critical-tools',
      name: 'Critical tool access',
      tools: ['sessions_spawn', 'cron_create', 'camera_access', 'screen_record', 'location_access'],
      action: 'require_approval',
      severity: 'critical',
      message: 'Critical tool requires approval'
    },
    {
      id: 'mass-spawn',
      name: 'Mass agent spawning',
      tools: ['sessions_spawn'],
      action: 'warn',
      severity: 'high',
      message: 'High rate of agent spawning detected'
    }
  ];
}

export function loadConfig(): WrapperConfig {
  const configPath = getConfigPath();
  const defaultConfig = getDefaultConfig();

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const userConfig = parseYaml(content) as Partial<WrapperConfig>;
    return mergeConfig(defaultConfig, userConfig);
  } catch (error) {
    console.error(`Warning: Failed to load config from ${configPath}, using defaults`);
    return defaultConfig;
  }
}

function mergeConfig(
  base: WrapperConfig,
  override: Partial<WrapperConfig>
): WrapperConfig {
  return {
    wrapper: { ...base.wrapper, ...override.wrapper },
    audit: {
      ...base.audit,
      ...override.audit,
      alertRules: override.audit?.alertRules ?? base.audit.alertRules
    },
    permissions: {
      files: { ...base.permissions.files, ...override.permissions?.files },
      commands: { ...base.permissions.commands, ...override.permissions?.commands },
      network: { ...base.permissions.network, ...override.permissions?.network }
    },
    credentials: { ...base.credentials, ...override.credentials },
    approval: {
      ...base.approval,
      ...override.approval,
      channels: override.approval?.channels ?? base.approval.channels
    }
  };
}

export function ensureConfigDir(): void {
  const configDir = getConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
}

export function saveConfig(config: WrapperConfig): void {
  ensureConfigDir();
  const configPath = getConfigPath();
  const yaml = require('yaml');
  fs.writeFileSync(configPath, yaml.stringify(config), 'utf-8');
}
