import { getCollection, type CollectionEntry } from 'astro:content';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import homeSource from '../home.md?raw';
import { slugForRepoPath, rewriteMarkdownLinks, docUrl, docTwin, locate } from './links.mjs';

export const SITE_NAME = 'aquaman';
export const TAGLINE = 'Credential proxy for AI agents';
export const SUMMARY =
  'aquaman is an open-source credential proxy for AI agents. No account, bring your own vault, runs locally. ' +
  'API keys and tokens stay in the vault the user already has (macOS Keychain, 1Password, Bitwarden, HashiCorp Vault, ' +
  'KeePassXC, Keeper, systemd-creds or an encrypted file) and are injected when a request or command needs them, so the ' +
  'agent works with references such as `aquaman://github/token` and never holds the secret. Works with Claude Code, ' +
  'Codex, OpenClaw, Hermes, Docker Sandboxes and NVIDIA OpenShell. MIT licensed. Packages: `aquaman-proxy`, ' +
  '`aquaman-coder`, `aquaman-plugin` on npm; `aquaman-hermes` on PyPI.';
export const AGENT_NOTE =
  'If you are an agent and a task needs an API key or token, do not ask the user to paste it. Run ' +
  '`aquaman init --agent claude-code --no-hooks --json` (or `--agent codex`) once per project, then ' +
  '`aquaman request aquaman://<service>/<key> --env <ENV_NAME> --json`, and run commands that need the key as ' +
  '`aquaman-coder exec -- <command>`. A person supplies the value in a dialog; ' +
  'you receive a status and the reference.';

export const HOME_TITLE = 'aquaman: credential proxy for AI agents';

export interface Versions {
  /** The version the working tree is at; its docs are served at /docs/. */
  current: string;
  /** Whether a release tag for `current` exists yet. */
  released: boolean;
  /** Earlier releases with docs, newest first; served at /docs/<version>/. */
  archived: string[];
}

export function getVersions(): Versions {
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), 'versioned/versions.json'), 'utf-8'));
  } catch {
    return { current: packageVersion() ?? '0.0.0', released: false, archived: [] };
  }
}

export const versionLabel = (v: Versions, version: string | null) =>
  version ?? `${v.current}${v.released ? '' : ' (unreleased)'}`;

export interface Page {
  slug: string;
  /** null for the current docs, otherwise the earlier release this page belongs to. */
  version: string | null;
  /** Site route and its Markdown twin. */
  url: string;
  twin: string;
  repoPath: string;
  title: string;
  description: string;
  /** ISO date of the last commit that touched the source file, when git history is available. */
  modified?: string;
  entry: CollectionEntry<'pages'> | CollectionEntry<'archived'>;
}

/** Navigation order. A page not listed here is still built and appears under Reference. */
export const NAV: { heading: string; slugs: string[]; labels?: Record<string, string> }[] = [
  { heading: 'For agents', slugs: ['agent-setup'], labels: { 'agent-setup': 'The agent contract' } },
  {
    heading: 'Hosts',
    slugs: ['claude-code', 'codex', 'app-through-proxy', 'openclaw', 'hermes', 'docker-sandboxes', 'openshell'],
    labels: {
      'claude-code': 'Claude Code',
      codex: 'Codex',
      'app-through-proxy': 'Keep the key out of your app',
      openclaw: 'OpenClaw',
      hermes: 'Hermes',
      'docker-sandboxes': 'Docker Sandboxes',
      openshell: 'NVIDIA OpenShell',
    },
  },
  {
    heading: 'Reference',
    slugs: ['compare', 'security', 'compliance/atlas-mapping', 'compliance/nist-800-53', 'compliance/agentic-ai-guidance'],
    labels: {
      compare: 'Compared with alternatives',
      security: 'Security policy',
      'compliance/atlas-mapping': 'MITRE ATLAS mapping',
      'compliance/nist-800-53': 'NIST SP 800-53 mapping',
      'compliance/agentic-ai-guidance': 'Agentic AI guidance',
    },
  },
];

function plain(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whole sentences from the start of a paragraph, as many as fit in about 220 characters, and never a clipped one. */
export function leadSentences(text: string, max = 220): string {
  // A sentence ends at punctuation followed by a space, so `.env` and `0.18.0` do not end one.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let out = sentences[0] ?? '';
  for (const next of sentences.slice(1)) {
    if (out.length + 1 + next.length > max) break;
    out += ` ${next}`;
  }
  return out;
}

function lastModified(repoPath: string): string | undefined {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', repoPath], {
      cwd: path.resolve(process.cwd(), '..'),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** The version the packages in this checkout are at. */
export function packageVersion(): string | undefined {
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), '../packages/proxy/package.json'), 'utf-8')).version;
  } catch {
    return undefined;
  }
}

