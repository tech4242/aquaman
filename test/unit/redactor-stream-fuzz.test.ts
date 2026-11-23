/**
 * The stream redactor against `redact()` on the whole text.
 *
 * The claim: for the builtin patterns and literal values, the pieces a stream
 * redactor writes add up to exactly what `redact()` gives for the whole text,
 * however the text is cut into chunks, as long as the text stays inside what
 * the redactor holds for: a run of token characters or a match of at most
 * 1 MiB, a pattern in several parts that began within 256 characters of where
 * the text ends, and a key block of at most 64 KiB whose BEGIN line is
 * followed by key material only. In particular no 12 characters of a secret
 * are written that one-piece redaction would have removed.
 *
 * Randomized, with a fixed seed so a run repeats: texts are put together
 * from whole secrets, beginnings and ends of secrets, and filler chosen to
 * sit badly (markers as input, loose BEGIN and END lines, pattern leads,
 * punctuation, injected values that are PEM keys), then cut at random places.
 * A text in which a BEGIN line is followed by something that is not key
 * material and by an END line later is outside the claim (the stream does
 * not wait for such a block) and is counted, not compared. One targeted row
 * per input class that was found to differ, rows that fail on time, and an
 * `it.fails` row for each thing outside the claim.
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

/** Injected values that are PEM keys: their BEGIN and END lines are gone before the key pattern is applied. */
const PEM_VALUES = [
  `-----BEGIN PRIVATE KEY-----\n${'INJ0Qm9keUxpbmVPZkFLZXk'.repeat(2)}\n${'INJ1Qm9keUxpbmVPZkFLZXk'.repeat(2)}\n-----END PRIVATE KEY-----`,
  `-----BEGIN OPENSSH PRIVATE KEY-----\n${'SSH0Qm9keUxpbmVPZkFLZXk'.repeat(3)}\n-----END OPENSSH PRIVATE KEY-----\n`,
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
  'AIza' + 'SyA-abcdefghijklmnopqrstuvwxyz01234', // made up; in two parts, as above
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
  /** Injected values that are PEM keys as well. */
  pemValues: boolean;
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

const KEY_KIND = '(?:RSA |OPENSSH |EC |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?';
const BEGIN_LINE = new RegExp(`-----BEGIN ${KEY_KIND}-----`, 'g');
const END_LINE = new RegExp(`-----END ${KEY_KIND}-----`);

/**
 * Whether the text has a block the stream does not wait for: a BEGIN line,
 * an END line somewhere after it, and between the two anything but lines of
 * base64. Written here on its own, not taken from the redactor. Asked of the
 * text with each injected value replaced by one character that stands for
 * its marker: that is the text the key pattern is applied to, and a marker
 * the redactor put there is not the same as marker-shaped text that was in
 * the input, which arrives a few characters at a time like anything else.
 */
function hasBlockThatIsNotKeyMaterial(text: string, values: readonly string[]): boolean {
  let staged = text;
  for (const value of values) staged = staged.split(value).join('\uE000');
  for (const begin of staged.matchAll(BEGIN_LINE)) {
    const rest = staged.slice(begin.index + begin[0].length);
    const end = rest.search(END_LINE);
    if (end >= 0 && !/^\n(?:[A-Za-z0-9+/=\uE000]*\n)*$/.test(rest.slice(0, end))) return true;
  }
  return false;
}

/** The seed the suite runs with. Another can be tried by hand: REDACTOR_FUZZ_SEED=7 npx vitest run test/unit/redactor-stream-fuzz.test.ts */
const SEED = Number(process.env.REDACTOR_FUZZ_SEED ?? 20261123);
const base = { keyBlocks: false, looseKeyLines: false, sep: false, awkward: false, pemValues: false, long: 0, chunk: 60, rounds: 3000 };

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
  ['injected values that are PEM keys, among whole key blocks; separated', { ...base, keyBlocks: true, pemValues: true, sep: true }],
  ['injected values that are PEM keys, with loose BEGIN and END lines and blocks cut short; joined directly', { ...base, keyBlocks: true, looseKeyLines: true, pemValues: true }],
  ['injected values that are PEM keys, with loose BEGIN and END lines and blocks cut short; separated', { ...base, keyBlocks: true, looseKeyLines: true, pemValues: true, sep: true }],
];

/** How many of each class's texts are inside the claim, pinned so the table cannot empty out unnoticed. */
const LEAST_COMPARED = 0.5;

