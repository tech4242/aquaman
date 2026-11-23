/**
 * The stream redactor against `redact()` on the whole text.
 *
 * The claim: for the builtin patterns and literal values, and inside the
 * redactor's bounds (a run of token characters, a match or a pattern lead of
 * at most 1 MiB, a key block of at most 64 KiB, at most 256 characters of
 * white space inside a pattern lead), the pieces a stream redactor writes add
 * up to exactly what `redact()` gives for the whole text, however the text
 * is cut into chunks. In particular no 12 characters of a secret are written
 * that one-piece redaction would have removed.
 *
 * Randomized, with a fixed seed so a run repeats: texts are put together
 * from whole secrets, beginnings and ends of secrets, and filler chosen to
 * sit badly (markers as input, loose BEGIN and END lines, pattern leads,
 * punctuation), then cut at random places. One targeted row per input class
 * that was found to differ. What is past a bound is an `it.fails` row.
 */
import { describe, it, expect } from 'vitest';
import { redact, BUILTIN_PATTERNS, buildValuePatterns, createStreamRedactor, type SecretPattern } from 'aquaman-core';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VALUES = [
  'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
  'xoxb-' + '1234567890-abcdefghijklmnop', // made up; in two parts so a secret scanner does not flag this file
  'plain value with spaces and (regex) [meta] chars.*+?^$',
  'line one of value\nline two of value',
  'abcdefghijklmnopq',
  'abcdefghijklmnopqrstuvwxyz', // the one above is a prefix
  'RSTUVWXYZabcdefghijklmnopq', // the short one is a suffix
  '[REDACTED:injected-value]tail-of-a-value',
  'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
  'opqrstuvwxyz-sk-ant-api03-abcdefgh', // overlaps the first value's start
];

/** Values that look like parts of the builtin patterns, or begin with punctuation. */
const AWKWARD_VALUES = [
  '"quoted value: with, breakers"',
  'Authorization: Bearer',
  'Bearer value-that-follows',
  '=starts-with-equals',
  'aws_secret_access_key',
];

const KEY_BLOCKS = [
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyz\nabcdefghijklmnopqrstuvwxyzABCDEF\n-----END RSA PRIVATE KEY-----',
  '-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyz\n-----END PRIVATE KEY-----',
];

const TOKENS = [
  'sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210zyxw',
  'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'AKIAIOSFODNN7EXAMPLE',
  'xoxp-999999999999-zzzzzzzzzzzz',
  'glpat-ABCDEFGHIJKLMNOPQRST',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  'Authorization: Bearer abcdefghijklmnop0123456789',
  'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'aquaman-proxy-managed',
];

/** The patterns made of several parts, with their parts on separate lines, and a few more single tokens. */
const SPREAD_TOKENS = [
  'Authorization:\nBearer\n abcdefghijklmnop0123456789',
  'AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"',
  'aws_secret_access_key\n:\n"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'sk_live_' + 'abcdefghijklmnopqrstuvwx', // made up; in two parts, as above
  'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  'AIzaSyA-abcdefghijklmnopqrstuvwxyz01234',
];

const FILLER = ['\n', '\n', ' ', 'x', 'hello world', '[REDACTED:anthropic-key]', '[REDACTED:injected-value]', '=', '"', '.', '-', 'sk-', 'sk-ant-', '\n\n', 'Authorization:', 'eyJ'];
const KEY_FILLER = ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----'];
const AWKWARD_FILLER = [':', ',', '{"a":"', '"}', '-----', 'Bearer ', 'aws_secret_access_key', '\t', '-----BEGIN RSA ', 'PRIVATE KEY-----', '-----END ', 'é', '\r\n'];

interface Shape {
  /** Whole key blocks among the secrets. */
  keyBlocks: boolean;
  /** Loose BEGIN and END lines among the filler, and key blocks cut short. */
  looseKeyLines: boolean;
  /** A space or a newline after every part. */
  sep: boolean;
  /** The awkward values, tokens and filler as well. */
  awkward: boolean;
  /** Up to this many characters of one kind of text in a part, so lines outgrow the line holdback. 0 for none. */
  long: number;
  /** The largest chunk. */
  chunk: number;
  /** How many texts. */
  rounds: number;
}

