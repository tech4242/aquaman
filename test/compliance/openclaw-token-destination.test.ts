/**
 * The loopback token goes to the proxy and to no other host (OpenClaw path).
 *
 * OpenClaw sends a provider's key to whatever `baseUrl` the provider has, and
 * a channel's token to its `apiRoot`. aquaman's key reference is answered
 * with the loopback token, so two things have to hold:
 *
 *   - setup writes the reference only beside an endpoint that is the proxy,
 *     and takes it back where it finds one beside another endpoint;
 *   - the resolver, asked for a reference, hands out the token only when the
 *     config shows the proxy as that reference's endpoint.
 *
 * One table row per endpoint spelling. The resolver rows run the real script
 * the way the gateway does (JSON on stdin, a near-empty environment).
 *
 * Mapped controls: NIST SP 800-53 SC-7 (boundary protection), AC-4
 * (information flow enforcement), IA-5 (authenticator management).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { wireSecretRefProviders, secretRefWiringStatus } from '../../packages/proxy/src/openclaw/secretref.js';
import { wireChannelRouting } from '../../packages/proxy/src/openclaw/channel-routing.js';

const RESOLVER = path.resolve('packages/plugin/secrets-resolver.mjs');
const TOKEN = 'aqm_lb_' + 'd'.repeat(48);
const PLACEHOLDER = 'aquaman-proxy-managed';
const ORIGIN = 'http://127.0.0.1:8585';
const REF = (service: string) => ({ source: 'exec', provider: 'aquaman', id: `${service}/api_key` });

/** Endpoints that are not the proxy listening on 127.0.0.1:8585, however they are written. */
const NOT_THE_PROXY: Array<[string, unknown]> = [
  ['a remote gateway', 'https://llm-gateway.corp.example/anthropic'],
  ['the provider itself', 'https://api.anthropic.com'],
  ['a remote host over http', 'http://gateway.example.com:8585/anthropic'],
  ['a private network address', 'http://192.168.1.20:8585/anthropic'],
  ['the proxy address as user info of another host', 'http://127.0.0.1:8585@gateway.example.com/anthropic'],
  ['the proxy address as a subdomain', 'http://127.0.0.1.gateway.example.com:8585/anthropic'],
  ['the proxy port as a subdomain label', 'http://localhost:8585.gateway.example.com/anthropic'],
  ['a backslash before the real host', 'http://127.0.0.1:8585\\@gateway.example.com/anthropic'],
  ['loopback on another port', 'http://127.0.0.1:4000/anthropic'],
  ['loopback over https', 'https://127.0.0.1:8585/anthropic'],
  ['loopback without a port', 'http://127.0.0.1/anthropic'],
  ['an upper-case scheme', 'HTTP://127.0.0.1:8585/anthropic'],
  ['a short form of 127.0.0.1', 'http://127.1:8585/anthropic'],
  ['an IPv6 address that is not ::1', 'http://[::2]:8585/anthropic'],
  ['the retired aquaman.local host', 'http://aquaman.local/anthropic'],
  ['a scheme-relative address', '//127.0.0.1:8585/anthropic'],
  ['a number', 8585],
  ['an object', { url: 'http://127.0.0.1:8585/anthropic' }],
  ['an empty string', ''],
];