describe('stream redactor, randomized: what is written is what one-piece redaction gives', () => {
  it.each(CLASSES)('%s', (_name, shape) => {
    const rnd = mulberry32(SEED);
    const pool = [...VALUES, ...(shape.awkward ? AWKWARD_VALUES : []), ...(shape.pemValues ? PEM_VALUES : [])];
    let differ = 0;
    let leaks = 0;
    let compared = 0;
    const examples: string[] = [];
    for (let round = 0; round < shape.rounds; round++) {
      const values = pool.filter(() => rnd() < 0.5);
      const patterns = [...buildValuePatterns(values), ...BUILTIN_PATTERNS];
      const text = buildText(rnd, shape, values.length > 0 ? values : pool);
      const expected = redact(text, patterns).output;
      const chunks = cuts(text, rnd, shape.chunk);
      const out = stream(chunks, patterns, values, rnd() < 0.8);
      if (hasBlockThatIsNotKeyMaterial(text, values)) continue;
      compared++;
      if (out !== expected) {
        differ++;
        const piece = leaked(out, expected, [...values, ...TOKENS, ...KEY_BLOCKS, ...SPREAD_TOKENS, ...PEM_VALUES]);
        if (piece) leaks++;
        if (examples.length < 3 && text.length < 1500) examples.push(JSON.stringify({ piece, values, chunks, expected, out }).slice(0, 2500));
      }
    }
    console.log(`${_name}: ${compared} of ${shape.rounds} texts compared, ${differ} differ, ${leaks} leak`);
    expect({ differ, leaks, examples }).toEqual({ differ: 0, leaks: 0, examples: [] });
    expect(compared).toBeGreaterThan(shape.rounds * LEAST_COMPARED);
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

  describe('key blocks', () => {
    const lines = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(4, '0')}${'Qm9keUxpbmVPZkFLZXk'.repeat(3)}`).join('\n');
    const STRAY = 'error: expected -----BEGIN PRIVATE KEY----- header\n';
    const LOG = 'ordinary log line, nothing to see here\n';
    const written = (out: string, tag: string) => (out.match(new RegExp(`${tag}\\d{4}Qm9k`, 'g')) ?? []).length;

    it('a key that begins 62 KiB after a BEGIN line that was only mentioned is not written, fed a line at a time', () => {
      const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines(40, 'REAL')}\n-----END OPENSSH PRIVATE KEY-----\n`;
      const { out } = run((STRAY + LOG.repeat(1640) + key).split(/(?<=\n)/));
      expect(written(out, 'REAL')).toBe(0);
      expect(out.endsWith(`${LOG}[REDACTED:private-key]\n`)).toBe(true);
    });

    it('the same with the mention, 70 KiB of output and the start of the key in one chunk', () => {
      const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines(3, 'REAL')}\n-----END OPENSSH PRIVATE KEY-----\n`;
      const at = key.indexOf('REAL0002');
      const { out } = run([STRAY + LOG.repeat(1800) + key.slice(0, at), key.slice(at)]);
      expect(written(out, 'REAL')).toBe(0);
    });

    it('a key that begins after a key block that outgrew the holdback and never ended is not written', () => {
      // The first block is real key material for more than 64 KiB, so it is let go; the second is still held.
      const first = `-----BEGIN PRIVATE KEY-----\n${lines(1200, 'OLD')}\n`;
      const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines(40, 'REAL')}\n-----END OPENSSH PRIVATE KEY-----\n`;
      const text = `${first}${key}`;
      for (const chunks of [text.split(/(?<=\n)/), [text.slice(0, first.length + 200), text.slice(first.length + 200)]]) {
        expect(written(run(chunks).out, 'REAL')).toBe(0);
      }
    });

    it('an injected value that is a PEM key, printed inside another key block that is still open: equal to one piece', () => {
      const injected = `-----BEGIN PRIVATE KEY-----\n${lines(3, 'INJ')}\n-----END PRIVATE KEY-----`;
      const whole = `-----BEGIN RSA PRIVATE KEY-----\n${lines(2, 'OTH')}\n${injected}\n${lines(1, 'OTH')}\n-----END RSA PRIVATE KEY-----\n`;
      for (let cut = 1; cut < whole.length; cut += 7) {
        const { out, expected } = run([whole.slice(0, cut), whole.slice(cut)], [injected]);
        expect(expected).toBe('[REDACTED:private-key]\n');
        expect(out, `cut at ${cut}`).toBe(expected);
      }
    });

    it('an injected value that is a PEM key, on its own and after a mention of a BEGIN line: its END line closes nothing else', () => {
      const injected = `-----BEGIN PRIVATE KEY-----\n${lines(3, 'INJ')}\n-----END PRIVATE KEY-----`;
      const key = `-----BEGIN RSA PRIVATE KEY-----\n${lines(4, 'REAL')}\n-----END RSA PRIVATE KEY-----\n`;
      const whole = `key: ${injected}\n${key.slice(0, 200)}`;
      const { out, expected } = run([whole, key.slice(200)], [injected]);
      expect(expected).toBe('key: [REDACTED:injected-value]\n[REDACTED:private-key]\n');
      expect(out).toBe(expected);
    });

    it('a key printed inside a JSON string, its line breaks written as \\n, cut anywhere', () => {
      const text = `{"key":"-----BEGIN PRIVATE KEY-----\\n${lines(90, 'JSN').replaceAll('\n', '\\n')}\\n-----END PRIVATE KEY-----\\n"}\n`;
      expect(text.length).toBeGreaterThan(4096);
      for (let cut = 1; cut < text.length; cut += 97) {
        const { out, expected } = run([text.slice(0, cut), text.slice(cut)]);
        expect(expected).toBe('{"key":"[REDACTED:private-key]\\n"}\n');
        expect(out, `cut at ${cut}`).toBe(expected);
      }
    });

    it('a key with PEM header lines (Proc-Type, DEK-Info) and CRLF line ends is held to its END line', () => {
      const text = `-----BEGIN RSA PRIVATE KEY-----\r\nProc-Type: 4,ENCRYPTED\r\nDEK-Info: AES-256-CBC,0123456789ABCDEF\r\n\r\n${lines(6, 'HDR').replaceAll('\n', '\r\n')}\r\n-----END RSA PRIVATE KEY-----\r\n`;
      const { out, expected } = run(text.split(/(?<=\n)/));
      expect(expected).toBe('[REDACTED:private-key]\r\n');
      expect(out).toBe(expected);
    });

    it('a key with CRLF line ends, cut at every position, also between the two halves of a line end', () => {
      const text = `x\r\n-----BEGIN EC PRIVATE KEY BLOCK-----\r\n${lines(4, 'CRL').replaceAll('\n', '\r\n')}\r\n-----END EC PRIVATE KEY BLOCK-----\r\ny\r\n`;
      for (let cut = 1; cut < text.length; cut++) {
        const { out, expected } = run([text.slice(0, cut), text.slice(cut)]);
        expect(expected).toBe('x\r\n[REDACTED:private-key]\r\ny\r\n');
        expect(out, `cut at ${cut}`).toBe(expected);
      }
    });

    it('a reply that mentions a BEGIN line in a sentence or a JSON string is written when it is produced, and so are the replies after it', () => {
      const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
      const replies = [
        '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"file starts with -----BEGIN PRIVATE KEY----- but is truncated"}]}}\n',
        '{"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n',
        '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"-----BEGIN PRIVATE KEY-----"}]}}\n',
        '{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"the header is -----BEGIN OPENSSH PRIVATE KEY-----\\nand then base64"}]}}\n',
        'error: expected -----BEGIN PRIVATE KEY----- header\n',
        '{"jsonrpc":"2.0","id":5,"result":{"ok":true}}\n',
      ];
      expect(replies.map((reply) => r.push(reply))).toEqual(replies);
    });

    it('a line that is nothing but a BEGIN line waits for one more line, and is written with it when that is not key material', () => {
      const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
      expect(r.push('-----BEGIN PRIVATE KEY-----\n')).toBe('');
      expect(r.push('(this file is a template)\n')).toBe('-----BEGIN PRIVATE KEY-----\n(this file is a template)\n');
    });
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

  it('a bearer token that an earlier pattern matches for a while as it arrives, after a header name that gets its word boundary from a value', () => {
    // Shaped like a Stripe key while it is 24 to 99 characters long, and too long for one in the end.
    const value = 'value-ending-in-a-word-character';
    const token = 'sk_' + 'test_' + 'Ab1'.repeat(40);
    const text = `${value}authorization:\tBearer\r\n${token} end\n`;
    const { out, expected } = run([...text], [value]);
    expect(expected).toBe('[REDACTED:injected-value][REDACTED:bearer-token] end\n');
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

  it('a line longer than the line holdback is not cut between the two halves of a character outside the BMP', () => {
    const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
    const text = `${'😀'.repeat(4000)}x${'😀'.repeat(1000)}`;
    const pieces = [r.push(text.slice(0, 9001)), r.push(text.slice(9001)), r.end()];
    for (const piece of pieces) {
      expect(/[\uD800-\uDBFF]$/.test(piece)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(piece)).toBe(false);
    }
    expect(pieces.join('')).toBe(text);
  });

  describe('time: what is held is not read again and again', () => {
    /** Push `chunks`; the slowest push and the whole run in milliseconds, and how much was written before the end. */
    const timed = (chunks: Iterable<string>) => {
      const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
      let slowest = 0;
      let written = 0;
      let fed = 0;
      const started = performance.now();
      for (const chunk of chunks) {
        const t = performance.now();
        written += r.push(chunk).length;
        slowest = Math.max(slowest, performance.now() - t);
        fed += chunk.length;
      }
      return { slowest, total: performance.now() - started, written, fed };
    };
    const pieces = function* (text: string, size: number) {
      for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
    };

    const leadLines: Array<[string, string]> = [
      ['a header name', 'authorization\n'],
      ['a header name and its scheme', 'Authorization: Bearer\n'],
      ['a variable name', 'aws_secret_access_key\n'],
      ['a BEGIN line', '-----BEGIN PRIVATE KEY-----\n'],
    ];
    for (const [name, line] of leadLines) {
      it(`640 KiB of lines that are each ${name}, in 64 KiB chunks: under a second a push, and written, not held`, () => {
        const text = line.repeat(Math.ceil((640 * 1024) / line.length));
        const { slowest, written, fed } = timed(pieces(text, 65536));
        expect(slowest).toBeLessThan(1000);
        // All but the last line, which could still be followed by its value.
        expect(fed - written).toBeLessThanOrEqual(line.length);
      });

      it(`the same lines one per push, 64 KiB of them: written as they come`, () => {
        const count = Math.ceil(65536 / line.length);
        const { total, written, fed } = timed(Array.from({ length: count }, () => line));
        expect(total).toBeLessThan(5000);
        expect(fed - written).toBeLessThanOrEqual(line.length);
      });
    }

    const tokenRuns: Array<[number, number]> = [[4096, 4], [512, 2], [16, 0.25]];
    for (const [size, mib] of tokenRuns) {
      it(`a run of token characters with no line break, ${mib} MiB in ${size}-character pushes: at least 1 MiB a second`, () => {
        const text = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo'.repeat(Math.ceil((mib * 1048576) / 35));
        const { total, fed } = timed(pieces(text, size));
        expect(fed / 1048576 / (total / 1000)).toBeGreaterThan(1);
      }, 60_000);
    }

    it('a line that never ends and is redrawn with carriage returns, in 40-character pushes: at least 1 MiB a second', () => {
      const text = '\rdownloading 37% [=======>           ] '.repeat(5000);
      const { total, fed } = timed(pieces(text, 40));
      expect(fed / 1048576 / (total / 1000)).toBeGreaterThan(1);
    });

    it('a 60 KiB key block a line per push: held to its END line without being read again for every line', () => {
      const line = `${'Qm9keUxpbmVPZkFLZXk'.repeat(3)}ABCDEFG=\n`;
      const chunks = ['-----BEGIN PRIVATE KEY-----\n', ...Array.from({ length: 920 }, () => line), '-----END PRIVATE KEY-----\n'];
      const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
      const started = performance.now();
      const out = chunks.map((c) => r.push(c)).join('') + r.end();
      expect(out).toBe('[REDACTED:private-key]\n');
      expect(performance.now() - started).toBeLessThan(500);
    });
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

    it.fails('LIMIT: a BEGIN line followed by text that is not key material is not waited for: with an END line later, one-piece redaction takes everything between as one block and the stream writes it', () => {
      const { out, expected } = run([
        '-----BEGIN RSA PRIVATE KEY-----\n',
        '# exported by a tool that adds a comment line\n',
        'MIIEowIBAAKCAQEAxyzxyzxyzxyzxyzxyz\n',
        '-----END RSA PRIVATE KEY-----\n',
      ]);
      expect(expected).toBe('[REDACTED:private-key]\n');
      expect(out).toBe(expected);
    });

    it.fails('LIMIT: BEGIN lines with one key line after each and no END line, a line per push, are read again on every push: slower than 0.1 MiB a second', () => {
      const line = `${'Qm9keUxpbmVPZkFLZXk'.repeat(3)}ABCDEFG=\n`;
      const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
      let fed = 0;
      const started = performance.now();
      for (let i = 0; i < 2400; i++) {
        const chunk = i % 2 ? line : '-----BEGIN PRIVATE KEY-----\n';
        r.push(chunk);
        fed += chunk.length;
      }
      expect(fed / 1048576 / ((performance.now() - started) / 1000)).toBeGreaterThan(0.1);
    }, 120_000);

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
