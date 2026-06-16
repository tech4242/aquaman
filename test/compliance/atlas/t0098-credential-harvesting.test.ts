/**
 * Compliance test — MITRE ATLAS AML.T0098 (AI Agent Tool Credential Harvesting).
 *
 * Added in the ATLAS 2026 update (v5.4.0). Covers an AI agent that uses its
 * tools (file reads, shell commands) to harvest credentials and surface them —
 * to the transcript, to a sanctioned tool call, or to an attacker.
 *
 * Aquaman's defense is layered:
 *   1. Credentials never enter the agent process (proxy isolation) — covered by
 *      T0090. There is nothing in env/argv to harvest.
 *   2. Per-tool-call broker materialization with a TTL, not a long-lived export.
 *   3. Post-tool-output redactor scrubs secret-shaped strings (and the verbatim
 *      injected values) before they can reach a transcript — proved here.
 *
 * This test proves layer 3: whatever a credential-harvesting tool surfaces,
 * the redactor removes it from the output stream.
 */

import { describe, it, expect } from 'vitest';
import { redact, containsSecret, buildValuePatterns, BUILTIN_PATTERNS } from 'aquaman-core';

describe('ATLAS AML.T0098 — AI Agent Tool Credential Harvesting', () => {
  it('redacts a harvested Anthropic key from tool output', () => {
    const harvested = 'cat .env => ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789AbCdEf0123456789';
    const { output, findings } = redact(harvested);
    expect(output).not.toContain('sk-ant-api03-AbCdEf0123456789AbCdEf0123456789');
    expect(findings.length).toBeGreaterThan(0);
  });

  it('redacts harvested AWS / GitHub / private-key material', () => {
    const harvested = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_0123456789abcdefABCDEF0123456789abcd',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const { output } = redact(harvested);
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output).not.toContain('ghp_0123456789abcdefABCDEF0123456789abcd');
    expect(output).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('scrubs the verbatim injected value regardless of its shape', () => {
    // The broker may materialize a value that matches no builtin pattern
    // (internal API token, DB URL, etc.). buildValuePatterns guarantees the
    // exact injected string is scrubbed from harvested output.
    const injected = 'internal-tok_9f3aQZ-not-a-known-pattern';
    const patterns = [...buildValuePatterns([injected]), ...BUILTIN_PATTERNS];
    const harvested = `export SECRET=${injected}; echo leaked`;
    const { output } = redact(harvested, patterns);
    expect(output).not.toContain(injected);
  });

  it('containsSecret flags harvested credentials for the PostToolUse warning', () => {
    expect(containsSecret('token=sk-ant-api03-AbCdEf0123456789AbCdEf0123456789')).toBe(true);
    expect(containsSecret('the build finished successfully in 2.3s')).toBe(false);
  });
});
