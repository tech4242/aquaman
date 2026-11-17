/**
 * The repository's star count, read once per build, so the page shows a
 * number without waiting. A small script in the layout then replaces it with
 * the live count. If GitHub cannot be reached the count is left out.
 */
let pending: Promise<number | null> | undefined;

export function githubStars(): Promise<number | null> {
  pending ??= (async () => {
    try {
      const res = await fetch('https://api.github.com/repos/tech4242/aquaman', {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'aquaman-website-build' },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return null;
      const count = (await res.json()).stargazers_count;
      return typeof count === 'number' ? count : null;
    } catch {
      return null;
    }
  })();
  return pending;
}

export const formatStars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
