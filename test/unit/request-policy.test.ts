/**
 * Unit tests for request-level policy enforcement.
 */

import { describe, it, expect } from 'vitest';
import {
  matchPathPattern,
  matchPolicy,
  validatePolicyConfig,
  loadPolicyFromConfig,
  getDefaultPolicyPresets,
  type PolicyConfig,
  type ServicePolicy
} from 'aquaman-proxy';

describe('matchPathPattern', () => {
  it('matches exact path', () => {
    expect(matchPathPattern('/v1/messages', '/v1/messages')).toBe(true);
  });

  it('rejects different path', () => {
    expect(matchPathPattern('/v1/messages', '/v1/completions')).toBe(false);
  });

  it('matches single-segment wildcard *', () => {
    expect(matchPathPattern('/v1/users/*/drafts', '/v1/users/me/drafts')).toBe(true);
    expect(matchPathPattern('/v1/users/*/drafts', '/v1/users/alice@example.com/drafts')).toBe(true);
  });

  it('single * does not match across segments', () => {
    expect(matchPathPattern('/v1/users/*/drafts', '/v1/users/a/b/drafts')).toBe(false);
  });

  it('matches multi-segment wildcard **', () => {
    expect(matchPathPattern('/v1/organizations/**', '/v1/organizations/foo/bar')).toBe(true);
    expect(matchPathPattern('/v1/organizations/**', '/v1/organizations/foo')).toBe(true);
    expect(matchPathPattern('/v1/organizations/**', '/v1/organizations')).toBe(true);
  });

  it('** matches zero segments', () => {
    expect(matchPathPattern('/v1/**', '/v1')).toBe(true);
  });

  it('substring wildcard within segment (admin.*)', () => {
    expect(matchPathPattern('/admin.*', '/admin.users.list')).toBe(true);
    expect(matchPathPattern('/admin.*', '/admin.conversations.create')).toBe(true);
  });

  it('exact segment does NOT match partial', () => {
    expect(matchPathPattern('/admin', '/admin.users')).toBe(false);
  });

  it('handles trailing slashes', () => {
    expect(matchPathPattern('/v1/messages/', '/v1/messages')).toBe(true);
    expect(matchPathPattern('/v1/messages', '/v1/messages/')).toBe(true);
  });

  it('matches root path', () => {
    expect(matchPathPattern('/', '/')).toBe(true);
  });

  it('** at end matches deep paths', () => {
    expect(matchPathPattern('/v1/**', '/v1/foo/bar/baz/qux')).toBe(true);
  });
});

describe('matchPolicy', () => {
  it('allows when no policy for service', () => {
    const config: PolicyConfig = {};
    const result = matchPolicy('anthropic', 'POST', '/v1/messages', config);
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBeUndefined();
  });

  it('allows when defaultAction is allow and no matching rule', () => {
    const config: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
      }
    };
    const result = matchPolicy('anthropic', 'POST', '/v1/messages', config);
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBeUndefined();
  });

  it('denies when defaultAction is deny and no matching rule', () => {
    const config: PolicyConfig = {
      gmail: {
        defaultAction: 'deny',
        rules: [{ method: 'POST', path: '/v1/users/*/drafts', action: 'allow' }]
      }
    };
    const result = matchPolicy('gmail', 'GET', '/v1/users/me/labels', config);
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBeUndefined();
  });

  it('matches exact method and path', () => {
    const config: PolicyConfig = {
      gmail: {
        defaultAction: 'allow',
        rules: [{ method: 'POST', path: '/v1/users/*/messages/send', action: 'deny' }]
      }
    };
    const result = matchPolicy('gmail', 'POST', '/v1/users/me/messages/send', config);
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toEqual({ method: 'POST', path: '/v1/users/*/messages/send', action: 'deny' });
  });

  it('wildcard method * matches any method', () => {
    const config: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
      }
    };
    expect(matchPolicy('anthropic', 'GET', '/v1/organizations/org123/members', config).allowed).toBe(false);
    expect(matchPolicy('anthropic', 'POST', '/v1/organizations/org123/api-keys', config).allowed).toBe(false);
    expect(matchPolicy('anthropic', 'DELETE', '/v1/organizations/org123', config).allowed).toBe(false);
  });

  it('case-insensitive method matching', () => {
    const config: PolicyConfig = {
      openai: {
        defaultAction: 'allow',
        rules: [{ method: 'DELETE', path: '/v1/**', action: 'deny' }]
      }
    };
    expect(matchPolicy('openai', 'delete', '/v1/files/file-abc', config).allowed).toBe(false);
    expect(matchPolicy('openai', 'Delete', '/v1/files/file-abc', config).allowed).toBe(false);
  });

  it('first-match-wins ordering', () => {
    const config: PolicyConfig = {
      test: {
        defaultAction: 'deny',
        rules: [
          { method: 'POST', path: '/v1/safe', action: 'allow' },
          { method: '*', path: '/v1/**', action: 'deny' },
        ]
      }
    };
    // POST /v1/safe hits the first rule (allow)
    expect(matchPolicy('test', 'POST', '/v1/safe', config).allowed).toBe(true);
    // GET /v1/safe hits the second rule (deny) since method doesn't match first
    expect(matchPolicy('test', 'GET', '/v1/safe', config).allowed).toBe(false);
  });

  it('substring wildcard in segment (Slack admin.*)', () => {
    const config: PolicyConfig = {
      slack: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/admin.*', action: 'deny' }]
      }
    };
    expect(matchPolicy('slack', 'POST', '/admin.users.list', config).allowed).toBe(false);
    expect(matchPolicy('slack', 'POST', '/chat.postMessage', config).allowed).toBe(true);
  });
});

