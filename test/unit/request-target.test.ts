/**
 * The proxy's one reading of a client's request target. Each refusal here is
 * a path that two parsers read differently, which is how a policy rule gets
 * dodged or a credential gets sent to the wrong host.
 */

import { describe, it, expect } from 'vitest';
import { parseRequestTarget, policyPathInterpretations, policyMethods, policyPathOverrides } from 'aquaman-proxy';

const ok = (url: string) => {
  const t = parseRequestTarget(url);
  if (!t.ok) throw new Error(`expected ${url} to parse, got: ${t.reason}`);
  return t;
};
const reason = (url: string) => {
  const t = parseRequestTarget(url);
  return t.ok ? null : t.reason;
};

describe('parseRequestTarget', () => {
  it('splits a plain path into segments and keeps the query apart', () => {
    expect(ok('/anthropic/v1/messages')).toEqual({ ok: true, segments: ['anthropic', 'v1', 'messages'], search: '' });
    expect(ok('/anthropic/v1/messages?beta=true&x=/a/../b')).toEqual({
      ok: true, segments: ['anthropic', 'v1', 'messages'], search: '?beta=true&x=/a/../b',
    });
    expect(ok('//anthropic//v1/messages/').segments).toEqual(['anthropic', 'v1', 'messages']);
  });

  it('keeps url-path credentials and ordinary punctuation intact', () => {
    expect(ok('/telegram/bot123456:AAtoken_-x/sendMessage').segments).toEqual(['telegram', 'bot123456:AAtoken_-x', 'sendMessage']);
    expect(ok('/github/repos/o/r/git/refs/heads%2Fmain').segments[6]).toBe('heads%2Fmain');
    expect(ok('/x/a@b,c;d=e+f').segments[1]).toBe('a@b,c;d=e+f');
  });

  it('normalises percent-encoding so policy and upstream see the same text', () => {
    expect(ok('/anthropic/v1/%6Frganizations').segments).toEqual(['anthropic', 'v1', 'organizations']);
    expect(ok('/x/a%2fb%3a').segments[1]).toBe('a%2Fb%3A');
  });

  it.each([
    ['/anthropic/\\evil.example/x', 'backslash'],
    ['/anthropic/\\\\evil.example/x', 'backslash'],
    ['/anthropic/v1/%5Cevil.example', 'encoded backslash'],
    ['/anthropic/v1/x/../organizations', 'dot segment'],
    ['/anthropic/v1/./organizations', 'dot segment'],
    ['/anthropic/v1/%2e%2e/organizations', 'dot segment'],
    ['/anthropic/v1/%2E/organizations', 'dot segment'],
    ['/anthropic/v1/x%2F..%2Forganizations', 'encoded dot segment'],
    ['/anthropic/v1/%252e%252e/organizations', 'double-encoded'],
    ['/anthropic/v1/a%252Fb', 'double-encoded'],
    ['/anthropic/v1/a%255Cb', 'double-encoded'],
    ['/anthropic/v1/%zz', 'malformed percent-escape'],
    ['/anthropic/v1/%', 'malformed percent-escape'],
    ['/anthropic/v1/%ff', 'not valid UTF-8'],
    ['/anthropic/v1/a%00b', 'control character'],
    ['/anthropic/v1/a%0Ab', 'control character'],
    ['/anthropic/v1/a b', 'whitespace'],
    ['/anthropic/v1/a\tb', 'whitespace'],
    ['/anthropic/v1/a#b', 'fragment'],
    ['/anthropic/v1?x=a b', 'query'],
    ['http://evil.example/anthropic/v1', 'must start with /'],
    ['anthropic/v1', 'must start with /'],
    ['*', 'must start with /'],
  ])('refuses %s', (url, expected) => {
    expect(reason(url)).toContain(expected);
  });

  it('never yields a segment that a URL resolver could read as a host or a traversal', () => {
    const hostile = [
      '/a/\\b', '/a/..', '/a/%2e%2e/b', '/a/b%2f..%2fc', '/a/%5cb', '/a/\tb', '/a/b#c', '/a/%2E%2E%2Fb',
      '/a/..%2f', '/a/%2f%2fevil.example', '/a//evil.example/x', '/a/b/%2e', '/a/;/../b',
    ];
    for (const url of hostile) {
      const t = parseRequestTarget(url);
      if (!t.ok) continue;
      const resolved = new URL('/' + t.segments.slice(1).join('/') + t.search, 'https://upstream.example');
      expect(resolved.origin, url).toBe('https://upstream.example');
      expect(resolved.pathname, url).toBe('/' + t.segments.slice(1).join('/'));
    }
  });
});

describe('policyPathInterpretations', () => {
  it('is just the forwarded path when nothing is ambiguous', () => {
    expect(policyPathInterpretations(['v1', 'messages'])).toEqual(['/v1/messages']);
    expect(policyPathInterpretations([])).toEqual(['/']);
  });

  it('adds the reading of an upstream that decodes %2F or drops ;params', () => {
    expect(policyPathInterpretations(['v1', 'organizations;x', 'y'])).toEqual(['/v1/organizations;x/y', '/v1/organizations/y']);
    expect(policyPathInterpretations(['v1', 'a%2Forganizations'])).toEqual(['/v1/a%2Forganizations', '/v1/a/organizations']);
  });
});

