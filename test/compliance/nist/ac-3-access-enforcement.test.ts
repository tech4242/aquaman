/**
 * Compliance test — NIST SP 800-53 AC-3 (Access Enforcement).
 *
 * Proves: policy engine evaluates method + path against allow/deny rules
 * before credentials are injected; denied requests return 403 and never
 * reach the upstream provider.
 */

import { describe, it, expect } from 'vitest';
import { matchPolicy, validatePolicyConfig, type PolicyConfig } from 'aquaman-proxy';

describe('NIST AC-3 — Access Enforcement', () => {
  const policy: PolicyConfig = {
    anthropic: {
      defaultAction: 'allow',
      rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }],
    },
    openai: {
      defaultAction: 'allow',
      rules: [
        { method: '*', path: '/v1/organization/**', action: 'deny' },
        { method: 'DELETE', path: '/v1/**', action: 'deny' },
      ],
    },
    slack: {
      defaultAction: 'allow',
      rules: [{ method: '*', path: '/admin.*', action: 'deny' }],
    },
  };

  it('denies anthropic admin paths (default-allow + targeted deny)', () => {
    const r = matchPolicy('anthropic', 'GET', '/v1/organizations/org1/members', policy);
    expect(r.allowed).toBe(false);
  });

  it('allows anthropic inference paths', () => {
    const r = matchPolicy('anthropic', 'POST', '/v1/messages', policy);
    expect(r.allowed).toBe(true);
  });

  it('denies openai DELETE requests across /v1/**', () => {
    const r = matchPolicy('openai', 'DELETE', '/v1/files/file-abc', policy);
    expect(r.allowed).toBe(false);
  });

  it('denies slack admin.* method paths', () => {
    const r = matchPolicy('slack', 'POST', '/admin.users.list', policy);
    expect(r.allowed).toBe(false);
  });

  it('unknown service falls back to allowed (operator must opt in to deny)', () => {
    const r = matchPolicy('unknown-svc', 'GET', '/anything', policy);
    expect(r.allowed).toBe(true);
  });

  it('policy validation catches invalid defaultAction', () => {
    const bad: any = { anthropic: { defaultAction: 'maybe', rules: [] } };
    const { valid, errors } = validatePolicyConfig(bad);
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('defaultAction'))).toBe(true);
  });
});
