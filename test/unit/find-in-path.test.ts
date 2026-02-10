/**
 * Unit tests for findInPath utility used in the plugin.
 * Tests the fs-based PATH scanning that replaces execSync("which ...").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Inline copy of findInPath from plugin/index.ts for unit testing.
 * (The plugin doesn't export this function since it's an internal utility.)
 */
function findInPath(name: string, pathEnv?: string): string | null {
  const dirs = (pathEnv || process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not found or not executable in this dir
    }
  }
  return null;
}

describe('findInPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'findpath-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds an executable in PATH', () => {
    const binPath = path.join(tmpDir, 'test-binary');
    fs.writeFileSync(binPath, '#!/bin/sh\necho hi', { mode: 0o755 });

    const result = findInPath('test-binary', tmpDir);
    expect(result).toBe(binPath);
  });

  it('returns null when binary does not exist', () => {
    const result = findInPath('nonexistent-binary-xyz', tmpDir);
    expect(result).toBeNull();
  });

  it('skips non-executable files', () => {
    const binPath = path.join(tmpDir, 'not-executable');
    fs.writeFileSync(binPath, 'data', { mode: 0o644 });

    const result = findInPath('not-executable', tmpDir);
    expect(result).toBeNull();
  });

  it('searches multiple PATH directories in order', () => {
    const dir1 = path.join(tmpDir, 'dir1');
    const dir2 = path.join(tmpDir, 'dir2');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    // Put binary only in dir2
    const binPath = path.join(dir2, 'my-tool');
    fs.writeFileSync(binPath, '#!/bin/sh', { mode: 0o755 });

    const pathStr = `${dir1}${path.delimiter}${dir2}`;
    const result = findInPath('my-tool', pathStr);
    expect(result).toBe(binPath);
  });

  it('returns first match when binary exists in multiple dirs', () => {
    const dir1 = path.join(tmpDir, 'first');
    const dir2 = path.join(tmpDir, 'second');
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    const bin1 = path.join(dir1, 'dupe');
    const bin2 = path.join(dir2, 'dupe');
    fs.writeFileSync(bin1, '#!/bin/sh\necho first', { mode: 0o755 });
    fs.writeFileSync(bin2, '#!/bin/sh\necho second', { mode: 0o755 });

    const pathStr = `${dir1}${path.delimiter}${dir2}`;
    const result = findInPath('dupe', pathStr);
    expect(result).toBe(bin1);
  });

  it('handles empty PATH gracefully', () => {
    const result = findInPath('anything', '');
    expect(result).toBeNull();
  });

  it('finds real system binary (node)', () => {
    // node must be in PATH for tests to run
    const result = findInPath('node');
    expect(result).not.toBeNull();
    expect(result).toContain('node');
  });
});
