/**
 * Docs for earlier releases. The site renders the working tree as the current
 * docs; for every release tag older than that, this copies the tag's `docs/`
 * and `SECURITY.md` out of git into `versioned/<version>/`, where the content
 * collection picks them up. Nothing is stored in the repository twice.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = path.resolve(SITE_DIR, '..');
export const VERSIONED_DIR = path.join(SITE_DIR, 'versioned');

/** The first release whose docs are published here. Earlier tags predate the guides. */
const FIRST = process.env.DOCS_FIRST_VERSION ?? '0.18.1';

const parse = (v) => v.split('.').map((n) => Number(n));
const compare = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, ...opts });
}

const REMOTE = 'https://github.com/tech4242/aquaman.git';

/**
 * A hosted build's checkout may come without release tags (a preview build of
 * a branch, a shallow clone). The version menu and the "unreleased" label are
 * read from tags, and page dates from history, so on a hosted build both are
 * fetched from the public repository first: tags always, and the full history
 * when the checkout is shallow. Failure is not an error; the build then shows
 * whatever the checkout had.
 */
function fetchReleaseTags() {
  if (!process.env.VERCEL && !process.env.DOCS_FETCH_TAGS) return;
  try {
    const shallow = git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true';
    git(['fetch', '--quiet', '--tags', ...(shallow ? ['--unshallow'] : []), REMOTE], { timeout: 120_000 });
  } catch { /* offline, or no git */ }
}

/**
 * Extract the docs of every earlier release and write `versions.json`.
 * Without git (a tarball) there are simply no earlier versions.
 */
export function prepareVersions() {
  const current = JSON.parse(fs.readFileSync(path.join(REPO, 'packages/proxy/package.json'), 'utf-8')).version;
  fetchReleaseTags();
  let tags = [];
  try {
    tags = git(['tag', '--list', 'v*']).toString().split('\n').map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  } catch { /* no git */ }
  const released = tags.includes(`v${current}`);
  const archived = tags
    .map((t) => t.slice(1))
    .filter((v) => compare(v, FIRST) >= 0 && compare(v, current) < 0)
    .sort((a, b) => compare(b, a));

  fs.rmSync(VERSIONED_DIR, { recursive: true, force: true });
  fs.mkdirSync(VERSIONED_DIR, { recursive: true });
  const kept = [];
  for (const version of archived) {
    const dir = path.join(VERSIONED_DIR, version);
    try {
      const present = git(['ls-tree', '--name-only', `v${version}`, 'docs', 'SECURITY.md']).toString().split('\n').filter(Boolean);
      if (present.length === 0) continue;
      const tar = git(['archive', '--format=tar', `v${version}`, ...present]);
      fs.mkdirSync(dir, { recursive: true });
      execFileSync('tar', ['-x', '-C', dir], { input: tar, stdio: ['pipe', 'ignore', 'ignore'] });
      kept.push(version);
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const versions = { current, released, archived: kept };
  fs.writeFileSync(path.join(VERSIONED_DIR, 'versions.json'), JSON.stringify(versions, null, 2));
  return versions;
}
