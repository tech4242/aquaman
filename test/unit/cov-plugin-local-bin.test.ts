/**
 * Unit: where the plugin looks for the `aquaman` binary. A ClawHub install
 * bundles aquaman-proxy, so the copy in the plugin's own node_modules/.bin is
 * version-matched and must win over whatever is on PATH. In this repository
 * that file does not exist (the workspace hoists it), so its presence is
 * simulated; nothing is created inside packages/plugin.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as path from 'node:path';

const LOCAL_BIN = path.resolve('packages/plugin/node_modules/.bin/aquaman');
const state = { localBinExists: false, asked: [] as string[] };

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: any) => {
    state.asked.push(String(p));
    if (String(p) === LOCAL_BIN) return state.localBinExists;
    return actual.existsSync(p);
  };
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

import { findAquamanProxyBinary } from '../../packages/plugin/src/proxy-manager.js';

describe('findAquamanProxyBinary: the bundled copy', () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    state.localBinExists = false;
    state.asked.length = 0;
  });

  it('prefers the plugin’s own node_modules/.bin/aquaman over PATH', () => {
    state.localBinExists = true;
    // PATH has an `aquaman` too (the workspace bin); it must not be the answer.
    process.env.PATH = path.resolve('node_modules/.bin');
    expect(findAquamanProxyBinary()).toBe(LOCAL_BIN);
  });

  it('is found even with an empty PATH', () => {
    state.localBinExists = true;
    process.env.PATH = '';
    expect(findAquamanProxyBinary()).toBe(LOCAL_BIN);
  });

  it('looks there first and falls back to PATH when it is absent', () => {
    process.env.PATH = '/nonexistent-dir-for-aquaman-test';
    expect(findAquamanProxyBinary()).toBeNull();
    expect(state.asked).toEqual([LOCAL_BIN]);
  });
});
