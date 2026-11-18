/**
 * Which credentials a program can be routed to, and how the proxy reads its
 * own token out of an HTTP basic `Authorization` value.
 *
 * A routed program holds a route token where its secret would be. For a
 * header service that is the whole header value. For a basic service the
 * client library builds `Basic base64(user:password)` itself, so the token
 * arrives as one half of that pair and has to be decoded to be recognised.
 */

import type { ServiceDefinition } from './service-registry.js';

/** Base64 characters allowed in an inbound Basic value. A user name plus a token fits many times over. */
const MAX_BASIC_BASE64_LENGTH = 1024;

/**
 * The vault keys a route may name for a service: the ones the proxy injects.
 * A header service has one. A basic service has the user name and, when it
 * declares one, the password. Other auth modes are not routable.
 */
export function routableKeys(def: Pick<ServiceDefinition, 'authMode' | 'credentialKey' | 'additionalCredentialKeys'>): string[] {
  const mode = def.authMode ?? 'header';
  if (mode === 'header') return [def.credentialKey];
  if (mode === 'basic') {
    const password = def.additionalCredentialKeys?.[0];
    return password ? [def.credentialKey, password] : [def.credentialKey];
  }
  return [];
}

/** What to tell someone who routed a key the proxy does not inject for the service. */
export function routeKeyMismatch(service: string, keys: readonly string[], key: string): { error: string; fix: string } {
  const refs = keys.map((k) => `aquaman://${service}/${k}`);
  return {
    error: `The proxy injects ${keys.map((k) => `${service}/${k}`).join(' and ')} for this service, not ${service}/${key}`,
    fix: `Use ${refs.join(' or ')}`,
  };
}

/**
 * Read `Basic <base64(user:password)>` strictly. Returns null for anything
 * that is not exactly that: another scheme, more than one space after it,
 * anything after the value, characters outside the base64
 * alphabet, wrong padding, an encoding that does not round-trip, input past
 * the length cap, or a decoded value without a colon. A value two decoders
 * could read differently is never accepted as carrying the token.
 */
export function parseBasicAuthorization(value: string | undefined): { user: string; password: string } | null {
  if (typeof value !== 'string') return null;
  // The scheme name is case-insensitive (RFC 9110); everything after it is exact.
  const match = /^basic ([A-Za-z0-9+/]{2,}={0,2})$/i.exec(value);
  if (!match) return null;
  const encoded = match[1];
  if (encoded.length > MAX_BASIC_BASE64_LENGTH || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return null;
  // One byte per character, so a non-ASCII user name cannot shift where the colon is.
  const decoded = bytes.toString('latin1');
  const colon = decoded.indexOf(':');
  if (colon === -1) return null;
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The two places a basic client may have put a token: the user name and the password. */
export function basicTokenCandidates(value: string | undefined): string[] {
  const parsed = parseBasicAuthorization(value);
  return parsed ? [parsed.user, parsed.password] : [];
}

/**
 * True when a header value holds one of the given tokens inside a Basic
 * value. Used to decide what must not go upstream, so it decodes leniently
 * (any case of the scheme, any spacing, either base64 alphabet, anywhere in
 * the value): refusing to forward too much costs nothing, forwarding a token
 * the strict reader would have rejected does.
 */
export function basicValueCarries(value: string, tokens: readonly string[]): boolean {
  const pattern = /basic\s+([A-Za-z0-9+/_=-]+)/gi;
  for (const match of value.matchAll(pattern)) {
    const decoded = Buffer.from(match[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    if (tokens.some((t) => decoded.includes(t))) return true;
  }
  return false;
}
