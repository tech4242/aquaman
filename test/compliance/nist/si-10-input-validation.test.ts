/**
 * Compliance test — NIST SP 800-53 SI-10 (Information Input Validation).
 *
 * Proves: aquaman's secret-pattern redactor catches known credential
 * shapes across providers (AWS, GitHub, Stripe, Slack, OpenAI, Anthropic,
 * JWTs, PEM private keys) — preventing leakage into agent transcripts.
 */

import { describe, it, expect } from 'vitest';
import { redact, redactDeep, containsSecret, BUILTIN_PATTERNS } from 'aquaman-core';

describe('NIST SI-10 — Information Input Validation (redactor)', () => {
  const kinds = BUILTIN_PATTERNS.map((p) => p.kind);

  it('the redactor ships canonical credential shapes for major providers', () => {
    const expected = [
      'anthropic-key',
      'openai-key',
      'github-token',
      'github-fine-grained',
      'stripe-key',
      'slack-token',
      'aws-access-key-id',
      'aws-secret-access-key',
      'google-api-key',
      'gitlab-pat',
      'npm-token',
      'jwt',
      'bearer-token',
      'private-key',
    ];
    for (const k of expected) {
      expect(kinds).toContain(k);
    }
  });

  it('redact() scrubs every recognized shape from a mixed input', () => {
    const input = [
      'sk-ant-' + 'a'.repeat(40),
      'ghp_' + 'b'.repeat(36),
      'AKIAIOSFODNN7EXAMPLE',
      'sk_live_' + 'c'.repeat(24),
      '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
    ].join(' ');
    const { output, findings } = redact(input);
    expect(output).not.toMatch(/sk-ant-/);
    expect(output).not.toMatch(/ghp_/);
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output).not.toMatch(/sk_live_/);
    expect(output).not.toContain('BEGIN PRIVATE KEY');
    expect(findings.length).toBeGreaterThanOrEqual(5);
  });

  it('containsSecret() flags secret-bearing input without exposing the secret', () => {
    expect(containsSecret('ghp_' + 'x'.repeat(36))).toBe(true);
    expect(containsSecret('benign input')).toBe(false);
  });

  it('redactDeep() walks nested objects (tool-call params + responses)', () => {
    const { output } = redactDeep({
      log: 'Authorization: Bearer abc123def456ghi789jkl',
      env: { AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE' },
      messages: [{ role: 'user', content: 'my key is sk-ant-' + 'q'.repeat(40) }],
    });
    expect((output as any).log).toContain('[REDACTED:bearer-token]');
    expect((output as any).env.AWS_ACCESS_KEY_ID).toContain('[REDACTED:aws-access-key-id]');
    expect((output as any).messages[0].content).toContain('[REDACTED:anthropic-key]');
  });

  it('redact() returns benign input unchanged (no false positives)', () => {
    const benign = 'Hello world. The capital of France is Paris.';
    const { output, findings } = redact(benign);
    expect(output).toBe(benign);
    expect(findings).toEqual([]);
  });
});
