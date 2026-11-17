#!/usr/bin/env node
/**
 * Coverage for everything that ships, including code that only runs in the
 * processes the tests start.
 *
 * Vitest measures the test process. A large part of the suite starts the real
 * CLI, daemon or hook as a child process, and those lines never show up
 * there. This script:
 *
 *   1. runs the suite with Vitest's coverage, telling children to write their
 *      own V8 coverage (test/helpers/child-coverage.ts);
 *   2. converts the children's data with c8, mapped back to the TypeScript;
 *   3. merges both by line: a line counts as covered if either saw it run.
 *
 * Line coverage is the merged figure and the one the floors apply to. Branch
 * and function figures are Vitest's alone, so they understate code that only
 * children run.
 *
 *   node scripts/coverage.mjs                       run, merge, print, check floors
 *   node scripts/coverage.mjs --merge               merge and print an existing run
 *   node scripts/coverage.mjs --out DIR -- FILES    run only some test files into DIR
 *                                                   (no floors; for working on one area)
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const testFiles = split === -1 ? [] : argv.slice(split + 1);
const outFlag = argv.indexOf('--out');
const OUT = path.resolve(ROOT, outFlag === -1 ? 'coverage' : argv[outFlag + 1]);
const partial = testFiles.length > 0;
const RAW = path.join(OUT, 'children-raw');
const CHILDREN = path.join(OUT, 'children');
const mergeOnly = argv.includes('--merge');

/** Lowest acceptable merged line coverage, in percent. Raise these as coverage rises; never lower them. */
const FLOORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/coverage-floors.json'), 'utf-8'));

function run(cmd, args, env = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } }).status ?? 1;
}

let testStatus = 0;
if (!mergeOnly) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  testStatus = run('npx', ['vitest', 'run', '--coverage', `--coverage.reportsDirectory=${OUT}`, ...testFiles], { AQUAMAN_CHILD_COVERAGE_DIR: RAW });
  run('npx', [
    'c8', 'report',
    '--temp-directory', RAW,
    '--reports-dir', CHILDREN,
    '--reporter', 'json',
    '--exclude-after-remap',
    '--include', 'packages/*/src/**/*.ts',
    '--include', 'packages/plugin/index.ts',
  ]);
}

/** Line number -> times run, from one file's istanbul record. */
function lines(record) {
  const hits = new Map();
  for (const [id, loc] of Object.entries(record.statementMap ?? {})) {
    const line = loc.start.line;
    hits.set(line, Math.max(hits.get(line) ?? 0, record.s[id] ?? 0));
  }
  return hits;
}

function load(file) {
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const out = {};
  for (const [name, record] of Object.entries(data)) out[path.relative(ROOT, name)] = lines(record);
  return out;
}

const own = load(path.join(OUT, 'coverage-final.json'));
const children = load(path.join(CHILDREN, 'coverage-final.json'));
if (Object.keys(own).length === 0) {
  console.error('No coverage data in coverage/coverage-final.json.');
  process.exit(1);
}

// The file list and what counts as a line come from Vitest's report, which
// applies the include and exclude rules. Children only add hits.
const files = {};
for (const [name, ownLines] of Object.entries(own)) {
  const extra = children[name] ?? new Map();
  let total = 0, covered = 0, onlyChildren = 0;
  const missed = [];
  for (const [line, count] of ownLines) {
    total++;
    const childCount = extra.get(line) ?? 0;
    if (count > 0 || childCount > 0) covered++; else missed.push(line);
    if (count === 0 && childCount > 0) onlyChildren++;
  }
  files[name] = { total, covered, onlyChildren, ownCovered: [...ownLines.values()].filter((c) => c > 0).length, missed };
}

const group = (name) => name.split('/').slice(0, 2).join('/');
const sum = (rows) => rows.reduce((a, r) => ({ total: a.total + r.total, covered: a.covered + r.covered, ownCovered: a.ownCovered + r.ownCovered }), { total: 0, covered: 0, ownCovered: 0 });
const pct = (covered, total) => (total === 0 ? 100 : (covered / total) * 100);
const fmt = (n) => n.toFixed(1).padStart(5);

const groups = {};
for (const [name, row] of Object.entries(files)) (groups[group(name)] ??= []).push({ name, ...row });

console.log('\nLine coverage, test process and child processes merged\n');
console.log('  merged  alone   lines  file');
for (const [g, rows] of Object.entries(groups).sort()) {
  const t = sum(rows);
  console.log(`\n  ${fmt(pct(t.covered, t.total))}%  ${fmt(pct(t.ownCovered, t.total))}%  ${String(t.total).padStart(5)}  ${g}/`);
  for (const r of rows.sort((a, b) => (b.total - b.covered) - (a.total - a.covered))) {
    if (r.total === 0) continue;
    console.log(`  ${fmt(pct(r.covered, r.total))}%  ${fmt(pct(r.ownCovered, r.total))}%  ${String(r.total).padStart(5)}    ${r.name.split('/').slice(2).join('/')}  (${r.total - r.covered} missed)`);
  }
}
const all = sum(Object.values(files));
console.log(`\n  ${fmt(pct(all.covered, all.total))}%  ${fmt(pct(all.ownCovered, all.total))}%  ${String(all.total).padStart(5)}  all files\n`);

fs.writeFileSync(
  path.join(OUT, 'merged-summary.json'),
  JSON.stringify({
    total: { lines: all.total, covered: all.covered, pct: pct(all.covered, all.total) },
    files: Object.fromEntries(Object.entries(files).map(([n, r]) => [n, { lines: r.total, covered: r.covered, pct: pct(r.covered, r.total), missed: r.missed }])),
  }, null, 2),
);

// An lcov file with the merged line data, for services that read lcov.
const lcov = [];
for (const [name, ownLines] of Object.entries(own)) {
  const extra = children[name] ?? new Map();
  lcov.push(`SF:${name}`);
  for (const [line, count] of [...ownLines].sort((a, b) => a[0] - b[0])) lcov.push(`DA:${line},${Math.max(count, extra.get(line) ?? 0)}`);
  lcov.push(`LF:${files[name].total}`, `LH:${files[name].covered}`, 'end_of_record');
}
fs.writeFileSync(path.join(OUT, 'merged.lcov'), lcov.join('\n') + '\n');

let failed = false;
for (const [prefix, floor] of partial ? [] : Object.entries(FLOORS)) {
  const rows = prefix === 'all' ? Object.values(files) : Object.entries(files).filter(([n]) => n === prefix || n.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)).map(([, r]) => r);
  if (rows.length === 0) { console.error(`floor for ${prefix}: no such file`); failed = true; continue; }
  const t = sum(rows);
  const got = pct(t.covered, t.total);
  if (got + 1e-9 < floor) { console.error(`below floor: ${prefix} is ${got.toFixed(1)}%, floor ${floor}%`); failed = true; }
}
if (failed) process.exit(1);
process.exit(testStatus);
