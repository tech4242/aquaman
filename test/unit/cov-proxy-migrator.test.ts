/**
 * OpenClaw credential migrator: the failure and edge paths (a vault that
 * refuses a write, unreadable credential files, cleanup that cannot delete,
 * malformed URLs, and the setup-time auto-migration over an isolated
 * OPENCLAW_STATE_DIR).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryStore } from 'aquaman-core';
import {
  migrateFromOpenClaw,
  scanCredentialsDir,
  readCredentialFromFile,
  cleanupSources,
  findUpstreamUrl,
  extractPluginUpstreamUrls,
  autoMigrateOpenClaw,
} from '../../packages/proxy/src/migration/openclaw-migrator.js';

describe('OpenClaw migrator: failure and edge paths', () => {
  let dir: string;
  let credentialsDir: string;
  let configPath: string;
  const savedStateDir = process.env['OPENCLAW_STATE_DIR'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-mig-'));
    credentialsDir = path.join(dir, 'credentials');
    configPath = path.join(dir, 'openclaw.json');
    process.env['OPENCLAW_STATE_DIR'] = dir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) delete process.env['OPENCLAW_STATE_DIR'];
    else process.env['OPENCLAW_STATE_DIR'] = savedStateDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeConfig = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config));

  describe('migrateFromOpenClaw', () => {
    it('reports a credential the vault refuses as an error and still migrates the others', async () => {
      writeConfig({ channels: { slack: { botToken: 'xoxb-one', appToken: 'xapp-two' } } });
      const store = new MemoryStore();
      const realSet = store.set.bind(store);
      store.set = async (service, key, value) => {
        if (key === 'bot_token') throw new Error('vault is locked');
        return realSet(service, key, value);
      };
      const result = await migrateFromOpenClaw(configPath, store);
      expect(result.errors).toEqual([{ service: 'slack', key: 'bot_token', error: 'Failed to store: Error: vault is locked' }]);
      expect(result.migrated).toEqual([{ service: 'slack', key: 'app_token', source: 'channels.slack.appToken' }]);
      expect(await store.get('slack', 'app_token')).toBe('xapp-two');
      expect(await store.get('slack', 'bot_token')).toBeNull();
      // The error names the reference, not the value.
      expect(JSON.stringify(result)).not.toContain('xoxb-one');
    });
  });

  describe('scanCredentialsDir', () => {
    it('returns nothing when the credentials path is a file, not a directory', () => {
      fs.writeFileSync(credentialsDir, 'not a directory');
      expect(scanCredentialsDir(credentialsDir)).toEqual([]);
    });

    it('skips an entry that cannot be inspected, and still reports the readable ones', () => {
      fs.mkdirSync(credentialsDir);
      fs.symlinkSync(path.join(dir, 'does-not-exist'), path.join(credentialsDir, 'anthropic.json'));
      fs.writeFileSync(path.join(credentialsDir, 'openai.json'), JSON.stringify({ api_key: 'sk-openai' }));
      const found = scanCredentialsDir(credentialsDir);
      expect(found.map((m) => `${m.service}/${m.key}`)).toEqual(['openai/api_key']);
    });
  });

  describe('readCredentialFromFile', () => {
    it('returns null for a file that is missing or not JSON', () => {
      fs.mkdirSync(credentialsDir);
      fs.writeFileSync(path.join(credentialsDir, 'anthropic.json'), 'sk-ant-raw-not-json');
      expect(readCredentialFromFile(credentialsDir, 'anthropic.json')).toBeNull();
      expect(readCredentialFromFile(credentialsDir, 'missing.json')).toBeNull();
    });

    it('returns null for JSON with none of the known fields, and the value for each known field', () => {
      fs.mkdirSync(credentialsDir);
      fs.writeFileSync(path.join(credentialsDir, 'a.json'), JSON.stringify({ other: 'x' }));
      expect(readCredentialFromFile(credentialsDir, 'a.json')).toBeNull();
      for (const field of ['api_key', 'apiKey', 'token', 'key', 'secret']) {
        fs.writeFileSync(path.join(credentialsDir, 'b.json'), JSON.stringify({ [field]: `value-${field}` }));
        expect(readCredentialFromFile(credentialsDir, 'b.json')).toBe(`value-${field}`);
      }
    });
  });

  describe('cleanupSources', () => {
    it('reports a credential file it cannot delete and carries on with the rest', () => {
      fs.mkdirSync(credentialsDir);
      // A directory where the file should be: unlink fails.
      fs.mkdirSync(path.join(credentialsDir, 'anthropic.json'));
      fs.writeFileSync(path.join(credentialsDir, 'openai.json'), JSON.stringify({ api_key: 'sk-openai' }));
      const result = cleanupSources(configPath, credentialsDir, [
        { service: 'anthropic', key: 'api_key', source: 'credentials-dir.anthropic.json' },
        { service: 'openai', key: 'api_key', source: 'credentials-dir.openai.json' },
      ]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.source).toBe('credentials/anthropic.json');
      expect(result.errors[0]!.error).toMatch(/^Failed to delete: /);
      expect(result.deleted).toEqual([
        { source: 'credentials/openai.json', description: `Deleted ${path.join(credentialsDir, 'openai.json')}` },
      ]);
      expect(fs.existsSync(path.join(credentialsDir, 'openai.json'))).toBe(false);
    });

    it('reports a config it cannot parse and leaves the file as it was', () => {
      fs.writeFileSync(configPath, '{ "channels": ');
      const result = cleanupSources(configPath, credentialsDir, [
        { service: 'slack', key: 'bot_token', source: 'channels.slack.botToken' },
      ]);
      expect(result.deleted).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]!.source).toBe('openclaw.json');
      expect(result.errors[0]!.error).toMatch(/^Failed to update config: /);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe('{ "channels": ');
    });

    it('claims no replacement when openclaw.json cannot be written', () => {
      writeConfig({ channels: { slack: { botToken: 'xoxb-real' } } });
      const before = fs.readFileSync(configPath, 'utf-8');
      fs.chmodSync(configPath, 0o444);
      try {
        const result = cleanupSources(configPath, credentialsDir, [
          { service: 'slack', key: 'bot_token', source: 'channels.slack.botToken' },
        ]);
        expect(result.deleted).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]!.source).toBe('openclaw.json');
        expect(result.errors[0]!.error).toMatch(/^Failed to update config: /);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
      } finally {
        fs.chmodSync(configPath, 0o644);
      }
    });

    it('replaces only the paths that exist with the placeholder', () => {
      writeConfig({ channels: { slack: { botToken: 'xoxb-real' } }, plugins: 'not-an-object' });
      const result = cleanupSources(configPath, credentialsDir, [
        { service: 'slack', key: 'bot_token', source: 'channels.slack.botToken' },
        { service: 'slack', key: 'app_token', source: 'channels.slack.appToken' },
        { service: 'x', key: 'api_key', source: 'plugins.entries.x.config.apiKey' },
      ]);
      expect(result.errors).toEqual([]);
      expect(result.deleted).toEqual([
        { source: 'openclaw.json → channels.slack.botToken', description: 'Replaced slack/bot_token with placeholder' },
      ]);
      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(after.channels.slack).toEqual({ botToken: 'aquaman-proxy-managed' });
      expect(after.plugins).toBe('not-an-object');
    });
  });

  describe('findUpstreamUrl', () => {
    it('skips an explicit field whose URL does not parse and takes the next one', () => {
      expect(findUpstreamUrl({ endpoint: 'http://[not-a-host', baseUrl: 'https://api.example.com/v1' }))
        .toEqual({ field: 'baseUrl', url: 'https://api.example.com' });
    });

    it('skips a fallback field whose URL does not parse', () => {
      expect(findUpstreamUrl({ region: 'https://[broken', mirror: 'https://mirror.example.com:8443/x' }))
        .toEqual({ field: 'mirror', url: 'https://mirror.example.com:8443' });
      expect(findUpstreamUrl({ region: 'https://[broken' })).toBeNull();
    });

    it('never takes a URL from a credential-like or callback field', () => {
      expect(findUpstreamUrl({ apiKey: 'https://looks-like-a-url.example.com', webhookUrl: 'https://hooks.example.com' })).toBeNull();
    });
  });

  describe('extractPluginUpstreamUrls', () => {
    it('ignores aquaman-plugin, entries without a config object, and plugins with no URL', () => {
      const urls = extractPluginUpstreamUrls({
        plugins: {
          entries: {
            'aquaman-plugin': { config: { endpoint: 'https://self.example.com' } },
            bare: {},
            nourl: { config: { region: 'eu' } },
            weather: { config: { endpoint: 'https://api.weather.example.com/v2' } },
          },
        },
      });
      expect(urls).toEqual([
        { pluginId: 'weather', upstream: 'https://api.weather.example.com', hostname: 'api.weather.example.com', sourceField: 'endpoint' },
      ]);
      expect(extractPluginUpstreamUrls({ plugins: { entries: 'x' } })).toEqual([]);
    });
  });

  describe('autoMigrateOpenClaw', () => {
    it('migrates channel, plugin and credentials-dir values, once each, and leaves placeholders alone', async () => {
      writeConfig({
        channels: {
          slack: { botToken: 'xoxb-from-config' },
          telegram: { botToken: 'aquaman-proxy-managed' },
        },
        plugins: {
          entries: {
            weather: { config: { apiKey: 'wx-plugin-key', nested: { clientSecret: 'wx-secret' }, region: 'eu' } },
            // Same service/key as the channel above: the first one found wins.
            slack: { config: { botToken: 'xoxb-from-plugin' } },
            managed: { config: { apiKey: 'aquaman://managed/api_key' } },
            'aquaman-plugin': { config: { token: 'never-read' } },
          },
        },
      });
      fs.mkdirSync(credentialsDir);
      fs.writeFileSync(path.join(credentialsDir, 'anthropic.json'), JSON.stringify({ api_key: 'sk-ant-from-file' }));
      fs.writeFileSync(path.join(credentialsDir, 'github.json'), JSON.stringify({ token: 'ghp-from-file' }));
      fs.writeFileSync(path.join(credentialsDir, 'notes.txt'), 'ignored');

      const store = new MemoryStore();
      const result = await autoMigrateOpenClaw({ store, isInteractive: false });
      expect(result).toEqual({ found: 5, migrated: 5, skipped: false });
      expect(await store.get('slack', 'bot_token')).toBe('xoxb-from-config');
      expect(await store.get('weather', 'api_key')).toBe('wx-plugin-key');
      expect(await store.get('weather', 'client_secret')).toBe('wx-secret');
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-from-file');
      expect(await store.get('github', 'token')).toBe('ghp-from-file');
      expect(await store.get('telegram', 'bot_token')).toBeNull();
      expect(await store.get('managed', 'api_key')).toBeNull();
      expect(await store.get('aquaman-plugin', 'token')).toBeNull();
    });

    it('never replaces a value already in the vault, and survives a write that fails', async () => {
      writeConfig({ channels: { slack: { botToken: 'xoxb-new', appToken: 'xapp-new' } } });
      fs.mkdirSync(credentialsDir);
      fs.writeFileSync(path.join(credentialsDir, 'openai.json'), JSON.stringify({ apiKey: 'sk-openai-file' }));
      const store = new MemoryStore();
      await store.set('slack', 'bot_token', 'xoxb-already-there');
      const realSet = store.set.bind(store);
      store.set = async (service, key, value) => {
        if (service === 'openai') throw new Error('vault is locked');
        return realSet(service, key, value);
      };
      const result = await autoMigrateOpenClaw({ store, isInteractive: false });
      expect(result).toEqual({ found: 3, migrated: 1, skipped: false });
      expect(await store.get('slack', 'bot_token')).toBe('xoxb-already-there');
      expect(await store.get('slack', 'app_token')).toBe('xapp-new');
      expect(await store.get('openai', 'api_key')).toBeNull();
    });

    it('a credentials-dir value does not displace one found in the config for the same reference', async () => {
      writeConfig({ plugins: { entries: { anthropic: { config: { apiKey: 'sk-ant-from-config' } } } } });
      fs.mkdirSync(credentialsDir);
      fs.writeFileSync(path.join(credentialsDir, 'anthropic.json'), JSON.stringify({ api_key: 'sk-ant-from-file' }));
      const store = new MemoryStore();
      const result = await autoMigrateOpenClaw({ store, isInteractive: false });
      expect(result).toEqual({ found: 1, migrated: 1, skipped: false });
      expect(await store.get('anthropic', 'api_key')).toBe('sk-ant-from-config');
    });

    it('reports plugins it left alone because of their id, also when nothing else was found', async () => {
      writeConfig({ plugins: { entries: { 'Bad Name': { config: { apiKey: 'left-where-it-is' } } } } });
      const store = new MemoryStore();
      expect(await autoMigrateOpenClaw({ store, isInteractive: false })).toEqual({
        found: 0,
        migrated: 0,
        skipped: false,
        unstorable: [{ service: 'Bad Name', reason: expect.stringContaining('not a service name aquaman can store under') }],
      });
      expect(await store.list()).toEqual([]);
    });

    it('finds nothing with an unparseable config and no credentials directory', async () => {
      fs.writeFileSync(configPath, '{ nope');
      const store = new MemoryStore();
      expect(await autoMigrateOpenClaw({ store, isInteractive: false })).toEqual({ found: 0, migrated: 0, skipped: false });
      expect(await store.list()).toEqual([]);
    });

    it('reads the config from an explicit path when one is given', async () => {
      const elsewhere = path.join(dir, 'other.json');
      fs.writeFileSync(elsewhere, JSON.stringify({ channels: { discord: { token: 'discord-bot-token' } } }));
      const store = new MemoryStore();
      const result = await autoMigrateOpenClaw({ store, isInteractive: false, configPath: elsewhere });
      expect(result).toEqual({ found: 1, migrated: 1, skipped: false });
      expect(await store.get('discord', 'bot_token')).toBe('discord-bot-token');
    });
  });
});
