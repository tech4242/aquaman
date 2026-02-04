/**
 * Migrates channel credentials from openclaw.json into aquaman's secure credential store.
 *
 * OpenClaw stores channel tokens as plaintext in its config file. This migrator
 * extracts them and stores them in the aquaman credential store (keychain,
 * encrypted-file, 1password, or vault), removing the plaintext exposure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CredentialStore } from '@aquaman/core';

export interface CredentialMapping {
  /** JSON path segments within openclaw.json to find the credential */
  jsonPath: string[];
  /** Aquaman service name */
  service: string;
  /** Aquaman credential key */
  key: string;
  /** Human-readable description */
  description: string;
}

export interface MigrationResult {
  migrated: Array<{ service: string; key: string; source: string }>;
  skipped: Array<{ service: string; key: string; reason: string }>;
  errors: Array<{ service: string; key: string; error: string }>;
}

/**
 * Known credential field mappings from openclaw.json channel configs.
 *
 * Each entry maps a JSON path in openclaw.json → aquaman service/key pair.
 * Paths use the pattern: channels.<provider>.accounts.<accountId>.<field>
 * Since account IDs are dynamic, we walk all accounts per provider.
 */
const PROVIDER_CREDENTIAL_FIELDS: Array<{
  provider: string;
  fields: Array<{ field: string; service: string; key: string; description: string }>;
}> = [
  {
    provider: 'telegram',
    fields: [
      { field: 'botToken', service: 'telegram', key: 'bot_token', description: 'Telegram bot token' },
      { field: 'token', service: 'telegram', key: 'bot_token', description: 'Telegram bot token (alt field)' },
    ],
  },
  {
    provider: 'discord',
    fields: [
      { field: 'token', service: 'discord', key: 'bot_token', description: 'Discord bot token' },
    ],
  },
  {
    provider: 'slack',
    fields: [
      { field: 'botToken', service: 'slack', key: 'bot_token', description: 'Slack bot token' },
      { field: 'appToken', service: 'slack', key: 'app_token', description: 'Slack app token' },
      { field: 'userToken', service: 'slack', key: 'user_token', description: 'Slack user token' },
    ],
  },
  {
    provider: 'msteams',
    fields: [
      { field: 'appId', service: 'ms-teams', key: 'client_id', description: 'MS Teams app ID' },
      { field: 'appPassword', service: 'ms-teams', key: 'client_secret', description: 'MS Teams app password' },
      { field: 'tenantId', service: 'ms-teams', key: 'tenant_id', description: 'Azure tenant ID' },
    ],
  },
  {
    provider: 'matrix',
    fields: [
      { field: 'accessToken', service: 'matrix', key: 'access_token', description: 'Matrix access token' },
      { field: 'password', service: 'matrix', key: 'password', description: 'Matrix password' },
    ],
  },
  {
    provider: 'mattermost',
    fields: [
      { field: 'botToken', service: 'mattermost', key: 'bot_token', description: 'Mattermost bot token' },
    ],
  },
  {
    provider: 'line',
    fields: [
      { field: 'channelAccessToken', service: 'line', key: 'channel_access_token', description: 'LINE channel access token' },
      { field: 'channelSecret', service: 'line', key: 'channel_secret', description: 'LINE channel secret' },
    ],
  },
  {
    provider: 'twitch',
    fields: [
      { field: 'accessToken', service: 'twitch', key: 'access_token', description: 'Twitch access token' },
      { field: 'clientId', service: 'twitch', key: 'client_id', description: 'Twitch client ID' },
      { field: 'clientSecret', service: 'twitch', key: 'client_secret', description: 'Twitch client secret' },
      { field: 'refreshToken', service: 'twitch', key: 'refresh_token', description: 'Twitch refresh token' },
    ],
  },
  {
    provider: 'feishu',
    fields: [
      { field: 'appId', service: 'feishu', key: 'app_id', description: 'Feishu app ID' },
      { field: 'appSecret', service: 'feishu', key: 'app_secret', description: 'Feishu app secret' },
    ],
  },
  {
    provider: 'googlechat',
    fields: [
      { field: 'serviceAccount', service: 'google-chat', key: 'service_account', description: 'Google Chat service account JSON' },
    ],
  },
  {
    provider: 'bluebubbles',
    fields: [
      { field: 'password', service: 'bluebubbles', key: 'password', description: 'BlueBubbles password' },
    ],
  },
  {
    provider: 'nextcloud-talk',
    fields: [
      { field: 'botSecret', service: 'nextcloud', key: 'bot_secret', description: 'Nextcloud bot secret' },
      { field: 'apiUser', service: 'nextcloud', key: 'api_user', description: 'Nextcloud API user' },
      { field: 'apiPassword', service: 'nextcloud', key: 'api_password', description: 'Nextcloud API password' },
    ],
  },
  {
    provider: 'nostr',
    fields: [
      { field: 'privateKey', service: 'nostr', key: 'private_key', description: 'Nostr private key' },
    ],
  },
  {
    provider: 'tlon',
    fields: [
      { field: 'code', service: 'tlon', key: 'code', description: 'Tlon/Urbit access code' },
    ],
  },
  {
    provider: 'zalo',
    fields: [
      { field: 'botToken', service: 'zalo', key: 'bot_token', description: 'Zalo bot token' },
      { field: 'webhookSecret', service: 'zalo', key: 'webhook_secret', description: 'Zalo webhook secret' },
    ],
  },
];

