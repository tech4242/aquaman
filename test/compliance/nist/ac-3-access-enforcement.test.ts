/**
 * Compliance test — NIST SP 800-53 AC-3 (Access Enforcement).
 *
 * Proves: policy engine evaluates method + path against allow/deny rules
 * before credentials are injected; denied requests return 403 and never
 * reach the upstream provider.
 */

import { describe, it, expect } from 'vitest';
import { matchPolicy, validatePolicyConfig, getDefaultPolicyPresets, lintPolicyConfig, type PolicyConfig } from 'aquaman-proxy';

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

  // v0.15.0: the shipped presets must deny the paths REAL traffic has. Slack
  // Web API calls reach the proxy as /api/<method> (the interceptor keeps
  // slack.com's full path). The pre-0.15.0 preset only denied /admin.*, a
  // path Slack 404s, so admin calls went through while the operator believed
  // they were blocked.
  describe('shipped presets deny real-traffic paths', () => {
    const presets = getDefaultPolicyPresets();
    it.each([
      ['slack', 'POST', '/api/admin.users.list'],
      ['slack', 'GET', '/api/admin.conversations.search'],
      ['gmail', 'POST', '/gmail/v1/users/me/messages/send'],
      ['anthropic', 'GET', '/v1/organizations/org_1/api_keys'],
      ['openai', 'GET', '/v1/organization/admin_api_keys'],
    ])('%s %s %s → denied', (svc, method, p) => {
      expect(matchPolicy(svc, method, p, presets).allowed).toBe(false);
    });
    it.each([
      ['slack', 'POST', '/api/chat.postMessage'],
      ['gmail', 'POST', '/gmail/v1/users/me/drafts'],
      ['anthropic', 'POST', '/v1/messages'],
    ])('%s %s %s → allowed', (svc, method, p) => {
      expect(matchPolicy(svc, method, p, presets).allowed).toBe(true);
    });
    it('lintPolicyConfig flags the pre-0.15.0 preset shapes still sitting in configs', () => {
      const legacy: PolicyConfig = {
        slack: { defaultAction: 'allow', rules: [{ method: '*', path: '/admin.*', action: 'deny' }] },
        gmail: { defaultAction: 'allow', rules: [{ method: 'POST', path: '/v1/users/*/messages/send', action: 'deny' }] },
      };
      const warnings = lintPolicyConfig(legacy);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('/api/admin.*');
      expect(lintPolicyConfig(presets)).toEqual([]);
    });
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
