/**
 * Unit tests for the names an Agent Substrate request carries, the grants
 * file and the provider's settings.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WrapperConfig } from 'aquaman-core';
import {
  isGranted, isSubstrateName, loadSubstrateGrants, parseActorSpiffeId, parseSecretUri, watchedSubstrateGrants,
} from '../../../packages/proxy/src/substrate/grants.js';
import { uriSubjectAltNames, callerRefusal, readTlsContext } from '../../../packages/proxy/src/substrate/grpc-server.js';
import {
  substrateProviderSettings, auditProviderAccess, auditLeftOutRefusals, createRefusalLimiter, DEFAULT_CALLER_SPIFFE_ID,
} from '../../../packages/proxy/src/substrate/integration.js';

describe('secret URIs and actor identities', () => {
  it('reads a secret URI into aquaman service and key', () => {
    expect(parseSecretUri('ate-secret://aquaman/github/token', 'aquaman')).toEqual({ service: 'github', key: 'token' });
    expect(parseSecretUri('ate-secret://vault.corp/cloudflare-ai/api_token', 'vault.corp')).toEqual({ service: 'cloudflare-ai', key: 'api_token' });
  });

  it('refuses anything else', () => {
    for (const uri of ['ate-secret://aquaman/github', 'ate-secret://aquaman//token', 'ate-secret://Aquaman/github/token',
      'ate-secret://aquaman/github/token/', `ate-secret://aquaman/github/${'k'.repeat(600)}`]) {
      expect(parseSecretUri(uri, 'aquaman')).toBeNull();
    }
    expect(parseSecretUri(undefined as unknown as string, 'aquaman')).toBeNull();
  });

  it('reads an actor identity into atespace and actor', () => {
    expect(parseActorSpiffeId('spiffe://substrate-actor.local/actor/team-a/coder', 'substrate-actor.local'))
      .toEqual({ atespace: 'team-a', actor: 'coder' });
    expect(parseActorSpiffeId('spiffe://substrate-actor.local/actor/team-a/coder', 'other.local')).toBeNull();
    expect(parseActorSpiffeId(undefined as unknown as string, 'substrate-actor.local')).toBeNull();
    expect(parseActorSpiffeId(`spiffe://substrate-actor.local/actor/a/${'b'.repeat(2000)}`, 'substrate-actor.local')).toBeNull();
  });

  it('accepts Kubernetes-style names only', () => {
    expect(isSubstrateName('team-a')).toBe(true);
    expect(isSubstrateName('a.b')).toBe(true);
    for (const bad of ['', '-a', 'a-', 'A', 'a..b', 'a/b', 'a b', '*']) expect(isSubstrateName(bad)).toBe(false);
  });
});

describe('grants file', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqgr-')); file = path.join(dir, 'config.yaml'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reads atespace and actor entries', () => {
    fs.writeFileSync(file, 'substrate:\n  provider:\n    grants:\n      team-a:\n        - aquaman://github/token\n      team-a/billing:\n        - aquaman://stripe/api_key\n');
    const g = loadSubstrateGrants(file);
    expect(g.error).toBeUndefined();
    expect(isGranted(g, { atespace: 'team-a', actor: 'x' }, 'aquaman://github/token')).toBe(true);
    expect(isGranted(g, { atespace: 'team-a', actor: 'billing' }, 'aquaman://stripe/api_key')).toBe(true);
    expect(isGranted(g, { atespace: 'team-a', actor: 'x' }, 'aquaman://stripe/api_key')).toBe(false);
    expect(isGranted(g, { atespace: 'team-b', actor: 'billing' }, 'aquaman://stripe/api_key')).toBe(false);
  });

  it('grants nothing without a file, without the key, and for a file it cannot read', () => {
    expect(loadSubstrateGrants(file)).toEqual({ grants: new Map() });
    fs.writeFileSync(file, 'broker:\n  enabled: true\n');
    expect(loadSubstrateGrants(file)).toEqual({ grants: new Map() });
    expect(loadSubstrateGrants(dir).error).toMatch(/cannot read/);
  });

  it('names what it left out', () => {
    fs.writeFileSync(file, JSON.stringify({ substrate: { provider: { grants: {
      'team-a': ['aquaman://github/token', 'aquaman://aquaman_internal/audit_anchor', 7, 'github/token'],
      'Team B': ['aquaman://github/token'],
    } } } }));
    const g = loadSubstrateGrants(file);
    expect([...g.grants.get('team-a')!]).toEqual(['aquaman://github/token']);
    expect(g.grants.has('Team B')).toBe(false);
    expect(g.error).toContain('aquaman_internal');
    expect(g.error).toContain('Team B');
  });

  it('is read again when the file changes, and not otherwise', () => {
    const grants = watchedSubstrateGrants(file);
    expect(grants().grants.size).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ substrate: { provider: { grants: { a: ['aquaman://x/y'] } } } }));
    const first = grants();
    expect(first.grants.size).toBe(1);
    expect(grants()).toBe(first);
    fs.rmSync(file);
    expect(grants().grants.size).toBe(0);
  });
});

describe('names in a certificate', () => {
  it('takes the URI names and nothing else', () => {
    expect(uriSubjectAltNames(undefined)).toEqual([]);
    expect(uriSubjectAltNames('DNS:a.svc, IP Address:10.0.0.1')).toEqual([]);
    expect(uriSubjectAltNames('URI:spiffe://a/b, DNS:x.svc, URI:spiffe://c/d')).toEqual(['spiffe://a/b', 'spiffe://c/d']);
  });

  it('keeps a name Node printed in quotes as one name that matches nothing', () => {
    expect(uriSubjectAltNames('URI:"spiffe://a/b\\u002c URI:spiffe://c/d", DNS:x')).toEqual(['"spiffe://a/b\\u002c URI:spiffe://c/d"']);
    expect(uriSubjectAltNames('URI:"a\\", URI:spiffe://c/d"')).toEqual(['"a\\", URI:spiffe://c/d"']);
  });

  it('refuses a caller with no certificate or one that does not parse', () => {
    expect(callerRefusal(undefined, DEFAULT_CALLER_SPIFFE_ID)).toMatch(/no certificate/);
    expect(callerRefusal(Buffer.alloc(0), DEFAULT_CALLER_SPIFFE_ID)).toMatch(/no certificate/);
    expect(callerRefusal(Buffer.from('not a certificate'), DEFAULT_CALLER_SPIFFE_ID)).toMatch(/could not be read/);
  });

  it('refuses a certificate outside its validity dates, also on a connection that is already open', async () => {
    const { createTestAuthority } = await import('../../helpers/test-pki.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqcv-'));
    try {
      const leaf = createTestAuthority(dir, 'ids').issue('gw', { uris: [DEFAULT_CALLER_SPIFFE_ID] });
      const der = new (await import('node:crypto')).X509Certificate(leaf.certPem).raw;
      expect(callerRefusal(der, DEFAULT_CALLER_SPIFFE_ID)).toBeNull();
      expect(callerRefusal(der, DEFAULT_CALLER_SPIFFE_ID, Date.now() + 3 * 86_400_000)).toMatch(/validity dates/);
      expect(callerRefusal(der, DEFAULT_CALLER_SPIFFE_ID, Date.now() - 3 * 86_400_000)).toMatch(/validity dates/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the file that cannot be read', () => {
    expect(() => readTlsContext({ certFile: '/nonexistent/a.pem', keyFile: '/nonexistent/a.pem', clientCaFile: '/nonexistent/ca.pem' }))
      .toThrow(/serving certificate at \/nonexistent\/a\.pem/);
  });
});

describe('provider settings', () => {
  const config = (provider: Record<string, unknown>) => ({ substrate: { provider: { enabled: true, ...provider } } }) as unknown as WrapperConfig;
  const tlsFiles = { certFile: '/run/a/bundle.pem', clientCaFile: '/run/b/ca.pem' };

  it('applies the defaults of a stock install', () => {
    expect(substrateProviderSettings(config({ tls: tlsFiles }))).toEqual({
      listen: '0.0.0.0:50051',
      name: 'aquaman',
      tls: { certFile: '/run/a/bundle.pem', keyFile: '/run/a/bundle.pem', clientCaFile: '/run/b/ca.pem' },
      callerSpiffeId: DEFAULT_CALLER_SPIFFE_ID,
      actorTrustDomain: 'substrate-actor.local',
      fetchesPerSecond: 20,
      atespaceFetchesPerSecond: 80,
    });
  });

  it.each([
    ['no TLS files', {}, /certFile/],
    ['no authority file', { tls: { certFile: '/a' } }, /clientCaFile/],
    ['a provider name Substrate would not accept', { tls: tlsFiles, name: 'Aquaman_1' }, /name/],
    ['a caller that is not a SPIFFE ID', { tls: tlsFiles, callerSpiffeId: 'atenet-egress' }, /callerSpiffeId/],
    ['a trust domain with a slash', { tls: tlsFiles, actorTrustDomain: 'a/b' }, /actorTrustDomain/],
    ['an address without a port', { tls: tlsFiles, listen: '0.0.0.0' }, /listen/],
    ['a fetch rate that is not a number', { tls: tlsFiles, fetchesPerSecond: 'many' }, /fetchesPerSecond/],
    ['a fetch rate of zero', { tls: tlsFiles, fetchesPerSecond: 0 }, /fetchesPerSecond/],
    ['an atespace rate below the actor rate', { tls: tlsFiles, atespaceFetchesPerSecond: 5 }, /atespaceFetchesPerSecond/],
  ])('refuses %s', (_what, provider, message) => {
    const s = substrateProviderSettings(config(provider));
    expect('error' in s && s.error).toMatch(message);
  });

  it('refuses when the section is missing altogether', () => {
    expect(substrateProviderSettings({} as WrapperConfig)).toHaveProperty('error');
  });
});

describe('audit entries', () => {
  it('names the actor as the session and the reference in the note', () => {
    const rows: unknown[] = [];
    const audit = { logCredentialAccess: (...args: unknown[]) => { rows.push(args); return 'written'; } };
    expect(auditProviderAccess(audit, { ref: 'aquaman://github/token', service: 'github', actor: { atespace: 'a', actor: 'b' }, success: true })).toBe('written');
    auditProviderAccess(audit, { success: false });
    expect(rows).toEqual([
      ['actor/a/b', 'substrate', { service: 'github', operation: 'read', success: true, error: undefined, note: 'aquaman://github/token' }],
      ['system', 'substrate', { service: 'aquaman-substrate', operation: 'read', success: false, error: 'refused', note: undefined }],
    ]);
  });

  const sink = () => {
    const rows: any[] = [];
    return { rows, audit: { logCredentialAccess: (...args: unknown[]) => { rows.push({ session: args[0], ...(args[2] as object) }); return 'written'; } } };
  };
  const refusal = (ref: string, error = 'not granted', actor = 'b') =>
    ({ ref, service: 'github', actor: { atespace: 'a', actor }, success: false, error });

  it('writes the same refusal once per window and counts the rest for a summary', async () => {
    let t = 1_000_000;
    const limiter = createRefusalLimiter({ now: () => t });
    const { rows, audit } = sink();
    expect(auditProviderAccess(audit, refusal('aquaman://github/token'), limiter)).toBe('written');
    for (let i = 0; i < 500; i++) { t += 100; expect(auditProviderAccess(audit, refusal('aquaman://github/token'), limiter)).toBeUndefined(); }
    expect(rows).toHaveLength(1);

    expect(await auditLeftOutRefusals(audit, limiter.flush())).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ session: 'actor/a/b', success: false, error: '500 more refusals were not written one by one' });
    // Counted once.
    expect(limiter.flush()).toEqual([]);

    t += 60_000;
    expect(auditProviderAccess(audit, refusal('aquaman://github/token'), limiter)).toBe('written');
  });

  it('writes at most twenty different refusals per caller per window, whatever the caller varies', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    const { rows, audit } = sink();
    for (let i = 0; i < 20_000; i++) auditProviderAccess(audit, refusal(`aquaman://github/k${i}`), limiter);
    for (let i = 0; i < 20_000; i++) auditProviderAccess(audit, { ...refusal('x'), ref: undefined, error: `"u${i}" is not a secret URI` }, limiter);
    expect(rows).toHaveLength(20);
    // Another actor is not held back by the first.
    auditProviderAccess(audit, refusal('aquaman://github/token', 'not granted', 'c'), limiter);
    expect(rows).toHaveLength(21);
    expect(limiter.flush()).toEqual([{ session: 'actor/a/b', leftOut: 39_980 }]);
  });

  it('writes a bounded number of refusals over all callers, however many callers there are', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    const { rows, audit } = sink();
    // 5,000 actor names, five identical refusals each: more names than are remembered.
    for (let n = 0; n < 5; n++) for (let a = 0; a < 5000; a++) auditProviderAccess(audit, refusal('aquaman://github/token', 'not granted', `actor-${a}`), limiter);
    expect(rows).toHaveLength(240);

    const summaries = limiter.flush();
    // A bounded number of summaries, and nothing lost from the count.
    expect(summaries.length).toBeLessThanOrEqual(51);
    expect(summaries.reduce((n, c) => n + c.leftOut, 0)).toBe(25_000 - 240);
  });

  it('keeps a refused caller and unreadable requests on separate accounts', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    for (let i = 0; i < 100; i++) limiter.admit('system', `unreadable ${i}`);
    for (let i = 0; i < 100; i++) limiter.admit('actor/a/b', `kind ${i}`);
    expect(limiter.admit('caller', 'not the gateway')).toBe(true);
  });

  it('actors that use up the overall bound do not take the entry that names a refused caller', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    // Twelve actors, twenty different refusals each: the whole overall bound.
    let written = 0;
    for (let a = 0; a < 12; a++) for (let k = 0; k < 20; k++) if (limiter.admit(`actor/t/a${a}`, `kind ${k}`)) written++;
    expect(written).toBe(240);
    expect(limiter.admit('actor/other/victim', 'not granted')).toBe(false);
    expect(limiter.admit('caller', 'not the gateway (it names "spiffe://cluster.local/ns/tenant/sa/rogue")')).toBe(true);
    expect(limiter.admit('system', 'an unreadable identity')).toBe(true);
  });

  it('names the caller and the unreadable requests in a summary, however many actors have larger counts', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    for (let a = 0; a < 60; a++) for (let k = 0; k < 40; k++) limiter.admit(`actor/t/a${a}`, `kind ${k}`);
    for (let i = 0; i < 3; i++) limiter.admit('caller', 'same');
    for (let i = 0; i < 2; i++) limiter.admit('system', 'same');
    const out = limiter.flush();
    expect(out.find((c) => c.session === 'caller')).toEqual({ session: 'caller', leftOut: 2 });
    expect(out.find((c) => c.session === 'system')).toEqual({ session: 'system', leftOut: 1 });
    // Fifty actors by name, the other ten together.
    expect(out.filter((c) => c.session.startsWith('actor/'))).toHaveLength(50);
    expect(out.find((c) => c.session === 'actors')!.leftOut).toBeGreaterThan(0);
    expect(out.reduce((n, c) => n + c.leftOut, 0)).toBe(60 * 40 - 240 + 2 + 1);
  });

  it('does not forget the caller or the unreadable requests, however many actor names come after them', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    let callerEntries = 0;
    for (let round = 0; round < 50; round++) {
      for (let i = 0; i < 100; i++) if (limiter.admit('caller', `identity ${i % 20}`)) callerEntries++;
      for (let a = 0; a < 5000; a++) limiter.admit(`actor/t/r${round}-a${a}`, 'not granted');
    }
    // Twenty identities, once each, in the one minute.
    expect(callerEntries).toBe(20);
    expect(limiter.flush().find((c) => c.session === 'caller')).toEqual({ session: 'caller', leftOut: 4980 });
  });

  it('puts a count back under the caller by name', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    limiter.restore([{ session: 'caller', leftOut: 9 }, { session: 'actor/gone/long-ago', leftOut: 4 }]);
    expect(limiter.flush()).toEqual([{ session: 'caller', leftOut: 9 }, { session: 'actors', leftOut: 4 }]);
  });

  it('keeps a count whose summary could not be written, and tries each on its own', async () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    for (const session of ['actor/a/b', 'actor/a/c', 'caller']) for (let i = 0; i < 4; i++) limiter.admit(session, 'same');
    const tried: string[] = [];
    const failing = { logCredentialAccess: (session: unknown) => { tried.push(String(session)); throw new Error('disk full'); } };
    const unwritten = await auditLeftOutRefusals(failing, limiter.flush());
    expect(tried).toHaveLength(3);
    expect(unwritten.reduce((n, c) => n + c.leftOut, 0)).toBe(9);
    limiter.restore(unwritten);
    expect(limiter.flush().reduce((n, c) => n + c.leftOut, 0)).toBe(9);
  });

  it('never leaves out a served fetch', () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    const { rows, audit } = sink();
    for (let i = 0; i < 300; i++) auditProviderAccess(audit, { ...refusal('aquaman://github/token'), success: true, error: undefined }, limiter);
    expect(rows).toHaveLength(300);
  });

  it('goes on when the clock is set back', () => {
    let t = 10_000_000;
    const limiter = createRefusalLimiter({ now: () => t });
    expect(limiter.admit('a', 'k')).toBe(true);
    t -= 3_600_000;
    expect(limiter.admit('a', 'k2')).toBe(true);
    expect(limiter.admit('a', 'k')).toBe(true);
  });

  // The summary says how many refusals were left out for a caller, not which references they were for.
  it.fails('limit: a refusal that was left out can be found again by its reference', async () => {
    const limiter = createRefusalLimiter({ now: () => 5 });
    const { rows, audit } = sink();
    for (let i = 0; i < 20; i++) auditProviderAccess(audit, refusal(`aquaman://github/junk${i}`), limiter);
    auditProviderAccess(audit, refusal('aquaman://stripe/the-one-of-interest'), limiter);
    await auditLeftOutRefusals(audit, limiter.flush());
    expect(JSON.stringify(rows)).toContain('the-one-of-interest');
  });
});

describe('fetch rate per actor', () => {
  it('lets a burst of twice the rate through and then the rate', async () => {
    const { createFetchRateLimit } = await import('../../../packages/proxy/src/substrate/credential-provider.js');
    let t = 0;
    const ok = createFetchRateLimit(20, () => t);
    let served = 0;
    for (let i = 0; i < 1000; i++) if (ok('a/b')) served++;
    expect(served).toBe(40);
    // Another actor has a bucket of its own.
    expect(ok('a/c')).toBe(true);
    t += 1000;
    served = 0;
    for (let i = 0; i < 1000; i++) if (ok('a/b')) served++;
    expect(served).toBe(20);
  });

  it('does not take tokens away when the clock is set back', async () => {
    const { createFetchRateLimit } = await import('../../../packages/proxy/src/substrate/credential-provider.js');
    let t = 10_000_000;
    const ok = createFetchRateLimit(20, () => t);
    for (let i = 0; i < 40; i++) ok('a');
    t -= 3_600_000;
    expect(ok('a')).toBe(false);
    t += 1000;
    expect(ok('a')).toBe(true);
  });

  it('bounds an atespace across its actors, however many names it uses', async () => {
    const { createSubstrateProviderCore } = await import('../../../packages/proxy/src/substrate/credential-provider.js');
    const { MemoryStore } = await import('aquaman-core');
    const store = new MemoryStore();
    await store.set('github', 'token', 'v');
    const core = createSubstrateProviderCore({
      store, providerName: 'aquaman', actorTrustDomain: 'substrate-actor.local', now: () => 5,
      grants: () => ({ grants: new Map([['team-a', new Set(['aquaman://github/token'])], ['team-b', new Set(['aquaman://github/token'])]]) }),
    });
    const ask = (atespace: string, actor: string) => core.fetchSecret({
      uri: 'ate-secret://aquaman/github/token', actor_spiffe_id: `spiffe://substrate-actor.local/actor/${atespace}/${actor}`,
    }).then(() => true, () => false);
    let served = 0;
    for (let i = 0; i < 5000; i++) if (await ask('team-a', `actor-${i}`)) served++;
    // Eighty a second for the atespace, twice that at once.
    expect(served).toBe(160);
    // Another atespace has its own.
    expect(await ask('team-b', 'x')).toBe(true);
  });

  it('an actor over its own rate does not use up what its neighbours in the atespace may have', async () => {
    const { createSubstrateProviderCore } = await import('../../../packages/proxy/src/substrate/credential-provider.js');
    const { MemoryStore } = await import('aquaman-core');
    const store = new MemoryStore();
    await store.set('github', 'token', 'v');
    let t = 0;
    const core = createSubstrateProviderCore({
      store, providerName: 'aquaman', actorTrustDomain: 'substrate-actor.local', now: () => t,
      grants: () => ({ grants: new Map([['team-a', new Set(['aquaman://github/token'])]]) }),
    });
    const ask = (actor: string) => core.fetchSecret({
      uri: 'ate-secret://aquaman/github/token', actor_spiffe_id: `spiffe://substrate-actor.local/actor/team-a/${actor}`,
    }).then(() => true, () => false);
    let neighbour = 0;
    for (let second = 0; second < 10; second++) {
      t = second * 1000;
      for (let i = 0; i < 500; i++) await ask('noisy');
      if (await ask('billing')) neighbour++;
    }
    expect(neighbour).toBe(10);
  });

  it('remembers a bounded number of actors', async () => {
    const { createFetchRateLimit } = await import('../../../packages/proxy/src/substrate/credential-provider.js');
    const ok = createFetchRateLimit(1, () => 0, 2);
    expect(ok('a')).toBe(true); expect(ok('a')).toBe(true); expect(ok('a')).toBe(false);
    ok('b'); ok('c');
    // "a" was dropped to make room and starts with a full bucket.
    expect(ok('a')).toBe(true);
  });
});

describe('grant keys as they are written', () => {
  it.each(['0x10', '1e3', '1.0', '007', 'true', 'null', 'yes'])('the atespace %s gets the grant, not another name', (name) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqgk-'));
    try {
      const file = path.join(dir, 'config.yaml');
      fs.writeFileSync(file, `substrate:\n  provider:\n    grants:\n      ${name}:\n        - aquaman://github/token\n`);
      const g = loadSubstrateGrants(file);
      expect([...g.grants.keys()]).toEqual([name]);
      expect(isGranted(g, { atespace: name, actor: 'x' }, 'aquaman://github/token')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
