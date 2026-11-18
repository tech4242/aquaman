/**
 * Unit: which keys a route may name per auth mode, the strict reading of an
 * inbound Basic value, the lenient reading used to decide what must not go
 * upstream, and what services.yaml may declare for a basic service.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  routableKeys,
  routeKeyMismatch,
  parseBasicAuthorization,
  basicTokenCandidates,
  basicValueCarries,
} from '../../packages/proxy/src/route-auth.js';
import { ServiceRegistry, createServiceRegistry } from '../../packages/proxy/src/service-registry.js';
import { defaultRouteBasePath } from '../../packages/coder/src/projects.js';

const b64 = (text: string) => Buffer.from(text, 'latin1').toString('base64');

describe('routableKeys', () => {
  it.each([
    ['a header service', { credentialKey: 'api_key' }, ['api_key']],
    ['a header service with other keys', { authMode: 'header' as const, credentialKey: 'bot_token', additionalCredentialKeys: ['channel_secret'] }, ['bot_token']],
    ['a basic service with a password key', { authMode: 'basic' as const, credentialKey: 'email', additionalCredentialKeys: ['api_token', 'unused'] }, ['email', 'api_token']],
    ['a basic service with one key', { authMode: 'basic' as const, credentialKey: 'password', additionalCredentialKeys: [] }, ['password']],
    ['a basic service that lists no other keys', { authMode: 'basic' as const, credentialKey: 'password' }, ['password']],
    ['a url-path service', { authMode: 'url-path' as const, credentialKey: 'bot_token' }, []],
    ['an oauth service', { authMode: 'oauth' as const, credentialKey: 'client_id', additionalCredentialKeys: ['client_secret'] }, []],
    ['an at-rest service', { authMode: 'none' as const, credentialKey: 'private_key' }, []],
  ])('%s', (_name, def, keys) => {
    expect(routableKeys(def)).toEqual(keys);
  });

  it('every builtin basic service routes by its user name and its password, and nothing else', () => {
    const registry = createServiceRegistry({ configPath: '/nonexistent/services.yaml' });
    const basic = registry.getAll().filter((s) => s.authMode === 'basic').map((s) => [s.name, routableKeys(s)]);
    expect(Object.fromEntries(basic)).toEqual({
      twilio: ['account_sid', 'auth_token'],
      bluebubbles: ['password'],
      nextcloud: ['api_user', 'api_password'],
    });
  });

  it('routeKeyMismatch names every key the proxy injects', () => {
    expect(routeKeyMismatch('stripe', ['secret_key'], 'restricted_key')).toEqual({
      error: 'The proxy injects stripe/secret_key for this service, not stripe/restricted_key',
      fix: 'Use aquaman://stripe/secret_key',
    });
    expect(routeKeyMismatch('twilio', ['account_sid', 'auth_token'], 'phone')).toEqual({
      error: 'The proxy injects twilio/account_sid and twilio/auth_token for this service, not twilio/phone',
      fix: 'Use aquaman://twilio/account_sid or aquaman://twilio/auth_token',
    });
  });
});

describe('parseBasicAuthorization', () => {
  it.each([
    ['user and password', `Basic ${b64('user:pass')}`, { user: 'user', password: 'pass' }],
    ['a colon in the password', `Basic ${b64('user:pa:ss')}`, { user: 'user', password: 'pa:ss' }],
    ['an empty user name', `Basic ${b64(':pass')}`, { user: '', password: 'pass' }],
    ['an empty password', `Basic ${b64('user:')}`, { user: 'user', password: '' }],
    ['a lower-case scheme', `basic ${b64('user:pass')}`, { user: 'user', password: 'pass' }],
    ['bytes above ASCII, one character each', `Basic ${b64(`${String.fromCharCode(0xfc)}:p`)}`, { user: String.fromCharCode(0xfc), password: 'p' }],
    ['a value at the length cap', `Basic ${b64(`${'u'.repeat(766)}:`)}`, { user: 'u'.repeat(766), password: '' }],
  ])('reads %s', (_name, value, expected) => {
    expect(parseBasicAuthorization(value)).toEqual(expected);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['the scheme alone', 'Basic'],
    ['the scheme and a space', 'Basic '],
    ['another scheme', `Bearer ${b64('user:pass')}`],
    ['no colon', `Basic ${b64('userpass')}`],
    ['two spaces', `Basic  ${b64('user:pass')}`],
    ['a tab', `Basic\t${b64('user:pass')}`],
    ['a leading space', ` Basic ${b64('user:pass')}`],
    ['a trailing space', `Basic ${b64('user:pass')} `],
    ['a trailing newline', `Basic ${b64('user:pass')}\n`],
    ['text after the value', `Basic ${b64('user:pass')} x`],
    ['a character outside the alphabet', `Basic ${b64('user:pass').replace('c', '*')}`],
    ['the URL-safe alphabet', `Basic ${Buffer.from(`${String.fromCharCode(0xfb, 0xff)}:`, 'latin1').toString('base64url')}`],
    ['missing padding', `Basic ${b64('user:pa')}`.replace(/=+$/, '')],
    ['extra padding', `Basic ${b64('user:pass')}=`],
    ['three padding characters', 'Basic dXM6===='],
    ['non-canonical trailing bits', 'Basic dXNlcjpwYXN='],
    ['one base64 character', 'Basic d'],
    ['a value past the length cap', `Basic ${b64(`${'u'.repeat(769)}:`)}`],
    ['a value far past the length cap', `Basic ${b64(`${'u'.repeat(100_000)}:p`)}`],
  ])('refuses %s', (_name, value) => {
    expect(parseBasicAuthorization(value)).toBeNull();
    expect(basicTokenCandidates(value)).toEqual([]);
  });

  it('the refused rows are what they claim to be', () => {
    expect(b64('user:pa').endsWith('=')).toBe(true);
    expect(b64('user:pass').endsWith('=')).toBe(false);
    expect(Buffer.from('dXNlcjpwYXN=', 'base64').toString()).toBe('user:pas');
    expect(b64('user:pas')).toBe('dXNlcjpwYXM=');
    expect(b64(`${'u'.repeat(766)}:`).length).toBe(1024);
    expect(b64(`${'u'.repeat(769)}:`).length).toBe(1028);
  });

  it('basicTokenCandidates gives both halves', () => {
    expect(basicTokenCandidates(`Basic ${b64('left:right')}`)).toEqual(['left', 'right']);
  });

  it('a long run of the scheme word is read in linear time', () => {
    const started = Date.now();
    expect(parseBasicAuthorization(`Basic ${'A'.repeat(200_000)}!`)).toBeNull();
    expect(basicValueCarries(`${'basic '.repeat(50_000)}!`, ['aqm_rt_x'])).toBe(false);
    expect(basicValueCarries(`basic${' '.repeat(200_000)}!`, ['aqm_rt_x'])).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('basicValueCarries', () => {
  const token = `aqm_rt_${'ab'.repeat(24)}`;
  const other = 'aqm_lb_some_loopback_token';

  it.each([
    ['as the password', `Basic ${b64(`user:${token}`)}`],
    ['as the user name', `Basic ${b64(`${token}:x`)}`],
    ['with a lower-case scheme', `basic ${b64(`user:${token}`)}`],
    ['with an upper-case scheme and several spaces', `BASIC   ${b64(`user:${token}`)}`],
    ['with a tab after the scheme', `Basic\t${b64(`user:${token}`)}`],
    ['without padding', `Basic ${b64(`abc:${token}`).replace(/=+$/, '')}`],
    ['in the URL-safe alphabet', `Basic ${Buffer.from(`${String.fromCharCode(0xfb, 0xff)}:${token}`, 'latin1').toString('base64url')}`],
    ['in the middle of a value', `a=1; auth="Basic ${b64(`user:${token}`)}"; b=2`],
    ['as the second Basic value', `Basic ${b64('user:pass')}, Basic ${b64(`user:${token}`)}`],
    ['with no colon at all', `Basic ${b64(token)}`],
  ])('finds a token %s', (_name, value) => {
    expect(basicValueCarries(value, [token])).toBe(true);
    expect(basicValueCarries(value, [other, token])).toBe(true);
    expect(basicValueCarries(value, [other])).toBe(false);
  });

  it.each([
    ['an unrelated Basic value', `Basic ${b64('user:pass')}`],
    ['prose that contains the word', 'basic information'],
    ['an empty value', ''],
    ['the scheme alone', 'Basic'],
    ['base64 of the token without the scheme', b64(`user:${token}`)],
    ['base64 of the token under another scheme', `Bearer ${b64(`user:${token}`)}`],
  ])('does not flag %s', (_name, value) => {
    expect(basicValueCarries(value, [token, other])).toBe(false);
  });
});

describe('services.yaml: a basic service with a second key', () => {
  const registry = new ServiceRegistry({ builtinServices: false, configPath: '/nonexistent/services.yaml' });
  const zendesk = {
    name: 'zendesk',
    upstream: 'https://example.zendesk.com',
    authMode: 'basic' as const,
    authHeader: 'Authorization',
    credentialKey: 'email',
    additionalCredentialKeys: ['api_token'],
  };

  it('accepts the definition, and loads it from a file with both keys', () => {
    expect(registry.validateService(zendesk)).toEqual({ valid: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-svc-'));
    const file = path.join(dir, 'services.yaml');
    fs.writeFileSync(file, [
      'services:',
      '  - name: zendesk',
      '    upstream: https://example.zendesk.com',
      '    authMode: basic',
      '    authHeader: Authorization',
      '    credentialKey: email',
      '    additionalCredentialKeys: [api_token]',
      '',
    ].join('\n'));
    expect(ServiceRegistry.validateConfigFile(file)).toEqual({ valid: true, errors: [] });
    const loaded = createServiceRegistry({ configPath: file }).get('zendesk')!;
    expect(loaded).toMatchObject({ authMode: 'basic', credentialKey: 'email', additionalCredentialKeys: ['api_token'] });
    expect(routableKeys(loaded)).toEqual(['email', 'api_token']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['an auth mode the proxy does not know', { authMode: 'digest' as never }, 'authMode must be one of: header, url-path, basic, oauth, none'],
    ['additional keys that are not a list', { additionalCredentialKeys: 'api_token' as never }, 'additionalCredentialKeys must be a list of key names (letters, digits, ".", "_", "-")'],
    ['an additional key that is not a string', { additionalCredentialKeys: [7] as never }, 'additionalCredentialKeys must be a list of key names (letters, digits, ".", "_", "-")'],
    ['an additional key with a path in it', { additionalCredentialKeys: ['../api_token'] }, 'additionalCredentialKeys must be a list of key names (letters, digits, ".", "_", "-")'],
    ['an empty additional key', { additionalCredentialKeys: [''] }, 'additionalCredentialKeys must be a list of key names (letters, digits, ".", "_", "-")'],
    ['the user-name key repeated as the password key', { additionalCredentialKeys: ['email'] }, 'additionalCredentialKeys must not repeat a key'],
    ['the same additional key twice', { additionalCredentialKeys: ['api_token', 'api_token'] }, 'additionalCredentialKeys must not repeat a key'],
  ])('refuses %s', (_name, change, error) => {
    expect(registry.validateService({ ...zendesk, ...change })).toEqual({ valid: false, error });
  });

  it('a file with a refused definition is reported and the service is not loaded', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqm-svc-'));
    const file = path.join(dir, 'services.yaml');
    fs.writeFileSync(file, 'services:\n  - name: zendesk\n    upstream: https://example.zendesk.com\n    authMode: basic\n    authHeader: Authorization\n    credentialKey: email\n    additionalCredentialKeys: [email]\n');
    expect(ServiceRegistry.validateConfigFile(file)).toEqual({ valid: false, errors: ['Service 1: additionalCredentialKeys must not repeat a key'] });
    expect(createServiceRegistry({ configPath: file }).has('zendesk')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('every builtin definition passes the same validation', () => {
    const all = createServiceRegistry({ configPath: '/nonexistent/services.yaml' });
    for (const service of all.getAll()) {
      expect(all.validateService(service), service.name).toEqual({ valid: true });
    }
  });
});

describe('defaultRouteBasePath', () => {
  it.each([
    ['openai', '/v1'],
    ['slack', '/api'],
    ['anthropic', ''],
    ['stripe', ''],
    ['zendesk', ''],
  ])('%s -> "%s"', (service, basePath) => {
    expect(defaultRouteBasePath(service)).toBe(basePath);
  });
});
