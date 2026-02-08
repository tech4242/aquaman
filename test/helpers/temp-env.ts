/**
 * Reusable temporary environment helper for CLI tests.
 *
 * Creates isolated ~/.aquaman and ~/.openclaw directories in temp dirs,
 * with optional pre-populated config, plugin, and auth profiles.
 */

import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

export interface TempEnv {
  aquamanDir: string;
  openclawDir: string;
  env: Record<string, string>;
  cleanup(): void;
}

export interface TempEnvOptions {
  withOpenClaw?: boolean;
  withConfig?: boolean;
  withPlugin?: boolean;
  withAuthProfiles?: boolean;
}

const PLUGIN_SRC = path.resolve(__dirname, '../../packages/plugin');

export function createTempEnv(options: TempEnvOptions = {}): TempEnv {
  const aquamanDir = mkdtempSync(path.join(tmpdir(), 'aquaman-test-'));
  const openclawDir = mkdtempSync(path.join(tmpdir(), 'openclaw-test-'));

  if (options.withConfig) {
    writeFileSync(
      path.join(aquamanDir, 'config.yaml'),
      [
        'credentials:',
        '  backend: keychain',
        '  proxyPort: 8081',
        '  proxiedServices:',
        '    - anthropic',
        '    - openai',
        '  tls:',
        '    enabled: false',
        'audit:',
        '  enabled: true',
        `  logDir: ${path.join(aquamanDir, 'audit')}`,
        '',
      ].join('\n'),
      'utf-8'
    );
    mkdirSync(path.join(aquamanDir, 'audit'), { recursive: true });
  }

  if (options.withOpenClaw) {
    mkdirSync(path.join(openclawDir, 'extensions'), { recursive: true });
  }

  if (options.withPlugin) {
    const installPath = path.join(openclawDir, 'extensions', 'aquaman-plugin');
    mkdirSync(path.join(openclawDir, 'extensions'), { recursive: true });
    cpSync(PLUGIN_SRC, installPath, { recursive: true });

    writeFileSync(
      path.join(openclawDir, 'openclaw.json'),
      JSON.stringify({
        plugins: {
          entries: {
            'aquaman-plugin': {
              enabled: true,
              config: {
                mode: 'proxy',
                backend: 'keychain',
                services: ['anthropic', 'openai'],
                proxyPort: 8081,
              },
            },
          },
        },
      }),
      'utf-8'
    );
  }

  if (options.withAuthProfiles) {
    const profilesDir = path.join(openclawDir, 'agents', 'main', 'agent');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      path.join(profilesDir, 'auth-profiles.json'),
      JSON.stringify({
        version: 1,
        profiles: {
          'anthropic:default': {
            type: 'api_key',
            provider: 'anthropic',
            key: 'aquaman-proxy-managed',
          },
        },
        order: { anthropic: ['anthropic:default'] },
      }),
      'utf-8'
    );
  }

  const env: Record<string, string> = {
    AQUAMAN_CONFIG_DIR: aquamanDir,
    OPENCLAW_STATE_DIR: openclawDir,
  };

  return {
    aquamanDir,
    openclawDir,
    env,
    cleanup() {
      rmSync(aquamanDir, { recursive: true, force: true });
      rmSync(openclawDir, { recursive: true, force: true });
    },
  };
}