function buildText(rnd: () => number, shape: Shape, values: readonly string[]): string {
  const tokens = [...TOKENS, ...(shape.keyBlocks ? KEY_BLOCKS : []), ...(shape.awkward ? SPREAD_TOKENS : [])];
  const filler = [...FILLER, ...(shape.looseKeyLines ? KEY_FILLER : []), ...(shape.awkward ? AWKWARD_FILLER : [])];
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
  const parts: string[] = [];
  const n = 1 + Math.floor(rnd() * (shape.awkward ? 24 : 14));
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.28) parts.push(pick(values));
    else if (r < 0.43) {
      const v = pick(values);
      parts.push(v.slice(0, 1 + Math.floor(rnd() * (v.length - 1))));
    } else if (r < 0.53) {
      const v = pick(values);
      parts.push(v.slice(Math.floor(rnd() * (v.length - 1))));
    } else if (r < 0.72) parts.push(pick(tokens));
    else if (r < 0.78) {
      const v = pick(tokens);
      parts.push(!shape.looseKeyLines && v.includes('PRIVATE KEY') ? v : v.slice(0, 1 + Math.floor(rnd() * (v.length - 1))));
    } else if (r < 0.83 && shape.long > 0) {
      const kind = rnd();
      const len = Math.floor(rnd() * shape.long);
      parts.push(kind < 0.4 ? 'a1B2'.repeat(len / 4) : kind < 0.7 ? 'word, '.repeat(len / 6) : '-'.repeat(len));
    } else parts.push(pick(filler));
    if (shape.sep) parts.push(rnd() < 0.5 ? '\n' : ' ');
  }
  return parts.join('');
}

/** A 12-character piece of a secret that is in `out` and not in `expected`. */
function leaked(out: string, expected: string, secrets: readonly string[]): string | undefined {
  for (const s of secrets) {
    for (let i = 0; i + 12 <= s.length; i++) {
      const w = s.slice(i, i + 12);
      if (out.includes(w) && !expected.includes(w)) return w;
    }
  }
  return undefined;
}

function cuts(text: string, rnd: () => number, largest: number): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const r = rnd();
    const len = r < 0.4 ? 1 + Math.floor(rnd() * 6) : r < 0.8 || largest <= 60 ? 1 + Math.floor(rnd() * 60) : 1 + Math.floor(rnd() * largest);
    out.push(text.slice(at, at + len));
    at += len;
  }
  return out;
}

/** `exec`'s wiring with the literal values handed over, or with their length alone. */
function stream(chunks: readonly string[], patterns: readonly SecretPattern[], values: readonly string[], literal = true): string {
  const longest = values.reduce((m, v) => Math.max(m, v.length), 0);
  const r = literal ? createStreamRedactor(patterns, longest, values) : createStreamRedactor(patterns, longest);
  return chunks.map((c) => r.push(c)).join('') + r.end();
}

const SEED = 20261123;
const base = { keyBlocks: false, looseKeyLines: false, sep: false, awkward: false, long: 0, chunk: 60, rounds: 3000 };

const CLASSES: Array<[string, Shape]> = [
  ['no key blocks, parts joined directly', { ...base }],
  ['no key blocks, parts separated by a space or newline', { ...base, sep: true }],
  ['whole key blocks, parts separated by a space or newline', { ...base, keyBlocks: true, sep: true }],
  ['key blocks, loose BEGIN and END lines and blocks cut short, parts separated', { ...base, keyBlocks: true, looseKeyLines: true, sep: true }],
  ['key blocks, loose BEGIN and END lines and blocks cut short, parts joined directly', { ...base, keyBlocks: true, looseKeyLines: true }],
  ['pattern parts on separate lines, punctuation, values that look like pattern parts; joined directly', { ...base, keyBlocks: true, looseKeyLines: true, awkward: true }],
  ['pattern parts on separate lines, punctuation, values that look like pattern parts; separated', { ...base, keyBlocks: true, looseKeyLines: true, awkward: true, sep: true }],
  ['the same with lines longer than the line holdback and chunks up to 6000; joined directly', { ...base, keyBlocks: true, looseKeyLines: true, awkward: true, long: 9000, chunk: 6000, rounds: 800 }],
  ['the same with lines longer than the line holdback and chunks up to 6000; separated', { ...base, keyBlocks: true, looseKeyLines: true, awkward: true, sep: true, long: 9000, chunk: 6000, rounds: 800 }],
];

