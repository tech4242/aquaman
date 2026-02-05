/**
 * Unit tests for the openclaw.json credential migrator.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStore } from 'aquaman-core';
import {
  extractCredentials,
  migrateFromOpenClaw,
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

    it('skips already-managed credentials', async () => {
      const config = {
        channels: {
          telegram: { accounts: { bot: { botToken: 'aquaman-proxy-managed' } } },
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(config));

      const result = await migrateFromOpenClaw(configPath, store);

      expect(result.migrated).toHaveLength(0);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0].reason).toContain('Already managed');
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
});
