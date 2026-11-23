/**
 * Compliance test: OWASP Top 10 for LLM Applications 2025, LLM02 (Sensitive
 * Information Disclosure), for the output of a command run under
 * `aquaman-coder exec`.
 *
 * The claim: a value aquaman injected into a command does not reach the
 * transcript when the command prints it, in the form it was given or in the
 * shapes ordinary tools print it in, however the output is split into chunks.
 * It is a guard against accidents, not against a command written to get
 * around it.
 *
 * The redactor is assembled the way `exec` assembles it: literal patterns for
 * each injected value in front of the built-in shape patterns, applied as a
 * stream with a hold-back as long as the longest value.
 *
 * Two shapes are known to get through and are `it.fails` rows stating why.
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_PATTERNS, buildValuePatterns, createStreamRedactor } from 'aquaman-core';

/** Not shaped like any vendor's key, so only the literal match can catch it. */
const VALUE = 'REALSECRET-declared-FFFFFFFF';
const OTHER = 'second/value+with=odd.chars(1)';
const MARK = '[REDACTED:injected-value]';

/** Run text through the redactor as `exec` does, delivered in the chunks given. */
function redactStream(chunks: string[], values: string[] = [VALUE, OTHER]): string {
  const patterns = [...buildValuePatterns(values), ...BUILTIN_PATTERNS];
  const longest = values.reduce((n, v) => Math.max(n, v.length), 0);
  const redactor = createStreamRedactor(patterns, longest, values);
  return chunks.map((c) => redactor.push(c)).join('') + redactor.end();
}

interface Shape {
  name: string;
  /** What the command printed. */
  output: string;
  /** Why this shape gets through today; absent for one that is caught. */
  limit?: string;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

const SHAPES: Shape[] = [
  { name: 'on a line of its own (echo $TOKEN)', output: `${VALUE}\n` },
  { name: 'in an environment dump (env)', output: `HOME=/home/u\nGITHUB_TOKEN=${VALUE}\nPATH=/usr/bin\n` },
  { name: 'in a shell trace (set -x)', output: `+ curl -H 'Authorization: token ${VALUE}' https://api.example/user\n` },
  { name: 'in an exported assignment (export -p)', output: `declare -x GITHUB_TOKEN="${VALUE}"\n` },
  { name: 'in a request header printed by a verbose client', output: `> GET /user HTTP/2\r\n> authorization: Bearer ${VALUE}\r\n> accept: */*\r\n` },
  { name: 'in a URL', output: `fatal: unable to access 'https://x-access-token:${VALUE}@github.example/o/r.git/'\n` },
  { name: 'in JSON', output: `{"config":{"token":"${VALUE}","retries":3}}\n` },
  { name: 'in an error message', output: `Error: 401 Unauthorized for key ${VALUE} (request id 7f3a)\n` },
  { name: 'twice on one line', output: `old=${VALUE} new=${VALUE}\n` },
  { name: 'with no newline at the end of the output', output: `token: ${VALUE}` },
  { name: 'directly against other text on both sides', output: `xx${VALUE}yy\n` },
  { name: 'a second injected value with regex metacharacters', output: `SECOND=${OTHER}\n` },
  { name: 'both injected values', output: `A=${VALUE}\nB=${OTHER}\n` },
  {
    name: 'base64, as a verbose HTTP client prints Basic auth (curl -v -u user:$TOKEN)',
    output: `> Authorization: Basic ${b64(`user:${VALUE}`)}\n`,
    limit: 'only the literal value is matched; an encoding of it is a different string',
  },
  {
    name: 'colour codes inside the value (env | grep --color=always declared)',
    output: 'DECL=REALSECRET-\u001b[01;31m\u001b[Kdeclared\u001b[m\u001b[K-FFFFFFFF\n',
    limit: 'escape sequences are not removed before matching, so the value is no longer contiguous',
  },
];

/** True when the value can be read back out of the text: as written, base64-decoded, or with colour codes removed. */
function recoverable(text: string, value: string): boolean {
  if (text.includes(value)) return true;
  // eslint-disable-next-line no-control-regex
  if (text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').includes(value)) return true;
  for (const candidate of text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    if (Buffer.from(candidate, 'base64').toString('latin1').includes(value)) return true;
  }
  return false;
}

describe('LLM02: an injected value does not reach the transcript', () => {
  describe('printed in one piece', () => {
    for (const shape of SHAPES.filter((s) => !s.limit)) {
      it(`redacted: ${shape.name}`, () => {
        const out = redactStream([shape.output]);
        expect(recoverable(out, VALUE)).toBe(false);
        expect(recoverable(out, OTHER)).toBe(false);
        expect(out).toContain(MARK);
      });
    }
  });

  describe('split across chunks', () => {
    for (const shape of SHAPES.filter((s) => !s.limit)) {
      it(`redacted at every split point: ${shape.name}`, () => {
        for (let cut = 1; cut < shape.output.length; cut++) {
          const out = redactStream([shape.output.slice(0, cut), shape.output.slice(cut)]);
          expect(recoverable(out, VALUE), `cut at ${cut}`).toBe(false);
          expect(recoverable(out, OTHER), `cut at ${cut}`).toBe(false);
        }
      });
    }

    it('one character per chunk', () => {
      const text = `first line\nGITHUB_TOKEN=${VALUE}\nlast line\n`;
      const out = redactStream([...text]);
      expect(out).toBe(`first line\nGITHUB_TOKEN=${MARK}\nlast line\n`);
    });

    it('three chunks, cut twice inside the value', () => {
      const text = `GITHUB_TOKEN=${VALUE}\n`;
      const start = text.indexOf(VALUE);
      for (let a = start + 1; a < start + VALUE.length - 1; a += 3) {
        for (let b = a + 1; b < start + VALUE.length; b += 4) {
          const out = redactStream([text.slice(0, a), text.slice(a, b), text.slice(b)]);
          expect(out, `cuts at ${a} and ${b}`).toBe(`GITHUB_TOKEN=${MARK}\n`);
        }
      }
    });

    it('the text around a redaction is written unchanged and in order', () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i} of ordinary output`);
      lines[120] = `token ${VALUE} here`;
      const text = lines.join('\n') + '\n';
      const chunks = text.match(/[\s\S]{1,37}/g)!;
      lines[120] = `token ${MARK} here`;
      expect(redactStream(chunks)).toBe(lines.join('\n') + '\n');
    });
  });

  describe('known limits', () => {
    for (const shape of SHAPES.filter((s) => s.limit)) {
      // Current limit: see `shape.limit` in the row; the assertion is what should hold.
      it.fails(`should be redacted, is not yet: ${shape.name} (${shape.limit})`, () => {
        const out = redactStream([shape.output]);
        expect(recoverable(out, VALUE)).toBe(false);
      });
    }
  });

  it('the check itself can tell: it finds a value in each shape before redaction', () => {
    for (const shape of SHAPES) {
      expect(recoverable(shape.output, VALUE) || recoverable(shape.output, OTHER), shape.name).toBe(true);
    }
  });
});
