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
 * not arrived. Larger than any PEM key; a block that has grown past this is
 * let go, so it cannot hold a stream back for good, and a block that begins
 * later is still held.
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

const KEY_KIND = '(?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?';
const PRIVATE_KEY_BEGIN = new RegExp(`-----BEGIN ${KEY_KIND}-----`, 'g');
const PRIVATE_KEY_END = new RegExp(`-----END ${KEY_KIND}-----`, 'g');

/**
 * What can stand between a BEGIN line and its END line in a key somebody
 * printed: a line break, real or written as `\n` in a quoted string, then
 * lines of base64, the header lines PEM and PGP armor use, or a marker left
 * by an earlier pattern. A line may be indented and may end in spaces or
 * tabs: a key in a YAML block scalar is a key. `keyLineAt()` reads one line and its break from where
 * it is applied; the break is empty at the end of the text, or the part of
 * a line break that has arrived so far (the first half of a CRLF, the
 * backslash of an escaped one). A header line may likewise stop after its
 * colon: the text can end anywhere.
 */
const KEY_BREAK = /\r?\n|\\r\\n|\\n|(?:\r|\\|\\r|\\r\\)?$/y;
// One run of white space, then at most one of the two forms: written so that
// no part of a line can be matched by two parts of the pattern.
const KEY_BODY_LINE = /^[ \t]*(?:(?:[A-Za-z0-9+/=]|\[REDACTED:[a-z-]+\])+[ \t]*|(?:Proc-Type|DEK-Info|Version|Comment): .*)?$/;
/** Whole lines of base64 and nothing else: what a key that is being held is continued by. */
const KEY_LINES_ONLY = /^(?:[A-Za-z0-9+/=]+\r?\n)+$/;
/** A BEGIN line on a line of its own. */
const KEY_BEGIN_LINE = new RegExp(`^[ \\t]*-----BEGIN ${KEY_KIND}-----[ \\t]*$`);
/** The line the text ends in, which may be a body line, a header, or an END line that is still arriving. */
const KEY_LAST_LINE = /^[ \t]*(?:(?:[A-Za-z0-9+/=-]|\[REDACTED:[a-z-]+\])+[ \t]*|[A-Za-z-]+:(?: .*)?|-----END [A-Z ]*-{0,5})?$/;
/** A line break written as an escape, cut off where the text ends. */
const PARTIAL_ESCAPE = /(?:\\|\\r|\\r\\)$/;

/**
 * The characters the builtin token shapes are made of. A run of them is one
 * candidate token: no builtin pattern for a single token matches across a
 * character outside this set, and `\b` reads every such character alike.
 */
const TOKEN_CHARS = (() => {
  const table = new Uint8Array(128);
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.+/=') table[ch.charCodeAt(0)] = 1;
  return table;
})();
const isTokenCharAt = (text: string, at: number): boolean => {
  const code = text.charCodeAt(at);
  return code < 128 && TOKEN_CHARS[code] === 1;
};

/**
 * Each builtin pattern that is made of several parts with white space or
 * punctuation between them, as far as it has got when a text ends inside it:
 * the name of a header or variable, its separator, and as much of the value
 * as has arrived, possibly on later lines. Matched at the end of a text. A
 * name that is followed by anything the pattern could not go on with does
 * not match, so a finished line that only mentions `Authorization` is not
 * held once the next line shows that no value follows.
 */
const PATTERNS_IN_PROGRESS: readonly RegExp[] = [
  /\b(?:Authorization|authorization)\s*(?::\s*(?:B|Be|Bea|Bear|Beare|Bearer(?:\s+[A-Za-z0-9._\-+/=]*)?)?)?$/,
  /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)["\s]*(?:[:=]["\s]*[A-Za-z0-9/+=]{0,40})?$/,
  /-----BEGIN [A-Z ]*-{0,4}$/,
];
/** How much text before its end is looked at for a pattern in progress. One that began further back is not followed. */
const PATTERN_PROGRESS_WINDOW = 256;

export interface StreamRedactor {
  /** Feed the next chunk; returns the text that is now safe to write. */
  push(chunk: string): string;
  /** The stream ended; returns whatever was still held back, redacted. */
  end(): string;
}

interface Tracked {
  /** The redacted text. */
  output: string;
  /** `from[i]` and `to[i]`: the input offsets where the source of output character `i` begins and ends. */
  from: number[];
  to: number[];
  /**
   * The text as it was when the private key pattern was about to be applied
   * (every pattern in front of it done), with its own offsets. Absent when
   * the list has no private key pattern.
   */
  beforeKeys?: { text: string; from: number[] };
}

