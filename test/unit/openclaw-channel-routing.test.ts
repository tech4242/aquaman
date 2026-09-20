/**
 * Unit tests for OpenClaw channel egress routing (v0.15.0+).
 *
 * The wiring is all-or-nothing per channel: a channel with our apiRoot but
 * their token, or our token with an empty vault, is a bot that stops working.
 * Most of these tests are about the refusal cases.
 */

import { describe, it, expect } from 'vitest';
import {
  loopbackChannelBaseUrl,
  wireChannelRouting,
  channelRoutingStatus,
  CHANNEL_ROUTING_SUPPORTED,
  CHANNEL_ROUTING_UNSUPPORTED
} from 'aquaman-proxy';

const ORIGIN = 'http://127.0.0.1:8585';
const TOKEN = 'aqm_loopback_token_for_tests';
const hasAll = () => true;
const hasNone = () => false;

const wire = (config: Record<string, any>, hasVaultCredential = hasAll) =>
  wireChannelRouting(config, { loopbackOrigin: ORIGIN, loopbackToken: TOKEN, hasVaultCredential });

describe('loopbackChannelBaseUrl', () => {
  it('maps telegram onto the proxy route', () => {
    expect(loopbackChannelBaseUrl('telegram', ORIGIN)).toBe('http://127.0.0.1:8585/telegram');
  });

  it('trims trailing slashes on the origin', () => {
    expect(loopbackChannelBaseUrl('telegram', 'http://127.0.0.1:8585///')).toBe(
      'http://127.0.0.1:8585/telegram'
    );
  });

  it('returns null for a channel with no endpoint override', () => {
    expect(loopbackChannelBaseUrl('discord', ORIGIN)).toBeNull();
    expect(loopbackChannelBaseUrl('slack', ORIGIN)).toBeNull();
  });
});

describe('wireChannelRouting', () => {
  it('routes a configured telegram channel and replaces the token with the loopback one', () => {
    const config = { channels: { telegram: { enabled: true, botToken: 'real:secret-token' } } };
    const result = wire(config);

    expect(result.changed).toBe(true);
    expect(result.routedChannels).toEqual(['telegram']);
    expect(config.channels.telegram).toMatchObject({
      enabled: true,
      apiRoot: 'http://127.0.0.1:8585/telegram',
      botToken: TOKEN
    });
  });

  it('leaves the real token nowhere in the written config', () => {
    const config = { channels: { telegram: { botToken: 'real:secret-token' } } };
    wire(config);

    expect(JSON.stringify(config)).not.toContain('real:secret-token');
  });

  it('is idempotent', () => {
    const config = { channels: { telegram: { botToken: 'real:secret-token' } } };
    wire(config);
    const second = wire(config);

    expect(second.changed).toBe(false);
    expect(second.routedChannels).toEqual(['telegram']);
  });

  it('does nothing when the channel is not configured', () => {
    const config = { channels: { discord: { botToken: 'x' } } };
    const result = wire(config);

    expect(result.changed).toBe(false);
    expect(result.routedChannels).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('does nothing when there are no channels at all', () => {
    const config: Record<string, any> = {};
    expect(wire(config).changed).toBe(false);
    expect(config.channels).toBeUndefined();
  });

  describe('refusals', () => {
    it('refuses when the vault has no credential, leaving the working token alone', () => {
      const config = { channels: { telegram: { botToken: 'real:secret-token' } } };
      const result = wire(config, hasNone);

      expect(result.changed).toBe(false);
      expect(result.skipped).toEqual([{ channel: 'telegram', reason: 'no-vault-credential' }]);
      expect(config.channels.telegram.botToken).toBe('real:secret-token');
      expect(config.channels.telegram).not.toHaveProperty('apiRoot');
    });

    it('refuses a self-hosted Bot API server', () => {
      const config = {
        channels: { telegram: { botToken: 'real:t', apiRoot: 'https://bot-api.example.com' } }
      };
      const result = wire(config);

      expect(result.changed).toBe(false);
      expect(result.skipped).toEqual([{ channel: 'telegram', reason: 'user-endpoint' }]);
      expect(config.channels.telegram.apiRoot).toBe('https://bot-api.example.com');
    });

    it('refuses a tokenFile-sourced token', () => {
      const config = { channels: { telegram: { tokenFile: '/etc/telegram.token' } } };
      const result = wire(config);

      expect(result.skipped).toEqual([{ channel: 'telegram', reason: 'token-file' }]);
      expect(config.channels.telegram).not.toHaveProperty('apiRoot');
    });

    it('refuses multi-account setups', () => {
      const config = {
        channels: { telegram: { accounts: { main: { botToken: 'a' }, alt: { botToken: 'b' } } } }
      };
      const result = wire(config);

      expect(result.skipped).toEqual([{ channel: 'telegram', reason: 'multi-account' }]);
      expect(config.channels.telegram).not.toHaveProperty('apiRoot');
    });
  });

  it('re-points a stale aquaman apiRoot at the current port', () => {
    const config = {
      channels: { telegram: { botToken: TOKEN, apiRoot: 'http://127.0.0.1:9999/telegram' } }
    };
    const result = wire(config);

    expect(result.changed).toBe(true);
    expect(config.channels.telegram.apiRoot).toBe('http://127.0.0.1:8585/telegram');
  });
});

describe('channelRoutingStatus', () => {
  it('reports a wired channel as routed', () => {
    const config = {
      channels: { telegram: { apiRoot: 'http://127.0.0.1:8585/telegram', botToken: TOKEN } }
    };
    const status = channelRoutingStatus(config, { hasVaultCredential: hasAll });

    expect(status.routed).toEqual(['telegram']);
    expect(status.notRouted).toEqual([]);
  });

  it('reports a configured but unwired channel', () => {
    const config = { channels: { telegram: { botToken: 'real:t' } } };
    const status = channelRoutingStatus(config, { hasVaultCredential: hasAll });

    expect(status.routed).toEqual([]);
    expect(status.notRouted).toEqual([{ channel: 'telegram', reason: 'not-wired' }]);
  });

  it('distinguishes a missing vault credential from a plain missing wiring', () => {
    const config = { channels: { telegram: { botToken: 'real:t' } } };
    const status = channelRoutingStatus(config, { hasVaultCredential: hasNone });

    expect(status.notRouted).toEqual([{ channel: 'telegram', reason: 'no-vault-credential' }]);
  });

  it('lists configured channels the host exposes no override for', () => {
    const config = { channels: { discord: { botToken: 'x' }, slack: { botToken: 'y' } } };
    const status = channelRoutingStatus(config, { hasVaultCredential: hasAll });

    expect(status.unroutable).toEqual(['discord', 'slack']);
    expect(status.routed).toEqual([]);
  });

  it('says nothing about channels that are not configured', () => {
    const status = channelRoutingStatus({ channels: {} }, { hasVaultCredential: hasAll });

    expect(status).toEqual({ routed: [], notRouted: [], unroutable: [] });
  });
});

describe('coverage lists', () => {
  it('keeps the routable and unroutable sets disjoint', () => {
    const overlap = CHANNEL_ROUTING_SUPPORTED.filter(c =>
      (CHANNEL_ROUTING_UNSUPPORTED as readonly string[]).includes(c)
    );
    expect(overlap).toEqual([]);
  });
});