describe('stream redactor, randomized: what is written is what one-piece redaction gives', () => {
  it.each(CLASSES)('%s', (_name, shape) => {
    const rnd = mulberry32(SEED);
    const pool = shape.awkward ? [...VALUES, ...AWKWARD_VALUES] : VALUES;
    let differ = 0;
    let leaks = 0;
    const examples: string[] = [];
    for (let round = 0; round < shape.rounds; round++) {
      const values = pool.filter(() => rnd() < 0.5);
      const patterns = [...buildValuePatterns(values), ...BUILTIN_PATTERNS];
      const text = buildText(rnd, shape, values.length > 0 ? values : pool);
      const expected = redact(text, patterns).output;
      const chunks = cuts(text, rnd, shape.chunk);
      const out = stream(chunks, patterns, values, rnd() < 0.8);
      if (out !== expected) {
        differ++;
        const piece = leaked(out, expected, [...values, ...TOKENS, ...KEY_BLOCKS, ...SPREAD_TOKENS]);
        if (piece) leaks++;
        if (examples.length < 3 && text.length < 1500) examples.push(JSON.stringify({ piece, values, chunks, expected, out }).slice(0, 2500));
      }
    }
    expect({ differ, leaks, examples }).toEqual({ differ: 0, leaks: 0, examples: [] });
  }, 120_000);
});