describe('validatePolicyConfig', () => {
  it('valid config passes', () => {
    const config: PolicyConfig = {
      anthropic: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
      }
    };
    const result = validatePolicyConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('invalid action is reported', () => {
    const config = {
      gmail: {
        defaultAction: 'allow' as const,
        rules: [{ method: 'POST', path: '/v1/send', action: 'block' as any }]
      }
    };
    const result = validatePolicyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('unknown action "block"');
  });

  it('invalid defaultAction is reported', () => {
    const config = {
      test: {
        defaultAction: 'reject' as any,
        rules: []
      }
    };
    const result = validatePolicyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid defaultAction "reject"');
  });

  it('path not starting with / is reported', () => {
    const config: PolicyConfig = {
      test: {
        defaultAction: 'allow',
        rules: [{ method: '*', path: 'v1/messages', action: 'deny' }]
      }
    };
    const result = validatePolicyConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("doesn't start with /");
  });

  it('empty config is valid', () => {
    const result = validatePolicyConfig({});
    expect(result.valid).toBe(true);
  });
});

describe('loadPolicyFromConfig', () => {
  it('returns empty config when no policy', () => {
    const result = loadPolicyFromConfig({});
    expect(result).toEqual({});
  });

  it('parses policy section correctly', () => {
    const config = {
      policy: {
        anthropic: {
          defaultAction: 'allow',
          rules: [{ method: '*', path: '/v1/organizations/**', action: 'deny' }]
        }
      }
    };
    const result = loadPolicyFromConfig(config);
    expect(result.anthropic).toBeDefined();
    expect(result.anthropic.defaultAction).toBe('allow');
    expect(result.anthropic.rules).toHaveLength(1);
    expect(result.anthropic.rules[0].action).toBe('deny');
  });

  it('defaults to allow for unknown defaultAction', () => {
    const config = {
      policy: {
        test: { defaultAction: 'whatever', rules: [] }
      }
    };
    const result = loadPolicyFromConfig(config);
    expect(result.test.defaultAction).toBe('allow');
  });
});

describe('getDefaultPolicyPresets', () => {
  it('returns presets for expected services', () => {
    const presets = getDefaultPolicyPresets();
    expect(presets.anthropic).toBeDefined();
    expect(presets.openai).toBeDefined();
    expect(presets.gmail).toBeDefined();
    expect(presets.slack).toBeDefined();
  });

  it('anthropic preset denies admin API', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('anthropic', 'GET', '/v1/organizations/org123/members', presets);
    expect(result.allowed).toBe(false);
  });

  it('anthropic preset allows inference', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('anthropic', 'POST', '/v1/messages', presets);
    expect(result.allowed).toBe(true);
  });

  it('openai preset denies admin API', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('openai', 'GET', '/v1/organization/users', presets);
    expect(result.allowed).toBe(false);
  });

  it('openai preset denies DELETE', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('openai', 'DELETE', '/v1/files/file-abc', presets);
    expect(result.allowed).toBe(false);
  });

  it('openai preset allows inference', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('openai', 'POST', '/v1/chat/completions', presets);
    expect(result.allowed).toBe(true);
  });

  it('slack preset denies admin methods', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('slack', 'POST', '/admin.users.list', presets);
    expect(result.allowed).toBe(false);
  });

  it('slack preset allows normal methods', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('slack', 'POST', '/chat.postMessage', presets);
    expect(result.allowed).toBe(true);
  });

  it('gmail preset denies send', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('gmail', 'POST', '/v1/users/me/messages/send', presets);
    expect(result.allowed).toBe(false);
  });

  it('gmail preset allows drafts', () => {
    const presets = getDefaultPolicyPresets();
    const result = matchPolicy('gmail', 'POST', '/v1/users/me/drafts', presets);
    expect(result.allowed).toBe(true);
  });
});