describe('the resolver hands out the loopback token only for a reference whose endpoint is the proxy', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-dest-'));
    fs.mkdirSync(path.join(dir, 'oc'));
    writeAquaman(8585);
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const writeAquaman = (port: number) => fs.writeFileSync(path.join(dir, 'config.yaml'), [
    'credentials:', '  backend: encrypted-file',
    'loopback:', '  enabled: true', `  port: ${port}`, '  host: 127.0.0.1', `  token: ${TOKEN}`, '',
  ].join('\n'));
  const writeOpenClaw = (config: unknown, file = path.join(dir, 'oc', 'openclaw.json')) =>
    fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));

  function resolve(ids: string[], env: Record<string, string> = {}): Promise<Record<string, string>> {
    return new Promise((done, reject) => {
      const proc = spawn(process.execPath, [RESOLVER], {
        cwd: path.dirname(RESOLVER),
        env: { AQUAMAN_CONFIG_DIR: dir, OPENCLAW_STATE_DIR: path.join(dir, 'oc'), HOME: dir, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.on('error', reject);
      proc.on('close', () => { try { done(JSON.parse(out).values); } catch (err) { reject(err); } });
      proc.stdin.end(JSON.stringify({ protocolVersion: 1, provider: 'aquaman', ids }));
    });
  }

  it.each([
    ['127.0.0.1', 'http://127.0.0.1:8585/anthropic'],
    ['localhost', 'http://localhost:8585/anthropic'],
    ['::1', 'http://[::1]:8585/anthropic'],
    ['no path', 'http://127.0.0.1:8585'],
  ])('the proxy as baseUrl (%s): the token', async (_name, baseUrl) => {
    writeOpenClaw({ models: { providers: { anthropic: { baseUrl, apiKey: REF('anthropic') } } } });
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': TOKEN });
  });

  it.each(NOT_THE_PROXY)('%s as a provider baseUrl: the placeholder, never the token', async (_name, baseUrl) => {
    writeOpenClaw({ models: { providers: { anthropic: { baseUrl, apiKey: REF('anthropic') } } } });
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': PLACEHOLDER });
  });

  it.each(NOT_THE_PROXY)('%s as the telegram apiRoot: the placeholder, never the token', async (_name, apiRoot) => {
    writeOpenClaw({ channels: { telegram: { apiRoot, botToken: { source: 'exec', provider: 'aquaman', id: 'telegram/bot_token' } } } });
    expect(await resolve(['telegram/bot_token'])).toEqual({ 'telegram/bot_token': PLACEHOLDER });
  });

  it('no baseUrl at all, so the provider\'s own host: the placeholder', async () => {
    writeOpenClaw({ models: { providers: { anthropic: { apiKey: REF('anthropic') } } } });
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': PLACEHOLDER });
  });

  it('decides each reference by its own endpoint', async () => {
    writeOpenClaw({
      models: { providers: {
        anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' },
        openai: { baseUrl: 'https://gateway.example.com/openai/v1' },
      } },
      channels: { telegram: { apiRoot: 'http://127.0.0.1:8585/telegram' } },
    });
    expect(await resolve(['anthropic/api_key', 'openai/api_key', 'telegram/bot_token', 'mistral/api_key'])).toEqual({
      'anthropic/api_key': TOKEN,
      'openai/api_key': PLACEHOLDER,
      'telegram/bot_token': TOKEN,
      'mistral/api_key': PLACEHOLDER,
    });
  });

  it.each(['anthropic', 'anthropic/', '/api_key', 'anthropic/other_key', 'telegram/api_key', 'a/b/c'])(
    'a reference of a shape that names no endpoint (%s): the placeholder',
    async (id) => {
      writeOpenClaw({ models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' } } } });
      expect(await resolve([id])).toEqual({ [id]: PLACEHOLDER });
    },
  );

  it('holds the endpoint to the listener\'s own port', async () => {
    writeAquaman(9931);
    writeOpenClaw({ models: { providers: {
      anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' },
      openai: { baseUrl: 'http://127.0.0.1:9931/openai/v1' },
    } } });
    expect(await resolve(['anthropic/api_key', 'openai/api_key'])).toEqual({
      'anthropic/api_key': PLACEHOLDER,
      'openai/api_key': TOKEN,
    });
  });

  it('reads the config OpenClaw was told to use (OPENCLAW_CONFIG_PATH), not the default one', async () => {
    writeOpenClaw({ models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' } } } });
    const other = path.join(dir, 'other.json');
    writeOpenClaw({ models: { providers: { anthropic: { baseUrl: 'https://gateway.example.com' } } } }, other);
    expect(await resolve(['anthropic/api_key'], { OPENCLAW_CONFIG_PATH: other })).toEqual({ 'anthropic/api_key': PLACEHOLDER });
  });

  it('gives the placeholder for everything while the listener is off', async () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), `loopback:\n  enabled: false\n  token: ${TOKEN}\n`);
    writeOpenClaw({ models: { providers: { anthropic: { baseUrl: 'http://127.0.0.1:8585/anthropic' } } } });
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': PLACEHOLDER });
  });

  it('still answers with the token when there is no OpenClaw config to read', async () => {
    fs.rmSync(path.join(dir, 'oc'), { recursive: true });
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': TOKEN });
  });

  // Limits. Where the script cannot see the whole config it returns the
  // token, so that a correctly wired install it cannot parse keeps working.
  it.fails('limit: a config with $include is not followed, so an endpoint set in an included file is not seen', async () => {
    fs.writeFileSync(path.join(dir, 'oc', 'models.json'), JSON.stringify({ providers: { anthropic: { baseUrl: 'https://gateway.example.com' } } }));
    writeOpenClaw({ models: { $include: './models.json' } });
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': PLACEHOLDER });
  });

  it.fails('limit: a config with comments (JSON5) is not read, so its endpoints are not seen', async () => {
    writeOpenClaw('{\n  // mine\n  "models": { "providers": { "anthropic": { "baseUrl": "https://gateway.example.com" } } }\n}\n');
    expect(await resolve(['anthropic/api_key'])).toEqual({ 'anthropic/api_key': PLACEHOLDER });
  });
});

describe('setup writes the key reference only beside an endpoint that is the proxy', () => {
  const userUrls = NOT_THE_PROXY.filter(([name]) => name !== 'the retired aquaman.local host');

  it.each(userUrls)('%s: no reference is written and the entry is left as it was', (_name, baseUrl) => {
    const config: Record<string, any> = { models: { providers: { anthropic: { baseUrl } } } };
    const result = wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: ORIGIN });
    expect(config.models.providers.anthropic).toEqual({ baseUrl });
    expect(result.wiredProviders).toEqual([]);
    expect(result.keptUserBaseUrl).toEqual(['anthropic']);
  });

  it.each(userUrls)('%s beside a reference an earlier setup wrote: the reference is taken back', (_name, baseUrl) => {
    const config: Record<string, any> = { models: { providers: { anthropic: { baseUrl, apiKey: REF('anthropic') } } } };
    const result = wireSecretRefProviders(config, ['anthropic'], { loopbackOrigin: ORIGIN });
    // A loopback URL of the proxy's shape beside our own reference is ours:
    // the listener's port was changed, and the entry is moved to the new one.
    if (baseUrl === 'http://127.0.0.1:4000/anthropic') {
      expect(config.models.providers.anthropic).toEqual({ baseUrl: `${ORIGIN}/anthropic`, apiKey: REF('anthropic') });
      return;
    }
    expect(config.models.providers.anthropic).toEqual({ baseUrl });
    expect(result.removedRefs).toEqual(['anthropic']);
    expect(secretRefWiringStatus(config, ['anthropic']).wiredProviders).toEqual([]);
  });

  it('a local gateway of the same path shape, with no reference of ours, is the user\'s and is kept', () => {
    const config: Record<string, any> = { models: { providers: { openai: { baseUrl: 'http://127.0.0.1:4000/openai/v1' } } } };
    const result = wireSecretRefProviders(config, ['openai'], { loopbackOrigin: ORIGIN });
    expect(config.models.providers.openai).toEqual({ baseUrl: 'http://127.0.0.1:4000/openai/v1' });
    expect(result.keptUserBaseUrl).toEqual(['openai']);
  });

  it('the proxy as endpoint: reference and baseUrl are written together', () => {
    const config: Record<string, any> = {};
    wireSecretRefProviders(config, ['anthropic', 'openai'], { loopbackOrigin: ORIGIN });
    expect(config.models.providers).toEqual({
      anthropic: { apiKey: REF('anthropic'), baseUrl: `${ORIGIN}/anthropic` },
      openai: { apiKey: REF('openai'), baseUrl: `${ORIGIN}/openai/v1` },
    });
  });

  it('doctor counts a reference beside any other endpoint as not routed', () => {
    for (const [, baseUrl] of NOT_THE_PROXY.filter(([name]) => name !== 'loopback on another port')) {
      const config = { models: { providers: { anthropic: { baseUrl, apiKey: REF('anthropic') } } } };
      const status = secretRefWiringStatus(config, ['anthropic']);
      expect(status.baseUrlProviders).toEqual([]);
      expect(status.missingBaseUrl).toEqual(['anthropic']);
    }
  });

  it.each([
    ['a self-hosted Bot API server', { apiRoot: 'https://bot-api.internal.example.com' }],
    ['a token file', { tokenFile: '/run/secrets/telegram' }],
    ['several accounts', { accounts: { a: { botToken: 'x' } } }],
  ])('telegram with %s: no token and no reference is written', (_name, entry) => {
    const config: Record<string, any> = { channels: { telegram: { enabled: true, ...entry } } };
    wireChannelRouting(config, { loopbackOrigin: ORIGIN, loopbackToken: TOKEN, tokenRef: true, hasVaultCredential: () => true });
    expect(config.channels.telegram).toEqual({ enabled: true, ...entry });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });

  it('telegram routed: the file gets a reference and the proxy root, never the token', () => {
    const config: Record<string, any> = { channels: { telegram: { enabled: true, botToken: TOKEN } } };
    wireChannelRouting(config, { loopbackOrigin: ORIGIN, loopbackToken: TOKEN, tokenRef: true, hasVaultCredential: () => true });
    expect(config.channels.telegram).toEqual({
      enabled: true,
      apiRoot: `${ORIGIN}/telegram`,
      botToken: { source: 'exec', provider: 'aquaman', id: 'telegram/bot_token' },
    });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
  });
});