describe('policyMethods', () => {
  it('returns the request method, upper-cased', () => {
    expect(policyMethods('post', {})).toEqual(['POST']);
  });

  it('adds every method an override header names', () => {
    expect(policyMethods('POST', { 'x-http-method-override': 'delete' })).toEqual(['POST', 'DELETE']);
    expect(policyMethods('POST', { 'x-method-override': ['PUT', 'PATCH'], 'x-http-method': ' DELETE ' }))
      .toEqual(['POST', 'PUT', 'PATCH', 'DELETE']);
    expect(policyMethods('POST', { 'x-http-method-override': 'POST' })).toEqual(['POST']);
  });

  it('reads a list in one header value, and a header sent twice, as several methods', () => {
    const rows: Array<[string | string[], string[]]> = [
      ['DELETE, GET', ['POST', 'DELETE', 'GET']],
      ['GET, DELETE', ['POST', 'GET', 'DELETE']],
      ['DELETE,GET', ['POST', 'DELETE', 'GET']],
      ['DELETE;', ['POST', 'DELETE']],
      ['get delete', ['POST', 'GET', 'DELETE']],
      [' , ', ['POST']],
      [['DELETE', 'GET'], ['POST', 'DELETE', 'GET']],
      [['PUT, PATCH', 'DELETE'], ['POST', 'PUT', 'PATCH', 'DELETE']],
    ];
    for (const name of ['x-http-method-override', 'x-method-override', 'x-http-method']) {
      for (const [value, expected] of rows) {
        expect(policyMethods('POST', { [name]: value }), `${name}: ${JSON.stringify(value)}`).toEqual(expected);
      }
    }
  });

  it('adds a method named by a _method query parameter, however the parameter is spelled', () => {
    const rows: Array<[string, string[]]> = [
      ['?_method=DELETE', ['POST', 'DELETE']],
      ['?x=1&_method=delete', ['POST', 'DELETE']],
      ['?x=1;_method=DELETE', ['POST', 'DELETE']],
      ['?%5Fmethod=DELETE', ['POST', 'DELETE']],
      ['?_method=%44ELETE', ['POST', 'DELETE']],
      ['?_METHOD=PUT', ['POST', 'PUT']],
      ['?_method=GET&_method=DELETE', ['POST', 'GET', 'DELETE']],
      ['?_method=PUT+PATCH', ['POST', 'PUT', 'PATCH']],
      // Not the parameter, no value, or nothing at all.
      ['?my_method=DELETE', ['POST']],
      ['?_method', ['POST']],
      ['?_method=', ['POST']],
      ['?&&', ['POST']],
      ['', ['POST']],
      // An escape that does not decode is taken as written.
      ['?_method=%zzDELETE', ['POST', '%ZZDELETE']],
    ];
    for (const [search, expected] of rows) {
      expect(policyMethods('POST', {}, search), search).toEqual(expected);
    }
  });
});

describe('policyPathOverrides', () => {
  it('is empty when no path-override header is present', () => {
    expect(policyPathOverrides({})).toEqual({ ok: true, paths: [] });
    expect(policyPathOverrides({ 'x-original-url': '', 'x-rewrite-url': ' , ' })).toEqual({ ok: true, paths: [] });
  });

  it('returns every reading of each path a header names', () => {
    const rows: Array<[Record<string, string | string[]>, string[]]> = [
      [{ 'x-original-url': '/v1/admin/users' }, ['/v1/admin/users']],
      [{ 'x-rewrite-url': '/v1/admin/users?x=1' }, ['/v1/admin/users']],
      [{ 'x-original-url': '/v1%2Fadmin/users;p=1' }, ['/v1%2Fadmin/users;p=1', '/v1/admin/users']],
      [{ 'x-original-url': 'https://api.example/v1/admin' }, ['/v1/admin']],
      [{ 'x-original-url': 'HTTP://api.example' }, ['/']],
      [{ 'x-original-url': '/a, /b' }, ['/a', '/b']],
      [{ 'x-original-url': ['/a', '/b'], 'x-rewrite-url': '/a' }, ['/a', '/b']],
    ];
    for (const [headers, paths] of rows) {
      expect(policyPathOverrides(headers), JSON.stringify(headers)).toEqual({ ok: true, paths });
    }
  });

  it('reports a value the strict parser refuses, naming the header', () => {
    expect(policyPathOverrides({ 'x-original-url': '/v1/x/../admin' }))
      .toEqual({ ok: false, reason: 'x-original-url header: path contains a dot segment' });
    expect(policyPathOverrides({ 'x-rewrite-url': 'v1/admin' }))
      .toEqual({ ok: false, reason: 'x-rewrite-url header: request target must start with /' });
  });
});
