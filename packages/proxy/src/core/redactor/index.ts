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
 * The most a stream redactor keeps back for one unfinished run of token
 * characters, one match or one pattern that has begun. Anything longer is no
 * credential. Past it the run is cut through where the line holdback falls:
 * a match is then written as a marker for the part seen so far, never as its
 * text, and text that had not matched yet is written as it is.
 */
const STREAM_MATCH_HOLDBACK = 1024 * 1024;

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;
const PRIVATE_KEY_END = /-----END (?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * The characters the builtin token shapes are made of. A run of them is one
 * candidate token: no builtin pattern for a single token matches across a
 * character outside this set, and `\b` reads every such character alike.
 */
const TOKEN_CHAR = /[A-Za-z0-9_\-.+/=]/;
const isTokenChar = (ch: string | undefined): boolean => ch !== undefined && TOKEN_CHAR.test(ch);

/**
 * The beginning of each builtin pattern that is made of several parts with
 * white space or punctuation between them, matched at the end of a text: the
 * name of a header or a variable whose value is still to come, possibly on
 * the next line, and a BEGIN line of a key block that is not complete.
 */
const PATTERN_LEADS: readonly RegExp[] = [
  /\b(?:Authorization|authorization)\s*(?::\s*(?:Bearer\s*)?)?$/,
  /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)["\s]*(?:[:=]["\s]*)?$/,
  /-----BEGIN (?:(?:RSA|OPENSSH|EC|DSA|PGP|ENCRYPTED) )?(?:PRIVATE (?:KEY )?)?$/,
];
/** How much text before a cut is looked at for a lead. Longer runs of white space inside one are not followed. */
const PATTERN_LEAD_WINDOW = 256;

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
 * Where a private key block begins that has no END after it, or -1. Read the
 * way the pattern reads: a BEGIN line, then the first END line that starts
 * after it, then on from there. Looked for in the text as it arrived: in the
 * redacted text another pattern may have taken the dashes of a BEGIN line
 * into a match of its own.
 */
function openKeyBlock(raw: string): number {
  let at = 0;
  for (;;) {
    PRIVATE_KEY_BEGIN.lastIndex = at;
    const begin = PRIVATE_KEY_BEGIN.exec(raw);
    PRIVATE_KEY_BEGIN.lastIndex = 0;
    if (!begin) return -1;
    PRIVATE_KEY_END.lastIndex = begin.index + begin[0].length;
    const end = PRIVATE_KEY_END.exec(raw);
    PRIVATE_KEY_END.lastIndex = 0;
    if (!end) return begin.index;
    at = end.index + end[0].length;
  }
}