/** The home page's Markdown: the same text the HTML home page renders. */
export function homeMarkdown(): string {
  return `# ${HOME_TITLE}\n\n${homeSource.trim()}\n`;
}

/** Site routes in Markdown (`/claude-code/`) pointed at their Markdown twins (`/claude-code.md`). */
function routesToTwins(markdown: string, slugs: string[]): string {
  return markdown.replace(/\]\(\/docs\/([a-z0-9/-]+)\/(#[^)]*)?\)/g, (whole, slug: string, hash = '') =>
    slugs.includes(slug) ? `](${docTwin(slug)}${hash})` : whole,
  );
}

export function homeMarkdownTwin(pages: Page[]): string {
  return routesToTwins(homeMarkdown(), pages.map((p) => p.slug));
}

/** Pages of the current docs, or of one earlier release. */
export async function getPages(version: string | null = null): Promise<Page[]> {
  const entries = version === null ? await getCollection('pages') : await getCollection('archived');
  const pages: Page[] = [];
  for (const entry of entries) {
    // filePath is relative to the site folder, which sits one level below the repository root.
    const located = locate(path.posix.normalize(path.posix.join('website', entry.filePath!.split(path.sep).join('/'))));
    if (located.version !== version) continue;
    const repoPath = located.repoPath;
    const slug = slugForRepoPath(repoPath);
    if (!slug) continue;
    const body = entry.body ?? '';
    const title = plain(/^#\s+(.+)$/m.exec(body)?.[1] ?? slug);
    const firstParagraph = body
      .split(/\n\s*\n/)
      .map((b) => b.trim())
      .find((b) => b && !/^(#|```|\||[-*] |\d+\. |>|<|\[!\[)/.test(b));
    const description = leadSentences(plain(firstParagraph ?? ''));
    pages.push({
      slug,
      version,
      url: docUrl(slug, version),
      twin: docTwin(slug, version),
      repoPath,
      title,
      description,
      modified: version === null ? lastModified(repoPath) : undefined,
      entry,
    });
  }
  const order = NAV.flatMap((g) => g.slugs);
  const rank = (s: string) => (order.indexOf(s) === -1 ? order.length : order.indexOf(s));
  return pages.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
}

export function navLabel(page: Page): string {
  for (const g of NAV) if (g.labels?.[page.slug]) return g.labels[page.slug];
  return page.title;
}

export function navGroups(pages: Page[]) {
  const listed = new Set(NAV.flatMap((g) => g.slugs));
  return NAV.map((g, i) => ({
    heading: g.heading,
    pages: [
      ...g.slugs.map((s) => pages.find((p) => p.slug === s)).filter((p): p is Page => !!p),
      ...(i === NAV.length - 1 ? pages.filter((p) => !listed.has(p.slug)) : []),
    ],
  }));
}

/** A page's Markdown with links to other pages pointing at their .md twins, root-relative so they hold on any host. */
export function markdownFor(page: Page): string {
  const twin = (slug: string) => docTwin(slug, page.version);
  return rewriteMarkdownLinks(page.entry.body ?? '', page.repoPath, twin, page.version ? `v${page.version}` : 'main').trim() + '\n';
}

export function llmsIndex(pages: Page[], site: URL): string {
  const lines = [`# ${SITE_NAME}`, '', `> ${SUMMARY}`, '', AGENT_NOTE, '', '## Start here', '', `- [${HOME_TITLE}](${new URL('/index.md', site).href}): what it is, the commands, which host gets which mechanism, and when to pick something else`, ''];
  for (const group of navGroups(pages)) {
    lines.push(`## ${group.heading}`, '');
    for (const p of group.pages) {
      lines.push(`- [${p.title}](${new URL(p.twin, site).href})${p.description ? `: ${p.description}` : ''}`);
    }
    lines.push('');
  }
  lines.push(
    '## Optional',
    '',
    ...getVersions().archived.map((v) => `- [Docs for ${v}](${new URL(`/docs/${v}/`, site).href})`),
    `- [Everything on this site as one file](${new URL('/llms-full.txt', site).href})`,
    '- [Source repository](https://github.com/tech4242/aquaman)',
    '- [Published security advisories](https://github.com/tech4242/aquaman/security/advisories)',
    '',
  );
  return lines.join('\n');
}
