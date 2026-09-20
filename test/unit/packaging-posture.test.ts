/**
 * Packaging-posture regression guards (v0.14.1+).
 *
 * A consumer's `npm audit` of our published tarball is a security signal about
 * a credential proxy — it is what flipped the ClawHub scan of aquaman-plugin
 * 0.14.0 to `suspicious`. These tests pin the packaging decisions that keep
 * that audit clean, because every one of them fails silently: nothing breaks
 * locally, the damage only shows up in someone else's install.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

describe('aquaman-proxy dependency surface', () => {
  const proxyPkg = readJson('packages/proxy/package.json');

  // kdbxweb 2.1.1 (latest) requires @xmldom/xmldom ^0.7.4, whose 0.7.x line has
  // no fixed release (5 high advisories). The repo-root `overrides` pin to
  // 0.8.15 protects THIS tree only — overrides are not published — so as a
  // regular dependency it shipped a vulnerable resolution to every consumer.
  // optionalDependencies would not help: npm installs those by default.
  // Optional peers are the only form npm skips.
  it.each(['kdbxweb', 'argon2'])('declares %s as an optional peer, not a dependency', (dep) => {
    expect(proxyPkg.dependencies?.[dep]).toBeUndefined();
    expect(proxyPkg.optionalDependencies?.[dep]).toBeUndefined();
    expect(proxyPkg.peerDependencies?.[dep]).toBeDefined();
    expect(proxyPkg.peerDependenciesMeta?.[dep]?.optional).toBe(true);
  });

  it('keeps the KeePassXC backend imports lazy so a missing peer is a runtime error, not a boot crash', () => {
    const backend = fs.readFileSync(
      path.join(ROOT, 'packages/proxy/src/core/credentials/backends/keepassxc.ts'),
      'utf8'
    );
    expect(backend).toMatch(/await import\('kdbxweb'\)/);
    expect(backend).toMatch(/await import\('argon2'\)/);
    // Static imports of either would defeat the optional-peer split.
    expect(backend).not.toMatch(/^import .*from '(kdbxweb|argon2)'/m);
    // The failure path must stay actionable — it is the only install docs a
    // user hits at the moment the peer is missing.
    expect(backend).toMatch(/npm install kdbxweb argon2/);
  });
});

describe('aquaman-plugin dependency surface', () => {
  const pluginPkg = readJson('packages/plugin/package.json');

  // npm >= 7 auto-installs non-optional peers, so a plain `npm i aquaman-plugin`
  // was dragging an ~86 MB copy of the gateway — and its advisories — into
  // consumer trees. The host always provides itself.
  it('declares openclaw as an optional peer', () => {
    expect(pluginPkg.peerDependencies?.openclaw).toBeDefined();
    expect(pluginPkg.peerDependenciesMeta?.openclaw?.optional).toBe(true);
    expect(pluginPkg.dependencies?.openclaw).toBeUndefined();
  });

  // ClawScan flags caret ranges on a credential proxy as a reproducibility
  // risk. Dependabot moves these; humans should not widen them back.
  it.each(['undici', '@sinclair/typebox'])('exact-pins %s', (dep) => {
    expect(pluginPkg.dependencies[dep]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins aquaman-proxy exactly at the workspace version', () => {
    expect(pluginPkg.dependencies['aquaman-proxy']).toBe(pluginPkg.version);
  });
});

describe('lockfile dev scoping', () => {
  const lock = readJson('package-lock.json');

  // The shipped-deps gate is `npm audit --omit=dev --audit-level=high`, which
  // reads the lockfile's dev flags. The gateway used to live here as the e2e
  // harness devDependency; any regeneration without --legacy-peer-deps turned
  // its whole shrinkwrapped subtree into "shipped" and the gate quietly audited
  // the gateway instead of us. v0.15.0 moved the harness out-of-tree (CI
  // installs the pinned gateway globally per lane) — keep it out.
  it('keeps the openclaw gateway out of the lockfile (e2e harness is installed out-of-tree)', () => {
    const openclawEntries = Object.keys(lock.packages ?? {}).filter((k) =>
      /(^|\/)node_modules\/openclaw$/.test(k)
    );
    expect(openclawEntries).toEqual([]);
    expect(readJson('package.json').devDependencies?.openclaw).toBeUndefined();
  });

  // Root .npmrc enforces the same flag CI's `npm ci` passes, so local and
  // Dependabot regenerations don't follow the optional peer edges below.
  it('pins legacy-peer-deps for every lockfile regeneration', () => {
    expect(fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf-8')).toMatch(/^legacy-peer-deps=true$/m);
  });

  it('keeps the KeePassXC peers out of the shipped tree', () => {
    for (const dep of ['node_modules/kdbxweb', 'node_modules/argon2', 'node_modules/@xmldom/xmldom']) {
      const entry = lock.packages[dep];
      if (entry) expect(entry.dev).toBe(true);
    }
  });
});
