/**
 * Unit tests for the openclaw.json credential migrator.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from 'aquaman-core';
import {
  extractCredentials,
  extractPluginCredentials,
  migrateFromOpenClaw,
  scanCredentialsDir,
  getCleanupCommands,
  cleanupSources,
} from '../../packages/proxy/src/migration/openclaw-migrator.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('OpenClaw Migrator', () => {
  describe('extractCredentials', () => {
    it('extracts telegram bot token from accounts config', () => {
      const config = {
        channels: {
          telegram: {
            accounts: {
              mybot: { botToken: '123456:ABC-DEF' }
            }
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(1);
      expect(creds[0].service).toBe('telegram');
      expect(creds[0].key).toBe('bot_token');
      expect(creds[0].jsonPath).toEqual(['channels', 'telegram', 'accounts', 'mybot', 'botToken']);
    });

    it('extracts slack multi-token config', () => {
      const config = {
        channels: {
          slack: {
            accounts: {
              workspace1: {
                botToken: 'xoxb-test-token',
                appToken: 'xapp-test-token',
                userToken: 'xoxp-test-token',
              }
            }
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(3);
      expect(creds.map(c => c.key).sort()).toEqual(['app_token', 'bot_token', 'user_token']);
    });

    it('extracts MS Teams credentials', () => {
      const config = {
        channels: {
          msteams: {
            accounts: {
              main: {
                appId: 'azure-app-id',
                appPassword: 'azure-app-secret',
                tenantId: 'azure-tenant',
              }
            }
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(3);
      expect(creds.find(c => c.key === 'client_id')?.service).toBe('ms-teams');
      expect(creds.find(c => c.key === 'client_secret')?.service).toBe('ms-teams');
      expect(creds.find(c => c.key === 'tenant_id')?.service).toBe('ms-teams');
    });

    it('extracts twitch multi-credential config', () => {
      const config = {
        channels: {
          twitch: {
            accounts: {
              streamer: {
                accessToken: 'oauth-token',
                clientId: 'client-123',
                clientSecret: 'secret-456',
                refreshToken: 'refresh-789',
              }
            }
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(4);
    });

    it('extracts nostr private key', () => {
      const config = {
        channels: {
          nostr: {
            accounts: {
              relay1: { privateKey: 'nsec1abc123' }
            }
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(1);
      expect(creds[0].service).toBe('nostr');
      expect(creds[0].key).toBe('private_key');
    });

    it('handles flat provider config (no accounts sub-object)', () => {
      const config = {
        channels: {
          telegram: {
            botToken: '123456:ABC-DEF'
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(1);
      expect(creds[0].service).toBe('telegram');
    });

    it('returns empty for missing channels', () => {
      expect(extractCredentials({})).toHaveLength(0);
      expect(extractCredentials({ channels: {} })).toHaveLength(0);
    });

    it('skips empty/null credential values', () => {
      const config = {
        channels: {
          telegram: {
            accounts: {
              bot1: { botToken: '' },
              bot2: { botToken: null },
            }
          }
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(0);
    });

    it('skips aquaman placeholder values', () => {
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'aquaman-proxy-managed' } } },
          slack: { accounts: { ws: { botToken: 'aquaman://managed', appToken: 'xapp-real-token' } } },
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(1);
      expect(creds[0].service).toBe('slack');
      expect(creds[0].key).toBe('app_token');
    });

    it('handles multiple providers simultaneously', () => {
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'tg-token' } } },
          discord: { accounts: { bot: { token: 'dc-token' } } },
          slack: { accounts: { ws: { botToken: 'sl-token' } } },
          matrix: { accounts: { hs: { accessToken: 'mx-token' } } },
        }
      };

      const creds = extractCredentials(config);
      expect(creds).toHaveLength(4);
      const services = creds.map(c => c.service).sort();
      expect(services).toEqual(['discord', 'matrix', 'slack', 'telegram']);
    });
  });

  describe('extractPluginCredentials', () => {
    it('extracts credential-like fields from plugin config', () => {
      const config = {
        plugins: {
          entries: {
            'notion-skill': {
              enabled: true,
              config: {
                apiToken: 'ntn_abc123secret',
              }
            }
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(1);
      expect(creds[0].service).toBe('notion-skill');
      expect(creds[0].key).toBe('api_token');
      expect(creds[0].jsonPath).toEqual(['plugins', 'entries', 'notion-skill', 'config', 'apiToken']);
    });

    it('extracts multiple credential fields from one plugin', () => {
      const config = {
        plugins: {
          entries: {
            'my-saas': {
              config: {
                apiKey: 'key-123',
                apiSecret: 'secret-456',
                webhookUrl: 'https://example.com/hook',
              }
            }
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(2);
      expect(creds.map(c => c.key).sort()).toEqual(['api_key', 'api_secret']);
    });

    it('extracts credentials from multiple plugins', () => {
      const config = {
        plugins: {
          entries: {
            'notion-skill': { config: { apiToken: 'ntn_123' } },
            'jira-plugin': { config: { apiKey: 'jira-key-456' } },
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(2);
      const services = creds.map(c => c.service).sort();
      expect(services).toEqual(['jira-plugin', 'notion-skill']);
    });

    it('skips aquaman-plugin config', () => {
      const config = {
        plugins: {
          entries: {
            'aquaman-plugin': {
              config: {
                mode: 'proxy',
                backend: 'keychain',
                proxyPort: 8081,
              }
            }
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(0);
    });

    it('skips placeholder values', () => {
      const config = {
        plugins: {
          entries: {
            'notion-skill': {
              config: {
                apiToken: 'aquaman-proxy-managed',
                apiKey: 'aquaman://managed',
              }
            }
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(0);
    });

    it('skips non-credential fields', () => {
      const config = {
        plugins: {
          entries: {
            'some-plugin': {
              config: {
                endpoint: 'https://api.example.com',
                timeout: 5000,
                retries: 3,
                enabled: true,
                name: 'my-instance',
              }
            }
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(0);
    });

    it('scans nested config objects', () => {
      const config = {
        plugins: {
          entries: {
            'complex-plugin': {
              config: {
                database: {
                  password: 'db-secret-123',
                },
                api: {
                  accessToken: 'tok-456',
                },
              }
            }
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(2);
      expect(creds.find(c => c.key === 'password')?.jsonPath).toEqual(
        ['plugins', 'entries', 'complex-plugin', 'config', 'database', 'password']
      );
      expect(creds.find(c => c.key === 'access_token')?.jsonPath).toEqual(
        ['plugins', 'entries', 'complex-plugin', 'config', 'api', 'accessToken']
      );
    });

    it('returns empty for missing plugins section', () => {
      expect(extractPluginCredentials({})).toHaveLength(0);
      expect(extractPluginCredentials({ plugins: {} })).toHaveLength(0);
      expect(extractPluginCredentials({ plugins: { entries: {} } })).toHaveLength(0);
    });

    it('skips plugins with no config object', () => {
      const config = {
        plugins: {
          entries: {
            'no-config': { enabled: true },
            'null-config': { config: null },
          }
        }
      };

      const creds = extractPluginCredentials(config);
      expect(creds).toHaveLength(0);
    });
  });

  describe('migrateFromOpenClaw', () => {
    let store: MemoryStore;
    let tmpDir: string;
    let configPath: string;

    beforeEach(() => {
      store = new MemoryStore();
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-migrate-'));
      configPath = path.join(tmpDir, 'openclaw.json');
    });

    it('migrates credentials from config file to store', async () => {
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'real-token-123' } } },
          discord: { accounts: { bot: { token: 'discord-token-456' } } },
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await migrateFromOpenClaw(configPath, store);

      expect(result.migrated).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(await store.get('telegram', 'bot_token')).toBe('real-token-123');
      expect(await store.get('discord', 'bot_token')).toBe('discord-token-456');
    });

    it('dry run does not write to store', async () => {
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'real-token' } } },
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await migrateFromOpenClaw(configPath, store, { dryRun: true });

      expect(result.migrated).toHaveLength(1);
      expect(await store.get('telegram', 'bot_token')).toBeNull();
    });

    it('skips already-managed credentials (placeholders filtered by extractCredentials)', async () => {
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'aquaman-proxy-managed' } } },
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await migrateFromOpenClaw(configPath, store);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('No channel credentials');
    });

    it('does not overwrite existing credentials by default', async () => {
      await store.set('telegram', 'bot_token', 'existing-token');

      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'new-token' } } },
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await migrateFromOpenClaw(configPath, store);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('Already exists');
      expect(await store.get('telegram', 'bot_token')).toBe('existing-token');
    });

    it('overwrites when --overwrite is set', async () => {
      await store.set('telegram', 'bot_token', 'existing-token');

      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'new-token' } } },
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await migrateFromOpenClaw(configPath, store, { overwrite: true });

      expect(result.migrated).toHaveLength(1);
      expect(await store.get('telegram', 'bot_token')).toBe('new-token');
    });

    it('reports error for missing config file', async () => {
      const result = await migrateFromOpenClaw('/nonexistent/path.json', store);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('not found');
    });

    it('reports error for invalid JSON', async () => {
      fs.writeFileSync(configPath, 'not json');

      const result = await migrateFromOpenClaw(configPath, store);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain('Failed to parse');
    });

    it('reports no credentials found for empty config', async () => {
      fs.writeFileSync(configPath, JSON.stringify({}));

      const result = await migrateFromOpenClaw(configPath, store);

      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('No channel credentials');
    });
  });

  describe('scanCredentialsDir', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-creddir-'));
    });

    it('finds anthropic.json credential file', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'anthropic.json'),
        JSON.stringify({ api_key: 'sk-ant-test-123' })
      );

      const results = scanCredentialsDir(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].service).toBe('anthropic');
      expect(results[0].key).toBe('api_key');
    });

    it('finds openai.json credential file', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'openai.json'),
        JSON.stringify({ api_key: 'sk-openai-test-456' })
      );

      const results = scanCredentialsDir(tmpDir);
      expect(results).toHaveLength(1);
      expect(results[0].service).toBe('openai');
      expect(results[0].key).toBe('api_key');
    });

    it('finds multiple credential files', () => {
      fs.writeFileSync(path.join(tmpDir, 'anthropic.json'), JSON.stringify({ api_key: 'key1' }));
      fs.writeFileSync(path.join(tmpDir, 'openai.json'), JSON.stringify({ api_key: 'key2' }));

      const results = scanCredentialsDir(tmpDir);
      expect(results).toHaveLength(2);
    });

    it('returns empty for non-existent directory', () => {
      const results = scanCredentialsDir('/nonexistent/path');
      expect(results).toHaveLength(0);
    });

    it('skips unknown file names', () => {
      fs.writeFileSync(path.join(tmpDir, 'random.json'), JSON.stringify({ key: 'value' }));

      const results = scanCredentialsDir(tmpDir);
      expect(results).toHaveLength(0);
    });

    it('skips files with empty credentials', () => {
      fs.writeFileSync(path.join(tmpDir, 'anthropic.json'), JSON.stringify({ note: 'no api_key here' }));

      const results = scanCredentialsDir(tmpDir);
      expect(results).toHaveLength(0);
    });

    it('skips unparseable files', () => {
      fs.writeFileSync(path.join(tmpDir, 'anthropic.json'), 'not json');

      const results = scanCredentialsDir(tmpDir);
      expect(results).toHaveLength(0);
    });
  });

  describe('getCleanupCommands', () => {
    it('generates rm commands for credential dir files', () => {
      const migrated = [
        { service: 'anthropic', key: 'api_key', source: 'credentials-dir.anthropic.json' },
        { service: 'openai', key: 'api_key', source: 'credentials-dir.openai.json' },
      ];

      const commands = getCleanupCommands('/path/to/openclaw.json', '/path/to/credentials', migrated);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toContain('rm');
      expect(commands[0]).toContain('anthropic.json');
      expect(commands[1]).toContain('openai.json');
    });

    it('adds comment for channel config migrations', () => {
      const migrated = [
        { service: 'telegram', key: 'bot_token', source: 'channels.telegram.accounts.bot.botToken' },
      ];

      const commands = getCleanupCommands('/path/to/openclaw.json', '/path/to/credentials', migrated);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.some(c => c.includes('edit manually'))).toBe(true);
    });

    it('returns empty for no migrations', () => {
      const commands = getCleanupCommands('/path', '/path', []);
      expect(commands).toHaveLength(0);
    });
  });

  describe('cleanupSources', () => {
    let tempDir: string;
    let configPath: string;
    let credDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aquaman-cleanup-test-'));
      configPath = path.join(tempDir, 'openclaw.json');
      credDir = path.join(tempDir, 'credentials');
      fs.mkdirSync(credDir, { recursive: true });
    });

    it('deletes credential files from credentials dir', () => {
      fs.writeFileSync(path.join(credDir, 'anthropic.json'), '{"api_key":"sk-test"}');
      fs.writeFileSync(path.join(credDir, 'xai.json'), '{"api_key":"xai-test"}');

      const result = cleanupSources(configPath, credDir, [
        { service: 'anthropic', key: 'api_key', source: 'credentials-dir.anthropic.json' },
        { service: 'xai', key: 'api_key', source: 'credentials-dir.xai.json' },
      ]);

      expect(result.deleted).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(path.join(credDir, 'anthropic.json'))).toBe(false);
      expect(fs.existsSync(path.join(credDir, 'xai.json'))).toBe(false);
    });

    it('replaces config tokens with placeholder in openclaw.json', () => {
      const config = {
        plugins: { entries: { 'aquaman-plugin': { enabled: true } } },
        channels: {
          telegram: { accounts: { mybot: { botToken: '123456:REAL-TOKEN' } } },
          slack: { accounts: { ws1: { botToken: 'xoxb-real', appToken: 'xapp-real' } } },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = cleanupSources(configPath, credDir, [
        { service: 'telegram', key: 'bot_token', source: 'channels.telegram.accounts.mybot.botToken' },
        { service: 'slack', key: 'bot_token', source: 'channels.slack.accounts.ws1.botToken' },
        { service: 'slack', key: 'app_token', source: 'channels.slack.accounts.ws1.appToken' },
      ]);

      expect(result.deleted).toHaveLength(3);
      expect(result.errors).toHaveLength(0);

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.channels.telegram.accounts.mybot.botToken).toBe('aquaman-proxy-managed');
      expect(updated.channels.slack.accounts.ws1.botToken).toBe('aquaman-proxy-managed');
      expect(updated.channels.slack.accounts.ws1.appToken).toBe('aquaman-proxy-managed');
      // Non-credential config preserved
      expect(updated.plugins.entries['aquaman-plugin'].enabled).toBe(true);
    });

    it('handles mixed credential files and config tokens', () => {
      fs.writeFileSync(path.join(credDir, 'xai.json'), '{"api_key":"xai-test"}');
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'tok' } } },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = cleanupSources(configPath, credDir, [
        { service: 'xai', key: 'api_key', source: 'credentials-dir.xai.json' },
        { service: 'telegram', key: 'bot_token', source: 'channels.telegram.accounts.bot.botToken' },
      ]);

      expect(result.deleted).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
      expect(fs.existsSync(path.join(credDir, 'xai.json'))).toBe(false);
      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.channels.telegram.accounts.bot.botToken).toBe('aquaman-proxy-managed');
    });

    it('replaces plugin config tokens with placeholder in openclaw.json', () => {
      const config = {
        plugins: {
          entries: {
            'aquaman-plugin': { enabled: true },
            'notion-skill': {
              config: { apiToken: 'ntn_real_secret' },
            },
          },
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      const result = cleanupSources(configPath, credDir, [
        { service: 'notion-skill', key: 'api_token', source: 'plugins.entries.notion-skill.config.apiToken' },
      ]);

      expect(result.deleted).toHaveLength(1);
      expect(result.errors).toHaveLength(0);

      const updated = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(updated.plugins.entries['notion-skill'].config.apiToken).toBe('aquaman-proxy-managed');
      // Other plugin configs preserved
      expect(updated.plugins.entries['aquaman-plugin'].enabled).toBe(true);
    });

    it('returns empty result for no migrations', () => {
      const result = cleanupSources(configPath, credDir, []);
      expect(result.deleted).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('reports error when file deletion fails (already deleted)', () => {
      // File doesn't exist — cleanup should handle gracefully
      const result = cleanupSources(configPath, credDir, [
        { service: 'anthropic', key: 'api_key', source: 'credentials-dir.anthropic.json' },
      ]);

      // Non-existent file is not an error (nothing to delete)
      expect(result.deleted).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });
});