/**
 * Redact a stream that arrives in chunks.
 *
 * A secret can straddle two chunks (a pipe delivers whatever the writer
 * flushed, and a 64 KB buffer boundary can fall anywhere), and redacting each
 * chunk on its own would let both halves through. This keeps back the end of
 * what it has seen until more arrives, and what it keeps back is kept as it
 * arrived, not redacted: the beginning of a literal value can have the shape
 * of a builtin pattern on its own (the first half of an API key is still
 * key-shaped), and a marker in its place would no longer end like the
 * beginning of the value. Each push redacts everything held plus the new
 * chunk with the whole of it in view, writes the redacted form of the part
 * before the cut, and keeps the part after the cut untouched.
 *
 * The cut is placed so that nothing after it can change how the text before
 * it is redacted, and nothing before it is needed to redact what follows.
 * Kept back, each up to its bound:
 *
 *   - the end of the text that is the beginning of a literal value;
 *   - the unfinished last line, up to STREAM_LINE_HOLDBACK;
 *   - the run of token characters the text ends in, and any such run the cut
 *     would fall inside: a token is not judged until the character after it
 *     has arrived, because what follows decides whether and how far it
 *     matches (STREAM_MATCH_HOLDBACK);
 *   - a match in the current view that reaches past the cut
 *     (STREAM_MATCH_HOLDBACK);
 *   - the lead of a pattern made of several parts, when the text before the
 *     cut ends in one (`PATTERN_LEADS`): a header or variable name whose
 *     value follows, also on the next line (STREAM_MATCH_HOLDBACK);
 *   - a private key block that has begun and has no END yet: from the first
 *     BEGIN after the last END, as the pattern would pair them
 *     (STREAM_KEY_BLOCK_HOLDBACK).
 *
 * Within those bounds, and for the builtin patterns and literal values, the
 * pieces written add up to what `redact()` gives for the whole text. Past a
 * bound they need not: a run or match longer than STREAM_MATCH_HOLDBACK is
 * cut through, and a key block longer than STREAM_KEY_BLOCK_HOLDBACK has its
 * first lines written before its END arrives. Patterns a caller adds that
 * match across white space or punctuation are covered by the line holdback
 * only.
 *
 * With the literal `values` given, the part kept back for them is exactly the
 * end of the text that is also the beginning of one of them, which for a
 * finished line is normally nothing. A program that answers one line at a
 * time and then waits (a stdio MCP server, a REPL) therefore has each reply
 * written when it is produced, unless the line ends in a pattern lead.
 * Without `values` the length alone is known, and one character less than
 * `longestValue` is kept back whatever the text is.
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
      const end = raw.length;
      const unfinishedLine = end - (raw.lastIndexOf('\n') + 1);
      const forValues = literals ? valuePrefixAtEnd(raw, literals) : Math.max(0, longestValue - 1);
      let cut = end - Math.min(end, Math.max(forValues, Math.min(unfinishedLine, STREAM_LINE_HOLDBACK)));

      // The run of token characters the text ends in is not finished.
      let run = end;
      while (run > 0 && isTokenChar(raw[run - 1])) run--;
      if (run < cut && end - run <= STREAM_MATCH_HOLDBACK) cut = run;

      const open = openKeyBlock(raw);
      if (open >= 0 && open < cut && end - open <= STREAM_KEY_BLOCK_HOLDBACK) cut = open;

      const { output, from, to } = redactTracked(raw, patterns);

      // Each rule can only move the cut back, and moving it can bring
      // another rule into play, so they are applied until none moves it.
      for (;;) {
        const before = cut;

        // Not inside a match of the current view.
        for (let i = output.length - 1; i >= 0; i--) {
          if (from[i] < cut && cut < to[i] && end - from[i] <= STREAM_MATCH_HOLDBACK) cut = from[i];
        }

        // Not inside a run of token characters.
        let start = cut;
        while (start > 0 && start < end && isTokenChar(raw[start - 1]) && isTokenChar(raw[start])) start--;
        if (end - start <= STREAM_MATCH_HOLDBACK) cut = start;

        // Not after the lead of a pattern whose next part is still to come.
        // Looked for in the redacted text, which is what the pattern will be
        // applied to (a value redacted in front of a lead is what gives it
        // its word boundary), and in the text as it arrived (a pattern
        // applied later may have taken the lead into a match of its own,
        // which the earlier pattern will undo once its value is there).
        const head = redactedBefore(cut);
        const redacted = output.slice(Math.max(0, head - PATTERN_LEAD_WINDOW), head);
        const arrivedEnd = cut;
        const arrived = raw.slice(Math.max(0, arrivedEnd - PATTERN_LEAD_WINDOW), arrivedEnd);
        for (const lead of PATTERN_LEADS) {
          const inRedacted = lead.exec(redacted);
          if (inRedacted && inRedacted[0].length > 0) {
            const at = from[head - (redacted.length - inRedacted.index)];
            if (at < cut && end - at <= STREAM_MATCH_HOLDBACK) cut = at;
          }
          const inArrived = lead.exec(arrived);
          if (inArrived && inArrived[0].length > 0) {
            const at = arrivedEnd - (arrived.length - inArrived.index);
            if (at < cut && end - at <= STREAM_MATCH_HOLDBACK) cut = at;
          }
        }

        if (cut === before) break;
      }

      // The redacted form of everything before the cut. A match too long to
      // hold is still cut through: its marker is written, never its text.
      pending = raw.slice(cut);
      return output.slice(0, redactedBefore(cut));

      /** How many characters of the redacted text stand for input before `at`. */
      function redactedBefore(at: number): number {
        let low = 0;
        let high = output.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (from[mid] < at) low = mid + 1;
          else high = mid;
        }
        return low;
      }
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
