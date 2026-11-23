/**
 * The repository's OpenSSF Scorecard result, read once per build from the
 * project's public API. Pages make no request to it; the number is as fresh
 * as the last deploy. If there is no published result, or the API cannot be
 * reached during the build, the score is left out.
 */
export const SCORECARD_URL = 'https://scorecard.dev/viewer/?uri=github.com/tech4242/aquaman';

let pending: Promise<number | null> | undefined;

export function scorecardScore(): Promise<number | null> {
  pending ??= (async () => {
    try {
      const res = await fetch('https://api.securityscorecards.dev/projects/github.com/tech4242/aquaman', {
        headers: { Accept: 'application/json', 'User-Agent': 'aquaman-website-build' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const score = (await res.json()).score;
      return typeof score === 'number' && score >= 0 && score <= 10 ? score : null;
    } catch {
      return null;
    }
  })();
  return pending;
}