/**
 * Locate the openclaw.json config file.
 */
export function findOpenClawConfig(customPath?: string): string {
  if (customPath) return customPath;
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
}

/**
 * Extract credentials from an openclaw.json config object.
 */
export function extractCredentials(config: any): CredentialMapping[] {
  const results: CredentialMapping[] = [];

  const channels = config?.channels;
  if (!channels || typeof channels !== 'object') return results;

  for (const providerDef of PROVIDER_CREDENTIAL_FIELDS) {
    const providerConfig = channels[providerDef.provider];
    if (!providerConfig || typeof providerConfig !== 'object') continue;

    // Check accounts sub-object (accounts.<id>.<field>)
    const accounts = providerConfig.accounts;
    if (accounts && typeof accounts === 'object') {
      for (const [accountId, accountConfig] of Object.entries(accounts)) {
        if (!accountConfig || typeof accountConfig !== 'object') continue;
        const acc = accountConfig as Record<string, any>;

        for (const fieldDef of providerDef.fields) {
          const value = acc[fieldDef.field];
          if (value && typeof value === 'string' && value.trim()) {
            results.push({
              jsonPath: ['channels', providerDef.provider, 'accounts', accountId, fieldDef.field],
              service: fieldDef.service,
              key: fieldDef.key,
              description: `${fieldDef.description} (account: ${accountId})`,
            });
          }
        }
      }
    }

    // Also check top-level provider fields (legacy flat config)
    for (const fieldDef of providerDef.fields) {
      const value = providerConfig[fieldDef.field];
      if (value && typeof value === 'string' && value.trim()) {
        // Avoid duplicating if already found in accounts
        const alreadyFound = results.some(
          r => r.service === fieldDef.service && r.key === fieldDef.key
        );
        if (!alreadyFound) {
          results.push({
            jsonPath: ['channels', providerDef.provider, fieldDef.field],
            service: fieldDef.service,
            key: fieldDef.key,
            description: fieldDef.description,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Resolve a value from a nested object given a path of keys.
 */
function getNestedValue(obj: any, jsonPath: string[]): string | null {
  let current = obj;
  for (const key of jsonPath) {
    if (!current || typeof current !== 'object') return null;
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

/**
 * Migrate credentials from openclaw.json into the aquaman credential store.
 */
export async function migrateFromOpenClaw(
  configPath: string,
  store: CredentialStore,
  options: { dryRun?: boolean; overwrite?: boolean } = {}
): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: [],
    skipped: [],
    errors: [],
  };

  // Read openclaw.json
  if (!fs.existsSync(configPath)) {
    result.errors.push({
      service: '-',
      key: '-',
      error: `Config file not found: ${configPath}`,
    });
    return result;
  }

  let config: any;
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    config = JSON.parse(content);
  } catch (err) {
    result.errors.push({
      service: '-',
      key: '-',
      error: `Failed to parse config: ${err}`,
    });
    return result;
  }

  // Extract credential mappings
  const mappings = extractCredentials(config);

  if (mappings.length === 0) {
    result.skipped.push({
      service: '-',
      key: '-',
      reason: 'No channel credentials found in config',
    });
    return result;
  }

  // Migrate each credential
  for (const mapping of mappings) {
    const value = getNestedValue(config, mapping.jsonPath);
    if (!value) {
      result.skipped.push({
        service: mapping.service,
        key: mapping.key,
        reason: 'Value is empty or not a string',
      });
      continue;
    }

    // Skip placeholder values
    if (value === 'aquaman-proxy-managed' || value.startsWith('aquaman://')) {
      result.skipped.push({
        service: mapping.service,
        key: mapping.key,
        reason: 'Already managed by aquaman',
      });
      continue;
    }

    if (options.dryRun) {
      result.migrated.push({
        service: mapping.service,
        key: mapping.key,
        source: mapping.jsonPath.join('.'),
      });
      continue;
    }

    try {
      // Check for existing credential
      if (!options.overwrite) {
        const existing = await store.get(mapping.service, mapping.key);
        if (existing) {
          result.skipped.push({
            service: mapping.service,
            key: mapping.key,
            reason: 'Already exists in store (use --overwrite to replace)',
          });
          continue;
        }
      }

      await store.set(mapping.service, mapping.key, value);
      result.migrated.push({
        service: mapping.service,
        key: mapping.key,
        source: mapping.jsonPath.join('.'),
      });
    } catch (err) {
      result.errors.push({
        service: mapping.service,
        key: mapping.key,
        error: `Failed to store: ${err}`,
      });
    }
  }

  return result;
}

export { PROVIDER_CREDENTIAL_FIELDS };