describe('stream redactor, one row per input class that was found to differ', () => {
  const run = (chunks: string[], values: string[] = [], extra: SecretPattern[] = []) => {
    const patterns = [...buildValuePatterns(values), ...extra, ...BUILTIN_PATTERNS];
    return { out: stream(chunks, patterns, values), expected: redact(chunks.join(''), patterns).output };
  };
  const AWS = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  it('a JWT that outgrows the line holdback before it first matches', () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${'A1b2'.repeat(1500)}.${'sig0'.repeat(20)}`;
    const { out, expected } = run([`token=${jwt.slice(0, 5500)}`, `${jwt.slice(5500)}\n`]);
    expect(expected).toBe('token=[REDACTED:jwt]\n');
    expect(out).toBe(expected);
  });

  it('two secrets with nothing between them, the second still arriving', () => {
    const value = 'abcdefghijklmnopq';
    for (let cut = 1; cut < value.length; cut++) {
      const { out, expected } = run([`id AKIAIOSFODNN7EXAMPLE${value.slice(0, cut)}`, `${value.slice(cut)} end\n`], [value]);
      expect(expected).toBe('id [REDACTED:aws-access-key-id][REDACTED:injected-value] end\n');
      expect(out).toBe(expected);
    }
  });

  it('a token directly followed by text that decides whether it matches', () => {
    // Followed by a word character the access key id is not one; the stream must not have judged it early.
    const { out, expected } = run(['id AKIAIOSFODNN7EXAMPLE', 'x end\n']);
    expect(expected).toBe('id AKIAIOSFODNN7EXAMPLEx end\n');
    expect(out).toBe(expected);
  });

  it('a key block that never ends, followed by one that does', () => {
    const body = 'MIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyzxyzxyz';
    const { out, expected } = run([
      `-----BEGIN RSA PRIVATE KEY-----\n${body}\n`,
      '-----BEGIN RSA PRIVATE KEY-----\nother\n',
      '-----END RSA PRIVATE KEY-----\n',
    ]);
    expect(expected).toBe('[REDACTED:private-key]\n');
    expect(out).toBe(expected);
  });

  it('a BEGIN line directly after a token whose characters include the dash', () => {
    const body = 'MIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyzxyzxyz';
    const { out, expected } = run([
      `sk-ant-${'a1B2'.repeat(10)}-----BEGIN PRIVATE KEY-----\n`,
      `${body}\n`,
      `${body}\n`,
      '-----END PRIVATE KEY-----\n',
    ]);
    expect(expected).not.toContain(body);
    expect(out).toBe(expected);
  });

  it('an END line whose dashes are the last dashes of a BEGIN line does not close the block', () => {
    const { out, expected } = run([
      '-----BEGIN RSA PRIVATE KEY------END PRIVATE KEY-----\n',
      'MIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyz\n',
      '-----END RSA PRIVATE KEY-----\n',
    ]);
    expect(expected).toBe('[REDACTED:private-key]\n');
    expect(out).toBe(expected);
  });

  const acrossLines: Array<[string, string[], string]> = [
    ['an AWS secret key on the line after its name', ['aws_secret_access_key =\n', `${AWS}\n`], AWS],
    ['an AWS secret key, name, colon and quoted value on three lines', ['x\nAWS_SECRET_ACCESS_KEY\n', ':\n', `"${AWS}"\n`], AWS],
    ['a bearer token on the line after the header name', ['Authorization: Bearer\n', 'abcdefghijklmnop0123456789\n'], 'abcdefghijklmnop0123456789'],
    ['a bearer token, header name, scheme and token on three lines', ['authorization\n', ':   Bearer\n', '\tabcdefghijklmnop0123456789\n'], 'abcdefghijklmnop0123456789'],
  ];
  for (const [name, chunks, secret] of acrossLines) {
    it(`a pattern across finished lines: ${name}`, () => {
      const { out, expected } = run(chunks);
      expect(expected).not.toContain(secret);
      expect(out).toBe(expected);
    });
  }

  it('a name of a later pattern inside what an earlier-looking match has taken: the AWS name at the end of a bearer token', () => {
    const { out, expected } = run(['Authorization: Bearer abcdefghijklmnop0123456789.aws_secret_access_key\n', `:\n"${AWS}\n`]);
    expect(expected).toBe('[REDACTED:bearer-token][REDACTED:aws-secret-access-key]\n');
    expect(out).toBe(expected);
  });

  it('a pattern lead that gets its word boundary from a value redacted in front of it', () => {
    const value = 'abcdefghijklmnopq';
    const { out, expected } = run([`${value}aws_secret_access_key = `, `${AWS} end\n`], [value]);
    expect(expected).toBe('[REDACTED:injected-value][REDACTED:aws-secret-access-key] end\n');
    expect(out).toBe(expected);
  });

  it('token-shaped text after a word character, where the line holdback would cut a long line', () => {
    const line = `${'x'.repeat(100)}AKIAIOSFODNN7EXAMPLE${'-'.repeat(4096 - 20)}`;
    const { out, expected } = run([line, '\n']);
    expect(expected).toBe(`${line}\n`);
    expect(out).toBe(expected);
  });

  it('a finished line that ends in nothing a secret begins with is written at once', () => {
    const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
    expect(r.push('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n')).toBe('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');
    expect(r.push('plain words, then a full stop.\n')).toBe('plain words, then a full stop.\n');
    // One that ends in a pattern lead waits for the next line.
    expect(r.push('Authorization: Bearer\n')).toBe('');
    expect(r.push('not-a-token\n')).toBe('Authorization: Bearer\nnot-a-token\n');
  });

  it('holds a bounded amount for a match that never ends, and does not take quadratic time', () => {
    const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
    const started = Date.now();
    let written = 0;
    r.push('sk-');
    const chunk = 'A'.repeat(64 * 1024);
    for (let i = 0; i < 48; i++) written += r.push(chunk).length; // 3 MiB
    const elapsed = Date.now() - started;
    written += r.end().length;
    expect(elapsed).toBeLessThan(20_000);
    expect(written).toBeGreaterThan(0);
  }, 60_000);

  describe('past the bounds', () => {
    it.fails('LIMIT: a run of token characters longer than 1 MiB that becomes a match only at its end (a JWT with a payload that size) is written before it matches', () => {
      const jwt = `eyJhbGciOiJSUzI1NiJ9.${'A1b2'.repeat(280_000)}.${'sig0'.repeat(20)}`;
      const { out, expected } = run([`token=${jwt.slice(0, 1_100_000)}`, `${jwt.slice(1_100_000)}\n`]);
      expect(expected).toBe('token=[REDACTED:jwt]\n');
      expect(out).toBe(expected);
    });

    it.fails('LIMIT: a private key block longer than 64 KiB has its first lines written before its END line arrives', () => {
      const line = `${'MIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz'}\n`;
      const { out, expected } = run(['-----BEGIN PRIVATE KEY-----\n', ...Array.from({ length: 1100 }, () => line), '-----END PRIVATE KEY-----\n']);
      expect(expected).toBe('[REDACTED:private-key]\n');
      expect(out).toBe(expected);
    });

    it.fails('LIMIT: more than 256 characters of white space between the name and the value of a pattern in several parts, split there', () => {
      const { out, expected } = run([`aws_secret_access_key =${'\n'.repeat(300)}`, `${AWS}\n`]);
      expect(expected).toBe('[REDACTED:aws-secret-access-key]\n');
      expect(out).toBe(expected);
    });

    it.fails('LIMIT: a pattern a caller adds that matches across lines is not held for; only the builtin patterns in several parts are', () => {
      const custom: SecretPattern = { kind: 'custom', description: 'a caller\'s own pattern over two lines', regex: /passphrase is\nhunter[0-9]+/g };
      const { out, expected } = run(['the passphrase is\n', 'hunter2222222222\n'], [], [custom]);
      expect(expected).toBe('the [REDACTED:custom]\n');
      expect(out).toBe(expected);
    });
  });
});
