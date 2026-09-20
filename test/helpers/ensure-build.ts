/**
 * Vitest globalSetup: make sure the workspace dist builds exist.
 *
 * Several e2e tests spawn a CLI from SOURCE (npx tsx on a package's src CLI)
 * or via the installed bin. Those processes don't get vitest's module aliases,
 * so a cross-package import of aquaman-proxy in the coder CLI resolves to
 * packages/proxy/dist, which npm test does not build.
 *
 * Until v0.15.0 this worked by accident: the OpenClaw plugin e2e built the
 * plugin in beforeAll (a `tsc -b` that also builds the proxy via project
 * references), and it always ran because openclaw was a repo devDependency.
 * With the gateway out of the lockfile that test skips unless a gateway is
 * installed, so nothing built dist and the coder e2e failed in CI with
 * ERR_MODULE_NOT_FOUND. Build here instead of depending on file order.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');

const ENTRYPOINTS: Array<{ workspace: string; dist: string }> = [
  { workspace: 'aquaman-proxy', dist: 'packages/proxy/dist/index.js' },
  { workspace: 'aquaman-coder', dist: 'packages/coder/dist/index.js' },
  { workspace: 'aquaman-plugin', dist: 'packages/plugin/dist/index.js' },
];

const stillMissing = () => ENTRYPOINTS.filter((e) => !fs.existsSync(path.join(ROOT, e.dist)));

export default function ensureBuild(): void {
  if (stillMissing().length === 0) return;
  // --force because `tsc -b` is a no-op when a stale tsconfig.tsbuildinfo says
  // the project is current but dist was removed (happens locally, never on a
  // fresh clone). The plugin's build script then copies its resolver into
  // dist, which fails if tsc emitted nothing, so force first and run the
  // package scripts after.
  execSync('npx tsc -b packages/proxy packages/plugin packages/coder --force', { cwd: ROOT, stdio: 'inherit' });
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  const left = stillMissing();
  if (left.length > 0) {
    throw new Error(`build did not produce: ${left.map((e) => e.dist).join(', ')}`);
  }
  // npm sets the exec bit on bin entrypoints at install time; tsc doesn't when
  // it rewrites them. Tests that resolve the aquaman bin (ProxyManager) check
  // X_OK and would silently skip otherwise.
  for (const bin of ['packages/proxy/dist/cli/index.js', 'packages/coder/dist/cli/index.js']) {
    const file = path.join(ROOT, bin);
    if (fs.existsSync(file)) fs.chmodSync(file, 0o755);
  }
}
