/**
 * Secret-pattern redactor.
 *
 * Scans arbitrary strings for known credential shapes and replaces matches
 * with `[REDACTED:<kind>]` markers. Used by:
 *   - aquaman-coder PostToolUse hooks (rewrite tool output before transcript)
 *   - aquaman-coder PreShell hooks (block calls with literal secrets in args)
 *   - Audit-log self-redaction (no secret reaches current.jsonl)
 *
 * The patterns target well-defined provider token shapes. False positives
 * are possible (any sufficiently random string of the right length can match
 * a generic pattern), so consumers that need high precision should pair this
 * with structured-output redaction (e.g., known field names) rather than
 * relying on regex alone.
 *
 * This module is dependency-free and pure — every export takes input and
 * returns the redacted output. No global state, no I/O.
 */

export interface SecretPattern {
  /** Stable identifier for the kind of secret. Used in the redaction marker. */
  kind: string;
  /** One-line human description of what this pattern detects. */
  description: string;
  /** Pattern. Match is replaced with `[REDACTED:<kind>]`. */
  regex: RegExp;
}

/**
 * Built-in patterns. Ordered roughly by specificity (more-specific first)
 * so a match doesn't get swallowed by a looser later pattern.
 *
 * **Order matters.** `anthropic-key` MUST appear before `openai-key`
 * because the OpenAI regex `sk-(?:proj-)?...` also matches `sk-ant-...`.
 * `redact()` walks patterns top-to-bottom and the first match wins;
 * `containsSecret` with a custom pattern list bypasses this safeguard,
 * so callers passing a subset should preserve the specific-first order.
 *
 * Each regex uses the global flag so `String.replace` redacts all
 * occurrences in one pass.
 */
export const BUILTIN_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'private-key',
    description: 'PEM-encoded private key block',
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/g,
  },
  {
    kind: 'anthropic-key',
    description: 'Anthropic API key (sk-ant-...)',
    regex: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/g,
  },
  {
    kind: 'openai-key',
    description: 'OpenAI API key (sk-... including project keys)',
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: 'github-token',
    description: 'GitHub fine-grained / classic / OAuth / refresh token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    kind: 'github-fine-grained',
    description: 'GitHub fine-grained PAT (github_pat_)',
    regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
  },
  {
    kind: 'stripe-key',
    description: 'Stripe secret/live/test key',
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,99}\b/g,
  },
  {
    kind: 'slack-token',
    description: 'Slack token (xoxb / xoxp / xoxa / xoxr / xoxs)',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: 'aws-access-key-id',
    description: 'AWS Access Key ID (AKIA / ASIA prefix)',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: 'aws-secret-access-key',
    description: 'AWS Secret Access Key (40-char base64-ish following aws_secret_access_key)',
    // Bind to a contextual prefix so we don't redact arbitrary 40-char strings.
    regex: /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)["\s]*[:=]["\s]*([A-Za-z0-9/+=]{40})\b/g,
  },
  {
    kind: 'google-api-key',
    description: 'Google API key (AIza...)',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    kind: 'gitlab-pat',
    description: 'GitLab personal access token (glpat-)',
    regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    kind: 'npm-token',
    description: 'npm automation/granular token (npm_)',
    regex: /\bnpm_[A-Za-z0-9]{36,}\b/g,
  },
  {
    kind: 'jwt',
    description: 'JSON Web Token (three dot-separated base64url segments)',
    // Conservative: require all three segments to look base64url and be of typical lengths.
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: 'bearer-token',
    description: 'Authorization header Bearer token',
    regex: /\b(?:Authorization|authorization)\s*:\s*Bearer\s+[A-Za-z0-9._\-+/=]{16,}/g,
  },
  {
    kind: 'aquaman-placeholder',
    description: 'aquaman placeholder marker (auth-profiles.json) — defensive',
    regex: /\baquaman-proxy-managed\b/g,
  },
];

/**
 * Redact every match of every pattern in `patterns` from `input`.
 *
 * Returns the redacted string and a summary of what was replaced.
 *
 * @param input The string to scan.
 * @param patterns Patterns to apply. Defaults to BUILTIN_PATTERNS.
 *
 * @example
 *   redact("token=sk-ant-abc123def456...etc")
 *   → { output: "token=[REDACTED:anthropic-key]", findings: [{kind:"anthropic-key", count:1}] }
 */
export function redact(
  input: string,
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS
): { output: string; findings: { kind: string; count: number }[] } {
  if (typeof input !== 'string' || input.length === 0) {
    return { output: input, findings: [] };
  }

  let output = input;
  const findings: { kind: string; count: number }[] = [];

  for (const pattern of patterns) {
    // Reset lastIndex defensively in case a caller passed a pre-used /g regex.
    pattern.regex.lastIndex = 0;
    let count = 0;
    output = output.replace(pattern.regex, () => {
      count++;
      return `[REDACTED:${pattern.kind}]`;
    });
    if (count > 0) {
      findings.push({ kind: pattern.kind, count });
    }
  }

  return { output, findings };
}

/**
 * Convenience: returns true iff any pattern matches the input.
 * Use when you only need to decide "block / pass" without rewriting.
 */
export function containsSecret(
  input: string,
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS
): boolean {
  if (typeof input !== 'string' || input.length === 0) return false;
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(input)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively redact secret-shaped strings in an arbitrary JSON-like value
 * (object / array / string / primitive). Useful for tool inputs/outputs that
 * arrive as parsed JSON.
 *
 * Numbers, booleans, null, undefined are returned unchanged.
 * Returns a deep copy — input is never mutated.
 */
export function redactDeep(
  value: unknown,
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS
): { output: unknown; findings: { kind: string; count: number }[] } {
  const aggregate = new Map<string, number>();

  function walk(v: unknown): unknown {
    if (typeof v === 'string') {
      const { output, findings } = redact(v, patterns);
      for (const f of findings) {
        aggregate.set(f.kind, (aggregate.get(f.kind) ?? 0) + f.count);
      }
      return output;
    }
    if (Array.isArray(v)) {
      return v.map(walk);
    }
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(vv);
      }
      return out;
    }
    return v;
  }

  const output = walk(value);
  const findings = Array.from(aggregate.entries()).map(([kind, count]) => ({ kind, count }));
  return { output, findings };
}
