/**
 * A private key block is redacted wherever the stream is cut: after the colon
 * of a PEM or PGP header line, and after the backslash of a line break written
 * as an escape in a JSON string. Every two-piece cut of each text is compared
 * with redacting it in one piece.
 */
import { describe, it, expect } from 'vitest';
import { redact, BUILTIN_PATTERNS, createStreamRedactor } from 'aquaman-core';

const body = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(4, '0')}${'Qm9keUxpbmVPZkFLZXk'.repeat(3)}`);

function run(chunks: string[]) {
  const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
  const out = chunks.map((c) => r.push(c)).join('') + r.end();
  return { out, expected: redact(chunks.join(''), BUILTIN_PATTERNS).output };
}

const CASES: Array<[string, string, string]> = [
  ['Proc-Type headers LF', 'HDR', `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0123456789ABCDEF\n\n${body(4, 'HDR').join('\n')}\n-----END RSA PRIVATE KEY-----\n`],
  ['PGP armor', 'PGP', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\nComment: made up\n\n${body(4, 'PGP').join('\n')}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----\n`],
  ['JSON escaped long line', 'JSL', `{"pad":"${'word '.repeat(900)}","key":"-----BEGIN PRIVATE KEY-----\\n${body(80, 'JSL').join('\\n')}\\n-----END PRIVATE KEY-----\\n"}\n`],
  ['indented, as in a YAML block scalar', 'YML', `tls:\n  key: |\n    -----BEGIN PRIVATE KEY-----\n${body(6, 'YML').map((l) => `    ${l}`).join('\n')}\n    -----END PRIVATE KEY-----\n  cert: none\n`],
  ['body lines with trailing spaces and a tab', 'TRL', `-----BEGIN EC PRIVATE KEY-----\n${body(5, 'TRL').map((l, i) => l + (i % 2 ? '  ' : '\t')).join('\n')}\n-----END EC PRIVATE KEY-----\n`],
  ['JSON escaped long line, key first', 'JSK', `{"key":"-----BEGIN PRIVATE KEY-----\\n${body(80, 'JSK').join('\\n')}\\n-----END PRIVATE KEY-----\\n","pad":"x"}\n`],
];

describe('a key block cut at every position', () => {
  for (const [name, tag, text] of CASES) {
    it(name, () => {
      const rows: string[] = [];
      let leaks = 0;
      // A short text is cut everywhere. A long one is cut at and just after
      // every backslash, where an escaped line break can be split, and at
      // every eleventh position besides: each cut redacts the whole text
      // twice, and ten thousand of them is too slow for one test.
      const everywhere = text.length < 3000;
      for (let cut = 1; cut < text.length; cut++) {
        if (!everywhere && text[cut - 1] !== '\\' && text[cut - 2] !== '\\' && cut % 11 !== 0) continue;
        const { out, expected } = run([text.slice(0, cut), text.slice(cut)]);
        if (out === expected) continue;
        const n = (out.match(new RegExp(`${tag}\\d{4}Qm9k`, 'g')) ?? []).length;
        if (n > 0) leaks++;
        if (rows.length < 12) rows.push(`cut ${cut} after ${JSON.stringify(text.slice(Math.max(0, cut - 14), cut))} | key lines written: ${n}`);
      }
      expect(leaks, rows.join('\n')).toBe(0);
    }, 60_000);
  }
});