/**
 * `redact()`, with each character of the result tied to the place in the
 * input it stands for. A character that was not redacted covers itself;
 * every character of a marker covers the whole match the marker replaced.
 * The patterns are applied one after another to the running result, exactly
 * as `redact()` applies them.
 */
function redactTracked(input: string, patterns: readonly SecretPattern[]): Tracked {
  let output = input;
  let from = Array.from({ length: input.length }, (_, i) => i);
  let to = Array.from({ length: input.length }, (_, i) => i + 1);
  let beforeKeys: Tracked['beforeKeys'];
  for (const pattern of patterns) {
    if (pattern.kind === 'private-key' && beforeKeys === undefined) beforeKeys = { text: output, from };
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
  return { output, from, to, beforeKeys };
}

/**
 * The line that begins at `pos`, without its break, and the break: a real
 * one, one written as an escape, the part of either that has arrived where
 * the text ends, or nothing at the end of the text. Null where the line is
 * ended by a backslash that is none of these.
 */
function keyLineAt(text: string, pos: number): [content: string, lineBreak: string] | null {
  let end = pos;
  for (; end < text.length; end++) {
    const c = text.charCodeAt(end);
    if (c === 10 || c === 13 || c === 92) break;
  }
  KEY_BREAK.lastIndex = end;
  const found = KEY_BREAK.exec(text);
  KEY_BREAK.lastIndex = 0;
  return found ? [text.slice(pos, end), found[0]] : null;
}

/**
 * Whether everything in `text` from `at` (the end of a BEGIN line) to `stop`
 * could be the body of a key that is still arriving. `stop` is where the
 * text ends, or where a literal value that is still arriving begins: that
 * value will be a marker, whatever it looks like now.
 *
 * A second BEGIN line counts as body when key lines came before it: a block
 * that was never closed, followed by another, is one block to the pattern,
 * which pairs the first BEGIN with the first END. BEGIN lines with nothing
 * between them (a search for the header across many files) are not a key.
 */
function isKeyMaterial(text: string, at: number, stop: number): boolean {
  if (at >= stop) return true;
  let pos = at;
  let first = true;
  let keyLines = 0;
  for (;;) {
    const line = keyLineAt(text, pos);
    if (!line) return false;
    const [content, lineBreak] = line;
    const whole = content + lineBreak;
    if (pos + content.length >= stop || lineBreak === '') {
      // The line the text stops in, or a backslash that is not a line break.
      const rest = text.slice(pos, stop);
      const partial = PARTIAL_ESCAPE.exec(rest);
      if (pos + content.length < stop && !partial) return false;
      const last = partial ? rest.slice(0, partial.index) : rest;
      return first ? last === '' : KEY_LAST_LINE.test(last);
    }
    // The BEGIN line ends where its dashes end; after that, body lines.
    if (first) {
      if (content !== '') return false;
    } else if (KEY_BEGIN_LINE.test(content)) {
      if (keyLines === 0) return false;
      keyLines = 0;
    } else if (!KEY_BODY_LINE.test(content)) {
      return false;
    } else if (content !== '') {
      keyLines++;
    }
    first = false;
    pos += whole.length;
    if (pos >= stop) return true;
  }
}

/**
 * Where a private key block begins that is still arriving, or -1: a BEGIN
 * line with no END line after it, followed up to `stop` by nothing but key
 * material (`isKeyMaterial`), and no further back than
 * STREAM_KEY_BLOCK_HOLDBACK. The first such one: a block that began further
 * back, or a BEGIN line that something else follows, does not keep a later
 * block from being held. A BEGIN line followed by anything but key material
 * is a mention of one, in a log line or a quoted string, and is not waited
 * for.
 *
 * `text` is the text the private key pattern is applied to, so a BEGIN or
 * END line inside an injected value, which an earlier pattern has already
 * replaced, is not counted.
 */
function openKeyBlock(text: string, stop: number): number {
  let lastEnd = -1;
  PRIVATE_KEY_END.lastIndex = 0;
  for (const match of text.matchAll(PRIVATE_KEY_END)) lastEnd = match.index;
  PRIVATE_KEY_END.lastIndex = 0;
  // A BEGIN line that an END line follows is closed or inside a closed
  // block, whichever BEGIN the pattern pairs that END with.
  PRIVATE_KEY_BEGIN.lastIndex = Math.max(0, lastEnd - 64, text.length - STREAM_KEY_BLOCK_HOLDBACK);
  let found = -1;
  for (let begin = PRIVATE_KEY_BEGIN.exec(text); begin; begin = PRIVATE_KEY_BEGIN.exec(text)) {
    const bodyStart = begin.index + begin[0].length;
    if (lastEnd >= bodyStart) continue;
    if (begin.index >= stop || isKeyMaterial(text, bodyStart, stop)) {
      found = begin.index;
      break;
    }
  }
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  return found;
}

/** The first index of an ascending list whose entry is not below `at`. */
function firstNotBelow(list: readonly number[], at: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid] < at) low = mid + 1;
    else high = mid;
  }
  return low;
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
 * Kept back, each up to its bound:
 *
 *   - the end of the text that is the beginning of a literal value;
 *   - the unfinished last line: STREAM_LINE_HOLDBACK of it, and up to twice
 *     that while nothing else has arrived, so a long line that comes in
 *     small pieces is read once per STREAM_LINE_HOLDBACK and not once per
 *     piece;
 *   - the run of token characters the text ends in, and any such run the cut
 *     would fall inside: a token is not judged until the character after it
 *     has arrived, because what follows decides whether and how far it
 *     matches (STREAM_MATCH_HOLDBACK);
 *   - a match in the current view that reaches past the cut
 *     (STREAM_MATCH_HOLDBACK);
 *   - a builtin pattern in several parts that the text ends inside
 *     (`PATTERNS_IN_PROGRESS`): a header or variable name with as much of
 *     its separator and value as has arrived, also across lines, as long as
 *     it began within PATTERN_PROGRESS_WINDOW of the end;
 *   - a private key block that is still arriving (`openKeyBlock`): a BEGIN
 *     line with no END yet and nothing but key material after it
 *     (STREAM_KEY_BLOCK_HOLDBACK).
 *
 * For text where each of those is inside its bound, and for the builtin
 * patterns and literal values, the pieces written add up to what `redact()`
 * gives for the whole text. Outside them they need not:
 *
 *   - a run or match longer than STREAM_MATCH_HOLDBACK is cut through;
 *   - a key block longer than STREAM_KEY_BLOCK_HOLDBACK has its first lines
 *     written before its END arrives;
 *   - a BEGIN line followed by text that is not key material is written with
 *     what follows it, where `redact()` on the whole text would take
 *     everything up to a later END line as one block;
 *   - a pattern in several parts with more than PATTERN_PROGRESS_WINDOW
 *     characters between its beginning and the end of the text is not held;
 *   - patterns a caller adds that match across white space or punctuation
 *     are covered by the line holdback only.
 *
 * With the literal `values` given, a finished line is written at once unless
 * it ends like the beginning of a value, ends inside a pattern in several
 * parts (a line that is just `Authorization: Bearer`), or is key material
 * after a BEGIN line. A program that answers one line at a time and then
 * waits (a stdio MCP server, a REPL) therefore has each reply written when
 * it is produced, including one that mentions a BEGIN line in a sentence or
 * a JSON string. Without `values` the length alone is known, and one
 * character less than `longestValue` is kept back whatever the text is.
 *
 * Nothing is redacted while the whole of what is held is one unfinished line
 * or one unfinished run of token characters, or a key block from its BEGIN
 * line on that the new chunk continues with whole lines of base64, since
 * nothing would be written either way; text that arrives a few characters or
 * a line at a time is therefore not read again on every push. Any other
 * held text is: a push costs time in proportion to what is held.
 */
