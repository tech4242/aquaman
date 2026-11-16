# aquaman website

The site renders the repository's own Markdown (`../docs`, `../SECURITY.md`); nothing is copied. The home page text is `src/home.md`.

```bash
cd website
npm install
npm run dev        # http://localhost:4399
SITE_URL=https://example.org npm run build
```

It is not an npm workspace of the repository and has its own lockfile, so it never changes what the published packages depend on.

Every page is also served as Markdown at the same path with `.md`, and `/llms.txt`, `/llms-full.txt` and `/AGENTS.md` are generated from the same pages. `SITE_URL` is the public origin; canonical URLs, the sitemap and `llms.txt` are built from it.
