#!/usr/bin/env node
/**
 * The credential provider image is installed from deploy/substrate/package-lock.json.
 * At release that lockfile is moved to the aquaman-proxy just published, which
 * the committed file cannot name beforehand. This checks that nothing else in
 * it moved to something nobody reviewed:
 *
 *   check-image-lock.mjs <lock before> <lock after> <root package-lock.json> [--local]
 *
 * Every entry of the new lockfile, other than aquaman-proxy itself, has to be
 * the entry the committed lockfile had, or be a package at a version and
 * integrity hash that the repository's own lockfile has (which is reviewed in
 * pull requests and tracked by Dependabot). Anything else fails.
 */
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
// --local: aquaman-proxy is a tarball of this checkout (the CI check before a release), not the registry's.
const local = args.includes('--local');
const [beforePath, afterPath, rootPath] = args.filter((a) => a !== '--local');
if (!beforePath || !afterPath || !rootPath) {
  console.error('Usage: check-image-lock.mjs <lock before> <lock after> <root package-lock.json>');
  process.exit(2);
}
const packages = (file) => JSON.parse(readFileSync(file, 'utf-8')).packages ?? {};
const nameOf = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
const same = (a, b) => a && b && a.version === b.version && a.integrity === b.integrity && a.resolved === b.resolved;

const before = packages(beforePath);
const after = packages(afterPath);
const reviewed = new Set();
for (const [key, entry] of Object.entries(packages(rootPath))) {
  if (key && entry.integrity) reviewed.add(`${nameOf(key)}@${entry.version}#${entry.integrity}`);
}

const problems = [];
for (const [key, entry] of Object.entries(after)) {
  if (key === '' || key === 'node_modules/aquaman-proxy') continue;
  if (same(before[key], entry)) continue;
  if (entry.integrity && reviewed.has(`${nameOf(key)}@${entry.version}#${entry.integrity}`)) continue;
  problems.push(`${key} ${entry.version ?? ''}: not in the committed image lockfile and not in the repository lockfile at this version`);
}
const proxy = after['node_modules/aquaman-proxy'];
if (!local && (!proxy?.integrity || !/^https:\/\/registry\.npmjs\.org\/aquaman-proxy\/-\/aquaman-proxy-[0-9A-Za-z.-]+\.tgz$/.test(proxy.resolved ?? ''))) {
  problems.push('aquaman-proxy is not locked to a tarball of the npm registry with an integrity hash');
}

if (problems.length > 0) {
  console.error('The image lockfile changed in a way that was not reviewed:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Update deploy/substrate/package-lock.json in a pull request, then release again.');
  process.exit(1);
}
console.log(`image lockfile: ${Object.keys(after).length - 1} entries, aquaman-proxy ${proxy?.version}; nothing else moved outside what is reviewed`);
