# aquaman website

The site renders the repository's own Markdown (`../docs`, `../SECURITY.md`); nothing is copied. The home page is `src/pages/index.astro`: short and visual, for a person. Its Markdown version, `/index.md`, is the long form for agents and is built from `src/home.md`, the host list in `src/lib/hosts.ts`, and `src/home-more.md`; keep the facts in the two in step.

```bash
cd website
npm install
npm run dev        # http://localhost:4399, live reload; no sitemap in this mode
npm run build && npx astro preview   # the built site, as it will be served
SITE_URL=https://example.org npm run build
```

It is not an npm workspace of the repository and has its own lockfile, so it never changes what the published packages depend on.

Every page is also served as Markdown at the same path with `.md`, and `/llms.txt`, `/llms-full.txt` and `/AGENTS.md` are generated from the same pages. `SITE_URL` is the public origin; canonical URLs, the sitemap and `llms.txt` are built from it.

## Versions

The working tree is the current docs, at `/docs/`. For each release tag older than the version in `packages/proxy/package.json` (from 0.18.0 on), the build copies that tag's `docs/` and `SECURITY.md` out of git into `versioned/` (ignored) and serves them at `/docs/<version>/`, with a version menu in the sidebar. Those pages name the current page as canonical and stay out of the sitemap and `llms.txt`. The build needs the repository's tags, so CI checks out full history.

## Pixel art

The home page's sprites are text grids in `src/lib/sprites.ts`. Each is built into its own file under `/sprites/` (`src/pages/sprites/[file].svg.ts`) and placed with `src/components/Sprite.astro` as an image, so the page's HTML stays small and readable as text. They are drawn from shapes by `scripts/draw-sprites.py`; change the drawing there and run `python3 scripts/draw-sprites.py` from `website/`.

The GitHub star count in the header is read from the GitHub API once per build (`src/lib/stars.ts`) and left out if the API cannot be reached.

## Share image

`public/og.png` is the picture shown when the site's link is shared. Its source is `scripts/og-image.html`, which uses the built sprites and the installed fonts. After `npm run build`, render it at 1200 by 630 with headless Chrome:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --hide-scrollbars \
  --window-size=1200,630 --allow-file-access-from-files \
  --screenshot=$PWD/public/og.png file://$PWD/scripts/og-image.html
```

## Deploying

The site is hosted on Vercel and deployed by `.github/workflows/website.yml`, not by Vercel's Git integration (`vercel.json` turns that off). The workflow deploys when a GitHub release is published, or when it is run by hand, so the public site describes a version that can be installed.

One-time setup:

1. In Vercel, import this repository as a project with Root Directory `website` and the Astro preset.
2. Create a Vercel token. Run `vercel link` once locally in `website/` and read the org and project ids from `.vercel/project.json`.
3. In the GitHub repository, add the secrets `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, and the variables `SITE_URL` (for example `https://example.org`) and `VERCEL_DEPLOY` = `true`.
4. Add the domain to the Vercel project.

`vercel.json` also sets the character set on the Markdown and text files and a `Link` header on the home page pointing at its Markdown version.
