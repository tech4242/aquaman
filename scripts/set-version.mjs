#!/usr/bin/env node
/**
 * Set every version field across the monorepo to a single value.
 *
 * Source of truth for a release is the git tag; CD calls this with the tag
 * version so the 9 fields the version-gate checks can never drift out of sync.
 * Also runnable locally before tagging: `npm run set-version 0.13.1`.
 *
 * Uses targeted line replacement (not JSON reformatting) to keep diffs minimal,
 * and fails loudly if any expected field is missing — so a new version field
 * added to the repo without being added here surfaces immediately.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(version)) {
  console.error(`Usage: set-version <version>\nGot: ${JSON.stringify(version)}`);
  process.exit(1);
}

// [file, regex with one capture group for the value, human label]
const edits = [
  ['package.json',                        /^(\s*"version":\s*")[^"]*(",)/m,           'root package.json'],
  ['packages/proxy/package.json',         /^(\s*"version":\s*")[^"]*(",)/m,           'proxy package.json'],
  ['packages/plugin/package.json',        /^(\s*"version":\s*")[^"]*(",)/m,           'plugin package.json'],
  ['packages/coder/package.json',         /^(\s*"version":\s*")[^"]*(",)/m,           'coder package.json'],
  ['packages/plugin/openclaw.plugin.json',/^(\s*"version":\s*")[^"]*(",)/m,           'openclaw.plugin.json'],
  ['packages/plugin/package.json',        /^(\s*"aquaman-proxy":\s*")[^"]*(",?)/m,    'plugin->aquaman-proxy dep'],
  ['packages/coder/package.json',         /^(\s*"aquaman-proxy":\s*")[^"]*(",?)/m,    'coder->aquaman-proxy dep'],
  ['packages/hermes/pyproject.toml',      /^(version\s*=\s*")[^"]*(")/m,              'pyproject.toml'],
  ['packages/hermes/aquaman_hermes/plugin.yaml', /^(version:\s*")[^"]*(")/m,          'hermes plugin.yaml'],
];

let failed = false;
for (const [file, re, label] of edits) {
  const before = readFileSync(file, 'utf-8');
  const after = before.replace(re, `$1${version}$2`);
  if (after === before && !re.test(before)) {
    console.error(`✗ ${label}: pattern not found in ${file}`);
    failed = true;
    continue;
  }
  writeFileSync(file, after);
  console.log(`✓ ${label} = ${version}`);
}
if (failed) { console.error('\nOne or more version fields could not be set — aborting.'); process.exit(1); }
console.log(`\nAll version fields set to ${version}.`);
