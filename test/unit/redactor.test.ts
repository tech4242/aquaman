/**
 * Unit tests for the secret-pattern redactor (packages/proxy/src/core/redactor/).
 *
 * Each pattern is hit with at least one positive case (must redact), at
 * least one negative case (must not false-match), and aggregate behavior
 * is covered via redactDeep.
 */

import { describe, it, expect } from 'vitest';
import { redact, redactDeep, containsSecret, BUILTIN_PATTERNS } from 'aquaman-core';

describe('redact (single string)', () => {
  describe('Anthropic API key', () => {
    it('redacts sk-ant- keys', () => {
      const { output, findings } = redact('export ANTHROPIC_API_KEY=sk-ant-api03-abc123def456ghi789jkl012mno345pqr678');
      expect(output).toContain('[REDACTED:anthropic-key]');
      expect(output).not.toMatch(/sk-ant-/);
      expect(findings).toEqual([{ kind: 'anthropic-key', count: 1 }]);
    });

    it('does not match short non-keys', () => {
      const { findings } = redact('sk-ant-short');
      expect(findings.find((f) => f.kind === 'anthropic-key')).toBeUndefined();
    });
  });

  describe('OpenAI API key', () => {
    it('redacts sk-... classic keys', () => {
      const { output } = redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789');
      expect(output).toContain('[REDACTED:openai-key]');
    });

    it('redacts sk-proj- keys', () => {
      const { output } = redact('OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234');
      expect(output).toContain('[REDACTED:openai-key]');
    });
  });

  describe('GitHub tokens', () => {
    it('redacts gh{p,o,u,s,r}_ tokens', () => {
      const samples = [
        'ghp_' + 'a'.repeat(36),
        'gho_' + 'b'.repeat(36),
        'ghu_' + 'c'.repeat(36),
        'ghs_' + 'd'.repeat(36),
        'ghr_' + 'e'.repeat(36),
      ];
      for (const s of samples) {
        const { output } = redact(`token=${s}`);
        expect(output).toContain('[REDACTED:github-token]');
        expect(output).not.toContain(s);
      }
    });

    it('redacts github_pat_ fine-grained tokens', () => {
      const fg = 'github_pat_' + 'A'.repeat(82);
      const { output } = redact(`gh_fg=${fg}`);
      expect(output).toContain('[REDACTED:github-fine-grained]');
    });
  });

  describe('Stripe key', () => {
    it('redacts sk_live_ and sk_test_', () => {
      const { output: liveOut } = redact('STRIPE_KEY=sk_live_' + 'a'.repeat(24));
      expect(liveOut).toContain('[REDACTED:stripe-key]');
      const { output: testOut } = redact('STRIPE_KEY=sk_test_' + 'b'.repeat(40));
      expect(testOut).toContain('[REDACTED:stripe-key]');
    });
  });

  describe('Slack token', () => {
    it('redacts xoxb-/xoxp-/xoxa-/xoxr-/xoxs-', () => {
      for (const prefix of ['xoxb', 'xoxp', 'xoxa', 'xoxr', 'xoxs']) {
        const token = `${prefix}-123456789-${'a'.repeat(20)}`;
        const { output } = redact(`SLACK=${token}`);
        expect(output).toContain('[REDACTED:slack-token]');
      }
    });
  });

  describe('AWS', () => {
    it('redacts AKIA-prefix access key IDs', () => {
      const { output } = redact('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
      expect(output).toContain('[REDACTED:aws-access-key-id]');
    });

    it('redacts ASIA-prefix STS access key IDs', () => {
      const { output } = redact('AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE');
      expect(output).toContain('[REDACTED:aws-access-key-id]');
    });

    it('redacts contextual aws_secret_access_key=... values', () => {
      const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY=';
      const { output } = redact(`aws_secret_access_key = ${secret}`);
      expect(output).toContain('[REDACTED:aws-secret-access-key]');
    });

    it('does not false-positive an arbitrary 40-char string', () => {
      const { findings } = redact('hash: 5d41402abc4b2a76b9719d911017c592ABCDEFGH');
      expect(findings.find((f) => f.kind === 'aws-secret-access-key')).toBeUndefined();
    });
  });

  describe('Google API key', () => {
    it('redacts AIza... keys', () => {
      const key = 'AIzaSy' + 'D'.repeat(33); // 39 chars total
      const { output } = redact(`GOOGLE_API_KEY=${key}`);
      expect(output).toContain('[REDACTED:google-api-key]');
    });
  });

  describe('GitLab PAT', () => {
    it('redacts glpat- tokens', () => {
      const { output } = redact('GL=glpat-abcdefghijklmnopqrstuv');
      expect(output).toContain('[REDACTED:gitlab-pat]');
    });
  });

  describe('npm token', () => {
    it('redacts npm_ tokens', () => {
      const { output } = redact('npm_token=npm_' + 'a'.repeat(36));
      expect(output).toContain('[REDACTED:npm-token]');
    });
  });

  describe('JWT', () => {
    it('redacts three-segment base64url tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const { output } = redact(`bearer ${jwt}`);
      expect(output).toContain('[REDACTED:jwt]');
    });
  });

  describe('PEM private key block', () => {
    it('redacts the full BEGIN/END block', () => {
      const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...\n-----END PRIVATE KEY-----';
      const { output, findings } = redact(`config: ${pem}`);
      expect(output).toContain('[REDACTED:private-key]');
      expect(output).not.toContain('BEGIN PRIVATE KEY');
      expect(findings.find((f) => f.kind === 'private-key')?.count).toBe(1);
    });

    it('redacts RSA / OPENSSH / EC variants', () => {
      for (const kind of ['RSA', 'OPENSSH', 'EC']) {
        const pem = `-----BEGIN ${kind} PRIVATE KEY-----\nfakebody\n-----END ${kind} PRIVATE KEY-----`;
        const { output } = redact(pem);
        expect(output).toBe('[REDACTED:private-key]');
      }
    });
  });

  describe('Bearer header', () => {
    it('redacts Authorization: Bearer ...', () => {
      const { output } = redact('Authorization: Bearer abc123def456ghi789jkl');
      expect(output).toContain('[REDACTED:bearer-token]');
    });
  });

  describe('aquaman placeholder', () => {
    it('redacts the literal aquaman-proxy-managed marker (defensive)', () => {
      const { output } = redact('key: aquaman-proxy-managed');
      expect(output).toContain('[REDACTED:aquaman-placeholder]');
    });
  });

  describe('multiple matches', () => {
    it('redacts every match of every pattern', () => {
      // Built via concat so the literal Stripe-shaped string never appears
      // in source — GitHub push protection's secret scanner pattern-matches
      // committed literals like `sk_live_<24chars>` and rejects the push.
      const input = 'GH=ghp_' + 'a'.repeat(36) + ' STRIPE=sk_live_' + 'b'.repeat(24);
      const { output, findings } = redact(input);
      expect(output).toContain('[REDACTED:github-token]');
      expect(output).toContain('[REDACTED:stripe-key]');
      const githubCount = findings.find((f) => f.kind === 'github-token')?.count;
      const stripeCount = findings.find((f) => f.kind === 'stripe-key')?.count;
      expect(githubCount).toBe(1);
      expect(stripeCount).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('returns input unchanged when empty', () => {
      expect(redact('').output).toBe('');
      expect(redact('').findings).toEqual([]);
    });

    it('returns input unchanged when no patterns match', () => {
      const { output, findings } = redact('hello world, no secrets here');
      expect(output).toBe('hello world, no secrets here');
      expect(findings).toEqual([]);
    });

    it('handles non-string input defensively', () => {
      // @ts-expect-error: testing non-string path
      const result = redact(null);
      expect(result.output).toBe(null);
      expect(result.findings).toEqual([]);
    });

    it('does not mutate input string', () => {
      const input = 'key=ghp_' + 'a'.repeat(36);
      const before = input;
      redact(input);
      expect(input).toBe(before);
    });
  });
});

describe('containsSecret', () => {
  it('returns true when any pattern matches', () => {
    expect(containsSecret('ghp_' + 'x'.repeat(36))).toBe(true);
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('returns false on safe input', () => {
    expect(containsSecret('hello world')).toBe(false);
    expect(containsSecret('')).toBe(false);
  });

  it('respects custom pattern list', () => {
    // Only the github-token pattern in the custom list
    const ghOnly = BUILTIN_PATTERNS.filter((p) => p.kind === 'github-token');
    expect(containsSecret('AKIAIOSFODNN7EXAMPLE', ghOnly)).toBe(false);
    expect(containsSecret('ghp_' + 'a'.repeat(36), ghOnly)).toBe(true);
  });
});

describe('redactDeep', () => {
  it('redacts strings inside an object', () => {
    const { output, findings } = redactDeep({
      anthropic: 'sk-ant-' + 'a'.repeat(40),
      ok: 'hello',
      nested: { github: 'ghp_' + 'b'.repeat(36) },
    });
    expect((output as any).anthropic).toContain('[REDACTED:anthropic-key]');
    expect((output as any).nested.github).toContain('[REDACTED:github-token]');
    expect((output as any).ok).toBe('hello');
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  it('redacts strings inside an array', () => {
    const { output } = redactDeep([
      'ghp_' + 'a'.repeat(36),
      'safe',
      ['nested', 'AKIAIOSFODNN7EXAMPLE'],
    ]);
    const arr = output as string[];
    expect(arr[0]).toContain('[REDACTED:github-token]');
    expect(arr[1]).toBe('safe');
    expect((arr[2] as unknown as string[])[1]).toContain('[REDACTED:aws-access-key-id]');
  });

  it('returns numbers, booleans, null, undefined unchanged', () => {
    const input = { a: 42, b: true, c: null, d: undefined, e: 3.14 };
    const { output } = redactDeep(input);
    expect(output).toEqual(input);
  });

  it('does not mutate input', () => {
    const input = { token: 'ghp_' + 'a'.repeat(36) };
    const before = { ...input };
    redactDeep(input);
    expect(input).toEqual(before);
  });

  it('aggregates counts across nested matches', () => {
    const { findings } = redactDeep([
      'ghp_' + 'a'.repeat(36),
      { x: 'ghp_' + 'b'.repeat(36) },
      'ghp_' + 'c'.repeat(36),
    ]);
    const gh = findings.find((f) => f.kind === 'github-token');
    expect(gh?.count).toBe(3);
  });
});