export function createStreamRedactor(
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS,
  longestValue = 0,
  values?: readonly string[],
): StreamRedactor {
  let pending = '';
  /** `pending` is nothing but token characters. */
  let pendingIsRun = true;
  /** `pending` has no line break in it. */
  let pendingIsLine = true;
  /** `pending` begins with the BEGIN line of a key block that is being held, and ends with a line break. */
  let pendingIsKey = false;
  const literals = values?.filter((v) => v && v.trim().length > 0);
  return {
    push(chunk: string): string {
      const raw = pending + chunk;
      const end = raw.length;

      // What the chunk alone settles, without reading what is held again.
      let chunkRun = chunk.length;
      while (chunkRun > 0 && isTokenCharAt(chunk, chunkRun - 1)) chunkRun--;
      const chunkBreak = chunk.lastIndexOf('\n');
      const isRun = pendingIsRun && chunkRun === 0;
      const isLine = pendingIsLine && chunkBreak < 0;
      if ((isRun && end <= STREAM_MATCH_HOLDBACK) || (isLine && end <= 2 * STREAM_LINE_HOLDBACK)) {
        pending = raw;
        pendingIsRun = isRun;
        pendingIsLine = isLine;
        return '';
      }
      if (pendingIsKey && end <= STREAM_KEY_BLOCK_HOLDBACK && KEY_LINES_ONLY.test(chunk)) {
        pending = raw;
        return '';
      }

      const lineStart = chunkBreak >= 0 ? pending.length + chunkBreak + 1 : raw.lastIndexOf('\n') + 1;
      const forValues = literals ? valuePrefixAtEnd(raw, literals) : Math.max(0, longestValue - 1);
      const valueStart = end - Math.min(end, forValues);
      let cut = Math.min(valueStart, Math.max(lineStart, end - STREAM_LINE_HOLDBACK));

      // The run of token characters the text ends in is not finished.
      let run = chunkRun > 0 ? pending.length + chunkRun : end;
      if (chunkRun === 0) {
        run = pending.length;
        while (run > 0 && isTokenCharAt(raw, run - 1)) run--;
      }
      if (run < cut && end - run <= STREAM_MATCH_HOLDBACK) cut = run;

      const { output, from, to, beforeKeys } = redactTracked(raw, patterns);

      /** How many characters of the redacted text stand for input before `at`. */
      const redactedBefore = (at: number): number => firstNotBelow(from, at);

      let keyBlock = -1;
      if (beforeKeys) {
        const open = openKeyBlock(beforeKeys.text, firstNotBelow(beforeKeys.from, valueStart));
        if (open >= 0 && open < beforeKeys.text.length) keyBlock = beforeKeys.from[open];
        if (keyBlock >= 0 && keyBlock < cut) cut = keyBlock;
      }

      // A pattern in several parts that the text ends inside. Looked for in
      // the redacted text, which is what the pattern will be applied to (a
      // value redacted in front of a name is what gives it its word
      // boundary), and in the text as it arrived (a pattern applied later
      // may have taken the name into a match of its own, which the earlier
      // pattern undoes once its value is there). Looked for where the text
      // ends, where a literal value that is still arriving begins (that
      // value will be a marker, and the pattern ends in front of it), and
      // where a match begins that reaches the end of the text (it may still
      // grow out of its pattern, and then the text is the value of another).
      const last = output.length - 1;
      const openMatch = last >= 0 && to[last] === end && to[last] - from[last] > 1 ? from[last] : end;
      for (const stop of new Set([end, valueStart, openMatch])) {
        const redactedStop = redactedBefore(stop);
        const redacted = output.slice(Math.max(0, redactedStop - PATTERN_PROGRESS_WINDOW), redactedStop);
        const arrived = raw.slice(Math.max(0, stop - PATTERN_PROGRESS_WINDOW), stop);
        for (const pattern of PATTERNS_IN_PROGRESS) {
          const inRedacted = pattern.exec(redacted);
          if (inRedacted && inRedacted[0].length > 0) {
            const at = from[redactedStop - (redacted.length - inRedacted.index)];
            if (at < cut) cut = at;
          }
          const inArrived = pattern.exec(arrived);
          if (inArrived && inArrived[0].length > 0) {
            const at = stop - (arrived.length - inArrived.index);
            if (at < cut) cut = at;
          }
        }
      }

      // The matches of the current view, in order: where each begins and ends in the input.
      const matches: Array<[number, number]> = [];
      for (let i = 0; i < output.length; i++) {
        if (to[i] - from[i] > 1 && (matches.length === 0 || matches[matches.length - 1][0] !== from[i])) matches.push([from[i], to[i]]);
      }

      // The remaining rules can only move the cut back, and moving it can
      // bring another into play, so they are applied until none moves it.
      for (;;) {
        const before = cut;

        // Not inside a match of the current view.
        let low = 0;
        let high = matches.length;
        while (low < high) {
          const mid = (low + high) >> 1;
          if (matches[mid][1] <= cut) low = mid + 1;
          else high = mid;
        }
        if (low < matches.length && matches[low][0] < cut && end - matches[low][0] <= STREAM_MATCH_HOLDBACK) cut = matches[low][0];

        // Not inside a run of token characters.
        let start = cut;
        while (start > 0 && start < end && isTokenCharAt(raw, start - 1) && isTokenCharAt(raw, start)) start--;
        if (end - start <= STREAM_MATCH_HOLDBACK) cut = start;

        // Not between the two halves of a character outside the BMP, also
        // when the second half is still to come.
        if (cut > 0 && (raw.charCodeAt(cut - 1) & 0xfc00) === 0xd800 && (cut === end || (raw.charCodeAt(cut) & 0xfc00) === 0xdc00)) cut--;

        if (cut === before) break;
      }

      // The redacted form of everything before the cut. A match too long to
      // hold is still cut through: its marker is written, never its text.
      pending = raw.slice(cut);
      pendingIsRun = run <= cut;
      pendingIsLine = lineStart <= cut;
      pendingIsKey = keyBlock === cut && cut < end && raw.charCodeAt(end - 1) === 10;
      return output.slice(0, redactedBefore(cut));
    },
    end(): string {
      const out = redact(pending, patterns).output;
      pending = '';
      pendingIsRun = true;
      pendingIsLine = true;
      pendingIsKey = false;
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
