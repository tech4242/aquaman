/**
 * E2E: `aquaman openshell setup|doctor` (v0.17.0). The live-gateway flow is
 * covered by scripts/e2e-openshell.sh; this pins the CLI's own contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

const CLI_PATH = path.resolve('packages/proxy/src/cli/index.ts');

describe('aquaman openshell CLI', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join('/tmp', 'aqoc-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (...args: string[]) => {
    const r = spawnSync('npx', ['tsx', CLI_PATH, 'openshell', ...args], {
      encoding: 'utf-8',
      env: { ...process.env, AQUAMAN_CONFIG_DIR: dir, NO_COLOR: '1' },
    });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const config = () => parseYaml(fs.readFileSync(path.join(dir, 'config.yaml'), 'utf-8'));

  it('setup enables the driver and prints a gateway snippet with the absolute socket path', () => {
    const r = run('setup');
    expect(r.code).toBe(0);
    expect(config().openshell).toEqual({ driver: { enabled: true } });
    expect(r.out).toContain('credential_drivers = ["aquaman"]');
    expect(r.out).toContain(`socket_path = "${path.join(dir, 'openshell.sock')}"`);
    expect(r.out).toContain('--credential ANTHROPIC_API_KEY=aquaman://anthropic/api_key');
  }, 30_000);

  it('setup --socket persists a custom path; relative paths are rejected', () => {
    expect(run('setup', '--socket', '/tmp/aq-custom.sock').code).toBe(0);
    expect(config().openshell.driver.socketPath).toBe('/tmp/aq-custom.sock');
    const bad = run('setup', '--socket', 'relative.sock');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('absolute');
  }, 30_000);

  it('setup --disable turns it off without losing other config', () => {
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'broker:\n  allowedRefs: [aquaman://a/b]\n');
    run('setup');
    expect(run('setup', '--disable').code).toBe(0);
    expect(config().openshell.driver.enabled).toBe(false);
    expect(config().broker.allowedRefs).toEqual(['aquaman://a/b']);
  }, 30_000);

  it('doctor fails when the daemon is not serving the driver', () => {
    run('setup');
    const r = run('doctor');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Driver enabled in config.yaml');
    expect(r.out).toContain('Driver socket not present');
  }, 30_000);
});
