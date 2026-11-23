/**
 * A key block whose BEGIN line ends in spaces or tabs, and one with an armor
 * header that has nothing after its colon, cut in two at every position and
 * compared with one-piece `redact()`.
 */
import { describe, it, expect } from 'vitest';
import { redact, BUILTIN_PATTERNS, createStreamRedactor } from 'aquaman-core';

const body = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${String(i).padStart(4, '0')}${'Qm9keUxpbmVPZkFLZXk'.repeat(3)}`);

const CASES: Array<[string, string, string]> = [
  // Every line padded, the BEGIN line included (a key printed in a fixed-width column).
  ['BEGIN line that ends in spaces', 'BTS', `-----BEGIN PRIVATE KEY-----  \n${body(4, 'BTS').map((l) => `${l}  `).join('\n')}\n-----END PRIVATE KEY-----  \n`],
  // A header line that is complete and has nothing after its colon.
  ['armor header with an empty value', 'PGE', `-----BEGIN PGP PRIVATE KEY BLOCK-----\nComment:\n\n${body(3, 'PGE').join('\n')}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----\n`],
];

describe('padded and empty-header key blocks cut at every position', () => {
  for (const [name, tag, text] of CASES) {
    it(name, () => {
      let leaks = 0;
      let first = '';
      for (let cut = 1; cut < text.length; cut++) {
        const r = createStreamRedactor(BUILTIN_PATTERNS, 0, []);
        const out = r.push(text.slice(0, cut)) + r.push(text.slice(cut)) + r.end();
        if (out === redact(text, BUILTIN_PATTERNS).output) continue;
        if (new RegExp(`${tag}\\d{4}Qm9k`).test(out)) { leaks++; first ||= `first at cut ${cut}`; }
      }
      expect(leaks, first).toBe(0);
    });
  }
});
