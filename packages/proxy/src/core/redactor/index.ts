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
    kind: 'gitlab-runner-token',
    description: 'GitLab runner authentication token (glrt-)',
    regex: /\bglrt-[A-Za-z0-9_.-]{20,}\b/g,
  },
  {
    kind: 'gitlab-oauth-secret',
    description: 'GitLab OAuth application secret (gloas-)',
    regex: /\bgloas-[A-Za-z0-9_-]{20,}\b/g,
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
    kind: 'atlassian-token',
    description: 'Atlassian API token (ATATT3xF prefix)',
    // Real tokens are ~190 chars total; require at least 100 trailing chars to
    // avoid matching the bare 8-char sentinel and benign occurrences of the prefix.
    regex: /\bATATT3xF[A-Za-z0-9_=\-+/]{100,}\b/g,
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
 * Build SecretPatterns that match the given exact string values literally
 * (any regex metacharacters in the values are escaped). Designed for the
 * "I just resolved these values from the vault and I'm about to spawn a
 * subprocess with them in its env — strip them out of stdout/stderr no
 * matter what shape they happen to have" use case.
 *
 * Returns patterns tagged `injected-value`. Prepend them to BUILTIN_PATTERNS
 * so the value-based match wins over any generic shape match (the kind tag
 * in the audit trail then correctly says "this is one of our injected
 * values" rather than misattributing it to a provider shape).
 *
 * Empty or whitespace-only values are skipped — otherwise the regex would
 * match between every character and redact the entire input.
 */
export function buildValuePatterns(values: readonly string[]): SecretPattern[] {
  const patterns: SecretPattern[] = [];
  for (const value of values) {
    if (!value || value.trim().length === 0) continue;
    patterns.push({
      kind: 'injected-value',
      description: 'aquaman-injected env value (resolved from vault at runtime)',
      regex: new RegExp(escapeForRegex(value), 'g'),
    });
  }
  return patterns;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

/** How much trailing text a stream redactor keeps back while waiting for a line to finish. */
const STREAM_LINE_HOLDBACK = 4096;

/**
 * How far back a stream redactor holds a private key block whose END line has
 * not arrived. Larger than any PEM key; a BEGIN line that is never closed is
 * let go after this much, so it cannot hold a stream back for good.
 */
const STREAM_KEY_BLOCK_HOLDBACK = 64 * 1024;

/**
 * The longest match a stream redactor keeps whole across pushes. A match that
 * is still growing at the end of the text is held until it ends; one that has
 * grown past this is no credential, and is written as a marker for the part
 * seen so far instead of being held without bound.
 */
const STREAM_MATCH_HOLDBACK = 1024 * 1024;

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;

export interface StreamRedactor {
  /** Feed the next chunk; returns the text that is now safe to write. */
  push(chunk: string): string;
  /** The stream ended; returns whatever was still held back, redacted. */
  end(): string;
}

/**
 * `redact()`, with each character of the result tied to the place in the
 * input it stands for: `from[i]` and `to[i]` are the input offsets where the
 * source of output character `i` begins and ends. A character that was not
 * redacted covers itself; every character of a marker covers the whole match
 * the marker replaced. The patterns are applied one after another to the
 * running result, exactly as `redact()` applies them.
 */
function redactTracked(
  input: string,
  patterns: readonly SecretPattern[],
): { output: string; from: number[]; to: number[] } {
  let output = input;
  let from = Array.from({ length: input.length }, (_, i) => i);
  let to = Array.from({ length: input.length }, (_, i) => i + 1);
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    let text = '';
    let nextFrom: number[] | undefined;
    let nextTo: number[] | undefined;
    let done = 0;
    for (const match of output.matchAll(pattern.regex)) {
      if (match[0].length === 0) continue;
      nextFrom ??= [];
      nextTo ??= [];
      const start = match.index;
      const end = start + match[0].length;
      text += output.slice(done, start);
      for (let i = done; i < start; i++) { nextFrom.push(from[i]); nextTo.push(to[i]); }
      const marker = `[REDACTED:${pattern.kind}]`;
      text += marker;
      for (let i = 0; i < marker.length; i++) { nextFrom.push(from[start]); nextTo.push(to[end - 1]); }
      done = end;
    }
    pattern.regex.lastIndex = 0;
    if (nextFrom && nextTo) {
      text += output.slice(done);
      for (let i = done; i < output.length; i++) { nextFrom.push(from[i]); nextTo.push(to[i]); }
      output = text;
      from = nextFrom;
      to = nextTo;
    }
  }
  return { output, from, to };
}

/**
 * Redact a stream that arrives in chunks.
 *
 * A secret can straddle two chunks (a pipe delivers whatever the writer
 * flushed, and a 64 KB buffer boundary can fall anywhere), and redacting each
 * chunk on its own would let both halves through. This keeps back the end of
 * what it has seen until more arrives: the part that could be the beginning of
 * a literal value, so a value split anywhere is whole again before it is
 * written, the unfinished last line (up to STREAM_LINE_HOLDBACK), so
 * shape-based patterns see whole lines, and a private key block that has
 * begun and not ended.
 *
 * What is kept back is kept as it arrived, not redacted. The beginning of a
 * literal value can have the shape of a builtin pattern on its own (the first
 * half of an API key is still key-shaped); redacting it early would replace
 * it with a marker, the text would no longer end like the beginning of the
 * value, and the rest of the value would be written when it arrived. So each
 * push redacts everything held plus the new chunk with the whole of it in
 * view, writes the redacted form of the part before the cut, and keeps the
 * part after the cut untouched for the next push.
 *
 * The cut is never inside a match: one that begins before it and reaches past
 * it (a token still growing at the end of a long line) moves the cut back to
 * where the match begins, so the match stays whole in the held part, up to
 * STREAM_MATCH_HOLDBACK.
 *
 * With the literal `values` given, the part kept back for them is exactly the
 * end of the text that is also the beginning of one of them, which for a
 * finished line is normally nothing. A program that answers one line at a
 * time and then waits (a stdio MCP server, a REPL) therefore has each reply
 * written when it is produced. Without `values` the length alone is known, and
 * one character less than `longestValue` is kept back whatever the text is.
 */
export function createStreamRedactor(
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS,
  longestValue = 0,
  values?: readonly string[],
): StreamRedactor {
  let pending = '';
  const literals = values?.filter((v) => v && v.trim().length > 0);
  return {
    push(chunk: string): string {
      const raw = pending + chunk;
      const unfinishedLine = raw.length - (raw.lastIndexOf('\n') + 1);
      const forValues = literals ? valuePrefixAtEnd(raw, literals) : Math.max(0, longestValue - 1);
      const hold = Math.min(
        raw.length,
        Math.max(forValues, Math.min(unfinishedLine, STREAM_LINE_HOLDBACK)),
      );
      let cut = raw.length - hold;
      const { output, from, to } = redactTracked(raw, patterns);

      // A key block that has begun and whose END line is still to come: a
      // BEGIN line that survived redaction is one that no END followed.
      PRIVATE_KEY_BEGIN.lastIndex = 0;
      let open = -1;
      for (const match of output.matchAll(PRIVATE_KEY_BEGIN)) open = from[match.index];
      PRIVATE_KEY_BEGIN.lastIndex = 0;
      if (open >= 0 && open < cut && raw.length - open <= STREAM_KEY_BLOCK_HOLDBACK) cut = open;

      // Never inside a match. Markers are in input order, so one pass from
      // the end settles it: moving the cut back can only meet earlier ones.
      for (let i = output.length - 1; i >= 0; i--) {
        if (from[i] < cut && cut < to[i] && raw.length - from[i] <= STREAM_MATCH_HOLDBACK) cut = from[i];
      }

      // The redacted form of everything before the cut. A match too long to
      // hold is still cut through: its marker is written, never its text.
      let written = 0;
      while (written < output.length && from[written] < cut) written++;
      pending = raw.slice(cut);
      return output.slice(0, written);
    },
    end(): string {
      const out = redact(pending, patterns).output;
      pending = '';
      return out;
    },
  };
}

/** Length of the longest end of `text` that is the beginning, and not the whole, of one of `values`. */
function valuePrefixAtEnd(text: string, values: readonly string[]): number {
  let longest = 0;
  for (const value of values) {
    for (let k = Math.min(value.length - 1, text.length); k > longest; k--) {
      if (text.endsWith(value.slice(0, k))) { longest = k; break; }
    }
  }
  return longest;
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
